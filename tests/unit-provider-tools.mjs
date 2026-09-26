/**
 * What the provider path hands Claude Code on every request: the pi tools it
 * serves over MCP and the memory files it keeps CC from loading on top of Pi's own
 * projection. Both ride in the cached prefix of every request, so anything served
 * here that the model cannot use is paid for on every turn.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { __test } = await import("../src/index.js");

const tool = (name) => ({ name, description: `${name} tool`, parameters: { type: "object", properties: {} } });

describe("provider MCP tool list", () => {
	it("leaves out both delegation tools, which refuse to run under this provider", () => {
		const context = { messages: [], tools: ["read", "bash", "DelegateToClaude", "SpawnClaudeAgent", "edit"].map(tool) };
		const { mcpTools, customToolNameToPi } = __test.resolveMcpTools(context, __test.providerExcludedToolNames());
		assert.deepEqual(mcpTools.map((t) => t.name), ["read", "bash", "edit"]);
		assert.equal(customToolNameToPi.has("mcp__custom-tools__SpawnClaudeAgent"), false);
		assert.equal(customToolNameToPi.has("mcp__custom-tools__DelegateToClaude"), false);
	});

	it("keeps pi's tool order, so the served prefix is stable across turns", () => {
		const names = ["write", "read", "bash"];
		const { mcpTools } = __test.resolveMcpTools({ messages: [], tools: names.map(tool) }, __test.providerExcludedToolNames());
		assert.deepEqual(mcpTools.map((t) => t.name), names);
	});
});

describe("provider memory excludes", () => {
	it("excludes AGENTS.md on top of the CLAUDE.md and rules patterns", () => {
		assert.deepEqual(__test.PROVIDER_CLAUDE_MD_EXCLUDES, ["**/CLAUDE.md", "**/.claude/rules/**", "**/AGENTS.md"]);
	});
});
