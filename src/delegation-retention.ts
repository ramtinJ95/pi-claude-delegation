// Retention limits are deliberately product choices, not a persistence format.
// Keep them independent so a UI adjustment cannot silently enlarge every field.
export const MODEL_RESULT_MAX_CHARS = 16_000;
export const TOOL_FIELD_MAX_CHARS = 2_000;
export const TIMELINE_MAX_CHARS = 32_000;
export const TIMELINE_MAX_EVENTS = 100;
export const TOOL_CALL_MAX_ITEMS = 10;
export const RETAINED_LIST_MAX_ITEMS = 100;
export const THINKING_MAX_CHARS = 4_000;
export const PROMPT_MAX_CHARS = 8_000;
export const ACTION_SUMMARY_MAX_CHARS = 2_000;
export const POLICY_ANNOTATION_MAX_CHARS = 1_000;

const REDACTED = "[REDACTED]";
const SEGMENT_SEPARATOR = "\n\n";

function sensitiveKey(key: string): boolean {
	return /(?:authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password|passwd|secret|session[-_]?token|cookie|private[-_]?key)/i.test(key);
}

/**
 * Best-effort display/session redaction. This is not a substitute for tool policy.
 *
 * Load-bearing limitation: every pattern here needs a whole credential in one
 * string, and retention cuts strings at character boundaries it chooses for
 * length, not for content. A secret straddling a retention boundary — the cap in
 * `appendRetainedText`, a per-field cap, or the slice in
 * `retainTextWithOmissions` — leaves a fragment on the retained side that no
 * pattern matches, so it survives into displayed and persisted detail. Keeping
 * unbounded text to redact it first would defeat the caps, and a streaming
 * secret detector that carries state across every field was deliberately
 * rejected as more machinery than this display path warrants. Treat the caps as
 * the real containment and this as a courtesy pass over what remains.
 */
export function redactSensitiveText(text: string): string {
	return text
		.replace(/\b(sk-ant-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|AKIA[A-Z0-9]{12,})\b/g, REDACTED)
		.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${REDACTED}`)
		.replace(/(["']?(?:authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password|passwd|secret|session[-_]?token|cookie|private[-_]?key)["']?\s*[=:]\s*["']?)([^\s,"'}]+)/gi, `$1${REDACTED}`)
		.replace(/(https?:\/\/[^\s/:@]+:)([^\s@/]+)(@)/gi, `$1${REDACTED}$3`);
}

export function truncateVisible(text: string, maxChars: number): string {
	return retainTextWithOmissions(text, maxChars, 0, false);
}

export function retainText(text: string, maxChars: number): string {
	return retainTextWithOmissions(text, maxChars);
}

/** Redact and fit one field plus a single accurate omission marker inside its cap. */
export function retainTextWithOmissions(
	text: string,
	maxChars: number,
	previouslyOmitted = 0,
	redact = true,
): string {
	const retained = redact ? redactSensitiveText(text) : text;
	return fitRetainedText(retained, maxChars, previouslyOmitted, "start");
}

export function appendRetainedText(
	current: string,
	delta: string,
	maxChars: number,
	previouslyOmitted = 0,
): { text: string; omittedChars: number } {
	if (previouslyOmitted > 0 || current.length >= maxChars) {
		return { text: current, omittedChars: previouslyOmitted + delta.length };
	}
	const room = maxChars - current.length;
	return {
		text: current + delta.slice(0, room),
		omittedChars: previouslyOmitted + Math.max(0, delta.length - room),
	};
}

/** Redact and fit the newest text, with a marker showing that earlier text was dropped. */
export function retainTailTextWithOmissions(
	text: string,
	maxChars: number,
	previouslyOmitted = 0,
): string {
	return fitRetainedText(redactSensitiveText(text), maxChars, previouslyOmitted, "end");
}

function fitRetainedText(
	text: string,
	maxChars: number,
	previouslyOmitted: number,
	keep: "start" | "end",
): string {
	if (text.length <= maxChars && previouslyOmitted === 0) return text;

	const markerFor = (omittedChars: number) => keep === "start"
		? `\n[… truncated ${omittedChars} chars]`
		: `[… truncated ${omittedChars} earlier chars]\n`;
	let newlyOmitted = Math.max(0, text.length - maxChars);
	let marker = "";
	// The marker consumes retained space; converge after its digit width stabilizes.
	for (let i = 0; i < 5; i++) {
		marker = markerFor(previouslyOmitted + newlyOmitted);
		const next = Math.max(0, text.length - Math.max(0, maxChars - marker.length));
		if (next === newlyOmitted) break;
		newlyOmitted = next;
	}
	marker = markerFor(previouslyOmitted + newlyOmitted);
	if (marker.length >= maxChars) return marker.slice(0, maxChars);
	const room = maxChars - marker.length;
	return keep === "start" ? text.slice(0, room) + marker : marker + text.slice(-room);
}

/** Redact and bound one tool/action summary before it reaches the model or the session. */
export function retainActionSummary(summary: string): string {
	return truncateVisible(redactSensitiveText(summary), ACTION_SUMMARY_MAX_CHARS);
}

/**
 * Fit one model-facing delegation result inside a single total budget.
 *
 * The segments are not equally load-bearing, so the budget is spent in an
 * explicit priority order rather than by joining everything and truncating the
 * tail. Tail truncation dropped exactly the policy annotations — a permission
 * override, a denial — whenever the answer alone reached the cap, which is the
 * one case where the model most needs to know that what it is reading was
 * produced under restricted permissions.
 *
 * Priority: policy annotations first (small, and they change what the answer is
 * worth), then the action summary, then the answer, which absorbs the remaining
 * budget. The answer is last on purpose: it is the only segment whose loss is
 * self-describing, since it carries an accurate `[… truncated N chars]` marker.
 * Output order stays answer, actions, annotations for readability.
 *
 * The lower-priority segments arrive already bounded — annotations by
 * `POLICY_ANNOTATION_MAX_CHARS`, the action summary by `retainActionSummary` —
 * and `answerFloor` is the backstop that keeps them from starving the answer
 * even if a caller hands over an unbounded one. It is a floor on what they may
 * collectively claim, so the answer keeps roughly, not exactly, half: segment
 * separators come out of the same budget.
 */
export function assembleModelResult(input: {
	answer: string;
	answerOmittedChars?: number;
	actions?: string;
	annotations?: string[];
	maxChars?: number;
}): string {
	const maxChars = input.maxChars ?? MODEL_RESULT_MAX_CHARS;
	const answerFloor = Math.floor(maxChars / 2);
	let used = 0;

	// Reserve one segment. `used` tracks the exact joined length, so the total
	// stays within budget no matter which segments were dropped.
	const reserve = (text: string, cap: number, previouslyOmitted = 0): string => {
		if (!text) return "";
		const separator = used > 0 ? SEGMENT_SEPARATOR.length : 0;
		const room = Math.min(cap, maxChars - used - separator);
		if (room <= 0) return "";
		const fitted = retainTextWithOmissions(text, room, previouslyOmitted);
		used += separator + fitted.length;
		return fitted;
	};
	const beforeAnswer = (cap: number) => Math.min(cap, maxChars - answerFloor - used);

	const annotations = (input.annotations ?? [])
		.map((annotation) => reserve(annotation, beforeAnswer(POLICY_ANNOTATION_MAX_CHARS)))
		.filter(Boolean);
	const actions = reserve(input.actions ?? "", beforeAnswer(maxChars));
	const answer = reserve(input.answer, maxChars, input.answerOmittedChars);

	return [answer, actions, ...annotations].filter(Boolean).join(SEGMENT_SEPARATOR);
}

function redactValue(value: unknown, key = "", seen = new WeakSet<object>()): unknown {
	if (sensitiveKey(key)) return REDACTED;
	if (typeof value === "string") return redactSensitiveText(value);
	if (value == null || typeof value !== "object") return value;
	if (seen.has(value)) return "[Circular]";
	seen.add(value);
	if (Array.isArray(value)) return value.map((item) => redactValue(item, "", seen));
	return Object.fromEntries(Object.entries(value as Record<string, unknown>)
		.map(([childKey, child]) => [childKey, redactValue(child, childKey, seen)]));
}

/** Retain structured input when it fits; otherwise retain a visibly truncated JSON rendering. */
export function retainToolValue(value: unknown): unknown {
	if (value === undefined) return undefined;
	const redacted = redactValue(value);
	let serialized: string;
	try { serialized = JSON.stringify(redacted, null, 2) ?? String(redacted); } catch { serialized = String(redacted); }
	return serialized.length <= TOOL_FIELD_MAX_CHARS
		? redacted
		: truncateVisible(serialized, TOOL_FIELD_MAX_CHARS);
}
