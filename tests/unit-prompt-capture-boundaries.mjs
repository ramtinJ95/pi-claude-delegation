import { describe, it } from "node:test";
import assert from "node:assert/strict";
import activate, { __test } from "../src/index.js";
import { projectPromptCapture } from "../src/prompt-capture.js";

function handlers() {
	const handlers = new Map();
	activate({
		on: (event, handler) => handlers.set(event, handler),
		registerProvider() {}, registerTool() {}, registerCommand() {},
		registerShortcut() {}, registerEntryRenderer() {},
	});
	return handlers;
}

describe("Pi prompt capture boundaries", () => {
	it("captures widened and mid-run prompts with the run's portable instructions", () => {
		const events = handlers();
		const options = { contextFiles: [{ path: "/repo/AGENTS.md", content: "project rules" }], skills: [], appendSystemPrompt: "extra rules" };
		events.get("before_agent_start")({ systemPrompt: "initial capture key", systemPromptOptions: options });
		for (const [event, prompt] of [["agent_start", "widened capture key"], ["turn_start", "rerendered capture key"]]) {
			assert.equal(__test.promptCaptures.resolve(prompt), undefined);
			events.get(event)({}, { getSystemPrompt: () => prompt });
			const capture = __test.promptCaptures.resolveOrDerive(prompt);
			assert.deepEqual(capture.contextFiles, options.contextFiles);
			const projected = projectPromptCapture(capture, { skillReadTool: "mcp" });
			assert.match(projected, /project rules/);
			assert.match(projected, /extra rules/);
			assert.ok(!projected.includes(prompt), "the Pi harness key must not be appended verbatim");
		}
	});

	it("reuses an unchanged key without growing the capture registry", () => {
		const events = handlers();
		events.get("before_agent_start")({ systemPrompt: "stable capture key", systemPromptOptions: {} });
		const before = __test.promptCaptures.size;
		const ctx = { getSystemPrompt: () => "stable capture key" };
		events.get("agent_start")({}, ctx);
		events.get("turn_start")({}, ctx);
		assert.equal(__test.promptCaptures.size, before);
	});

	it("refreshes portable inputs if later before_agent_start handlers mutate the options", () => {
		const events = handlers();
		const options = { appendSystemPrompt: "before" };
		events.get("before_agent_start")({ systemPrompt: "mutation initial key", systemPromptOptions: options });
		options.appendSystemPrompt = "after";
		events.get("agent_start")({}, { getSystemPrompt: () => "mutation final key" });
		assert.equal(__test.promptCaptures.resolve("mutation final key").append, "after");
	});

	it("preserves extra instructions in a forced wrapper rather than re-keying stale inputs", () => {
		const events = handlers();
		const options = { appendSystemPrompt: "portable parent instructions" };
		const parent = "forced wrapper parent capture key";
		events.get("before_agent_start")({ systemPrompt: parent, systemPromptOptions: options });
		options.forceSystemPrompt = `${parent}\nDo not publish anything.`;
		const ctx = { getSystemPrompt: () => options.forceSystemPrompt };
		events.get("agent_start")({}, ctx);
		events.get("turn_start")({}, ctx);
		assert.equal(__test.promptCaptures.resolve(options.forceSystemPrompt), undefined);
		const projected = projectPromptCapture(__test.promptCaptures.resolveOrDerive(options.forceSystemPrompt), { skillReadTool: "mcp" });
		assert.match(projected, /portable parent instructions/);
		assert.match(projected, /Do not publish anything/);
		assert.ok(!projected.includes(parent));
	});

	it("does not bless an unaccountable forced replacement as the old portable instructions", () => {
		const events = handlers();
		const options = { forceSystemPrompt: "unaccountable forced replacement" };
		events.get("before_agent_start")({ systemPrompt: options.forceSystemPrompt, systemPromptOptions: options });
		events.get("agent_start")({}, { getSystemPrompt: () => options.forceSystemPrompt });
		assert.throws(() => __test.promptCaptures.resolveOrDerive(options.forceSystemPrompt), /no capture/);
	});
});
