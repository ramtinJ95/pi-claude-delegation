import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BackgroundJobManager } from "../src/background-jobs.js";
import { CheckoutWriteLease } from "../src/checkout-write-lease.js";
import { registerSpawnClaudeAgent } from "../src/spawn-claude-agent.js";


/** Minimal Pi extension API double: records registrations, replays events. */
function fakePi() {
	const tools = new Map();
	const handlers = new Map();
	return {
		tools,
		handlers,
		registerTool(tool) {
			tools.set(tool.name, tool);
		},
		on(type, handler) {
			const list = handlers.get(type) ?? [];
			list.push(handler);
			handlers.set(type, list);
		},
		// Pi 0.84.2's extension runner awaits every handler; mirror that.
		async emit(type, event) {
			const results = [];
			for (const handler of handlers.get(type) ?? []) results.push(await handler(event, {}));
			return results;
		},
	};
}

const DIFF_ARTIFACT = {
	cwd: "/repo",
	capturedAt: 0,
	source: "working tree at launch vs HEAD abcdef123456 (staged + unstaged changes)",
	headRef: "abcdef123456",
	statusText: " M src/a.ts",
	statusTruncated: false,
	diffText: "+changed line",
	diffTruncated: false,
};

function runResult() {
	return {
		responseText: "done",
		stopReason: "stop",
		permissionDenials: [],
		snapshot: { status: "succeeded", tools: [], permissionDenials: [], diagnostics: [], timeline: [], responseText: "done", thinkingText: "" },
		messageCount: 1,
	};
}

/** A foreground result shaped like the shared foreground implementation returns. */
function foregroundResult(extra = {}) {
	return {
		content: [{ type: "text", text: "foreground answer" }],
		details: { prompt: "task", origin: "spawn-foreground", ...extra },
	};
}

/** Wire the seam with recording fakes; every effect is injectable and observed. */
function wire(overrides = {}) {
	const pi = fakePi();
	const jobs = new BackgroundJobManager({ idPrefix: "t", sleep: () => Promise.resolve() });
	const captures = [];
	const runs = [];
	const foregroundRuns = [];
	const writeLease = new CheckoutWriteLease();
	const deps = {
		enabled: true,
		allowFull: true,
		writeLease,
		jobs,
		captureDiff: async (input) => {
			captures.push(input);
			return { ...DIFF_ARTIFACT, cwd: input.cwd, capturedAt: input.capturedAt };
		},
		runJob: (input) => {
			runs.push(input);
			return new Promise(() => {}); // background work outlives the tool call
		},
		runForeground: async (input) => {
			foregroundRuns.push(input);
			return foregroundResult();
		},
		cwd: () => "/repo",
		now: () => 42,
		...overrides,
	};
	registerSpawnClaudeAgent(pi, deps);
	return { pi, jobs, captures, runs, foregroundRuns, writeLease, deps };
}

function execute(pi, params, { signal, ctx } = {}) {
	const tool = pi.tools.get("SpawnClaudeAgent");
	assert.ok(tool, "SpawnClaudeAgent must be registered");
	return tool.execute(
		"call-1",
		params,
		signal ?? new AbortController().signal,
		undefined,
		ctx ?? { model: { baseUrl: "anthropic" } },
	);
}

describe("SpawnClaudeAgent adapter wiring", () => {
	it("registers nothing when the DelegateToClaude opt-in is off", () => {
		const pi = fakePi();
		registerSpawnClaudeAgent(pi, {
			enabled: false,
			jobs: new BackgroundJobManager({ idPrefix: "t" }),
			captureDiff: async () => { throw new Error("unreachable"); },
			runJob: async () => runResult(),
		});
		assert.equal(pi.tools.size, 0);
		assert.equal(pi.handlers.size, 0);
	});

	it("returns the job ID before the injected background executor settles", async () => {
		const { pi, jobs, captures, runs } = wire();
		const result = await execute(pi, { task: "map the module graph", mode: "read" });

		// The executor is still pending — the tool already answered.
		assert.equal(runs.length, 1);
		assert.equal(result.details.jobId, "claude-job-t-1");
		assert.equal(result.details.error, undefined);
		assert.equal(result.details.launchCwd, "/repo");
		assert.equal(result.details.launchCapturedAt, 42);
		assert.ok(result.content[0].text.includes("claude-job-t-1"));
		assert.equal(jobs.get("claude-job-t-1").status, "running");
		// Explorer never pays for diff capture.
		assert.equal(captures.length, 0);
	});

	it("passes profile, model, thinking, cwd, and the diff-bearing prompt into the execution path", async () => {
		const { pi, captures, runs } = wire();
		const result = await execute(pi, {
			task: "review the change",
			mode: "read",
			review: { base: "main" },
			model: "sonnet",
			thinking: "high",
		});

		assert.equal(captures.length, 1);
		assert.ok(captures[0].signal instanceof AbortSignal);
		const { signal: _signal, ...facts } = captures[0];
		assert.deepEqual(facts, { cwd: "/repo", base: "main", capturedAt: 42 });
		assert.equal(result.details.diffSource, DIFF_ARTIFACT.source);
		assert.equal(result.details.diffArtifactTruncated, false);
		assert.equal(runs.length, 1);
		const run = runs[0];
		assert.equal(run.profile.id, "reviewer");
		assert.equal(run.requestedModel, "sonnet");
		assert.equal(run.thinking, "high");
		assert.equal(run.cwd, "/repo");
		assert.ok(run.signal instanceof AbortSignal);
		assert.ok(run.prompt.includes("independent code-review agent"));
		assert.ok(run.prompt.includes("+changed line"));
		assert.ok(run.prompt.includes("Task:\nreview the change"));
	});

	it("reports the truncation fact honestly for status-only truncation of the launch artifact", async () => {
		const { pi } = wire({
			captureDiff: async (input) => ({
				...DIFF_ARTIFACT,
				cwd: input.cwd,
				capturedAt: input.capturedAt,
				statusTruncated: true,
				diffTruncated: false,
			}),
		});
		const result = await execute(pi, { task: "review", mode: "read", review: {} });
		assert.equal(result.details.error, undefined);
		assert.equal(result.details.diffArtifactTruncated, true);
	});

	it("promotes a second concurrent spawn to an error without paying for diff capture", async () => {
		const { pi, captures } = wire();
		const first = await execute(pi, { task: "explore", mode: "read" });
		const second = await execute(pi, { task: "review", mode: "read", review: {} });

		assert.equal(second.details.error, true);
		assert.ok(second.content[0].text.includes(first.details.jobId));
		// The rejection happened before any reviewer git capture.
		assert.equal(captures.length, 0);
	});

	it("promotes a diff-capture failure to an error result and starts no job", async () => {
		const { pi, jobs, runs } = wire({
			captureDiff: async () => { throw new Error('Invalid comparison base "nope": not a commit in this repository.'); },
		});
		const result = await execute(pi, { task: "review", mode: "read", review: { base: "nope" } });

		assert.equal(result.details.error, true);
		assert.ok(result.content[0].text.includes('Invalid comparison base "nope"'));
		assert.deepEqual(jobs.list(), []);
		assert.equal(runs.length, 0);
	});

	it("starts no job when the tool call was cancelled before launch", async () => {
		const { pi, jobs, captures, runs } = wire();
		const controller = new AbortController();
		controller.abort();
		const result = await execute(pi, { task: "review", mode: "read", review: {} }, { signal: controller.signal });

		assert.equal(result.details.error, true);
		assert.ok(result.content[0].text.includes("cancelled"));
		assert.equal(captures.length, 0);
		assert.equal(runs.length, 0);
		assert.deepEqual(jobs.list(), []);
	});

	it("starts no detached job when the tool call is cancelled during diff capture", async () => {
		const controller = new AbortController();
		const { pi, jobs, runs } = wire({
			captureDiff: async (input) => {
				assert.equal(input.signal, controller.signal);
				controller.abort(); // cancellation lands while the capture is awaited
				return { ...DIFF_ARTIFACT, cwd: input.cwd, capturedAt: input.capturedAt };
			},
		});
		const result = await execute(pi, { task: "review", mode: "read", review: {} }, { signal: controller.signal });

		assert.equal(result.details.error, true);
		assert.ok(result.content[0].text.includes("cancelled during launch capture"));
		assert.equal(runs.length, 0);
		assert.deepEqual(jobs.list(), []);
	});

	it("hands the running job to its own controller — the tool-call signal plays no further part", async () => {
		const { pi, jobs, runs } = wire();
		const controller = new AbortController();
		await execute(pi, { task: "explore", mode: "read" }, { signal: controller.signal });

		controller.abort();
		assert.equal(runs[0].signal.aborted, false);
		assert.equal(jobs.get("claude-job-t-1").status, "running");
		// The manager's own cancel still reaches the job.
		assert.equal(jobs.cancel("claude-job-t-1"), true);
		assert.equal(runs[0].signal.aborted, true);
	});

	it("wires session shutdown and session-start reset cleanup", async () => {
		const { pi, jobs } = wire();
		await execute(pi, { task: "explore", mode: "read" });
		assert.equal(jobs.get("claude-job-t-1").status, "running");

		// The executor never settles and the injected sleep is instant, so the
		// awaited shutdown handler records the job as abandoned.
		await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		assert.equal(jobs.get("claude-job-t-1").status, "abandoned");

		await pi.emit("session_start", { type: "session_start", reason: "new" });
		assert.deepEqual(jobs.list(), []);
	});

	it("wires tool_result promotion for its own failed results", async () => {
		const { pi } = wire();
		const [promoted] = await pi.emit("tool_result", { toolName: "SpawnClaudeAgent", isError: false, details: { error: true } });
		assert.deepEqual(promoted, { isError: true });
		const [ignored] = await pi.emit("tool_result", { toolName: "SpawnClaudeAgent", isError: false, details: { jobId: "claude-job-t-1" } });
		assert.equal(ignored, undefined);
	});

	it("keeps the claude-delegation circular-delegation block", async () => {
		const { pi, jobs, runs } = wire();
		const result = await execute(pi, { task: "explore", mode: "read" }, { ctx: { model: { baseUrl: "claude-delegation" } } });

		assert.equal(result.details.error, true);
		assert.ok(result.content[0].text.includes("claude-delegation"));
		assert.deepEqual(jobs.list(), []);
		assert.equal(runs.length, 0);
	});

	it("rejects review specialization outside read mode", async () => {
		const { pi, jobs } = wire();
		const result = await execute(pi, { task: "advise", mode: "none", review: {} });
		assert.equal(result.details.error, true);
		assert.ok(result.content[0].text.includes('requires mode="read"'));
		assert.deepEqual(jobs.list(), []);

		const worker = await execute(pi, { task: "fix", mode: "full", user_requested: true, review: {} });
		assert.equal(worker.details.error, true);
	});
});

describe("SpawnClaudeAgent capability modes", () => {
	it("keeps the model-facing schema concise without dropping its safety rules", () => {
		const { pi } = wire();
		const tool = pi.tools.get("SpawnClaudeAgent");
		const properties = tool.parameters.properties;

		assert.ok(tool.description.length < 300);
		assert.match(tool.description, /do not poll/);
		assert.match(tool.description, /do not edit concurrently/);
		assert.ok(Object.values(properties).every((property) => !property.description || property.description.length < 160));
		assert.match(properties.execution.description, /deliver the result later/);
		assert.match(properties.isolated.description, /Background is always isolated/);
	});

	it("spawns a background worker with the full-capability prompt and a single-writer warning", async () => {
		const { pi, jobs, captures, runs } = wire();
		const result = await execute(pi, { task: "rename the helper", mode: "full", user_requested: true });

		assert.equal(result.details.error, undefined);
		assert.equal(result.details.profile, "worker");
		assert.equal(jobs.get(result.details.jobId).status, "running");
		// The worker needs no diff artifact.
		assert.equal(captures.length, 0);
		assert.ok(runs[0].prompt.includes("worker agent"));
		assert.ok(runs[0].prompt.includes("Do NOT commit, push, open pull requests"));
		// The immediate result carries the explicit single-writer contract.
		const text = result.content[0].text;
		assert.ok(text.includes("full-capability"));
		assert.ok(text.includes("SINGLE-WRITER WARNING"));
		assert.ok(text.includes("do not edit, create, or delete files"));
	});

	it("keeps the read-only wording (and no warning) for explorer spawns", async () => {
		const { pi } = wire();
		const result = await execute(pi, { task: "explore", mode: "read" });
		const text = result.content[0].text;
		assert.ok(text.includes("read-only"));
		assert.ok(!text.includes("SINGLE-WRITER WARNING"));
	});

	it("spawns a no-access advisor with no diff capture or mutation lease", async () => {
		const { pi, captures, runs, writeLease } = wire();
		const result = await execute(pi, { task: "compare two general approaches", mode: "none" });
		assert.equal(result.details.mode, "none");
		assert.equal(result.details.profile, "advisor");
		assert.equal(captures.length, 0);
		assert.equal(runs[0].profile.id, "advisor");
		assert.match(runs[0].prompt, /no repository, filesystem, shell, agent, or web capabilities/i);
		assert.match(result.content[0].text, /no-access/);
		assert.equal(writeLease.current(), undefined);
	});

	it("excludes full mode from the schema and rejects full calls when allowFull is off", async () => {
		const { pi, jobs, runs, foregroundRuns } = wire({ allowFull: false });
		const tool = pi.tools.get("SpawnClaudeAgent");
		const modeValues = tool.parameters.properties.mode.enum
			?? tool.parameters.properties.mode.anyOf?.map((option) => option.const);
		assert.ok(!JSON.stringify(modeValues ?? tool.parameters.properties.mode).includes("full"));
		assert.ok(!tool.description.includes("Use full mode only"));

		const result = await execute(pi, { task: "fix", mode: "full", user_requested: true });
		assert.equal(result.details.error, true);
		assert.ok(result.content[0].text.includes("allowFullMode"));
		assert.deepEqual(jobs.list(), []);
		assert.equal(runs.length, 0);
		assert.equal(foregroundRuns.length, 0);
	});

	it("requires an explicit user-request assertion for full-mode calls", async () => {
		const { pi, jobs, runs, foregroundRuns } = wire();
		const result = await execute(pi, { task: "fix", mode: "full" });
		assert.equal(result.details.error, true);
		assert.match(result.content[0].text, /requires user_requested=true/);
		assert.deepEqual(jobs.list(), []);
		assert.equal(runs.length, 0);
		assert.equal(foregroundRuns.length, 0);
	});

	it("rejects user_requested outside full mode", async () => {
		const { pi, jobs } = wire();
		const result = await execute(pi, { task: "explore", mode: "read", user_requested: true });
		assert.equal(result.details.error, true);
		assert.match(result.content[0].text, /applies only to mode="full"/);
		assert.deepEqual(jobs.list(), []);
	});
});

describe("SpawnClaudeAgent execution dispatch", () => {
	const foregroundCtx = () => ({
		model: { baseUrl: "anthropic" },
		getSystemPrompt: () => "SYSTEM",
		sessionManager: { getBranch: () => [] },
	});

	it("defaults to background: no execution argument reaches the manager path", async () => {
		const { pi, jobs, foregroundRuns } = wire();
		const result = await execute(pi, { task: "explore", mode: "read" });
		assert.equal(result.details.jobId, "claude-job-t-1");
		assert.equal(jobs.get("claude-job-t-1").status, "running");
		assert.equal(foregroundRuns.length, 0);
	});

	it("runs execution=foreground through the injected foreground implementation and starts no job", async () => {
		const { pi, jobs, runs, foregroundRuns } = wire();
		const result = await execute(
			pi,
			{ task: "fix the bug", mode: "full", user_requested: true, execution: "foreground", model: "sonnet", thinking: "high" },
			{ ctx: foregroundCtx() },
		);

		assert.deepEqual(jobs.list(), []);
		assert.equal(runs.length, 0);
		assert.equal(foregroundRuns.length, 1);
		const run = foregroundRuns[0];
		assert.equal(run.toolCallId, "call-1");
		assert.equal(run.task, "fix the bug");
		assert.equal(run.profile.id, "worker");
		assert.equal(run.requestedModel, "sonnet");
		assert.equal(run.thinking, "high");
		assert.equal(run.cwd, "/repo");
		assert.equal(run.systemPrompt, "SYSTEM");
		// Fresh isolated by default: no Pi branch context is forwarded.
		assert.equal(run.isolated, true);
		assert.equal(run.context, undefined);
		// The delegation prompt wraps the task in the worker role and launch context.
		assert.ok(run.prompt.includes("worker agent"));
		assert.ok(run.prompt.includes("Task:\nfix the bug"));
		// The tool call returns the foreground result directly.
		assert.equal(result.content[0].text, "foreground answer");
		assert.equal(result.details.origin, "spawn-foreground");
	});

	it("forwards Pi branch context for foreground isolated=false like DelegateToClaude shared mode", async () => {
		const { pi, foregroundRuns } = wire();
		await execute(
			pi,
			{ task: "continue the plan", mode: "read", execution: "foreground", isolated: false },
			{ ctx: foregroundCtx() },
		);
		assert.equal(foregroundRuns[0].isolated, false);
		assert.ok(Array.isArray(foregroundRuns[0].context));
	});

	it("rejects execution=background with isolated=false visibly instead of silently ignoring it", async () => {
		const { pi, jobs, runs, foregroundRuns } = wire();
		for (const params of [
			{ task: "explore", mode: "read", isolated: false },
			{ task: "explore", mode: "read", execution: "background", isolated: false },
		]) {
			const result = await execute(pi, params);
			assert.equal(result.details.error, true);
			assert.ok(result.content[0].text.includes('requires execution="foreground"'));
		}
		assert.deepEqual(jobs.list(), []);
		assert.equal(runs.length, 0);
		assert.equal(foregroundRuns.length, 0);
	});

	it("accepts an explicit isolated=true on background spawns (already the contract)", async () => {
		const { pi, jobs } = wire();
		const result = await execute(pi, { task: "explore", mode: "read", isolated: true });
		assert.equal(result.details.error, undefined);
		assert.equal(jobs.get(result.details.jobId).status, "running");
	});

	it("captures and validates the reviewer diff in foreground mode too", async () => {
		const { pi, captures, foregroundRuns } = wire();
		await execute(
			pi,
			{ task: "review it", mode: "read", review: { base: "main" }, execution: "foreground" },
			{ ctx: foregroundCtx() },
		);
		assert.equal(captures.length, 1);
		assert.ok(captures[0].signal instanceof AbortSignal);
		const { signal: _signal, ...facts } = captures[0];
		assert.deepEqual(facts, { cwd: "/repo", base: "main", capturedAt: 42 });
		assert.ok(foregroundRuns[0].prompt.includes("+changed line"));

		const failing = wire({
			captureDiff: async () => { throw new Error('Invalid comparison base "nope": not a commit in this repository.'); },
		});
		const result = await execute(
			failing.pi,
			{ task: "review", mode: "read", review: { base: "nope" }, execution: "foreground" },
			{ ctx: foregroundCtx() },
		);
		assert.equal(result.details.error, true);
		assert.ok(result.content[0].text.includes('Invalid comparison base "nope"'));
		assert.equal(failing.foregroundRuns.length, 0);
	});

	it("allows a foreground call while a background job is running (the limit is background-only)", async () => {
		const { pi, jobs, foregroundRuns } = wire();
		await execute(pi, { task: "explore", mode: "read" });
		assert.ok(jobs.running());
		const result = await execute(
			pi,
			{ task: "quick question", mode: "read", execution: "foreground" },
			{ ctx: foregroundCtx() },
		);
		assert.equal(result.details.origin, "spawn-foreground");
		assert.equal(foregroundRuns.length, 1);
	});

	it("rejects another writer while a background worker owns the checkout lease", async () => {
		const { pi, jobs, foregroundRuns, writeLease } = wire();
		await execute(pi, { task: "first edit", mode: "full", user_requested: true });
		assert.equal(jobs.running()?.profile, "worker");
		assert.match(writeLease.current()?.label ?? "", /background .*worker/);

		const result = await execute(
			pi,
			{ task: "second edit", mode: "full", user_requested: true, execution: "foreground" },
			{ ctx: foregroundCtx() },
		);
		assert.equal(result.details.error, true);
		assert.match(result.content[0].text, /write access is already held/);
		assert.equal(foregroundRuns.length, 0);
	});

	it("keeps the worker lease after abandonment until the executor really settles", async () => {
		let settle;
		const executor = new Promise((resolve) => { settle = resolve; });
		const { pi, jobs, writeLease } = wire({ runJob: () => executor });
		const result = await execute(pi, { task: "long edit", mode: "full", user_requested: true });
		await jobs.shutdown();
		assert.equal(jobs.get(result.details.jobId).status, "abandoned");
		assert.ok(writeLease.current(), "abandonment is not proof the process stopped");

		settle(runResult());
		await jobs.settled(result.details.jobId);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(writeLease.current(), undefined);
	});

	it("fails closed on a spawned worker with no settlement handle", async () => {
		const record = {
			id: "claude-job-broken-1",
			profile: "worker",
			task: "edit",
			requestedModel: "opus",
			status: "running",
			createdAt: 42,
			launch: { cwd: "/repo", capturedAt: 42 },
		};
		const jobs = {
			running: () => undefined,
			spawn: () => record,
			settled: () => undefined,
			reset: async () => {},
			shutdown: async () => {},
		};
		const { pi, writeLease } = wire({ jobs });
		const result = await execute(pi, { task: "edit", mode: "full", user_requested: true });
		assert.equal(result.details.error, true);
		assert.match(result.content[0].text, /write ownership remains held/);
		assert.ok(writeLease.current(), "an unconfirmed running writer must keep blocking checkout mutation");
	});

	it("releases a foreground worker lease when execution settles", async () => {
		const { pi, writeLease } = wire();
		await execute(
			pi,
			{ task: "edit", mode: "full", user_requested: true, execution: "foreground" },
			{ ctx: foregroundCtx() },
		);
		assert.equal(writeLease.current(), undefined);
	});

	it("returns visible errors for malformed mode, review, and execution values", async () => {
		const { pi, jobs } = wire();
		const badMode = await execute(pi, { task: "x", mode: "intruder" });
		assert.equal(badMode.details.error, true);
		assert.match(badMode.content[0].text, /Unknown SpawnClaudeAgent capability mode: intruder/);
		const badReview = await execute(pi, { task: "x", mode: "read", review: "yes" });
		assert.equal(badReview.details.error, true);
		assert.match(badReview.content[0].text, /review parameter must be an object/);

		const badExecution = await execute(pi, { task: "x", mode: "read", execution: "parallel" });
		assert.equal(badExecution.details.error, true);
		assert.match(badExecution.content[0].text, /Unknown SpawnClaudeAgent execution mode: parallel/);
		assert.deepEqual(jobs.list(), []);
	});

	it("renders foreground results with the DelegateToClaude renderer and background results as plain text", () => {
		const { pi } = wire();
		const tool = pi.tools.get("SpawnClaudeAgent");
		const theme = { fg: (_c, t) => t, bold: (t) => t };

		const foreground = tool.renderResult(
			{ content: [{ type: "text", text: "hi" }], details: { origin: "spawn-foreground", profile: "worker", snapshot: undefined } },
			{ expanded: false, isPartial: false },
			theme,
			{},
		);
		// The rich DelegateToClaude renderer returns a Container of components.
		assert.equal(typeof foreground.addChild, "function");

		const background = tool.renderResult(
			{ content: [{ type: "text", text: "Started background Claude job claude-job-t-1" }], details: { jobId: "claude-job-t-1" } },
			{ expanded: false, isPartial: false },
			theme,
			{},
		);
		assert.equal(typeof background.addChild, "undefined");
	});

	it("tags execution and isolation in the rendered call", () => {
		const { pi } = wire();
		const tool = pi.tools.get("SpawnClaudeAgent");
		const theme = { fg: (_c, t) => t, bold: (t) => t };
		const rendered = tool.renderCall({ task: "t", mode: "full", user_requested: true, execution: "foreground", isolated: false }, theme);
		const text = JSON.stringify(rendered);
		assert.ok(text.includes("execution=foreground"));
		assert.ok(text.includes("user-requested"));
		assert.ok(text.includes("shared"));
	});

	it("derives mode tags for restored Phase 3c profile-based calls", () => {
		const { pi } = wire();
		const tool = pi.tools.get("SpawnClaudeAgent");
		const theme = { fg: (_c, t) => t, bold: (t) => t };
		const rendered = tool.renderCall({ task: "old review", profile: "reviewer", execution: "foreground" }, theme);
		const text = JSON.stringify(rendered);
		assert.ok(text.includes("mode=read"));
		assert.ok(text.includes("agent=reviewer"));
		assert.ok(!text.includes("mode=undefined"));
	});
});
