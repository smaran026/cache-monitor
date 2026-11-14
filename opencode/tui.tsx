import { Plugin } from "@opencode/plugin/tui";
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createSignal } from "solid-js";

const DB_FILE = join(homedir(), ".local/share/opencode/opencode.db");
const CONFIG_FILE = join(homedir(), ".local/share/opencode/cache-monitor-config.json");
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
      SELECT data
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
          const cost = typeof d.cost === "number" ? d.cost : 0;
          const total = input + read;
          const isCompleteHit = total > 0 && read >= total * completeHitFloor;
          const isStrictHit = total > 0 && read >= total * strictHitFloor;
          const isColdPrefill = turn === 1 && !isCompleteHit;
          const isWarmPrefill = turn === 1 && isCompleteHit;
          const isHit = turn === 1 ? isWarmPrefill : isCompleteHit && isStrictHit;
          const isPartialMiss = turn > 1 && isCompleteHit && !isStrictHit;
          const readK = Math.round(read / 1000);
          const costStr = `$${cost.toFixed(4)}`;
          const shortCost = cost > 0 && cost < 0.01 ? `$${cost.toFixed(3)}` : `$${cost.toFixed(2)}`;
          const pctStr = total > 0 ? ((read / total) * 100).toFixed(1) : "0.0";

          let turnWriteTokens = 0;
          let label = "";
          let description = "";
          let detail = "";

          const outputStr = output + reasoning > 0 ? ` · ${(output + reasoning).toLocaleString()} out` : "";

          if (isColdPrefill) {
            turnWriteTokens = explicitWrite > 0 ? explicitWrite : input;
            label = `T1 Cold (${fmtK(total)}->${fmtK(turnWriteTokens)}W) ${shortCost}`;
            description = `warmup`;
            detail = `Cold prefill: ${total.toLocaleString()} tokens sent, ${turnWriteTokens.toLocaleString()} written to cache (${costStr}${outputStr})`;
          } else if (isWarmPrefill) {
            turnWriteTokens = explicitWrite > 0 ? explicitWrite : input;
            label = `T1 Warm (${fmtK(read)}+${fmtK(input)}) ${shortCost}`;
            description = `${pctStr}% cached`;
            detail = `Warm prefill hit: ${read.toLocaleString()} cached + ${input.toLocaleString()} new tokens sent (${pctStr}% cached · ${costStr}${outputStr})`;
          } else if (isHit) {
            turnWriteTokens = explicitWrite;
            label = `T${turn} Hit (${fmtK(read)}) ${shortCost}`;
            description = `${pctStr}% (${fmtK(read)}/${fmtK(total)})`;
            detail = `${pctStr}% cached (${read.toLocaleString()} / ${total.toLocaleString()} tokens · ${costStr}${outputStr})`;
          } else if (isPartialMiss) {
            turnWriteTokens = explicitWrite;
            label = `T${turn} P Miss (${fmtK(read)}) ${shortCost}`;
            description = `${pctStr}% (${fmtK(read)}/${fmtK(total)})`;
            detail = `Partial Miss (P Miss): ${pctStr}% cached (${read.toLocaleString()} / ${total.toLocaleString()} tokens · ${costStr}${outputStr})`;
          } else {
            turnWriteTokens = explicitWrite;
            label = `T${turn} Miss (${fmtK(read)}) ${shortCost}`;
            description = `${pctStr}% (${fmtK(read)}/${fmtK(total)})`;
            detail = `Cache Miss: ${pctStr}% cached (${read.toLocaleString()} / ${total.toLocaleString()} tokens · turn cost ${costStr}${outputStr})`;
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

let dialogOpen = false;

async function openHistoryDialog(context: any, sessionID?: string) {
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
  let missCost = 0;
  let writeTokens = 0;
  let totalInput = 0;
  let totalRead = 0;
  let totalOutput = 0;
  let totalReasoning = 0;

  for (const t of turns) {
    totalCost += t.cost;
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
      if (t.writeTokens > 0) writeTokens += t.writeTokens;
    }
  }

  const missPct = totalCost > 0 ? ((missCost / totalCost) * 100).toFixed(1) : "0.0";
  const writeK = Math.round(writeTokens / 1000);
  const writeStr = writeTokens > 0 ? ` | W:${writeK}k` : "";
  const fullMisses = turns.filter((t) => !t.isColdPrefill && !t.isHit && !t.isPartialMiss).length;
  const partialMisses = turns.filter((t) => t.isPartialMiss).length;
  const title = `Cache ${turns.length}t · $${totalCost.toFixed(2)}${writeStr} | ${fullMisses} miss · ${partialMisses} P | miss turns $${missCost.toFixed(2)} (${missPct}%)`;

  const validTurns = turns.filter((t) => t.turn > 1);
  const turnAvgPct =
    validTurns.length > 0
      ? validTurns.reduce((s, t) => s + (t.totalTokens > 0 ? (t.readTokens / t.totalTokens) * 100 : 100), 0) /
        validTurns.length
      : 100;
  const totalPrompt = totalInput + totalRead;
  const tokenWeightedPct = totalPrompt > 0 ? (totalRead / totalPrompt) * 100 : 100;
  const totalGen = totalOutput + totalReasoning;

  const summaryOption = {
    title: `📊 Session Cost & Token Breakdown (${turns.length} turns · $${totalCost.toFixed(3)})`,
    value: "session_summary",
    description: `Out/Reasoning: ${fmtK(totalGen)} | Read: ${fmtK(totalRead)} | New: ${fmtK(totalInput)}`,
  };

  const options = [
    summaryOption,
    ...[...turns].reverse().map((t) => ({
      title: t.label,
      value: String(t.turn),
      description: t.description,
    })),
  ];

  dialogOpen = true;
  try {
    setTimeout(() => {
      try {
        context.ui?.dialog?.setSize?.("large");
      } catch {}
    }, 0);
    const chosen = await context.ui.dialog.select({
      title,
      placeholder: "Filter (Summary, Miss, P Miss, Hit, Cold, T10)",
      options,
    });
    const pickedVal = typeof chosen === "string" ? chosen : chosen?.value;
    if (pickedVal && context.ui?.toast?.show) {
      if (pickedVal === "session_summary") {
        const reasoningPart = totalReasoning > 0 ? ` (incl. ${totalReasoning.toLocaleString()} reasoning)` : "";
        context.ui.toast.show({
          title: "Session Breakdown",
          message: [
            `Total Spend: $${totalCost.toFixed(4)} across ${turns.length} turns`,
            `Cache Rate: ${turnAvgPct.toFixed(1)}% (turn avg) · ${tokenWeightedPct.toFixed(1)}% (token weighted)`,
            `Output: ${totalGen.toLocaleString()} tokens${reasoningPart}`,
            `Cache Read: ${totalRead.toLocaleString()} tokens`,
            `Uncached Input: ${totalInput.toLocaleString()} tokens`,
            writeTokens > 0 ? `Cache Write: ${writeTokens.toLocaleString()} tokens` : "",
            `Misses: ${fullMisses} C Miss · ${partialMisses} P Miss`,
          ].filter(Boolean).join("\n"),
          variant: "info",
          duration: 7000,
        });
        return;
      }
      const t = turns.find((item) => String(item.turn) === String(pickedVal));
      if (t) {
        context.ui.toast.show({
          title: `Turn ${t.turn}`,
          message: t.detail,
          variant: !t.isHit && !t.isColdPrefill ? "warning" : "info",
          duration: 4500,
        });
      }
    }
  } catch {
  } finally {
    dialogOpen = false;
  }
}

export default Plugin.define({
  id: "oc-mistral-affinity.tui",
  setup(context: any) {
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
