import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createDelegationSnapshot } from "../src/delegation-events.js";
import { extractAskClaudeCalls, mergeLiveCall } from "../src/askclaude-details.js";
import {
	askClaudeOverlayFocus,
	backgroundJobsOverlayFocus,
	buildSessionBodyLines,
	buildSessionHeaderLines,
	defaultOverlayFocus,
	extractBackgroundJobRecords,
	mergeBackgroundJobRecords,
	mergeClaudeSessionRecords,
	requestedOverlayFocus,
} from "../src/claude-sessions.js";
import {
	ClaudeSessionsOverlay,
	clearLiveAskClaudeCall,
	getLiveAskClaudeCall,
	registerClaudeSessionsUI,
	updateLiveAskClaudeCall,
} from "../src/claude-sessions-overlay.js";
import { BackgroundJobManager } from "../src/background-jobs.js";
import { BACKGROUND_JOB_ENTRY_TYPE } from "../src/background-job-ui.js";

initTheme("dark", false);

const theme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};
const kb = { matches: () => false };

const T = (time) => Date.parse(`2026-08-20T${time}.000Z`);

// --- Fixtures over the real session-branch entry shapes ---

function messageEntry(message, timestamp) {
	return { type: "message", id: `id-${Math.random()}`, parentId: null, timestamp, message };
}

function callEntry(id, prompt, timestamp) {
	return messageEntry(
		{ role: "assistant", content: [{ type: "toolCall", id, name: "DelegateToClaude", arguments: { prompt, mode: "read" } }] },
		timestamp,
	);
}

function resultEntry(id, details) {
	return messageEntry({ role: "toolResult", toolCallId: id, toolName: "DelegateToClaude", content: [{ type: "text", text: "answer" }], isError: false, details });
}

function askDetails(overrides = {}) {
	return {
		prompt: "retained prompt copy",
		executionTime: 1200,
		capabilityMode: "read",
		requestedModel: "opus",
		isolated: true,
		snapshot: { ...createDelegationSnapshot(T("09:00:00")), status: "succeeded", resultText: "ask answer" },
		...overrides,
	};
}

function bgSnapshot(overrides = {}) {
	return {
		...createDelegationSnapshot(T("09:30:00")),
		status: "succeeded",
		updatedAt: T("09:35:00"),
		model: "claude-opus-runtime",
		sessionId: "claude-session-bg",
		cwd: "/claude/job/cwd",
		runtimePermissionMode: "default",
		responseText: "streamed job narration",
		resultText: "## Review\nAll findings recorded",
		thinkingText: "job thinking summary",
		tools: [
			{ id: "t1", name: "Read", status: "succeeded", input: { file_path: "src/a.ts" }, output: "file text", startedAt: T("09:30:10"), updatedAt: T("09:30:11"), completedAt: T("09:30:11"), durationMs: 1000, parentToolUseId: null },
		],
		timeline: [{ at: T("09:30:10"), kind: "tool_start", label: "Read", toolUseId: "t1" }],
		usage: { inputTokens: 1500, outputTokens: 200, cacheReadInputTokens: 100, cacheCreationInputTokens: 20, totalCostUsd: 0.0456, turns: 2, durationMs: 300000, durationApiMs: 250000, modelUsage: {} },
		contextUsage: { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 800, cacheCreationInputTokens: 100, model: "claude-opus-runtime", contextWindow: 200000 },
		...overrides,
	};
}

function completionData(overrides = {}) {
	return {
		jobId: "claude-job-t-1",
		profile: "reviewer",
		status: "succeeded",
		task: "review the working-tree diff",
		requestedModel: "opus",
		thinking: "high",
		createdAt: T("09:30:00"),
		endedAt: T("09:35:00"),
		launchCwd: "/tmp/project",
		diffSource: "merge-base main",
		permission: { requested: "auto", effective: "default", overridden: true },
		snapshot: bgSnapshot(),
		...overrides,
	};
}

function jobEntry(data, timestamp = "2026-08-20T09:35:01.000Z") {
	return { type: "custom", id: `e-${Math.random()}`, parentId: null, timestamp, customType: BACKGROUND_JOB_ENTRY_TYPE, data };
}

function managerRecord(overrides = {}) {
	return {
		id: "claude-job-t-9",
		profile: "explorer",
		task: "explore the repo",
		requestedModel: "opus",
		status: "running",
		createdAt: T("10:30:00"),
		launch: { cwd: "/tmp/project", capturedAt: 0 },
		...overrides,
	};
}

describe("manager record normalization cache", () => {
	it("preserves unchanged fallback identities and invalidates a replaced record", () => {
		const terminal = managerRecord({ status: "succeeded" });
		const running = managerRecord({ id: "running" });
		const first = mergeBackgroundJobRecords([], [terminal, running]);
		const second = mergeBackgroundJobRecords([], [terminal, { ...running, snapshot: bgSnapshot() }]);
		assert.equal(first[0], second[0]);
		assert.equal(first[0].data, second[0].data);
		assert.notEqual(first[1].data, second[1].data);
	});

	it("does not normalize a manager record shadowed by a persisted terminal entry", () => {
		const persisted = extractBackgroundJobRecords([jobEntry(completionData({ jobId: "terminal" }))]);
		const record = managerRecord({ id: "terminal", status: "succeeded" });
		Object.defineProperty(record, "snapshot", { get() { assert.fail("shadowed record was normalized"); } });
		assert.equal(mergeBackgroundJobRecords(persisted, [record])[0], persisted[0]);
	});
});

function jobsStub(records = []) {
	const listeners = new Set();
	return {
		records,
		list: () => [...records],
		running: () => records.find((record) => record.status === "running"),
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		emit() {
			for (const listener of [...listeners]) listener();
		},
		listenerCount: () => listeners.size,
	};
}

/** Executor that stays pending until the test settles it. */
function pendingExecutor() {
	const state = {};
	let settle;
	const settled = new Promise((resolve) => { settle = resolve; });
	const execute = ({ signal, onSnapshot }) => {
		state.signal = signal;
		state.onSnapshot = onSnapshot;
		return settled;
	};
	return { execute, resolve: (value) => settle(value), state };
}

function runResult(stopReason = "stop", snapshot = bgSnapshot()) {
	return { responseText: snapshot.responseText, stopReason, permissionDenials: [], snapshot, messageCount: 1 };
}

function stubTui(rows = 30, columns = 100) {
	return { renders: 0, requestRender() { this.renders++; }, terminal: { rows, columns } };
}

function mixedBranch() {
	return [
		callEntry("call-1", "First ask", "2026-08-20T09:00:00.000Z"),
		resultEntry("call-1", askDetails()),
		jobEntry(completionData()),
		callEntry("call-2", "Second ask", "2026-08-20T10:00:00.000Z"),
		resultEntry("call-2", askDetails()),
	];
}

function loadMixed(entries, jobs = jobsStub()) {
	return () => mergeClaudeSessionRecords(
		mergeLiveCall(extractAskClaudeCalls(entries, "DelegateToClaude"), getLiveAskClaudeCall()),
		mergeBackgroundJobRecords(extractBackgroundJobRecords(entries), jobs.list()),
	);
}

beforeEach(() => clearLiveAskClaudeCall());

describe("background entry extraction", () => {
	it("extracts valid persisted completion entries with normalized ids and start timestamps", () => {
		const data = completionData();
		const records = extractBackgroundJobRecords([
			messageEntry({ role: "user", content: "hi" }, "2026-08-20T08:00:00.000Z"),
			{ type: "custom", customType: "some-other-extension", data: { jobId: "x" } },
			jobEntry(data),
		]);
		assert.equal(records.length, 1);
		assert.equal(records[0].kind, "background");
		assert.equal(records[0].id, "background:claude-job-t-1");
		assert.equal(records[0].startMs, T("09:30:00"));
		assert.equal(records[0].data, data);
		assert.equal(records[0].malformed, undefined);
	});

	it("degrades malformed and future entries to visible placeholders instead of throwing", () => {
		const malformedPayloads = [
			undefined,
			null,
			"junk",
			{ jobId: "claude-job-partial" },
			completionData({ status: "future-status" }),
			completionData({ snapshot: { responseText: "no retained arrays" } }),
			completionData({ snapshot: bgSnapshot({ timeline: "not-an-array" }) }),
		];
		const records = extractBackgroundJobRecords(malformedPayloads.map((data) => jobEntry(data, "2026-08-20T09:35:01.000Z")));
		assert.equal(records.length, malformedPayloads.length);
		for (const record of records) {
			assert.equal(record.malformed, true);
			assert.equal(record.data, undefined);
			assert.equal(record.startMs, T("09:35:01"), "malformed entries fall back to the branch timestamp");
			const header = buildSessionHeaderLines(record, { index: 0, total: 1 }, theme).join("\n");
			assert.match(header, /entry unavailable \(missing or malformed data\)/);
			const body = buildSessionBodyLines(record, theme, 80);
			assert.match(body.lines.join("\n"), /entry unavailable \(missing or malformed data\)/);
		}
		// A malformed entry that still carries a string job ID keeps it for dedup.
		assert.equal(records[3].id, "background:claude-job-partial");
	});

	it("keeps the first branch position but the latest data for duplicate persisted entries", () => {
		const first = completionData({ status: "failed", error: "first write" });
		const second = completionData({ status: "succeeded" });
		const records = extractBackgroundJobRecords([jobEntry(first), jobEntry(second)]);
		assert.equal(records.length, 1);
		assert.equal(records[0].data.status, "succeeded");
		assert.equal(records[0].startMs, T("09:30:00"));
	});
});

describe("background record merge/dedup", () => {
	it("keeps the persisted completion entry for settled jobs and adds manager-only records", () => {
		const persisted = extractBackgroundJobRecords([jobEntry(completionData())]);
		const settledManager = managerRecord({ id: "claude-job-t-1", status: "cancelled", endedAt: T("09:36:00") });
		const runningManager = managerRecord({ id: "claude-job-t-9", status: "running" });
		const merged = mergeBackgroundJobRecords(persisted, [settledManager, runningManager]);
		assert.equal(merged.length, 2);
		assert.equal(merged[0].data.status, "succeeded", "persisted completion entry wins for settled records");
		assert.equal(merged[1].id, "background:claude-job-t-9");
		assert.equal(merged[1].live, true);
		assert.equal(merged[1].data.status, "running");
	});

	it("uses the manager record as a terminal fallback when persistence is absent", () => {
		const settled = managerRecord({ id: "claude-job-t-2", status: "failed", endedAt: T("10:31:00"), error: "exploded" });
		const merged = mergeBackgroundJobRecords([], [settled]);
		assert.equal(merged.length, 1);
		assert.equal(merged[0].live, undefined);
		assert.equal(merged[0].data.status, "failed");
		assert.equal(merged[0].data.error, "exploded");
	});

	it("replaces a malformed persisted placeholder with the manager's record for the same job", () => {
		const persisted = extractBackgroundJobRecords([jobEntry({ jobId: "claude-job-t-3" })]);
		assert.equal(persisted[0].malformed, true);
		const merged = mergeBackgroundJobRecords(persisted, [managerRecord({ id: "claude-job-t-3", status: "succeeded", endedAt: T("10:31:00") })]);
		assert.equal(merged.length, 1);
		assert.equal(merged[0].malformed, undefined);
		assert.equal(merged[0].data.status, "succeeded");
	});
});

describe("chronological merge and focus rules", () => {
	it("orders DelegateToClaude ISO timestamps and background epoch timestamps in one flat list", () => {
		const records = loadMixed(mixedBranch())();
		assert.deepEqual(records.map((record) => record.kind), ["askclaude", "background", "askclaude"]);
		assert.deepEqual(records.map((record) => record.id), [
			"askclaude:call-1",
			"background:claude-job-t-1",
			"askclaude:call-2",
		]);
	});

	it("falls back to deterministic branch order for missing timestamps", () => {
		const calls = extractAskClaudeCalls([
			callEntry("call-1", "first", "2026-08-20T09:00:00.000Z"),
			callEntry("call-2", "no timestamp", undefined),
		], "DelegateToClaude");
		const background = extractBackgroundJobRecords([jobEntry(completionData())]);
		const records = mergeClaudeSessionRecords(calls, background);
		// call-2 has no timestamp: it inherits call-1's position and stays before
		// the 09:30 background job.
		assert.deepEqual(records.map((record) => record.id), [
			"askclaude:call-1",
			"askclaude:call-2",
			"background:claude-job-t-1",
		]);
	});

	it("focuses a running background job first, else the latest record", () => {
		const settledOnly = loadMixed(mixedBranch())();
		assert.deepEqual(defaultOverlayFocus(settledOnly), { index: 2, pinned: false });

		const withRunning = loadMixed(mixedBranch(), jobsStub([managerRecord()]))();
		assert.equal(withRunning.length, 4);
		assert.deepEqual(defaultOverlayFocus(withRunning), { index: 3, pinned: true });
		assert.deepEqual(defaultOverlayFocus([]), { index: -1, pinned: false });
	});

	it("clamps requested merged indexes and pins non-latest selections", () => {
		const records = loadMixed(mixedBranch())();
		assert.deepEqual(requestedOverlayFocus(records, 2), { index: 1, pinned: true });
		assert.deepEqual(requestedOverlayFocus(records, 99), { index: 2, pinned: false });
	});

	it("resolves /askclaude-details numbering among DelegateToClaude calls only and maps to the merged list", () => {
		const records = loadMixed(mixedBranch())();
		assert.equal(askClaudeOverlayFocus(records).index, 2, "default focuses the latest DelegateToClaude record");
		assert.deepEqual(askClaudeOverlayFocus(records, 1), { index: 0, pinned: true }, "call #1 maps around the background record");
		assert.equal(askClaudeOverlayFocus(records, 2).index, 2, "call #2 is merged record 3");
		assert.equal(askClaudeOverlayFocus(records, 99).index, 2, "clamped to the last DelegateToClaude call");

		const backgroundOnly = loadMixed([jobEntry(completionData())])();
		assert.deepEqual(askClaudeOverlayFocus(backgroundOnly), { index: -1, pinned: false }, "the compatibility command reports no DelegateToClaude calls");
	});

	it("focuses /claude-jobs on the running job, else the latest background job, else nothing", () => {
		const withRunning = loadMixed(mixedBranch(), jobsStub([managerRecord()]))();
		assert.deepEqual(backgroundJobsOverlayFocus(withRunning), { index: 3, pinned: true });

		const settledOnly = loadMixed(mixedBranch())();
		assert.deepEqual(backgroundJobsOverlayFocus(settledOnly), { index: 1, pinned: true });

		const askOnly = loadMixed([callEntry("call-1", "p", "2026-08-20T09:00:00.000Z")])();
		assert.equal(backgroundJobsOverlayFocus(askOnly).index, -1);
	});
});

describe("background record header", () => {
	it("shows only background Claude facts with kind/profile/status labels", () => {
		const [record] = extractBackgroundJobRecords([jobEntry(completionData())]);
		const header = buildSessionHeaderLines(record, { index: 1, total: 3 }, theme).join("\n");
		assert.match(header, /Claude reviewer background job/);
		assert.match(header, /record 2\/3/);
		assert.match(header, /succeeded/);
		assert.match(header, /5m00s/);
		assert.match(header, /model: claude-opus-runtime \(requested opus\)/);
		assert.match(header, /session: claude-session-bg/);
		assert.match(header, /permission: auto → default/);
		assert.match(header, /cwd: \/tmp\/project · diff: merge-base main/);
		assert.match(header, /context: 2,000 \/ 200,000 \(1\.0%\)/);
		assert.match(header, /run: 1,500 in \/ 200 out · cache 100 read \/ 20 write · 2 turns · \$0\.0456/);
		assert.match(header, /job: claude-job-t-1 · thinking: high/);
		// Nothing borrows the active Pi session's cwd.
		assert.ok(!header.includes(process.cwd()));
	});

	it("reports unavailable fields honestly and live elapsed for a running manager record", () => {
		const [record] = mergeBackgroundJobRecords([], [managerRecord()]);
		const header = buildSessionHeaderLines(record, { index: 0, total: 1 }, theme, T("10:31:30")).join("\n");
		assert.match(header, /Claude explorer background job/);
		assert.match(header, /running \(live\)/);
		assert.match(header, /1m30s/);
		assert.match(header, /model: unavailable \(requested opus\)/);
		assert.match(header, /session: unavailable/);
		assert.match(header, /permission: unavailable/);
		assert.match(header, /context: pending/);
		assert.match(header, /run: pending/);
		assert.match(header, /job: claude-job-t-9/);
	});

	it("surfaces managed policy and permission denials", () => {
		const data = completionData({
			managedPolicy: {
				origin: "managed-settings.json",
				disableBypassPermissions: true,
				permissionRulesOnly: false,
				denyRuleCount: 0,
				askRuleCount: 0,
				sandboxRequired: true,
				unsandboxedCommandsDisabled: false,
				managedDomainsOnly: false,
				managedReadPathsOnly: false,
			},
			snapshot: bgSnapshot({ permissionDenials: [{ toolName: "WebFetch", toolUseId: "d1", message: "denied" }] }),
		});
		const [record] = extractBackgroundJobRecords([jobEntry(data)]);
		const header = buildSessionHeaderLines(record, { index: 0, total: 1 }, theme).join("\n");
		assert.match(header, /managed policy: sandbox required, bypass disabled/);
		assert.match(header, /permission denials: WebFetch/);
	});
});

describe("background record body", () => {
	it("reuses the shared sections over the retained snapshot, titling the prompt section Task", () => {
		const [record] = extractBackgroundJobRecords([jobEntry(completionData())]);
		const body = buildSessionBodyLines(record, theme, 120);
		assert.deepEqual(body.sections.map((section) => section.title), ["Task", "Thinking", "Tools", "Timeline", "Response"]);
		const rendered = body.lines.join("\n");
		assert.match(rendered, /review the working-tree diff/);
		assert.match(rendered, /job thinking summary/);
		assert.match(rendered, /Read succeeded/);
		assert.match(rendered, /tool_start Read/);
		assert.match(rendered, /All findings recorded/);
	});

	it("keeps failed, cancelled, and abandoned outcomes explicit", () => {
		const failed = extractBackgroundJobRecords([jobEntry(completionData({ status: "failed", error: "exploded during review", snapshot: undefined }))])[0];
		const failedBody = buildSessionBodyLines(failed, theme, 100).lines.join("\n");
		assert.match(failedBody, /Error: exploded during review/);

		const cancelled = extractBackgroundJobRecords([jobEntry(completionData({ status: "cancelled", snapshot: bgSnapshot({ status: "cancelled" }) }))])[0];
		assert.match(buildSessionBodyLines(cancelled, theme, 100).lines.join("\n"), /Cancelled — partial response below/);

		const abandoned = extractBackgroundJobRecords([jobEntry(completionData({ status: "abandoned", endedAt: T("09:36:00"), snapshot: undefined }))])[0];
		const abandonedBody = buildSessionBodyLines(abandoned, theme, 100).lines.join("\n");
		assert.match(abandonedBody, /Abandoned — the Claude Code process did not confirm termination/);
	});

	it("renders restored (JSON round-tripped) persisted entries identically", () => {
		const restoredEntry = JSON.parse(JSON.stringify(jobEntry(completionData())));
		const [record] = extractBackgroundJobRecords([restoredEntry]);
		assert.equal(record.malformed, undefined);
		const rendered = buildSessionBodyLines(record, theme, 120).lines.join("\n");
		assert.match(rendered, /All findings recorded/);
		const header = buildSessionHeaderLines(record, { index: 0, total: 1 }, theme).join("\n");
		assert.match(header, /Claude reviewer background job/);
	});
});

describe("unified overlay with live background jobs", () => {
	it("re-renders on manager transitions, keeps focus pinned on the running job, and unsubscribes on dispose", async () => {
		const jobs = new BackgroundJobManager({ idPrefix: "live", sleep: () => Promise.resolve(), now: () => T("10:30:00") });
		const pending = pendingExecutor();
		const record = jobs.spawn({ profile: "explorer", task: "explore the repo", requestedModel: "opus", launch: { cwd: "/tmp/project", capturedAt: 0 }, execute: pending.execute });
		const entries = mixedBranch();
		const load = loadMixed(entries, jobs);

		const tui = stubTui(40);
		const overlay = new ClaudeSessionsOverlay(tui, theme, kb, () => {}, load, undefined, jobs);
		let rendered = overlay.render(100).join("\n");
		assert.match(rendered, /record 4\/4/);
		assert.match(rendered, /Claude explorer background job/);
		assert.match(rendered, /running \(live\)/);

		const rendersBefore = tui.renders;
		pending.state.onSnapshot(bgSnapshot({ status: "running", resultText: undefined, responseText: "partial narration" }));
		assert.ok(tui.renders > rendersBefore, "manager snapshot transition repaints the open overlay");
		rendered = overlay.render(100).join("\n");
		assert.match(rendered, /model: claude-opus-runtime/);
		assert.match(rendered, /partial narration/);

		// A newer DelegateToClaude live call appends a record but must not steal the
		// pinned running-job selection.
		updateLiveAskClaudeCall({ toolCallId: "call-9", startedAt: T("10:45:00"), prompt: "live ask", details: { prompt: "live ask" } });
		rendered = overlay.render(100).join("\n");
		assert.match(rendered, /record 4\/5/);
		assert.match(rendered, /Claude explorer background job/);

		overlay.dispose();
		const rendersAfterDispose = tui.renders;
		pending.state.onSnapshot(bgSnapshot({ status: "running" }));
		updateLiveAskClaudeCall({ toolCallId: "call-9", startedAt: T("10:45:00"), prompt: "live ask", details: { prompt: "live ask 2" } });
		assert.equal(tui.renders, rendersAfterDispose, "both subscriptions are released on dispose");

		pending.resolve(runResult());
		await jobs.settled(record.id);
	});

	it("repaints a quiet running background header once per tick and stops ticking on dispose", async () => {
		const jobs = new BackgroundJobManager({ idPrefix: "tick", sleep: () => Promise.resolve(), now: () => T("10:30:00") });
		const pending = pendingExecutor();
		const record = jobs.spawn({ profile: "explorer", task: "wait", requestedModel: "opus", launch: { cwd: "/tmp/project", capturedAt: 0 }, execute: pending.execute });
		const tui = stubTui();
		let tick;
		let stopped = false;
		const overlay = new ClaudeSessionsOverlay(
			tui,
			theme,
			kb,
			() => {},
			loadMixed([], jobs),
			undefined,
			jobs,
			(onTick) => { tick = onTick; return () => { stopped = true; }; },
		);

		const before = tui.renders;
		tick();
		assert.equal(tui.renders, before + 1);
		overlay.dispose();
		assert.equal(stopped, true);
		tick();
		assert.equal(tui.renders, before + 1, "disposed overlay ignores later ticks");

		pending.resolve(runResult());
		await jobs.settled(record.id);
	});

	it("keeps a pinned settled record's parsed body cached across manager updates", () => {
		const entries = mixedBranch();
		const jobs = jobsStub([managerRecord()]);
		let bodyHeadings = 0;
		const countingTheme = {
			fg: (color, text) => {
				if (color === "muted" && String(text).startsWith("──")) bodyHeadings++;
				return text;
			},
			bold: (text) => text,
		};
		const tui = stubTui();
		const overlay = new ClaudeSessionsOverlay(tui, countingTheme, kb, () => {}, loadMixed(entries, jobs), (records) => requestedOverlayFocus(records, 2), jobs);
		assert.match(overlay.render(100).join("\n"), /record 2\/4.*Claude reviewer background job|Claude reviewer background job.*record 2\/4/);
		const headingsAfterInitialRender = bodyHeadings;

		jobs.emit(); // manager transition while pinned to an immutable persisted record
		assert.match(overlay.render(100).join("\n"), /record 2\/4/);
		assert.equal(bodyHeadings, headingsAfterInitialRender, "a manager update must not rebuild a pinned record's Markdown body");
		overlay.dispose();
		assert.equal(jobs.listenerCount(), 0);
	});

	it("navigates one flat list across both kinds", () => {
		const overlay = new ClaudeSessionsOverlay(stubTui(), theme, kb, () => {}, loadMixed(mixedBranch()));
		assert.match(overlay.render(100).join("\n"), /record 3\/3.*DelegateToClaude call|DelegateToClaude call.*record 3\/3/);
		overlay.handleInput("\x1b[D"); // left
		assert.match(overlay.render(100).join("\n"), /Claude reviewer background job/);
		overlay.handleInput("p");
		assert.match(overlay.render(100).join("\n"), /DelegateToClaude call/);
		overlay.handleInput("n");
		overlay.handleInput("\x1b[C");
		assert.match(overlay.render(100).join("\n"), /record 3\/3/);
		overlay.dispose();
	});

	it("stays within the terminal budget and width for background records on small terminals", () => {
		const overlay = new ClaudeSessionsOverlay(stubTui(10, 44), theme, kb, () => {}, loadMixed([jobEntry(completionData())]));
		const lines = overlay.render(40);
		assert.ok(lines.length <= 8, `rendered ${lines.length} lines for a 10-row terminal`);
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= 40, `line exceeds width: ${JSON.stringify(line)}`);
		}
		overlay.dispose();
	});
});

describe("unified overlay registration", () => {
	function register(entries, jobs = jobsStub()) {
		const commands = new Map();
		const shortcuts = new Map();
		const handle = registerClaudeSessionsUI({
			registerCommand: (name, command) => commands.set(name, command),
			registerShortcut: (key, shortcut) => shortcuts.set(key, shortcut),
		}, { toolName: "DelegateToClaude", jobs });

		const notifications = [];
		let active = null;
		let customCalls = 0;
		const ctx = {
			mode: "tui",
			sessionManager: { getBranch: () => entries },
			ui: {
				notify: (message, type) => notifications.push({ message, type }),
				custom: (factory) => new Promise((resolve) => {
					customCalls++;
					let component;
					const done = (value) => {
						component?.dispose();
						if (active === component) active = null;
						resolve(value);
					};
					component = factory(stubTui(), theme, kb, done);
					active = component;
				}),
			},
		};
		return { commands, shortcuts, handle, ctx, notifications, overlay: () => active, customCalls: () => customCalls };
	}

	it("registers /claude-details as the canonical command with a merged 1-based index", async () => {
		const { commands, ctx, overlay } = register(mixedBranch());
		assert.ok(commands.has("claude-details"));

		const opened = commands.get("claude-details").handler("", ctx);
		assert.match(overlay().render(100).join("\n"), /record 3\/3/);
		overlay().handleInput("q");
		await opened;

		const openedAt2 = commands.get("claude-details").handler("2", ctx);
		const rendered = overlay().render(100).join("\n");
		assert.match(rendered, /record 2\/3/);
		assert.match(rendered, /Claude reviewer background job/);
		overlay().handleInput("q");
		await openedAt2;
	});

	it("notifies honestly when the session has no Claude records", async () => {
		const { commands, ctx, notifications, customCalls } = register([]);
		await commands.get("claude-details").handler("", ctx);
		assert.equal(customCalls(), 0);
		assert.match(notifications[0].message, /No DelegateToClaude calls or background Claude jobs/);
	});

	it("keeps /askclaude-details as an unfiltered alias with DelegateToClaude-relative numbering", async () => {
		const { commands, ctx, overlay } = register(mixedBranch());
		assert.ok(commands.has("askclaude-details"));
		assert.match(commands.get("askclaude-details").description, /Alias of \/claude-details/);

		// <n> counts DelegateToClaude calls only: call #2 is merged record 3 of 3.
		const openedAt2 = commands.get("askclaude-details").handler("2", ctx);
		let rendered = overlay().render(100).join("\n");
		assert.match(rendered, /record 3\/3/);
		assert.match(rendered, /DelegateToClaude call/);
		// The overlay stays unfiltered: the background record is one step left.
		overlay().handleInput("\x1b[D");
		assert.match(overlay().render(100).join("\n"), /Claude reviewer background job/);
		overlay().handleInput("q");
		await openedAt2;

		// Without <n> it focuses the latest DelegateToClaude record even when a later
		// background record exists.
		const entries = [
			callEntry("call-1", "only ask", "2026-08-20T09:00:00.000Z"),
			resultEntry("call-1", askDetails()),
			jobEntry(completionData()),
		];
		const later = register(entries);
		const opened = later.commands.get("askclaude-details").handler("", later.ctx);
		rendered = later.overlay().render(100).join("\n");
		assert.match(rendered, /record 1\/2/);
		assert.match(rendered, /DelegateToClaude call/);
		later.overlay().handleInput("q");
		await opened;
	});

	it("keeps the compatibility alias honest when only background records exist", async () => {
		const { commands, ctx, notifications, customCalls } = register([jobEntry(completionData())]);
		await commands.get("askclaude-details").handler("", ctx);
		assert.equal(customCalls(), 0);
		assert.match(notifications[0].message, /No DelegateToClaude calls in this session branch/);
	});

	it("Ctrl+N toggles one owned overlay and focuses a running background job first", async () => {
		const jobs = jobsStub([managerRecord()]);
		const { shortcuts, ctx, overlay, customCalls } = register(mixedBranch(), jobs);
		const opened = shortcuts.get("ctrl+n").handler(ctx);
		const rendered = overlay().render(100).join("\n");
		assert.match(rendered, /Claude explorer background job/);
		assert.match(rendered, /running \(live\)/);

		await shortcuts.get("ctrl+n").handler(ctx); // toggle closes instead of opening a second overlay
		await opened;
		assert.equal(customCalls(), 1);
		assert.equal(overlay(), null);
	});

	it("opens for /claude-jobs focused on the running, else latest, background job and notifies when none exist", async () => {
		const { handle, ctx, overlay, notifications, customCalls } = register(mixedBranch());
		const opened = handle.openBackgroundJobs(ctx);
		const rendered = overlay().render(100).join("\n");
		assert.match(rendered, /record 2\/3/);
		assert.match(rendered, /Claude reviewer background job/);
		overlay().handleInput("q");
		await opened;

		const none = register([callEntry("call-1", "p", "2026-08-20T09:00:00.000Z")]);
		await none.handle.openBackgroundJobs(none.ctx);
		assert.equal(none.customCalls(), 0);
		assert.match(none.notifications[0].message, /No background Claude jobs in this session/);

		assert.equal(customCalls(), 1);
		assert.equal(notifications.length, 0);
	});

	it("requires the interactive TUI", async () => {
		const { handle, ctx, notifications, customCalls } = register(mixedBranch());
		ctx.mode = "print";
		await handle.openBackgroundJobs(ctx);
		assert.equal(customCalls(), 0);
		assert.match(notifications[0].message, /requires the interactive TUI/);
	});
});

describe("foreground SpawnClaudeAgent records in the unified list", () => {
	function spawnForegroundEntry(id, timestamp) {
		return messageEntry(
			{ role: "assistant", content: [{ type: "toolCall", id, name: "SpawnClaudeAgent", arguments: { task: "fix the bug", mode: "full", execution: "foreground" } }] },
			timestamp,
		);
	}
	function spawnForegroundResult(id) {
		return messageEntry({
			role: "toolResult",
			toolCallId: id,
			toolName: "SpawnClaudeAgent",
			content: [{ type: "text", text: "done" }],
			isError: false,
			details: askDetails({ origin: "spawn-foreground", profile: "worker", capabilityMode: "full" }),
		});
	}
	function mixedWithSpawn() {
		return [
			callEntry("call-1", "first ask", "2026-08-20T09:00:00.000Z"),
			resultEntry("call-1", askDetails()),
			spawnForegroundEntry("spawn-1", "2026-08-20T09:15:00.000Z"),
			spawnForegroundResult("spawn-1"),
			callEntry("call-2", "second ask", "2026-08-20T09:45:00.000Z"),
			resultEntry("call-2", askDetails()),
		];
	}
	const loadWithSpawn = () => mergeClaudeSessionRecords(
		extractAskClaudeCalls(mixedWithSpawn(), "DelegateToClaude", "SpawnClaudeAgent"),
		[],
	);

	it("merges foreground spawn calls as foreground Claude records in chronological order", () => {
		const records = loadWithSpawn();
		assert.deepEqual(records.map((record) => record.id), [
			"askclaude:call-1",
			"askclaude:spawn-1",
			"askclaude:call-2",
		]);
		assert.equal(records[1].call.origin, "spawn-foreground");
	});

	it("counts only actual DelegateToClaude compatibility calls for /askclaude-details numbering", () => {
		const records = loadWithSpawn();
		// Latest DelegateToClaude record is merged index 2, skipping the spawn record.
		assert.equal(askClaudeOverlayFocus(records).index, 2);
		assert.deepEqual(askClaudeOverlayFocus(records, 1), { index: 0, pinned: true });
		assert.equal(askClaudeOverlayFocus(records, 2).index, 2, "call #2 skips the foreground spawn record");

		const spawnOnly = mergeClaudeSessionRecords(
			extractAskClaudeCalls([spawnForegroundEntry("spawn-1"), spawnForegroundResult("spawn-1")], "DelegateToClaude", "SpawnClaudeAgent"),
			[],
		);
		assert.deepEqual(askClaudeOverlayFocus(spawnOnly), { index: -1, pinned: false }, "spawn foreground calls are not DelegateToClaude compatibility calls");
	});

	it("renders the spawn record body with a Task section over the same section renderer", () => {
		const records = loadWithSpawn();
		const spawnBody = buildSessionBodyLines(records[1], theme, 100);
		assert.match(spawnBody.lines.join("\n"), /── Task ──/);
		assert.deepEqual(spawnBody.sections.map((section) => section.title).slice(0, 2), ["Task", "Thinking"]);

		const askBody = buildSessionBodyLines(records[0], theme, 100);
		assert.equal(askBody.sections[0].title, "Prompt");
	});
});
