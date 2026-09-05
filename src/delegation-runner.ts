import {
	query,
	type Options,
	type PermissionMode,
	type Query,
	type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
	createDelegationSnapshot,
	assertSdkResultReceived,
	reduceDelegationMessage,
	sdkResultErrorText,
	type DelegationPermissionDenial,
	type DelegationSnapshot,
} from "./delegation-events.js";
import {
	observePermissionMode,
	type ManagedPolicySummary,
	type PermissionObservation,
} from "./query-policy.js";

export interface DelegationQuery extends AsyncIterable<SDKMessage> {
	interrupt(): Promise<unknown>;
	close(): void;
}

export type DelegationQueryFactory = (params: { prompt: string; options: Options }) => DelegationQuery;

export interface DelegationRunnerInput {
	prompt: string;
	options: Options;
	requestedPermissionMode: PermissionMode;
	signal?: AbortSignal;
	managedPolicy?: Promise<ManagedPolicySummary | undefined>;
	onSnapshot?: (snapshot: DelegationSnapshot) => void;
	queryFactory?: DelegationQueryFactory;
	now?: () => number;
}

export interface DelegationRunResult {
	responseText: string;
	stopReason: "stop" | "cancelled";
	permission?: PermissionObservation;
	permissionDenials: DelegationPermissionDenial[];
	managedPolicy?: ManagedPolicySummary;
	snapshot: DelegationSnapshot;
	messageCount: number;
}

const defaultQueryFactory: DelegationQueryFactory = (params) => query(params) as Query;

/**
 * Own one Claude-native Agent SDK query lifecycle.
 *
 * Provider QueryContext, MCP result routing, and Pi session synchronization do
 * not belong here. Foreground delegations and background jobs share this lifecycle.
 */
export async function runDelegation(input: DelegationRunnerInput): Promise<DelegationRunResult> {
	const now = input.now ?? Date.now;
	let snapshot = createDelegationSnapshot(now());
	let permission: PermissionObservation | undefined;
	let managedPolicy: ManagedPolicySummary | undefined;
	let messageCount = 0;
	let wasAborted = false;
	let sawResult = false;
	let sdkQuery: DelegationQuery | undefined;

	const publish = () => input.onSnapshot?.(snapshot);
	const onAbort = () => {
		wasAborted = true;
		const activeQuery = sdkQuery;
		// Ask Claude Code to stop cooperatively, but do not wait for that control
		// request before closing the transport. A wedged interrupt must not leave a
		// background worker editing after shutdown has marked it abandoned.
		void activeQuery?.interrupt().catch(() => {});
		try { activeQuery?.close(); } catch {}
	};
	const completedResult = (stopReason: "stop" | "cancelled"): DelegationRunResult => ({
		responseText: snapshot.responseText,
		stopReason,
		permission,
		permissionDenials: snapshot.permissionDenials,
		managedPolicy,
		snapshot,
		messageCount,
	});

	if (input.signal?.aborted) {
		// A queued background job can be cancelled before its runner gets CPU.
		// Report that through the same terminal outcome as an in-flight abort;
		// there is no SDK process to create, interrupt, or close in this path.
		wasAborted = true;
		snapshot = { ...snapshot, status: "cancelled", updatedAt: now() };
		publish();
		return completedResult("cancelled");
	}

	try {
		sdkQuery = (input.queryFactory ?? defaultQueryFactory)({
			prompt: input.prompt,
			options: input.options,
		});
		input.signal?.addEventListener("abort", onAbort, { once: true });
		publish();

		for await (const message of sdkQuery) {
			if (wasAborted) break;
			messageCount++;
			snapshot = reduceDelegationMessage(snapshot, message, now());

			if (message.type === "system" && message.subtype === "init") {
				managedPolicy ??= await input.managedPolicy;
				permission = observePermissionMode(
					input.requestedPermissionMode,
					message.permissionMode,
				);
			}

			if (message.type === "result") sawResult = true;
			// Claude Code reports API failures (capacity, overload, prompt-too-long)
			// with `is_error` on an otherwise success-shaped result. Publish the
			// terminal snapshot first, then throw so callers render an error result
			// instead of returning the failure text as Claude's answer.
			const failure = message.type === "result" ? sdkResultErrorText(message) : undefined;
			if (failure) {
				snapshot = { ...snapshot, status: "failed", error: failure, updatedAt: now() };
				publish();
				throw new Error(failure);
			}
			publish();
		}

		if (wasAborted) {
			// Cancellation resolves rather than throws: the caller still owns the
			// partial answer and tool activity collected before the interrupt.
			snapshot = { ...snapshot, status: "cancelled", updatedAt: now() };
			publish();
			return completedResult("cancelled");
		}

		// The catch publishes missing-result failures just like transport failures.
		assertSdkResultReceived(sawResult, snapshot.assistantError);

		snapshot = { ...snapshot, status: "succeeded", updatedAt: now() };
		publish();
		return completedResult("stop");
	} catch (error) {
		if (wasAborted) {
			// An interrupt makes the SDK iterator throw ("aborted by user"). That is
			// the cancellation path, not a delegation failure, so the error text is
			// dropped and the state matches a clean break out of the loop.
			snapshot = {
				...snapshot,
				status: "cancelled",
				error: undefined,
				updatedAt: now(),
			};
			publish();
			return completedResult("cancelled");
		}
		// A result-shaped or missing-result failure already published its terminal
		// snapshot above; only an unexpected throw still needs one.
		if (snapshot.status === "running") {
			snapshot = {
				...snapshot,
				status: "failed",
				error: error instanceof Error ? error.message : String(error),
				updatedAt: now(),
			};
			publish();
		}
		throw error;
	} finally {
		input.signal?.removeEventListener("abort", onAbort);
		try { sdkQuery?.close(); } catch {}
	}
}
