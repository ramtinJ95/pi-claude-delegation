// Rendering helpers for the DelegateToClaude tool.
//
// While Claude Code runs inside an DelegateToClaude call, Pi has one stateful tool row
// for the whole delegation. Compact rendering summarizes it; expanded rendering
// adds the retained response, thinking summaries, a grouped action/status
// summary, usage, session and permission state. Per-tool inputs/outputs,
// durations, nesting, and the retained timeline are deep-inspection surfaces
// owned exclusively by the Claude Sessions overlay (claude-sessions-overlay.ts).
// The provider path still exposes tools directly through Pi and does not use
// this renderer.

import { getMarkdownTheme, keyHint } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import { retainDelegationSnapshot, type DelegationPermissionDenial, type DelegationSnapshot, type DelegationToolCall } from "./delegation-events.js";
import {
	PROMPT_MAX_CHARS,
	retainActionSummary,
	retainText,
} from "./delegation-retention.js";
import { managedPolicyLabels, type ManagedPolicySummary, type PermissionObservation } from "./query-policy.js";

export const PREVIEW_MAX_CHARS = 1000;
export const PREVIEW_MAX_LINES = 6;

export interface AskClaudeResultDetails {
	prompt?: string;
	executionTime?: number;
	actions?: string;
	capabilityMode?: "full" | "read" | "none";
	requestedModel?: string;
	thinking?: string;
	isolated?: boolean;
	error?: boolean;
	cancelled?: boolean;
	/** Marks a foreground SpawnClaudeAgent result; absent on DelegateToClaude compatibility calls. */
	origin?: "spawn-foreground";
	/** SpawnClaudeAgent profile of a foreground call, for labels only. */
	profile?: string;
	permission?: PermissionObservation;
	permissionDenials?: DelegationPermissionDenial[];
	managedPolicy?: ManagedPolicySummary;
	snapshot?: DelegationSnapshot;
}

export interface RenderTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

interface RenderResult {
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
}

interface RenderContext {
	lastComponent?: Component;
}

export function retainAskClaudePrompt(prompt: string): string {
	return retainText(prompt, PROMPT_MAX_CHARS);
}

export interface ToolCallState {
	name: string;
	status: string;
	rawInput?: unknown;
}

export function extractPath(rawInput: unknown): string | undefined {
	if (!rawInput || typeof rawInput !== "object") return undefined;
	const input = rawInput as Record<string, unknown>;
	if (typeof input.file_path === "string") return input.file_path;
	if (typeof input.path === "string") return input.path;
	if (typeof input.command === "string") return input.command.substring(0, 80);
	return undefined;
}

export function shortPath(p: string): string {
	const cwd = process.cwd();
	if (p.startsWith(cwd + "/")) return p.slice(cwd.length + 1);
	if (p.startsWith("/")) {
		const parts = p.split("/");
		if (parts.length > 3) return parts.slice(-2).join("/");
	}
	return p;
}

export function formatToolAction(tc: ToolCallState): string | undefined {
	const path = extractPath(tc.rawInput);
	const verb = tc.name.toLowerCase().split(/\s/)[0];
	if (verb === "read" || verb === "readfile") {
		return path ? `Read(${shortPath(path)})` : "Read";
	} else if (verb === "glob") {
		const input = tc.rawInput as Record<string, unknown> | undefined;
		const pat = typeof input?.pattern === "string" ? input.pattern.slice(0, 40) : "";
		return pat ? `Glob(${pat})` : "Glob";
	} else if (verb === "edit" || verb === "write" || verb === "writefile" || verb === "multiedit") {
		return path ? `Edit(${shortPath(path)})` : "Edit";
	} else if (verb === "bashoutput") {
		return undefined; // redundant with preceding Bash call
	} else if (verb === "bash" || verb === "terminal") {
		return path ? `Bash(${path})` : "Bash";
	} else if (verb === "agent") {
		const input = tc.rawInput as Record<string, unknown> | undefined;
		return `Agent(${String(input?.description ?? "").slice(0, 40)})`;
	} else if (verb === "grep") {
		const input = tc.rawInput as Record<string, unknown> | undefined;
		const pat = typeof input?.pattern === "string" ? input.pattern.slice(0, 40) : "";
		return pat ? `Grep(${pat})` : "Grep";
	} else if (verb === "skill") {
		const input = tc.rawInput as Record<string, unknown> | undefined;
		const name = typeof input?.skill === "string" ? input.skill.slice(0, 40) : "";
		return name ? `Skill(${name})` : "Skill";
	} else if (verb === "todowrite" || verb === "taskcreate" || verb === "taskupdate") {
		const todos = Array.isArray((tc.rawInput as any)?.todos) ? (tc.rawInput as any).todos : [];
		const current = todos.find((t: any) => t.status === "in_progress") ?? todos.find((t: any) => t.status === "pending");
		const label = current ? String(current.content ?? "").slice(0, 40) : "";
		return label || undefined;
	} else if (verb === "askclaude") {
		// Recursive — don't show DelegateToClaude in its own action summary
		return undefined;
	}
	return tc.name;
}

export function buildActionSummary(calls: Map<string, ToolCallState>): string {
	const parts: string[] = [];
	let prevVerb = "";
	for (const [, tc] of calls) {
		const action = formatToolAction(tc);
		if (!action) continue;
		const verb = tc.name.toLowerCase().split(/\s/)[0];
		// Collapse consecutive calls to the same tool — keep only the latest
		if (verb === prevVerb) {
			parts[parts.length - 1] = action;
		} else {
			parts.push(action);
		}
		prevVerb = verb;
	}
	return parts.join("; ");
}

/** Build the action summary from an already-retained snapshot, then redact and bound it. */
export function buildSnapshotActionSummary(snapshot: DelegationSnapshot): string {
	const calls = new Map<string, ToolCallState>();
	for (const tool of snapshot.tools) {
		calls.set(tool.id, { name: tool.name, status: tool.status, rawInput: tool.input });
	}
	return retainActionSummary(buildActionSummary(calls));
}

/**
 * One aggregate status line for the expanded inline row. The total counts every
 * tool the snapshot represents (retained plus omitted); status counts cover
 * only the retained tools, so an omission note explains any shortfall instead
 * of claiming a status for calls whose details were discarded.
 */
export function buildToolAggregateLine(snapshot: DelegationSnapshot): string {
	const counts = { running: 0, succeeded: 0, failed: 0, denied: 0 };
	for (const tool of snapshot.tools) counts[tool.status]++;
	const omitted = snapshot.toolsOmitted ?? 0;
	const total = snapshot.tools.length + omitted;
	const breakdown = (["running", "succeeded", "failed", "denied"] as const)
		.filter((status) => counts[status] > 0)
		.map((status) => `${counts[status]} ${status}`)
		.join(" · ");
	const omittedNote = omitted ? ` (details of ${omitted} earlier no longer retained)` : "";
	return `${total} tool${total === 1 ? "" : "s"}${omittedNote}${breakdown ? `: ${breakdown}` : ""}`;
}

export function buildAskClaudePartialUpdate(
	snapshot: DelegationSnapshot,
	input: {
		prompt: string;
		executionTime: number;
		capabilityMode: "full" | "read" | "none";
		requestedModel: string;
		thinking?: string;
		isolated: boolean;
	},
): { content: Array<{ type: "text"; text: string }>; details: AskClaudeResultDetails } {
	const retained = retainDelegationSnapshot(snapshot);
	const actions = buildSnapshotActionSummary(retained);
	return {
		content: [{ type: "text", text: actions || "working..." }],
		details: {
			prompt: retainAskClaudePrompt(input.prompt),
			executionTime: input.executionTime,
			actions,
			capabilityMode: input.capabilityMode,
			requestedModel: input.requestedModel,
			thinking: input.thinking,
			isolated: input.isolated,
			permissionDenials: retained.permissionDenials,
			snapshot: retained,
		},
	};
}

export function formatToolDuration(tool: DelegationToolCall): string {
	const ms = tool.durationMs ?? (tool.elapsedSeconds == null ? undefined : tool.elapsedSeconds * 1000);
	if (ms == null) return "";
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function toolStatusIcon(tool: DelegationToolCall, theme: RenderTheme): string {
	switch (tool.status) {
		case "succeeded": return theme.fg("success", "✓");
		case "failed": return theme.fg("error", "✗");
		case "denied": return theme.fg("warning", "⊘");
		case "running": return theme.fg("mdLink", "◉");
	}
}

export function valueMarkdown(value: unknown): string {
	if (typeof value === "string") return value;
	try { return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``; }
	catch { return String(value); }
}

function addSection(container: Container, title: string, body: string): void {
	if (!body) return;
	container.addChild(new Spacer(1));
	container.addChild(new Text(title, 0, 0));
	container.addChild(new Markdown(body, 0, 0, getMarkdownTheme()));
}

function contextTokens(snapshot?: DelegationSnapshot): number | undefined {
	const usage = snapshot?.contextUsage;
	if (!usage) return undefined;
	return usage.inputTokens + usage.outputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
}

export function contextUsageLine(snapshot?: DelegationSnapshot, running = snapshot?.status === "running"): string | undefined {
	const tokens = contextTokens(snapshot);
	if (tokens === undefined) return undefined;
	const contextWindow = snapshot?.contextUsage?.contextWindow;
	if (!contextWindow) return `context: ${tokens.toLocaleString()} used · window ${running ? "pending" : "unavailable"}`;
	return `context: ${tokens.toLocaleString()} / ${contextWindow.toLocaleString()} (${(tokens / contextWindow * 100).toFixed(1)}%)`;
}

export function runUsageLine(snapshot?: DelegationSnapshot): string | undefined {
	const usage = snapshot?.usage;
	if (!usage) return undefined;
	const tokens = `${usage.inputTokens.toLocaleString()} in / ${usage.outputTokens.toLocaleString()} out`;
	const cache = usage.cacheReadInputTokens || usage.cacheCreationInputTokens
		? ` · cache ${usage.cacheReadInputTokens.toLocaleString()} read / ${usage.cacheCreationInputTokens.toLocaleString()} write`
		: "";
	return `run: ${tokens}${cache} · ${usage.turns} turns · $${usage.totalCostUsd.toFixed(4)}`;
}

export function usageLine(snapshot?: DelegationSnapshot, running = snapshot?.status === "running"): string | undefined {
	const parts = [contextUsageLine(snapshot, running), runUsageLine(snapshot)].filter((part): part is string => Boolean(part));
	return parts.length ? parts.join(" · ") : undefined;
}

/** Render both streaming partials and the final result from the same retained snapshot. */
export function renderAskClaudeResult(
	result: RenderResult,
	options: { expanded: boolean; isPartial: boolean },
	theme: RenderTheme,
	context: RenderContext,
	requestedPermissionMode: string,
): Component {
	const details = result.details as AskClaudeResultDetails | undefined;
	const snapshot = details?.snapshot;
	const contentText = result.content[0]?.type === "text" ? result.content[0].text ?? "" : "";
	const body = snapshot?.resultText ?? snapshot?.responseText ?? contentText;
	const failed = !details?.cancelled && (details?.error || snapshot?.status === "failed");
	const failureText = failed ? snapshot?.error ?? contentText : "";
	const container = context.lastComponent instanceof Container ? context.lastComponent : new Container();
	container.clear();

	const status = details?.cancelled || snapshot?.status === "cancelled"
		? { icon: "⊘", color: "warning", label: "cancelled" }
		: details?.error || snapshot?.status === "failed"
			? { icon: "✗", color: "error", label: "error" }
			: options.isPartial || snapshot?.status === "running"
				? { icon: "◉", color: "mdLink", label: "running" }
				: { icon: "✓", color: "success", label: "complete" };
	let header = theme.fg(status.color, `${status.icon} Claude Code ${status.label}`);
	if (details?.executionTime != null) header += ` ${theme.fg("dim", `${(details.executionTime / 1000).toFixed(1)}s`)}`;
	if (snapshot?.tools.length || snapshot?.toolsOmitted) {
		const running = snapshot.tools.filter((tool) => tool.status === "running").length;
		const total = snapshot.tools.length + (snapshot.toolsOmitted ?? 0);
		header += ` ${theme.fg("muted", `${total} tool${total === 1 ? "" : "s"}${running ? ` · ${running} active` : ""}`)}`;
	}
	container.addChild(new Text(header, 0, 0));

	if (!options.expanded) {
		if (failureText) container.addChild(new Text(theme.fg("error", failureText.startsWith("Error:") ? failureText : `Error: ${failureText}`), 0, 0));
		const actions = details?.actions || (snapshot ? buildSnapshotActionSummary(snapshot) : "");
		if (actions) container.addChild(new Text(theme.fg("muted", actions), 0, 0));
		const preview = body.split("\n").slice(-3).join("\n");
		if (preview) container.addChild(new Text(theme.fg("toolOutput", preview), 0, 0));
		if (snapshot?.retry) container.addChild(new Text(theme.fg("warning", `Retry ${snapshot.retry.attempt}/${snapshot.retry.maxRetries} in ${(snapshot.retry.delayMs / 1000).toFixed(1)}s`), 0, 0));
		if (!options.isPartial && (body.split("\n").length > 3 || snapshot?.tools.length || snapshot?.thinkingText)) {
			container.addChild(new Text(theme.fg("dim", keyHint("app.tools.expand", "to expand")), 0, 0));
		}
		return container;
	}

	const policyLabels = managedPolicyLabels(details?.managedPolicy);
	const permission = details?.permission
		? details.permission.overridden
			? `${details.permission.requested} → ${details.permission.effective}`
			: details.permission.effective
		: snapshot?.runtimePermissionMode ?? requestedPermissionMode;
	const metadata = [
		snapshot?.model || details?.requestedModel ? `model=${snapshot?.model ?? details?.requestedModel}` : undefined,
		details?.profile ? `profile=${details.profile}` : undefined,
		details?.capabilityMode ? `capability=${details.capabilityMode}` : undefined,
		details?.thinking ? `thinking=${details.thinking}` : undefined,
		details?.isolated == null ? undefined : `conversation=${details.isolated ? "isolated" : "shared"}`,
		`permission=${permission}`,
		snapshot?.sessionId ? `session=${snapshot.sessionId.slice(0, 12)}` : undefined,
		snapshot?.cwd ? `cwd=${snapshot.cwd}` : undefined,
		usageLine(snapshot),
	].filter(Boolean).join(" · ");
	if (metadata) container.addChild(new Text(theme.fg("dim", metadata), 0, 0));
	if (policyLabels.length) container.addChild(new Text(theme.fg("warning", `Managed policy: ${policyLabels.join(", ")}`), 0, 0));
	if (details?.permissionDenials?.length) {
		const omitted = snapshot?.permissionDenialsOmitted ? ` (${snapshot.permissionDenialsOmitted} earlier omitted)` : "";
		container.addChild(new Text(theme.fg("warning", `Permission denials${omitted}: ${details.permissionDenials.map((item) => item.toolName).join(", ")}`), 0, 0));
	}
	if (snapshot?.rateLimit) container.addChild(new Text(theme.fg("warning", `Rate limit: ${snapshot.rateLimit.status}`), 0, 0));
	if (snapshot?.retry) container.addChild(new Text(theme.fg("warning", `Retry ${snapshot.retry.attempt}/${snapshot.retry.maxRetries}: ${snapshot.retry.error}`), 0, 0));
	if (failureText) container.addChild(new Text(theme.fg("error", failureText.startsWith("Error:") ? failureText : `Error: ${failureText}`), 0, 0));

	if (details?.prompt) addSection(
		container,
		theme.fg("muted", details.origin === "spawn-foreground" ? "── Task ──" : "── Prompt ──"),
		details.prompt,
	);
	if (snapshot?.thinkingText) addSection(container, theme.fg("muted", "── Emitted thinking summary ──"), snapshot.thinkingText);

	if (snapshot && (snapshot.tools.length || snapshot.toolsOmitted)) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "── Actions ──"), 0, 0));
		const actions = details?.actions || buildSnapshotActionSummary(snapshot);
		if (actions) container.addChild(new Text(theme.fg("muted", actions), 0, 0));
		container.addChild(new Text(theme.fg("dim", buildToolAggregateLine(snapshot)), 0, 0));
		container.addChild(new Text(theme.fg("dim", "Per-tool inputs/outputs, durations, and timeline: /claude-details (ctrl+n)"), 0, 0));
	}
	if (body) addSection(container, theme.fg("muted", "── Response ──"), body);
	if (snapshot?.diagnostics.length) {
		container.addChild(new Spacer(1));
		const omitted = snapshot.diagnosticsOmitted ? ` (${snapshot.diagnosticsOmitted} earlier omitted)` : "";
		container.addChild(new Text(theme.fg("warning", `Diagnostics${omitted}: ${snapshot.diagnostics.map((item) => item.label).join(", ")}`), 0, 0));
	}
	return container;
}
