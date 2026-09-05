import { StringEnum, type Context } from "@earendil-works/pi-ai";
import { buildSessionContext, keyHint, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { AGENT_PROFILES, agentCapabilityMode, buildAgentJobPrompt, resolveAgentProfile, type AgentProfile, type AgentProfileId } from "./agent-profiles.js";
import { BackgroundJobLimitError, type BackgroundJobManager, type BackgroundJobLaunch, type BackgroundJobRecord } from "./background-jobs.js";
import { CheckoutWriteLease, checkoutWriteConflictText, type CheckoutWriteLeaseHandle } from "./checkout-write-lease.js";
import type { ReviewerDiffArtifact } from "./reviewer-diff.js";
import type { DelegationRunResult } from "./delegation-runner.js";
import { errorMessage, type DelegationSnapshot } from "./delegation-events.js";
import { DEFAULT_PERMISSION_MODE, type CapabilityMode } from "./query-policy.js";
import { assembleModelResult } from "./delegation-retention.js";
import { ASK_CLAUDE_DEFAULT_MODEL } from "./delegation-options.js";
import { renderAskClaudeResult, PREVIEW_MAX_CHARS, PREVIEW_MAX_LINES, type AskClaudeResultDetails } from "./askclaude-ui.js";
import type { ForegroundDelegationResult } from "./foreground-delegation.js";

export const spawnClaudeAgentToolName = "SpawnClaudeAgent";

/** Bounded launch facts for the persisted spawn result — never the diff text itself. */
interface SpawnClaudeAgentResultDetails {
	jobId?: string;
	mode?: CapabilityMode;
	/** Derived role/presentation label; capability is selected by `mode`. */
	profile?: AgentProfileId;
	requestedModel?: string;
	thinking?: string;
	launchCwd?: string;
	launchCapturedAt?: number;
	diffSource?: string;
	/** True when the launch artifact's diff or status text was truncated to its bound. */
	diffArtifactTruncated?: boolean;
	error?: boolean;
}

/**
 * Promote a failed spawn to pi's `toolResult.isError`, exactly like
 * `askClaudeResultIsError`: a rejected second spawn or a diff-capture failure
 * must reach the model as an error result, not as a successful-looking answer.
 */
export function spawnClaudeAgentResultIsError(
	event: { toolName: string; isError: boolean; details?: unknown },
): { isError: true } | undefined {
	if (event.toolName !== spawnClaudeAgentToolName || event.isError) return undefined;
	return (event.details as SpawnClaudeAgentResultDetails | undefined)?.error ? { isError: true } : undefined;
}

export function spawnedJobResultText(record: BackgroundJobRecord): string {
	const mode = AGENT_PROFILES[record.profile].capabilityMode;
	const worker = mode === "full";
	const capability = mode === "none" ? "no-access" : mode === "read" ? "read-only" : "full-capability";
	const parts = [
		`Started background Claude job ${record.id} (mode=${mode}, agent=${record.profile}, model=${record.requestedModel}${record.thinking ? `, thinking=${record.thinking}` : ""}).`,
		`It runs in a fresh isolated ${capability} Claude session in ${record.launch.cwd} on context captured at launch${record.launch.diff ? ` (review diff artifact: ${record.launch.diff.source})` : ""}.`,
		"One background job runs per session; a second spawn fails until this one finishes.",
	];
	if (worker) {
		parts.push("SINGLE-WRITER WARNING: this worker edits the current checkout while it runs. Until its completion message arrives, do not edit, create, or delete files or run mutating commands in this checkout — inspect and discuss only.");
	}
	parts.push(`When the job reaches a terminal state its bounded result is delivered into this conversation as a message you will see on a later turn — ${worker ? "" : "keep working normally; "}there are no status, result, or cancel tools to poll.`);
	return parts.join(" ");
}

/** One foreground SpawnClaudeAgent call handed to the shared foreground execution implementation. */
interface SpawnForegroundRun {
	toolCallId: string;
	/** The caller's task text — displayed/persisted as the call's prompt. */
	task: string;
	/** The full delegation prompt (role prompt + launch context + task, reviewer diff included). */
	prompt: string;
	profile: AgentProfile;
	requestedModel: string;
	thinking?: string;
	isolated: boolean;
	cwd: string;
	signal: AbortSignal;
	onUpdate?: (update: ForegroundDelegationResult) => void;
	systemPrompt?: string;
	/** Pi branch messages when isolated=false; resumed exactly like DelegateToClaude shared mode. */
	context?: Context["messages"];
}

/** Injected effects for `registerSpawnClaudeAgent` — the seam unit tests replace all of them. */
export interface SpawnClaudeAgentDeps {
	debug?: (...args: unknown[]) => void;
	/** SpawnClaudeAgent shares DelegateToClaude's opt-in; nothing registers when it is off. */
	enabled: boolean;
	/**
	 * Whether full capability is offered. Wired from the
	 * DelegateToClaude contract's allowFullMode lockout so a configuration that forbids
	 * full mode cannot be bypassed through SpawnClaudeAgent.
	 */
	allowFull: boolean;
	/** Effective requested permission mode, for rendering only. */
	requestedPermissionMode?: string;
	/** Shared atomic lease for every full-capability Claude writer. */
	writeLease?: CheckoutWriteLease;
	jobs: BackgroundJobManager;
	captureDiff: (input: { cwd: string; base?: string; capturedAt: number; signal?: AbortSignal }) => Promise<ReviewerDiffArtifact>;
	runJob: (input: {
		prompt: string;
		profile: AgentProfile;
		requestedModel: string;
		thinking?: string;
		cwd: string;
		signal: AbortSignal;
		onSnapshot: (snapshot: DelegationSnapshot) => void;
	}) => Promise<DelegationRunResult>;
	/** Foreground execution — production wires the shared `executeForegroundDelegation`. */
	runForeground: (input: SpawnForegroundRun) => Promise<ForegroundDelegationResult>;
	cwd?: (ctx: Pick<ExtensionContext, "cwd">) => string;
	now?: () => number;
}

/** Mirror Pi's default (no-renderResult) tool result rendering for background spawn results. */
function renderSpawnBackgroundResult(
	result: { content: Array<{ type: string; text?: string }> },
	options: { expanded: boolean },
	theme: Parameters<typeof renderAskClaudeResult>[2],
): Text {
	const output = result.content[0]?.type === "text" ? result.content[0].text ?? "" : "";
	const lines = output.split("\n");
	const displayLines = options.expanded ? lines : lines.slice(0, 10);
	const remaining = lines.length - displayLines.length;
	let text = displayLines.map((line) => theme.fg("toolOutput", line)).join("\n");
	if (remaining > 0) {
		text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
	}
	return new Text(text, 0, 0);
}

/**
 * Narrow adapter seam that wires SpawnClaudeAgent into Pi: tool registration,
 * error-result promotion, and the session lifecycle cleanup of background
 * jobs. Everything impure — the job manager, reviewer diff capture, background
 * delegation, foreground execution, cwd, clock — arrives injected so the wiring
 * is deterministic to test; production injects the real implementations from
 * the extension entry.
 *
 * Both execution modes are callers of the shared delegation runner. A
 * background job returns promptly with a job ID and never enters foreground
 * finalization or provider QueryContext; a foreground call blocks and returns
 * its bounded result through the same foreground implementation DelegateToClaude uses.
 */
export function registerSpawnClaudeAgent(pi: Pick<ExtensionAPI, "registerTool" | "on">, deps: SpawnClaudeAgentDeps): void {
	if (!deps.enabled) return;
	const { jobs, debug = () => {} } = deps;
	const cwdOf = deps.cwd ?? ((ctx: Pick<ExtensionContext, "cwd">) => ctx.cwd);
	const now = deps.now ?? Date.now;
	const renderPermissionMode = deps.requestedPermissionMode ?? DEFAULT_PERMISSION_MODE;
	const writeLease = deps.writeLease ?? new CheckoutWriteLease();

	pi.on("tool_result", (event) => spawnClaudeAgentResultIsError(event));
	// Background jobs are Pi-session-scoped. Both handlers are async and Pi
	// 0.84.2 awaits them, so this cleanup — bounded by the manager's shutdown
	// grace — really completes before the session is replaced or torn down;
	// jobs that settle inside the grace keep their genuine terminal state and
	// only unconfirmed ones are recorded as abandoned.
	pi.on("session_start", async (event) => {
		if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") {
			await jobs.reset();
		}
	});
	pi.on("session_shutdown", async () => {
		await jobs.shutdown();
	});

	const modeValues = deps.allowFull ? ["none", "read", "full"] as const : ["none", "read"] as const;
	const modeDescription = '"none": no tools. "read": read-only repository/web access.'
		+ (deps.allowFull
			? ' "full": Bash/Edit/Write; only for explicit user-requested implementation.'
			: "");
	const spawnClaudeAgentParams = Type.Object({
		task: Type.String({ description: "Complete task instructions; isolated agents do not see Pi history." }),
		mode: StringEnum(modeValues, { description: modeDescription }),
		review: Type.Optional(Type.Object({
			base: Type.Optional(Type.String({ description: "Git ref; the review diff starts at its merge base with HEAD." })),
		}, { description: 'Read-mode code review. Omit base to review working-tree changes against HEAD.' })),
		user_requested: Type.Optional(Type.Boolean({ description: "Required true for full mode; set only for explicit user-requested implementation delegation." })),
		execution: Type.Optional(StringEnum(["foreground", "background"] as const, { description: '"background" (default): return a job ID now and deliver the result later. "foreground": block and return the result directly.' })),
		isolated: Type.Optional(Type.Boolean({ description: "Foreground only. true (default): fresh session. false: include Pi history. Background is always isolated." })),
		model: Type.Optional(Type.String({ description: 'Model name or ID. Default: "opus".' })),
		thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const, { description: "Thinking effort level. Omit to use Claude Code's default." })),
	});
	pi.registerTool<typeof spawnClaudeAgentParams>({
		name: spawnClaudeAgentToolName,
		label: "Spawn Claude Agent",
		description: "Start a foreground or background (default) Claude Code agent. Background returns a job ID and delivers the result later; do not poll. One background job may run per Pi session."
			+ (deps.allowFull ? " Full mode requires explicit user delegation; do not edit concurrently with a background full-mode agent." : ""),
		parameters: spawnClaudeAgentParams,
		renderCall(args, theme) {
			let text = theme.fg("mdLink", theme.bold("SpawnClaudeAgent "));
			// Restored Phase 3c tool calls still carry `profile`; derive their
			// capability so old transcript rows never render `mode=undefined`.
			const legacyProfile = (args as typeof args & { profile?: unknown }).profile;
			const mode = args.mode ?? (typeof legacyProfile === "string" ? agentCapabilityMode(legacyProfile) : undefined);
			const tags = [`mode=${mode ?? "unavailable"}`, `execution=${args.execution ?? "background"}`];
			if (typeof legacyProfile === "string") tags.push(`agent=${legacyProfile}`);
			if (args.review) tags.push("review");
			if (args.user_requested) tags.push("user-requested");
			if (args.isolated !== undefined) tags.push(args.isolated ? "isolated" : "shared");
			tags.push(`model=${args.model ?? ASK_CLAUDE_DEFAULT_MODEL}`);
			if (args.thinking) tags.push(`thinking=${args.thinking}`);
			if (args.review?.base) tags.push(`base=${args.review.base}`);
			text += `${theme.fg("accent", `[${tags.join(", ")}]`)} `;
			const truncated = args.task.length > PREVIEW_MAX_CHARS ? args.task.substring(0, PREVIEW_MAX_CHARS) : args.task;
			const lines = truncated.split("\n").slice(0, PREVIEW_MAX_LINES);
			text += theme.fg("muted", `"${lines.join("\n")}"`);
			if (args.task.length > PREVIEW_MAX_CHARS || args.task.split("\n").length > PREVIEW_MAX_LINES) text += theme.fg("dim", " …");
			return new Text(text, 0, 0);
		},
		renderResult(result, options, theme, context) {
			// Foreground calls carry the DelegateToClaude-shaped details (marked with
			// origin) and reuse the same rich renderer; background results keep
			// Pi's plain default-style rendering.
			const details = result.details as AskClaudeResultDetails | SpawnClaudeAgentResultDetails | undefined;
			if (details && "origin" in details && details.origin === "spawn-foreground") {
				return renderAskClaudeResult(result, options, theme, context, renderPermissionMode);
			}
			return renderSpawnBackgroundResult(result, options, theme);
		},
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const requestedModel = params.model ?? ASK_CLAUDE_DEFAULT_MODEL;
			const rawMode: unknown = params.mode;
			const rawReview: unknown = params.review;
			const rawExecution: unknown = params.execution ?? "background";
			const mode = rawMode === "none" || rawMode === "read" || rawMode === "full"
				? rawMode as CapabilityMode
				: undefined;
			const review = rawReview === undefined
				? undefined
				: typeof rawReview === "object" && rawReview !== null && !Array.isArray(rawReview)
					? rawReview as { base?: unknown }
					: null;
			let profile: AgentProfile | undefined;
			if (mode && review !== null && (!review || mode === "read")) {
				profile = resolveAgentProfile(mode, review !== undefined);
			}
			const spawnError = (text: string): { content: { type: "text"; text: string }[]; details: SpawnClaudeAgentResultDetails } => ({
				content: [{ type: "text" as const, text: assembleModelResult({ answer: `Error: ${text}` }) }],
				details: { error: true, ...(mode ? { mode } : {}), ...(profile ? { profile: profile.id } : {}), requestedModel, thinking: params.thinking },
			});

			if (ctx.model?.baseUrl === "claude-delegation") {
				debug("spawnClaudeAgent: blocked circular delegation (active provider is claude-delegation)");
				return spawnError("SpawnClaudeAgent cannot be used when the active provider is claude-delegation — you're already running through Claude Code.");
			}
			if (!mode) {
				return spawnError(`Unknown SpawnClaudeAgent capability mode: ${typeof rawMode === "string" ? rawMode : String(rawMode)}.`);
			}
			if (rawExecution !== "foreground" && rawExecution !== "background") {
				return spawnError(`Unknown SpawnClaudeAgent execution mode: ${typeof rawExecution === "string" ? rawExecution : String(rawExecution)}.`);
			}
			const execution = rawExecution;
			if (review === null) {
				return spawnError("The review parameter must be an object when provided.");
			}
			if (review?.base !== undefined && typeof review.base !== "string") {
				return spawnError("The review.base parameter must be a string when provided.");
			}
			if (review && mode !== "read") {
				return spawnError('Review specialization requires mode="read".');
			}
			// Schema-level gating already hides full mode; this keeps a
			// restored or hand-written call from bypassing the allowFullMode lockout.
			if (mode === "full" && !deps.allowFull) {
				return spawnError('SpawnClaudeAgent mode="full" is disabled: delegation.allowFullMode is false in this configuration.');
			}
			if (mode === "full" && params.user_requested !== true) {
				return spawnError('SpawnClaudeAgent mode="full" requires user_requested=true, and that assertion may be supplied only when the user explicitly asked to delegate implementation to Claude.');
			}
			if (mode !== "full" && params.user_requested !== undefined) {
				return spawnError('The user_requested assertion applies only to mode="full".');
			}
			if (!profile) return spawnError("Could not resolve the requested Claude agent role.");
			// Background jobs are always fresh and isolated; silently ignoring
			// isolated=false would change semantics the caller asked for.
			if (execution === "background" && params.isolated === false) {
				return spawnError('execution="background" always runs a fresh isolated Claude session; isolated=false (shared Pi conversation context) requires execution="foreground".');
			}
			// The initiating tool call owns the launch: a cancelled call must not
			// start anything, and a spawn the manager would reject anyway must not
			// pay for reviewer diff capture.
			if (signal.aborted) {
				debug("spawnClaudeAgent: tool call cancelled before launch");
				return spawnError("SpawnClaudeAgent was cancelled before it launched anything; no agent was started.");
			}
			if (execution === "background") {
				const alreadyRunning = jobs.running();
				if (alreadyRunning) {
					return spawnError(new BackgroundJobLimitError(alreadyRunning.id).message);
				}
			}

			let writeLeaseHandle: CheckoutWriteLeaseHandle | undefined;
			if (profile.capabilityMode === "full") {
				writeLeaseHandle = writeLease.tryAcquire({
					id: `${spawnClaudeAgentToolName}:${execution}:${toolCallId}`,
					label: `${spawnClaudeAgentToolName} ${execution} full-mode worker`,
				});
				if (!writeLeaseHandle) return spawnError(checkoutWriteConflictText(writeLease));
			}

			try {
				const cwd = cwdOf(ctx);
				const capturedAt = now();
				// The extension captures the reviewer's diff at launch in either
				// execution mode; the agent never gets Bash to take its own. Capture
				// failures (non-git directory, invalid base) must fail the spawn
				// visibly here, not hand the reviewer an empty diff it would read as
				// "no changes".
				const diff = profile.requiresDiffArtifact
					? await deps.captureDiff({ cwd, base: typeof review?.base === "string" ? review.base : undefined, capturedAt, signal })
					: undefined;
				// The capture awaited; the tool call may have been cancelled meanwhile.
				if (signal.aborted) {
					debug("spawnClaudeAgent: tool call cancelled during launch capture");
					return spawnError("SpawnClaudeAgent was cancelled during launch capture; no agent was started.");
				}
				const launch: BackgroundJobLaunch = { cwd, capturedAt, ...(diff ? { diff } : {}) };
				const prompt = buildAgentJobPrompt({ profile, task: params.task, launch });

				if (execution === "foreground") {
					// Foreground blocks this tool call and returns the bounded result
					// through the same implementation as DelegateToClaude: same runner, live
					// updates, retained snapshot, overlay slot, and error semantics.
					// Pi is blocked while it runs, so a foreground worker is naturally
					// the only writer of the checkout.
					const isolated = params.isolated ?? true;
					debug(`spawnClaudeAgent: foreground mode=${mode} agent=${profile.id} isolated=${isolated} diff=${diff ? diff.source : "none"}`);
					try {
						return await deps.runForeground({
							toolCallId,
							task: params.task,
							prompt,
							profile,
							requestedModel,
							thinking: params.thinking,
							isolated,
							cwd,
							signal,
							onUpdate,
							systemPrompt: ctx.getSystemPrompt(),
							context: isolated ? undefined : buildSessionContext(ctx.sessionManager.getBranch()).messages as Context["messages"],
						});
					} finally {
						writeLeaseHandle?.release();
						writeLeaseHandle = undefined;
					}
				}

				// From here the job's own AbortController owns its lifecycle; the
				// initiating tool call's signal deliberately plays no further part.
				const record = jobs.spawn({
					profile: profile.id,
					task: params.task,
					requestedModel,
					thinking: params.thinking,
					launch,
					execute: (run) => deps.runJob({
						prompt,
						profile,
						requestedModel,
						thinking: params.thinking,
						cwd,
						signal: run.signal,
						onSnapshot: run.onSnapshot,
					}),
				});
				if (writeLeaseHandle) {
					const settlement = jobs.settled(record.id);
					if (!settlement) {
						// The worker already exists. Fail closed: deliberately orphan the
						// handle while the process-global lease stays held, rather than let
						// the outer catch release write ownership under a running writer.
						writeLeaseHandle = undefined;
						throw new Error(`Background worker ${record.id} has no settlement handle; checkout write ownership remains held because termination cannot be confirmed.`);
					}
					const transferredLease = writeLeaseHandle;
					void settlement.finally(() => transferredLease.release());
					writeLeaseHandle = undefined;
				}
				debug(`spawnClaudeAgent: started ${record.id} profile=${record.profile} diff=${diff ? diff.source : "none"}`);
				return {
					content: [{ type: "text" as const, text: spawnedJobResultText(record) }],
					details: {
						jobId: record.id,
						mode,
						profile: record.profile,
						requestedModel: record.requestedModel,
						thinking: record.thinking,
						launchCwd: record.launch.cwd,
						launchCapturedAt: record.launch.capturedAt,
						...(diff ? { diffSource: diff.source, diffArtifactTruncated: diff.diffTruncated || diff.statusTruncated } : {}),
					} satisfies SpawnClaudeAgentResultDetails,
				};
			} catch (err) {
				writeLeaseHandle?.release();
				if (!(err instanceof BackgroundJobLimitError)) {
					debug(`spawnClaudeAgent error: mode=${mode} agent=${profile.id} execution=${execution} model=${requestedModel}`, err);
				}
				return spawnError(errorMessage(err));
			}
		},
	});
}
