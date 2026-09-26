# Token efficiency: baseline, changes, proposals

Measured 2026-09-25 on SDK 0.3.281 / Claude Code 2.1.281. Re-run the numbers with
`node diag/token-cost.mjs [--since YYYY-MM-DD]`; render a request with
`diag/capture-proxy.mjs` (set `ENABLE_TOOL_SEARCH=true` too — Claude Code turns tool
search off behind a non-Anthropic `ANTHROPIC_BASE_URL`, so a capture otherwise
differs from production by one `DeferredToolPlaceholder` tool).

Cost is in base-input-price units (output 5, cache read 0.1, cache write 1.25 at 5m /
2 at 1h). The provider runs on a subscription, so real spend is quota, and how the
quota weights each billing type is not published.

## Where a provider request comes from

Pi's agent loop → `streamClaudeAgentSdk` → one Claude Code `query()` per user turn
(`--resume` of a JSONL the bridge keeps in sync with Pi history) → Anthropic API.
Pi's tools are served to Claude Code over the in-process MCP server; each tool call
ends the Pi stream and the next `streamSimple` delivers the result.

Claude Code lays the request out as tools → system (billing header, identity,
preset + the bridge's `append`) with a 1h breakpoint → first user message (Claude
Code memory reminder, user-email reminder, prompt) → mid-conversation system
message (environment, date) with its own breakpoint → conversation. Volatile
values already sit after the boundary; nothing the bridge adds is volatile.

## Baseline (7 sessions, 422 requests, 32 tasks, Opus 5 / 5.5)

| billing type | tokens | cost share |
|---|---|---|
| cache read | 69.6M | 57.6% |
| cache write (1h) | 1.61M | 26.6% |
| output | 0.38M | 15.9% |
| uncached input | 844 | 0.0% |

- Cache hit rate 97.7%. Requests per task: median 3, p90 42, mean 13.2.
- Static prefix at session start: ~9.3k tokens median (10.6k in this repo with every
  extension loaded): pi tool schemas 39%, Pi-projected AGENTS.md files 22%,
  Claude Code's second copy of AGENTS.md 14%, Claude Code preset 12%, skills 8%.
- What later requests re-read: bash results 32%, assistant output 30%, read
  results 23%, the starting prefix 13%. Median read result is 14.8k chars.
- 56% of cost comes from requests whose prompt is over 200k tokens.
- Cold requests: one 402k-token re-write after a 139-minute idle gap, and two
  query-boundary breaks on 2026-08-15 (older bridge; none since).
- Tools: bash in 75% of tasks (3.6% errors), read/edit/write ~22%, everything
  else under 10%.

## Changes made

| change | measured effect |
|---|---|
| `**/AGENTS.md` added to the provider's `claudeMdExcludes` | removes a duplicate of the project AGENTS.md wrapped in "OVERRIDE … MUST follow" |
| SpawnClaudeAgent left out of the provider's tool list (it refuses under this provider) | together with the above, −2,063 prompt tokens per request (8,033 → 5,970, same cwd and tools) |
| `usage.cacheWrite1h` recorded per request | 1h writes can be priced at 2x instead of assumed |
| `diag/token-cost.mjs` | per-task cost by billing type, tool call share and errors, cold requests, TTL replay |
| `provider.promptCacheTtl` (flag; unset = unchanged) | TTL replay: 5m is 7.2% cheaper than 1h on the recorded gaps |

The first two cut about 1% of total cost on the baseline mix (2.1k × 0.1 on every
request plus the 2x first write per segment). That is small because the history, not
the prefix, is what gets re-read.

## Null result: deferring tool schemas

`ENABLE_TOOL_SEARCH=auto:0` and `=true` with a tool lacking `_meta["anthropic/alwaysLoad"]`
still load in-process SDK MCP tools eagerly on Opus 5.5 (Haiku has no tool search at
all). Only Claude Code's own placeholder is deferred. Offloading would need a
bridge-side loader tool that changes the tool list mid-query, which rewrites the
cached prefix, and the upside is bounded: every non-core tool together is ~2.9k
tokens, worth at most ~1% of cost, while a search round trip at a typical 150k
context costs ~15k.

## Proposals, ranked

1. **Default `promptCacheTtl` to `"5m"`** — est. −7% (TTL replay over recorded gaps;
   411 of 414 gaps were ≤5 min). Risk: users who routinely pause 5–60 min pay a
   full re-write each time; subscription quota weighting of 1h writes is unknown.
   Validate with the test plan below. Roll back: unset the key.
2. **Compact earlier on 1M-context models** — requests over 200k tokens are 56% of
   cost. Pi owns the threshold (it compacts near the registered 1M window). Risk:
   compaction loses detail the model needed; measure task success before changing.
   Propose to Pi / as a per-provider compaction threshold, not a bridge change.
3. **Compact before re-sending after cache expiry** — the 139-minute return
   re-wrote 402k tokens (~6.7% of all baseline cost) and was compacted right after.
   Summarizing first would skip one full write. Pi-side; needs the idle gap and TTL.
4. **Smaller inline cap for bash output** — Pi inlines up to 50KB; one minified
   bundle (38k chars) was re-read 142 times (~2% of cost). Pi already writes the
   full output to a temp file when truncating, so a lower cap keeps the data
   reachable. Pi-side.
5. **Model/effort routing** — output is 16% of cost; delegation defaults already
   pick model and effort explicitly. No data on which turns would tolerate a
   cheaper model; not pursued.

## Test plan for the flag (`promptCacheTtl: "5m"`)

- Offline: the same 5 recorded-style tasks (short user phrasing, this repo and one
  other) with the key unset and with `"5m"`, three runs each; compare
  `diag/token-cost.mjs` cost/task, requests/task, cache hit rate, cold requests.
  TTL cannot change task success, so the guardrail is cold-request count.
- Online: two weeks with `"5m"` in the global config; compare against the two weeks
  before with `--since`. Ship as default only if cost/task drops and cold requests
  after 5–60 min gaps stay under ~2% of requests. Record a null result either way.
