import type { Context } from "@earendil-works/pi-ai";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { DelegationQueryFactory, DelegationRunResult } from "./delegation-runner.js";
import { errorMessage, retainDelegationSnapshot, type DelegationSnapshot } from "./delegation-events.js";
import { buildAskClaudePartialUpdate, buildSnapshotActionSummary, retainAskClaudePrompt, type AskClaudeResultDetails } from "./askclaude-ui.js";
import { updateLiveAskClaudeCall } from "./claude-sessions-overlay.js";
import { assembleModelResult } from "./delegation-retention.js";
import { finalizeAskClaudeResult } from "./delegation-output.js";
import { createProgressPublisher } from "./progress-publisher.js";

export interface ForegroundRunOptions {
	systemPrompt?: string;
	appendSkills?: boolean;
	onSnapshot?: (snapshot: DelegationSnapshot) => void;
	model?: string;
	thinking?: string;
	isolated?: boolean;
	context?: Context["messages"];
	permissionMode?: PermissionMode;
	/** Pi's execute-context cwd; process.cwd() is only the fallback. */
	cwd?: string;
	/** Test seam forwarded to the delegation runner. */
	queryFactory?: DelegationQueryFactory;
}

export type ForegroundDelegationRunner = (prompt: string, mode: "full" | "read" | "none", signal?: AbortSignal, options?: ForegroundRunOptions) => Promise<DelegationRunResult>;

export interface ForegroundDelegationResult {
	content: { type: "text"; text: string }[];
	details: AskClaudeResultDetails;
}

export interface ForegroundDelegationInput {
	toolCallId: string;
	/** Shown in the live overlay slot and retained in details as the call's prompt. */
	displayPrompt: string;
	/** The prompt actually sent to Claude Code (may wrap displayPrompt in a role/launch context). */
	delegationPrompt: string;
	mode: "full" | "read" | "none";
	isolated: boolean;
	requestedModel: string;
	thinking?: string;
	signal?: AbortSignal;
	onUpdate?: (update: ForegroundDelegationResult) => void;
	systemPrompt?: string;
	appendSkills?: boolean;
	permissionMode?: PermissionMode;
	/** Pi branch messages for isolated=false session resume; undefined when isolated. */
	context?: Context["messages"];
	cwd?: string;
	/** Persisted label facts (e.g. SpawnClaudeAgent foreground profile) merged into every published details object. */
	detailExtras?: Pick<AskClaudeResultDetails, "origin" | "profile">;
	/** Test seam forwarded to the delegation runner. */
	queryFactory?: DelegationQueryFactory;
}

/**
 * The one foreground execution path: blocking DelegateToClaude calls and foreground
 * SpawnClaudeAgent calls both run through here, so there is a single
 * synchronous delegation runner, retained-snapshot/live-update pipeline, live
 * overlay slot, finalization, and error-promotion contract. Callers differ only
 * in how they build the delegation prompt and which label extras they persist.
 */
export function createForegroundDelegationExecutor(run: ForegroundDelegationRunner, debug: (...args: unknown[]) => void = () => {}) {
	return async function executeForegroundDelegation(input: ForegroundDelegationInput): Promise<ForegroundDelegationResult> {
		const { toolCallId, displayPrompt, mode, isolated, requestedModel } = input;
		const extras = input.detailExtras ?? {};
		const start = Date.now();
		let lastSnapshot: DelegationSnapshot | undefined;
		const progress = createProgressPublisher((snapshot: DelegationSnapshot) => {
			const now = Date.now();
			const update = buildAskClaudePartialUpdate(snapshot, {
				prompt: displayPrompt,
				executionTime: now - start,
				capabilityMode: mode,
				requestedModel,
				thinking: input.thinking,
				isolated,
			});
			const details = { ...update.details, ...extras };
			// Same bounded, retained, redacted record the tool row streams — the
			// details overlay's live view adds no second retention path.
			updateLiveAskClaudeCall({ toolCallId, startedAt: start, prompt: displayPrompt, details });
			input.onUpdate?.({ ...update, details });
		});
		const publishSnapshot = (force = false) => {
			if (lastSnapshot) progress.push(lastSnapshot, force);
		};
		const progressInterval = setInterval(() => publishSnapshot(true), 1000);
		const stopPublishing = () => {
			clearInterval(progressInterval);
			progress.stop();
		};

		try {
			// Seed the live slot before the first snapshot so /claude-details and
			// ctrl+n can show the running call immediately. The slot keeps the final
			// details after completion until the session branch persists the result,
			// which then shadows it; the next call replaces the slot.
			updateLiveAskClaudeCall({
				toolCallId,
				startedAt: start,
				prompt: displayPrompt,
				details: {
					prompt: retainAskClaudePrompt(displayPrompt),
					executionTime: 0,
					capabilityMode: mode,
					requestedModel,
					thinking: input.thinking,
					isolated,
					...extras,
				},
			});

			const result = await run(input.delegationPrompt, mode, input.signal, {
				systemPrompt: input.systemPrompt,
				appendSkills: input.appendSkills,
				onSnapshot: (snapshot) => {
					lastSnapshot = snapshot;
					publishSnapshot();
				},
				model: requestedModel,
				thinking: input.thinking,
				isolated,
				permissionMode: input.permissionMode,
				context: input.context,
				cwd: input.cwd,
				queryFactory: input.queryFactory,
			});
			const finalized = finalizeAskClaudeResult({
				result,
				prompt: displayPrompt,
				executionTime: Date.now() - start,
				capabilityMode: mode,
				requestedModel,
				thinking: input.thinking,
				isolated,
			});
			const details = { ...finalized.details, ...extras };
			updateLiveAskClaudeCall({ toolCallId, startedAt: start, prompt: displayPrompt, details });
			return { content: finalized.content, details };
		} catch (err) {
			debug(`foreground delegation error: mode=${mode}, model=${requestedModel}, isolated=${isolated}, elapsed=${((Date.now() - start) / 1000).toFixed(1)}s, error=`, err);
			// Summarize the retained snapshot, not the raw one: the failure path
			// persists and displays the same bounded, redacted record as success.
			const retainedSnapshot = lastSnapshot ? retainDelegationSnapshot(lastSnapshot) : undefined;
			const errorDetails: AskClaudeResultDetails = {
				prompt: retainAskClaudePrompt(displayPrompt),
				executionTime: Date.now() - start,
				actions: retainedSnapshot ? buildSnapshotActionSummary(retainedSnapshot) : undefined,
				capabilityMode: mode,
				requestedModel,
				thinking: input.thinking,
				isolated,
				error: true,
				permissionDenials: retainedSnapshot?.permissionDenials,
				snapshot: retainedSnapshot,
				...extras,
			};
			updateLiveAskClaudeCall({ toolCallId, startedAt: start, prompt: displayPrompt, details: errorDetails });
			return {
				content: [{ type: "text" as const, text: assembleModelResult({ answer: `Error: ${errorMessage(err)}` }) }],
				details: errorDetails,
			};
		} finally {
			stopPublishing();
		}
	};
}
