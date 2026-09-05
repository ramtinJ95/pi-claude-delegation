# @ramtinj95/pi-claude-delegation

[![npm version](https://img.shields.io/npm/v/@ramtinj95/pi-claude-delegation)](https://www.npmjs.com/package/@ramtinj95/pi-claude-delegation)

Pi extension that integrates Claude Code via the [Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript). This package is maintained from [ramtinJ95/pi-claude-delegation](https://github.com/ramtinJ95/pi-claude-delegation), forked from [elidickinson/pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge), which was based initially on [claude-agent-sdk-pi](https://github.com/prateekmedia/claude-agent-sdk-pi) by Prateek Sunal. The inherited MIT license and upstream history are preserved.

1. **Provider** — Use Opus/Sonnet/Haiku as models in pi, with all tool calls flowing through pi's TUI
2. **DelegateToClaude tool** — Delegate tasks or questions to Claude Code when using another provider
3. **SpawnClaudeAgent tool** — Start an independent Claude Code agent with explicit `none`, `read`, or `full` capability and optional read-only review specialization, in the background (job ID, live widget, result on a later turn) or foreground (blocks and returns directly, like DelegateToClaude)


**FYI:** Anthropic [announced and then unannounced](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) a change to how you would be billed for tools that use the Agent SDK like this one. It currently uses your regular subscription quota just like Claude Code.

<p>
<a href="assets/claude-bridge1.png"><img src="assets/claude-bridge1.png" width="49%"></a>&nbsp;
<a href="assets/claude-bridge2.png"><img src="assets/claude-bridge2.png" width="49%"></a>
</p>

## Install

```
pi install npm:@ramtinj95/pi-claude-delegation
```

This fork requires Pi 0.84.2 or newer and Node.js 22.19 or newer.

Version 0.1.0 has clean typecheck and unit/package validation. The manual
Phase 3d dogfood checks for reload-time worker termination and checkout-write
lease ownership have not yet been recorded; see `docs/FORK-DIRECTION.md` in
the source repository. This is an explicit verification gap, not a claim that
those runtime paths have been dogfooded.

### Migrating from `pi-claude-bridge`

This package intentionally starts a new runtime namespace. It does not read
the old config automatically:

1. Install `npm:@ramtinj95/pi-claude-delegation` and remove the old package or
   local-path entry.
2. Rename `claude-bridge.json` to `claude-delegation.json`.
3. Rename the config's `askClaude` block to `delegation`.
4. Select models under the `claude-delegation` provider. The blocking tool is
   now `DelegateToClaude`; `SpawnClaudeAgent` keeps its name.

## Provider

Use `/model` to select `claude-delegation/claude-fable-5-1`, `claude-delegation/claude-opus-5`, `claude-delegation/claude-opus-4-8`, `claude-delegation/claude-opus-4-7`, `claude-delegation/claude-opus-4-6`, `claude-delegation/claude-sonnet-5`, `claude-delegation/claude-sonnet-4-6`, or `claude-delegation/claude-haiku-4-5`. The `fable` shortcut and stale `claude-fable-5` requests are forced to Fable 5.1; this package no longer invokes Fable 5.

Behind the scenes, pi's tools are bridged to Claude Code but it should all work like normal in pi. Bash commands get a 120-second default timeout (matching Claude Code's default) since pi's bash has no timeout by default. Skills in pi are copied over to Claude Code's system prompt so should work as they would with any other pi provider. Steering works mid-turn: a message sent while Claude is running a tool reaches it at that tool boundary, not after the whole turn finishes.

**1M Context:** Opus 5, Opus 4.8, and Opus 4.7 get 1M context by default. Opus 4.6 only gets 1M if you're on a Max plan or pay for Extra Usage. Sonnet 4.6 only gets 1M if you pay for Extra Usage. You will need to set `provider.plan` and/or `provider.longContextExtraUsage` for 1M context in Opus 4.6/Sonnet 4.6 as described in [Configuration](#configuration).

## DelegateToClaude Tool

Opt-in: set `delegation.enabled` to `true` (see [Configuration](#configuration)). Available when using any non-claude-delegation provider. Pi's LLM can delegate tasks to Claude Code and wait for it to answer a question or perform a task. Examples of how to use:

- "Ask Claude to plan a fix"
- "If you get stuck, ask claude for help"
- "Ask claude to review the plan in @foo.md, implement it, then ask an isolated=true claude to review the implementation"
- "Ask claude to poke holes in this theory"
- "Find all the places in the codebase that handle auth"

You could also create skills or add something to AGENTS.md to e.g. "Always call Ask Claude to review complicated feature implementations before considering the task complete."

### Parameters

- **`prompt`** — the question or task for Claude Code
- **`mode`** — `read` (default; model-callable tools are limited to Read, Glob, Grep, WebFetch, and WebSearch), `none` (no model-callable tools), or `full` (Claude Code's normal tools except unsupported interactive/lifecycle tools; disable with `allowFullMode: false`)
- **`model`** — `opus` (default), `sonnet`, `haiku`, or a full model ID
- **`thinking`** — effort level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`
- **`isolated`** — when `true`, Claude gets a fresh conversation with no Pi history or persisted Claude session (default: `true`). This is conversation isolation, not a hermetic process: working-directory access, settings, sandbox, and managed policy still apply.

While a call runs, DelegateToClaude streams Claude's response and a compact tool/action
summary into one Pi tool row. Expand the row for the prompt, emitted thinking
summaries, a grouped action summary with one aggregate tool-status line,
usage/cost, session metadata, observed permission or managed-policy state, and
the authoritative response. Per-tool inputs/outputs, durations, nesting, and the
retained event timeline live only in the details overlay below, not inline.
Thinking is emitted summary text, not private chain-of-thought. Persisted display
details use bounded fields, visible truncation, and best-effort credential
redaction; the model-facing result is separately capped at about 16k characters.

### Claude Sessions overlay

For deep inspection beyond the inline row, `/claude-details` opens one centered
overlay over every Claude delegation in the session — DelegateToClaude calls,
foreground SpawnClaudeAgent calls, and background SpawnClaudeAgent jobs — as a
single flat chronological list with clear kind/mode/agent/status labels.
Foreground SpawnClaudeAgent calls appear as foreground Claude records labelled
`SpawnClaudeAgent <agent> (foreground)`, read from the same persisted
tool-call/result pairs as DelegateToClaude records (no new persistence format), and
they update live and survive session restores the same way. `Ctrl+N` toggles the same overlay. When a
background job is running, opening the overlay focuses it first; otherwise it
focuses the chronologically latest record. `/claude-details 2` opens record #2
of the merged list. DelegateToClaude records are read from the current session
branch's persisted tool-call/result pairs; background records come from the
persisted `claude-background-job` completion entries merged with the in-memory
job manager (which supplies running state and is the terminal fallback if no
entry was persisted). Completed records stay inspectable after a session
resume, and the running DelegateToClaude call or background job updates live while
the overlay is open.

`/askclaude-details` remains as a legacy command alias: it opens the same
unfiltered overlay focused on the latest DelegateToClaude record, and
`/askclaude-details 2` counts actual DelegateToClaude compatibility calls only —
foreground SpawnClaudeAgent calls and background jobs are skipped, preserving
the command's original numbering — before mapping to the merged list. It is
not a separately filtered view.

Pi 0.84.2 also assigns `Ctrl+N` inside its session picker. The extension owns
the shortcut in the main editor, so Pi may report that overlap as an extension
shortcut warning at startup; the session picker's focused binding still works.

The pinned header shows only what the Claude delegation itself reported. For
DelegateToClaude records: runtime model, tokens/cache/cost/turns, Claude session ID,
Claude working directory, runtime permission mode, status, capability,
isolation, and requested thinking level. For background records: capability mode and derived agent role,
status, runtime/requested model, thinking, permission and managed-policy
state, Claude session ID and launch working directory, usage, elapsed time or
duration, job ID, and the reviewer diff source when applicable. Values the
delegation did not report read `unavailable` rather than borrowing anything
from the active Pi session. The scrollable body shows the same sections for
both kinds — the full original prompt or task, the emitted thinking summary,
retained nested tools with inputs/outputs/durations/status, the retained
timeline, the authoritative response, and diagnostics. Tool outputs and lists
remain subject to the same retained limits as the inline row — truncation and
omission notices are shown as persisted, not re-expanded — and a malformed or
forward-incompatible persisted job entry degrades to a visible placeholder.

Keys while the overlay is focused: `↑`/`↓` or `j`/`k` scroll by line,
`PgUp`/`PgDn` (including your configured select-page bindings) by page,
`Home`/`End` jump, `1`-`9` jump to a section, `←`/`→` (or `p`/`n`) switch to the
previous/next record, and `q`, `Esc`, or `Ctrl+N` close.

## SpawnClaudeAgent Tool

Registered together with DelegateToClaude (`delegation.enabled: true`). Like DelegateToClaude
it is for non-claude-delegation providers only: when the active provider is
claude-delegation the tool returns a visible error instead of delegating in a
circle. Pi's LLM can start one independent Claude Code agent in either
execution mode:

- **`execution: "background"`** (default) — the tool returns immediately with a
  stable job ID (e.g. `claude-job-3f9c2d1a7b4e-1` — a collision-resistant
  random per-runtime prefix plus a counter, so ID collisions across extension
  reloads are overwhelmingly unlikely) instead of waiting for Claude to
  finish. The job always runs in a fresh isolated Claude session. A sticky
  widget tracks the running job, the Claude Sessions overlay (`Ctrl+N`,
  `/claude-details`, or `/claude-jobs`) inspects it, `/claude-jobs cancel`
  cancels it, and the job's bounded result is delivered back into the
  conversation exactly once when it reaches a terminal state (see below).
- **`execution: "foreground"`** — the tool call blocks until the agent
  finishes and returns its bounded result directly, through the same
  foreground implementation as DelegateToClaude: same delegation runner, live
  progress in the tool row, retained snapshot, rich rendering, error
  semantics, and Claude Sessions overlay record. Foreground calls may choose
  `isolated: false` to share the Pi conversation context (exactly like
  DelegateToClaude's shared mode); background jobs are always fresh and isolated, and
  `execution: "background"` with `isolated: false` is rejected with a visible
  error rather than silently ignored.

Both modes run through the same delegation engine and policy resolver as
DelegateToClaude, with `permissionMode` taken from the same `delegation` configuration
(default `"auto"`; bypass is never hard-coded).

### Parameters

- **`task`** — the body of work. Include everything the agent needs; by
  default it has no Pi conversation history.
- **`mode`** — the same explicit capability vocabulary as DelegateToClaude:
  - `none`: no repository, filesystem, shell, agent, or web tools. The derived
    advisor role answers only from the task and general knowledge.
  - `read`: structurally limited to Read, Glob, Grep, WebFetch, and WebSearch —
    no Bash, editing, or nested agents. The normal derived role is explorer.
  - `full`: Claude Code capability through the Claude Code preset
    (Bash/Edit/Write, governed by Claude Code permission policy and managed
    settings). The derived worker edits the current checkout and its role
    prompt forbids committing, pushing, opening PRs, branch changes, and
    destructive cleanup unless the task explicitly authorizes them. Full mode
    is offered only while `delegation.allowFullMode` permits it.
- **`review`** — optional code-review specialization, valid only with
  `mode: "read"`. Pass `{}` to review staged, unstaged, and untracked changes
  against `HEAD`, or `{ "base": "main" }` for a branch/PR review spanning the
  merge base of that ref and `HEAD` through the launch-time working tree. The
  extension captures and freezes the diff before launch. Review is separate
  from capability: it derives the reviewer role but does not add tools.
- **`execution`** — `background` (default) or `foreground`, as above.
- **`user_requested`** — full mode only; must be `true`, and may be asserted only
  when the user explicitly asked to delegate implementation to Claude. Missing
  or false assertions reject the full-mode call visibly; supplying it in
  `none` or `read` mode is also rejected.
- **`isolated`** — foreground only; `true` (default) for a fresh session,
  `false` to share Pi conversation history like DelegateToClaude.
- **`model`** / **`thinking`** — same semantics and defaults as DelegateToClaude.

The UI derives familiar agent labels from the contract: `none` → advisor,
`read` → explorer, `read` plus `review` → reviewer, and `full` → worker. These
labels select role prompts and presentation only; `mode` remains the capability
authority.

### Behavior and current limits

- One background job runs per Pi session. A second spawn fails with a visible
  error result; it is not queued. Foreground calls do not count against this
  limit — Pi is blocked while they run.
- **Single-writer contract for full-capability Claude calls:** one atomic,
  process-wide checkout lease covers background workers, foreground workers,
  and DelegateToClaude `mode: "full"`. A second Claude writer fails visibly, including
  across an extension reload while an old worker has not actually settled.
  Background worker results and the live widget also warn the main agent to
  inspect/discuss only. The lease remains held after an `abandoned` status
  until the executor really settles; cancellation requests cooperative
  interrupt and immediately closes the SDK transport so a wedged interrupt
  cannot keep editing behind a dismissed warning. A dedicated git-worktree
  lifecycle is deliberately deferred.
- DelegateToClaude remains a compatibility tool for now. SpawnClaudeAgent foreground
  execution now covers its `none`/`read`/`full` capability vocabulary plus its
  blocking/live/session-sharing mechanics; removing DelegateToClaude is a separate
  post-dogfooding compatibility decision.
- Agents launch from Pi's execute-context working directory (the session cwd),
  not a guessed repository.
- A review-specialized agent's status/diff artifact is captured by the extension at launch —
  the job cannot take its own (no Bash). It is bounded under named limits (40k
  chars of diff, 4k of status) with visible truncation markers and best-effort
  credential redaction, and it records which base/source it compares. Invalid
  refs and non-git directories fail the spawn instead of producing an empty
  diff that would read as "no changes". Capture streams bounded prefixes, obeys
  launch cancellation, and has a 30-second overall deadline. Omitted files are
  still checked for Git failures; oversized Git metadata also fails the spawn.
  External diff and text-conversion helpers are disabled.
- The diff artifact is frozen at launch, but the job's Read/Glob/Grep calls see
  the live working tree, which may already contain later edits; the job's
  prompt says so explicitly.
- Cancelling the initiating tool call before the job ID is returned prevents
  the launch entirely — no detached job is started. Once the job ID is
  returned, the job's own lifecycle controls it; the original call's
  cancellation no longer reaches it.
- Jobs are session-scoped with bounded in-memory records only. On session
  shutdown or switch, running jobs are aborted (interrupting their Claude Code
  queries) and shutdown waits up to 2 seconds for them to confirm settlement.
  A job that confirms in time keeps its genuine terminal state (usually
  `cancelled`); only a job still unconfirmed after that grace period is
  recorded as `abandoned`. A job settled by shutdown or session switch is not
  delivered anywhere — the session it belonged to is gone.
- There are no model-callable status/result/cancel tools: the model spawns the
  job and receives the completion message; humans inspect and cancel via
  `/claude-jobs`.

### Live widget, /claude-jobs, and completion delivery

While a job runs, a compact widget above Pi's editor shows the Claude-job
facts: job ID, capability mode, derived agent role, requested/runtime model, requested thinking, status,
current action, elapsed time, runtime permission mode, permission-denial
count, and usage once Claude Code reports it, plus the `Ctrl+N` details and
`/claude-jobs cancel` hints. It is at most three lines (worker jobs add a
fourth single-writer warning line), truncated to the terminal width, and
disappears on every terminal state, session shutdown, or session switch.

Human commands (no model context consumed):

- `/claude-jobs` — open the Claude Sessions overlay focused on the running
  background job, else the latest background job; if the session has none it
  says so. Outside the interactive TUI it prints the textual status listing
  (job ID, status, elapsed time, and model per job) instead.
- `/claude-jobs cancel [job-id]` — cancel the running job (the job ID is
  optional when one job is running). Unknown or already-terminal jobs are
  reported honestly instead of being "cancelled".

When a job reaches a terminal state, its result is delivered exactly once:

- One session-persisted, TUI-only entry with the reviewable details — task,
  actions, aggregate tool status, usage, permission/managed-policy state, and
  the bounded, redacted response. It renders collapsed by default, expands
  with the usual tool-expand key, and still renders after a session is
  resumed.
- One bounded model-visible message sent with Pi 0.84.2's non-triggering
  `sendMessage(..., { triggerTurn: false, deliverAs: "nextTurn" })`: it is
  queued alongside your next prompt and never interrupts or triggers a turn on
  its own. Failed, cancelled, and abandoned jobs deliver explicit outcomes —
  never a successful-looking empty result — and a success with no output text
  says so. The queued message is in-memory Pi state: if Pi exits before your
  next prompt, it is not re-delivered.

## Configuration

Config: `~/.pi/agent/claude-delegation.json` (global) or the project Pi config directory, usually `.pi/claude-delegation.json` (project; merged over global).

```json
{
  "delegation": {
    "enabled": true,
    "allowFullMode": true,
    "defaultIsolated": true,
    "permissionMode": "auto",
    "description": "Custom tool description override"
  },
  "provider": {
    "plan": "max",
    "longContextExtraUsage": false,
    "strictMcpConfig": true,
    "permissionMode": "auto",
    "pathToClaudeCodeExecutable": "/home/you/.nix-profile/bin/claude"
  }
}
```

`delegation`:
- `enabled` — register the DelegateToClaude and SpawnClaudeAgent tools (default `false`). If it's unset, the startup notice below points this out once.
- `name` — override the tool's pi-side name (default `"DelegateToClaude"`)
- `label` — override the TUI label (default `"Delegate to Claude"`)
- `description` — override the tool description. Default when `allowFullMode: true`: *"Delegate to Claude Code for a second opinion or analysis (code review, architecture questions, debugging theories), or to autonomously handle a task. Defaults to read-only mode — use full mode when the user wants to delegate a task that requires changes. Prefer to handle straightforward tasks yourself."*
- `defaultMode` — `"read"` (default), `"none"`, or `"full"`
- `defaultIsolated` — start each call in a fresh conversation without Pi history or Claude session persistence (default `true`)
- `allowFullMode` — allow `mode: "full"`; set `false` to remove full capability from both DelegateToClaude and SpawnClaudeAgent.
- `appendSkills` — forward pi's skills block into the system prompt (default `true`)
- `permissionMode` — Claude Code permission policy within the selected capability mode (default `"auto"`). Supported SDK values are `"auto"`, `"default"`, `"acceptEdits"`, `"dontAsk"`, `"plan"`, and `"bypassPermissions"`. Bypass is dangerous, must be explicit, and cannot override organization-managed policy.

`provider`:
- `plan` (default `"pro"`) — set to `"max"` if you have a Max (or Team Premium/Enterprise) Anthropic plan. This enables Opus with 1M context.
- `longContextExtraUsage` — set to `true` to enable 1M context models even if they cost money through Extra Usage on your plan. It enables Sonnet 4.6 with 1M on every plan and Opus 4.6 with 1M on Pro. Not needed for Opus 4.7 or 4.8.
- `strictMcpConfig` — block MCP servers from `~/.claude.json` / `.mcp.json` (default `true`). Cloud MCP (Gmail/Drive via claude.ai OAuth) is always blocked.
- `autoMemoryEnabled` — enable Claude Code's auto-memory system (default `false`)
- `permissionMode` — Claude Code permission policy for provider queries and isolated summaries (default `"auto"`). The bridge does not install a host callback that overrides denials; Claude settings and managed policy may therefore reject Pi MCP calls.
- `pathToClaudeCodeExecutable` — path to the `claude` binary. Useful if your OS/filesystem has the SDK's bundled musl/glibc binaries in a place where they can't run. For example, with Nix you can set the binary to e.g. `"/home/you/.nix-profile/bin/claude"`.

If a provider tool is denied, allow its exact Claude-side MCP alias in Claude
permission settings (for example, `mcp__custom-tools__read`) or explicitly choose
a different `provider.permissionMode`. Organization-managed permission rules may
require an administrator to add the grant. The bridge deliberately does not pass
`allowedTools` for every Pi tool: doing so would auto-approve the entire Pi tool
inventory and make the configured provider permission mode nominal rather than
effective.

Capability and permission are independent: `mode` controls which tools exist,
while `permissionMode` controls how Claude Code governs calls to those tools.
Claude Code may replace the requested permission mode because of user, project,
or managed settings. DelegateToClaude renders the requested and runtime modes when they
differ and reports observable permission denials; the provider emits the same
override as a warning. The bridge also summarizes non-sensitive constraints that
the Agent SDK attributes to its managed settings tier (for example, required
sandboxing or disabled bypass) without exposing permission-rule contents. The
resolver does not execute an administrator `policyHelper`, and the SDK does not
expose a complete effective sandbox decision, so the bridge does not claim that
this summary is exhaustive.


**Startup notice:** the first interactive session to reach Claude Code lists whichever of `provider.plan` and `delegation.enabled` you have left unset, then records `startupNoticeShown` (the date, `YYYY-MM-DD`) in the global config so it doesn't nag again.

**Extension providers and models.json:** pi's `modelOverrides` in `~/.pi/agent/models.json` do not currently apply to extension-registered providers (like claude-delegation). Overriding `contextWindow` or other fields requires editing `src/models.ts` directly.

## Tests

`npm run test:unit` for offline tests (`tests/unit-*.mjs`: queue, import, skills). 

The offline suite also launches the repository-local Pi 0.84.2 CLI to verify
that the extension loads and registers its provider. Test output records the
installed Pi, Agent SDK, and bundled Claude Code versions.

`npm test` for the full suite, which adds integration tests that hit APIs (`tests/int-*.{sh,mjs}`: smoke, multi-turn, cache, session-resume, session-rebuild, tool-message). Set `CLAUDE_BRIDGE_TESTING_ALT_MODEL` in `.env.test` for the alt-provider smoke test (e.g. `openrouter/z-ai/glm-4.7-flash`).

Integration tests spawn real `pi` and Claude Code subprocesses, so they need write access to `~/.claude` for CC's session state — a sandbox that blocks it makes the next turn's `--resume` fail with `No conversation found with session ID`. The RPC harness probes for this at startup and fails fast.

## Debugging

Set `CLAUDE_BRIDGE_DEBUG=1` to enable debug output:

- **Bridge log** at `~/.pi/agent/claude-delegation.log` — every provider call, session sync decision, tool result delivery, and CC's stderr. Override location with `CLAUDE_BRIDGE_DEBUG_PATH`.
- **Per-query Claude Code CLI logs** at `~/.pi/agent/cc-cli-logs/<timestamp>-<tag>-<seq>.log` — the CC subprocess's own debug stream, one file per `query()` call. Tags are `provider` (main turn) or `askclaude` (sub-delegation). Useful when a resume fails or CC misbehaves internally — shows the CLI's own view of session loading, API requests, and tool calls.

When filing a bug about a session-resume failure (e.g. "No conversation found"), the most useful attachments are the `syncResult:` lines from the bridge log plus the matching `cc-cli-logs/` file for the failing query.

## Known issues

**Pi provider request/response hooks are not available through the Agent SDK.**
Claude Bridge cannot faithfully implement Pi 0.84.2's `onPayload` replacement
or `onResponse` observation contracts because the Agent SDK exposes neither the
final wire payload nor the underlying HTTP response. It does not fabricate
either one. This means `before_provider_request` and `after_provider_response`
extensions do not observe bridge traffic. See
[Pi 0.84 compatibility baseline](docs/PI-084-COMPATIBILITY.md).

**Sessions get rebuilt more often than they need to be, and a rebuild is expensive.** The bridge rewrites Claude Code's session from pi's history whenever pi's messages move underneath it — after an abort, `/compact`, tree navigation, or an API error. Measured over this repo's own bridge log, a rebuild boundary loses the prompt cache roughly 58% of the time against 26% for a plain resume, so an abort-heavy session costs noticeably more than a clean one. Aborts alone are 46% of rebuilds.

**Files Claude Code edits are not carried across a rebuild.** CC records the post-edit contents as an `edited_text_file` attachment; those aren't carried, because they hang off a tool-result record rather than a prompt and so have no stable position to restore them to. The edit itself survives — it's in the history as a tool call and its result — so this costs Claude the file snapshot, not the knowledge that it made the change. `@file` expansions *are* carried.
