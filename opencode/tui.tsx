import { Plugin } from "@opencode/plugin/tui";
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createSignal } from "solid-js";

const DB_FILE = join(homedir(), ".local/share/opencode/opencode.db");
const MODELS_CACHE_FILE = join(homedir(), ".cache/opencode/models.json");
const GO_LIMITS_FILE = join(homedir(), ".cache/oc-models-pro/go-limits.json");
const PRICING_CACHE_FILE = join(homedir(), ".cache/opencode/cache-monitor-pricing.json");
const OPENCODE_CONFIG_FILE = join(homedir(), ".config/opencode/opencode.json");
const CONFIG_FILE = join(homedir(), ".local/share/opencode/cache-monitor-config.json");
const PRICING_REFRESH_MS = 24 * 60 * 60 * 1000;
const DEFAULT_P_MISS_PCT = 10;
const DEFAULT_MISS_PCT = 50;

function readConfigFile(): Record<string, any> {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
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
    // Read-modify-write so the "providers" section (used by index.ts) is preserved.
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

interface ModelRate {
  input?: number;
  output?: number;
  reasoning?: number;
  cache_read?: number;
  cache_write?: number;
  tiers?: Array<ModelRate & { tier?: { type?: string; size?: number } }>;
  context_over_200k?: ModelRate;
}

const FALLBACK_PRICING_PROVIDERS = [
  "opencode-go",
  "opencode",
  "anthropic",
  "openai",
  "deepseek",
  "mistral",
  "google",
];

let modelsCache: { mtimeMs: number; data: Record<string, any> } | null = null;
let pricingCache: { mtimeMs: number; data: { fetchedAt?: number; goLimits?: any[]; custom?: Record<string, Record<string, ModelRate>> } } | null = null;
let goTariffCache: { sig: string; byKey: Map<string, { peak?: ModelRate; offPeak?: ModelRate; base?: ModelRate }> } | null = null;

function normModelKey(name: string): string {
  return name
    .replace(/\s*\((?:off-?peak|peak)\)\s*$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function loadPricingCache(): { fetchedAt?: number; goLimits?: any[]; custom?: Record<string, Record<string, ModelRate>> } {
  try {
    const st = statSync(PRICING_CACHE_FILE);
    if (pricingCache && pricingCache.mtimeMs === st.mtimeMs) return pricingCache.data;
    const data = JSON.parse(readFileSync(PRICING_CACHE_FILE, "utf8"));
    if (data && typeof data === "object") {
      pricingCache = { mtimeMs: st.mtimeMs, data };
      return data;
    }
  } catch {}
  return pricingCache?.data ?? {};
}

function stripHtmlText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function parseCellMoney(html: string): number | undefined {
  const plain = stripHtmlText(html);
  if (/free/i.test(plain)) return 0;
  const m = plain.match(/\$([\d.]+)/);
  return m ? Number(m[1]) : undefined;
}

function parseGoPricingHtml(html: string): any[] {
  const rows = html.split(/<tr[\s>]/i).slice(1);
  const out: any[] = [];
  const seen = new Set<string>();
  for (const raw of rows) {
    const row = raw.split(/<\/tr>/i)[0] ?? "";
    const cells = row.match(/<td[^>]*>[\s\S]*?<\/td>/gi) ?? [];
    if (cells.length < 5) continue;
    const name = stripHtmlText(cells[0] ?? "");
    if (!name || /^model$/i.test(name) || seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      input: parseCellMoney(cells[1] ?? ""),
      output: parseCellMoney(cells[2] ?? ""),
      cacheRead: parseCellMoney(cells[3] ?? ""),
      cacheWrite: parseCellMoney(cells[4] ?? ""),
    });
  }
  return out;
}

function extractNumericModelRate(entry: any): ModelRate | null {
  if (!entry || typeof entry !== "object") return null;
  if (entry.cost && typeof entry.cost === "object" && typeof entry.cost.input === "number") {
    return entry.cost as ModelRate;
  }
  const p = entry.pricing;
  if (p && typeof p === "object") {
    const toPerM = (v: unknown) => {
      const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
      return Number.isFinite(n) && n >= 0 ? n * 1_000_000 : undefined;
    };
    const input = toPerM(p.prompt ?? p.input);
    const output = toPerM(p.completion ?? p.output);
    if (input !== undefined || output !== undefined) {
      return {
        input,
        output,
        cache_read: toPerM(p.input_cache_read ?? p.cache_read),
        cache_write: toPerM(p.input_cache_write ?? p.cache_write),
      };
    }
  }
  return null;
}

function resolveEnvTemplate(val: unknown): string {
  if (typeof val !== "string") return "";
  return val.replace(/\{env:([^}]+)\}/g, (_, name) => process.env[name] ?? "");
}

async function refreshPricingCache() {
  try {
    const existing = loadPricingCache();
    if (existing.fetchedAt && Date.now() - existing.fetchedAt < PRICING_REFRESH_MS) return;

    let goLimits = existing.goLimits;
    try {
      const res = await fetch("https://opencode.ai/docs/console/go/", { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const parsed = parseGoPricingHtml(await res.text());
        if (parsed.length > 0) goLimits = parsed;
      }
    } catch {}

    const custom: Record<string, Record<string, ModelRate>> = { ...(existing.custom ?? {}) };
    try {
      const ocCfg = JSON.parse(readFileSync(OPENCODE_CONFIG_FILE, "utf8"));
      const providers = ocCfg?.provider ?? {};
      for (const [pid, pcfg] of Object.entries<any>(providers)) {
        const baseURL = typeof pcfg?.options?.baseURL === "string" ? pcfg.options.baseURL.replace(/\/+$/, "") : "";
        if (!baseURL || pid === "ollama") continue;
        const apiKey = resolveEnvTemplate(pcfg?.options?.apiKey);
        const headers: Record<string, string> = {};
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
        try {
          const res = await fetch(`${baseURL}/models`, { headers, signal: AbortSignal.timeout(4000) });
          if (!res.ok) continue;
          const body: any = await res.json();
          const list: any[] = Array.isArray(body?.data) ? body.data : [];
          const rates: Record<string, ModelRate> = {};
          for (const item of list) {
            const rate = extractNumericModelRate(item);
            if (rate && item?.id) rates[String(item.id)] = rate;
          }
          if (Object.keys(rates).length > 0) custom[pid] = rates;
        } catch {}
      }
    } catch {}

    mkdirSync(dirname(PRICING_CACHE_FILE), { recursive: true });
    writeFileSync(PRICING_CACHE_FILE, JSON.stringify({ fetchedAt: Date.now(), goLimits, custom }));
    pricingCache = null;
    goTariffCache = null;
  } catch {}
}

function loadGoTariffs(): Map<string, { peak?: ModelRate; offPeak?: ModelRate; base?: ModelRate }> {
  try {
    const cached = loadPricingCache();
    let limits: any[] = [];
    let sig = "";
    if (Array.isArray(cached.goLimits) && cached.goLimits.length > 0) {
      limits = cached.goLimits;
      sig = `cache:${cached.fetchedAt ?? 0}`;
    } else {
      const st = statSync(GO_LIMITS_FILE);
      sig = `file:${st.mtimeMs}`;
      if (goTariffCache && goTariffCache.sig === sig) return goTariffCache.byKey;
      const parsed = JSON.parse(readFileSync(GO_LIMITS_FILE, "utf8"));
      limits = parsed?.plan?.limits ?? [];
    }
    if (goTariffCache && goTariffCache.sig === sig) return goTariffCache.byKey;

    const byKey = new Map<string, { peak?: ModelRate; offPeak?: ModelRate; base?: ModelRate }>();
    for (const row of limits) {
      if (!row?.name) continue;
      const k = normModelKey(String(row.name));
      const entry = byKey.get(k) ?? {};
      const rate: ModelRate = {
        input: typeof row.input === "number" ? row.input : undefined,
        output: typeof row.output === "number" ? row.output : undefined,
        cache_read: typeof row.cacheRead === "number" ? row.cacheRead : undefined,
        cache_write: typeof row.cacheWrite === "number" ? row.cacheWrite : undefined,
      };
      if (/\(peak\)/i.test(row.name)) entry.peak = rate;
      else if (/\(off-?peak\)/i.test(row.name)) entry.offPeak = rate;
      else entry.base = rate;
      byKey.set(k, entry);
    }
    goTariffCache = { sig, byKey };
    return byKey;
  } catch {
    return goTariffCache?.byKey ?? new Map();
  }
}

function isUtcPeakWindow(timestampMs?: number): boolean {
  if (!timestampMs || !Number.isFinite(timestampMs)) return false;
  const d = new Date(timestampMs);
  const day = d.getUTCDay(); // 0=Sun .. 6=Sat
  if (day === 0 || day === 6) return false;
  const hour = d.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

function loadModelsCache(): Record<string, any> {
  try {
    const st = statSync(MODELS_CACHE_FILE);
    if (modelsCache && modelsCache.mtimeMs === st.mtimeMs) return modelsCache.data;
    const data = JSON.parse(readFileSync(MODELS_CACHE_FILE, "utf8"));
    if (data && typeof data === "object") {
      modelsCache = { mtimeMs: st.mtimeMs, data };
      return data;
    }
  } catch {}
  return modelsCache?.data ?? {};
}

function resolveModelPricing(
  providerID?: string,
  modelID?: string,
  timestampMs?: number
): { rate: ModelRate | null; tariff?: "peak" | "off-peak" } {
  if (!modelID) return { rate: null };
  const cfg = readConfigFile();
  const userPricing = cfg?.pricing;
  if (userPricing && typeof userPricing === "object") {
    const exact = providerID ? userPricing[`${providerID}/${modelID}`] : undefined;
    if (exact && typeof exact === "object") return { rate: exact as ModelRate };
    const byModel = userPricing[modelID];
    if (byModel && typeof byModel === "object") return { rate: byModel as ModelRate };
  }

  if (providerID === "ollama" || modelID.endsWith("-free")) return { rate: null };

  const liveCustom = providerID ? loadPricingCache().custom?.[providerID]?.[modelID] : undefined;
  if (liveCustom) return { rate: liveCustom };

  // OpenCode Go models with Peak / Off-Peak tariffs (from go-limits.json)
  if (providerID === "opencode-go") {
    const goEntry = loadGoTariffs().get(normModelKey(modelID));
    if (goEntry && (goEntry.peak || goEntry.offPeak)) {
      const peakNow = isUtcPeakWindow(timestampMs);
      const chosen = peakNow ? (goEntry.peak ?? goEntry.offPeak) : (goEntry.offPeak ?? goEntry.peak);
      if (chosen) return { rate: chosen, tariff: peakNow ? "peak" : "off-peak" };
    }
    if (goEntry?.base) return { rate: goEntry.base };
  }

  const models = loadModelsCache();
  if (providerID && models[providerID]?.models?.[modelID]?.cost) {
    return { rate: models[providerID].models[modelID].cost as ModelRate };
  }

  // Custom OpenAI-compatible providers (e.g. opendesign) aren't in models.json;
  // fall back to canonical provider entries and go-limits.json for the same model id.
  if (!providerID || !models[providerID]) {
    const stripped = modelID.includes("/") ? modelID.split("/").pop()! : modelID;
    const baseVariant = stripped
      .replace(/-(?:eco|thinking|reasoning|high|medium|low|fast)$/i, "")
      .replace(/flashx$/i, "flash");
    const candidates = stripped === baseVariant ? [modelID, stripped] : [modelID, stripped, baseVariant];

    for (const cand of candidates) {
      for (const pid of FALLBACK_PRICING_PROVIDERS) {
        const m = models[pid]?.models;
        if (m?.[cand]?.cost) return { rate: m[cand].cost as ModelRate };
      }
      const goEntry = loadGoTariffs().get(normModelKey(cand));
      const goRate = goEntry?.base ?? goEntry?.offPeak ?? goEntry?.peak;
      if (goRate) return { rate: goRate };
    }
  }
  return { rate: null };
}

function selectRateTier(base: ModelRate, totalPromptTokens: number): ModelRate {
  if (Array.isArray(base.tiers) && base.tiers.length > 0) {
    const sorted = [...base.tiers]
      .filter((t) => t?.tier?.type === "context" && typeof t.tier.size === "number")
      .sort((a, b) => (b.tier!.size ?? 0) - (a.tier!.size ?? 0));
    for (const t of sorted) {
      if (totalPromptTokens > (t.tier!.size ?? 0)) return t;
    }
  }
  if (base.context_over_200k && totalPromptTokens > 200_000) {
    return base.context_over_200k;
  }
  return base;
}

function estimateTurnCost(
  tokens: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } },
  providerID?: string,
  modelID?: string,
  timestampMs?: number
): { cost: number; tariff?: "peak" | "off-peak" } {
  const { rate: base, tariff } = resolveModelPricing(providerID, modelID, timestampMs);
  if (!base) return { cost: 0 };
  const input = tokens.input || 0;
  const read = tokens.cache?.read || 0;
  const write = tokens.cache?.write || 0;
  const output = tokens.output || 0;
  const reasoning = tokens.reasoning || 0;
  const rates = selectRateTier(base, input + read + write);
  const total =
    input * (rates.input ?? 0) +
    read * (rates.cache_read ?? 0) +
    write * (rates.cache_write ?? rates.input ?? 0) +
    output * (rates.output ?? 0) +
    reasoning * (rates.reasoning ?? rates.output ?? 0);
  return { cost: total / 1_000_000, tariff };
}

function fmtCost(cost: number, estimated: boolean, decimals: number): string {
  const prefix = estimated && cost > 0 ? "~" : "";
  return `${prefix}$${cost.toFixed(decimals)}`;
}

interface TurnDetail {
  turn: number;
  isHit: boolean;
  isPartialMiss: boolean;
  isColdPrefill: boolean;
  isWarmPrefill: boolean;
  readK: number;
  readTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  writeTokens: number;
  totalTokens: number;
  cost: number;
  costEstimated: boolean;
  agent: string;
  providerID: string;
  modelID: string;
  label: string;
  description: string;
  detail: string;
}

function fmtK(n: number): string {
  if (n >= 10000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function currentSessionID(context: any): string | undefined {
  try {
    const route = context?.ui?.router?.current?.();
    if (route && route.type === "session") return route.sessionID;
  } catch {}
  return undefined;
}

// The database can be very large and the badge refreshes every 2s, so keep one
// read-only handle and only re-parse a session when its rows changed.
let sharedDb: Database | null = null;
const turnCache = new Map<string, { sig: string; turns: TurnDetail[] }>();

function getDb(): Database {
  if (!sharedDb) sharedDb = new Database(DB_FILE, { readonly: true });
  return sharedDb;
}

function getSessionTurnHistory(sessionID?: string): TurnDetail[] {
  if (!sessionID) return [];
  const { pMissPct, missPct } = loadThresholds();
  const strictHitFloor = Math.max(0, Math.min(1, (100 - pMissPct) / 100));
  const completeHitFloor = Math.max(0, Math.min(1, (100 - missPct) / 100));
  try {
    const db = getDb();
    const head = db
      .query(`SELECT COUNT(*) AS c, MAX(time_created) AS m FROM session_message WHERE session_id = ?`)
      .get(sessionID) as any;
    const sig = `${head?.c}:${head?.m}:${pMissPct}:${missPct}`;
    const cached = turnCache.get(sessionID);
    if (cached && cached.sig === sig) return cached.turns;

    const rows = db.query(`
      SELECT data, time_created
      FROM session_message
      WHERE session_id = ?
      ORDER BY time_created ASC
    `).all(sessionID) as any[];

    const turns: TurnDetail[] = [];
    let turn = 0;
    for (const r of rows) {
      try {
        const d = JSON.parse(r.data);
        if (d.tokens && (d.tokens.input > 0 || (d.tokens.cache && d.tokens.cache.read > 0))) {
          turn++;
          const input = d.tokens.input || 0;
          const read = d.tokens.cache?.read || 0;
          const explicitWrite = d.tokens.cache?.write || 0;
          const output = d.tokens.output || 0;
          const reasoning = d.tokens.reasoning || 0;
          const rawCost = typeof d.cost === "number" ? d.cost : 0;
          const agent = d.agent || "default";
          const providerID = d.model?.providerID || d.providerID || "";
          const modelID = d.model?.id || d.modelID || "";
          const msgTs = typeof d.time?.created === "number" ? d.time.created : r.time_created;
          const costEstimated = !(rawCost > 0);
          const est = rawCost > 0 ? { cost: rawCost, tariff: undefined } : estimateTurnCost(d.tokens, providerID, modelID, msgTs);
          const cost = est.cost;
          const total = input + read;
          const isCompleteHit = total > 0 && read >= total * completeHitFloor;
          const isStrictHit = total > 0 && read >= total * strictHitFloor;
          const isColdPrefill = turn === 1 && !isCompleteHit;
          const isWarmPrefill = turn === 1 && isCompleteHit;
          const isHit = turn === 1 ? isWarmPrefill : isCompleteHit && isStrictHit;
          const isPartialMiss = turn > 1 && isCompleteHit && !isStrictHit;
          const readK = Math.round(read / 1000);
          const costStr = fmtCost(cost, costEstimated, 4);
          const shortCost = fmtCost(cost, costEstimated, cost > 0 && cost < 0.01 ? 3 : 2);
          const pctStr = total > 0 ? ((read / total) * 100).toFixed(1) : "0.0";
          const tariffSuffix = est.tariff ? ` (${est.tariff})` : "";
          const tariffTag = est.tariff === "peak" ? " · peak" : "";

          let turnWriteTokens = 0;
          let label = "";
          let description = "";
          let detail = "";

          const outputStr = output + reasoning > 0 ? ` · ${(output + reasoning).toLocaleString()} out` : "";
          const modelDetail = modelID ? ` [${agent} · ${providerID ? `${providerID}/` : ""}${modelID}${tariffSuffix}]` : "";

          if (isColdPrefill) {
            turnWriteTokens = explicitWrite > 0 ? explicitWrite : input;
            label = `T1 Cold (${fmtK(total)}->${fmtK(turnWriteTokens)}W) ${shortCost}`;
            description = `warmup${tariffTag}`;
            detail = `Cold prefill: ${total.toLocaleString()} tokens sent, ${turnWriteTokens.toLocaleString()} written to cache (${costStr}${outputStr})${modelDetail}`;
          } else if (isWarmPrefill) {
            turnWriteTokens = explicitWrite > 0 ? explicitWrite : input;
            label = `T1 Warm (${fmtK(read)}+${fmtK(input)}) ${shortCost}`;
            description = `${pctStr}% cached${tariffTag}`;
            detail = `Warm prefill hit: ${read.toLocaleString()} cached + ${input.toLocaleString()} new tokens sent (${pctStr}% cached · ${costStr}${outputStr})${modelDetail}`;
          } else if (isHit) {
            turnWriteTokens = explicitWrite;
            label = `T${turn} Hit (${fmtK(read)}) ${shortCost}`;
            description = `${pctStr}% (${fmtK(read)}/${fmtK(total)})${tariffTag}`;
            detail = `${pctStr}% cached (${read.toLocaleString()} / ${total.toLocaleString()} tokens · ${costStr}${outputStr})${modelDetail}`;
          } else if (isPartialMiss) {
            turnWriteTokens = explicitWrite;
            label = `T${turn} P Miss (${fmtK(read)}) ${shortCost}`;
            description = `${pctStr}% (${fmtK(read)}/${fmtK(total)})${tariffTag}`;
            detail = `Partial Miss (P Miss): ${pctStr}% cached (${read.toLocaleString()} / ${total.toLocaleString()} tokens · ${costStr}${outputStr})${modelDetail}`;
          } else {
            turnWriteTokens = explicitWrite;
            label = `T${turn} Miss (${fmtK(read)}) ${shortCost}`;
            description = `${pctStr}% (${fmtK(read)}/${fmtK(total)})${tariffTag}`;
            detail = `Cache Miss: ${pctStr}% cached (${read.toLocaleString()} / ${total.toLocaleString()} tokens · turn cost ${costStr}${outputStr})${modelDetail}`;
          }

          turns.push({
            turn,
            isHit,
            isPartialMiss,
            isColdPrefill,
            isWarmPrefill,
            readK,
            readTokens: read,
            inputTokens: input,
            outputTokens: output,
            reasoningTokens: reasoning,
            writeTokens: turnWriteTokens,
            totalTokens: total,
            cost,
            costEstimated,
            agent,
            providerID,
            modelID,
            label,
            description,
            detail,
          });
        }
      } catch {}
    }
    turnCache.set(sessionID, { sig, turns });
    return turns;
  } catch {
    sharedDb = null; // reopen on next call
    return [];
  }
}

interface AggregateStats {
  turns: number;
  inputTokens: number;
  readTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  writeTokens: number;
  cost: number;
  costEstimated: boolean;
  fullMisses: number;
  partialMisses: number;
}

interface AgentModelGroup extends AggregateStats {
  agent: string;
  providerID: string;
  modelID: string;
}

interface TaskSessionStats extends AggregateStats {
  sessionID: string;
  title: string;
  depth: number;
  agent: string;
  providerID: string;
  modelID: string;
}

interface SessionTreeBreakdown {
  byAgentModel: AgentModelGroup[];
  byTask: TaskSessionStats[];
  totals: AggregateStats & { childCount: number };
}

function emptyStats(): AggregateStats {
  return {
    turns: 0,
    inputTokens: 0,
    readTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    writeTokens: 0,
    cost: 0,
    costEstimated: false,
    fullMisses: 0,
    partialMisses: 0,
  };
}

function addTurnToStats(stats: AggregateStats, t: TurnDetail) {
  stats.turns++;
  stats.inputTokens += t.inputTokens;
  stats.readTokens += t.readTokens;
  stats.outputTokens += t.outputTokens;
  stats.reasoningTokens += t.reasoningTokens;
  stats.writeTokens += t.writeTokens;
  stats.cost += t.cost;
  if (t.costEstimated && t.cost > 0) stats.costEstimated = true;
  if (t.isPartialMiss) stats.partialMisses++;
  else if (!t.isColdPrefill && !t.isHit) stats.fullMisses++;
}

function getSessionTreeBreakdown(sessionID?: string): SessionTreeBreakdown | null {
  if (!sessionID) return null;
  try {
    const db = getDb();
    const treeRows = db
      .query(
        `WITH RECURSIVE tree(id, parent_id, title, agent, model, depth, time_created) AS (
          SELECT id, parent_id, title, agent, model, 0, time_created FROM session_v2 WHERE id = ?
          UNION ALL
          SELECT s.id, s.parent_id, s.title, s.agent, s.model, t.depth + 1, s.time_created
          FROM session_v2 s JOIN tree t ON s.parent_id = t.id
        )
        SELECT id, title, agent, model, depth FROM tree ORDER BY depth ASC, time_created ASC`
      )
      .all(sessionID) as Array<{ id: string; title: string | null; agent: string | null; model: string | null; depth: number }>;

    if (treeRows.length === 0) return null;

    const agentMap = new Map<string, AgentModelGroup>();
    const byTask: TaskSessionStats[] = [];
    const totals: AggregateStats & { childCount: number } = {
      ...emptyStats(),
      childCount: Math.max(0, treeRows.length - 1),
    };

    for (const row of treeRows) {
      const turns = getSessionTurnHistory(row.id);
      if (turns.length === 0) continue;

      let parsedModel: { id?: string; providerID?: string } = {};
      try {
        if (row.model) parsedModel = JSON.parse(row.model);
      } catch {}

      const taskStats: TaskSessionStats = {
        ...emptyStats(),
        sessionID: row.id,
        title: row.title || (row.depth === 0 ? "Root session" : row.id),
        depth: row.depth,
        agent: row.agent || turns[0]?.agent || "default",
        providerID: parsedModel.providerID || turns[0]?.providerID || "",
        modelID: parsedModel.id || turns[0]?.modelID || "",
      };

      for (const t of turns) {
        addTurnToStats(totals, t);
        addTurnToStats(taskStats, t);

        const key = `${t.agent}\0${t.providerID}\0${t.modelID}`;
        let group = agentMap.get(key);
        if (!group) {
          group = {
            ...emptyStats(),
            agent: t.agent,
            providerID: t.providerID,
            modelID: t.modelID,
          };
          agentMap.set(key, group);
        }
        addTurnToStats(group, t);
      }
      byTask.push(taskStats);
    }

    const byAgentModel = [...agentMap.values()].sort((a, b) => b.cost - a.cost || b.turns - a.turns);
    return { byAgentModel, byTask, totals };
  } catch {
    return null;
  }
}

function truncPad(s: string, width: number): string {
  if (s.length > width) return `${s.slice(0, Math.max(1, width - 1))}…`;
  return s.padEnd(width);
}

function padL(s: string, width: number): string {
  return s.length >= width ? s : s.padStart(width);
}

function setWideDialog(context: any) {
  setTimeout(() => {
    try {
      context.ui?.dialog?.setSize?.("large");
    } catch {}
  }, 0);
}

let dialogOpen = false;

async function openAgentDetailDialog(
  context: any,
  group: AgentModelGroup,
  breakdown: SessionTreeBreakdown,
  rootSessionID?: string
) {
  if (dialogOpen) return;
  const promptTotal = group.inputTokens + group.readTokens;
  const rate = promptTotal > 0 ? ((group.readTokens / promptTotal) * 100).toFixed(1) : "100.0";
  const costStr = fmtCost(group.cost, group.costEstimated, 4);
  const modelName = group.providerID ? `${group.providerID}/${group.modelID || "?"}` : group.modelID || "?";
  const matchingTasks = breakdown.byTask.filter(
    (t) => t.agent === group.agent && t.modelID === group.modelID && t.providerID === group.providerID
  );

  const options = [
    {
      title: "← Back",
      value: "__back__",
      description: "Subagents & Models",
    },
    {
      title: `Provider ${group.providerID || "unknown"}`,
      value: "__info_provider__",
      description: "",
    },
    {
      title: `Model    ${group.modelID || "unknown"}`,
      value: "__info_model__",
      description: "",
    },
    {
      title: `Agent    ${group.agent}`,
      value: "__info_agent__",
      description: "",
    },
    {
      title: `Spend    ${costStr}`,
      value: "__info_spend__",
      description: `${group.turns} turns`,
    },
    {
      title: `Cache    ${rate}%`,
      value: "__info_cache__",
      description: `${group.fullMisses} miss · ${group.partialMisses} P Miss`,
    },
    {
      title: `Tokens   ${fmtK(group.readTokens)} read · ${fmtK(group.inputTokens)} new`,
      value: "__info_tokens__",
      description: `${fmtK(group.outputTokens + group.reasoningTokens)} out`,
    },
    ...matchingTasks.map((task) => {
      const tPrompt = task.inputTokens + task.readTokens;
      const tRate = tPrompt > 0 ? ((task.readTokens / tPrompt) * 100).toFixed(0) : "100";
      const tCost = fmtCost(task.cost, task.costEstimated, task.cost > 0 && task.cost < 0.01 ? 3 : 2);
      const label = task.depth === 0 ? `root: ${task.title}` : task.title;
      return {
        title: `• ${truncPad(label, 22)} ${padL(tCost, 7)}`,
        value: `task:${task.sessionID}`,
        description: `${task.turns}t · ${tRate}% · ${task.fullMisses}m`,
      };
    }),
  ];

  let action: "back" | "stay" | "drill" | null = null;
  let drillSessionID: string | null = null;
  dialogOpen = true;
  try {
    setWideDialog(context);
    const chosen = await context.ui.dialog.select({
      title: `${group.agent} · ${group.modelID || "?"} · ${costStr}`,
      placeholder: "Select a task or ← Back",
      options,
    });
    const pickedVal = typeof chosen === "string" ? chosen : chosen?.value;
    if (pickedVal === "__back__") {
      action = "back";
    } else if (typeof pickedVal === "string" && pickedVal.startsWith("task:")) {
      action = "drill";
      drillSessionID = pickedVal.slice(5);
    } else if (typeof pickedVal === "string" && pickedVal.startsWith("__info_")) {
      action = "stay";
    }
  } catch {
  } finally {
    dialogOpen = false;
  }

  if (action === "back") {
    await openAgentBreakdownDialog(context, breakdown, rootSessionID);
  } else if (action === "stay") {
    await openAgentDetailDialog(context, group, breakdown, rootSessionID);
  } else if (action === "drill" && drillSessionID) {
    const task = breakdown.byTask.find((t) => t.sessionID === drillSessionID);
    await openHistoryDialog(context, drillSessionID, {
      title: task?.title,
      agent: task?.agent ?? group.agent,
      hideTreeLink: true,
      backLabel: `← Back to ${group.agent}`,
      onBack: () => openAgentDetailDialog(context, group, breakdown, rootSessionID),
    });
  }
}

async function openAgentBreakdownDialog(
  context: any,
  breakdown: SessionTreeBreakdown,
  rootSessionID?: string
) {
  if (dialogOpen) return;
  const { byAgentModel, totals } = breakdown;
  const totalCostStr = fmtCost(totals.cost, totals.costEstimated, 3);
  const title = `Agents & Models · ${totals.turns}t · ${totalCostStr}`;

  const options = [
    ...(rootSessionID
      ? [
          {
            title: "← Back",
            value: "__back__",
            description: "Session history",
          },
        ]
      : []),
    ...byAgentModel.map((g, idx) => {
      const promptTotal = g.inputTokens + g.readTokens;
      const rate = promptTotal > 0 ? ((g.readTokens / promptTotal) * 100).toFixed(0) : "100";
      const costStr = fmtCost(g.cost, g.costEstimated, g.cost > 0 && g.cost < 0.01 ? 3 : 2);
      return {
        title: `• ${truncPad(g.agent, 13)} ${padL(costStr, 7)}`,
        value: `agent:${idx}`,
        description: `${g.modelID || "?"} · ${g.turns}t · ${rate}% · ${g.fullMisses}m`,
      };
    }),
  ];

  let action: "back" | "agent" | null = null;
  let selectedAgent: AgentModelGroup | null = null;
  dialogOpen = true;
  try {
    setWideDialog(context);
    const chosen = await context.ui.dialog.select({
      title,
      placeholder: "Filter (agent, model)",
      options,
    });
    const pickedVal = typeof chosen === "string" ? chosen : chosen?.value;
    if (pickedVal === "__back__") {
      action = "back";
    } else if (typeof pickedVal === "string" && pickedVal.startsWith("agent:")) {
      const g = byAgentModel[Number(pickedVal.slice(6))];
      if (g) {
        action = "agent";
        selectedAgent = g;
      }
    }
  } catch {
  } finally {
    dialogOpen = false;
  }

  if (action === "back" && rootSessionID) {
    await openHistoryDialog(context, rootSessionID);
  } else if (action === "agent" && selectedAgent) {
    await openAgentDetailDialog(context, selectedAgent, breakdown, rootSessionID);
  }
}

async function openTaskListDialog(
  context: any,
  breakdown: SessionTreeBreakdown,
  rootSessionID?: string
) {
  if (dialogOpen) return;
  const tasks = breakdown.byTask.filter((t) => t.depth > 0);
  const taskCost = tasks.reduce((s, t) => s + t.cost, 0);
  const taskEst = tasks.some((t) => t.costEstimated && t.cost > 0);
  const taskTurns = tasks.reduce((s, t) => s + t.turns, 0);
  const title = `Subagent Tasks (${tasks.length}) · ${taskTurns}t · ${fmtCost(taskCost, taskEst, 3)}`;

  const options = [
    ...(rootSessionID
      ? [
          {
            title: "← Back",
            value: "__back__",
            description: "Session history",
          },
        ]
      : []),
    ...tasks.map((task) => {
      const promptTotal = task.inputTokens + task.readTokens;
      const rate = promptTotal > 0 ? ((task.readTokens / promptTotal) * 100).toFixed(0) : "100";
      const costStr = fmtCost(task.cost, task.costEstimated, task.cost > 0 && task.cost < 0.01 ? 3 : 2);
      return {
        title: `• ${truncPad(task.title, 22)} ${padL(costStr, 7)}`,
        value: `task:${task.sessionID}`,
        description: `${task.agent} · ${task.modelID || "?"} · ${task.turns}t · ${rate}%`,
      };
    }),
  ];

  let action: "back" | "drill" | null = null;
  let drillSessionID: string | null = null;
  dialogOpen = true;
  try {
    setWideDialog(context);
    const chosen = await context.ui.dialog.select({
      title,
      placeholder: "Filter (task name, agent, model)",
      options,
    });
    const pickedVal = typeof chosen === "string" ? chosen : chosen?.value;
    if (pickedVal === "__back__") {
      action = "back";
    } else if (typeof pickedVal === "string" && pickedVal.startsWith("task:")) {
      action = "drill";
      drillSessionID = pickedVal.slice(5);
    }
  } catch {
  } finally {
    dialogOpen = false;
  }

  if (action === "back" && rootSessionID) {
    await openHistoryDialog(context, rootSessionID);
  } else if (action === "drill" && drillSessionID) {
    const task = tasks.find((t) => t.sessionID === drillSessionID);
    await openHistoryDialog(context, drillSessionID, {
      title: task?.title,
      agent: task?.agent,
      hideTreeLink: true,
      backLabel: "← Back to Subagent Tasks",
      onBack: () => openTaskListDialog(context, breakdown, rootSessionID),
    });
  }
}

interface HistoryNav {
  title?: string;
  agent?: string;
  backLabel?: string;
  hideTreeLink?: boolean;
  onBack?: () => Promise<void>;
}

async function openSummaryDialog(
  context: any,
  opts: {
    sessionID?: string;
    nav?: HistoryNav;
    header: string;
    providerSummary: string;
    modelSummary: string;
    agentSummary: string;
    turnsCount: number;
    totalCost: number;
    totalCostEstimated: boolean;
    missCost: number;
    missCostEstimated: boolean;
    turnAvgPct: number;
    tokenWeightedPct: number;
    totalRead: number;
    totalInput: number;
    totalGen: number;
    totalReasoning: number;
    writeTokens: number;
    fullMisses: number;
    partialMisses: number;
    treeLine: string;
  }
) {
  if (dialogOpen) return;
  const options = [
    {
      title: "← Back",
      value: "__back__",
      description: "Turn history",
    },
    ...(opts.nav?.title
      ? [{ title: `Task     ${truncPad(opts.nav.title, 30).trim()}`, value: "__i0__", description: "" }]
      : []),
    {
      title: `Provider ${opts.providerSummary}`,
      value: "__i1__",
      description: "",
    },
    {
      title: `Model    ${opts.modelSummary}`,
      value: "__i2__",
      description: "",
    },
    {
      title: `Agent    ${opts.agentSummary}`,
      value: "__i2b__",
      description: "",
    },
    {
      title: `Spend   ${fmtCost(opts.totalCost, opts.totalCostEstimated, 4)}`,
      value: "__i3__",
      description: `${opts.turnsCount} turns`,
    },
    ...(opts.treeLine
      ? [{ title: `Tree    ${opts.treeLine}`, value: "__i4__", description: "" }]
      : []),
    {
      title: `Cache   ${opts.tokenWeightedPct.toFixed(1)}% token`,
      value: "__i5__",
      description: `${opts.turnAvgPct.toFixed(1)}% turn avg`,
    },
    {
      title: `Misses  ${opts.fullMisses} miss · ${opts.partialMisses} P`,
      value: "__i6__",
      description: `miss cost ${fmtCost(opts.missCost, opts.missCostEstimated, 4)}`,
    },
    {
      title: `Read    ${opts.totalRead.toLocaleString()}`,
      value: "__i7__",
      description: "cached input tokens",
    },
    {
      title: `New In  ${opts.totalInput.toLocaleString()}`,
      value: "__i8__",
      description: "uncached input tokens",
    },
    {
      title: `Output  ${opts.totalGen.toLocaleString()}`,
      value: "__i9__",
      description: opts.totalReasoning > 0 ? `incl. ${opts.totalReasoning.toLocaleString()} reasoning` : "output tokens",
    },
    ...(opts.writeTokens > 0
      ? [{ title: `Write   ${opts.writeTokens.toLocaleString()}`, value: "__i10__", description: "cache write tokens" }]
      : []),
  ];

  let action: "back" | "stay" | null = null;
  dialogOpen = true;
  try {
    setWideDialog(context);
    const chosen = await context.ui.dialog.select({
      title: opts.header,
      placeholder: "Select ← Back to return",
      options,
    });
    const pickedVal = typeof chosen === "string" ? chosen : chosen?.value;
    if (pickedVal === "__back__") action = "back";
    else if (typeof pickedVal === "string" && pickedVal.startsWith("__i")) action = "stay";
  } catch {
  } finally {
    dialogOpen = false;
  }

  if (action === "back") {
    await openHistoryDialog(context, opts.sessionID, opts.nav);
  } else if (action === "stay") {
    await openSummaryDialog(context, opts);
  }
}

async function openTurnDetailDialog(
  context: any,
  t: TurnDetail,
  sessionID?: string,
  nav?: HistoryNav
) {
  if (dialogOpen) return;
  const pctStr = t.totalTokens > 0 ? ((t.readTokens / t.totalTokens) * 100).toFixed(1) : "0.0";
  const modelName = t.providerID ? `${t.providerID}/${t.modelID}` : t.modelID || "unknown";
  const status = t.isColdPrefill
    ? "Cold Prefill"
    : t.isWarmPrefill
      ? "Warm Prefill"
      : t.isHit
        ? "Cache Hit"
        : t.isPartialMiss
          ? "Partial Miss"
          : "Cache Miss";

  const options = [
    { title: "← Back", value: "__back__", description: "Turn history" },
    { title: `Status   ${status}`, value: "__i1__", description: `${pctStr}% cached` },
    { title: `Provider ${t.providerID || "unknown"}`, value: "__i2__", description: "" },
    { title: `Model    ${t.modelID || "unknown"}`, value: "__i2b__", description: "" },
    { title: `Agent    ${t.agent}`, value: "__i2c__", description: "" },
    { title: `Cost     ${fmtCost(t.cost, t.costEstimated, 4)}`, value: "__i3__", description: t.costEstimated ? "estimated" : "reported" },
    { title: `Read     ${t.readTokens.toLocaleString()}`, value: "__i4__", description: "cached tokens" },
    { title: `New In   ${t.inputTokens.toLocaleString()}`, value: "__i5__", description: "uncached tokens" },
    { title: `Output   ${(t.outputTokens + t.reasoningTokens).toLocaleString()}`, value: "__i6__", description: t.reasoningTokens > 0 ? `incl. ${t.reasoningTokens.toLocaleString()} reasoning` : "" },
    ...(t.writeTokens > 0 ? [{ title: `Write    ${t.writeTokens.toLocaleString()}`, value: "__i7__", description: "cache write" }] : []),
  ];

  let action: "back" | "stay" | null = null;
  dialogOpen = true;
  try {
    setWideDialog(context);
    const chosen = await context.ui.dialog.select({
      title: `Turn ${t.turn} · ${status} · ${fmtCost(t.cost, t.costEstimated, 4)}`,
      placeholder: "Select ← Back to return",
      options,
    });
    const pickedVal = typeof chosen === "string" ? chosen : chosen?.value;
    if (pickedVal === "__back__") action = "back";
    else if (typeof pickedVal === "string" && pickedVal.startsWith("__i")) action = "stay";
  } catch {
  } finally {
    dialogOpen = false;
  }

  if (action === "back") {
    await openHistoryDialog(context, sessionID, nav);
  } else if (action === "stay") {
    await openTurnDetailDialog(context, t, sessionID, nav);
  }
}

async function openHistoryDialog(
  context: any,
  sessionID?: string,
  nav?: HistoryNav
) {
  if (dialogOpen) return;
  const sid = sessionID || currentSessionID(context);
  const turns = getSessionTurnHistory(sid);
  if (!turns || turns.length === 0) {
    if (context.ui?.toast?.show) {
      context.ui.toast.show({
        title: "Prompt Cache",
        message: "No recorded turns for this session yet.",
        variant: "info",
        duration: 2500,
      });
    }
    return;
  }

  let totalCost = 0;
  let totalCostEstimated = false;
  let missCost = 0;
  let missCostEstimated = false;
  let writeTokens = 0;
  let totalInput = 0;
  let totalRead = 0;
  let totalOutput = 0;
  let totalReasoning = 0;

  for (const t of turns) {
    totalCost += t.cost;
    if (t.costEstimated && t.cost > 0) totalCostEstimated = true;
    totalInput += t.inputTokens;
    totalRead += t.readTokens;
    totalOutput += t.outputTokens;
    totalReasoning += t.reasoningTokens;
    if (t.isColdPrefill) {
      writeTokens += t.writeTokens;
    } else if (t.isHit) {
      if (t.writeTokens > 0) writeTokens += t.writeTokens;
    } else {
      missCost += t.cost;
      if (t.costEstimated && t.cost > 0) missCostEstimated = true;
      if (t.writeTokens > 0) writeTokens += t.writeTokens;
    }
  }

  const breakdown = nav?.hideTreeLink ? null : getSessionTreeBreakdown(sid);
  const hasMultiAgentOrTasks =
    breakdown !== null && (breakdown.totals.childCount > 0 || breakdown.byAgentModel.length > 1);

  const missPct = totalCost > 0 ? ((missCost / totalCost) * 100).toFixed(1) : "0.0";
  const writeK = Math.round(writeTokens / 1000);
  const writeStr = writeTokens > 0 ? ` | W:${writeK}k` : "";
  const fullMisses = turns.filter((t) => !t.isColdPrefill && !t.isHit && !t.isPartialMiss).length;
  const partialMisses = turns.filter((t) => t.isPartialMiss).length;
  const treeNote =
    breakdown && breakdown.totals.childCount > 0
      ? ` (tree ${breakdown.totals.turns}t · ${fmtCost(breakdown.totals.cost, breakdown.totals.costEstimated, 2)})`
      : "";
  const title = nav?.title
    ? `${nav.agent ? `[${nav.agent}] ` : ""}${truncPad(nav.title, 26).trim()} · ${turns.length}t · ${fmtCost(totalCost, totalCostEstimated, 2)} | ${fullMisses}m · ${partialMisses}P`
    : `Cache ${turns.length}t · ${fmtCost(totalCost, totalCostEstimated, 2)}${treeNote}${writeStr} | ${fullMisses} miss · ${partialMisses} P | miss ${fmtCost(missCost, missCostEstimated, 2)} (${missPct}%)`;

  const validTurns = turns.filter((t) => t.turn > 1);
  const turnAvgPct =
    validTurns.length > 0
      ? validTurns.reduce((s, t) => s + (t.totalTokens > 0 ? (t.readTokens / t.totalTokens) * 100 : 100), 0) /
        validTurns.length
      : 100;
  const totalPrompt = totalInput + totalRead;
  const tokenWeightedPct = totalPrompt > 0 ? (totalRead / totalPrompt) * 100 : 100;
  const totalGen = totalOutput + totalReasoning;

  const uniqueModels = [...new Set(turns.map((t) => (t.providerID ? `${t.providerID}/${t.modelID}` : t.modelID)).filter(Boolean))];
  const modelSummary = uniqueModels.length > 0 ? uniqueModels.join(", ") : "unknown";
  const shortModel = turns[0]?.modelID || modelSummary;

  const summaryOption = {
    title: `📊 Summary (${turns.length}t · ${fmtCost(totalCost, totalCostEstimated, 3)})`,
    value: "session_summary",
    description: `${shortModel} · ${tokenWeightedPct.toFixed(0)}% cached · ${fullMisses}m`,
  };

  const childTasks = breakdown ? breakdown.byTask.filter((t) => t.depth > 0) : [];
  const childCost = childTasks.reduce((s, t) => s + t.cost, 0);
  const childEst = childTasks.some((t) => t.costEstimated && t.cost > 0);

  const options = [
    ...(nav?.onBack
      ? [
          {
            title: nav.backLabel || "← Back",
            value: "__back__",
            description: "Previous view",
          },
        ]
      : []),
    summaryOption,
    ...(hasMultiAgentOrTasks && breakdown
      ? [
          {
            title: `• Agents & Models (${breakdown.byAgentModel.length})`,
            value: "agent_breakdown",
            description: `${fmtCost(breakdown.totals.cost, breakdown.totals.costEstimated, 2)} · ${breakdown.totals.turns}t`,
          },
          ...(childTasks.length > 0
            ? [
                {
                  title: `• Subagent Tasks (${childTasks.length})`,
                  value: "task_list",
                  description: `${fmtCost(childCost, childEst, 2)} · ${childTasks.reduce((s, t) => s + t.turns, 0)}t`,
                },
              ]
            : []),
        ]
      : []),
    ...[...turns].reverse().map((t) => ({
      title: t.label,
      value: String(t.turn),
      description: t.description,
    })),
  ];

  let nextAction: "back" | "breakdown" | "tasks" | "summary" | "turn" | null = null;
  let pickedTurn: TurnDetail | null = null;
  dialogOpen = true;
  try {
    setWideDialog(context);
    const chosen = await context.ui.dialog.select({
      title,
      placeholder: "Filter (Summary, Agents, Tasks, Miss, P Miss, Hit, T10)",
      options,
    });
    const pickedVal = typeof chosen === "string" ? chosen : chosen?.value;
    if (pickedVal === "__back__" && nav?.onBack) {
      nextAction = "back";
    } else if (pickedVal === "agent_breakdown" && breakdown) {
      nextAction = "breakdown";
    } else if (pickedVal === "task_list" && breakdown) {
      nextAction = "tasks";
    } else if (pickedVal === "session_summary") {
      nextAction = "summary";
    } else if (pickedVal) {
      const t = turns.find((item) => String(item.turn) === String(pickedVal));
      if (t) {
        nextAction = "turn";
        pickedTurn = t;
      }
    }
  } catch {
  } finally {
    dialogOpen = false;
  }

  if (nextAction === "back" && nav?.onBack) {
    await nav.onBack();
  } else if (nextAction === "breakdown" && breakdown) {
    await openAgentBreakdownDialog(context, breakdown, sid);
  } else if (nextAction === "tasks" && breakdown) {
    await openTaskListDialog(context, breakdown, sid);
  } else if (nextAction === "summary") {
    const treeLine =
      breakdown && breakdown.totals.childCount > 0
        ? `${breakdown.totals.childCount} subagents · ${fmtCost(breakdown.totals.cost, breakdown.totals.costEstimated, 4)} (${breakdown.totals.turns}t)`
        : "";
    const uniqueProviders = [...new Set(turns.map((t) => t.providerID).filter(Boolean))];
    const uniqueModelIds = [...new Set(turns.map((t) => t.modelID).filter(Boolean))];
    const uniqueAgents = [...new Set(turns.map((t) => t.agent).filter(Boolean))];
    await openSummaryDialog(context, {
      sessionID: sid,
      nav,
      header: `Summary · ${nav?.title ? truncPad(nav.title, 28).trim() : `${turns.length}t`}`,
      providerSummary: uniqueProviders.length > 0 ? uniqueProviders.join(", ") : "unknown",
      modelSummary: uniqueModelIds.length > 0 ? uniqueModelIds.join(", ") : "unknown",
      agentSummary: uniqueAgents.length > 0 ? uniqueAgents.join(", ") : nav?.agent || "default",
      turnsCount: turns.length,
      totalCost,
      totalCostEstimated,
      missCost,
      missCostEstimated,
      turnAvgPct,
      tokenWeightedPct,
      totalRead,
      totalInput,
      totalGen,
      totalReasoning,
      writeTokens,
      fullMisses,
      partialMisses,
      treeLine,
    });
  } else if (nextAction === "turn" && pickedTurn) {
    await openTurnDetailDialog(context, pickedTurn, sid, nav);
  }
}

export default Plugin.define({
  id: "oc-mistral-affinity.tui",
  setup(context: any) {
    void refreshPricingCache();
    const [tick, setTick] = createSignal(0);
    const timer = setInterval(() => {
      setTick((n) => n + 1);
    }, 2000);
    let stopSucceeded: (() => void) | undefined;
    try {
      stopSucceeded = context.data?.on?.("session.execution.succeeded", () => {
        setTick((n) => n + 1);
      });
    } catch {}

    // Register /cache and /cache_c slash commands
    try {
      context.keymap?.layer?.(() => ({
        mode: "global",
        commands: [
          {
            id: "oc-mistral-affinity.cache-history",
            title: "Show prompt cache history or set P Miss %",
            description: "Run /cache to view history, or /cache <pct> to set P Miss threshold",
            slash: { name: "cache", arguments: true },
            run: (input?: string) => {
              const trimmed = (input ?? "").trim();
              if (!trimmed) {
                void openHistoryDialog(context, currentSessionID(context));
                return;
              }
              const pct = parsePctInput(trimmed);
              if (pct === null) {
                context.ui?.toast?.show?.({
                  title: "Prompt Cache",
                  message: "Usage: /cache <0-100> (e.g. /cache 10)",
                  variant: "warning",
                  duration: 2500,
                });
                return;
              }
              const { missPct } = loadThresholds();
              saveThresholds(pct, missPct);
              setTick((n) => n + 1);
              context.ui?.toast?.show?.({
                title: "Prompt Cache",
                message: `Thresholds: P Miss > ${pct}% | Miss > ${missPct}%`,
                variant: "info",
                duration: 2500,
              });
            },
          },
          {
            id: "oc-mistral-affinity.cache-complete-miss",
            title: "Set complete cache Miss % threshold",
            description: "Run /cache_c <pct> to set complete Miss threshold (default 50%)",
            slash: { name: "cache_c", arguments: true },
            run: (input?: string) => {
              const trimmed = (input ?? "").trim();
              const current = loadThresholds();
              if (!trimmed) {
                context.ui?.toast?.show?.({
                  title: "Prompt Cache",
                  message: `Thresholds: P Miss > ${current.pMissPct}% | Miss > ${current.missPct}%`,
                  variant: "info",
                  duration: 2500,
                });
                return;
              }
              const pct = parsePctInput(trimmed);
              if (pct === null) {
                context.ui?.toast?.show?.({
                  title: "Prompt Cache",
                  message: "Usage: /cache_c <0-100> (e.g. /cache_c 50)",
                  variant: "warning",
                  duration: 2500,
                });
                return;
              }
              saveThresholds(current.pMissPct, pct);
              setTick((n) => n + 1);
              context.ui?.toast?.show?.({
                title: "Prompt Cache",
                message: `Thresholds: P Miss > ${current.pMissPct}% | Miss > ${pct}%`,
                variant: "info",
                duration: 2500,
              });
            },
          },
        ],
      }));
    } catch {}

    const Badge = (props: { sessionID?: string }) => {
      tick();
      const sid = currentSessionID(context) || props.sessionID;
      if (!sid) return null;

      // Query current session live turns for accurate stats
      const turns = getSessionTurnHistory(sid);
      if (turns.length === 0) return null;

      let fullMiss = 0;
      let partialMiss = 0;
      let totalRead = 0;
      let totalAll = 0;

      for (const t of turns) {
        if (t.isPartialMiss) partialMiss++;
        else if (!t.isColdPrefill && !t.isHit) fullMiss++;
        totalRead += t.readTokens;
        totalAll += t.totalTokens;
      }

      const rate = totalAll > 0 ? ((totalRead / totalAll) * 100).toFixed(0) : "100";
      const missCount = fullMiss + partialMiss;
      const isOk = missCount === 0;

      return (
        <box
          flexDirection="row"
          flexShrink={0}
          onMouseUp={(e: any) => {
            e?.stopPropagation?.();
            void openHistoryDialog(context, sid);
          }}
        >
          <text fg={isOk ? "#3fb950" : "#d29922"} wrapMode="none">
            ⚡ {rate}% cache
          </text>
          <text fg={isOk ? "#3fb950" : "#f85149"} wrapMode="none">
            {" "}
            ({fullMiss} miss · {partialMiss} P / {turns.length})
          </text>
        </box>
      );
    };

    try {
      context.ui.slot({
        append: "prompt.footer.status",
        render: (slot?: { sessionID?: string }) => <Badge sessionID={slot?.sessionID} />,
      });
    } catch {}

    return () => {
      clearInterval(timer);
      stopSucceeded?.();
    };
  },
});
