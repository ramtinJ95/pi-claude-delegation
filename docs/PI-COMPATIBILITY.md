# Pi compatibility baseline

The fork requires Pi 0.86.1 or newer and develops against exact 0.87.1 versions
of `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and
`@earendil-works/pi-tui`. Node.js 22.19 or newer is required.

Upgrade older Pi installations before using this release. The public transcript
helpers used by the adapter require the 0.86.1 floor; the old 0.84.2 baseline is
no longer supported.

The offline unit suite launches the repository-local Pi CLI in an isolated
temporary agent directory, loads `src/index.ts`, and verifies that the
`claude-delegation` models are registered. Test output also records the installed Pi
packages, Agent SDK, and the Claude Code version bundled by that SDK.

## Transcript and summary adaptation

Pi 0.86+ carries prompt sections and tool changes in transcript system messages,
not `context.systemPrompt` / `context.tools`. `src/transcript.ts` replays this state
with Pi's public helpers before provider or isolated-summary execution. Section
order stays aligned with Pi's prompt builder, including removal and re-addition,
so exact prompt-capture lookup still works. Captures are refreshed at agent/turn
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

## Live validation limits

Core transcript, summary, and cache paths are tested on Pi 0.86.1 and 0.87.1.
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
