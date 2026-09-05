import type {
	ModelUsage,
	PermissionMode,
	SDKAssistantMessageError,
	SDKMessage,
	SDKRateLimitInfo,
	SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
	MODEL_RESULT_MAX_CHARS,
	RETAINED_LIST_MAX_ITEMS,
	THINKING_MAX_CHARS,
	TIMELINE_MAX_CHARS,
	TIMELINE_MAX_EVENTS,
	TOOL_CALL_MAX_ITEMS,
	TOOL_FIELD_MAX_CHARS,
	appendRetainedText,
	retainText,
	retainTailTextWithOmissions,
	retainTextWithOmissions,
	retainToolValue,
} from "./delegation-retention.js";

export type DelegationStatus = "running" | "succeeded" | "failed" | "cancelled";
export type DelegationToolStatus = "running" | "succeeded" | "failed" | "denied";

export interface DelegationUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	totalCostUsd: number;
	turns: number;
	durationMs: number;
	durationApiMs: number;
	modelUsage: Record<string, ModelUsage>;
}

/** Latest top-level Claude turn, kept separate from cumulative run usage. */
export interface DelegationContextUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	/** Runtime model ID from the latest top-level message_start, when reported. */
	model?: string;
	/** Served window reported authoritatively by the terminal result. */
	contextWindow?: number;
}

type DelegationContextUsageUpdate = Partial<Omit<DelegationContextUsage, "model" | "contextWindow">>
	& Pick<DelegationContextUsage, "model" | "contextWindow">;

export interface DelegationToolCall {
	id: string;
	name: string;
	status: DelegationToolStatus;
	input?: unknown;
	output?: string;
	error?: string;
	startedAt: number;
	updatedAt: number;
	completedAt?: number;
	durationMs?: number;
	elapsedSeconds?: number;
	parentToolUseId: string | null;
}

export interface DelegationPermissionDenial {
	toolName: string;
	toolUseId: string;
	reasonType?: string;
	reason?: string;
	message: string;
}

export interface DelegationDiagnostic {
	kind: "unhandled_sdk_message" | "unknown_stream_event";
	label: string;
	at: number;
}

export interface DelegationTimelineEntry {
	at: number;
	kind: string;
	label: string;
	toolUseId?: string;
	parentToolUseId?: string | null;
}

export interface DelegationSnapshot {
	status: DelegationStatus;
	startedAt: number;
	updatedAt: number;
	responseText: string;
	responseOmittedChars: number;
	resultText?: string;
	resultOmittedChars?: number;
	thinkingText: string;
	thinkingOmittedChars: number;
	tools: DelegationToolCall[];
	toolsOmitted?: number;
	timeline: DelegationTimelineEntry[];
	timelineOmitted: number;
	permissionDenials: DelegationPermissionDenial[];
	permissionDenialsOmitted?: number;
	diagnostics: DelegationDiagnostic[];
	diagnosticsOmitted?: number;
	sessionId?: string;
	cwd?: string;
	model?: string;
	runtimePermissionMode?: PermissionMode;
	resultSubtype?: string;
	stopReason?: string | null;
	error?: string;
	assistantError?: SDKAssistantMessageError;
	usage?: DelegationUsage;
	contextUsage?: DelegationContextUsage;
	rateLimit?: SDKRateLimitInfo;
	retry?: {
		attempt: number;
		maxRetries: number;
		delayMs: number;
		status: number | null;
		error: string;
	};
}

export type DelegationEvent =
	| { type: "session"; at: number; sessionId: string; cwd: string; model: string; permissionMode: PermissionMode }
	| { type: "text_delta"; at: number; text: string }
	| { type: "thinking_delta"; at: number; text: string }
	| { type: "tool_start"; at: number; id: string; name: string; input?: unknown; parentToolUseId: string | null }
	| { type: "tool_input"; at: number; id: string; name: string; input: unknown; parentToolUseId: string | null }
	| { type: "tool_progress"; at: number; id: string; name: string; elapsedSeconds: number; parentToolUseId: string | null }
	| { type: "tool_result"; at: number; id: string; output: string; isError: boolean; parentToolUseId: string | null }
	| { type: "assistant_error"; at: number; error: SDKAssistantMessageError }
	| { type: "permission_denial"; at: number; denial: DelegationPermissionDenial }
	| { type: "context_usage"; at: number; usage: DelegationContextUsageUpdate; reset: boolean }
	| { type: "usage"; at: number; usage: DelegationUsage }
	| { type: "result"; at: number; subtype: string; stopReason: string | null; resultText?: string }
	| { type: "retry"; at: number; attempt: number; maxRetries: number; delayMs: number; status: number | null; error: string }
	| { type: "rate_limit"; at: number; info: SDKRateLimitInfo }
	| { type: "diagnostic"; at: number; kind: DelegationDiagnostic["kind"]; label: string };

export function createDelegationSnapshot(startedAt = Date.now()): DelegationSnapshot {
	return {
		status: "running",
		startedAt,
		updatedAt: startedAt,
		responseText: "",
		responseOmittedChars: 0,
		thinkingText: "",
		thinkingOmittedChars: 0,
		tools: [],
		timeline: [],
		timelineOmitted: 0,
		permissionDenials: [],
		diagnostics: [],
	};
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
	return content.map((block) => {
		if (!block || typeof block !== "object") return String(block);
		const item = block as Record<string, unknown>;
		if (item.type === "text" && typeof item.text === "string") return item.text;
		if (item.type === "image") return "[image]";
		return JSON.stringify(item);
	}).join("\n");
}

function usageFromResult(message: Record<string, any>): DelegationUsage | undefined {
	if (!message.usage) return undefined;
	return {
		inputTokens: message.usage.input_tokens ?? 0,
		outputTokens: message.usage.output_tokens ?? 0,
		cacheReadInputTokens: message.usage.cache_read_input_tokens ?? 0,
		cacheCreationInputTokens: message.usage.cache_creation_input_tokens ?? 0,
		totalCostUsd: message.total_cost_usd ?? 0,
		turns: message.num_turns ?? 0,
		durationMs: message.duration_ms ?? 0,
		durationApiMs: message.duration_api_ms ?? 0,
		modelUsage: message.modelUsage ?? {},
	};
}

function contextUsageFromStream(usage: Record<string, any> | undefined, model?: unknown): DelegationContextUsageUpdate | undefined {
	if (!usage) return undefined;
	// Server-side tools can cause several sampling iterations. The top-level
	// fields are cumulative billing counts; the SDK documents the final
	// iteration as the true context size for the request.
	const iterations = Array.isArray(usage.iterations) ? usage.iterations : [];
	const source = iterations.length ? iterations[iterations.length - 1] : usage;
	const field = (name: string): number | undefined => {
		const value = source?.[name];
		return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
	};
	const fields: DelegationContextUsageUpdate = {
		inputTokens: field("input_tokens"),
		outputTokens: field("output_tokens"),
		cacheReadInputTokens: field("cache_read_input_tokens"),
		cacheCreationInputTokens: field("cache_creation_input_tokens"),
	};
	for (const key of Object.keys(fields) as Array<keyof typeof fields>) {
		if (fields[key] === undefined) delete fields[key];
	}
	if (!Object.keys(fields).length && typeof model !== "string") return undefined;
	return {
		...fields,
		...(typeof model === "string" ? { model } : {}),
	};
}

/** Convert one raw Agent SDK message into stable delegation events. */
export function normalizeDelegationMessage(message: SDKMessage, at = Date.now()): DelegationEvent[] {
	if (message.type === "stream_event") {
		const event = message.event as any;
		// These are per-request values, unlike the terminal result's cumulative
		// usage. Keep only top-level turns: nested Agent frames carry a parent ID
		// and describe the subagent's separate context rather than this session.
		if (event?.type === "message_start") {
			if (message.parent_tool_use_id) return [];
			const usage = contextUsageFromStream(event.message?.usage, event.message?.model);
			return usage ? [{ type: "context_usage", at, usage, reset: true }] : [];
		}
		if (event?.type === "message_delta") {
			if (message.parent_tool_use_id) return [];
			const usage = contextUsageFromStream(event.usage);
			return usage ? [{ type: "context_usage", at, usage, reset: false }] : [];
		}
		if (event?.type === "content_block_start") {
			if (event.content_block?.type === "tool_use") {
				return [{
					type: "tool_start",
					at,
					id: event.content_block.id,
					name: event.content_block.name,
					input: event.content_block.input,
					parentToolUseId: message.parent_tool_use_id,
				}];
			}
			return [];
		}
		if (event?.type === "content_block_delta") {
			if (event.delta?.type === "text_delta") {
				return [{ type: "text_delta", at, text: event.delta.text ?? "" }];
			}
			if (event.delta?.type === "thinking_delta") {
				return [{ type: "thinking_delta", at, text: event.delta.thinking ?? "" }];
			}
			if (event.delta?.type === "input_json_delta" || event.delta?.type === "signature_delta") return [];
			return [{ type: "diagnostic", at, kind: "unknown_stream_event", label: `content_block_delta:${event.delta?.type ?? "unknown"}` }];
		}
		if (["message_stop", "content_block_stop"].includes(event?.type)) return [];
		return [{ type: "diagnostic", at, kind: "unknown_stream_event", label: event?.type ?? "unknown" }];
	}

	if (message.type === "assistant") {
		const events: DelegationEvent[] = [];
		if (message.error) events.push({ type: "assistant_error", at, error: message.error });
		for (const block of message.message?.content ?? []) {
			if (block.type === "tool_use") {
				events.push({ type: "tool_input", at, id: block.id, name: block.name, input: block.input, parentToolUseId: message.parent_tool_use_id });
			}
		}
		return events;
	}

	if (message.type === "user") {
		if ((message as { isReplay?: boolean }).isReplay) return [];
		const events: DelegationEvent[] = [];
		const content = Array.isArray(message.message?.content) ? message.message.content : [];
		for (const block of content) {
			if (block.type !== "tool_result") continue;
			events.push({
				type: "tool_result",
				at,
				id: block.tool_use_id,
				output: contentText(block.content),
				isError: block.is_error === true,
				parentToolUseId: message.parent_tool_use_id,
			});
		}
		return events;
	}

	if (message.type === "tool_progress") {
		return [{
			type: "tool_progress",
			at,
			id: message.tool_use_id,
			name: message.tool_name,
			elapsedSeconds: message.elapsed_time_seconds,
			parentToolUseId: message.parent_tool_use_id,
		}];
	}

	if (message.type === "result") {
		const raw = message as Record<string, any>;
		const events: DelegationEvent[] = [];
		for (const denial of message.permission_denials ?? []) {
			events.push({
				type: "permission_denial",
				at,
				denial: {
					toolName: denial.tool_name,
					toolUseId: denial.tool_use_id,
					message: "Denied by Claude Code permission policy",
				},
			});
		}
		const usage = usageFromResult(raw);
		if (usage) events.push({ type: "usage", at, usage });
		events.push({
			type: "result",
			at,
			subtype: message.subtype,
			stopReason: message.stop_reason,
			resultText: message.subtype === "success" && !message.is_error ? message.result : undefined,
		});
		return events;
	}

	if (message.type === "system") {
		if (message.subtype === "init") {
			return [{
				type: "session",
				at,
				sessionId: message.session_id,
				cwd: message.cwd,
				model: message.model,
				permissionMode: message.permissionMode,
			}];
		}
		if (message.subtype === "permission_denied") {
			return [{
				type: "permission_denial",
				at,
				denial: {
					toolName: message.tool_name,
					toolUseId: message.tool_use_id,
					reasonType: message.decision_reason_type,
					reason: message.decision_reason,
					message: message.message,
				},
			}];
		}
		if (message.subtype === "api_retry") {
			return [{
				type: "retry",
				at,
				attempt: message.attempt,
				maxRetries: message.max_retries,
				delayMs: message.retry_delay_ms,
				status: message.error_status,
				error: message.error,
			}];
		}
		if (["status", "compact_boundary"].includes(message.subtype)) return [];
		return [{ type: "diagnostic", at, kind: "unhandled_sdk_message", label: `system:${message.subtype}` }];
	}

	if (message.type === "rate_limit_event") {
		return [{ type: "rate_limit", at, info: message.rate_limit_info }];
	}

	return [{ type: "diagnostic", at, kind: "unhandled_sdk_message", label: message.type }];
}

function upsertTool(
	tools: DelegationToolCall[],
	id: string,
	create: () => DelegationToolCall,
	update: (tool: DelegationToolCall) => DelegationToolCall,
): DelegationToolCall[] {
	const index = tools.findIndex((tool) => tool.id === id);
	if (index < 0) return [...tools, create()];
	const next = [...tools];
	next[index] = update(next[index]);
	return next;
}

/**
 * Parent relation for a tool already present in the snapshot.
 *
 * The `tool_use` block is authoritative for where a call sits in the subagent
 * tree; progress and result frames only echo it. Treat a missing echo as
 * "unchanged" so a late frame cannot flatten a nested call to the top level.
 */
function echoedParent(tool: DelegationToolCall, echoed: string | null): string | null {
	return echoed ?? tool.parentToolUseId;
}

function timelineEntryForEvent(
	event: DelegationEvent,
	snapshot: DelegationSnapshot,
): DelegationTimelineEntry | undefined {
	switch (event.type) {
		case "text_delta":
		case "thinking_delta":
		case "tool_progress":
			return undefined;
		case "session":
			return { at: event.at, kind: "session", label: `${event.model} · permission=${event.permissionMode}` };
		case "tool_start":
			return { at: event.at, kind: "tool_start", label: event.name, toolUseId: event.id, parentToolUseId: event.parentToolUseId };
		case "tool_input":
			return snapshot.tools.some((tool) => tool.id === event.id)
				? undefined
				: { at: event.at, kind: "tool_start", label: event.name, toolUseId: event.id, parentToolUseId: event.parentToolUseId };
		case "tool_result":
			return { at: event.at, kind: event.isError ? "tool_failed" : "tool_succeeded", label: event.isError ? "failed" : "completed", toolUseId: event.id, parentToolUseId: event.parentToolUseId };
		case "assistant_error":
			return { at: event.at, kind: "assistant_error", label: String(event.error) };
		case "permission_denial":
			return { at: event.at, kind: "permission_denial", label: `${event.denial.toolName}: ${event.denial.message}`, toolUseId: event.denial.toolUseId };
		case "context_usage":
			return undefined;
		case "usage":
			return { at: event.at, kind: "usage", label: `${event.usage.turns} turns · ${event.usage.outputTokens} output tokens` };
		case "result":
			return { at: event.at, kind: "result", label: `${event.subtype}${event.stopReason ? ` · ${event.stopReason}` : ""}` };
		case "retry":
			return { at: event.at, kind: "retry", label: `${event.attempt}/${event.maxRetries}: ${event.error}` };
		case "rate_limit":
			return { at: event.at, kind: "rate_limit", label: `${event.info.status ?? "update"}` };
		case "diagnostic":
			return { at: event.at, kind: event.kind, label: event.label };
	}
}

function canonicalModelId(model: string): string {
	return model.replace(/-\d{8}$/, "");
}

function servedContextWindow(
	context: DelegationContextUsage | undefined,
	modelUsage: Record<string, ModelUsage>,
): number | undefined {
	const entries = Object.entries(modelUsage)
		.filter(([, usage]) => Number.isFinite(usage.contextWindow) && usage.contextWindow > 0);
	if (!entries.length) return undefined;
	if (context?.model) {
		const model = canonicalModelId(context.model);
		const match = entries.find(([id]) => canonicalModelId(id) === model);
		if (match) return match[1].contextWindow;
		return undefined;
	}
	return entries.length === 1 ? entries[0][1].contextWindow : undefined;
}

function appendTimeline(
	snapshot: DelegationSnapshot,
	entry: DelegationTimelineEntry | undefined,
): Pick<DelegationSnapshot, "timeline" | "timelineOmitted"> {
	if (!entry) return { timeline: snapshot.timeline, timelineOmitted: snapshot.timelineOmitted };
	const nextEntry = { ...entry, label: retainText(entry.label, TOOL_FIELD_MAX_CHARS) };
	let timeline = [...snapshot.timeline, nextEntry];
	let omitted = snapshot.timelineOmitted;
	while (timeline.length > TIMELINE_MAX_EVENTS || JSON.stringify(timeline).length > TIMELINE_MAX_CHARS) {
		timeline = timeline.slice(1);
		omitted++;
	}
	return { timeline, timelineOmitted: omitted };
}

/**
 * Apply one normalized event without mutating the prior snapshot.
 *
 * Status stays `running` through a `result` event on purpose: no single message
 * tells the reducer whether the iterator then completed, was interrupted, or
 * died. `runDelegation` owns the terminal status.
 */
export function reduceDelegationEvent(
	snapshot: DelegationSnapshot,
	event: DelegationEvent,
): DelegationSnapshot {
	const base = {
		...snapshot,
		...appendTimeline(snapshot, timelineEntryForEvent(event, snapshot)),
		updatedAt: event.at,
	};
	switch (event.type) {
		case "session":
			return {
				...base,
				sessionId: event.sessionId,
				cwd: event.cwd,
				model: event.model,
				runtimePermissionMode: event.permissionMode,
			};
		case "text_delta": {
			const retained = appendRetainedText(snapshot.responseText, event.text, MODEL_RESULT_MAX_CHARS, snapshot.responseOmittedChars);
			return { ...base, responseText: retained.text, responseOmittedChars: retained.omittedChars };
		}
		case "thinking_delta": {
			const combined = snapshot.thinkingText + event.text;
			const newlyOmitted = Math.max(0, combined.length - THINKING_MAX_CHARS);
			return {
				...base,
				thinkingText: newlyOmitted ? combined.slice(-THINKING_MAX_CHARS) : combined,
				thinkingOmittedChars: snapshot.thinkingOmittedChars + newlyOmitted,
			};
		}
		case "tool_start":
			return {
				...base,
				tools: upsertTool(snapshot.tools, event.id,
					() => ({ id: event.id, name: event.name, status: "running", input: retainToolValue(event.input), startedAt: event.at, updatedAt: event.at, parentToolUseId: event.parentToolUseId }),
					(tool) => ({ ...tool, name: event.name, input: event.input === undefined ? tool.input : retainToolValue(event.input), updatedAt: event.at, parentToolUseId: event.parentToolUseId })),
			};
		case "tool_input":
			return {
				...base,
				tools: upsertTool(snapshot.tools, event.id,
					() => ({ id: event.id, name: event.name, status: "running", input: retainToolValue(event.input), startedAt: event.at, updatedAt: event.at, parentToolUseId: event.parentToolUseId }),
					(tool) => ({ ...tool, name: event.name, input: retainToolValue(event.input), updatedAt: event.at, parentToolUseId: event.parentToolUseId })),
			};
		case "tool_progress":
			return {
				...base,
				tools: upsertTool(snapshot.tools, event.id,
					() => ({ id: event.id, name: event.name, status: "running", startedAt: event.at, updatedAt: event.at, elapsedSeconds: event.elapsedSeconds, parentToolUseId: event.parentToolUseId }),
					(tool) => ({ ...tool, updatedAt: event.at, elapsedSeconds: event.elapsedSeconds, parentToolUseId: echoedParent(tool, event.parentToolUseId) })),
			};
		case "tool_result":
			return {
				...base,
				tools: upsertTool(snapshot.tools, event.id,
					() => ({
						id: event.id,
						name: "unknown",
						status: event.isError ? "failed" : "succeeded",
						output: retainText(event.output, TOOL_FIELD_MAX_CHARS),
						error: event.isError ? retainText(event.output, TOOL_FIELD_MAX_CHARS) : undefined,
						startedAt: event.at,
						updatedAt: event.at,
						completedAt: event.at,
						durationMs: 0,
						parentToolUseId: event.parentToolUseId,
					}),
					(tool) => ({
						...tool,
						status: event.isError ? "failed" : "succeeded",
						output: retainText(event.output, TOOL_FIELD_MAX_CHARS),
						error: event.isError ? retainText(event.output, TOOL_FIELD_MAX_CHARS) : undefined,
						updatedAt: event.at,
						completedAt: event.at,
						durationMs: Math.max(0, event.at - tool.startedAt),
						parentToolUseId: echoedParent(tool, event.parentToolUseId),
					})),
			};
		case "permission_denial": {
			const duplicate = snapshot.permissionDenials.some((item) => item.toolUseId === event.denial.toolUseId);
			return {
				...base,
				permissionDenials: duplicate ? snapshot.permissionDenials : [...snapshot.permissionDenials, {
					...event.denial,
					reason: event.denial.reason ? retainText(event.denial.reason, TOOL_FIELD_MAX_CHARS) : undefined,
					message: retainText(event.denial.message, TOOL_FIELD_MAX_CHARS),
				}],
				tools: upsertTool(snapshot.tools, event.denial.toolUseId,
					() => ({ id: event.denial.toolUseId, name: event.denial.toolName, status: "denied", error: retainText(event.denial.message, TOOL_FIELD_MAX_CHARS), startedAt: event.at, updatedAt: event.at, completedAt: event.at, durationMs: 0, parentToolUseId: null }),
					(tool) => ({ ...tool, status: "denied", error: retainText(event.denial.message, TOOL_FIELD_MAX_CHARS), updatedAt: event.at, completedAt: event.at, durationMs: Math.max(0, event.at - tool.startedAt) })),
			};
		}
		case "context_usage": {
			const prior = event.reset ? undefined : snapshot.contextUsage;
			const model = event.usage.model ?? prior?.model;
			const contextWindow = event.usage.contextWindow ?? prior?.contextWindow;
			return {
				...base,
				contextUsage: {
					inputTokens: event.usage.inputTokens ?? prior?.inputTokens ?? 0,
					outputTokens: event.usage.outputTokens ?? prior?.outputTokens ?? 0,
					cacheReadInputTokens: event.usage.cacheReadInputTokens ?? prior?.cacheReadInputTokens ?? 0,
					cacheCreationInputTokens: event.usage.cacheCreationInputTokens ?? prior?.cacheCreationInputTokens ?? 0,
					...(model ? { model } : {}),
					...(contextWindow ? { contextWindow } : {}),
				},
			};
		}
		case "usage": {
			const contextWindow = servedContextWindow(snapshot.contextUsage, event.usage.modelUsage);
			return {
				...base,
				usage: event.usage,
				contextUsage: snapshot.contextUsage
					? { ...snapshot.contextUsage, ...(contextWindow ? { contextWindow } : {}) }
					: undefined,
			};
		}
		case "assistant_error":
			return { ...base, assistantError: event.error };
		case "result": {
			const authoritative = event.resultText === undefined
				? undefined
				: appendRetainedText("", event.resultText, MODEL_RESULT_MAX_CHARS);
			return {
				...base,
				resultSubtype: event.subtype,
				stopReason: event.stopReason,
				resultText: authoritative?.text,
				resultOmittedChars: authoritative?.omittedChars,
				responseText: snapshot.responseText || authoritative?.text || "",
				responseOmittedChars: snapshot.responseText ? snapshot.responseOmittedChars : authoritative?.omittedChars ?? 0,
			};
		}
		case "retry":
			return { ...base, retry: { attempt: event.attempt, maxRetries: event.maxRetries, delayMs: event.delayMs, status: event.status, error: retainText(event.error, TOOL_FIELD_MAX_CHARS) } };
		case "rate_limit":
			return { ...base, rateLimit: event.info };
		case "diagnostic":
			return { ...base, diagnostics: [...snapshot.diagnostics, { kind: event.kind, label: retainText(event.label, TOOL_FIELD_MAX_CHARS), at: event.at }] };
	}
}

export function reduceDelegationMessage(
	snapshot: DelegationSnapshot,
	message: SDKMessage,
	at = Date.now(),
): DelegationSnapshot {
	return normalizeDelegationMessage(message, at)
		.reduce((current, event) => reduceDelegationEvent(current, event), snapshot);
}

/**
 * Fit one delegation snapshot inside the retained per-field and per-list caps
 * so it is safe to persist or hold in a bounded in-memory record. Truncation
 * stays visible: text fields carry an accurate omission marker and list
 * omissions are counted rather than silently dropped.
 */
export function retainDelegationSnapshot(snapshot: DelegationSnapshot): DelegationSnapshot {
	const tools = snapshot.tools ?? [];
	const permissionDenials = snapshot.permissionDenials ?? [];
	const diagnostics = snapshot.diagnostics ?? [];
	const timeline = snapshot.timeline ?? [];
	const toolsOmitted = Math.max(0, tools.length - TOOL_CALL_MAX_ITEMS);
	const retainedTools = tools.slice(-TOOL_CALL_MAX_ITEMS);
	const retainedToolIds = new Set(retainedTools.map((tool) => tool.id));
	const retainedTimeline = timeline.filter((entry) => !entry.toolUseId || retainedToolIds.has(entry.toolUseId));
	const denialsOmitted = Math.max(0, permissionDenials.length - RETAINED_LIST_MAX_ITEMS);
	const diagnosticsOmitted = Math.max(0, diagnostics.length - RETAINED_LIST_MAX_ITEMS);
	return {
		...snapshot,
		tools: retainedTools,
		toolsOmitted: (snapshot.toolsOmitted ?? 0) + toolsOmitted,
		permissionDenials: permissionDenials.slice(-RETAINED_LIST_MAX_ITEMS),
		permissionDenialsOmitted: (snapshot.permissionDenialsOmitted ?? 0) + denialsOmitted,
		diagnostics: diagnostics.slice(-RETAINED_LIST_MAX_ITEMS),
		diagnosticsOmitted: (snapshot.diagnosticsOmitted ?? 0) + diagnosticsOmitted,
		timeline: retainedTimeline,
		timelineOmitted: (snapshot.timelineOmitted ?? 0) + timeline.length - retainedTimeline.length,
		responseText: retainTextWithOmissions(snapshot.responseText ?? "", MODEL_RESULT_MAX_CHARS, snapshot.responseOmittedChars ?? 0),
		responseOmittedChars: 0,
		resultText: snapshot.resultText === undefined
			? undefined
			: retainTextWithOmissions(snapshot.resultText, MODEL_RESULT_MAX_CHARS, snapshot.resultOmittedChars ?? 0),
		resultOmittedChars: 0,
		thinkingText: retainTailTextWithOmissions(snapshot.thinkingText ?? "", THINKING_MAX_CHARS, snapshot.thinkingOmittedChars ?? 0),
		thinkingOmittedChars: 0,
		error: snapshot.error ? retainText(snapshot.error, MODEL_RESULT_MAX_CHARS) : undefined,
		retry: snapshot.retry ? { ...snapshot.retry, error: retainText(snapshot.retry.error, MODEL_RESULT_MAX_CHARS) } : undefined,
	};
}

/**
 * Failure text for an SDK result, or undefined when it succeeded. Claude Code
 * can report API failures (capacity, overload, prompt-too-long) with `is_error`
 * on a success-shaped result; accepting `subtype: success` alone would hand the
 * failure text back to Pi as Claude's answer.
 */
export function sdkResultErrorText(message: SDKResultMessage): string | undefined {
	const result = message as SDKResultMessage & { error?: unknown };
	if (result.subtype === "success") return result.is_error ? result.result || "Claude Code reported an error" : undefined;
	if (Array.isArray(result.errors) && result.errors.length) return result.errors.map(String).join("\n");
	if (typeof result.error === "string") return result.error;
	return `Claude Code failed: ${result.subtype ?? "unknown result"}`;
}

/**
 * Failure text for a stream that ended without an authoritative `result`.
 *
 * Every completed query ends with one. Reaching the end of the iterator without
 * it means the subprocess died or the stream was truncated, so an assistant
 * error observed earlier — which alone is not fatal, since a result may still
 * follow it — becomes the best available explanation.
 */
export function missingResultErrorText(assistantError?: SDKAssistantMessageError): string {
	return assistantError
		? `Claude Code ended without a result after an assistant error: ${assistantError}`
		: "Claude Code ended without a result";
}

/** Shared EOF invariant; callers handle cancellation before checking completion. */
export function assertSdkResultReceived(sawResult: boolean, assistantError?: SDKAssistantMessageError): void {
	if (!sawResult) throw new Error(missingResultErrorText(assistantError));
}

export function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (err && typeof err === "object") {
		const obj = err as Record<string, unknown>;
		if (typeof obj.message === "string") return obj.message;
		if (typeof obj.error === "string") return obj.error;
		try { return JSON.stringify(err); } catch {}
	}
	return String(err);
}
