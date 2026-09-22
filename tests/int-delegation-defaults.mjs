// Exercise the registered tool without requiring a second provider/account to
// decide to call it. The actual Claude query still runs through the full wrapper.
import "./lib/setup.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import activate from "../src/index.js";

test("registered DelegateToClaude defaults launch Opus 5.5 with high effort", { timeout: 120_000 }, async () => {
	const originalCwd = process.cwd();
	const cwd = mkdtempSync(join(tmpdir(), "delegation-defaults-"));
	const tools = new Map();
	try {
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(join(cwd, ".pi", "claude-delegation.json"), JSON.stringify({ delegation: { enabled: true, name: "DelegateToClaude" } }));
		process.chdir(cwd);
		activate({
			on() {}, registerProvider() {}, registerCommand() {}, registerShortcut() {}, registerEntryRenderer() {},
			registerTool: (tool) => tools.set(tool.name, tool),
		});
		process.chdir(originalCwd);
		const tool = tools.get("DelegateToClaude");
		assert.ok(tool);
		const result = await tool.execute("default-model-probe", {
			prompt: "What is 2+2? Reply with just the number.", mode: "none", isolated: true,
		}, AbortSignal.timeout(115_000), undefined, {
			cwd, model: { baseUrl: "test-other-provider" }, getSystemPrompt: () => "",
		});
		assert.ok(!result.details.error, JSON.stringify(result.content));
		assert.equal(result.details.requestedModel, "claude-opus-5-5");
		assert.equal(result.details.thinking, "high");
		assert.match(result.details.snapshot.model, /^claude-opus-5-5/);
		assert.match(result.content[0].text, /4/);
	} finally {
		process.chdir(originalCwd);
		rmSync(cwd, { recursive: true, force: true });
	}
});
