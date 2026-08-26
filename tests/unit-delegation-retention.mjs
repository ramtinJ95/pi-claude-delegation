import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	ACTION_SUMMARY_MAX_CHARS,
	MODEL_RESULT_MAX_CHARS,
	POLICY_ANNOTATION_MAX_CHARS,
	PROMPT_MAX_CHARS,
	RETAINED_LIST_MAX_ITEMS,
	THINKING_MAX_CHARS,
	TIMELINE_MAX_CHARS,
	TIMELINE_MAX_EVENTS,
	TOOL_CALL_MAX_ITEMS,
	TOOL_FIELD_MAX_CHARS,
	assembleModelResult,
	redactSensitiveText,
	retainActionSummary,
	retainText,
	retainToolValue,
} from "../src/delegation-retention.js";
import { createDelegationSnapshot, reduceDelegationEvent, retainDelegationSnapshot } from "../src/delegation-events.js";

describe("delegation retention", () => {
	it("pins each independently adjustable retention choice", () => {
		assert.deepEqual(
			{ MODEL_RESULT_MAX_CHARS, TOOL_FIELD_MAX_CHARS, TIMELINE_MAX_CHARS, TIMELINE_MAX_EVENTS, TOOL_CALL_MAX_ITEMS, RETAINED_LIST_MAX_ITEMS, THINKING_MAX_CHARS, PROMPT_MAX_CHARS, ACTION_SUMMARY_MAX_CHARS, POLICY_ANNOTATION_MAX_CHARS },
			{ MODEL_RESULT_MAX_CHARS: 16_000, TOOL_FIELD_MAX_CHARS: 2_000, TIMELINE_MAX_CHARS: 32_000, TIMELINE_MAX_EVENTS: 100, TOOL_CALL_MAX_ITEMS: 10, RETAINED_LIST_MAX_ITEMS: 100, THINKING_MAX_CHARS: 4_000, PROMPT_MAX_CHARS: 8_000, ACTION_SUMMARY_MAX_CHARS: 2_000, POLICY_ANNOTATION_MAX_CHARS: 1_000 },
		);
	});

	it("redacts and bounds one action summary", () => {
		const redacted = retainActionSummary("Bash(export api_key=super-secret)");
		assert.doesNotMatch(redacted, /super-secret/);
		assert.match(redacted, /Bash\(export api_key=\[REDACTED\]/);

		const oversized = retainActionSummary(Array.from({ length: 400 }, (_, i) => `Read(file-${i}.ts)`).join("; "));
		assert.ok(oversized.length <= ACTION_SUMMARY_MAX_CHARS, `length ${oversized.length}`);
		assert.match(oversized, /truncated/);
	});

	it("spends the model-result budget in priority order rather than truncating the tail", () => {
		const assembled = assembleModelResult({
			answer: "y".repeat(MODEL_RESULT_MAX_CHARS),
			answerOmittedChars: 1_000,
			actions: "[Claude Code actions: Read(a.ts)]",
			annotations: ["[permission mode: requested auto, runtime default.]", "[permission denials: Bash.]"],
		});

		assert.ok(assembled.length <= MODEL_RESULT_MAX_CHARS, `length ${assembled.length}`);
		assert.match(assembled, /^y+/);
		assert.match(assembled, /\[Claude Code actions: Read\(a\.ts\)\]/);
		assert.match(assembled, /runtime default/);
		assert.match(assembled, /permission denials: Bash/);
		// The answer absorbed the shortfall, and says by how much.
		assert.match(assembled, /\[… truncated 1[,\d]* chars\]/);
	});

	it("keeps roughly half the model-result budget for the answer whatever the other segments claim", () => {
		const assembled = assembleModelResult({
			answer: "y".repeat(MODEL_RESULT_MAX_CHARS),
			actions: `[Claude Code actions: ${"a".repeat(MODEL_RESULT_MAX_CHARS)}]`,
			annotations: Array.from({ length: 40 }, (_, i) => `[annotation ${i} ${"p".repeat(2_000)}]`),
		});
		const [answer] = assembled.split("\n\n");

		assert.ok(assembled.length <= MODEL_RESULT_MAX_CHARS, `length ${assembled.length}`);
		assert.ok(answer.startsWith("yyy") && answer.length > MODEL_RESULT_MAX_CHARS * 0.49, `answer kept ${answer.length}`);
		assert.match(assembled, /annotation 0/);
	});

	it("redacts each assembled segment even when nothing needs truncation", () => {
		const assembled = assembleModelResult({
			answer: "token sk-ant-abcdefghijklmnop",
			actions: "[Claude Code actions: Bash(curl -H authorization=leaked-value)]",
			annotations: ["[api_key=annotation-secret]"],
		});

		assert.doesNotMatch(assembled, /abcdefghijklmnop|leaked-value|annotation-secret/);
	});

	it("redacts common credentials before retaining text", () => {
		const text = 'Authorization: Bearer abcdefghijklmnop api_key=secret-value "access_token": "json-secret" https://me:hunter2@example.test sk-ant-abcdefghijklmnop';
		const retained = redactSensitiveText(text);

		assert.doesNotMatch(retained, /abcdefghijklmnop|secret-value|json-secret|hunter2/);
		assert.match(retained, /\[REDACTED\]/);
	});

	it("redacts structured tool fields and visibly truncates oversized values", () => {
		const structured = retainToolValue({ apiKey: "super-secret", nested: { command: "echo ok" } });
		assert.equal(structured.apiKey, "[REDACTED]");
		assert.equal(structured.nested.command, "echo ok");

		const oversized = retainToolValue({ output: "x".repeat(TOOL_FIELD_MAX_CHARS * 2) });
		assert.equal(typeof oversized, "string");
		assert.ok(oversized.length <= TOOL_FIELD_MAX_CHARS);
		assert.match(oversized, /truncated/);
	});

	it("bounds streamed response, thinking, and timeline retention", () => {
		let snapshot = createDelegationSnapshot(0);
		snapshot = reduceDelegationEvent(snapshot, { type: "text_delta", at: 1, text: "a".repeat(MODEL_RESULT_MAX_CHARS + 50) });
		snapshot = reduceDelegationEvent(snapshot, { type: "thinking_delta", at: 2, text: "b".repeat(THINKING_MAX_CHARS + 20) });
		for (let i = 0; i < TIMELINE_MAX_EVENTS + 20; i++) {
			snapshot = reduceDelegationEvent(snapshot, { type: "diagnostic", at: 3 + i, kind: "unhandled_sdk_message", label: `frame-${i}` });
		}

		assert.equal(snapshot.responseText.length, MODEL_RESULT_MAX_CHARS);
		assert.equal(snapshot.responseOmittedChars, 50);
		assert.equal(snapshot.thinkingText.length, THINKING_MAX_CHARS);
		assert.equal(snapshot.thinkingOmittedChars, 20);
		assert.ok(snapshot.timeline.length <= TIMELINE_MAX_EVENTS);
		assert.ok(JSON.stringify(snapshot.timeline).length <= TIMELINE_MAX_CHARS);
		assert.equal(snapshot.timelineOmitted, 20);
	});

	it("redacts assembled streamed text and makes truncation visible before persistence", () => {
		const snapshot = {
			...createDelegationSnapshot(0),
			responseText: "Authorization: Bearer assembled-secret-value",
			responseOmittedChars: 25,
		};
		const retained = retainDelegationSnapshot(snapshot);

		assert.doesNotMatch(retained.responseText, /assembled-secret-value/);
		assert.match(retained.responseText, /REDACTED/);
		assert.match(retained.responseText, /truncated/);
		assert.equal(retained.responseOmittedChars, 0);
	});

	it("keeps an accurate omission count when a reducer-capped field needs a marker", () => {
		const snapshot = {
			...createDelegationSnapshot(0),
			responseText: "x".repeat(MODEL_RESULT_MAX_CHARS),
			responseOmittedChars: 5_000,
		};
		const retained = retainDelegationSnapshot(snapshot);
		const match = retained.responseText.match(/\n\[… truncated (\d+) chars\]$/);

		assert.ok(retained.responseText.length <= MODEL_RESULT_MAX_CHARS);
		assert.ok(match);
		const visibleChars = retained.responseText.indexOf("\n[… truncated");
		assert.equal(Number(match[1]), 5_000 + MODEL_RESULT_MAX_CHARS - visibleChars);
	});

	it("caps retained state lists and records what was omitted", () => {
		const snapshot = createDelegationSnapshot(0);
		snapshot.tools = Array.from({ length: TOOL_CALL_MAX_ITEMS + 3 }, (_, index) => ({
			id: `tool-${index}`, name: "Read", status: "succeeded", startedAt: index, updatedAt: index, parentToolUseId: null,
		}));
		snapshot.permissionDenials = Array.from({ length: RETAINED_LIST_MAX_ITEMS + 2 }, (_, index) => ({
			toolName: "Read", toolUseId: `tool-${index}`, message: "denied",
		}));
		snapshot.diagnostics = Array.from({ length: RETAINED_LIST_MAX_ITEMS + 1 }, (_, index) => ({
			kind: "unhandled_sdk_message", label: `frame-${index}`, at: index,
		}));
		snapshot.timeline = [
			{ kind: "session", label: "started", at: 0 },
			...snapshot.tools.map((tool) => ({ kind: "tool_start", label: tool.name, at: tool.startedAt, toolUseId: tool.id })),
		];

		const retained = retainDelegationSnapshot(snapshot);
		assert.equal(retained.tools.length, TOOL_CALL_MAX_ITEMS);
		assert.equal(retained.toolsOmitted, 3);
		assert.equal(retained.tools[0].id, "tool-3");
		assert.deepEqual(retained.timeline.map((entry) => entry.toolUseId ?? entry.kind), ["session", ...retained.tools.map((tool) => tool.id)]);
		assert.equal(retained.timelineOmitted, 3);
		assert.equal(retained.permissionDenials.length, RETAINED_LIST_MAX_ITEMS);
		assert.equal(retained.permissionDenialsOmitted, 2);
		assert.equal(retained.diagnostics.length, RETAINED_LIST_MAX_ITEMS);
		assert.equal(retained.diagnosticsOmitted, 1);
	});

	it("retains the latest thinking trace and marks the omitted prefix", () => {
		let snapshot = createDelegationSnapshot(0);
		snapshot = reduceDelegationEvent(snapshot, { type: "thinking_delta", at: 1, text: "OLD:" + "x".repeat(THINKING_MAX_CHARS) });
		snapshot = reduceDelegationEvent(snapshot, { type: "thinking_delta", at: 2, text: "api_key=tailsecret LATEST" });

		assert.equal(snapshot.thinkingText.endsWith("LATEST"), true);
		assert.equal(snapshot.thinkingText.includes("OLD:"), false);
		const retained = retainDelegationSnapshot(snapshot);
		const omission = retained.thinkingText.match(/^\[… truncated (\d+) earlier chars\]\n/);
		assert.equal(retained.thinkingText.length, THINKING_MAX_CHARS);
		assert.equal(Number(omission?.[1]), 60);
		assert.doesNotMatch(retained.thinkingText, /tailsecret/);
		assert.match(retained.thinkingText, /api_key=\[REDACTED\]/);
		assert.equal(retained.thinkingText.endsWith("LATEST"), true);
	});

	it("keeps visible text truncation within its field limit", () => {
		const retained = retainText("x".repeat(100), 40);
		assert.equal(retained.length, 40);
		assert.match(retained, /truncated/);
	});
});
