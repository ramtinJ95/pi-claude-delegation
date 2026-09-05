import { permissionAnnotations } from "./delegation-output.js";
// Background job UI adapter: the Phase 3b presentation and delivery layer for
// SpawnClaudeAgent jobs.
//
// The BackgroundJobManager stays the only owner of job lifecycle and retention;
// this module renders its records and transitions into Pi 0.84.2 surfaces:
//
// - a sticky live widget above the editor while a job runs;
// - /claude-jobs for human status inspection and cancellation, without adding
//   first-class model tools;
// - exactly-once terminal delivery per job: one bounded, session-persisted
//   TUI-only custom entry with reviewable details, and one bounded
//   model-visible custom message sent with
//   `sendMessage(..., { triggerTurn: false, deliverAs: "nextTurn" })`, which
//   Pi queues for the next turn without interrupting or triggering one.
//
// Settlements flagged `duringShutdown` by the manager (session shutdown, switch
// or reset) are never delivered: the session they belong to is being torn down
// and a replacement session must not receive them.

import { getMarkdownTheme, keyHint, type ExtensionAPI, type ExtensionContext, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { AGENT_PROFILE_IDS, agentCapabilityMode, type AgentProfileId } from "./agent-profiles.js";
import type { BackgroundJobManager, BackgroundJobRecord, BackgroundJobStatus } from "./background-jobs.js";
import type { DelegationSnapshot } from "./delegation-events.js";
import {
	buildSnapshotActionSummary,
	buildToolAggregateLine,
	formatToolAction,
	usageLine,
	type RenderTheme,
} from "./askclaude-ui.js";
import { managedPolicyLabels, type ManagedPolicySummary, type PermissionObservation } from "./query-policy.js";
import { assembleModelResult } from "./delegation-retention.js";

export const BACKGROUND_JOB_WIDGET_KEY = "claude-delegation-background-job";
/** Session-persisted TUI-only entry type for completed-job details. */
export const BACKGROUND_JOB_ENTRY_TYPE = "claude-background-job";
/** Model-visible custom message type for completion delivery. */
export const BACKGROUND_JOB_MESSAGE_TYPE = "claude-background-job-result";

/**
 * Bounded, redacted completed-job facts persisted in the custom entry. The
 * snapshot arrives already retained/redacted by the manager; nothing here may
 * hold raw or unbounded transcript data.
 */
export interface BackgroundJobCompletionData {
	jobId: string;
	profile: AgentProfileId;
	status: BackgroundJobStatus;
	task: string;
	requestedModel: string;
	thinking?: string;
	createdAt: number;
	endedAt?: number;
	launchCwd: string;
	diffSource?: string;
	error?: string;
	permission?: PermissionObservation;
	managedPolicy?: ManagedPolicySummary;
	snapshot?: DelegationSnapshot;
}

export function formatJobElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function statusPresentation(status: BackgroundJobStatus): { icon: string; color: string; label: string } {
	switch (status) {
		case "running": return { icon: "◉", color: "mdLink", label: "running" };
		case "succeeded": return { icon: "✓", color: "success", label: "succeeded" };
		case "failed": return { icon: "✗", color: "error", label: "failed" };
		case "cancelled": return { icon: "⊘", color: "warning", label: "cancelled" };
		case "abandoned": return { icon: "⊘", color: "warning", label: "abandoned" };
	}
}

const BACKGROUND_JOB_STATUSES = new Set<BackgroundJobStatus>([
	"running", "succeeded", "failed", "cancelled", "abandoned",
]);
const AGENT_PROFILES = new Set<AgentProfileId>(AGENT_PROFILE_IDS);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Persisted custom-entry data is untrusted across restores and package
 * versions. Validate every field this renderer and the Claude Sessions overlay
 * (claude-sessions.ts) dereference so a corrupt or forward-incompatible entry
 * degrades visibly instead of breaking transcript reconstruction or the
 * overlay.
 */
export function isRenderableCompletionData(value: unknown): value is BackgroundJobCompletionData {
	if (!isRecord(value)) return false;
	if (typeof value.jobId !== "string"
		|| typeof value.profile !== "string" || !AGENT_PROFILES.has(value.profile as AgentProfileId)
		|| typeof value.status !== "string" || !BACKGROUND_JOB_STATUSES.has(value.status as BackgroundJobStatus)
		|| typeof value.task !== "string"
		|| typeof value.requestedModel !== "string"
		|| typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)
		|| typeof value.launchCwd !== "string") return false;
	if (value.endedAt !== undefined && (typeof value.endedAt !== "number" || !Number.isFinite(value.endedAt))) return false;
	for (const key of ["thinking", "diffSource", "error"] as const) {
		if (value[key] !== undefined && typeof value[key] !== "string") return false;
	}
	if (value.snapshot === undefined) return true;
	if (!isRecord(value.snapshot)
		|| typeof value.snapshot.responseText !== "string"
		|| (value.snapshot.resultText !== undefined && typeof value.snapshot.resultText !== "string")
		|| (value.snapshot.thinkingText !== undefined && typeof value.snapshot.thinkingText !== "string")
		|| (value.snapshot.error !== undefined && typeof value.snapshot.error !== "string")
		|| typeof value.snapshot.startedAt !== "number" || !Number.isFinite(value.snapshot.startedAt)
		|| !Array.isArray(value.snapshot.tools)
		|| !value.snapshot.tools.every((tool) => isRecord(tool)
			&& typeof tool.id === "string"
			&& typeof tool.name === "string"
			&& typeof tool.status === "string"
			&& ["running", "succeeded", "failed", "denied"].includes(tool.status)
			&& (tool.output === undefined || typeof tool.output === "string")
			&& (tool.error === undefined || typeof tool.error === "string"))
		|| !Array.isArray(value.snapshot.timeline)
		|| !value.snapshot.timeline.every((event) => isRecord(event) && typeof event.at === "number" && Number.isFinite(event.at))
		|| !Array.isArray(value.snapshot.diagnostics)
		|| !value.snapshot.diagnostics.every(isRecord)
		|| !Array.isArray(value.snapshot.permissionDenials)
		|| !value.snapshot.permissionDenials.every((denial) => isRecord(denial) && typeof denial.toolName === "string")) return false;
	if (value.snapshot.usage !== undefined) {
		if (!isRecord(value.snapshot.usage)) return false;
		for (const key of ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "turns", "totalCostUsd"] as const) {
			if (typeof value.snapshot.usage[key] !== "number" || !Number.isFinite(value.snapshot.usage[key])) return false;
		}
	}
	if (value.snapshot.contextUsage !== undefined) {
		if (!isRecord(value.snapshot.contextUsage)) return false;
		for (const key of ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens"] as const) {
			if (typeof value.snapshot.contextUsage[key] !== "number"
				|| !Number.isFinite(value.snapshot.contextUsage[key])
				|| value.snapshot.contextUsage[key] < 0) return false;
		}
		if (value.snapshot.contextUsage.model !== undefined && typeof value.snapshot.contextUsage.model !== "string") return false;
		if (value.snapshot.contextUsage.contextWindow !== undefined
			&& (typeof value.snapshot.contextUsage.contextWindow !== "number"
				|| !Number.isFinite(value.snapshot.contextUsage.contextWindow)
				|| value.snapshot.contextUsage.contextWindow <= 0)) return false;
	}
	return true;
}

/** The most recent running tool as a short label, or the latest timeline label. */
export function currentJobAction(snapshot: DelegationSnapshot | undefined): string | undefined {
	if (!snapshot) return undefined;
	for (let i = snapshot.tools.length - 1; i >= 0; i--) {
		const tool = snapshot.tools[i];
		if (tool.status !== "running") continue;
		return formatToolAction({ name: tool.name, status: tool.status, rawInput: tool.input });
	}
	const last = snapshot.timeline[snapshot.timeline.length - 1];
	return last ? `${last.kind}: ${last.label}` : undefined;
}

/**
 * Compact live-widget lines for one running job: only Claude-job facts, at most
 * four lines (the fourth is the worker single-writer warning), each truncated to
 * the available width so the widget stays safe in fullscreen and small terminals.
 */
export function buildBackgroundJobWidgetLines(
	record: BackgroundJobRecord,
	theme: RenderTheme,
	width: number,
	nowMs: number,
): string[] {
	const fit = (text: string) => truncateToWidth(text, Math.max(10, width), "…");
	const snapshot = record.snapshot;
	const mode = agentCapabilityMode(record.profile);
	const status = statusPresentation(record.status);
	const elapsed = formatJobElapsed((record.endedAt ?? nowMs) - record.createdAt);
	const lines: string[] = [];

	lines.push(fit(
		`${theme.fg(status.color, status.icon)} ${theme.bold(`Claude ${record.profile} job`)} `
		+ `${theme.fg(status.color, status.label)} ${theme.fg("dim", elapsed)} · ${theme.fg("muted", record.id)}`,
	));

	const facts = [
		mode ? `mode ${mode}` : undefined,
		`model ${snapshot?.model ?? record.requestedModel}`,
		record.thinking ? `thinking ${record.thinking}` : undefined,
		snapshot?.runtimePermissionMode ? `permission ${snapshot.runtimePermissionMode}` : undefined,
		snapshot?.permissionDenials.length ? `${snapshot.permissionDenials.length} denied` : undefined,
	].filter(Boolean).join(" · ");
	if (facts) lines.push(fit(`  ${theme.fg("dim", facts)}`));

	const action = currentJobAction(snapshot) ?? "starting";
	const toolCount = (snapshot?.tools.length ?? 0) + (snapshot?.toolsOmitted ?? 0);
	const activity = [
		`now: ${action}`,
		toolCount ? `${toolCount} tool${toolCount === 1 ? "" : "s"}` : undefined,
		usageLine(snapshot, record.status === "running"),
		"Ctrl+N details",
		"/claude-jobs cancel to stop",
	].filter(Boolean).join(" · ");
	lines.push(fit(`  ${theme.fg("muted", activity)}`));

	if (record.profile === "worker") {
		lines.push(fit(`  ${theme.fg("warning", "⚠ single-writer: this job edits the current checkout — do not edit files until it settles")}`));
	}
	return lines;
}

interface WidgetTui {
	requestRender(): void;
}

/**
 * Live widget component. It renders the manager's current running record and
 * re-renders on manager transitions plus a coarse once-per-second tick for the
 * elapsed-time display; the registration layer removes the widget when no job
 * is running, so an empty render here is only a transient between the two.
 */
export class BackgroundJobLiveWidget {
	private readonly unsubscribe: () => void;
	private readonly stopTicking: () => void;

	constructor(
		private readonly tui: WidgetTui,
		private readonly theme: RenderTheme,
		private readonly jobs: Pick<BackgroundJobManager, "running" | "subscribe">,
		private readonly options?: {
			now?: () => number;
			/** Injectable tick scheduler; the default is an unref'd 1s interval. */
			scheduleTick?: (onTick: () => void) => () => void;
		},
	) {
		this.unsubscribe = jobs.subscribe(() => this.tui.requestRender());
		const schedule = options?.scheduleTick ?? ((onTick: () => void) => {
			const timer = setInterval(onTick, 1_000);
			timer.unref?.();
			return () => clearInterval(timer);
		});
		this.stopTicking = schedule(() => this.tui.requestRender());
	}

	render(width: number): string[] {
		const running = this.jobs.running();
		if (!running) return [];
		return buildBackgroundJobWidgetLines(running, this.theme, width, (this.options?.now ?? Date.now)());
	}

	invalidate(): void {
		// Every render reads the manager's current record; nothing is cached.
	}

	dispose(): void {
		this.stopTicking();
		this.unsubscribe();
	}
}

/** Bounded completed-job facts for the persisted custom entry. */
export function buildCompletionEntryData(record: BackgroundJobRecord): BackgroundJobCompletionData {
	return {
		jobId: record.id,
		profile: record.profile,
		status: record.status,
		task: record.task,
		requestedModel: record.requestedModel,
		...(record.thinking ? { thinking: record.thinking } : {}),
		createdAt: record.createdAt,
		...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
		launchCwd: record.launch.cwd,
		...(record.launch.diff ? { diffSource: record.launch.diff.source } : {}),
		...(record.error ? { error: record.error } : {}),
		...(record.permission ? { permission: record.permission } : {}),
		...(record.managedPolicy ? { managedPolicy: record.managedPolicy } : {}),
		...(record.snapshot ? { snapshot: record.snapshot } : {}),
	};
}

/**
 * Render the persisted completion entry. Works from entry data alone so
 * restored sessions render identically; a missing/malformed payload degrades
 * to a visible placeholder instead of throwing during transcript rebuild.
 */
export function renderBackgroundJobCompletion(
	data: BackgroundJobCompletionData | unknown,
	expanded: boolean,
	theme: RenderTheme,
): Component {
	const container = new Container();
	if (!isRenderableCompletionData(data)) {
		container.addChild(new Text(theme.fg("dim", "Background Claude job entry unavailable (missing or malformed data)."), 0, 0));
		return container;
	}
	const snapshot = data.snapshot;
	const mode = agentCapabilityMode(data.profile);
	const status = statusPresentation(data.status);
	const duration = data.endedAt !== undefined ? formatJobElapsed(data.endedAt - data.createdAt) : undefined;
	const toolCount = (snapshot?.tools.length ?? 0) + (snapshot?.toolsOmitted ?? 0);

	let header = theme.fg(status.color, `${status.icon} Claude ${data.profile} job ${status.label}`);
	if (duration) header += ` ${theme.fg("dim", duration)}`;
	header += ` ${theme.fg("muted", data.jobId)}`;
	if (toolCount) header += ` ${theme.fg("muted", `· ${toolCount} tool${toolCount === 1 ? "" : "s"}`)}`;
	container.addChild(new Text(header, 0, 0));

	if (!expanded) {
		if (data.error) container.addChild(new Text(theme.fg("error", `Error: ${data.error}`), 0, 0));
		const body = snapshot?.resultText ?? snapshot?.responseText ?? "";
		const preview = body.split("\n").slice(-3).join("\n");
		if (preview) container.addChild(new Text(theme.fg("toolOutput", preview), 0, 0));
		container.addChild(new Text(theme.fg("dim", keyHint("app.tools.expand", "to expand")), 0, 0));
		return container;
	}

	const permission = data.permission
		? data.permission.overridden
			? `${data.permission.requested} → ${data.permission.effective}`
			: data.permission.effective
		: snapshot?.runtimePermissionMode;
	const metadata = [
		mode ? `mode=${mode}` : undefined,
		`model=${snapshot?.model ?? data.requestedModel}`,
		data.thinking ? `thinking=${data.thinking}` : undefined,
		permission ? `permission=${permission}` : undefined,
		snapshot?.sessionId ? `session=${snapshot.sessionId.slice(0, 12)}` : undefined,
		`cwd=${data.launchCwd}`,
		data.diffSource ? `diff=${data.diffSource}` : undefined,
		usageLine(snapshot, data.status === "running"),
	].filter(Boolean).join(" · ");
	container.addChild(new Text(theme.fg("dim", metadata), 0, 0));

	const policyLabels = managedPolicyLabels(data.managedPolicy);
	if (policyLabels.length) container.addChild(new Text(theme.fg("warning", `Managed policy: ${policyLabels.join(", ")}`), 0, 0));
	if (snapshot?.permissionDenials.length) {
		const omitted = snapshot.permissionDenialsOmitted ? ` (${snapshot.permissionDenialsOmitted} earlier omitted)` : "";
		container.addChild(new Text(theme.fg("warning", `Permission denials${omitted}: ${snapshot.permissionDenials.map((item) => item.toolName).join(", ")}`), 0, 0));
	}
	if (data.error) container.addChild(new Text(theme.fg("error", `Error: ${data.error}`), 0, 0));

	const addSection = (title: string, body: string) => {
		if (!body) return;
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", title), 0, 0));
		container.addChild(new Markdown(body, 0, 0, getMarkdownTheme()));
	};
	addSection("── Task ──", data.task);
	if (snapshot && toolCount) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "── Actions ──"), 0, 0));
		const actions = buildSnapshotActionSummary(snapshot);
		if (actions) container.addChild(new Text(theme.fg("muted", actions), 0, 0));
		container.addChild(new Text(theme.fg("dim", buildToolAggregateLine(snapshot)), 0, 0));
	}
	addSection("── Response ──", snapshot?.resultText ?? snapshot?.responseText ?? "");
	return container;
}

function outcomeHeadline(record: BackgroundJobRecord): string {
	const duration = record.endedAt !== undefined ? ` after ${formatJobElapsed(record.endedAt - record.createdAt)}` : "";
	const mode = agentCapabilityMode(record.profile);
	const subject = `Background Claude job ${record.id} (${mode ? `${mode}, ` : ""}${record.profile})`;
	switch (record.status) {
		case "succeeded":
			return `[${subject} completed${duration}.]`;
		case "failed":
			return `[${subject} failed${duration}: ${record.error ?? record.snapshot?.error ?? "unknown error"}]`;
		case "cancelled":
			return `[${subject} was cancelled${duration}.]`;
		case "abandoned":
			return `[${subject} was abandoned${duration}: its Claude Code process did not confirm termination and no result is available.]`;
		case "running":
			// Delivery only happens on settled transitions; stay honest if a caller
			// ever formats a non-terminal record anyway.
			return `[${subject} is still running.]`;
	}
}

/**
 * The bounded model-visible completion text. Terminal outcomes stay explicit:
 * a failure, cancellation, or abandonment can never read as a successful empty
 * answer, and a success with no output text says so instead of being blank.
 */
export function buildCompletionMessageText(record: BackgroundJobRecord): string {
	const snapshot = record.snapshot;
	const headline = outcomeHeadline(record);
	const output = snapshot?.resultText ?? snapshot?.responseText ?? "";

	let body: string;
	switch (record.status) {
		case "succeeded":
			body = output || "The job reported success but produced no output text.";
			break;
		case "cancelled":
			body = output ? `Partial output before cancellation:\n\n${output}` : "No output was produced before cancellation.";
			break;
		default:
			// failed/abandoned: the headline carries the explicit failure; partial
			// streamed narration is not presented as if it were a result.
			body = "";
			break;
	}

	const annotations = permissionAnnotations({
		permission: record.permission,
		managedPolicy: record.managedPolicy,
		permissionDenials: snapshot?.permissionDenials ?? [],
	});
	const actions = snapshot ? buildSnapshotActionSummary(snapshot) : "";

	return assembleModelResult({
		answer: body ? `${headline}\n\n${body}` : headline,
		actions: actions ? `[Claude Code actions: ${actions}]` : "",
		annotations,
	});
}

/** One compact human-readable status line per job for /claude-jobs. */
export function buildJobStatusLines(records: BackgroundJobRecord[], nowMs: number): string[] {
	if (records.length === 0) {
		return ["No background Claude jobs in this session. Start one with the SpawnClaudeAgent tool."];
	}
	const lines = records.map((record) => {
		const status = statusPresentation(record.status);
		const mode = agentCapabilityMode(record.profile);
		const elapsed = formatJobElapsed((record.endedAt ?? nowMs) - record.createdAt);
		const facts = [
			record.profile,
			mode ? `mode ${mode}` : undefined,
			record.status === "running" ? `running ${elapsed}` : `${status.label} after ${elapsed}`,
			`model ${record.snapshot?.model ?? record.requestedModel}`,
			record.thinking ? `thinking ${record.thinking}` : undefined,
			record.status === "failed" && record.error ? `error: ${record.error.split("\n")[0]}` : undefined,
		].filter(Boolean).join(" · ");
		return `${status.icon} ${record.id} — ${facts}`;
	});
	if (records.some((record) => record.status === "running")) {
		lines.push("Cancel the running job with /claude-jobs cancel");
	}
	return lines;
}

/** Injected seams for `registerBackgroundJobUI`; unit tests replace them all. */
export interface BackgroundJobUIDeps {
	/** Shares the DelegateToClaude/SpawnClaudeAgent opt-in for live behavior. */
	enabled: boolean;
	jobs: Pick<BackgroundJobManager, "subscribe" | "running" | "list" | "get" | "cancel">;
	now?: () => number;
	onDebug?: (message: string) => void;
	/**
	 * Opens the unified Claude Sessions overlay focused on background jobs.
	 * Owned by claude-sessions-overlay.ts — this module never registers a
	 * competing overlay; outside the TUI (or without the handle) `/claude-jobs`
	 * keeps its textual status output.
	 */
	openSessionsOverlay?: (ctx: ExtensionContext) => Promise<void>;
}

type BackgroundJobUIPi = Pick<
	ExtensionAPI,
	"on" | "registerCommand" | "registerEntryRenderer" | "appendEntry" | "sendMessage"
>;

/**
 * Wire the background-job UI into Pi. Everything renders from the manager's
 * bounded records; this module keeps no job state of its own beyond the widget
 * visibility flag and the captured UI handle for the current session.
 */
export function registerBackgroundJobUI(pi: BackgroundJobUIPi, deps: BackgroundJobUIDeps): void {
	// Restored entries must remain renderable after the user disables new
	// DelegateToClaude/SpawnClaudeAgent work. Only live behavior is feature-gated.
	pi.registerEntryRenderer<BackgroundJobCompletionData>(BACKGROUND_JOB_ENTRY_TYPE, (entry, options, theme) =>
		renderBackgroundJobCompletion(entry.data, options.expanded, theme));
	if (!deps.enabled) return;
	const { jobs } = deps;
	const now = deps.now ?? Date.now;
	let ui: ExtensionUIContext | undefined;
	let widgetVisible = false;

	const clearWidget = () => {
		if (!ui || !widgetVisible) return;
		ui.setWidget(BACKGROUND_JOB_WIDGET_KEY, undefined);
		widgetVisible = false;
	};
	const refreshWidget = () => {
		if (!ui) return;
		if (!jobs.running()) {
			clearWidget();
			return;
		}
		if (widgetVisible) return; // the live component re-renders itself on manager transitions
		ui.setWidget(BACKGROUND_JOB_WIDGET_KEY, (tui, theme) => new BackgroundJobLiveWidget(tui, theme, jobs, { now }));
		widgetVisible = true;
	};

	const deliverCompletion = (record: BackgroundJobRecord) => {
		deps.onDebug?.(`background job ${record.id}: delivering ${record.status} completion (entry + nextTurn message)`);
		pi.appendEntry(BACKGROUND_JOB_ENTRY_TYPE, buildCompletionEntryData(record));
		// Pi 0.84.2 queues this for the next turn: it records the custom message
		// without interrupting an active run or triggering a new one.
		pi.sendMessage(
			{
				customType: BACKGROUND_JOB_MESSAGE_TYPE,
				content: buildCompletionMessageText(record),
				display: false,
				details: { jobId: record.id, profile: record.profile, status: record.status },
			},
			{ triggerTurn: false, deliverAs: "nextTurn" },
		);
		ui?.notify(`Background Claude job ${record.id} ${record.status}; details in the transcript, result queued for the model's next turn.`, record.status === "succeeded" ? "info" : "warning");
	};

	// The manager emits exactly one `settled` transition per job (terminal states
	// are first-wins), which is what makes this delivery exactly-once. Shutdown
	// and reset settlements are suppressed: their session is being torn down and
	// the replacement session must not receive them.
	jobs.subscribe((transition) => {
		switch (transition.type) {
			case "spawned":
			case "updated":
			case "cleared":
				refreshWidget();
				break;
			case "settled":
				refreshWidget();
				if (!transition.duringShutdown) deliverCompletion(transition.record);
				break;
		}
	});

	pi.on("session_start", (_event, ctx) => {
		ui = ctx.mode === "tui" ? ctx.ui : undefined;
		widgetVisible = false;
		refreshWidget();
	});
	pi.on("session_shutdown", () => {
		clearWidget();
		ui = undefined;
	});

	pi.registerCommand("claude-jobs", {
		description: "Inspect background Claude jobs; \"/claude-jobs cancel [job-id]\" cancels the running one",
		handler: async (args, ctx) => {
			const [verb, jobId] = args.trim().split(/\s+/).filter(Boolean);
			if (!verb) {
				// In the TUI this opens the unified Claude Sessions overlay focused
				// on the running (else latest) background job; the textual status
				// listing remains the non-TUI behavior.
				if (ctx.mode === "tui" && deps.openSessionsOverlay) {
					await deps.openSessionsOverlay(ctx);
					return;
				}
				ctx.ui.notify(buildJobStatusLines(jobs.list(), now()).join("\n"), "info");
				return;
			}
			if (verb !== "cancel") {
				ctx.ui.notify(`Unknown /claude-jobs argument "${verb}". Use "/claude-jobs" or "/claude-jobs cancel [job-id]".`, "warning");
				return;
			}
			const targetId = jobId ?? jobs.running()?.id;
			if (!targetId) {
				ctx.ui.notify("No background Claude job is running.", "warning");
				return;
			}
			const record = jobs.get(targetId);
			if (!record) {
				ctx.ui.notify(`Unknown background job ${targetId}: it is not in this session's records.`, "warning");
				return;
			}
			if (!jobs.cancel(targetId)) {
				ctx.ui.notify(`Background job ${targetId} is not running (status: ${record.status}); nothing to cancel.`, "warning");
				return;
			}
			ctx.ui.notify(`Cancellation requested for ${targetId}; it settles as cancelled once Claude Code confirms the interrupt.`, "info");
		},
	});
}
