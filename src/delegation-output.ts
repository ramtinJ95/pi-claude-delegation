import { assembleModelResult } from "./delegation-retention.js";
import { retainDelegationSnapshot } from "./delegation-events.js";
import { buildSnapshotActionSummary, retainAskClaudePrompt, type AskClaudeResultDetails } from "./askclaude-ui.js";
import { managedPolicyLabels, type ManagedPolicySummary, type PermissionObservation } from "./query-policy.js";
import type { DelegationRunResult } from "./delegation-runner.js";

export function permissionAnnotations(input: {
	permission?: PermissionObservation;
	managedPolicy?: ManagedPolicySummary;
	permissionDenials: readonly { toolName: string; reasonType?: string }[];
}): string[] {
	const annotations: string[] = [];
	if (input.permission?.overridden) {
		const policyLabels = managedPolicyLabels(input.managedPolicy);
		annotations.push(`[Claude Code permission mode: requested ${input.permission.requested}, runtime ${input.permission.effective}${policyLabels.length ? `; observed managed policy: ${policyLabels.join(", ")}` : "; Claude settings or managed policy may have overridden it"}.]`);
	}
	if (input.permissionDenials.length) {
		const denied = input.permissionDenials
			.slice(0, 5)
			.map((item) => `${item.toolName}${item.reasonType ? ` (${item.reasonType})` : ""}`)
			.join(", ");
		annotations.push(`[Claude Code permission denials: ${denied}${input.permissionDenials.length > 5 ? ", …" : ""}.]`);
	}
	return annotations;
}

/**
 * Shape one finished delegation into the model-facing result and TUI details.
 *
 * A cancelled run resolves normally in the runner so partial work survives, so
 * this is the only place that can stop it reading as a successful empty answer:
 * the model is told it was cancelled, whatever response and actions did arrive
 * are kept, and the `cancelled`/`error` details keep the renderer — and
 * `askClaudeResultIsError` — from claiming success.
 *
 * The action summary is derived here from the retained snapshot rather than
 * accepted from the caller, so the model-facing summary, the persisted details,
 * and the rendered tool list all describe the same bounded record.
 */
export function finalizeAskClaudeResult(input: {
	result: DelegationRunResult;
	prompt: string;
	executionTime: number;
	capabilityMode?: "full" | "read" | "none";
	requestedModel?: string;
	thinking?: string;
	isolated?: boolean;
}): { content: { type: "text"; text: string }[]; details: AskClaudeResultDetails } {
	const { result } = input;
	const snapshot = retainDelegationSnapshot(result.snapshot);
	const actions = buildSnapshotActionSummary(snapshot);
	const cancelled = result.stopReason === "cancelled";

	// The authoritative SDK result still wins over earlier streamed narration.
	// Budget the model answer from the runner's own snapshot text rather than the
	// retained display copy, so an answer that hits the cap carries one accurate
	// omission count instead of a second marker stacked on an already-marked one.
	const resultText = result.snapshot.resultText;
	const answer = resultText ?? result.snapshot.responseText;
	const answerOmittedChars = (resultText === undefined ? result.snapshot.responseOmittedChars : result.snapshot.resultOmittedChars) ?? 0;

	// Policy annotations, not prose: they tell the model the answer was produced
	// under an overridden permission mode or with tools denied.
	const annotations = permissionAnnotations(result);

	const text = assembleModelResult({
		answer: cancelled
			? answer
				? `Cancelled by user. Partial response before cancellation:\n\n${answer}`
				: "Cancelled by user before Claude Code produced a response."
			: answer,
		answerOmittedChars: answer ? answerOmittedChars : 0,
		actions: actions ? `[Claude Code actions: ${actions}]` : "",
		annotations,
	});

	return {
		content: [{ type: "text" as const, text }],
		details: {
			prompt: retainAskClaudePrompt(input.prompt),
			executionTime: input.executionTime,
			actions,
			capabilityMode: input.capabilityMode,
			requestedModel: input.requestedModel,
			thinking: input.thinking,
			isolated: input.isolated,
			...(cancelled ? { cancelled: true, error: true } : {}),
			permission: result.permission,
			permissionDenials: snapshot.permissionDenials,
			managedPolicy: result.managedPolicy,
			snapshot,
		},
	};
}
