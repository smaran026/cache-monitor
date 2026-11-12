import fs from "fs";
import path from "path";
import os from "os";
import { createHash } from "crypto";

// ---------------------------------------------------------------------------
// Provider rules (configurable)
//
// A rule is keyed by provider id (the `providerID` OpenCode reports). Add or
// override rules in the "providers" object of
//   ~/.local/share/opencode/cache-monitor-config.json
// Set a built-in rule to null to disable it. Example:
//   { "providers": { "my-gateway": { "urls": ["gw.example.com"],
//       "headers": ["x-affinity"], "bodyCacheKey": "inject" },
//       "opencode-go": null } }
//
// bodyCacheKey: "strip"  remove prompt_cache_key from headers and JSON body
//               "inject" set prompt_cache_key = affinity id in the JSON body
//               "keep"   leave it untouched (default)
// ---------------------------------------------------------------------------

type BodyKeyMode = "strip" | "inject" | "keep";

interface ProviderRule {
  ids?: string[]; // extra provider ids that use this rule
  urls?: string[]; // substrings matched against the request URL
  headers?: string[]; // header names set to the affinity id
  bodyCacheKey?: BodyKeyMode;
}

const DEFAULT_PROVIDERS: Record<string, ProviderRule> = {
  mistral: {
    urls: ["mistral.ai", "codestral"],
    headers: ["x-affinity"],
    bodyCacheKey: "strip",
  },
  "opencode-go": {
    urls: ["opencode.ai"],
    headers: ["x-affinity", "x-session-affinity", "session-id"],
    bodyCacheKey: "inject",
  },
};

const DATA_DIR = path.join(os.homedir(), ".local/share/opencode");
const CONFIG_FILE = path.join(DATA_DIR, "cache-monitor-config.json");
const LOG_FILE = path.join(DATA_DIR, "mistral-affinity.log");
const PREFIX_LOG_FILE = path.join(DATA_DIR, "cache-prefix.log");
const MAX_LOG_BYTES = 512 * 1024;

// Logging is off unless OC_AFFINITY_DEBUG=1 (routing lines) or
// OC_AFFINITY_PREFIX=1 (request-body prefix hashes, see README).
const DEBUG = !!process.env.OC_AFFINITY_DEBUG;
const PREFIX_DEBUG = !!process.env.OC_AFFINITY_PREFIX;

function appendRotating(file: string, line: string) {
  try {
    try {
      if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, file + ".1");
    } catch {}
    fs.appendFileSync(file, line);
  } catch {}
}

function log(msg: string) {
  if (!DEBUG) return;
  appendRotating(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
}

function loadProviders(): Record<string, ProviderRule> {
  const merged: Record<string, ProviderRule> = { ...DEFAULT_PROVIDERS };
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    const user = parsed?.providers;
    if (user && typeof user === "object") {
      for (const [id, rule] of Object.entries(user)) {
        if (rule === null) delete merged[id];
        else if (typeof rule === "object") merged[id] = rule as ProviderRule;
      }
    }
  } catch {}
  return merged;
}

function findRule(
  providers: Record<string, ProviderRule>,
  providerID: string,
  url: string
): { id: string; rule: ProviderRule } | null {
  for (const [id, rule] of Object.entries(providers)) {
    if (providerID && (providerID === id || rule.ids?.includes(providerID))) return { id, rule };
  }
  if (url) {
    for (const [id, rule] of Object.entries(providers)) {
      if (rule.urls?.some((u) => url.includes(u))) return { id, rule };
    }
  }
  return null;
}

function logPrefixHashes(providerId: string, model: string, affinity: string, bodyText: string) {
  if (!PREFIX_DEBUG) return;
  const hashes: Record<string, string> = {};
  for (const kb of [4, 32, 128]) {
    const n = kb * 1024;
    if (bodyText.length >= n) {
      hashes[`first_${kb}k`] = createHash("sha1").update(bodyText.slice(0, n)).digest("hex").slice(0, 12);
    }
  }
  appendRotating(
    PREFIX_LOG_FILE,
    JSON.stringify({ t: new Date().toISOString(), provider: providerId, model, affinity, bytes: bodyText.length, ...hashes }) + "\n"
  );
}

export default {
  id: "oc-mistral-affinity",
  setup(context: any) {
    log("oc-mistral-affinity plugin loaded");

    if (!context?.session?.hook) {
      log("context.session.hook is not available");
      return;
    }

    // 1. model.request: set affinity headers on model requests
    context.session.hook("model.request", async (req: any) => {
      try {
        const url = typeof req?.baseURL === "string" ? req.baseURL : "";
        const match = findRule(loadProviders(), req?.model?.providerID || "", url);
        if (!match) return;

        if (req?.headers && req?.sessionID) {
          for (const h of match.rule.headers ?? ["x-affinity"]) req.headers[h] = req.sessionID;
        }
      } catch (e: any) {
        log(`model.request error: ${e?.message}`);
      }
    });

    // 2. http.request: set affinity headers, handle prompt_cache_key
    context.session.hook("http.request", async (req: any) => {
      try {
        const url = req?.request?.url || "";
        const match = findRule(loadProviders(), req?.model?.providerID || "", url);
        if (!match) return;
        const { id: ruleId, rule } = match;

        const headers = req.request.headers;
        // Root session id if forked/subagent, otherwise the current session id
        const affinity =
          headers.get("x-session-affinity") ||
          headers.get("x-opencode-session") ||
          headers.get("x-session-id") ||
          headers.get("session-id") ||
          req.sessionID;

        if (affinity) {
          for (const h of rule.headers ?? ["x-affinity"]) headers.set(h, affinity);
        }

        const mode: BodyKeyMode = rule.bodyCacheKey ?? "keep";
        if (mode === "strip") {
          headers.delete("prompt_cache_key");
          headers.delete("prompt-cache-key");
        }

        const model = req?.model?.id || "unknown";
        let bodyModified = false;
        let bodyText: string | null = null;
        try {
          bodyText = await req.request.clone().text();
        } catch {}

        if (bodyText) logPrefixHashes(ruleId, model, String(affinity ?? ""), bodyText);

        if (mode !== "keep" && bodyText && (bodyText.startsWith("{") || bodyText.startsWith("["))) {
          try {
            const body = JSON.parse(bodyText);
            if (body && typeof body === "object") {
              if (mode === "strip") {
                if ("prompt_cache_key" in body || "promptCacheKey" in body) {
                  delete body.prompt_cache_key;
                  delete body.promptCacheKey;
                  bodyModified = true;
                }
              } else if (mode === "inject" && affinity && body.prompt_cache_key !== affinity) {
                body.prompt_cache_key = affinity;
                bodyModified = true;
              }
            }
            if (bodyModified) {
              const newHeaders = new Headers(req.request.headers);
              newHeaders.delete("content-length"); // body length changed
              req.request = new Request(req.request.url, {
                method: req.request.method,
                headers: newHeaders,
                body: JSON.stringify(body),
                signal: req.request.signal, // keep cancellation working
              });
            }
          } catch (err: any) {
            log(`JSON parse error: ${err?.message}`);
          }
        }

        log(`Routed ${ruleId}/${model}: affinity=${affinity} mode=${mode} body_modified=${bodyModified} url=${url}`);
      } catch (e: any) {
        log(`http.request error: ${e?.message}`);
      }
    });
  },
};
