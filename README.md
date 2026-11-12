# cache-monitor

Per-turn prompt cache hit rate tracking and affinity routing for coding agent sessions.

Works with **Pi coding agent** and **OpenCode Go**. The core logic is provider-agnostic and can be adapted to any client that exposes pre-request and post-response hooks.

---

## What it does

- Tracks cache hit rate and cost per turn for every assistant response
- Shows a live footer badge: `⚡ 99% cache (1/400 miss)`
- Alerts on cache misses in real time with exact token counts and cost
- Sets `x-affinity` and strips conflicting `prompt_cache_key` headers on outgoing requests (Mistral) so the backend routes consistently to the same KV replica
- Classifies turns as: **Cold Prefill** (turn 1 warmup), **Warm Prefill** (turn 1 cache reuse), **Hit**, **P Miss** (partial miss, configurable threshold), or **Miss**
- Tracks tokens-per-second (`ts`) and time-to-first-stream (`ttfs`) per turn
- Commands: `/cache` (interactive history), `/cache <pct>` (set P Miss threshold), `/cache_c <pct>` (set Miss threshold)
- Keyboard shortcut: `Ctrl+Alt+C` (Pi only) to open the cache history modal

---

## Why

Mistral's flash models (`deepseek-v4-1-flash`, `zai-glm-5-3-flash`) bounce between backend replicas when multiple sessions run concurrently. This causes cache hit rates to drop from 99% to 0% repeatedly within the same session. On a bad session, 80%+ of the bill can come from cache misses alone.

This plugin makes it visible and routes requests to reduce bouncing.

---

## Install

### One-line (recommended)

```bash
git clone https://github.com/smaran026/cache-monitor
cd cache-monitor
bash scripts/install.sh
```

The script prompts you to choose Pi, OpenCode, or both. It backs up any existing files before overwriting.

### Manual

#### Pi coding agent

Copy `pi/cache-monitor.ts` into your Pi extensions directory:

```bash
cp pi/cache-monitor.ts ~/.pi/agent/extensions/cache-monitor.ts
```

Then restart Pi or run `/reload`.

Verify the build:

```bash
bun build ~/.pi/agent/extensions/cache-monitor.ts --no-bundle --outfile /tmp/cm-check.js && rm /tmp/cm-check.js && echo OK
```

#### OpenCode Go

Copy the three files into a local plugin directory:

```bash
mkdir -p ~/.config/opencode/local-plugins/oc-mistral-affinity
cp opencode/index.ts   ~/.config/opencode/local-plugins/oc-mistral-affinity/
cp opencode/tui.tsx    ~/.config/opencode/local-plugins/oc-mistral-affinity/
cp opencode/package.json ~/.config/opencode/local-plugins/oc-mistral-affinity/
```

Register the plugin in your OpenCode config (`~/.config/opencode/config.json`):

```json
{
  "plugins": [
    "~/.config/opencode/local-plugins/oc-mistral-affinity"
  ]
}
```

Then restart OpenCode.

---

## Usage

### Pi

| Command | Action |
|---|---|
| `/cache` | Open interactive turn-by-turn cache history modal |
| `/cache 15` | Set P Miss threshold to 15% (turns with <85% cache rate count as P Miss) |
| `/cache_c 60` | Set Miss threshold to 60% (turns with <40% cache rate count as full Miss) |
| `/cache-widget` | Toggle persistent widget below the editor |
| `Ctrl+Alt+C` | Open cache history modal |

The footer status bar shows: `⚡ 99.5% cache (1 miss · $0.0062 lost) | Turn 42: Hit (312k cached) - $0.0021`

### OpenCode

| Command | Action |
|---|---|
| `/cache` | Open filterable dialog with turn-by-turn history |
| `/cache 15` | Set P Miss threshold |
| `/cache_c 60` | Set Miss threshold |

The footer badge shows: `⚡ 99% cache (1/400 miss)` — click it to open the history dialog.

---

## Thresholds

| Classification | Default condition |
|---|---|
| **Hit** | >= 90% of prompt tokens were cached |
| **P Miss** (Partial Miss) | Between 50% and 90% cached |
| **Miss** | < 50% cached |
| **Cold Prefill** | Turn 1, < 50% cached (initial warmup, excluded from miss count) |
| **Warm Prefill** | Turn 1, >= 50% cached (prior session cache reused) |

Thresholds are configurable per session and persisted to disk:
- Pi: `~/.pi/agent/cache-monitor-config.json`
- OpenCode: `~/.local/share/opencode/cache-monitor-config.json`

---

## Debug logging (Pi only)

To log outgoing and incoming Mistral headers for each request:

```bash
PI_DEBUG_MISTRAL=1 pi -p --model mistral/deepseek-v4-1-flash-1017
```

Logs are written to `~/.pi/agent/mistral-requests.log`.

---

## How the affinity routing works

**Mistral (`api.mistral.ai`):**
- Adds `x-affinity: <sessionId>` to every request header
- Strips `prompt_cache_key` / `prompt-cache-key` from headers and JSON body (sending both causes the backend to treat them as conflicting routing signals and bounce to a different replica)

**OpenCode Go:**
- Adds `x-affinity: <sessionId>`, `x-session-affinity`, and `session-id` headers
- Injects `prompt_cache_key: <sessionId>` into the request body

The backend still bounces under heavy concurrent load — this reduces the frequency but cannot eliminate it entirely. Running one active session at a time gives the best cache hit rate.

---

## Files

```
pi/
  cache-monitor.ts        Pi extension (single file, TypeScript)

opencode/
  index.ts                Affinity routing hook (model.request + http.request)
  tui.tsx                 TUI badge + history dialog + slash commands (SolidJS)
  package.json            Plugin manifest

scripts/
  install.sh              Installer script
```

---

## Requirements

- **Pi**: Pi coding agent with Bun runtime
- **OpenCode**: OpenCode Go with local plugin support and Bun runtime (for `bun:sqlite`)

---

## Portability

The core classification logic (Cold Prefill / Warm Prefill / Hit / P Miss / Miss, ts/ttfs telemetry) is self-contained TypeScript with no external dependencies beyond Node.js built-ins. Adapting it to another client requires implementing:
1. A pre-request hook to inject headers
2. A post-response hook to read token usage (`input`, `cacheRead`, `cacheWrite`, `output`, `cost`)
3. A UI hook to display the status badge

---

## License

MIT
