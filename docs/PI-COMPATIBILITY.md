# Pi compatibility baseline

The fork requires Pi 1.1.0 or newer and develops against exact 1.1.0 versions
of `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and
`@earendil-works/pi-tui`. Node.js 22.19 or newer is required.

Upgrade older Pi installations before using this release. 1.1.0 is the oldest
release this fork is tested on; nothing older is supported. The Pi packages are
declared as `"*"` peers, as Pi's package guidance asks for host-provided
modules, so npm does not enforce this floor: Pi installs extensions without
resolving their Pi peers.

The offline unit suite launches the repository-local Pi CLI in an isolated
temporary agent directory, loads a copy of the extension outside the checkout
with only its runtime dependencies (no Pi devDependencies), and verifies that the
`claude-delegation` models are registered. Test output also records the installed Pi
packages, Agent SDK, and the Claude Code version bundled by that SDK.

Import transcript helpers from `@earendil-works/pi-ai`: Pi supplies that package
root to extensions, but not the `utils/transcript` or `utils/text` subpaths.
Read the built-in model catalog with `getBuiltinModels` from
`@earendil-works/pi-ai/providers/all`, which Pi also supplies; the
`@earendil-works/pi-ai/compat` catalog reads are deprecated, and Pi plans to
delete that entry point.

## Transcript and summary adaptation

Pi 0.86+ carries prompt sections and tool changes in transcript system messages,
not `context.systemPrompt` / `context.tools`. `src/transcript.ts` replays this state
with Pi's public helpers before provider or isolated-summary execution. Section
order stays aligned with Pi's prompt builder, including removal and re-addition,
so exact prompt-capture lookup still works. Extension sections are the
exception: Pi appends them in the order this prompt's `before_agent_start`
handlers added them, which replay cannot recover, so both the capture and the
lookup also key the prompt with those sections sorted by name. Lookup also tries
replay's first-appearance order, which matches Pi when an extension overrides a
section Pi does not render by default. One transition still misses: overriding a
Pi section in a later prompt after Pi rendered its default earlier in the
session. Pi appends the override; replay keeps the old position. That turn fails
with an explicit `no capture` error rather than dropping instructions. A full fix
needs an order-independent key from structured sections, which Pi does not give
extensions. Captures are refreshed at agent/turn
start to account for prompt re-rendering after `before_agent_start`.
Opaque `forceSystemPrompt` replacements are not re-keyed onto stale portable
inputs: wrappers retain the existing inheritance projection, and an unaccountable
replacement still fails explicitly instead of silently discarding instructions.

System messages never enter Claude Code session history or cursor counts. Shared
delegation applies the same history filtering. One-off summaries marked by Pi's
`cacheRetention: "none"`, including `/bug`, use a separate non-persistent query
instead of touching the active provider session. Compaction and branch-summary
takeover hooks continue using that same isolated executor.

Regression tests cover transcript replay, prompt captures, session reuse, summary
instructions, and cancellation; `tests/int-bug-summary.mjs` drives Pi's real bug
summary function without uploading a report.

## Pi 1.x tools and prompt sections

- **Extension sections reach Claude.** Sections extensions add to the prompt,
  including Pi's own `mcp_servers` list of MCP servers reachable through
  codemode or `tool_search`, are appended to Claude Code's prompt on the
  provider path. An extension's override of one of Pi's sections is forwarded
  too, replacing what it supersedes (an `addendum` override replaces the append
  text); Pi's default harness sections are not. Delegations run their own
  Claude Code tools and do not receive them.
- **Tools loaded mid-turn are served mid-turn.** `tool_search` activates tools and
  promises them on the model's next call, which under this provider is the next
  request of the query already running. The bridge swaps its MCP tool list,
  sends `tools/list_changed`, and holds the tool result until Claude Code has
  re-listed. `tests/int-cc-contracts.mjs` pins that Claude Code re-lists and
  offers the new tool in the same turn. A removed tool stops being listed but
  still answers a call Claude issued before the removal, and an abort during the
  wait drops that turn's results rather than delivering them to the next query.
- **Skills follow Pi's reader.** Claude's copy of the skills names `read`, else
  `bash`, else no tool when Pi hides its reader but keeps it reachable, as
  codemode-only does, instead of being dropped whenever `read` is not served.
- **Delegation tools are `model-only`.** `DelegateToClaude` and `SpawnClaudeAgent`
  orchestrate other agents, so codemode scripts cannot call them.

## Live validation limits

Core transcript, summary, and cache paths are tested on Pi 1.1.0.
The full live suite additionally requires an authenticated alternate provider and
permission for its fixture tools. Managed-policy denials are not overridden to
make those tests pass. The pinned third-party rpiv/pi-subagents integration also
has an unaccounted custom-prompt path; that capture failure reproduces on the
previous 0.1.5 release and is not fixed by the transcript adapter.

## Provider lifecycle hooks

Pi says custom `streamSimple` providers must:

1. Call `SimpleStreamOptions.onPayload` before sending the provider request and
   use any returned replacement payload.
2. Call `SimpleStreamOptions.onResponse` after receiving the HTTP response and
   before consuming its body.

The bridge cannot currently implement either contract faithfully:

| Hook | Support | Reason |
| --- | --- | --- |
| `onPayload` | Unsupported | The Agent SDK accepts a Claude query and owns construction of the provider wire request. It does not expose that final payload or a supported replacement hook. |
| `onResponse` | Unsupported | The Agent SDK does not expose the underlying HTTP response, status, or headers before consuming the body. |
| `onProviderStreamEvent` | Not invoked | Pi makes this observer optional per adapter. The bridge does not forward Claude Code's stream events to it, so `provider_stream_event` handlers see no Claude Delegation traffic. |

Consequently, Pi extensions using `before_provider_request` or
`after_provider_response` do not observe Claude Delegation provider traffic. The
bridge deliberately does not invoke those callbacks with a synthetic query
object, fake HTTP status, or invented headers: doing so would violate payload
replacement semantics and make telemetry misleading.

`tests/unit-provider-hook-contract.mjs` pins both sides of this adapter gap and
asserts that the actual provider adapter does not invoke either callback. It
also pins the exact Agent SDK version for which its declarations were manually
reviewed. Any SDK upgrade must update that review gate after checking for
request, response, fetch, transport, or differently named interception APIs;
the absence of three familiar property names is not treated as proof. Until a
supported adapter API exists, resolving the gap is not a truthful bridge-only
shim.
