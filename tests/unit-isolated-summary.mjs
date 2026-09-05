import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createIsolatedSummaryStreamFn } from "../src/isolated-summary.js";

const model = { id: "test", api: "test", provider: "test" };
const context = { messages: [{ role: "user", content: "summarize" }], systemPrompt: "summary instructions" };
const assistant = (text) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });
const success = (result = "") => ({ type: "result", subtype: "success", is_error: false, result });

async function summarize(messages, overrides = {}, signal) {
	let closes = 0;
	const streamFn = createIsolatedSummaryStreamFn({
		createStream: createAssistantMessageEventStream,
		resolveOptions: () => ({ tools: [], persistSession: false }),
		queryFactory: () => ({
			async *[Symbol.asyncIterator]() { yield* messages; },
			async interrupt() {},
			close() { closes++; },
		}),
		...overrides,
	});
	const events = [];
	for await (const event of streamFn(model, context, { signal })) events.push(event);
	return { events, closes, terminal: events.at(-1) };
}

describe("isolated summary lifecycle", () => {
	it("preserves structured setup errors instead of displaying [object Object]", async () => {
		const { terminal } = await summarize([], { resolveOptions: () => { throw { message: "invalid settings" }; } });
		assert.equal(terminal.error.errorMessage, "invalid settings");
	});

	it("rejects assistant text followed by EOF rather than replacing history with a partial summary", async () => {
		const { terminal, closes } = await summarize([assistant("partial summary")]);
		assert.equal(terminal.type, "error");
		assert.match(terminal.error.errorMessage, /ended without a result/);
		assert.deepEqual(terminal.error.content, []);
		assert.equal(closes, 1);
	});

	it("requires a result even when no text arrived", async () => {
		const { terminal } = await summarize([]);
		assert.match(terminal.error.errorMessage, /ended without a result/);
	});

	it("uses assistant text only after an authoritative success", async () => {
		const { terminal } = await summarize([assistant("complete summary"), success()]);
		assert.equal(terminal.type, "done");
		assert.equal(terminal.message.content[0].text, "complete summary");
	});

	it("keeps summaries independent of delegation output caps", async () => {
		const text = "long summary ".repeat(4000);
		const { terminal } = await summarize([assistant("earlier text"), success(text)]);
		assert.equal(terminal.message.content[0].text, text);
	});

	it("never accepts an error result as a summary", async () => {
		const { terminal } = await summarize([assistant("partial"), { ...success("capacity exhausted"), is_error: true }]);
		assert.equal(terminal.type, "error");
		assert.match(terminal.error.errorMessage, /capacity exhausted/);
	});

	it("rejects empty successful summaries", async () => {
		const { terminal } = await summarize([success("  ")]);
		assert.match(terminal.error.errorMessage, /empty text/);
	});

	it("does not resolve settings or create a subprocess when already cancelled", async () => {
		const controller = new AbortController();
		controller.abort();
		const unreachable = () => { assert.fail("cancelled summary launched work"); };
		const { terminal } = await summarize([], { queryFactory: unreachable, resolveOptions: unreachable }, controller.signal);
		assert.equal(terminal.reason, "aborted");
	});

	it("keeps cancellation distinct from iterator failure and closes the query", async () => {
		const controller = new AbortController();
		let closes = 0;
		const { terminal } = await summarize([], { queryFactory: () => ({
			async *[Symbol.asyncIterator]() {
				yield assistant("partial");
				controller.abort();
				throw new Error("transport closed by abort");
			},
			async interrupt() {},
			close() { closes++; },
		}) }, controller.signal);
		assert.equal(terminal.reason, "aborted");
		assert.ok(closes > 0);
	});
});
