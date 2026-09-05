// Unified Claude Sessions view model: one flat chronological list across
// DelegateToClaude calls and background SpawnClaudeAgent jobs for the Claude Sessions
// overlay (claude-sessions-overlay.ts).
//
// Everything here is pure over already-persisted session-branch entries, the
// DelegateToClaude live slot, and the BackgroundJobManager's bounded records. No new
// raw or unbounded data enters the overlay: DelegateToClaude records reuse the
// persisted tool-call/result pairs and retained snapshots, background records
// reuse the bounded `claude-background-job` completion entries (validated by
// the same guard the transcript renderer uses) or the manager's retained
// record normalized through the same completion-data shape.

import type { AskClaudeCallRecord, AskClaudeCallStatus, OverlayBody } from "./askclaude-details.js";
import {
	buildOverlayBodyLines,
	buildOverlayHeaderLines,
	selectCallIndex,
	statusPresentation,
	usageText,
	UNAVAILABLE,
} from "./askclaude-details.js";
import { contextUsageLine, type AskClaudeResultDetails, type RenderTheme } from "./askclaude-ui.js";
import { agentCapabilityMode } from "./agent-profiles.js";
import type { BackgroundJobRecord, BackgroundJobStatus } from "./background-jobs.js";
import {
	BACKGROUND_JOB_ENTRY_TYPE,
	buildCompletionEntryData,
	formatJobElapsed,
	isRenderableCompletionData,
	type BackgroundJobCompletionData,
} from "./background-job-ui.js";
import { managedPolicyLabels } from "./query-policy.js";

export interface AskClaudeSessionRecord {
	kind: "askclaude";
	/** Stable id, namespaced so DelegateToClaude and background records never collide. */
	id: string;
	/** Normalized start timestamp in epoch ms, when known. */
	startMs?: number;
	call: AskClaudeCallRecord;
}

export interface BackgroundSessionRecord {
	kind: "background";
	id: string;
	startMs?: number;
	/** True while the record is backed by the live manager record of a running job. */
	live?: boolean;
	/** Validated bounded completion data (persisted entry or normalized manager record). */
	data?: BackgroundJobCompletionData;
	/** The persisted entry failed validation; render a visible placeholder, never throw. */
	malformed?: boolean;
}

export type ClaudeSessionRecord = AskClaudeSessionRecord | BackgroundSessionRecord;

function backgroundRecordId(jobId: string): string {
	return `background:${jobId}`;
}

interface CustomEntryLike {
	type?: string;
	customType?: string;
	timestamp?: string;
	data?: unknown;
}

function parseIsoMs(timestamp: string | undefined): number | undefined {
	if (!timestamp) return undefined;
	const ms = Date.parse(timestamp);
	return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Read persisted background-job completion entries from real session-branch
 * entries. Validation is the exact guard the transcript renderer uses, so a
 * malformed or forward-incompatible entry becomes a visible placeholder record
 * instead of throwing or silently disappearing from the list.
 */
export function extractBackgroundJobRecords(entries: readonly unknown[]): BackgroundSessionRecord[] {
	const records: BackgroundSessionRecord[] = [];
	const byId = new Map<string, number>();
	let malformedCount = 0;
	for (const raw of entries) {
		const entry = raw as CustomEntryLike;
		if (entry?.type !== "custom" || entry.customType !== BACKGROUND_JOB_ENTRY_TYPE) continue;
		const branchMs = parseIsoMs(entry.timestamp);
		if (!isRenderableCompletionData(entry.data)) {
			const jobId = (entry.data as { jobId?: unknown } | null | undefined)?.jobId;
			const id = typeof jobId === "string" ? backgroundRecordId(jobId) : `background:malformed:${++malformedCount}`;
			records.push({ kind: "background", id, startMs: branchMs, malformed: true });
			continue;
		}
		const data = entry.data;
		const record: BackgroundSessionRecord = {
			kind: "background",
			id: backgroundRecordId(data.jobId),
			startMs: Number.isFinite(data.createdAt) ? data.createdAt : branchMs,
			data,
		};
		// A duplicate persisted entry for the same job keeps its first branch
		// position but shows the most recently persisted data.
		const existing = byId.get(record.id);
		if (existing !== undefined) records[existing] = { ...record, startMs: records[existing].startMs };
		else {
			byId.set(record.id, records.length);
			records.push(record);
		}
	}
	return records;
}

/**
 * Merge persisted completion entries with the manager's in-memory records,
 * deduplicated by job ID. The persisted completion entry wins for settled
 * records; the manager record supplies running state (a completion entry for a
 * still-running job cannot exist) and is the terminal fallback when persistence
 * is absent (e.g. non-TUI sessions or suppressed delivery). A manager record
 * also replaces a malformed persisted placeholder for the same job.
 */
export function mergeBackgroundJobRecords(
	persisted: BackgroundSessionRecord[],
	managerRecords: readonly BackgroundJobRecord[],
): BackgroundSessionRecord[] {
	const merged = [...persisted];
	const indexById = new Map(merged.map((record, index) => [record.id, index]));
	for (const record of managerRecords) {
		const id = backgroundRecordId(record.id);
		const existing = indexById.get(id);
		// Persisted terminal data already wins; do not normalize its shadow.
		if (existing !== undefined && record.status !== "running" && !merged[existing].malformed) continue;
		const view = normalizedManagerRecord(record);
		if (existing === undefined) {
			indexById.set(view.id, merged.length);
			merged.push(view);
		} else if (record.status === "running" || merged[existing].malformed) {
			merged[existing] = view;
		}
	}
	return merged;
}

// Manager updates replace records, so identity is a revision key. Weak keys
// retain neither evicted jobs nor old snapshots, and keep Markdown caches valid
// for unchanged terminal fallbacks while a different job publishes progress.
const normalizedManagerRecords = new WeakMap<BackgroundJobRecord, BackgroundSessionRecord>();
function normalizedManagerRecord(record: BackgroundJobRecord): BackgroundSessionRecord {
	let view = normalizedManagerRecords.get(record);
	if (!view) {
		view = {
			kind: "background",
			id: backgroundRecordId(record.id),
			startMs: record.createdAt,
			...(record.status === "running" ? { live: true } : {}),
			data: buildCompletionEntryData(record),
		};
		normalizedManagerRecords.set(record, view);
	}
	return view;
}

/**
 * One flat chronological list across both kinds. DelegateToClaude ISO timestamps and
 * background epoch timestamps are already normalized to epoch ms; records with
 * no timestamp inherit their predecessor's within the same source list, so the
 * deterministic branch order is the fallback (stable sort keeps ties in
 * concatenation order: DelegateToClaude before background).
 */
export function mergeClaudeSessionRecords(
	calls: readonly AskClaudeCallRecord[],
	background: readonly BackgroundSessionRecord[],
): ClaudeSessionRecord[] {
	const ask: ClaudeSessionRecord[] = calls.map((call) => ({
		kind: "askclaude",
		id: `askclaude:${call.toolCallId}`,
		startMs: parseIsoMs(call.timestamp),
		call,
	}));
	const keyed: Array<{ record: ClaudeSessionRecord; sortMs: number }> = [];
	for (const list of [ask, background as readonly ClaudeSessionRecord[]]) {
		let previous = Number.NEGATIVE_INFINITY;
		for (const record of list) {
			previous = record.startMs ?? previous;
			keyed.push({ record, sortMs: previous });
		}
	}
	return keyed.sort((a, b) => a.sortMs - b.sortMs).map((item) => item.record);
}

export function isRunningBackground(record: ClaudeSessionRecord): boolean {
	return record.kind === "background" && record.data?.status === "running";
}

export interface OverlayFocus {
	index: number;
	/** Pin the selection to this record across live updates instead of following the latest. */
	pinned: boolean;
}

/**
 * Ctrl+N / `/claude-details` default focus: a running background job first
 * (pinned, so live updates cannot steal the selection), otherwise the
 * chronologically latest record (followed across live updates).
 */
export function defaultOverlayFocus(records: readonly ClaudeSessionRecord[]): OverlayFocus {
	const running = records.findIndex(isRunningBackground);
	if (running >= 0) return { index: running, pinned: true };
	return { index: records.length - 1, pinned: false };
}

/** `/claude-details <n>`: a 1-based index into the merged chronological list, clamped. */
export function requestedOverlayFocus(records: readonly ClaudeSessionRecord[], requested: number): OverlayFocus {
	const index = selectCallIndex(records.length, requested);
	return { index, pinned: index >= 0 && index < records.length - 1 };
}

/**
 * `/askclaude-details [n]` compatibility: `n` counts actual DelegateToClaude
 * compatibility calls only — not foreground SpawnClaudeAgent calls or
 * background jobs — preserving the command's original numbering, and maps to
 * the merged record. Without `n`, focus the latest DelegateToClaude record.
 * `index: -1` means no DelegateToClaude record exists, so the compatibility command
 * can preserve its old honest no-calls response instead of unexpectedly
 * opening on another record kind.
 */
export function askClaudeOverlayFocus(records: readonly ClaudeSessionRecord[], requested?: number): OverlayFocus {
	const askIndexes = records.flatMap((record, index) => (record.kind === "askclaude" && record.call.origin === undefined ? [index] : []));
	if (askIndexes.length === 0) return { index: -1, pinned: false };
	const index = askIndexes[selectCallIndex(askIndexes.length, requested)];
	return { index, pinned: index < records.length - 1 };
}

/**
 * `/claude-jobs` focus: the running background job first, else the latest
 * background job. `index: -1` means no background jobs exist and the caller
 * must say so instead of opening.
 */
export function backgroundJobsOverlayFocus(records: readonly ClaudeSessionRecord[]): OverlayFocus {
	const running = records.findIndex(isRunningBackground);
	if (running >= 0) return { index: running, pinned: true };
	for (let index = records.length - 1; index >= 0; index--) {
		if (records[index].kind === "background") return { index, pinned: index < records.length - 1 };
	}
	return { index: -1, pinned: false };
}

function backgroundCallStatus(status: BackgroundJobStatus): AskClaudeCallStatus {
	switch (status) {
		case "running": return "running";
		case "succeeded": return "completed";
		case "failed": return "failed";
		case "cancelled": return "cancelled";
		case "abandoned": return "abandoned";
	}
}

const MALFORMED_NOTICE = "Background Claude job entry unavailable (missing or malformed data).";

function backgroundHeaderLines(
	record: BackgroundSessionRecord,
	position: { index: number; total: number },
	theme: RenderTheme,
	nowMs: number,
): string[] {
	const data = record.data;
	if (!data) {
		return [
			theme.fg("muted", `• ${theme.bold("Background Claude job")}`) +
			theme.fg("muted", ` · record ${position.index + 1}/${position.total}`),
			theme.fg("dim", MALFORMED_NOTICE),
		];
	}
	const snapshot = data.snapshot;
	const mode = agentCapabilityMode(data.profile) ?? UNAVAILABLE;
	const status = statusPresentation(backgroundCallStatus(data.status));
	const when = Number.isFinite(data.createdAt) ? new Date(data.createdAt).toLocaleString() : UNAVAILABLE;
	const elapsed = formatJobElapsed((data.endedAt ?? nowMs) - data.createdAt);
	const lines: string[] = [];

	lines.push(
		theme.fg(status.color, `${status.icon} ${theme.bold(`Claude ${data.profile} background job`)}`) +
		theme.fg("muted", ` · record ${position.index + 1}/${position.total} · ${data.status}${record.live ? " (live)" : ""} · ${elapsed} · ${when}`),
	);
	const model = snapshot?.model
		? `${snapshot.model}${data.requestedModel && data.requestedModel !== snapshot.model ? ` (requested ${data.requestedModel})` : ""}`
		: data.requestedModel
			? `${UNAVAILABLE} (requested ${data.requestedModel})`
			: UNAVAILABLE;
	const permission = data.permission
		? data.permission.overridden
			? `${data.permission.requested} → ${data.permission.effective}`
			: data.permission.effective
		: snapshot?.runtimePermissionMode ?? UNAVAILABLE;
	lines.push(theme.fg("dim", `mode: ${mode} · model: ${model} · session: ${snapshot?.sessionId ?? UNAVAILABLE} · permission: ${permission}`));
	lines.push(theme.fg("dim", `cwd: ${data.launchCwd}${data.diffSource ? ` · diff: ${data.diffSource}` : ""}`));
	const running = data.status === "running";
	lines.push(theme.fg("dim", contextUsageLine(snapshot, running) ?? `context: ${running ? "pending" : UNAVAILABLE}`));
	lines.push(theme.fg("dim", usageText(snapshot, running)));
	lines.push(theme.fg("dim", [
		`job: ${data.jobId}`,
		data.thinking ? `thinking: ${data.thinking}` : undefined,
	].filter(Boolean).join(" · ")));

	const policyLabels = managedPolicyLabels(data.managedPolicy);
	if (policyLabels.length) lines.push(theme.fg("warning", `managed policy: ${policyLabels.join(", ")}`));
	if (snapshot?.permissionDenials?.length) {
		const omitted = snapshot.permissionDenialsOmitted ? ` (${snapshot.permissionDenialsOmitted} earlier omitted)` : "";
		lines.push(theme.fg("warning", `permission denials${omitted}: ${snapshot.permissionDenials.map((item) => item.toolName).join(", ")}`));
	}
	if (snapshot?.retry) lines.push(theme.fg("warning", `retry ${snapshot.retry.attempt}/${snapshot.retry.maxRetries}: ${snapshot.retry.error}`));
	if (snapshot?.rateLimit) lines.push(theme.fg("warning", `rate limit: ${snapshot.rateLimit.status}`));
	return lines;
}

/** Shape a background record as the same call-record body input DelegateToClaude uses. */
function backgroundCallRecord(record: BackgroundSessionRecord): AskClaudeCallRecord | undefined {
	const data = record.data;
	if (!data) return undefined;
	const details: AskClaudeResultDetails = {
		prompt: data.task,
		capabilityMode: agentCapabilityMode(data.profile),
		executionTime: data.endedAt !== undefined ? data.endedAt - data.createdAt : undefined,
		requestedModel: data.requestedModel,
		thinking: data.thinking,
		error: data.status === "failed" || data.status === "abandoned" ? true : undefined,
		cancelled: data.status === "cancelled" ? true : undefined,
		permission: data.permission,
		managedPolicy: data.managedPolicy,
		permissionDenials: data.snapshot?.permissionDenials,
		snapshot: data.snapshot,
	};
	return {
		toolCallId: data.jobId,
		prompt: data.task,
		details,
		status: backgroundCallStatus(data.status),
		live: record.live,
	};
}

/** Pinned header lines for either record kind, with clear kind/profile/status labels. */
export function buildSessionHeaderLines(
	record: ClaudeSessionRecord,
	position: { index: number; total: number },
	theme: RenderTheme,
	nowMs: number = Date.now(),
): string[] {
	if (record.kind === "askclaude") return buildOverlayHeaderLines(record.call, position, theme);
	return backgroundHeaderLines(record, position, theme, nowMs);
}

/**
 * Scrollable body lines for either record kind. Both reuse the same section
 * renderer — Prompt/Task, Thinking, Tools, Timeline, Response, Diagnostics —
 * over already retained/redacted data.
 */
export function buildSessionBodyLines(record: ClaudeSessionRecord, theme: RenderTheme, width: number): OverlayBody {
	if (record.kind === "askclaude") {
		return buildOverlayBodyLines(record.call, theme, width,
			record.call.origin === "spawn-foreground" ? { promptTitle: "Task" } : undefined);
	}
	const call = backgroundCallRecord(record);
	if (!call) return { lines: [theme.fg("dim", MALFORMED_NOTICE)], sections: [] };
	return buildOverlayBodyLines(call, theme, width, {
		promptTitle: "Task",
		failureText: record.data?.error,
	});
}
