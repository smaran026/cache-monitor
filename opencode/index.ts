import fs from "fs";
import path from "path";
import os from "os";

const LOG_FILE = path.join(os.homedir(), ".local/share/opencode/mistral-affinity.log");
const STATE_FILE = path.join(os.homedir(), ".local/share/opencode/cache-monitor.json");

function log(msg: string) {
  try {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    fs.appendFileSync(LOG_FILE, line);
  } catch {}
}

function updateState(updater: (state: any) => void) {
  try {
    let state: any = {
      sessionID: "",
      turnCount: 0,
      totalPrompt: 0,
      totalCached: 0,
      overallRate: 100,
      zeroMisses: 0,
      partialMisses: 0,
      lastTurnPrompt: 0,
      lastTurnCached: 0,
      lastTurnHitPct: 100,
      lastModel: "",
      lastProvider: "",
      updatedAt: Date.now(),
    };
    if (fs.existsSync(STATE_FILE)) {
      try {
        state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      } catch {}
    }
    updater(state);
    state.updatedAt = Date.now();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {}
}

function isAffinityTarget(req: any, url: string): boolean {
  const provider = req?.model?.providerID || "";
  const modelId = req?.model?.id || "";
  return (
    provider === "mistral" ||
    provider === "opencode-go" ||
    url.includes("mistral.ai") ||
    url.includes("codestral") ||
    url.includes("opencode.ai/zen") ||
    modelId.includes("deepseek") ||
    modelId.includes("qwen") ||
    modelId.includes("minimax") ||
    modelId.includes("glm")
  );
}

export default {
  id: "oc-mistral-affinity",
  setup(context: any) {
    log("oc-mistral-affinity plugin loaded (supports Mistral & OpenCode Go)");

    if (!context?.session?.hook) {
      log("context.session.hook is not available");
      return;
    }

    // 1. Hook model.request: set x-affinity & session-id headers on model requests
    context.session.hook("model.request", async (req: any) => {
      try {
        const url = typeof req?.baseURL === "string" ? req.baseURL : "";
        if (!isAffinityTarget(req, url)) return;

        if (req?.headers && req?.sessionID) {
          req.headers["x-affinity"] = req.sessionID;
          req.headers["session-id"] = req.sessionID;
        }
      } catch (e: any) {
        log(`model.request error: ${e?.message}`);
      }
    });

    // 2. Hook http.request: inject x-affinity HTTP header and strip prompt_cache_key
    context.session.hook("http.request", async (req: any) => {
      try {
        const url = req?.request?.url || "";
        if (!isAffinityTarget(req, url)) return;

        const headers = req.request.headers;
        // Retrieve affinity session ID (root session ID if forked/subagent, otherwise current sessionID)
        const affinity =
          headers.get("x-session-affinity") ||
          headers.get("x-opencode-session") ||
          headers.get("x-session-id") ||
          headers.get("session-id") ||
          req.sessionID;

        if (affinity) {
          headers.set("x-affinity", affinity);
          headers.set("session-id", affinity);
        }

        // Remove conflicting cache key headers if present
        headers.delete("prompt_cache_key");
        headers.delete("prompt-cache-key");

        const provider = req?.model?.providerID || (url.includes("opencode.ai") ? "opencode-go" : "mistral");
        const model = req?.model?.id || "unknown";
        const isDirectMistral =
          provider === "mistral" ||
          url.includes("mistral.ai") ||
          url.includes("codestral");

        // Inspect body: strip prompt_cache_key for direct Mistral (x-affinity only), inject for opencode-go
        let bodyModified = false;
        let bodyText: string | null = null;
        try {
          bodyText = await req.request.clone().text();
        } catch {}

        if (bodyText && (bodyText.startsWith("{") || bodyText.startsWith("["))) {
          try {
            const body = JSON.parse(bodyText);
            if (body && typeof body === "object") {
              if (isDirectMistral) {
                if ("prompt_cache_key" in body || "promptCacheKey" in body) {
                  delete body.prompt_cache_key;
                  delete body.promptCacheKey;
                  bodyModified = true;
                }
              } else if (affinity) {
                body.prompt_cache_key = affinity;
                bodyModified = true;
              }
            }
            if (bodyModified) {
              req.request = new Request(req.request.url, {
                method: req.request.method,
                headers: req.request.headers,
                body: JSON.stringify(body),
              });
            }
          } catch (err: any) {
            log(`JSON parse error: ${err?.message}`);
          }
        }

        log(
          `Routed ${provider}/${model}: affinity=${affinity} direct_mistral=${isDirectMistral} body_modified=${bodyModified} url=${url}`
        );

        // Update session monitor state
        updateState((s) => {
          if (s.sessionID !== req.sessionID) {
            s.sessionID = req.sessionID || "";
            s.turnCount = 0;
            s.totalPrompt = 0;
            s.totalCached = 0;
            s.zeroMisses = 0;
            s.partialMisses = 0;
          }
          s.turnCount = (s.turnCount || 0) + 1;
          s.lastModel = model;
          s.lastProvider = provider;
        });
      } catch (e: any) {
        log(`http.request error: ${e?.message}`);
      }
    });
  },
};
