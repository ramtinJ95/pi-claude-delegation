#!/usr/bin/env node

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { formatRuntimeVersions, installedRuntimeVersions } from "./lib/runtime-versions.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

describe("Pi 0.86.1 minimum / 0.87.1 development baseline", () => {
	it("pins matching Pi development packages and minimum peer versions", () => {
		const versions = installedRuntimeVersions();
		console.log(`    runtime: ${formatRuntimeVersions(versions)}`);
		assert.deepEqual(
			[versions.piAi, versions.piCodingAgent, versions.piTui],
			["0.87.1", "0.87.1", "0.87.1"],
		);
		for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]) {
			assert.equal(packageJson.devDependencies[name], "0.87.1");
			assert.equal(packageJson.peerDependencies[name], ">=0.86.1");
		}
		assert.equal(packageJson.engines.node, ">=22.19.0");
	});

	it("loads the extension and registers its provider in the local Pi CLI", () => {
		const scratch = mkdtempSync(join(tmpdir(), "pi-claude-delegation-load-"));
		try {
			const pi = join(ROOT, "node_modules/.bin/pi");
			const extension = join(ROOT, "src/index.ts");
			const result = spawnSync(pi, [
				"--offline",
				"--no-extensions",
				"--no-context-files",
				"-e",
				extension,
				"--list-models",
				"claude-delegation",
			], {
				cwd: scratch,
				env: { ...process.env, PI_CODING_AGENT_DIR: join(scratch, "agent") },
				encoding: "utf8",
				timeout: 30_000,
			});

			assert.equal(
				result.status,
				0,
				`Pi failed to load the extension${result.error ? `: ${result.error.stack ?? result.error.message}` : ""}`
					+ `\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
			);
			assert.match(result.stdout, /^claude-delegation\s+claude-/m);
			assert.match(result.stdout, /claude-delegation\s+claude-haiku-4-5/);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});
});
