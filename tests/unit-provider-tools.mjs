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

describe("delegation tool exposure", () => {
	it("registers both delegation tools model-only, so codemode scripts cannot reach them", async () => {
		const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { default: activate } = await import("../src/index.js");
		const originalCwd = process.cwd();
		const cwd = mkdtempSync(join(tmpdir(), "delegation-exposure-"));
		const tools = new Map();
		try {
			mkdirSync(join(cwd, ".pi"));
			writeFileSync(join(cwd, ".pi", "claude-delegation.json"), JSON.stringify({ delegation: { enabled: true } }));
			process.chdir(cwd);
			activate({
				on() {}, registerProvider() {}, registerCommand() {}, registerShortcut() {}, registerEntryRenderer() {},
				registerTool: (registered) => tools.set(registered.name, registered),
			});
		} finally {
			process.chdir(originalCwd);
			rmSync(cwd, { recursive: true, force: true });
		}
		assert.deepEqual([...tools.keys()].sort(), ["DelegateToClaude", "SpawnClaudeAgent"]);
		for (const registered of tools.values()) assert.equal(registered.exposure, "model-only", registered.name);
	});
});
