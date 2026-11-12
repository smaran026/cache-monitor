# cache-monitor

Per-turn prompt cache hit rate tracking, plus optional affinity routing headers, for coding agent sessions.

Works with **Pi coding agent** and **OpenCode Go**. The classification logic is provider-agnostic and can be adapted to any client that exposes pre-request and post-response hooks.

---

## What it does

- Tracks cache hit rate and cost per turn for every assistant response
- Shows a live footer badge: `⚡ 99% cache (1 miss · 2 P / 400)`
- Alerts on cache misses in real time with exact token counts and cost
- Sends affinity headers (and handles `prompt_cache_key`) per provider, driven by a configurable provider list (see below)
- Classifies turns as: **Cold Prefill** (turn 1 warmup), **Warm Prefill** (turn 1 cache reuse), **Hit**, **P Miss** (partial miss) or **Miss**
- Estimates the extra money each miss cost you (**overpaid**), separately from the total cost of the turns that missed
- Tracks tokens-per-second (`ts`) and time-to-first-stream (`ttfs`) per turn
- Commands: `/cache` (interactive history), `/cache <pct>` (set P Miss threshold), `/cache_c <pct>` (set Miss threshold)
- Keyboard shortcut: `Ctrl+Alt+C` (Pi only) to open the cache history modal

---

## Why

Some hosted models bounce between backend replicas that do not share a KV cache. Cache hit rate then drops from 99% to 0% for a turn or two, even though the client sent the same prompt prefix. This plugin makes that visible and sends the routing hints the provider may honour (`x-affinity` and friends).

Whether the hints help is provider dependent. On our Mistral sessions they did not prevent bouncing under load (see "What this can and cannot do").

---

## Install

### One-line (recommended)

```bash
git clone https://github.com/smaran026/cache-monitor
cd cache-monitor
bash scripts/install.sh
```

The script prompts you to choose Pi, OpenCode, or both. It backs up any existing files (timestamped `.bak`) before overwriting.

### Manual

#### Pi coding agent

```bash
cp pi/cache-monitor.ts ~/.pi/agent/extensions/cache-monitor.ts
```

Then restart Pi or run `/reload`. To check the file parses:

```bash
bun build ~/.pi/agent/extensions/cache-monitor.ts --no-bundle --outfile /tmp/cm-check.js && rm /tmp/cm-check.js && echo OK
```

#### OpenCode Go

```bash
mkdir -p ~/.config/opencode/local-plugins/oc-mistral-affinity
cp opencode/index.ts opencode/tui.tsx opencode/package.json ~/.config/opencode/local-plugins/oc-mistral-affinity/
```

The plugin has two halves, registered in two files:

`~/.config/opencode/opencode.json` (request hooks, `index.ts`):

```json
{ "plugin": ["./local-plugins/oc-mistral-affinity"] }
```

`~/.config/opencode/cli.json` (footer badge and `/cache`, `tui.tsx`):

```json
{ "plugins": ["./local-plugins/oc-mistral-affinity"] }
```

Restart OpenCode afterwards.

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

Footer example: `⚡ 99.5% cache (1 miss · 2 P · ~$0.0062 overpaid) | Turn 42: Hit (312k cached) - $0.0021`

### OpenCode

| Command | Action |
|---|---|
| `/cache` | Open filterable dialog with turn-by-turn history |
| `/cache 15` | Set P Miss threshold |
| `/cache_c 60` | Set Miss threshold |

The footer badge shows `⚡ 99% cache (1 miss · 2 P / 400)`. Click it to open the history dialog.

---

## Thresholds

| Classification | Default condition |
|---|---|
| **Hit** | >= 90% of prompt tokens were cached |
| **P Miss** (Partial Miss) | Between 50% and 90% cached |
| **Miss** | < 50% cached |
| **Cold Prefill** | Turn 1, < 50% cached (initial warmup, excluded from miss counts) |
| **Warm Prefill** | Turn 1, >= 50% cached (prior session cache reused) |

Miss counts are reported as full misses and P Misses separately. Both feed "cost of miss turns".

Thresholds are configurable and persisted to:
- Pi: `~/.pi/agent/cache-monitor-config.json`
- OpenCode: `~/.local/share/opencode/cache-monitor-config.json`

### Two cost figures

- **Overpaid (Pi)**: estimated extra spend. Tokens of the previous turn's prompt that were not read from cache are charged at (input price - cache-read price). It is an estimate; it assumes the previous prompt should have been cached.
- **Cost of miss turns**: the full cost of every turn classified Miss or P Miss, including output tokens and the cached part. Always larger than the overpay. OpenCode shows only this figure, because it does not expose a per-token price breakdown.

---

## Configuring providers

Which providers get affinity handling is a list of rules keyed by provider id. Built-ins: `mistral` and `opencode-go`. Add your own, override a built-in, or disable one (`null`) in the same config file as the thresholds, under `"providers"`:

```json
{
  "providers": {
    "my-gateway": {
      "urls": ["gw.example.com"],
      "headers": ["x-affinity"],
      "bodyCacheKey": "inject"
    },
    "opencode-go": null
  }
}
```

| Field | Meaning |
|---|---|
| key | Provider id as reported by the harness (`model.provider` in Pi, `providerID` in OpenCode) |
| `ids` | Extra provider ids that use the same rule |
| `urls` | Substrings matched against the base URL when the id does not match |
| `apis` | (Pi) `model.api` values that match |
| `headers` | Header names set to the session id |
| `bodyCacheKey` | `strip` removes `prompt_cache_key` from headers and body, `inject` sets it to the session id, `keep` (default) leaves it alone |

Built-in rules:

| Rule | Headers | `prompt_cache_key` |
|---|---|---|
| `mistral` | `x-affinity` | strip |
| `opencode-go` | `x-affinity`, `x-session-affinity`, `session-id` | inject |

Providers without a rule are never touched. Changes are read on every request, no restart needed.

---

## Debugging

Nothing is logged by default.

| Variable | Harness | Writes |
|---|---|---|
| `PI_DEBUG_AFFINITY=1` (or legacy `PI_DEBUG_MISTRAL=1`) | Pi | Outgoing and response headers of matched providers to `~/.pi/agent/mistral-requests.log` |
| `PI_DEBUG_PREFIX=1` | Pi | Hashes of the request body prefix to `~/.pi/agent/cache-prefix.log` |
| `OC_AFFINITY_DEBUG=1` | OpenCode | Routing lines to `~/.local/share/opencode/mistral-affinity.log` |
| `OC_AFFINITY_PREFIX=1` | OpenCode | Hashes of the request body prefix to `~/.local/share/opencode/cache-prefix.log` |

Credential headers (`authorization`, `x-api-key`, `api-key`, `cookie`, `set-cookie`) are redacted. Logs rotate at 512 KB (`.log.1`).

### Telling "our prompt changed" apart from "the provider bounced"

With the prefix log on, each request records the SHA-1 prefix of its body at 4 KB, 32 KB and 128 KB. If a miss turn has the same `first_32k` hash as the turn before it, the prompt prefix did not change and the miss happened on the provider side. If the hash differs, something in the client (compaction, a reordered tool list, a timestamp in the system prompt) changed the prefix.

---

## What this can and cannot do

Affinity headers are a hint. If the provider ignores them, or its replicas do not share a KV cache, you will still see turn-to-turn bounces: a 0% turn followed by a 96% turn on the same conversation. The plugin cannot fix that. It can show you how bad it is and let you compare providers (for example Mistral against OpenCode Go in the same hour) so you can route work to the one that holds its cache.

Do not read the hit-rate numbers across providers as a controlled benchmark: sessions differ in length, task and context size, and providers price cached tokens differently.

---

## Files

```
pi/
  cache-monitor.ts        Pi extension (single file, TypeScript)

opencode/
  index.ts                Affinity routing hooks (model.request + http.request)
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

The classification logic (Cold Prefill / Warm Prefill / Hit / P Miss / Miss, ts/ttfs telemetry) is self-contained TypeScript with no dependencies beyond Node.js built-ins. Adapting it to another client requires implementing:
1. A pre-request hook to inject headers
2. A post-response hook to read token usage (`input`, `cacheRead`, `cacheWrite`, `output`, `cost`)
3. A UI hook to display the status badge

---

## License

MIT, see [LICENSE](LICENSE).
