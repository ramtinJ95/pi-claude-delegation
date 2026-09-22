import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt, buildSystemPromptSections } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
import { nonSystemMessages, toBridgeContext } from "../src/transcript.js";

const system = (fields) => ({ role: "system", content: "", timestamp: 0, ...fields });
const user = { role: "user", content: "go", timestamp: 1 };
const tool = (name) => ({ name, description: name, parameters: { type: "object", properties: {} } });

describe("Pi transcript boundary", () => {
	it("preserves legacy contexts by identity and does not mutate transcripts", () => {
		const legacy = { systemPrompt: "instructions", tools: [tool("read")], messages: [user] };
		assert.equal(toBridgeContext(legacy), legacy);
		const transcript = { messages: [system({ content: "instructions", toolsAdded: legacy.tools }), user] };
		const before = structuredClone(transcript);
		assert.deepEqual(toBridgeContext(transcript), legacy);
		assert.deepEqual(transcript, before);
	});

	it("replays content and section updates rather than sending updates as conversation", () => {
		const context = toBridgeContext({ messages: [
			system({ content: [{ type: "text", text: "A" }, { type: "text", text: "B" }], sections: { rules: "old", cwd: "/repo" } }),
			user,
			system({ content: "extra", sections: { rules: "new", cwd: null } }),
		] });
		assert.equal(context.systemPrompt, "A\nB\n\nextra\n\nnew");
		assert.deepEqual(context.messages, [user]);
	});

	it("restores canonical section order after removal/re-addition", () => {
		const context = toBridgeContext({ messages: [
			system({ sections: { preamble: "P", rules: "R", skills: "old", cwd: "C" } }),
			system({ sections: { skills: null } }),
			system({ sections: { skills: "S" } }), user,
		] });
		assert.equal(context.systemPrompt, "P\n\nR\n\nS\n\nC");
	});

	it("matches the installed Pi builder after skills first appear mid-run", () => {
		const options = { cwd: "/repo", selectedTools: [], contextFiles: [], skills: [{
			name: "test", description: "Testing", filePath: "/repo/SKILL.md", baseDir: "/repo", source: "test",
		}] };
		const before = buildSystemPromptSections(options);
		const after = buildSystemPromptSections({ ...options, selectedTools: ["read"] });
		assert.ok(after.skills && !before.skills, "fixture must introduce a new skills section");
		const context = toBridgeContext({ messages: [system({ sections: before }), system({ sections: after }), user] });
		assert.equal(context.systemPrompt, buildSystemPrompt({ ...options, selectedTools: ["read"] }));
	});

	it("keeps unknown sections in their canonical placement and extension sections at the tail", () => {
		const sections = { preamble: "P", docs: "D", environment: "E", cwd: "C", extension: "X" };
		assert.equal(toBridgeContext({ messages: [system({ sections }), user] }).systemPrompt, "P\n\nD\n\nE\n\nC\n\nX");
	});

	it("replays tool removals, replacement definitions, and additions in order", () => {
		const read = tool("read"), grep = tool("grep"), updated = { ...read, description: "updated" };
		const context = toBridgeContext({ messages: [
			system({ toolsAdded: [read, grep] }),
			system({ toolsRemoved: [{ name: "read" }] }),
			system({ toolsAdded: [updated] }), user,
		] });
		assert.deepEqual(context.tools, [grep, updated]);
	});

	it("does not resurrect stale legacy instructions or tools after transcript deletion", () => {
		const context = toBridgeContext({ systemPrompt: "stale", tools: [tool("write")], messages: [
			system({ sections: { rules: "removed" }, toolsAdded: [tool("read")] }),
			system({ sections: { rules: null }, toolsRemoved: [{ name: "read" }] }), user,
		] });
		assert.equal(context.systemPrompt, undefined);
		assert.equal(context.tools, undefined);
	});

	it("retains tool results and user objects in history while dropping every system message", () => {
		const result = { role: "toolResult", toolCallId: "c", content: [] };
		assert.deepEqual(nonSystemMessages([system({}), user, system({}), result]), [user, result]);
		assert.equal(nonSystemMessages([system({}), user])[0], user);
	});
});
