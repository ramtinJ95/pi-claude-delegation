// Exercise Pi's actual /bug summarizer through the provider, without invoking
// the report uploader or exposing a user's transcript. No capture hook fires.
import "./lib/setup.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { getModels } from "@earendil-works/pi-ai/compat";
import { generateBugReportSummary } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/bug-report.js";
import { __test } from "../src/index.js";

test("Pi /bug summaries use an isolated query and preserve the provider session", { timeout: 120_000 }, async () => {
	const model = {
		...getModels("anthropic").find((model) => model.id === "claude-haiku-4-5"),
		provider: "claude-delegation", api: "claude-delegation", baseUrl: "claude-delegation",
	};
	const parent = { sessionId: "untouched-parent", cursor: 42, cwd: process.cwd() };
	__test.setSharedSession(parent);
	try {
		const summary = await generateBugReportSummary({
			model,
			messages: [{ role: "user", content: "The test widget failed to render. This is a synthetic test fixture.", timestamp: 0 }],
			signal: AbortSignal.timeout(115_000),
			streamFn: __test.streamClaudeAgentSdk,
		});
		assert.ok(summary.trim(), "Pi received an empty bug summary");
		assert.deepEqual(__test.getSharedSession(), parent);
	} finally {
		__test.resetSharedSession();
	}
});
