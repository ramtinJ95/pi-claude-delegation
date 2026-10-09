/**
 * Prompts carrying extension sections, built and replayed with Pi's own code.
 *
 * Pi 1.x's MCP extension adds an `mcp_servers` section to every prompt once
 * servers exist, and codemode-only hides `read` while keeping skills. Both reach
 * the provider through prompt capture: the section order replay produces must
 * still find the capture, the sections must reach Claude, and the skills must
 * survive a hidden reader.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import { buildSystemPrompt, buildSystemPromptSections, diffSystemPromptSections } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
import activate, { __test } from "../src/index.js";
import { PromptCaptures, projectPromptCapture } from "../src/prompt-capture.js";
import { alternatePromptKeys, toBridgeContext } from "../src/transcript.js";

function handlers() {
	const handlers = new Map();
	activate({
		on: (event, handler) => handlers.set(event, handler),
		registerProvider() {}, registerTool() {}, registerCommand() {},
		registerShortcut() {}, registerEntryRenderer() {},
	});
	return handlers;
}

const user = (text) => ({ role: "user", content: text, timestamp: 0 });

/** Two prompts as Pi's agent session produces them: the first declares every
 *  section, the second appends a patch from diffing against the replay. */
function transcript(first, second) {
	const head = { role: "system", content: "", sections: buildSystemPromptSections(first), timestamp: 0 };
	const patch = diffSystemPromptSections(getCurrentSystemMessage([head]).sections, buildSystemPromptSections(second));
	return [head, user("one"), { role: "system", content: "", sections: patch, timestamp: 1 }, user("two")];
}

const base = (marker, sections) => ({ cwd: `/repo/${marker}`, selectedTools: ["read", "bash"], sections });

describe("prompts with extension sections", () => {
	it("finds the capture when a new section renders ahead of an older one", () => {
		const events = handlers();
		// Every prompt starts from empty options, so a handler that runs first adds
		// its section first: mcp_servers precedes extension_rules once it exists.
		const first = base("order", { extension_rules: "Extension rules." });
		const second = base("order", { mcp_servers: "- mcp__docs (codemode)", extension_rules: "Extension rules." });
		const prompt = buildSystemPrompt(second);
		events.get("before_agent_start")({ systemPrompt: prompt, systemPromptOptions: second });

		const messages = transcript(first, second);
		const replayed = toBridgeContext({ messages }).systemPrompt;
		assert.notEqual(replayed, prompt, "precondition: replay renders the sections in another order");
		assert.ok(replayed.startsWith(buildSystemPrompt(first)),
			"precondition: the replay embeds the first prompt, so a derived match would forward Pi's prompt verbatim");

		const capture = __test.promptCaptures.resolveOrDerive(replayed, alternatePromptKeys({ messages }));
		assert.equal(capture.assembledPrompt, prompt);
		const projected = projectPromptCapture(capture, { skillReadTool: "none" });
		assert.ok(!projected.includes("You are an expert coding assistant"), "Pi's harness prompt leaked into Claude's");
	});

	it("offers no alternate key when replay already renders Pi's order and it is sorted", () => {
		const options = base("sorted", { extension_rules: "Extension rules.", mcp_servers: "- mcp__docs (codemode)" });
		assert.deepEqual(alternatePromptKeys({ messages: transcript(options, options) }), []);
	});

	it("still resolves the exact key first when replay and Pi agree on an unsorted order", () => {
		const events = handlers();
		const options = base("agree", { mcp_servers: "- mcp__docs (codemode)", extension_rules: "Extension rules." });
		const prompt = buildSystemPrompt(options);
		events.get("before_agent_start")({ systemPrompt: prompt, systemPromptOptions: options });
		const messages = transcript(options, options);
		assert.equal(toBridgeContext({ messages }).systemPrompt, prompt);
		const capture = __test.promptCaptures.resolveOrDerive(prompt, alternatePromptKeys({ messages }));
		assert.equal(capture.assembledPrompt, prompt);
	});

	it("forwards extension sections to Claude, and not Pi's own", () => {
		const events = handlers();
		const options = { ...base("forward", { mcp_servers: "- mcp__docs (codemode): Product docs" }), appendSystemPrompt: "Appended." };
		const prompt = buildSystemPrompt(options);
		events.get("before_agent_start")({ systemPrompt: prompt, systemPromptOptions: options });
		const projected = projectPromptCapture(__test.promptCaptures.resolveOrDerive(prompt), { skillReadTool: "none" });
		assert.match(projected, /<mcp_servers>\n- mcp__docs \(codemode\): Product docs\n<\/mcp_servers>$/);
		assert.match(projected, /Appended\./);
		assert.ok(!projected.includes("<cwd>"), "Pi's built-in sections must not be forwarded");
	});

	it("keeps skills when codemode-only hides the read tool", () => {
		const events = handlers();
		const skill = { name: "deploy", description: "Deploy the app", filePath: "/skills/deploy/SKILL.md", baseDir: "/skills/deploy", disableModelInvocation: false };
		const options = { cwd: "/repo/codemode", selectedTools: ["read", "bash", "codemode"], hiddenTools: ["read", "bash"], skills: [skill] };
		const prompt = buildSystemPrompt(options);
		assert.match(prompt, /<available_skills>/, "precondition: Pi keeps the skills");
		events.get("before_agent_start")({ systemPrompt: prompt, systemPromptOptions: options });
		const capture = __test.promptCaptures.resolveOrDerive(prompt);

		const served = [{ name: "codemode", description: "", parameters: { type: "object" } }];
		const readTool = __test.providerSkillReadTool(served, capture);
		assert.equal(readTool, "indirect");
		const projected = projectPromptCapture(capture, { skillReadTool: readTool });
		assert.match(projected, /Load a skill's file when the task matches its description/);
		assert.match(projected, /<location>\/skills\/deploy\/SKILL\.md<\/location>/);

		assert.equal(__test.providerSkillReadTool([{ name: "read" }], capture), "mcp");
		assert.equal(__test.providerSkillReadTool(served, { ...capture, hiddenTools: [] }), "none");
	});

	it("keeps a prompt's own identity when it was first seen as another prompt's alias", () => {
		const events = handlers();
		const reversed = base("alias", { z_rules: "Z rules.", a_rules: "A rules." });
		const sorted = base("alias", { a_rules: "A rules.", z_rules: "Z rules." });
		const reversedPrompt = buildSystemPrompt(reversed);
		const sortedPrompt = buildSystemPrompt(sorted);
		events.get("before_agent_start")({ systemPrompt: reversedPrompt, systemPromptOptions: reversed });
		assert.equal(__test.promptCaptures.resolve(sortedPrompt)?.assembledPrompt, reversedPrompt, "precondition: aliased");

		events.get("before_agent_start")({ systemPrompt: sortedPrompt, systemPromptOptions: sorted });
		assert.equal(__test.promptCaptures.resolve(sortedPrompt).assembledPrompt, sortedPrompt);
		assert.equal(__test.promptCaptures.resolve(reversedPrompt).assembledPrompt, reversedPrompt);
		// Inheritance matches on the verbatim prompt, so a wrapper must still find it.
		const wrapped = __test.promptCaptures.resolveOrDerive(`${sortedPrompt}\n\nWrapper note.`);
		assert.equal(wrapped.inherited[0].parent.assembledPrompt, sortedPrompt);
	});

	it("forwards overrides of Pi's own sections in place of what they replace", () => {
		const events = handlers();
		const options = { ...base("override", { addendum: "NEW addendum.", rules: "POLICY rules." }), appendSystemPrompt: "OLD append." };
		const prompt = buildSystemPrompt(options);
		events.get("before_agent_start")({ systemPrompt: prompt, systemPromptOptions: options });
		const projected = projectPromptCapture(__test.promptCaptures.resolveOrDerive(prompt), { skillReadTool: "none" });
		assert.match(projected, /NEW addendum\./);
		assert.match(projected, /<rules>\nPOLICY rules\.\n<\/rules>/);
		assert.ok(!projected.includes("OLD append."), "the superseded append was forwarded");
	});

	const skill = { name: "deploy", description: "Deploy the app", filePath: "/skills/deploy/SKILL.md", baseDir: "/skills/deploy", disableModelInvocation: false };
	const codemode = [{ name: "codemode", description: "", parameters: { type: "object" } }];

	it("keeps skills when bash is the only reader, declared or hidden", () => {
		const events = handlers();
		const hidden = { cwd: "/repo/bash-hidden", selectedTools: ["bash", "codemode"], hiddenTools: ["bash"], skills: [skill] };
		const prompt = buildSystemPrompt(hidden);
		assert.match(prompt, /<available_skills>/, "precondition: Pi keeps the skills");
		events.get("before_agent_start")({ systemPrompt: prompt, systemPromptOptions: hidden });
		const capture = __test.promptCaptures.resolveOrDerive(prompt);
		assert.equal(__test.providerSkillReadTool(codemode, capture), "indirect");
		assert.match(projectPromptCapture(capture, { skillReadTool: "indirect" }), /\/skills\/deploy\/SKILL\.md/);

		const bash = [{ name: "bash", description: "", parameters: { type: "object" } }];
		assert.equal(__test.providerSkillReadTool(bash, capture), "mcp-bash");
		assert.match(projectPromptCapture(capture, { skillReadTool: "mcp-bash" }), /Use bash \(mcp__custom-tools__bash\) to load a skill's file/);
	});

	it("keeps skills for a wrapper around a prompt whose reader is hidden", () => {
		const events = handlers();
		const options = { cwd: "/repo/wrapped-hidden", selectedTools: ["read", "codemode"], hiddenTools: ["read"], skills: [skill] };
		const prompt = buildSystemPrompt(options);
		events.get("before_agent_start")({ systemPrompt: prompt, systemPromptOptions: options });
		const derived = __test.promptCaptures.resolveOrDerive(`Wrapper preface.\n\n${prompt}`);
		const readTool = __test.providerSkillReadTool(codemode, derived);
		assert.equal(readTool, "indirect");
		assert.match(projectPromptCapture(derived, { skillReadTool: readTool }), /\/skills\/deploy\/SKILL\.md/);
	});

	for (const [label, overrides] of [
		["rules under a custom prompt", { customPrompt: "CUSTOM preamble.", sections: { rules: "POLICY" } }],
		["project_context without context files", { sections: { project_context: "POLICY" } }],
		["addendum without append text", { sections: { addendum: "POLICY" } }],
	]) {
		it(`finds the capture through replay when an override supplies ${label}`, () => {
			const events = handlers();
			const options = { ...base(`absent-${label.split(" ")[0]}`, undefined), ...overrides };
			const prompt = buildSystemPrompt(options);
			events.get("before_agent_start")({ systemPrompt: prompt, systemPromptOptions: options });
			const messages = transcript(options, options);
			const replayed = toBridgeContext({ messages }).systemPrompt;
			const capture = __test.promptCaptures.resolveOrDerive(replayed, alternatePromptKeys({ messages }));
			assert.equal(capture.assembledPrompt, prompt);
			assert.match(projectPromptCapture(capture, { skillReadTool: "none" }), /POLICY/);
		});
	}

	it("does not let a parent's skills override hide a child's own skills", () => {
		const events = handlers();
		const parentOptions = { cwd: "/repo/skills-override", selectedTools: ["read"], skills: [skill], sections: { skills: "PARENT-OVERRIDE" } };
		const parentPrompt = buildSystemPrompt(parentOptions);
		events.get("before_agent_start")({ systemPrompt: parentPrompt, systemPromptOptions: parentOptions });
		const childOptions = { cwd: "/repo/skills-override", selectedTools: ["read"], skills: [skill], customPrompt: `CHILD\n\n${parentPrompt}` };
		const childPrompt = buildSystemPrompt(childOptions);
		assert.match(childPrompt, /<location>\/skills\/deploy\/SKILL\.md/, "precondition: Pi shows the child its skill");
		events.get("before_agent_start")({ systemPrompt: childPrompt, systemPromptOptions: childOptions });
		const projected = projectPromptCapture(__test.promptCaptures.resolveOrDerive(childPrompt), { skillReadTool: "mcp" });
		assert.match(projected, /\/skills\/deploy\/SKILL\.md/);
		assert.match(projected, /PARENT-OVERRIDE/);
	});

	it("revives a capture by an alias whose key was evicted", () => {
		const captures = new PromptCaptures(3);
		const input = { contextFiles: [], skills: [] };
		captures.record("PARENT-RAW", input, ["PARENT-SORTED"]);
		captures.record("child", { ...input, custom: "before PARENT-RAW after" });
		captures.record("unrelated-1", input);
		captures.record("unrelated-2", input);
		assert.equal(captures.resolve("PARENT-SORTED"), undefined, "precondition: the alias key was evicted");
		assert.equal(captures.resolveOrDerive("PARENT-SORTED").assembledPrompt, "PARENT-RAW");
	});
});
