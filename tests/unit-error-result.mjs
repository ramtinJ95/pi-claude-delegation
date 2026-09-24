/**
 * CC reports API failures (429 capacity, overload, prompt-too-long) as a result with
 * is_error set while subtype stays "success", after streaming the text as a <synthetic>
 * assistant message. Shape verified against claude-agent-sdk 0.3.257. Without this the
 * turn finalizes as a normal stop and the failure never reaches pi.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { QueryContext } from "../src/query-state.js";

const { __test } = await import("../src/index.js");

const fakeModel = { api: "anthropic-messages", provider: "anthropic", id: "test-model" };

function fakeStream() {
	const events = [];
	return { events, push: (e) => events.push(e), end: () => events.push({ type: "end" }) };
}

function makeCtx() {
	const c = new QueryContext();
	c.currentPiStream = fakeStream();
	c.resetTurnState(fakeModel);
	return c;
}

async function consume(c, messages) {
	async function* gen() { for (const m of messages) yield m; }
	await __test.consumeQuery(gen(), new Map(), fakeModel, () => false, c);
}

const errorResult = {
	type: "result", subtype: "success", is_error: true, api_error_status: 429,
	result: "API Error: Server is temporarily limiting requests (not your usage limit): Rate limited",
	terminal_reason: "model_error",
};

// Shared by the provider turn and the isolated compact summary — the summary path used to
// accept an errored result as a valid summary, writing "Prompt is too long" into history.
describe("resultErrorText", () => {
	it("treats is_error on a success-shaped result as a failure", () => {
		assert.strictEqual(__test.resultErrorText(errorResult), errorResult.result);
	});

	it("returns undefined for a genuine success", () => {
		assert.strictEqual(__test.resultErrorText({ type: "result", subtype: "success", is_error: false, result: "a summary" }), undefined);
	});

	it("joins errors[] for the dedicated error subtypes", () => {
		assert.strictEqual(__test.resultErrorText({ type: "result", subtype: "error_during_execution", errors: ["boom", "bang"] }), "boom\nbang");
	});

	it("never returns an empty message for a failure", () => {
		assert.ok(__test.resultErrorText({ type: "result", subtype: "success", is_error: true, result: "" }));
		assert.ok(__test.resultErrorText({ type: "result", subtype: "error_max_budget_usd" }));
		// errors[] is typed string[], with no promise of being non-empty; joining an
		// empty one marks the turn errored with nothing to show the user.
		assert.ok(__test.resultErrorText({ type: "result", subtype: "error_during_execution", errors: [] }));
	});
});

// pi carries a failure only as errorMessage text, so every consumer that reacts to a rate
// limit pattern-matches it. These mirror pi-subagents' gate (model-fallback.ts): one pattern
// from its retryable list, and the tool-failure shape it refuses to retry.
const RETRYABLE = /rate\s*limit/i;
const TOOL_FAILURE_PREFIX = /^[\w.:@/-]+ failed (?:(?:\(exit \d+\):)|(?:with exit code \d+))(?:\s|$)/i;

describe("a rate-limited failure", () => {
	// Claude Code words a subscription limit with none of the vocabulary anyone matches on,
	// and sends the rejection as its own message just before the failure it caused.
	const rejection = {
		type: "rate_limit_event",
		rate_limit_info: { status: "rejected", resetsAt: 1786141800, rateLimitType: "five_hour" },
	};
	const limitResult = {
		type: "result", subtype: "success", is_error: true,
		result: "You're out of extra usage · resets 6:30pm (America/New_York)",
	};

	it("is named as a rate limit so fallback chains fire", async () => {
		const c = makeCtx();
		await consume(c, [rejection, limitResult]);

		assert.match(c.turnOutput.errorMessage, RETRYABLE);
		assert.doesNotMatch(c.turnOutput.errorMessage, TOOL_FAILURE_PREFIX);
		assert.ok(c.turnOutput.errorMessage.includes(limitResult.result), "keeps Claude Code's own wording");
		assert.ok(c.turnOutput.errorMessage.includes("five_hour"));
	});

	it("labels only the failure it caused, not a later one", async () => {
		const c = makeCtx();
		await consume(c, [rejection, limitResult, errorResult]);

		assert.strictEqual(c.turnOutput.errorMessage, errorResult.result);
	});

	it("leaves an unrelated failure alone", async () => {
		const c = makeCtx();
		await consume(c, [errorResult]);
		assert.strictEqual(c.turnOutput.errorMessage, errorResult.result);
	});
});

describe("rate-limit notifications", () => {
	function withNotifications(run) {
		const notices = [];
		__test.setPiUI({ notify: (text) => notices.push(text) });
		return run(notices).finally(() => __test.setPiUI(null));
	}
	const warning = (utilization, surpassedThreshold = 0.75) => ({
		type: "rate_limit_event",
		rate_limit_info: { status: "allowed_warning", utilization, surpassedThreshold, rateLimitType: "five_hour" },
	});

	// resetsAt is Unix seconds (recorded streams carry values like 1785379800); reading it
	// as milliseconds put every reset in January 1970.
	it("reads resetsAt as Unix seconds", () => withNotifications(async (notices) => {
		await consume(makeCtx(), [{ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1786141800, rateLimitType: "five_hour" } }]);
		assert.deepStrictEqual(notices, [`Claude rate limited (five_hour) — resets at ${new Date(1786141800 * 1000).toLocaleTimeString()}`]);
	}));

	it("reports utilization as a percentage and only re-warns on a new 5% step", () => withNotifications(async (notices) => {
		await consume(makeCtx(), [warning(0.8), warning(0.81), warning(0.84), warning(0.86)]);
		assert.deepStrictEqual(notices, [
			"Claude rate limit warning: 80% used (five_hour)",
			"Claude rate limit warning: 86% used (five_hour)",
		]);
	}));

	it("re-arms the warning once the window resets", () => withNotifications(async (notices) => {
		const allowed = { type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour" } };
		await consume(makeCtx(), [warning(0.8), allowed, warning(0.8)]);
		assert.strictEqual(notices.length, 2);
	}));
});

describe("error results", () => {
	it("marks the turn errored and finalizes with an error event", async () => {
		const c = makeCtx();
		await consume(c, [errorResult]);

		assert.strictEqual(c.turnOutput.stopReason, "error");
		assert.strictEqual(c.turnOutput.errorMessage, errorResult.result);

		const stream = c.currentPiStream;
		__test.finalizeCurrentStream(c, c.turnOutput.stopReason);
		const terminal = stream.events.at(-2);
		assert.strictEqual(terminal.type, "error");
		assert.strictEqual(terminal.reason, "error");
		assert.strictEqual(terminal.error.errorMessage, errorResult.result);
	});

	it("does not re-emit text the synthetic assistant message already delivered", async () => {
		const c = makeCtx();
		await consume(c, [
			{ type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text: errorResult.result }] } },
			errorResult,
		]);

		const texts = c.turnOutput.content.filter((b) => b.type === "text");
		assert.deepStrictEqual(texts.map((b) => b.text), [errorResult.result]);
	});

	it("still streams and finalizes a successful result normally", async () => {
		const c = makeCtx();
		await consume(c, [{ type: "result", subtype: "success", is_error: false, result: "done" }]);

		assert.strictEqual(c.turnOutput.stopReason, "stop");
		assert.strictEqual(c.turnOutput.errorMessage, undefined);
		assert.deepStrictEqual(c.turnOutput.content, [{ type: "text", text: "done" }]);

		const stream = c.currentPiStream;
		__test.finalizeCurrentStream(c, c.turnOutput.stopReason);
		assert.strictEqual(stream.events.at(-2).type, "done");
	});

	// A turn that ended on a tool call has already closed its pi stream, and the
	// guard that suppresses content events for a closed stream used to swallow the
	// result message with it — so a 429 mid-tool set no stopReason, no
	// errorMessage, and logged nothing at all.
	it("records a failure that arrives after the turn ended on a tool call", async () => {
		const c = makeCtx();
		c.currentPiStream = null; // what the tool boundary leaves behind

		await consume(c, [errorResult]);

		assert.strictEqual(c.turnOutput.stopReason, "error");
		assert.strictEqual(c.turnOutput.errorMessage, errorResult.result);
	});

	it("reports the dedicated error subtypes", async () => {
		const c = makeCtx();
		await consume(c, [{ type: "result", subtype: "error_max_turns", is_error: true, errors: ["hit the cap"] }]);

		assert.strictEqual(c.turnOutput.stopReason, "error");
		assert.strictEqual(c.turnOutput.errorMessage, "hit the cap");
	});
});
