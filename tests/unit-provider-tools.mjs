/**
 * The pi tools the provider serves to Claude Code ride in the cached prefix of
 * every request, so a tool the model cannot use is paid for on every turn.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { __test } = await import("../src/index.js");

const tool = (name) => ({ name, description: `${name} tool`, parameters: { type: "object", properties: {} } });

describe("provider MCP tool list", () => {
	it("leaves out both delegation tools, which refuse to run under this provider", () => {
		const context = { messages: [], tools: ["read", "bash", "DelegateToClaude", "SpawnClaudeAgent", "edit"].map(tool) };
		assert.deepEqual(__test.resolveMcpTools(context).mcpTools.map((t) => t.name), ["read", "bash", "edit"]);
	});
});
