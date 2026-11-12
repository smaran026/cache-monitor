import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const AGENT_DIR = join(homedir(), ".pi/agent");
const CONFIG_FILE = join(AGENT_DIR, "cache-monitor-config.json");
const REQUEST_LOG_FILE = join(AGENT_DIR, "mistral-requests.log");
const PREFIX_LOG_FILE = join(AGENT_DIR, "cache-prefix.log");
const MAX_LOG_BYTES = 512 * 1024;
const DEFAULT_P_MISS_PCT = 10;
const DEFAULT_MISS_PCT = 50;

// ---------------------------------------------------------------------------
// Provider rules (configurable)
//
// A rule is keyed by provider id (Pi's `model.provider`). Add or override rules
// in the "providers" object of ~/.pi/agent/cache-monitor-config.json. Set a
// built-in rule to null to disable it. Example:
//   { "providers": { "my-gateway": { "urls": ["gw.example.com"],
//       "headers": ["x-affinity"], "bodyCacheKey": "inject" },
//       "opencode-go": null } }
//
// bodyCacheKey: "strip"  remove prompt_cache_key from headers and request body
//               "inject" set prompt_cache_key = session id in the request body
//               "keep"   leave it untouched (default)
// ---------------------------------------------------------------------------
type BodyKeyMode = "strip" | "inject" | "keep";

interface ProviderRule {
  ids?: string[]; // extra provider ids that use this rule
  urls?: string[]; // substrings matched against the model base URL
  apis?: string[]; // Pi `model.api` values
  headers?: string[]; // header names set to the session id
  bodyCacheKey?: BodyKeyMode;
}

const DEFAULT_PROVIDERS: Record<string, ProviderRule> = {
  mistral: {
    urls: ["mistral.ai", "codestral"],
    apis: ["mistral-conversations"],
    headers: ["x-affinity"],
    bodyCacheKey: "strip",
  },
  "opencode-go": {
    urls: ["opencode.ai"],
    headers: ["x-affinity", "x-session-affinity", "session-id"],
    bodyCacheKey: "inject",
  },
};

function readConfigFile(): Record<string, any> {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function loadProviders(): Record<string, ProviderRule> {
  const merged: Record<string, ProviderRule> = { ...DEFAULT_PROVIDERS };
  const user = readConfigFile().providers;
  if (user && typeof user === "object") {
    for (const [id, rule] of Object.entries(user)) {
      if (rule === null) delete merged[id];
      else if (typeof rule === "object") merged[id] = rule as ProviderRule;
    }
  }
  return merged;
}

function findRule(
  providers: Record<string, ProviderRule>,
  model: { provider?: string; api?: string; baseUrl?: string } | undefined
): { id: string; rule: ProviderRule } | null {
  const provider = model?.provider || "";
  const api = model?.api || "";
  const baseUrl = model?.baseUrl || "";
  for (const [id, rule] of Object.entries(providers)) {
    if (provider && (provider === id || rule.ids?.includes(provider))) return { id, rule };
  }
  for (const [id, rule] of Object.entries(providers)) {
    if (api && rule.apis?.includes(api)) return { id, rule };
    if (baseUrl && rule.urls?.some((u) => baseUrl.includes(u))) return { id, rule };
  }
  return null;
}

function appendRotating(file: string, line: string) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    try {
      if (statSync(file).size > MAX_LOG_BYTES) renameSync(file, file + ".1");
    } catch {}
    appendFileSync(file, line);
  } catch {}
}

// Headers that can carry credentials or session cookies; never written to logs.
const SENSITIVE_HEADER = /^(authorization|proxy-authorization|x-api-key|api-key|cookie|set-cookie)$/i;

function redactHeaders(headers: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(headers || {})) {
    out[k] = SENSITIVE_HEADER.test(k) ? "[REDACTED]" : v;
  }
  return out;
}

const DEBUG_HEADERS = !!(process.env.PI_DEBUG_AFFINITY || process.env.PI_DEBUG_MISTRAL);
const DEBUG_PREFIX = !!process.env.PI_DEBUG_PREFIX;

function logPrefixHashes(providerId: string, model: string, sessionId: string, payload: unknown) {
  if (!DEBUG_PREFIX) return;
  try {
    const text = JSON.stringify(payload) ?? "";
    const hashes: Record<string, string> = {};
    for (const kb of [4, 32, 128]) {
      const n = kb * 1024;
      if (text.length >= n) hashes[`first_${kb}k`] = createHash("sha1").update(text.slice(0, n)).digest("hex").slice(0, 12);
    }
    appendRotating(
      PREFIX_LOG_FILE,
      JSON.stringify({ t: new Date().toISOString(), provider: providerId, model, sessionId, bytes: text.length, ...hashes }) + "\n"
    );
  } catch {}
}

function loadThresholds(): { pMissPct: number; missPct: number } {
  const parsed = readConfigFile();
  const pMissPct =
    typeof parsed?.pMissPct === "number" && Number.isFinite(parsed.pMissPct) && parsed.pMissPct >= 0 && parsed.pMissPct <= 100
      ? parsed.pMissPct
      : DEFAULT_P_MISS_PCT;
  const missPct =
    typeof parsed?.missPct === "number" && Number.isFinite(parsed.missPct) && parsed.missPct >= 0 && parsed.missPct <= 100
      ? parsed.missPct
      : DEFAULT_MISS_PCT;
  return { pMissPct, missPct };
}

function saveThresholds(pMissPct: number, missPct: number) {
  try {
    mkdirSync(dirname(CONFIG_FILE), { recursive: true });
    // Read-modify-write so the "providers" section is preserved.
    writeFileSync(CONFIG_FILE, JSON.stringify({ ...readConfigFile(), pMissPct, missPct }, null, 2));
  } catch {}
}

function parsePctInput(raw?: string): number | null {
  const cleaned = (raw ?? "").trim().replace(/%$/, "").trim();
  if (!cleaned) return null;
  const val = Number(cleaned);
  if (!Number.isFinite(val) || val < 0 || val > 100) return null;
  return val;
}

interface TimingData {
  msgTs: number;
  ttfsMs?: number;
  decodeMs?: number;
  totalMs?: number;
  ts?: number;
}

interface TurnRecord {
  turn: number;
  uncached: number;
  cached: number;
  totalPrompt: number;
  output: number;
  hitPct: number;
  isHit: boolean;
  isPartialMiss: boolean;
  isColdPrefill: boolean;
  isWarmPrefill: boolean;
  isAborted: boolean;
  writeTokens: number;
  cachedStr: string;
  cost: number;
  /** Estimated extra spend vs. a full cache hit on this turn (0 for hits). */
  overpay: number;
  ttfsMs?: number;
  totalMs?: number;
  ts?: number;
  tsEstimated?: boolean;
  label: string;
  description: string;
}

function formatTtfs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

function formatTs(tokPerSec: number, estimated?: boolean): string {
  const val = tokPerSec >= 100 ? Math.round(tokPerSec).toString() : tokPerSec.toFixed(1);
  return `${estimated ? "~" : ""}${val}/s`;
}

function formatPerfSuffix(ts?: number, ttfsMs?: number, tsEstimated?: boolean): string {
  const parts: string[] = [];
  if (ts !== undefined && Number.isFinite(ts)) {
    parts.push(`ts ${formatTs(ts, tsEstimated)}`);
  }
  if (ttfsMs !== undefined && Number.isFinite(ttfsMs)) {
    parts.push(`ttfs ${formatTtfs(ttfsMs)}`);
  }
  return parts.length > 0 ? ` [${parts.join(" · ")}]` : "";
}

export default function (pi: ExtensionAPI) {
  let turnCount = 0;
  let totalUncached = 0;
  let totalCached = 0;
  let totalOutput = 0;
  let totalCost = 0;
  let missCost = 0; // total cost of turns classified as Miss or P Miss
  let overpay = 0; // estimated extra spend caused by uncached prefix tokens
  let writeCost = 0;
  let totalWriteTokens = 0;
  let fullMissCount = 0;
  let partialMissCount = 0;
  let coldPrefillCount = 0;
  let warmPrefillCount = 0;
  let abortedCount = 0;
  let tsSum = 0;
  let tsCount = 0;
  let ttfsSum = 0;
  let ttfsCount = 0;
  let widgetEnabled = false;
  const history: TurnRecord[] = [];

  // Live streaming timing state (kept across syncHistoryFromSession calls)
  let activeReqStartMs: number | null = null;
  let activeFirstStreamMs: number | null = null;
  const liveTimingsByMsgTs = new Map<number, TimingData>();

  function resetStats() {
    turnCount = 0;
    totalUncached = 0;
    totalCached = 0;
    totalOutput = 0;
    totalCost = 0;
    missCost = 0;
    overpay = 0;
    writeCost = 0;
    totalWriteTokens = 0;
    fullMissCount = 0;
    partialMissCount = 0;
    coldPrefillCount = 0;
    warmPrefillCount = 0;
    abortedCount = 0;
    tsSum = 0;
    tsCount = 0;
    ttfsSum = 0;
    ttfsCount = 0;
    history.length = 0;
  }

  function syncHistoryFromSession(ctx: any): TurnRecord[] {
    if (!ctx?.sessionManager?.getEntries) return history;
    try {
      const entries = ctx.sessionManager.getEntries();
      if (!Array.isArray(entries) || entries.length === 0) return history;

      const timingsByMsgTs = new Map<number, TimingData>();
      for (const entry of entries) {
        if (entry?.type === "custom" && entry.customType === "cache-timing" && entry.data?.msgTs) {
          timingsByMsgTs.set(entry.data.msgTs, entry.data as TimingData);
        }
      }
      for (const [k, v] of liveTimingsByMsgTs) {
        timingsByMsgTs.set(k, v);
      }

      const { pMissPct, missPct } = loadThresholds();
      const strictHitFloor = Math.max(0, Math.min(1, (100 - pMissPct) / 100));
      const completeHitFloor = Math.max(0, Math.min(1, (100 - missPct) / 100));

      resetStats();
      let prevTotalPrompt = 0;
      let lastCacheReadRate = 0; // $ per cached token, learned from the last turn that had cached tokens
      for (const entry of entries) {
        if (entry?.type === "message" && entry.message?.role === "assistant") {
          const usage = entry.message.usage;
          if (usage) {
            turnCount++;
            const uncached = usage.input || 0;
            const cached = usage.cacheRead || 0;
            const explicitWrite = usage.cacheWrite || 0;
            const output = usage.output || 0;
            const cost = usage.cost?.total || 0;
            const totalPrompt = uncached + cached;

            totalUncached += uncached;
            totalCached += cached;
            totalOutput += output;
            totalCost += cost;

            const msgTs = typeof entry.message.timestamp === "number" ? entry.message.timestamp : 0;
            const savedTiming = msgTs > 0 ? timingsByMsgTs.get(msgTs) : undefined;
            let turnTtfsMs = savedTiming?.ttfsMs;
            let turnTotalMs = savedTiming?.totalMs;
            let turnTs = savedTiming?.ts;
            let tsEstimated = false;

            const isAborted = totalPrompt === 0 || entry.message.stopReason === "aborted";
            if (!isAborted && turnTs === undefined && output > 0 && msgTs > 0 && entry.timestamp) {
              const entryEndMs = Date.parse(entry.timestamp);
              if (Number.isFinite(entryEndMs) && entryEndMs > msgTs) {
                turnTotalMs = entryEndMs - msgTs;
                turnTs = output / (turnTotalMs / 1000);
                tsEstimated = true;
              }
            }

            if (!isAborted) {
              if (turnTs !== undefined && Number.isFinite(turnTs)) {
                tsSum += turnTs;
                tsCount++;
              }
              if (turnTtfsMs !== undefined && Number.isFinite(turnTtfsMs)) {
                ttfsSum += turnTtfsMs;
                ttfsCount++;
              }
            }

            const perfSuffix = formatPerfSuffix(turnTs, turnTtfsMs, tsEstimated);

            let isHit = false;
            let isPartialMiss = false;
            let isColdPrefill = false;
            let isWarmPrefill = false;
            let turnWriteTokens = 0;
            let label = "";
            let description = "";
            let cachedStr = "";
            let turnHitPct = 0;
            let turnOverpay = 0;

            // Overpay estimate: the prompt prefix we expected to be cached is the previous turn's prompt.
            // Every expected-but-uncached token cost (input rate - cache-read rate) more than a hit.
            const estimateOverpay = (): number => {
              const expected = Math.min(prevTotalPrompt, totalPrompt);
              const lost = Math.max(0, expected - cached);
              if (lost === 0) return 0;
              const inputRate = uncached > 0 && usage.cost?.input > 0 ? usage.cost.input / uncached : 0;
              if (inputRate > 0) return lost * Math.max(0, inputRate - lastCacheReadRate);
              return totalPrompt > 0 ? cost * (lost / totalPrompt) : 0; // no per-token rate available
            };
            if (cached > 0 && usage.cost?.cacheRead > 0) lastCacheReadRate = usage.cost.cacheRead / cached;

            if (isAborted) {
              abortedCount++;
              label = `Turn ${turnCount}: Aborted (0 tokens) - $0.0000${perfSuffix}`;
              description = "Turn aborted before token completion (0 cost)";
            } else {
              const isCompleteHit = totalPrompt > 0 && cached >= totalPrompt * completeHitFloor;
              const isStrictHit = totalPrompt > 0 && cached >= totalPrompt * strictHitFloor;
              turnHitPct = totalPrompt > 0 ? (cached / totalPrompt) * 100 : 100;

              if (turnCount === 1) {
                const readK = Math.round(cached / 1000);
                cachedStr = cached === 0 ? "0 cached" : `${readK}k cached`;

                if (!isCompleteHit) {
                  // Cold start: cache warmup from scratch
                  isColdPrefill = true;
                  coldPrefillCount++;
                  turnWriteTokens = explicitWrite > 0 ? explicitWrite : uncached;
                  totalWriteTokens += turnWriteTokens;
                  writeCost += usage.cost?.cacheWrite || 0;

                  const sentK = Math.round(totalPrompt / 1000);
                  const writeK = Math.round(turnWriteTokens / 1000);
                  label = `Turn 1: Cold Prefill (${sentK}k tokens sent · ${writeK}k written) - $${cost.toFixed(4)}${perfSuffix}`;
                  description = `Cold prefill: ${totalPrompt.toLocaleString()} tokens sent & written to cache (initial session warmup · not a miss)`;
                } else {
                  // Warm start: reused cache from prior session within TTL window
                  isHit = true;
                  isWarmPrefill = true;
                  warmPrefillCount++;
                  turnWriteTokens = explicitWrite > 0 ? explicitWrite : uncached;
                  totalWriteTokens += turnWriteTokens;
                  writeCost += (usage.cost?.cacheWrite || 0);

                  const uncachedStr = uncached >= 1000 ? `${(uncached / 1000).toFixed(1)}k` : `${uncached}`;
                  label = `Turn 1: Warm Prefill (${cachedStr} · ${uncachedStr} sent) - $${cost.toFixed(4)}${perfSuffix}`;
                  description = `Warm prefill hit: ${cached.toLocaleString()} cached tokens reused from prior session + ${uncached.toLocaleString()} new tokens sent (${turnHitPct.toFixed(1)}% cached)`;
                }
              } else if (!isCompleteHit) {
                fullMissCount++;
                missCost += cost;
                turnOverpay = estimateOverpay();
                overpay += turnOverpay;
                if (explicitWrite > 0) {
                  turnWriteTokens = explicitWrite;
                  totalWriteTokens += explicitWrite;
                  writeCost += (usage.cost?.cacheWrite || 0);
                }
                const readK = Math.round(cached / 1000);
                cachedStr = cached === 0 ? "0 cached" : `${readK}k cached`;
                label = `Turn ${turnCount}: Miss (${cachedStr}) - $${cost.toFixed(4)} [Miss Cost]${perfSuffix}`;
                description = `${turnHitPct.toFixed(1)}% cached (${cached.toLocaleString()} / ${totalPrompt.toLocaleString()} tokens)`;
              } else if (!isStrictHit) {
                isPartialMiss = true;
                partialMissCount++;
                missCost += cost;
                turnOverpay = estimateOverpay();
                overpay += turnOverpay;
                if (explicitWrite > 0) {
                  turnWriteTokens = explicitWrite;
                  totalWriteTokens += explicitWrite;
                  writeCost += (usage.cost?.cacheWrite || 0);
                }
                const readK = Math.round(cached / 1000);
                cachedStr = `${readK}k cached`;
                label = `Turn ${turnCount}: P Miss (${cachedStr}) - $${cost.toFixed(4)} [Miss Cost]${perfSuffix}`;
                description = `Partial miss: ${turnHitPct.toFixed(1)}% cached (${cached.toLocaleString()} / ${totalPrompt.toLocaleString()} tokens)`;
              } else {
                isHit = true;
                if (explicitWrite > 0) {
                  turnWriteTokens = explicitWrite;
                  totalWriteTokens += explicitWrite;
                  writeCost += (usage.cost?.cacheWrite || 0);
                }
                const readK = Math.round(cached / 1000);
                cachedStr = `${readK}k cached`;
                label = `Turn ${turnCount}: Hit (${cachedStr}) - $${cost.toFixed(4)}${perfSuffix}`;
                description = `${turnHitPct.toFixed(1)}% cached (${cached.toLocaleString()} / ${totalPrompt.toLocaleString()} tokens)`;
              }
            }

            history.push({
              turn: turnCount,
              uncached,
              cached,
              totalPrompt,
              output,
              hitPct: turnHitPct,
              isHit,
              isPartialMiss,
              isColdPrefill,
              isWarmPrefill,
              isAborted,
              writeTokens: turnWriteTokens,
              cachedStr,
              cost,
              overpay: turnOverpay,
              ttfsMs: turnTtfsMs,
              totalMs: turnTotalMs,
              ts: turnTs,
              tsEstimated,
              label,
              description,
            });
            if (!isAborted) prevTotalPrompt = totalPrompt;
          }
        }
      }

      updateStatusAndWidget(ctx);
    } catch {}
    return history;
  }

  function updateStatusAndWidget(ctx: any) {
    if (!ctx?.ui) return;
    const totalPromptAll = totalUncached + totalCached;
    const overallRate = totalPromptAll > 0 ? ((totalCached / totalPromptAll) * 100).toFixed(1) : "100";
    const writeK = Math.round(totalWriteTokens / 1000);
    const writeStr = totalWriteTokens > 0 ? `${writeK}k write` : "";
    const lastTurn = history[history.length - 1];
    const missCount = fullMissCount + partialMissCount;
    const missBreakdown = `${fullMissCount} miss · ${partialMissCount} P`;

    // 1. Footer status bar with themed colors & telemetry
    try {
      const theme = ctx.ui.theme;
      let statusMsg = "";
      if (theme) {
        const icon = missCount === 0 ? theme.fg("success", "⚡") : theme.fg("warning", "⚡");
        const rateText = theme.fg("accent", ` ${overallRate}% cache`);
        const writeText = writeStr ? theme.fg("dim", ` · ${writeStr}`) : "";
        const missText =
          missCount > 0
            ? theme.fg("error", ` (${missBreakdown} · ~$${overpay.toFixed(4)} overpaid)`)
            : "";
        const lastTurnText = lastTurn
          ? theme.fg("dim", ` | ${lastTurn.label}`)
          : "";
        statusMsg = `${icon}${rateText}${writeText}${missText}${lastTurnText}`;
      } else {
        const writeText = writeStr ? ` · ${writeStr}` : "";
        const missText = missCount > 0 ? ` (${missBreakdown} · ~$${overpay.toFixed(4)} overpaid)` : "";
        statusMsg = `⚡ Cache: ${overallRate}%${writeText}${missText}${lastTurn ? " | " + lastTurn.label : ""}`;
      }
      ctx.ui.setStatus("cache_monitor", statusMsg);
    } catch {}

    // 2. Optional pinned widget below the input editor
    try {
      if (widgetEnabled && ctx.ui.setWidget) {
        const missPct = totalCost > 0 ? ((missCost / totalCost) * 100).toFixed(1) : "0.0";
        const prefillSummary =
          coldPrefillCount > 0
            ? `Cold Prefill (warmup)`
            : warmPrefillCount > 0
            ? `Warm Prefill (reused cache)`
            : "None";
        const avgParts: string[] = [];
        if (tsCount > 0) avgParts.push(`Avg ts: ${formatTs(tsSum / tsCount)}`);
        if (ttfsCount > 0) avgParts.push(`Avg ttfs: ${formatTtfs(ttfsSum / ttfsCount)}`);
        const avgLine = avgParts.length > 0 ? ` | ${avgParts.join(" · ")}` : "";
        const summary = [
          `⚡ Prompt Cache: ${overallRate}% | Total Cost: $${totalCost.toFixed(4)} | Overpaid ~$${overpay.toFixed(4)} | Cost of miss turns: $${missCost.toFixed(4)} (${missPct}% of bill)${avgLine}`,
          `   Cache Write: ${totalWriteTokens.toLocaleString()} tokens ($${writeCost.toFixed(4)}) | Hits: ${turnCount - missCount - abortedCount - coldPrefillCount} | Misses: ${fullMissCount} | P Misses: ${partialMissCount} | Prefill: ${prefillSummary}`,
          lastTurn ? `   Latest: ${lastTurn.label}` : "",
        ].filter(Boolean);
        ctx.ui.setWidget("cache_monitor_widget", summary, { placement: "belowEditor" });
      } else if (!widgetEnabled && ctx.ui.setWidget) {
        ctx.ui.setWidget("cache_monitor_widget", undefined);
      }
    } catch {}
  }

  async function showInteractiveModal(ctx: any) {
    syncHistoryFromSession(ctx);

    const totalPromptAll = totalUncached + totalCached;
    const overallRate = totalPromptAll > 0 ? ((totalCached / totalPromptAll) * 100).toFixed(1) : "100.0";

    if (history.length === 0) {
      ctx.ui?.notify?.("No recorded turns with token usage found in this session.", "info");
      return;
    }

    const options = [...history].reverse().map((t) => t.label);
    const avgParts: string[] = [];
    if (tsCount > 0) avgParts.push(`Avg ts: ${formatTs(tsSum / tsCount)}`);
    if (ttfsCount > 0) avgParts.push(`Avg ttfs: ${formatTtfs(ttfsSum / ttfsCount)}`);
    const avgTitle = avgParts.length > 0 ? ` | ${avgParts.join(" · ")}` : "";

    if (ctx.hasUI && typeof ctx.ui.select === "function") {
      try {
        const missPct = totalCost > 0 ? ((missCost / totalCost) * 100).toFixed(1) : "0.0";
        const writeK = Math.round(totalWriteTokens / 1000);
        const writeTitle = totalWriteTokens > 0 ? ` | Write: ${writeK}k [$${writeCost.toFixed(4)}]` : "";
        const title = `Prompt Cache (${overallRate}% | Total: $${totalCost.toFixed(4)}${writeTitle} | ${fullMissCount} miss · ${partialMissCount} P | Overpaid ~$${overpay.toFixed(4)} | Miss turns: $${missCost.toFixed(4)} [${missPct}%]${avgTitle} | Enter to inspect)`;
        const chosen = await ctx.ui.select(title, options);
        if (chosen) {
          const match = chosen.match(/Turn\s+(\d+):/);
          if (match) {
            const num = parseInt(match[1], 10);
            const t = history.find((h) => h.turn === num);
            if (t) {
              const perfLines = [
                t.ts !== undefined
                  ? `• ts: ${formatTs(t.ts, t.tsEstimated)}${t.tsEstimated ? " (estimated incl. ttfs from session timestamps)" : " (output tokens / decode time)"}`
                  : "",
                t.ttfsMs !== undefined ? `• ttfs: ${formatTtfs(t.ttfsMs)}` : "",
                t.totalMs !== undefined ? `• Turn Duration: ${formatTtfs(t.totalMs)}` : "",
              ].filter(Boolean);

              if (t.isAborted) {
                ctx.ui.notify(
                  [
                    `🔍 Turn ${t.turn} Details:`,
                    `• Status: Aborted before token generation`,
                    `• Cost: $0.0000`,
                    ...perfLines,
                    `• Note: Not counted as a cache miss.`,
                  ].join("\n"),
                  "info"
                );
              } else if (t.isColdPrefill) {
                const detail = [
                  `🔍 Turn 1 Details:`,
                  `• Verdict: ❄️ Cold Prefill (Initial Cache Write)`,
                  `• Tokens Sent: ${t.totalPrompt.toLocaleString()} tokens (sent to initialize cache)`,
                  `• Tokens Written to Cache: ${t.writeTokens.toLocaleString()}`,
                  `• Cached Tokens: ${t.cached.toLocaleString()}`,
                  `• Output Generated: ${t.output.toLocaleString()}`,
                  ...perfLines,
                  `• Turn Cost: $${t.cost.toFixed(4)}`,
                  `• Note: Initial session prefill & cache write. Excluded from cache miss count and miss cost.`,
                ].join("\n");
                ctx.ui.notify(detail, "info");
              } else if (t.isWarmPrefill) {
                const detail = [
                  `🔍 Turn 1 Details:`,
                  `• Verdict: 🔥 Warm Prefill Hit (Reused Prior Session Cache)`,
                  `• Cached Tokens Reused: ${t.cached.toLocaleString()} (${t.hitPct.toFixed(1)}% cached)`,
                  `• New Tokens Sent: ${t.uncached.toLocaleString()} (appended to cache)`,
                  `• Total Prompt: ${t.totalPrompt.toLocaleString()} tokens`,
                  `• Output Generated: ${t.output.toLocaleString()}`,
                  ...perfLines,
                  `• Turn Cost: $${t.cost.toFixed(4)} (discounted cache rate)`,
                  `• Note: Initial session prompt reused active cache from recent session within TTL.`,
                ].join("\n");
                ctx.ui.notify(detail, "info");
              } else {
                const verdict = t.isHit
                  ? "✅ Cache Hit"
                  : t.isPartialMiss
                  ? "⚠️ Partial Cache Miss (P Miss)"
                  : "❌ Cache Miss";
                const costNote = t.isHit
                  ? " (discounted cache rate)"
                  : t.isPartialMiss
                  ? " (partial miss)"
                  : " (FULL UNCACHED COST)";
                const detail = [
                  `🔍 Turn ${t.turn} Details:`,
                  `• Verdict: ${verdict}`,
                  `• Turn Cost: $${t.cost.toFixed(4)}${costNote}`,
                  `• Cached Tokens: ${t.cached.toLocaleString()}`,
                  `• Uncached Input: ${t.uncached.toLocaleString()}`,
                  t.writeTokens > 0 ? `• Cache Write: ${t.writeTokens.toLocaleString()} tokens` : "",
                  `• Output Generated: ${t.output.toLocaleString()}`,
                  `• Total Prompt: ${t.totalPrompt.toLocaleString()} (${t.hitPct.toFixed(1)}% cached)`,
                  ...perfLines,
                  !t.isHit ? `• Estimated overpay: ~$${t.overpay.toFixed(4)} vs a full hit (prior prefix re-sent uncached)` : "",
                ].filter(Boolean).join("\n");
                ctx.ui.notify(detail, "info");
              }
            }
          }
        }
        return;
      } catch {}
    }

    // Fallback if select is unavailable or dismissed
    const writeK = Math.round(totalWriteTokens / 1000);
    const writeTitle = totalWriteTokens > 0 ? ` | Write: ${writeK}k [$${writeCost.toFixed(4)}]` : "";
    ctx.ui?.notify?.(
      `📊 Prompt Cache Breakdown (${overallRate}% overall | Total: $${totalCost.toFixed(4)}${writeTitle} | Overpaid ~$${overpay.toFixed(4)} | Miss turns: $${missCost.toFixed(4)}${avgTitle}):\n\n${options.join("\n")}`,
      "info"
    );
  }

  // 1. Proactive affinity routing & provider-specific cache key handling
  pi.on("before_provider_headers", (event, ctx) => {
    const sessionId = ctx.sessionManager?.getSessionId?.();
    if (!sessionId) return;

    const match = findRule(loadProviders(), ctx.model);
    if (!match) return;
    const { id: ruleId, rule } = match;

    for (const h of rule.headers ?? ["x-affinity"]) event.headers[h] = sessionId;
    if (rule.bodyCacheKey === "strip") {
      event.headers["prompt_cache_key"] = null as any;
      event.headers["prompt-cache-key"] = null as any;
    }

    if (DEBUG_HEADERS) {
      appendRotating(
        REQUEST_LOG_FILE,
        JSON.stringify({
          timestamp: new Date().toISOString(),
          event: "outgoing_headers",
          rule: ruleId,
          provider: ctx.model?.provider,
          api: ctx.model?.api,
          model: ctx.model?.id,
          sessionId,
          x_affinity: event.headers["x-affinity"],
          headers: redactHeaders(event.headers),
        }) + "\n"
      );
    }
  });

  pi.on("after_provider_response", (event, ctx) => {
    if (!DEBUG_HEADERS) return;
    const match = findRule(loadProviders(), ctx.model);
    if (!match) return;
    appendRotating(
      REQUEST_LOG_FILE,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        event: "response_received",
        rule: match.id,
        provider: ctx.model?.provider,
        model: ctx.model?.id,
        status: event.status,
        response_headers: redactHeaders(event.headers as Record<string, unknown>),
      }) + "\n"
    );
  });

  pi.on("before_provider_request", (event, ctx) => {
    activeReqStartMs = Date.now();
    activeFirstStreamMs = null;

    const sessionId = ctx.sessionManager?.getSessionId?.();
    const match = findRule(loadProviders(), ctx.model);
    if (!match) return;

    if (event.payload && typeof event.payload === "object") {
      const payload = event.payload as Record<string, unknown>;
      if (match.rule.bodyCacheKey === "strip") {
        // x-affinity header only; a body prompt_cache_key may conflict with it
        delete payload.promptCacheKey;
        delete payload.prompt_cache_key;
      } else if (match.rule.bodyCacheKey === "inject" && sessionId) {
        payload.prompt_cache_key = sessionId;
      }
      logPrefixHashes(match.id, ctx.model?.id || "", sessionId || "", payload);
    }
  });

  // 2. Lifecycle tracking
  pi.on("session_start", (_event, ctx) => {
    activeReqStartMs = null;
    activeFirstStreamMs = null;
    syncHistoryFromSession(ctx);
  });

  pi.on("before_agent_start", (_event, ctx) => {
    syncHistoryFromSession(ctx);
  });

  pi.on("message_start", (event) => {
    if (event.message?.role === "assistant" && activeReqStartMs === null) {
      activeReqStartMs = Date.now();
      activeFirstStreamMs = null;
    }
  });

  pi.on("message_update", (event) => {
    if (event.message?.role === "assistant" && activeFirstStreamMs === null) {
      activeFirstStreamMs = Date.now();
    }
  });

  pi.on("message_end", (event) => {
    const msg = event.message as any;
    if (!msg || msg.role !== "assistant") return;

    const endMs = Date.now();
    const msgTs = typeof msg.timestamp === "number" ? msg.timestamp : endMs;
    const startMs = activeReqStartMs ?? (typeof msg.timestamp === "number" ? msg.timestamp : null);
    const ttfsMs =
      startMs !== null && activeFirstStreamMs !== null
        ? Math.max(0, activeFirstStreamMs - startMs)
        : undefined;
    const totalMs = startMs !== null ? Math.max(0, endMs - startMs) : undefined;
    const decodeMs =
      activeFirstStreamMs !== null
        ? Math.max(0, endMs - activeFirstStreamMs)
        : totalMs;
    const output = msg.usage?.output ?? 0;
    const speedMs = decodeMs !== undefined && decodeMs >= 50 ? decodeMs : totalMs;
    const ts =
      output > 0 && speedMs !== undefined && speedMs > 0
        ? output / (speedMs / 1000)
        : undefined;

    if (ttfsMs !== undefined || ts !== undefined || totalMs !== undefined) {
      const timing: TimingData = {
        msgTs,
        ...(ttfsMs !== undefined ? { ttfsMs } : {}),
        ...(decodeMs !== undefined ? { decodeMs } : {}),
        ...(totalMs !== undefined ? { totalMs } : {}),
        ...(ts !== undefined ? { ts } : {}),
      };
      liveTimingsByMsgTs.set(msgTs, timing);
      try {
        pi.appendEntry("cache-timing", timing);
      } catch {}
    }

    activeReqStartMs = null;
    activeFirstStreamMs = null;
  });

  pi.on("turn_end", (_event, ctx) => {
    syncHistoryFromSession(ctx);

    const lastTurn = history[history.length - 1];
    if (lastTurn && !lastTurn.isHit && !lastTurn.isColdPrefill && !lastTurn.isAborted && lastTurn.totalPrompt > 5000) {
      try {
        ctx.ui.notify(
          `⚠️ Cache Miss: Turn ${lastTurn.turn} cost $${lastTurn.cost.toFixed(4)} (${lastTurn.cached.toLocaleString()} / ${lastTurn.totalPrompt.toLocaleString()} cached)`,
          "warning"
        );
      } catch {}
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    activeReqStartMs = null;
    activeFirstStreamMs = null;
    try {
      ctx.ui.setStatus("cache_monitor", undefined);
      if (ctx.ui.setWidget) ctx.ui.setWidget("cache_monitor_widget", undefined);
    } catch {}
  });

  // 3. Command: /cache [pMiss%] - Interactive modal or set P Miss % threshold
  pi.registerCommand("cache", {
    description: "Show prompt cache history (/cache) or set P Miss % threshold (/cache 10)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const trimmed = (args ?? "").trim();
      if (!trimmed) {
        await showInteractiveModal(ctx);
        return;
      }
      const pct = parsePctInput(trimmed);
      if (pct === null) {
        ctx.ui?.notify?.("Usage: /cache <0-100> (e.g. /cache 10)", "warning");
        return;
      }
      const { missPct } = loadThresholds();
      saveThresholds(pct, missPct);
      syncHistoryFromSession(ctx);
      ctx.ui?.notify?.(`Thresholds: P Miss > ${pct}% | Miss > ${missPct}%`, "info");
    },
  });

  // 3b. Command: /cache_c [miss%] - Set complete Miss % threshold
  pi.registerCommand("cache_c", {
    description: "Set complete cache Miss % threshold (/cache_c 50)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const trimmed = (args ?? "").trim();
      const current = loadThresholds();
      if (!trimmed) {
        ctx.ui?.notify?.(`Thresholds: P Miss > ${current.pMissPct}% | Miss > ${current.missPct}%`, "info");
        return;
      }
      const pct = parsePctInput(trimmed);
      if (pct === null) {
        ctx.ui?.notify?.("Usage: /cache_c <0-100> (e.g. /cache_c 50)", "warning");
        return;
      }
      saveThresholds(current.pMissPct, pct);
      syncHistoryFromSession(ctx);
      ctx.ui?.notify?.(`Thresholds: P Miss > ${current.pMissPct}% | Miss > ${pct}%`, "info");
    },
  });

  // 4. Command: /cache-widget - Toggle persistent widget below the editor
  pi.registerCommand("cache-widget", {
    description: "Toggle persistent cache status widget below the editor",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      widgetEnabled = !widgetEnabled;
      updateStatusAndWidget(ctx);
      ctx.ui.notify(
        widgetEnabled ? "Persistent cache widget enabled" : "Persistent cache widget disabled",
        "info"
      );
    },
  });

  // 5. Global Keyboard Shortcut: Ctrl+Alt+C
  try {
    pi.registerShortcut("ctrl+alt+c", {
      description: "Open interactive prompt cache breakdown",
      handler: async (ctx) => {
        await showInteractiveModal(ctx);
      },
    });
  } catch {}
}
