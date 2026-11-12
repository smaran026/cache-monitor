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

function loadThresholds(): { pMissPct: number; missPct: number } {
  try {
    const raw = readFileSync(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const pMissPct =
      typeof parsed?.pMissPct === "number" && Number.isFinite(parsed.pMissPct) && parsed.pMissPct >= 0 && parsed.pMissPct <= 100
        ? parsed.pMissPct
        : DEFAULT_P_MISS_PCT;
    const missPct =
      typeof parsed?.missPct === "number" && Number.isFinite(parsed.missPct) && parsed.missPct >= 0 && parsed.missPct <= 100
        ? parsed.missPct
        : DEFAULT_MISS_PCT;
    return { pMissPct, missPct };
  } catch {
    return { pMissPct: DEFAULT_P_MISS_PCT, missPct: DEFAULT_MISS_PCT };
  }
}

function saveThresholds(pMissPct: number, missPct: number) {
  try {
    mkdirSync(dirname(CONFIG_FILE), { recursive: true });
    writeFileSync(CONFIG_FILE, JSON.stringify({ pMissPct, missPct }, null, 2));
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
  isColdPrefill: boolean;
  isWarmPrefill: boolean;
  readK: number;
  readTokens: number;
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

function getSessionTurnHistory(sessionID?: string): TurnDetail[] {
  if (!sessionID) return [];
  const { pMissPct, missPct } = loadThresholds();
  const strictHitFloor = Math.max(0, Math.min(1, (100 - pMissPct) / 100));
  const completeHitFloor = Math.max(0, Math.min(1, (100 - missPct) / 100));
  try {
    const db = new Database(DB_FILE, { readonly: true });
    const rows = db.query(`
      SELECT data
      FROM session_message
      WHERE session_id = ?
      ORDER BY time_created ASC
    `).all(sessionID) as any[];

    db.close();

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

          if (isColdPrefill) {
            turnWriteTokens = explicitWrite > 0 ? explicitWrite : input;
            label = `T1 Cold (${fmtK(total)}->${fmtK(turnWriteTokens)}W) ${shortCost}`;
            description = `warmup`;
            detail = `Cold prefill: ${total.toLocaleString()} tokens sent, ${turnWriteTokens.toLocaleString()} written to cache (${costStr})`;
          } else if (isWarmPrefill) {
            turnWriteTokens = explicitWrite > 0 ? explicitWrite : input;
            label = `T1 Warm (${fmtK(read)}+${fmtK(input)}) ${shortCost}`;
            description = `${pctStr}% cached`;
            detail = `Warm prefill hit: ${read.toLocaleString()} cached + ${input.toLocaleString()} new tokens sent (${pctStr}% cached · ${costStr})`;
          } else if (isHit) {
            turnWriteTokens = explicitWrite;
            label = `T${turn} Hit (${fmtK(read)}) ${shortCost}`;
            description = `${pctStr}% (${fmtK(read)}/${fmtK(total)})`;
            detail = `${pctStr}% cached (${read.toLocaleString()} / ${total.toLocaleString()} tokens · ${costStr})`;
          } else if (isPartialMiss) {
            turnWriteTokens = explicitWrite;
            label = `T${turn} P Miss (${fmtK(read)}) ${shortCost}`;
            description = `${pctStr}% (${fmtK(read)}/${fmtK(total)})`;
            detail = `Partial Miss (P Miss): ${pctStr}% cached (${read.toLocaleString()} / ${total.toLocaleString()} tokens · ${costStr})`;
          } else {
            turnWriteTokens = explicitWrite;
            label = `T${turn} Miss (${fmtK(read)}) ${shortCost}`;
            description = `${pctStr}% (${fmtK(read)}/${fmtK(total)})`;
            detail = `Cache Miss: ${pctStr}% cached (${read.toLocaleString()} / ${total.toLocaleString()} tokens · ${costStr}, miss penalty ~$${(cost * 0.9).toFixed(4)})`;
          }

          turns.push({
            turn,
            isHit,
            isColdPrefill,
            isWarmPrefill,
            readK,
            readTokens: read,
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
    return turns;
  } catch {
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

  for (const t of turns) {
    totalCost += t.cost;
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
  const title = `Cache ${turns.length}t · $${totalCost.toFixed(2)}${writeStr} | Miss:$${missCost.toFixed(2)} (${missPct}%)`;

  const options = [...turns].reverse().map((t) => ({
    title: t.label,
    value: String(t.turn),
    description: t.description,
  }));

  dialogOpen = true;
  try {
    setTimeout(() => {
      try {
        context.ui?.dialog?.setSize?.("large");
      } catch {}
    }, 0);
    const chosen = await context.ui.dialog.select({
      title,
      placeholder: "Filter (Miss, P Miss, Hit, Cold, T10)",
      options,
    });
    const pickedVal = typeof chosen === "string" ? chosen : chosen?.value;
    if (pickedVal && context.ui?.toast?.show) {
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

      let missCount = 0;
      let totalRead = 0;
      let totalAll = 0;

      for (const t of turns) {
        if (!t.isColdPrefill && !t.isHit) {
          missCount++;
        }
        totalRead += t.readTokens;
        totalAll += t.totalTokens;
      }

      const rate = totalAll > 0 ? ((totalRead / totalAll) * 100).toFixed(0) : "100";
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
            ({missCount}/{turns.length} miss)
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
