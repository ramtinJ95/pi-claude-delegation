/**
 * DelegateToClaude finalization contract.
 *
 * runDelegation resolves — rather than throws — on cancellation so the partial
 * answer and tool activity survive. That makes this glue the only thing standing
 * between an interrupted delegation and a result the model reads as a complete
 * (often empty) answer.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { __test } = await import("../src/index.js");
const { askClaudeResultIsError } = __test;
const { finalizeAskClaudeResult } = await import("../src/delegation-output.js");
const { createDelegationSnapshot } = await import("../src/delegation-events.js");
const { MODEL_RESULT_MAX_CHARS } = await import("../src/delegation-retention.js");

/**
 * A run result carries a complete snapshot, so the fixture builds one rather
 * than handing finalization a partial object it would have to tolerate.
 * `responseText` mirrors the snapshot the way `runDelegation` returns it.
 */
function runResult({ responseText = "", snapshot = {}, ...overrides } = {}) {
	return {
		responseText,
		stopReason: "stop",
		permissionDenials: [],
		messageCount: 1,
		...overrides,
		snapshot: { ...createDelegationSnapshot(0), responseText, ...snapshot },
	};
}

function readTool(path) {
	return { id: `read-${path}`, name: "Read", status: "succeeded", input: { file_path: path }, startedAt: 0, updatedAt: 1, parentToolUseId: null };
}

function finalize(overrides = {}) {
	return finalizeAskClaudeResult({
		result: runResult(overrides),
		prompt: "why?",
		executionTime: 1200,
	});
}

describe("DelegateToClaude finalization", () => {
	it("returns Claude's answer and its actions on a normal stop", () => {
		const { content, details } = finalize({ responseText: "ANSWER", snapshot: { tools: [readTool("a.ts")] } });

		assert.equal(content[0].text, "ANSWER\n\n[Claude Code actions: Read(a.ts)]");
		assert.equal(details.cancelled, undefined);
		assert.equal(details.error, undefined);
		assert.deepEqual(
			{ prompt: details.prompt, executionTime: details.executionTime, actions: details.actions },
			{ prompt: "why?", executionTime: 1200, actions: "Read(a.ts)" },
		);
	});

	it("tells the model a cancelled run was cancelled and keeps its partial work", () => {
		const { content, details } = finalize({
			stopReason: "cancelled",
			responseText: "half an ans",
			snapshot: { tools: [readTool("a.ts")] },
		});

		assert.match(content[0].text, /^Cancelled by user\./);
		assert.match(content[0].text, /half an ans/);
		assert.match(content[0].text, /\[Claude Code actions: Read\(a\.ts\)\]/);
		assert.equal(details.cancelled, true);
		assert.equal(details.error, true);
		assert.equal(details.actions, "Read(a.ts)");
	});

	it("never reports an empty success when cancellation produced nothing", () => {
		const { content, details } = finalize({ stopReason: "cancelled" });

		assert.equal(content[0].text, "Cancelled by user before Claude Code produced a response.");
		assert.equal(details.cancelled, true);
		assert.equal(details.error, true);
	});

	it("still surfaces permission overrides and denials after cancellation", () => {
		const { content } = finalize({
			stopReason: "cancelled",
			permission: { requested: "auto", effective: "default", overridden: true },
			permissionDenials: [{ toolName: "Bash", toolUseId: "t1", reasonType: "rule", message: "denied" }],
		});

		assert.match(content[0].text, /requested auto, runtime default/);
		assert.match(content[0].text, /permission denials: Bash \(rule\)/);
	});

	it("promotes the failure detail to pi's toolResult.isError", () => {
		const cancelled = finalize({ stopReason: "cancelled" }).details;

		assert.deepEqual(
			askClaudeResultIsError({ toolName: "DelegateToClaude", isError: false, details: cancelled }),
			{ isError: true },
		);
		assert.equal(
			askClaudeResultIsError({ toolName: "DelegateToClaude", isError: false, details: finalize({ responseText: "ANSWER" }).details }),
			undefined,
		);
		assert.equal(askClaudeResultIsError({ toolName: "bash", isError: false, details: cancelled }), undefined);
		assert.equal(askClaudeResultIsError({ toolName: "DelegateToClaude", isError: true, details: cancelled }), undefined);
	});

	it("bounds and redacts the model-facing result and retained snapshot", () => {
		const secret = "sk-ant-abcdefghijklmnop";
		const { content, details } = finalize({ responseText: `${secret}\n${"x".repeat(20_000)}` });

		assert.ok(content[0].text.length <= 16_000);
		assert.doesNotMatch(content[0].text, /sk-ant-/);
		assert.match(content[0].text, /truncated/);
		assert.doesNotMatch(details.snapshot.responseText, /sk-ant-/);
	});

	it("returns the authoritative final answer instead of earlier streamed narration", () => {
		const { content, details } = finalize({
			responseText: "I will inspect the files first.",
			snapshot: { resultText: "FINAL ANSWER" },
		});

		assert.equal(content[0].text, "FINAL ANSWER");
		assert.equal(details.snapshot.resultText, "FINAL ANSWER");
	});

	it("keeps policy annotations when a cap-sized answer would otherwise push them off the end", () => {
		const { content } = finalize({
			snapshot: {
				resultText: "y".repeat(MODEL_RESULT_MAX_CHARS),
				resultOmittedChars: 4_000,
				tools: [readTool("a.ts")],
			},
			permission: { requested: "auto", effective: "default", overridden: true },
			permissionDenials: [{ toolName: "Bash", toolUseId: "t1", reasonType: "rule", message: "denied" }],
		});
		const text = content[0].text;

		assert.ok(text.length <= MODEL_RESULT_MAX_CHARS, `length ${text.length}`);
		assert.match(text, /^y{100}/);
		assert.match(text, /requested auto, runtime default/);
		assert.match(text, /permission denials: Bash \(rule\)/);
		assert.match(text, /\[Claude Code actions: Read\(a\.ts\)\]/);
		// One accurate marker: the reducer's omissions plus what this budget cut.
		const markers = text.match(/\[… truncated \d+ chars\]/g);
		assert.equal(markers.length, 1);
		assert.ok(Number(markers[0].match(/(\d+)/)[1]) > 4_000);
	});

	it("keeps the whole model-facing result inside its cap when every segment is oversized", () => {
		const { content } = finalize({
			snapshot: {
				resultText: "y".repeat(MODEL_RESULT_MAX_CHARS * 2),
				tools: Array.from({ length: 400 }, (_, index) => readTool(`file-${index}-${"x".repeat(60)}.ts`)),
			},
			permission: { requested: "auto", effective: "default", overridden: true },
			permissionDenials: Array.from({ length: 40 }, (_, index) => ({
				toolName: `Tool${index}`, toolUseId: `t${index}`, reasonType: "rule", message: "denied",
			})),
		});
		const text = content[0].text;

		assert.ok(text.length <= MODEL_RESULT_MAX_CHARS, `length ${text.length}`);
		// The answer still gets at least the floor the budget reserves for it.
		assert.ok(text.startsWith("y".repeat(MODEL_RESULT_MAX_CHARS / 2)));
		assert.match(text, /requested auto, runtime default/);
		assert.match(text, /permission denials: Tool0 \(rule\)/);
	});
});
