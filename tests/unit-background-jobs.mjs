import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	BACKGROUND_JOB_RECORDS_MAX,
	BACKGROUND_JOB_SHUTDOWN_GRACE_MS,
	MAX_RUNNING_BACKGROUND_JOBS,
	BackgroundJobLimitError,
	BackgroundJobManager,
} from "../src/background-jobs.js";
import { createDelegationSnapshot } from "../src/delegation-events.js";
import { TOOL_CALL_MAX_ITEMS } from "../src/delegation-retention.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

// Deterministic shutdown-grace stand-ins: no unit test sleeps for real.
const neverSleep = () => new Promise(() => {});
const instantSleep = () => Promise.resolve();

function testManager(options = {}) {
	return new BackgroundJobManager({ idPrefix: "t", ...options });
}

function runResult(stopReason = "stop", status = "succeeded", extras = {}) {
	return {
		responseText: "done",
		stopReason,
		permissionDenials: [],
		snapshot: { ...createDelegationSnapshot(1), status },
		messageCount: 1,
		...extras,
	};
}

// Runner-shaped policy observations, matching the bounded summary types.
const OBSERVED_PERMISSION = { requested: "acceptEdits", effective: "default", overridden: true };
const OBSERVED_MANAGED_POLICY = {
	origin: "managed-settings.json",
	disableBypassPermissions: true,
	permissionRulesOnly: false,
	denyRuleCount: 2,
	askRuleCount: 1,
	sandboxRequired: true,
	unsandboxedCommandsDisabled: false,
	managedDomainsOnly: false,
	managedReadPathsOnly: false,
};

function spawnInput(execute, overrides = {}) {
	return {
		profile: "explorer",
		task: "look around",
		requestedModel: "opus",
		launch: { cwd: "/tmp/project", capturedAt: 10 },
		execute,
		...overrides,
	};
}

/** Executor that stays pending until the test settles it. */
function pendingExecutor() {
	const state = { signal: undefined, aborted: false };
	let settle;
	const settled = new Promise((resolve, reject) => { settle = { resolve, reject }; });
	const execute = ({ signal, onSnapshot }) => {
		state.signal = signal;
		state.onSnapshot = onSnapshot;
		signal.addEventListener("abort", () => { state.aborted = true; }, { once: true });
		return settled;
	};
	return { execute, resolve: (value) => settle.resolve(value), reject: (error) => settle.reject(error), state };
}

describe("background job manager", () => {
	it("coalesces snapshot work, then preserves the latest partial snapshot on failure", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
		const manager = testManager();
		const pending = pendingExecutor();
		const transitions = [];
		manager.subscribe((event) => transitions.push(event));
		const record = manager.spawn(spawnInput(pending.execute));
		for (let i = 0; i < 100; i++) {
			pending.state.onSnapshot({ ...createDelegationSnapshot(1), responseText: `partial ${i}` });
		}
		assert.equal(transitions.filter((event) => event.type === "updated").length, 1);
		t.mock.timers.tick(100);
		assert.equal(manager.get(record.id).snapshot.responseText, "partial 99");
		pending.state.onSnapshot({ ...createDelegationSnapshot(1), responseText: "last partial before failure" });
		pending.reject(new Error("runner failed"));
		await manager.settled(record.id);
		assert.equal(manager.get(record.id).status, "failed");
		assert.equal(manager.get(record.id).snapshot.responseText, "last partial before failure");
		assert.equal(transitions.at(-1).type, "settled");
		const count = transitions.length;
		t.mock.timers.tick(1000);
		assert.equal(transitions.length, count, "no delayed progress after settlement");
	});

	it("flushes pending progress before abandonment and cannot resurrect it after reset", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
		const manager = testManager({ sleep: instantSleep });
		const pending = pendingExecutor();
		const record = manager.spawn(spawnInput(pending.execute));
		pending.state.onSnapshot({ ...createDelegationSnapshot(1), responseText: "first" });
		pending.state.onSnapshot({ ...createDelegationSnapshot(1), responseText: "last" });
		await manager.shutdown();
		assert.equal(manager.get(record.id).status, "abandoned");
		assert.equal(manager.get(record.id).snapshot.responseText, "last");
		await manager.reset();
		t.mock.timers.tick(1000);
		pending.state.onSnapshot({ ...createDelegationSnapshot(1), responseText: "late" });
		assert.deepEqual(manager.list(), []);
		pending.resolve(runResult());
		await tick();
	});

	it("pins the phase's concurrency, record, and shutdown-grace bounds", () => {
		assert.equal(MAX_RUNNING_BACKGROUND_JOBS, 1);
		assert.equal(BACKGROUND_JOB_RECORDS_MAX, 20);
		assert.equal(BACKGROUND_JOB_SHUTDOWN_GRACE_MS, 2_000);
	});

	it("returns a running record with a stable job ID before the executor settles", async () => {
		const manager = testManager({ now: () => 100 });
		const pending = pendingExecutor();
		const record = manager.spawn(spawnInput(pending.execute, { thinking: "high" }));

		assert.equal(record.id, "claude-job-t-1");
		assert.equal(record.status, "running");
		assert.equal(record.profile, "explorer");
		assert.equal(record.requestedModel, "opus");
		assert.equal(record.thinking, "high");
		assert.equal(record.createdAt, 100);
		assert.deepEqual(record.launch, { cwd: "/tmp/project", capturedAt: 10 });
		assert.equal(manager.get("claude-job-t-1").status, "running");
		assert.deepEqual(manager.running(), record);

		pending.resolve(runResult());
		await manager.settled("claude-job-t-1");
		assert.equal(manager.running(), undefined);
	});

	it("prefixes job IDs with a collision-resistant 12-hex crypto prefix per manager", async () => {
		const manager = new BackgroundJobManager();
		const record = manager.spawn(spawnInput(async () => runResult()));
		assert.match(record.id, /^claude-job-[0-9a-f]{12}-1$/);
		await manager.settled(record.id);

		// Distinct managers (e.g. across /reload) draw independent random prefixes.
		const second = new BackgroundJobManager();
		const fromSecond = second.spawn(spawnInput(async () => runResult()));
		assert.notEqual(fromSecond.id, record.id);
		await second.settled(fromSecond.id);

		const injected = new BackgroundJobManager({ idPrefix: "ab12" });
		const other = injected.spawn(spawnInput(async () => runResult()));
		assert.equal(other.id, "claude-job-ab12-1");
		await injected.settled(other.id);
	});

	it("copies the launch record at spawn so later caller mutation cannot rewrite it", async () => {
		const manager = testManager();
		const launch = { cwd: "/tmp/project", capturedAt: 10, diff: { source: "working tree", diffText: "+x", diffTruncated: false } };
		const record = manager.spawn(spawnInput(async () => runResult(), { launch }));

		launch.cwd = "/elsewhere";
		launch.diff.diffText = "+tampered";
		assert.equal(record.launch.cwd, "/tmp/project");
		assert.equal(record.launch.diff.diffText, "+x");
		await manager.settled(record.id);
	});

	it("rejects a second spawn visibly while one job runs, then allows the next", async () => {
		const manager = testManager();
		const pending = pendingExecutor();
		const first = manager.spawn(spawnInput(pending.execute));

		assert.throws(
			() => manager.spawn(spawnInput(async () => runResult())),
			(error) => error instanceof BackgroundJobLimitError
				&& error.runningJobId === first.id
				&& error.message.includes(first.id),
		);
		// The rejected spawn left no record and did not disturb the running job.
		assert.equal(manager.list().length, 1);
		assert.equal(manager.get(first.id).status, "running");

		pending.resolve(runResult());
		await manager.settled(first.id);
		const second = manager.spawn(spawnInput(async () => runResult()));
		assert.equal(second.id, "claude-job-t-2");
		await manager.settled(second.id);
		assert.equal(manager.get(second.id).status, "succeeded");
	});

	it("transitions to succeeded with the retained snapshot and an end time", async () => {
		let now = 100;
		const manager = testManager({ now: () => now });
		const record = manager.spawn(spawnInput(async () => runResult("stop", "succeeded")));
		now = 250;
		await manager.settled(record.id);

		const finished = manager.get(record.id);
		assert.equal(finished.status, "succeeded");
		assert.equal(finished.endedAt, 250);
		assert.equal(finished.snapshot.status, "succeeded");
	});

	it("keeps the runner's observed permission and managed policy in the succeeded record, as copies", async () => {
		const manager = testManager();
		const permission = { ...OBSERVED_PERMISSION };
		const managedPolicy = { ...OBSERVED_MANAGED_POLICY };
		const record = manager.spawn(spawnInput(async () => runResult("stop", "succeeded", { permission, managedPolicy })));
		await manager.settled(record.id);

		const finished = manager.get(record.id);
		assert.equal(finished.status, "succeeded");
		assert.deepEqual(finished.permission, OBSERVED_PERMISSION);
		assert.deepEqual(finished.managedPolicy, OBSERVED_MANAGED_POLICY);

		// Stored as copies: a caller mutating the runner result cannot rewrite
		// the terminal record's policy facts.
		permission.overridden = false;
		managedPolicy.denyRuleCount = 99;
		assert.equal(finished.permission.overridden, true);
		assert.equal(finished.managedPolicy.denyRuleCount, 2);
	});

	it("keeps the runner's policy telemetry on a cancelled settlement too", async () => {
		const manager = testManager();
		const pending = pendingExecutor();
		const record = manager.spawn(spawnInput(pending.execute));
		pending.state.signal.addEventListener("abort", () => pending.resolve(
			runResult("cancelled", "cancelled", { permission: { ...OBSERVED_PERMISSION }, managedPolicy: { ...OBSERVED_MANAGED_POLICY } }),
		), { once: true });

		assert.equal(manager.cancel(record.id), true);
		await manager.settled(record.id);
		const cancelled = manager.get(record.id);
		assert.equal(cancelled.status, "cancelled");
		assert.deepEqual(cancelled.permission, OBSERVED_PERMISSION);
		assert.deepEqual(cancelled.managedPolicy, OBSERVED_MANAGED_POLICY);
	});

	it("leaves policy telemetry absent when the runner never produced it", async () => {
		const manager = testManager({ sleep: instantSleep });

		// Success without runner-observed policy: absent, not defaulted.
		const bare = manager.spawn(spawnInput(async () => runResult()));
		await manager.settled(bare.id);
		assert.equal(manager.get(bare.id).permission, undefined);
		assert.equal(manager.get(bare.id).managedPolicy, undefined);

		// Failure: the executor threw, so no run result exists to take facts from.
		const failed = manager.spawn(spawnInput(async () => { throw new Error("boom"); }));
		await manager.settled(failed.id);
		assert.equal(manager.get(failed.id).status, "failed");
		assert.equal(manager.get(failed.id).permission, undefined);
		assert.equal(manager.get(failed.id).managedPolicy, undefined);

		// Abandonment: the executor never confirmed; nothing may be fabricated.
		manager.spawn(spawnInput(pendingExecutor().execute));
		const abandoned = manager.running();
		await manager.shutdown();
		assert.equal(manager.get(abandoned.id).status, "abandoned");
		assert.equal(manager.get(abandoned.id).permission, undefined);
		assert.equal(manager.get(abandoned.id).managedPolicy, undefined);
	});

	it("transitions to failed with a bounded error when the executor rejects", async () => {
		const manager = testManager();
		const record = manager.spawn(spawnInput(async () => { throw new Error(`boom ${"x".repeat(5_000)}`); }));
		await manager.settled(record.id);

		const failed = manager.get(record.id);
		assert.equal(failed.status, "failed");
		assert.ok(failed.error.startsWith("boom "));
		assert.ok(failed.error.length <= 2_000);
		assert.match(failed.error, /\[… truncated \d+ chars\]/);
		assert.ok(failed.endedAt !== undefined);
	});

	it("cancels an in-flight job through its own AbortController", async () => {
		const manager = testManager();
		const pending = pendingExecutor();
		const record = manager.spawn(spawnInput(pending.execute));
		pending.state.signal.addEventListener("abort", () => pending.resolve(runResult("cancelled", "cancelled")), { once: true });

		assert.equal(manager.cancel(record.id), true);
		await manager.settled(record.id);
		assert.equal(pending.state.aborted, true);
		assert.equal(manager.get(record.id).status, "cancelled");
		// Terminal jobs cannot be cancelled again; unknown jobs report false.
		assert.equal(manager.cancel(record.id), false);
		assert.equal(manager.cancel("claude-job-t-99"), false);
	});

	it("resolves a cancel that lands before the runner gets CPU as cancelled", async () => {
		const manager = testManager();
		// Mirrors the runner's pre-aborted contract: a signal aborted before the
		// delegation starts reports the normal cancelled outcome.
		const record = manager.spawn(spawnInput(async ({ signal }) => {
			await tick();
			return signal.aborted ? runResult("cancelled", "cancelled") : runResult();
		}));
		assert.equal(manager.cancel(record.id), true);
		await manager.settled(record.id);
		assert.equal(manager.get(record.id).status, "cancelled");
	});

	it("preserves the genuine terminal state when shutdown's abort settles inside the grace", async () => {
		const sleeps = [];
		const manager = testManager({
			sleep: (ms) => { sleeps.push(ms); return neverSleep(); },
		});
		const pending = pendingExecutor();
		const record = manager.spawn(spawnInput(pending.execute));
		pending.state.signal.addEventListener("abort", () => pending.resolve(runResult("cancelled", "cancelled")), { once: true });

		// The sleep never resolves, so shutdown returning at all proves the
		// settlement — not the timeout — completed the wait.
		await manager.shutdown();
		assert.deepEqual(sleeps, [BACKGROUND_JOB_SHUTDOWN_GRACE_MS]);
		assert.equal(manager.get(record.id).status, "cancelled");
	});

	it("marks only jobs unsettled after the shutdown grace as abandoned and ignores their late settlement", async () => {
		const debugLines = [];
		let now = 100;
		const manager = testManager({
			now: () => now,
			onDebug: (line) => debugLines.push(line),
			sleep: instantSleep,
		});
		const pending = pendingExecutor();
		const record = manager.spawn(spawnInput(pending.execute));

		now = 300;
		await manager.shutdown();
		// Shutdown aborted the job (so the runner interrupts Claude Code), but the
		// executor never confirmed inside the grace: the truthful state is abandoned.
		assert.equal(pending.state.aborted, true);
		assert.equal(manager.get(record.id).status, "abandoned");
		assert.equal(manager.get(record.id).endedAt, 300);
		assert.ok(debugLines.some((line) => line.includes("unsettled after") && line.includes("marking abandoned")));

		// A late executor settlement must not rewrite the terminal state.
		pending.resolve(runResult("cancelled", "cancelled"));
		await manager.settled(record.id);
		assert.equal(manager.get(record.id).status, "abandoned");
		assert.ok(debugLines.some((line) => line.includes("ignored late cancelled after terminal abandoned")));

		// Shutdown on an all-terminal manager is a no-op.
		await manager.shutdown();
		assert.equal(manager.get(record.id).status, "abandoned");
	});

	it("honors an injected shutdown grace", async () => {
		const sleeps = [];
		const manager = testManager({
			shutdownGraceMs: 5,
			sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); },
		});
		manager.spawn(spawnInput(pendingExecutor().execute));
		await manager.shutdown();
		assert.deepEqual(sleeps, [5]);
	});

	it("stores bounded snapshots while running and freezes them at the terminal state", async () => {
		const manager = testManager();
		const pending = pendingExecutor();
		const record = manager.spawn(spawnInput(pending.execute));

		const oversized = {
			...createDelegationSnapshot(1),
			tools: Array.from({ length: TOOL_CALL_MAX_ITEMS + 30 }, (_, i) => ({
				id: `tool-${i}`, name: "Read", status: "succeeded", startedAt: 1, updatedAt: 1, parentToolUseId: null,
			})),
		};
		pending.state.onSnapshot(oversized);
		const live = manager.get(record.id);
		assert.equal(live.snapshot.tools.length, TOOL_CALL_MAX_ITEMS);
		assert.equal(live.snapshot.toolsOmitted, 30);

		pending.resolve(runResult("stop", "succeeded"));
		await manager.settled(record.id);
		assert.equal(manager.get(record.id).status, "succeeded");

		// A straggler snapshot after the terminal state changes nothing.
		pending.state.onSnapshot({ ...createDelegationSnapshot(1), responseText: "late" });
		assert.notEqual(manager.get(record.id).snapshot.responseText, "late");
	});

	it("resets on session change: bounded cleanup, cleared records, fresh spawn, no reused IDs", async () => {
		const debugLines = [];
		const manager = testManager({ sleep: instantSleep, onDebug: (line) => debugLines.push(line) });
		const pending = pendingExecutor();
		const record = manager.spawn(spawnInput(pending.execute));
		const settled = manager.settled(record.id);

		await manager.reset();
		assert.equal(pending.state.aborted, true);
		assert.deepEqual(manager.list(), []);
		assert.equal(manager.get(record.id), undefined);

		// The cleared job's late settlement neither throws nor resurrects it, and
		// it stays accounted for in the debug log.
		pending.resolve(runResult("cancelled", "cancelled"));
		await settled;
		assert.equal(manager.get(record.id), undefined);
		assert.ok(debugLines.some((line) => line.includes(`${record.id}: ignored cancelled settlement for a cleared record`)));

		// The counter survives reset: within one manager an ID is never reused.
		const next = manager.spawn(spawnInput(async () => runResult()));
		assert.equal(next.id, "claude-job-t-2");
		await manager.settled(next.id);
		assert.equal(manager.get(next.id).status, "succeeded");
	});

	it("waits for a settlement that confirms during reset before clearing records", async () => {
		const manager = testManager({ sleep: neverSleep });
		const pending = pendingExecutor();
		const record = manager.spawn(spawnInput(pending.execute));
		pending.state.signal.addEventListener("abort", () => pending.resolve(runResult("cancelled", "cancelled")), { once: true });

		await manager.reset();
		assert.deepEqual(manager.list(), []);
		assert.equal(manager.get(record.id), undefined);
	});

	it("evicts the oldest terminal records beyond the bounded in-memory cap", async () => {
		const manager = testManager();
		for (let i = 0; i < BACKGROUND_JOB_RECORDS_MAX + 5; i++) {
			const record = manager.spawn(spawnInput(async () => runResult()));
			await manager.settled(record.id);
		}
		const records = manager.list();
		assert.equal(records.length, BACKGROUND_JOB_RECORDS_MAX);
		assert.equal(manager.get("claude-job-t-1"), undefined);
		assert.equal(manager.get(`claude-job-t-${BACKGROUND_JOB_RECORDS_MAX + 5}`).status, "succeeded");
	});

	it("leaves no live work behind once every job is terminal", async () => {
		const sleeps = [];
		const manager = testManager({ sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); } });
		const success = manager.spawn(spawnInput(async () => runResult()));
		await manager.settled(success.id);
		const failure = manager.spawn(spawnInput(async () => { throw new Error("boom"); }));
		await manager.settled(failure.id);

		for (const record of manager.list()) {
			assert.notEqual(record.status, "running");
			assert.equal(manager.cancel(record.id), false);
		}
		const before = manager.list().map((record) => record.status);
		await manager.shutdown();
		assert.deepEqual(manager.list().map((record) => record.status), before);
		// An all-terminal shutdown never waits at all.
		assert.deepEqual(sleeps, []);
	});

	it("emits spawned, updated, and one settled transition per job in order", async () => {
		const manager = testManager();
		const transitions = [];
		manager.subscribe((transition) => transitions.push(transition));

		const pending = pendingExecutor();
		const record = manager.spawn(spawnInput(pending.execute));
		pending.state.onSnapshot({ ...createDelegationSnapshot(1), responseText: "partial" });
		pending.resolve(runResult());
		await manager.settled(record.id);

		assert.deepEqual(transitions.map((transition) => transition.type), ["spawned", "updated", "settled"]);
		assert.equal(transitions[0].record.id, record.id);
		assert.equal(transitions[1].record.snapshot.responseText, "partial");
		assert.equal(transitions[2].record.status, "succeeded");
		assert.equal(transitions[2].duringShutdown, false);
		// The settled record is the stored terminal record, retained snapshot included.
		assert.deepEqual(transitions[2].record, manager.get(record.id));
	});

	it("flags every shutdown-window settlement as duringShutdown — confirmed cancel and abandonment alike", async () => {
		const manager = testManager({ sleep: instantSleep });
		const transitions = [];
		manager.subscribe((transition) => transitions.push(transition));

		// Confirmed inside the grace: genuine cancelled state, still flagged.
		const confirmed = pendingExecutor();
		const first = manager.spawn(spawnInput(confirmed.execute));
		confirmed.state.signal.addEventListener("abort", () => confirmed.resolve(runResult("cancelled", "cancelled")), { once: true });
		await manager.shutdown();
		const firstSettled = transitions.find((transition) => transition.type === "settled");
		assert.equal(firstSettled.record.id, first.id);
		assert.equal(firstSettled.record.status, "cancelled");
		assert.equal(firstSettled.duringShutdown, true);

		// Unconfirmed after the grace: abandoned, flagged, and emitted exactly once.
		transitions.length = 0;
		const wedged = pendingExecutor();
		const second = manager.spawn(spawnInput(wedged.execute));
		await manager.reset();
		const settled = transitions.filter((transition) => transition.type === "settled");
		assert.equal(settled.length, 1);
		assert.equal(settled[0].record.id, second.id);
		assert.equal(settled[0].record.status, "abandoned");
		assert.equal(settled[0].duringShutdown, true);
		// Reset announces the record wipe after the settlements.
		assert.equal(transitions[transitions.length - 1].type, "cleared");

		// The wedged executor's late settlement emits nothing further.
		transitions.length = 0;
		wedged.resolve(runResult("cancelled", "cancelled"));
		await manager.settled(second.id);
		assert.deepEqual(transitions, []);
	});

	it("emits settled exactly once per job even when cancel and success race", async () => {
		const manager = testManager();
		const transitions = [];
		manager.subscribe((transition) => transitions.push(transition));

		const pending = pendingExecutor();
		const record = manager.spawn(spawnInput(pending.execute));
		manager.cancel(record.id);
		pending.resolve(runResult("cancelled", "cancelled"));
		await manager.settled(record.id);

		assert.equal(transitions.filter((transition) => transition.type === "settled").length, 1);
	});

	it("isolates listener failures from job lifecycle and honors unsubscribe", async () => {
		const debugLines = [];
		const manager = testManager({ onDebug: (line) => debugLines.push(line) });
		const seen = [];
		manager.subscribe(() => { throw new Error("listener boom"); });
		const unsubscribe = manager.subscribe((transition) => seen.push(transition.type));

		const record = manager.spawn(spawnInput(async () => runResult()));
		await manager.settled(record.id);
		// The throwing listener neither blocked the lifecycle nor the next listener.
		assert.equal(manager.get(record.id).status, "succeeded");
		assert.deepEqual(seen, ["spawned", "settled"]);
		assert.ok(debugLines.some((line) => line.includes("listener error") && line.includes("listener boom")));

		unsubscribe();
		const next = manager.spawn(spawnInput(async () => runResult()));
		await manager.settled(next.id);
		assert.deepEqual(seen, ["spawned", "settled"]);
	});

	it("retains an oversized task in the record without altering the visible head", async () => {
		const manager = testManager();
		const record = manager.spawn(spawnInput(async () => runResult(), { task: "t".repeat(10_000) }));
		assert.ok(record.task.length <= 8_000);
		assert.ok(record.task.startsWith("tttt"));
		assert.match(record.task, /\[… truncated \d+ chars\]/);
		await manager.settled(record.id);
	});
});

describe("SpawnClaudeAgent result contract", () => {
	it("promotes a failed spawn to an error tool result for its own tool only", async () => {
		const { spawnClaudeAgentResultIsError, spawnedJobResultText } = await import("../src/spawn-claude-agent.js");
		assert.deepEqual(
			spawnClaudeAgentResultIsError({ toolName: "SpawnClaudeAgent", isError: false, details: { error: true } }),
			{ isError: true },
		);
		assert.equal(
			spawnClaudeAgentResultIsError({ toolName: "SpawnClaudeAgent", isError: false, details: { jobId: "claude-job-x9k2-1" } }),
			undefined,
		);
		assert.equal(
			spawnClaudeAgentResultIsError({ toolName: "DelegateToClaude", isError: false, details: { error: true } }),
			undefined,
		);
		assert.equal(
			spawnClaudeAgentResultIsError({ toolName: "SpawnClaudeAgent", isError: true, details: { error: true } }),
			undefined,
		);
	});

	it("returns the job ID promptly with honest phase limits in the spawned text", async () => {
		const { spawnClaudeAgentResultIsError, spawnedJobResultText } = await import("../src/spawn-claude-agent.js");
		const text = spawnedJobResultText({
			id: "claude-job-x9k2-1",
			profile: "reviewer",
			task: "review",
			requestedModel: "opus",
			thinking: "high",
			status: "running",
			createdAt: 1,
			launch: {
				cwd: "/tmp/project",
				capturedAt: 1,
				diff: { source: 'working tree at launch vs HEAD abcdef123456 (staged + unstaged changes)', diffTruncated: false },
			},
		});
		assert.ok(text.includes("claude-job-x9k2-1"));
		assert.ok(text.includes("mode=read"));
		assert.ok(text.includes("agent=reviewer"));
		assert.ok(text.includes("model=opus"));
		assert.ok(text.includes("thinking=high"));
		assert.ok(text.includes("diff artifact"));
		assert.ok(text.includes("no status, result, or cancel tools"));
		assert.ok(text.includes("One background job runs per session"));
	});
});
