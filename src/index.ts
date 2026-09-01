import { calculateCost, StringEnum, type AssistantMessage, type AssistantMessageEventStream, type Context, type ImageContent, type Model, type SimpleStreamOptions, type TextContent, type Tool, type UserMessage } from "@earendil-works/pi-ai";
import * as piAi from "@earendil-works/pi-ai";
import { getModels } from "@earendil-works/pi-ai/compat";
import { buildSessionContext, compact, generateBranchSummary, keyHint, type BranchSummaryResult, type CompactionEntry, type ExtensionAPI, type ExtensionContext, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { query, resolveSettings, type EffortLevel, type PermissionMode, type SDKMessage, type SettingSource } from "@anthropic-ai/claude-agent-sdk";
import type { Base64ImageSource, ContentBlockParam } from "@anthropic-ai/sdk/resources";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { createSession, deleteSession, openSession, repairToolPairing } from "cc-session-io";
import { appendFileSync, mkdirSync, realpathSync, statSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { PROVIDER_ID, messageContentToText, convertPiMessages } from "./convert.js";
import { applyLongContext, buildModels, claudeCodeModelId, type LongContextSettings, normalizeClaudeModelRequest, resolveModel as _resolveModel } from "./models.js";
import { MCP_SERVER_NAME, MCP_TOOL_PREFIX, renderSkillsBlock } from "./skills.js";
import { verifyWrittenSession as _verifyWrittenSession } from "./session-verify.js";
import { extractAllToolResults as _extractAllToolResults, type McpResult } from "./extract-tool-results.js";
import { QueryContext, ctx } from "./query-state.js";
import { makePromptStream, userMessage, type PromptStream } from "./prompt-stream.js";
import { claudeCodeSettings, loadConfig, markStartupNoticeShown, type Config } from "./config.js";
import {
	collectPromptSkills,
	projectPromptCapture,
	PromptCaptures,
} from "./prompt-capture.js";
import { collectCarriedAttachments, placeCarriedAttachments, type CarriedAttachment } from "./attachments.js";
import { createToolServer } from "./mcp-server.js";
import { askClaudeContextTags, buildAskClaudeContract } from "./askclaude-contract.js";
import { clearLiveAskClaudeCall, registerClaudeSessionsUI, updateLiveAskClaudeCall, type ClaudeSessionsUIHandle } from "./claude-sessions-overlay.js";
import {
	buildAskClaudePartialUpdate,
	buildSnapshotActionSummary,
	renderAskClaudeResult,
	retainAskClaudePrompt,
	type AskClaudeResultDetails,
} from "./askclaude-ui.js";
import { assembleModelResult } from "./delegation-retention.js";
import { buildDelegationQueryOptions } from "./delegation-options.js";
import { runDelegation, type DelegationQueryFactory, type DelegationRunResult } from "./delegation-runner.js";
import { AGENT_PROFILES, agentCapabilityMode, buildAgentJobPrompt, resolveAgentProfile, type AgentProfile, type AgentProfileId } from "./agent-profiles.js";
import { BackgroundJobLimitError, BackgroundJobManager, type BackgroundJobLaunch, type BackgroundJobRecord } from "./background-jobs.js";
import { registerBackgroundJobUI } from "./background-job-ui.js";
import { captureReviewerDiff, type ReviewerDiffArtifact } from "./reviewer-diff.js";
import {
	CheckoutWriteLease,
	checkoutWriteConflictText,
	globalCheckoutWriteLease,
	type CheckoutWriteLeaseHandle,
} from "./checkout-write-lease.js";
import {
	retainDelegationSnapshot,
	sdkResultErrorText as resultErrorText,
	type DelegationSnapshot,
} from "./delegation-events.js";
import {
	observePermissionMode,
	managedPolicyLabels,
	DEFAULT_PERMISSION_MODE,
	resolveDelegationPolicy,
	resolveProviderPermissionPolicy,
	summarizeManagedPolicy,
	type CapabilityMode,
	type ManagedPolicySummary,
} from "./query-policy.js";

// Compat (#2): use factory if available (pi-ai ≥0.66), else fall back to constructor (gsd-pi etc.)
const _piAi = piAi as any;
const newAssistantMessageEventStream: () => AssistantMessageEventStream =
	typeof _piAi.createAssistantMessageEventStream === "function"
		? _piAi.createAssistantMessageEventStream
		: () => new _piAi.AssistantMessageEventStream();

// --- Debug logging ---
// CLAUDE_BRIDGE_DEBUG=1 enables debug logging to ~/.pi/agent/claude-delegation.log

const DEBUG = process.env.CLAUDE_BRIDGE_DEBUG === "1";
const DEBUG_LOG_PATH = process.env.CLAUDE_BRIDGE_DEBUG_PATH || join(homedir(), ".pi", "agent", "claude-delegation.log");
const DIAG_LOG_PATH = join(homedir(), ".pi", "agent", "claude-delegation-diag.log");

// CLAUDE_BRIDGE_RECORD_STREAM=<path> appends every SDK message consumeQuery sees,
// one JSON object per line. Used by tests/lib/record-sdk-streams.mjs to capture
// replay fixtures, so unit tests assert against message shapes Claude Code really
// emitted rather than ones we imagined.
const RECORD_STREAM_PATH = process.env.CLAUDE_BRIDGE_RECORD_STREAM;

// Applied to every Claude Code subprocess the bridge spawns — provider, DelegateToClaude
// and the compact summary. One place, so a guard is added once rather than three
// times, and so a missing one is visible.
//
// - ENABLE_CLAUDEAI_MCP_SERVERS=0: keep the user's claude.ai-connected MCP servers
//   out of a pi session, which serves its own tools.
// - DISABLE_AUTO_COMPACT=1: pi owns compaction; CC compacting its own copy would
//   diverge from pi's history, which is the source of truth for every rebuild.
const CC_CHILD_ENV = {
	ENABLE_CLAUDEAI_MCP_SERVERS: "0",
	DISABLE_AUTO_COMPACT: "1",
} as const;

// Pi owns context files on the provider path, so Claude Code must not load its
// own on top: otherwise a project CLAUDE.md arrives twice, and the user's
// ~/.claude/CLAUDE.md — a persona written for a harness that is not the one
// running — arrives at all, stamped "These instructions OVERRIDE any default
// behavior" and outranking Pi's own AGENTS.md.
//
// Excludes rather than settingSources: the source gate that suppresses CLAUDE.md
// is the same one that reads settings.json, where Bedrock/Vertex users keep
// `env` and `apiKeyHelper`. Patterns are matched with picomatch against absolute
// paths; "**/CLAUDE.md" covers the user, ancestor, project and .claude/ copies,
// while rules need their own. Managed/policy memory is not excludable by design.
const CLAUDE_MD_EXCLUDES = ["**/CLAUDE.md", "**/.claude/rules/**"];

// Ensure log directories exist when debug is enabled
if (DEBUG) {
	try {
		mkdirSync(dirname(DEBUG_LOG_PATH), { recursive: true });
		mkdirSync(dirname(DIAG_LOG_PATH), { recursive: true });
	} catch {
		// If directory creation fails, debug functions will throw on first use
	}
}

// Unique per module evaluation — confirms whether subagents share module state
const moduleInstanceId = Math.random().toString(36).slice(2, 8);

function debug(...args: unknown[]) {
	if (!DEBUG) return;
	const ts = new Date().toISOString();
	const fmt = (a: unknown): string => {
		if (typeof a === "string") return a;
		if (a instanceof Error) return `${a.name}: ${a.message}${a.stack ? "\n" + a.stack : ""}`;
		return JSON.stringify(a);
	};
	const msg = args.map(fmt).join(" ");
	appendFileSync(DEBUG_LOG_PATH, `[${ts}] [${moduleInstanceId}] ${msg}\n`);
}

// Per-query CLI debug capture. When CLAUDE_BRIDGE_DEBUG=1, ask the Claude Code
// CLI subprocess to write its own debug log to a file we choose, and also
// forward its stderr into our debug stream. Drops straight into the real SDK's
// Options — see @anthropic-ai/claude-agent-sdk sdk.d.ts:1245 (debug, debugFile,
// stderr). Without this, CC's internal view of the world is invisible to us
// and "No conversation found" / empty-error reports are unactionable.
let nextCliDebugSeq = 1;
function makeCliDebugOptions(tag: string): { debug?: boolean; debugFile?: string; stderr?: (data: string) => void } {
	if (!DEBUG) return {};
	const seq = nextCliDebugSeq++;
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const logDir = join(dirname(DEBUG_LOG_PATH), "cc-cli-logs");
	try { mkdirSync(logDir, { recursive: true }); } catch { /* ignore */ }
	const debugFile = join(logDir, `${ts}-${tag}-${seq}.log`);
	debug(`cli-debug: ${tag} #${seq} → ${debugFile}`);
	return {
		debug: true,
		debugFile,
		stderr: (data: string) => {
			for (const line of data.split(/\r?\n/)) {
				if (line) debug(`[cli-stderr ${tag}#${seq}] ${line}`);
			}
		},
	};
}

/** Unconditional diagnostic dump — for "should never happen" paths */
function diagDump(label: string, data: Record<string, unknown>) {
	const ts = new Date().toISOString();
	const entry = { ts, moduleInstanceId, label, ...data };
	appendFileSync(DIAG_LOG_PATH, JSON.stringify(entry) + "\n");
	debug(`DIAG: ${label} (see ${DIAG_LOG_PATH})`);
}

// --- Constants ---

// Global key to prevent re-registration of the provider across module reloads.
//
// Extensions like pi-subagents spawn a subagent and it loads this module
// again. Without this guard, the subagent's call to registerProvider() would
// overwrite the parent's `streamSimple` function reference in the shared
// ModelRegistry. When the parent later delivers a tool result, it would call
// the subagent's `streamSimple` (which has empty state) instead of its own.
//
// By storing the active streamSimple in a Symbol.for() global (shared across all
// module instances), we ensure only the FIRST instance to register takes effect.
// Subsequent instances wrap the stored function instead of overwriting it.
//
// On session_shutdown (including /reload), clearSession() resets this so a fresh
// registration can occur for the next session.
const ACTIVE_STREAM_SIMPLE_KEY = Symbol.for("claude-delegation:activeStreamSimple");

// Pi >=0.84.2 requires custom streamSimple providers to support request and
// response lifecycle hooks. The Agent SDK exposes neither the final wire
// payload nor the HTTP response, so the bridge cannot implement either hook's
// replacement/observation contract faithfully. Keep this explicit and tested:
// calling a hook with a made-up payload or response would be worse than an
// honest compatibility limitation. See docs/PI-084-COMPATIBILITY.md.
const PROVIDER_HOOK_SUPPORT = Object.freeze({
	reviewedAgentSdk: "0.3.257",
	onPayload: false,
	onResponse: false,
});

// MODELS is buildModels(getModels("anthropic")) — projection kept in models.js.
const MODELS = buildModels(getModels("anthropic"));
let providerSettings: NonNullable<Config["provider"]> = {};
let longContextSettings: LongContextSettings = { plan: "pro", longContextExtraUsage: false };
const managedPolicyCache = new Map<string, Promise<ManagedPolicySummary | undefined>>();
const shownProviderPermissionOverrides = new Set<string>();

function observedManagedPolicy(cwd: string): Promise<ManagedPolicySummary | undefined> {
	let pending = managedPolicyCache.get(cwd);
	if (!pending) {
		pending = resolveSettings({ cwd, settingSources: [] })
			.then(summarizeManagedPolicy)
			.catch((error) => {
				debug("managed policy: SDK settings resolution failed", error);
				return undefined;
			});
		managedPolicyCache.set(cwd, pending);
	}
	return pending;
}

function resolveModel(input: string) {
	return _resolveModel(MODELS, input);
}

// --- Error handling ---

function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (err && typeof err === "object") {
		const obj = err as Record<string, unknown>;
		if (typeof obj.message === "string") return obj.message;
		if (typeof obj.error === "string") return obj.error;
		try { return JSON.stringify(err); } catch {}
	}
	return String(err);
}

// --- Session persistence ---

interface SessionState {
	sessionId: string;
	cursor: number;
	cwd: string;
	// Force the next syncSharedSession call down the REBUILD path. Set when
	// pi has mutated its messages array out from under us (compact, tree
	// navigation) or after an abort left the JSONL in an indeterminate state.
	// REBUILD wipes and rewrites the file to match pi's current history.
	needsRebuild?: boolean;
	// Set ONLY after an abort. The killed CC subprocess may still be flushing
	// a late "[Request interrupted by user]" record to the session JSONL.
	// Reusing the same sessionId/path would race that orphan write into our
	// fresh file and break CC's parent-uuid chain on the next resume. When
	// this flag is set, REBUILD takes a fresh UUID and skips deleteSession
	// so the orphan writes land on a dead inode. Compact/tree do NOT set
	// this — there's no concurrent CC writer during those events, so
	// in-place rebuild (preserve UUID, deleteSession + createSession) is safe.
	forceRotate?: boolean;
}

/**
 * Claude Code's `@file` expansions from the session about to be replaced.
 *
 * Must be called before `deleteSession`, which wipes the file they live in —
 * reading after it yields nothing, with no error to notice.
 */
function readCarriedAttachments(sessionId: string, cwd: string): CarriedAttachment[] {
	try {
		const previous = openSession({ sessionId, projectPath: cwd, claudeDir: process.env.CLAUDE_CONFIG_DIR });
		return collectCarriedAttachments(previous.records);
	} catch (error) {
		// A post-abort rebuild reads a file the killed CC subprocess may have been
		// midway through writing, and cc-session-io parses each line with a bare
		// JSON.parse, so a truncated last line throws. Throwing here would turn a
		// lost attachment into a failed turn; carrying none is exactly what happened
		// before this existed, so the failure mode is bounded by the status quo.
		debug(`WARNING: could not read attachments from session ${sessionId.slice(0, 8)}:`, error);
		return [];
	}
}

let sharedSession: SessionState | null = null;

// Convert pi messages to Anthropic API format for session import.
// Lossy: only text, thinking and toolCall blocks survive, and thinking only when
// Claude Code itself minted the signature. An assistant message whose blocks all
// filter out keeps its slot with a placeholder, since dropping it can create a
// tool_result with no preceding tool_use. A turn aborted before anything streamed
// is dropped instead — it never had content, and inventing one diverges from the
// prefix Claude Code cached.
function convertAndImportMessages(
	session: ReturnType<typeof createSession>,
	messages: Context["messages"],
	customToolNameToSdk?: Map<string, string>,
	carried?: readonly CarriedAttachment[],
): void {
	const { anthropicMessages, sanitizedIds, dropped } = convertPiMessages(messages, customToolNameToSdk);

	debug(`convertAndImportMessages: ${messages.length} pi msgs → ${anthropicMessages.length} anthropic msgs`);
	debug(`convertAndImportMessages: imported roles:`, anthropicMessages.map((m, i) => {
		const c = m.content;
		if (typeof c === "string") return `[${i}]${m.role}:text`;
		if (Array.isArray(c)) return `[${i}]${m.role}:${(c).map((b) => b.type).join("+")}`;
		return `[${i}]${m.role}:?`;
	}).join(" "));
	// The roles line above shows only what survived, so a stripped block is
	// indistinguishable there from one that never existed. Name the losses.
	const droppedParts = [
		dropped.thinking ? `${dropped.thinking} thinking (${[...dropped.providers].sort().join(", ")})` : "",
		dropped.abortedTurns ? `${dropped.abortedTurns} aborted turn(s)` : "",
		...[...dropped.other].map(([type, n]) => `${n} ${type}`),
	].filter(Boolean);
	if (droppedParts.length > 0) {
		debug(`convertAndImportMessages: dropped ${droppedParts.join(", ")}`);
	}
	if (sanitizedIds.size > 0) {
		debug(`convertAndImportMessages: sanitized ${sanitizedIds.size} tool IDs:`,
			[...sanitizedIds.entries()].map(([orig, clean]) => orig === clean ? orig : `${orig}→${clean}`).join(", "));
	}
	// Pre-repair for debug logging; importMessages also repairs internally (idempotent).
	const repaired = repairToolPairing(anthropicMessages);
	if (repaired.length !== anthropicMessages.length) {
		debug(`convertAndImportMessages: repairToolPairing ${anthropicMessages.length} → ${repaired.length} msgs`);
	}
	// Placement runs against the repaired array because that is the index space
	// importMessages reads. Attachments are links in CC's uuid chain, so they have
	// to be written in order with the messages, not appended afterwards.
	const placed = carried?.length
		? placeCarriedAttachments(carried, repaired as unknown as { role: string; content: unknown }[])
		: undefined;
	if (placed?.skipped.length) {
		debug(`convertAndImportMessages: dropped ${placed.skipped.length} carried attachment(s): ${placed.skipped.join("; ")}`);
	}
	if (placed?.attachments.length) {
		debug(`convertAndImportMessages: carrying ${placed.attachments.length} attachment(s) across the rebuild`);
	}
	if (repaired.length) {
		session.importMessages(repaired, placed?.attachments.length ? { attachments: placed.attachments } : undefined);
	}
}

// Pi doesn't pass tool results directly — it appends them to the context and calls
// the provider again. Thin wrapper over extract-tool-results.js that adds per-turn
// debug logging at the extraction boundary.
function extractAllToolResults(context: Context): McpResult[] {
	const { results, stopIdx } = _extractAllToolResults(context.messages as unknown as Array<{ role: string; [key: string]: unknown }>);
	debug(`extractAllToolResults: ${results.length} results from ${context.messages.length} msgs, stopped at index ${stopIdx}`);
	debug(`extractAllToolResults: all msg roles:`, context.messages.map((m, i) => `[${i}]${m.role}`).join(" "));
	for (let r = 0; r < results.length; r++) {
		debug(`extractAllToolResults: result[${r}] id=${results[r].toolCallId}${results[r].isError ? " ERROR" : ""} preview:`, JSON.stringify(results[r].content).slice(0, 150));
	}
	return results;
}

/** Index of the first message of the current user turn — the trailing run of
 *  user messages that has not been written into the Claude Code session yet.
 *  Equals messages.length when the last message is not a user message.
 *
 *  Single source of truth for the history/prompt split: everything before this
 *  index is replayed as session history, everything from it onward becomes the
 *  prompt. Deriving both halves from one index is what keeps a message from
 *  landing in both — an extension appending a display-only user message after
 *  the real one (see issue #34) makes the turn longer than one message. */
function turnStart(messages: Context["messages"]): number {
	let i = messages.length;
	while (i > 0 && messages[i - 1].role === "user") i--;
	return i;
}

/** Extract the current user turn as a prompt string. Returns null if the last message is not a user message. */
function extractUserPrompt(messages: Context["messages"]): string | null {
	const turn = messages.slice(turnStart(messages)) as UserMessage[];
	if (turn.length === 0) return null;
	// Drop empties before joining so an all-empty turn still yields "" and trips
	// the caller's empty-prompt guard rather than sending bare newlines.
	return turn
		.map((m) => (typeof m.content === "string" ? m.content : messageContentToText(m.content)))
		.filter((text) => text)
		.join("\n");
}

/** Extract the current user turn as ContentBlockParam[] (preserving images).
 *  Returns null if no images — caller should fall back to string prompt. */
function extractUserPromptBlocks(messages: Context["messages"]): ContentBlockParam[] | null {
	const turn = messages.slice(turnStart(messages)) as UserMessage[];
	if (turn.length === 0) return null;

	let hasImage = false;
	const blocks: ContentBlockParam[] = [];
	for (const message of turn) {
		const content: (TextContent | ImageContent)[] = typeof message.content === "string"
			? [{ type: "text", text: message.content }]
			: message.content;
		// Off-type content violates UserMessage's contract, so fail rather than
		// degrade — but name the shape, since the cause is almost always another
		// extension appending a malformed message, not this file.
		if (!Array.isArray(content)) {
			throw new Error(
				`extractUserPromptBlocks: user message content must be a string or block array, got ${typeof content} — likely a malformed message from another extension`,
			);
		}
		for (const block of content) {
			if (block.type === "text" && block.text) {
				blocks.push({ type: "text", text: block.text });
			} else if (block.type === "image") {
				// Guard before logging: data-less image blocks do occur, and reading
				// .length off the missing field in the debug template would throw
				// before this check ever runs (template args evaluate unconditionally).
				if (!block.data || !block.mimeType) {
					debug(`image block missing data or mimeType, skipping: keys=${Object.keys(block).join(",")}`);
					continue;
				}
				debug(`image block: mimeType=${block.mimeType}, data length=${block.data.length}`);
				hasImage = true;
				blocks.push({
					type: "image",
					source: {
						type: "base64",
						media_type: block.mimeType as Base64ImageSource["media_type"],
						data: block.data,
					},
				});
			}
		}
	}
	debug(`extractUserPromptBlocks: ${turn.length} msgs in turn, ${blocks.length} blocks, types=${blocks.map((b) => b.type).join(",")}`);
	return hasImage ? blocks : null;
}

function newAssistantOutput(model: Model<any>, text: string, stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		...(errorMessage ? { errorMessage } : {}),
		timestamp: Date.now(),
	};
}

function extractIsolatedSummaryPrompt(messages: Context["messages"]): string {
	if (messages.length !== 1 || messages[0].role !== "user") {
		throw new Error(
			`isolatedStreamFn: expected exactly 1 user message, got ${messages.length} ` +
			`(${messages.map((m) => m.role).join(",")})`,
		);
	}
	const promptText = extractUserPrompt(messages);
	if (!promptText) throw new Error("isolatedStreamFn: summarization prompt is empty");
	return promptText;
}

function isolatedStreamFn(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = newAssistantMessageEventStream();
	void runIsolatedSummary(model, context, options, stream);
	return stream;
}

async function runIsolatedSummary(
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	stream: AssistantMessageEventStream,
): Promise<void> {
	let sdkQuery: ReturnType<typeof query> | undefined;
	let wasAborted = false;
	const onAbort = () => {
		wasAborted = true;
		void sdkQuery?.interrupt().catch(() => {});
		try { sdkQuery?.close(); } catch {}
	};

	try {
		const promptText = extractIsolatedSummaryPrompt(context.messages);
		const cwd = (options as { cwd?: string } | undefined)?.cwd ?? process.cwd();
		const compactProviderSettings = loadConfig(cwd).provider;
		const claudeExecutable = compactProviderSettings?.pathToClaudeCodeExecutable;
		const permissionPolicy = resolveProviderPermissionPolicy(compactProviderSettings);
		const cliModel = claudeCodeModelId(model, longContextSettings);
		debug(`compact summary: spawn model=${cliModel} registeredModel=${model.id} promptLen=${promptText.length}`);

		sdkQuery = query({
			prompt: promptText,
			options: {
				cwd,
				env: { ...process.env, ...CC_CHILD_ENV },
				permissionMode: permissionPolicy.permissionMode,
				...(permissionPolicy.allowDangerouslySkipPermissions
					? { allowDangerouslySkipPermissions: true }
					: {}),
				settings: { autoMemoryEnabled: false },
				tools: [],
				strictMcpConfig: true,
				settingSources: [] as SettingSource[],
				skills: [],
				persistSession: false,
				systemPrompt: context.systemPrompt,
				model: cliModel,
				maxTurns: 1,
				...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
				...makeCliDebugOptions("compact-summary"),
			},
		});

		if (options?.signal) {
			if (options.signal.aborted) onAbort();
			else options.signal.addEventListener("abort", onAbort, { once: true });
		}

		let assistantText = "";
		let finalText = "";
		let errorText: string | undefined;
		let firstEventLogged = false;

		for await (const message of sdkQuery) {
			if (!firstEventLogged) {
				debug(`compact summary: first event type=${message.type}`);
				firstEventLogged = true;
			}
			if (wasAborted) break;

			if (message.type === "assistant") {
				for (const block of (message as any).message?.content ?? []) {
					if (block.type === "text" && typeof block.text === "string") assistantText += block.text;
				}
			} else if (message.type === "result") {
				logServedContextWindow("compact summary", message, model);
				errorText = resultErrorText(message);
				if (!errorText && message.subtype === "success") finalText = message.result || assistantText;
			}
		}

		if (wasAborted) {
			const output = newAssistantOutput(model, "", "aborted", "Operation aborted");
			debug("compact summary: aborted");
			stream.push({ type: "error", reason: "aborted", error: output });
			stream.end();
			return;
		}

		const text = finalText || assistantText;
		if (errorText || !text.trim()) {
			const msg = errorText ?? "Claude Code summary returned empty text";
			debug(`compact summary: error ${msg}`);
			stream.push({ type: "error", reason: "error", error: newAssistantOutput(model, "", "error", msg) });
			stream.end();
			return;
		}

		debug(`compact summary: done textLen=${text.length}`);
		stream.push({ type: "done", reason: "stop", message: newAssistantOutput(model, text, "stop") });
		stream.end();
	} catch (err) {
		const msg = errorMessage(err);
		debug("runIsolatedSummary threw; pushing terminal error", err);
		stream.push({ type: "error", reason: "error", error: newAssistantOutput(model, "", "error", msg) });
		stream.end();
	} finally {
		options?.signal?.removeEventListener("abort", onAbort);
		try { sdkQuery?.close(); } catch {}
	}
}

function reinjectPriorCompactionFileOps(branchEntries: Array<{ type: string; details?: unknown }>, preparation: { fileOps: { read: Set<string>; edited: Set<string> } }): void {
	const prior = [...branchEntries]
		.reverse()
		.find((entry): entry is CompactionEntry => entry.type === "compaction");
	const details = prior?.details as { readFiles?: unknown; modifiedFiles?: unknown } | undefined;
	if (!Array.isArray(details?.readFiles) || !Array.isArray(details?.modifiedFiles)) return;
	for (const file of details.readFiles) preparation.fileOps.read.add(String(file));
	for (const file of details.modifiedFiles) preparation.fileOps.edited.add(String(file));
	debug(`compact takeover: re-injected prior file ops read=${details.readFiles.length} modified=${details.modifiedFiles.length}`);
}

interface SyncResult {
	sessionId: string | null;
	preserveSharedSession?: boolean;
}

/**
 * Ensure the shared session has all messages up to (but not including) the last user message.
 * Returns session ID to resume from, or null if no resume needed.
 */
// Read the session file we just wrote and sanity-check it. Warns instead of
// throwing — CC may be more tolerant than our checks, so a false positive
// shouldn't block the user. Pure logic is in session-verify.js; this wrapper
// fans each warning out to debug log + piUI notify + diagDump.
function verifyWrittenSession(
	jsonlPath: string,
	expectedSessionId: string,
	expectedRecordCount: number,
	cwd: string,
): void {
	const warnings = _verifyWrittenSession(jsonlPath, expectedSessionId, expectedRecordCount);
	for (const msg of warnings) {
		debug(`WARNING session verify: ${msg}`);
		piUI?.notify(
			`Session file issue: ${msg}\n` +
			`cwd=${cwd} realpath=${safeRealpath(cwd)} CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR ?? "(unset)"}\n` +
			`Please copy and paste this message into a new issue at https://github.com/ramtinJ95/pi-claude-delegation/issues/new` +
			(DEBUG ? ` and attach ${DEBUG_LOG_PATH}` : ` (rerun with CLAUDE_BRIDGE_DEBUG=1 to capture a debug log)`),
			"warning",
		);
		diagDump("session_verify_fail", { msg, jsonlPath, cwd, realpath: safeRealpath(cwd), claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? null });
	}
}

function safeRealpath(p: string): string {
	try { return realpathSync(p); } catch (e) { return `<failed: ${(e as Error).message}>`; }
}

// Diagnostic snapshot of where a session file was just written. Catches the
// class of bugs where pi writes to ~/.claude/projects/<X> but CC SDK reads
// from ~/.claude/projects/<Y> (symlinks, CLAUDE_CONFIG_DIR, hash mismatch).
function debugSessionPaths(label: string, cwd: string, jsonlPath: string): void {
	const realCwd = safeRealpath(cwd);
	let fileSize: number | null = null;
	let fileExists = false;
	try {
		const st = statSync(jsonlPath);
		fileExists = true;
		fileSize = st.size;
	} catch { /* file may not exist yet */ }
	debug(`${label}: cwd=${cwd}`);
	if (realCwd !== cwd) debug(`${label}: realpath(cwd)=${realCwd} (DIFFERS — symlink-resolved path is what CC SDK uses)`);
	debug(`${label}: jsonlPath=${jsonlPath}`);
	debug(`${label}: fileExists=${fileExists}${fileSize != null ? ` size=${fileSize}` : ""}`);
	debug(`${label}: env.CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR ?? "(unset)"} HOME=${process.env.HOME ?? "(unset)"}`);
}

// Two semantic paths:
//   REUSE — pi's history is in sync with the existing sharedSession (or drifted
//     only by the trailing final-assistant message that pi appends after
//     streamSimple returns, which CC's own persisted session already has).
//     Returns the existing sessionId. Keeps CC's prompt cache warm.
//   REBUILD — no session yet, or pi's history has diverged (non-trailing
//     missed messages, e.g. another provider took a turn). Wipes the existing
//     session file (if any) and writes a fresh one containing all prior
//     messages, reusing the same sessionId across rebuilds so UUIDs stay
//     stable for the lifetime of pi's session.
//
// Why a full rebuild rather than patching:
//   Injecting deltas into an existing session creates a branch that CC's
//   --resume doesn't follow (documented attempt prior to this). A complete
//   overwrite at the same path is simpler and correct.
//
// Why reuse the sessionId across rebuilds:
//   CC re-reads the JSONL on every --resume call — no in-process UUID
//   caching. Validated in tests/exp-session-clear.mjs, including the case
//   where CC had appended its own tool_use/tool_result records between
//   rebuilds. Preserving the UUID means stable log correlation across
//   provider switches and no orphaned session files.
//
// Log strings still say "Case 1/2/3/4" so existing diagnostics (int-cache.sh,
// int-session-resume.mjs) keep grepping the same anchors.
function syncSharedSession(
	messages: Context["messages"],
	cwd: string,
	customToolNameToSdk?: Map<string, string>,
	modelId?: string,
): SyncResult {
	const priorMessages = messages.slice(0, turnStart(messages)); // everything before the current user turn

	// REUSE path
	//
	// Guard on priorMessages.length >= cursor: a shorter incoming context cannot
	// be a continuation of the cached session. This is the general invariant for
	// pi-side history rewrites such as /compact and session_tree: without it,
	// missed = [].slice(cursor) can falsely hit REUSE and resume an unrelated
	// longer CC session. See issue #25.
	if (sharedSession && !sharedSession.needsRebuild && priorMessages.length >= sharedSession.cursor) {
		const missed = priorMessages.slice(sharedSession.cursor);
		const trailingAssistantOnly =
			missed.length === 1 && (missed[0] as { role?: string }).role === "assistant";
		if (missed.length === 0 || trailingAssistantOnly) {
			if (trailingAssistantOnly) {
				sharedSession = { ...sharedSession, cursor: priorMessages.length, cwd };
			}
			debug(`Case 3: ${trailingAssistantOnly ? "advanced cursor past trailing assistant, " : ""}resuming session ${sharedSession.sessionId.slice(0, 8)}, cursor=${sharedSession.cursor}`);
			debug(`syncResult: path=reuse sessionId=${sharedSession.sessionId} cursor=${sharedSession.cursor}`);
			return { sessionId: sharedSession.sessionId };
		}
	}
	// This is what keeps a reentrant subagent from taking over the parent's
	// session: a subagent starts with priors of its own, shorter than the parent's
	// cursor, so it lands here, gets a fresh session, and the ephemeral session it
	// captures is deleted once its query completes (see preserveSharedSession in
	// the completion handler). Remove this branch and a subagent resumes — then
	// overwrites — the parent's session. The non-isolated DelegateToClaude path reaches it
	// the same way.
	//
	// It is NOT, despite an earlier comment here, the isolated compact-summary
	// path: runIsolatedSummary never calls syncSharedSession at all.
	//
	// Only reachable when needsRebuild is false — user-facing history rewrites
	// (/compact, session_tree, /new, fork) always set needsRebuild or clear
	// sharedSession before the next syncSharedSession call.
	if (sharedSession && !sharedSession.needsRebuild && priorMessages.length < sharedSession.cursor) {
		debug(`Case 1 synthetic: clean start for shorter context, preserving shared session ${sharedSession.sessionId.slice(0, 8)}, cursor=${sharedSession.cursor}`);
		debug(`syncResult: path=clean-start preserve-shared sessionId=${sharedSession.sessionId} cursor=${sharedSession.cursor}`);
		return { sessionId: null, preserveSharedSession: true };
	}

	// REBUILD path
	if (priorMessages.length === 0) {
		debug(`Case 1: clean start, ${messages.length} total messages`);
		debug(`syncResult: path=clean-start`);
		return { sessionId: null };
	}
	const previousSessionId = sharedSession?.sessionId;
	const previousCursor = sharedSession?.cursor ?? 0;
	// preserveId: rebuild in place (deleteSession + createSession with the
	// existing UUID), so prompt-cache UUIDs stay stable for log correlation
	// and for any tools that key off them. Skipped only when there's a
	// concurrent writer we shouldn't race — see forceRotate docs above.
	const preserveId = previousSessionId !== undefined && !sharedSession?.forceRotate;
	// Before deleteSession — it wipes the file these live in.
	const carried = previousSessionId !== undefined ? readCarriedAttachments(previousSessionId, cwd) : [];
	if (preserveId) {
		// Wipe prior jsonl + companion dir (no-op if nothing to wipe).
		deleteSession(previousSessionId!, cwd, process.env.CLAUDE_CONFIG_DIR);
	}
	const session = createSession({
		projectPath: cwd,
		claudeDir: process.env.CLAUDE_CONFIG_DIR,
		...(preserveId ? { sessionId: previousSessionId } : {}),
		...(modelId ? { model: modelId } : {}),
	});
	convertAndImportMessages(session, priorMessages, customToolNameToSdk, carried);
	session.save();
	// records, not messages: `messages` filters out the attachment records that
	// carrying an `@file` expansion across a rebuild writes into the same file.
	verifyWrittenSession(session.jsonlPath, session.sessionId, session.records.length, cwd);
	sharedSession = { sessionId: session.sessionId, cursor: priorMessages.length, cwd };
	if (previousSessionId === undefined) {
		debug(`Case 2: first turn with ${priorMessages.length} prior messages → session ${session.sessionId.slice(0, 8)}, ${session.records.length} records`);
	} else if (preserveId) {
		const missedCount = priorMessages.length - previousCursor;
		debug(`Case 4: ${missedCount} missed messages, ${priorMessages.length} total → rewrote session ${session.sessionId.slice(0, 8)} (same id), ${session.records.length} records`);
	} else {
		debug(`Case 4 post-abort: ${priorMessages.length} total → new session ${session.sessionId.slice(0, 8)} (was ${previousSessionId.slice(0, 8)}, rotated to avoid race with orphan writer), ${session.records.length} records`);
	}
	debugSessionPaths(`${session.sessionId.slice(0, 8)}`, cwd, session.jsonlPath);
	debug(`syncResult: path=rebuild sessionId=${session.sessionId} priors=${priorMessages.length} ${previousSessionId === undefined ? "first" : preserveId ? "preserved" : "rotated-post-abort"}`);
	return { sessionId: session.sessionId };
}

// @internal
export const __test = {
	resetSharedSession() {
		sharedSession = null;
	},
	setSharedSession(state: SessionState | null) {
		sharedSession = state;
	},
	getSharedSession() {
		return sharedSession;
	},
	setPiUI(ui: ExtensionUIContext | null) {
		piUI = ui;
	},
	syncSharedSession,
	extractUserPromptBlocks,
	consumeQuery,
	finalizeCurrentStream,
	resultErrorText,
	deliverToolResults,
	drainForAbort,
	CC_CHILD_ENV,
	buildMcpServers,
	branchSummaryOutcome,
	PROVIDER_HOOK_SUPPORT,
	finalizeAskClaudeResult,
	askClaudeResultIsError,
	spawnClaudeAgentResultIsError,
	spawnedJobResultText,
	registerSpawnClaudeAgent,
	executeForegroundDelegation,
};

// --- DelegateToClaude result shaping ---

/**
 * Promote DelegateToClaude's own failure flag to pi's `toolResult.isError`.
 *
 * pi's AgentToolResult carries no isError field: a tool can only mark failure by
 * throwing, and a throw replaces the result with a bare message, discarding the
 * details the renderer needs and the partial answer a cancelled run collected.
 * DelegateToClaude records failure in its details instead, and the `tool_result` hook
 * feeds this decision back so the model sees an error result.
 */
function askClaudeResultIsError(
	event: { toolName: string; isError: boolean; details?: unknown },
): { isError: true } | undefined {
	if (event.toolName !== askClaudeToolName || event.isError) return undefined;
	return (event.details as AskClaudeResultDetails | undefined)?.error ? { isError: true } : undefined;
}

/**
 * Shape one finished delegation into the model-facing result and TUI details.
 *
 * A cancelled run resolves normally in the runner so partial work survives, so
 * this is the only place that can stop it reading as a successful empty answer:
 * the model is told it was cancelled, whatever response and actions did arrive
 * are kept, and the `cancelled`/`error` details keep the renderer — and
 * `askClaudeResultIsError` — from claiming success.
 *
 * The action summary is derived here from the retained snapshot rather than
 * accepted from the caller, so the model-facing summary, the persisted details,
 * and the rendered tool list all describe the same bounded record.
 */
function finalizeAskClaudeResult(input: {
	result: DelegationRunResult;
	prompt: string;
	executionTime: number;
	capabilityMode?: "full" | "read" | "none";
	requestedModel?: string;
	thinking?: string;
	isolated?: boolean;
}): { content: { type: "text"; text: string }[]; details: AskClaudeResultDetails } {
	const { result } = input;
	const snapshot = retainDelegationSnapshot(result.snapshot);
	const actions = buildSnapshotActionSummary(snapshot);
	const cancelled = result.stopReason === "cancelled";

	// The authoritative SDK result still wins over earlier streamed narration.
	// Budget the model answer from the runner's own snapshot text rather than the
	// retained display copy, so an answer that hits the cap carries one accurate
	// omission count instead of a second marker stacked on an already-marked one.
	const resultText = result.snapshot.resultText;
	const answer = resultText ?? result.snapshot.responseText;
	const answerOmittedChars = (resultText === undefined ? result.snapshot.responseOmittedChars : result.snapshot.resultOmittedChars) ?? 0;

	// Policy annotations, not prose: they tell the model the answer was produced
	// under an overridden permission mode or with tools denied.
	const annotations: string[] = [];
	if (result.permission?.overridden) {
		const policyLabels = managedPolicyLabels(result.managedPolicy);
		annotations.push(`[Claude Code permission mode: requested ${result.permission.requested}, runtime ${result.permission.effective}${policyLabels.length ? `; observed managed policy: ${policyLabels.join(", ")}` : "; Claude settings or managed policy may have overridden it"}.]`);
	}
	if (result.permissionDenials.length) {
		const denied = result.permissionDenials
			.slice(0, 5)
			.map((item) => `${item.toolName}${item.reasonType ? ` (${item.reasonType})` : ""}`)
			.join(", ");
		annotations.push(`[Claude Code permission denials: ${denied}${result.permissionDenials.length > 5 ? ", …" : ""}.]`);
	}

	const text = assembleModelResult({
		answer: cancelled
			? answer
				? `Cancelled by user. Partial response before cancellation:\n\n${answer}`
				: "Cancelled by user before Claude Code produced a response."
			: answer,
		answerOmittedChars: answer ? answerOmittedChars : 0,
		actions: actions ? `[Claude Code actions: ${actions}]` : "",
		annotations,
	});

	return {
		content: [{ type: "text" as const, text }],
		details: {
			prompt: retainAskClaudePrompt(input.prompt),
			executionTime: input.executionTime,
			actions,
			capabilityMode: input.capabilityMode,
			requestedModel: input.requestedModel,
			thinking: input.thinking,
			isolated: input.isolated,
			...(cancelled ? { cancelled: true, error: true } : {}),
			permission: result.permission,
			permissionDenials: snapshot.permissionDenials,
			managedPolicy: result.managedPolicy,
			snapshot,
		},
	};
}

// Provider path: the query runs with `tools: []`, so the only tools CC can
// legitimately call are the pi tools we serve over MCP. Any other name is the
// model hallucinating a builtin (`bash`, `Bash`, `Edit`, an MCP server we don't
// serve). CC answers those itself with "No such tool available" and retries
// inside the same query, never dispatching them to our MCP server — so a tool
// call under such a name must not reach pi. Forwarding one ran a tool CC never
// dispatched (real side effects) and, because the retry carries a fresh
// tool_use id, left the handler for the retry with no result to release it:
// pi's result arrived keyed to the dead id, and both sides deadlocked.
function piToolNameFor(name: string, customToolNameToPi: Map<string, string>): string | undefined {
	return customToolNameToPi.get(name) ?? customToolNameToPi.get(name.toLowerCase());
}

// Renames for Claude Code SDK param names that differ from pi's native names.
// Keys not listed here pass through unchanged, so new pi params work automatically.
const SDK_KEY_RENAMES: Record<string, Record<string, string>> = {
	read:  { file_path: "path" },
	write: { file_path: "path" },
	edit:  { file_path: "path", old_string: "oldText", new_string: "newText", old_text: "oldText", new_text: "newText" },
};

// Maps SDK tool args to pi tool args via key renaming + pass-through.
// Pi's own prepareArguments hooks handle any structural transforms (e.g. edit oldText/newText → edits[]).
function mapToolArgs(
	toolName: string, args: Record<string, unknown> | undefined,
): Record<string, unknown> {
	const input = args ?? {};
	const renames = SDK_KEY_RENAMES[toolName.toLowerCase()];
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) {
		const piKey = renames?.[key] ?? key;
		if (!(piKey in result)) result[piKey] = value; // first alias wins
	}
	// Pi bash has no default timeout; add a safety default
	if (toolName.toLowerCase() === "bash" && result.timeout == null) {
		result.timeout = 120;
	}
	return result;
}

// --- Query state ---
// QueryContext lives in query-state.js so tests can import it without
// activating the extension.

// Global (not query state):
let piUI: ExtensionUIContext | null = null;
let piMode: ExtensionContext["mode"] | null = null;
const activeQueryContexts = new Set<QueryContext>();

// Defaults that silently cost the user something (no Opus 1M on Max, no
// DelegateToClaude tool) are announced once. Deferred to the first bridge query rather
// than session_start: the notice persists a flag to the global config, and
// firing it on startup would write that file for every pi session that merely
// has this extension installed. One message, because consecutive info notifies
// overwrite each other in the TUI.
let pendingNotices: string[] = [];

function showStartupNoticeOnce(): void {
	// `hasUI` is true in RPC mode too — it means dialogs are possible, not that a
	// human is watching. Only a terminal user can act on this.
	if (pendingNotices.length === 0 || piMode !== "tui") return;
	const notices = pendingNotices;
	pendingNotices = [];
	const path = markStartupNoticeShown();
	// pi wraps the whole notify string in the theme's dim foreground; the inner reset
	// drops back to the terminal default rather than dim, which is fine here.
	const title = `\x1b[33mWelcome to pi-claude-delegation\x1b[39m — settings live in ${path}`;
	const bullets = [...notices, "This message only appears once. See README.md for more."].map((n) => `• ${n}`);
	piUI?.notify([title, ...bullets, "─".repeat(64)].join("\n"), "info");
}

// Captures of what pi assembled per agent; see src/prompt-capture.ts for why this
// is keyed rather than held in a single slot.
const promptCaptures = new PromptCaptures();

/** Whatever a settled session left behind, named in one greppable line.
 *
 *  Every one of these should be empty once the last turn ends, and each is a leak
 *  that costs something real: a retained context routes a later orphaned tool result
 *  into the delivery path and returns a stream nobody ends; a pending tool call is an
 *  MCP handler Claude Code is still waiting on; a live prompt stream is an unresolved
 *  ack. The activeQueryContexts leak was present on every single happy-path run and
 *  no test noticed, because nothing asserted that anything ends clean — so assert it
 *  where the real sessions are, and let diag/audit-warnings.mjs scan for it. */
function reportLeaks(label: string): void {
	const pendingCalls = [...activeQueryContexts].reduce((n, c) => n + c.pendingToolCalls.size, 0);
	const liveStreams = [...activeQueryContexts].filter((c) => c.promptStream !== null).length;
	if (activeQueryContexts.size === 0 && pendingCalls === 0 && liveStreams === 0) return;
	debug(
		`WARNING: ${label} left state behind — contexts=${activeQueryContexts.size} `
		+ `pendingToolCalls=${pendingCalls} promptStreams=${liveStreams}`,
	);
}

/** What pi's branch summary means for the navigation it was asked for.
 *
 *  Cancelling on failure matches pi's own path, which rethrows a summary error out
 *  of the navigation rather than moving without one. Separated from the event
 *  handler so this decision is testable without a Claude Code subprocess — driving
 *  `generateBranchSummary` itself would only be testing pi. */
function branchSummaryOutcome(result: BranchSummaryResult): { cancel: true } | { summary: { summary: string; details: unknown; usage?: BranchSummaryResult["usage"] } } {
	if (result.aborted) return { cancel: true };
	if (result.error) throw new Error(result.error);
	debug(`session_before_tree: takeover complete summaryLen=${result.summary?.length ?? 0}`);
	return {
		summary: {
			summary: result.summary ?? "",
			details: { readFiles: result.readFiles ?? [], modifiedFiles: result.modifiedFiles ?? [] },
			usage: result.usage,
		},
	};
}

function contextForToolResults(results: McpResult[]): QueryContext | undefined {
	for (const result of results) {
		const id = result.toolCallId;
		if (!id) continue;
		for (const queryCtx of activeQueryContexts) {
			if (queryCtx.pendingToolCalls.has(id) || queryCtx.pendingResults.has(id) || queryCtx.turnToolCallIds.includes(id)) {
				return queryCtx;
			}
		}
	}
	return undefined;
}

function resolveMcpTools(context: Context, excludeToolName?: string): {
	mcpTools: Tool[];
	customToolNameToSdk: Map<string, string>;
	customToolNameToPi: Map<string, string>;
} {
	const mcpTools: Tool[] = [];
	const customToolNameToSdk = new Map<string, string>();
	const customToolNameToPi = new Map<string, string>();

	if (!context.tools) return { mcpTools, customToolNameToSdk, customToolNameToPi };

	for (const tool of context.tools) {
		if (tool.name === excludeToolName) continue;
		const sdkName = `${MCP_TOOL_PREFIX}${tool.name}`;
		mcpTools.push(tool);
		customToolNameToSdk.set(tool.name, sdkName);
		customToolNameToSdk.set(tool.name.toLowerCase(), sdkName);
		customToolNameToPi.set(sdkName, tool.name);
		customToolNameToPi.set(sdkName.toLowerCase(), tool.name);
	}

	return { mcpTools, customToolNameToSdk, customToolNameToPi };
}

// Creates an MCP server that bridges pi tools to the SDK. Each tool handler
// blocks on a Promise until pi delivers the tool result via streamSimple.
// Handlers receive their toolCallId from Claude's tools/call _meta, so results
// are matched by ID end to end.
//
// The handler and pi's result can arrive in either order, hence the two maps:
// a result that lands first waits in `pendingResults` for the handler to claim
// it, and a handler that runs first parks its resolver in `pendingToolCalls`.
// Handlers close over the captured `queryCtx`, ensuring they operate on the
// correct query's state while multiple queries run concurrently.
function buildMcpServers(tools: Tool[], queryCtx: QueryContext): Record<string, ReturnType<typeof createToolServer>> | undefined {
	if (!tools.length) return undefined;
	const mcpTools = tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		inputSchema: tool.parameters,
		handler: async (toolCallId: string) => {
			if (queryCtx.pendingResults.has(toolCallId)) {
				const result = queryCtx.pendingResults.get(toolCallId)!;
				queryCtx.pendingResults.delete(toolCallId);
				debug(`mcp handler: ${tool.name} [${toolCallId}] → resolved from queue (${queryCtx.pendingResults.size} remaining)`);
				return result;
			}
			debug(`mcp handler: ${tool.name} [${toolCallId}] → waiting`);
			return new Promise<McpResult>((resolve) => {
				queryCtx.pendingToolCalls.set(toolCallId, { toolName: tool.name, resolve });
			});
		},
	}));
	return { [MCP_SERVER_NAME]: createToolServer(MCP_SERVER_NAME, mcpTools) };
}

// --- Usage helpers ---

function updateUsage(output: AssistantMessage, usage: Record<string, number | undefined>, model: Model<any>): void {
	if (usage.input_tokens != null) output.usage.input = usage.input_tokens;
	if (usage.output_tokens != null) output.usage.output = usage.output_tokens;
	if (usage.cache_read_input_tokens != null) output.usage.cacheRead = usage.cache_read_input_tokens;
	if (usage.cache_creation_input_tokens != null) output.usage.cacheWrite = usage.cache_creation_input_tokens;
	// Claude Code may report reasoning/thinking tokens separately, while pi's Usage type does not model that field.
	const reasoning = usage.reasoning_tokens ?? usage.thinking_tokens;
	if (reasoning != null) (output.usage as typeof output.usage & { reasoning?: number }).reasoning = reasoning;
	output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
	calculateCost(model, output.usage);
	const promptTokens = output.usage.input + output.usage.cacheRead + output.usage.cacheWrite;
	const cachePct = promptTokens > 0 ? Math.round(output.usage.cacheRead / promptTokens * 100) : 0;
	const reasoningText = reasoning != null ? ` reasoning=${reasoning}` : "";
	debug(`usage: in=${output.usage.input} out=${output.usage.output} cacheRead=${output.usage.cacheRead} cacheWrite=${output.usage.cacheWrite} total=${output.usage.totalTokens}${reasoningText} cachePct=${cachePct}% model=${model.id}`);
}

// Log the *served* context window reported by an SDK result message
// (modelUsage[id].contextWindow), which can differ from the window pi
// registered (model.contextWindow) when the runtime entitlement doesn't
// match the docs — e.g. bare Opus served 200K on Pro, or [1m] not honored.
// The result message's modelUsage is otherwise discarded; this makes the
// gap observable. See issue #18.
function logServedContextWindow(label: string, message: SDKMessage, model: Model<any>): void {
	const modelUsage = (message as any).modelUsage as Record<string, { contextWindow?: number; maxOutputTokens?: number }> | undefined;
	if (!modelUsage) return;
	for (const [k, v] of Object.entries(modelUsage)) {
		debug(`${label}: served contextWindow=${v.contextWindow ?? "?"} maxOutputTokens=${v.maxOutputTokens ?? "?"} servedModel=${k} registered=${model.contextWindow}`);
	}
}

// --- Effort level mapping ---
// Pi reasoning levels → CC SDK effort levels

const REASONING_TO_EFFORT: Record<string, EffortLevel> = {
	minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "max",
};

// --- Provider helpers: misc ---

function mapStopReason(reason: string | undefined): "stop" | "length" | "toolUse" {
	switch (reason) {
		case "tool_use": return "toolUse";
		case "max_tokens": return "length";
		case "end_turn": default: return "stop";
	}
}

function parsePartialJson(input: string, fallback: Record<string, unknown>): Record<string, unknown> {
	if (!input) return fallback;
	try { return JSON.parse(input); } catch { return fallback; }
}


// --- Provider: streaming function ---
//
// Push-based streaming with MCP tool bridge:
// 1. streamSimple starts a query() and kicks off consumeQuery() in background
// 2. consumeQuery() iterates the SDK generator, pushing events to currentPiStream
// 3. On tool_use: ends the current pi stream, nulls it out. The MCP handler
//    blocks the generator naturally — no events arrive until resolved.
// 4. Pi executes the tool, calls streamSimple again. We swap in the new stream,
//    resolve the MCP handler, and the generator unblocks — events flow to new stream.
//
// Note: resetTurnState clears turnSawStreamEvent while the generator may still
// have queued messages from the previous turn. This is safe because step 3 nulls
// currentPiStream, so any leftover messages hit the `!ctx().currentPiStream` guard
// in consumeQuery and are skipped before resetTurnState runs.

const completedStreams = new WeakSet<object>();

function markStreamComplete(stream: AssistantMessageEventStream | null): void {
	if (stream) completedStreams.add(stream as object);
}

function claimCurrentPiStream(stream: AssistantMessageEventStream, label: string, c: QueryContext): void {
	if (c.currentPiStream && !completedStreams.has(c.currentPiStream as object)) {
		debug(`WARNING: currentPiStream overwritten before terminal event (${label}); activeQuery=${Boolean(c.activeQuery)} pendingHandlers=${c.pendingToolCalls.size}`);
	}
	c.currentPiStream = stream;
}

function ensureTurnStarted(c: QueryContext): void {
	if (!c.turnStarted && c.currentPiStream && c.turnOutput) {
		c.currentPiStream!.push({ type: "start", partial: c.turnOutput });
		c.turnStarted = true;
	}
}

function finalizeCurrentStream(c: QueryContext, stopReason?: string): void {
	if (!c.currentPiStream || !c.turnOutput) return;
	debug(`provider: finalizeCurrentStream called, stopReason=${stopReason}, turnOutput=${JSON.stringify({stopReason: c.turnOutput!.stopReason, error: c.turnOutput!.errorMessage})}`);
	if (!c.turnStarted) ensureTurnStarted(c);
	const stream = c.currentPiStream;
	if (c.turnOutput.stopReason === "error") {
		stream!.push({ type: "error", reason: "error", error: c.turnOutput });
	} else {
		const reason = stopReason === "length" ? "length" : "stop";
		stream!.push({ type: "done", reason, message: c.turnOutput });
	}
	markStreamComplete(stream);
	stream!.end();
	c.currentPiStream = null;
}

/** Maps Anthropic stream events to pi stream events (text, thinking, toolcall).
 *  On message_stop with tool_use: ends currentPiStream so pi can execute the tool. */
function processStreamEvent(
	message: SDKMessage,
	customToolNameToPi: Map<string, string>,
	model: Model<any>,
	c: QueryContext,
): void {
	if (!c.currentPiStream || !c.turnOutput) return;
	c.turnSawStreamEvent = true;
	const event = (message as SDKMessage & { event: any }).event;

	if (event?.type === "message_start") {
		c.turnToolCallIds = [];
		if (event.message?.usage) updateUsage(c.turnOutput, event.message.usage, model);
		return;
	}

	if (event?.type === "content_block_start") {
		ensureTurnStarted(c);
		if (event.content_block?.type === "text") {
			c.turnBlocks.push({ type: "text", text: "", index: event.index });
			c.currentPiStream!.push({ type: "text_start", contentIndex: c.turnBlocks.length - 1, partial: c.turnOutput });
		} else if (event.content_block?.type === "thinking") {
			c.turnBlocks.push({ type: "thinking", thinking: "", thinkingSignature: "", index: event.index });
			c.currentPiStream!.push({ type: "thinking_start", contentIndex: c.turnBlocks.length - 1, partial: c.turnOutput });
		} else if (event.content_block?.type === "tool_use") {
			const piName = piToolNameFor(event.content_block.name, customToolNameToPi);
			if (!piName) {
				debug(`processStreamEvent: skipping tool_use for unserved tool ${event.content_block.name} [${event.content_block.id}] — CC rejects it and retries`);
				return;
			}
			c.turnSawToolCall = true;
			c.turnToolCallIds.push(event.content_block.id);
			c.turnBlocks.push({
				type: "toolCall", id: event.content_block.id,
				name: piName,
				arguments: (event.content_block.input as Record<string, unknown>) ?? {},
				partialJson: "", index: event.index,
			});
			c.currentPiStream!.push({ type: "toolcall_start", contentIndex: c.turnBlocks.length - 1, partial: c.turnOutput });
		} else {
			debug("processStreamEvent: unhandled content_block_start type", event.content_block?.type);
		}
		return;
	}

	if (event?.type === "content_block_delta") {
		const index = c.turnBlocks.findIndex((b: any) => b.index === event.index);
		const block = c.turnBlocks[index];
		if (!block) return;
		if (event.delta?.type === "text_delta" && block.type === "text") {
			block.text += event.delta.text;
			c.currentPiStream!.push({ type: "text_delta", contentIndex: index, delta: event.delta.text, partial: c.turnOutput });
		} else if (event.delta?.type === "thinking_delta" && block.type === "thinking") {
			block.thinking += event.delta.thinking;
			c.currentPiStream!.push({ type: "thinking_delta", contentIndex: index, delta: event.delta.thinking, partial: c.turnOutput });
		} else if (event.delta?.type === "input_json_delta" && block.type === "toolCall") {
			block.partialJson += event.delta.partial_json;
			block.arguments = parsePartialJson(block.partialJson, block.arguments);
			c.currentPiStream!.push({ type: "toolcall_delta", contentIndex: index, delta: event.delta.partial_json, partial: c.turnOutput });
		} else if (event.delta?.type === "signature_delta" && block.type === "thinking") {
			block.thinkingSignature = (block.thinkingSignature ?? "") + event.delta.signature;
		} else {
			debug("processStreamEvent: unhandled content_block_delta type", event.delta?.type);
		}
		return;
	}

	if (event?.type === "content_block_stop") {
		const index = c.turnBlocks.findIndex((b: any) => b.index === event.index);
		const block = c.turnBlocks[index];
		if (!block) return;
		delete block.index;
		if (block.type === "text") {
			c.currentPiStream!.push({ type: "text_end", contentIndex: index, content: block.text, partial: c.turnOutput });
		} else if (block.type === "thinking") {
			c.currentPiStream!.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: c.turnOutput });
		} else if (block.type === "toolCall") {
			c.turnSawToolCall = true;
			block.arguments = mapToolArgs(
				block.name, parsePartialJson(block.partialJson, block.arguments),
			);
			delete block.partialJson;
			c.currentPiStream!.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: c.turnOutput });
		}
		return;
	}

	if (event?.type === "message_delta") {
		c.turnOutput.stopReason = mapStopReason(event.delta?.stop_reason);
		if (event.usage) updateUsage(c.turnOutput, event.usage, model);
		return;
	}

	if (event?.type === "message_stop" && c.turnSawToolCall) {
		// Tool call complete — end this pi stream. The SDK will still yield an
		// assistant message for this turn, but currentPiStream=null causes
		// consumeQuery to skip it. The MCP handler blocks the generator until
		// pi delivers the tool result via the next streamSimple call.
		c.turnOutput.stopReason = "toolUse";
		const stream = c.currentPiStream;
		stream!.push({ type: "done", reason: "toolUse", message: c.turnOutput });
		markStreamComplete(stream);
		stream!.end();
		c.currentPiStream = null;

		// Cursor is updated by the next streamSimple call (tool result delivery path)
		// which sets cursor = context.messages.length with the post-tool-result context.
		return;
	}

	if (event?.type !== "message_stop" && event?.type !== "ping") {
		debug("processStreamEvent: unhandled event type", event?.type);
	}
}

// The SDK always yields `assistant` messages (completed content blocks) after streaming.
// When stream_events already delivered the content, this is a no-op. But after
// resetTurnState (e.g. tool result delivery), if the next turn's assistant message
// arrives before any stream_events, this is the primary content path. Must maintain
// the same stream lifecycle as processStreamEvent — including ending the stream on
// tool_use to prevent deadlock with the MCP handler.
function processAssistantMessage(message: SDKMessage, model: Model<any>, customToolNameToPi: Map<string, string>, c: QueryContext): void {
	if (c.turnSawStreamEvent) return;
	const assistantMsg = (message as any).message;
	if (!assistantMsg?.content) return;
	c.turnToolCallIds = [];
	debug(`processAssistantMessage fallback: ${assistantMsg.content.length} blocks, types=${assistantMsg.content.map((b: any) => b.type).join(",")}`);
	for (const block of assistantMsg.content) {
		if (block.type === "text" && block.text) {
			ensureTurnStarted(c);
			c.turnBlocks.push({ type: "text", text: block.text });
			const idx = c.turnBlocks.length - 1;
			c.currentPiStream?.push({ type: "text_start", contentIndex: idx, partial: c.turnOutput });
			c.currentPiStream?.push({ type: "text_delta", contentIndex: idx, delta: block.text, partial: c.turnOutput });
			c.currentPiStream?.push({ type: "text_end", contentIndex: idx, content: block.text, partial: c.turnOutput });
		} else if (block.type === "thinking") {
			ensureTurnStarted(c);
			c.turnBlocks.push({ type: "thinking", thinking: block.thinking ?? "", thinkingSignature: block.signature ?? "" });
			const idx = c.turnBlocks.length - 1;
			c.currentPiStream?.push({ type: "thinking_start", contentIndex: idx, partial: c.turnOutput });
			if (block.thinking) c.currentPiStream?.push({ type: "thinking_delta", contentIndex: idx, delta: block.thinking, partial: c.turnOutput });
			c.currentPiStream?.push({ type: "thinking_end", contentIndex: idx, content: block.thinking ?? "", partial: c.turnOutput });
		} else if (block.type === "tool_use") {
			const piName = piToolNameFor(block.name, customToolNameToPi);
			if (!piName) {
				debug(`processAssistantMessage: skipping tool_use for unserved tool ${block.name} [${block.id}] — CC rejects it and retries`);
				continue;
			}
			ensureTurnStarted(c);
			c.turnSawToolCall = true;
			c.turnToolCallIds.push(block.id);
			c.turnBlocks.push({
				type: "toolCall", id: block.id,
				name: piName,
				arguments: mapToolArgs(piName, block.input),
			});
			const idx = c.turnBlocks.length - 1;
			const toolBlock = c.turnBlocks[idx];
			c.currentPiStream?.push({ type: "toolcall_start", contentIndex: idx, partial: c.turnOutput });
			c.currentPiStream?.push({ type: "toolcall_end", contentIndex: idx, toolCall: toolBlock as any, partial: c.turnOutput });
		} else {
			debug("processAssistantMessage: unhandled block type", block.type);
		}
	}
	if (assistantMsg.usage && c.turnOutput) updateUsage(c.turnOutput, assistantMsg.usage, model);

	// End the stream on tool_use, same as processStreamEvent's message_stop handler.
	if (c.turnSawToolCall && c.currentPiStream && c.turnOutput) {
		c.turnOutput.stopReason = "toolUse";
		const stream = c.currentPiStream;
		stream.push({ type: "done", reason: "toolUse", message: c.turnOutput });
		markStreamComplete(stream);
		stream.end();
		c.currentPiStream = null;
	}
}

/** Background consumer: iterates the SDK generator, pushing events to currentPiStream.
 *  Runs until the query ends. Per turn, the SDK yields stream_events (deltas), then
 *  an assistant message (completed blocks). On tool_use, the stream is ended by
 *  whichever path handles it first (processStreamEvent or processAssistantMessage),
 *  and the MCP handler blocks the generator until pi delivers the tool result. */
async function consumeQuery(
	sdkQuery: ReturnType<typeof query>,
	customToolNameToPi: Map<string, string>,
	model: Model<any>,
	wasAborted: () => boolean,
	queryCtx: QueryContext,
	requestedPermissionMode: PermissionMode = DEFAULT_PERMISSION_MODE,
	managedPolicyPromise: Promise<ManagedPolicySummary | undefined> = Promise.resolve(undefined),
): Promise<{ capturedSessionId?: string }> {
	let capturedSessionId: string | undefined;

	for await (const message of sdkQuery) {
		if (RECORD_STREAM_PATH) appendFileSync(RECORD_STREAM_PATH, `${JSON.stringify(message)}\n`);
		if (wasAborted()) break;
		// Everything below the currentPiStream guard is content, which there is
		// nowhere to put once a turn has ended on a tool call. These three are not
		// content and must not share that gate:
		//
		// - stdin: nothing else closes the CLI's stdin now that the prompt is a
		//   streamed generator (isSingleUserTurn=false), so missing this hangs the query.
		// - the failure a `result` carries: it is the only record that the turn
		//   failed at all. Behind the guard, a 429 arriving at a tool boundary set
		//   no stopReason, no errorMessage, and logged nothing — the turn simply
		//   ended empty.
		// - rate-limit events: notifications to the user, which are most likely to
		//   fire during exactly the long tool-using turns the guard was skipping.
		let resultError: string | undefined;
		if (message.type === "result") {
			queryCtx.promptStream?.end();
			logServedContextWindow("result", message, model);
			const permissionDenials = (message as SDKMessage & {
				permission_denials?: Array<{ tool_name: string; tool_use_id: string }>;
			}).permission_denials ?? [];
			if (permissionDenials.length) {
				const deniedTools = permissionDenials
					.slice(0, 3)
					.map((denial) => denial.tool_name)
					.join(", ");
				debug("provider: permission denials", JSON.stringify(permissionDenials.map((denial) => ({
					toolName: denial.tool_name,
					toolUseId: denial.tool_use_id,
				}))));
				piUI?.notify(
					`Claude Code denied provider tool${permissionDenials.length === 1 ? "" : "s"} ${deniedTools}. Allow the required MCP aliases in Claude permission settings or adjust provider.permissionMode; managed policy may require an administrator.`,
					"warning",
				);
			}
			resultError = resultErrorText(message);
			if (resultError !== undefined) {
				debug(`consumeQuery: error result, subtype=${message.subtype}, error=${resultError}`);
				if (queryCtx.turnOutput) {
					queryCtx.turnOutput.stopReason = "error";
					queryCtx.turnOutput.errorMessage = resultError;
				}
			}
		}
		if (message.type === "rate_limit_event") {
			const info = (message as any).rate_limit_info;
			debug("consumeQuery: rate_limit_event", JSON.stringify(info).slice(0, 300));
			if (info?.status === "rejected") {
				const resetsAt = info.resetsAt ? new Date(info.resetsAt).toLocaleTimeString() : "unknown";
				piUI?.notify(`Claude rate limited (${info.rateLimitType ?? "unknown"}) — resets at ${resetsAt}`, "warning");
			} else if (info?.status === "allowed_warning") {
				piUI?.notify(`Claude rate limit warning: ${Math.round(info.utilization ?? 0)}% used (${info.rateLimitType ?? ""})`, "warning");
			}
			continue;
		}
		if (message.type === "system" && message.subtype === "init") {
			const observation = observePermissionMode(requestedPermissionMode, message.permissionMode);
			if (observation) {
				debug("provider: permission mode",
					`requested=${observation.requested} effective=${observation.effective}`,
					`overridden=${observation.overridden}`);
				if (observation.overridden) {
					const managedPolicy = await managedPolicyPromise;
					const policyDetail = managedPolicyLabels(managedPolicy);
					debug("provider: observed managed policy", policyDetail.join(",") || "not-observed");
					const noticeKey = `${observation.requested}->${observation.effective}:${policyDetail.join("|")}`;
					if (!shownProviderPermissionOverrides.has(noticeKey)) {
						shownProviderPermissionOverrides.add(noticeKey);
						piUI?.notify(
							`Claude Code changed permission mode ${observation.requested} → ${observation.effective}${policyDetail.length ? `; managed policy: ${policyDetail.join(", ")}` : "; settings or managed policy may be responsible"}.`,
							"warning",
						);
					}
				}
			}
		}
		if (!queryCtx.currentPiStream || !queryCtx.turnOutput) continue;

		switch (message.type) {
			case "stream_event":
				processStreamEvent(message, customToolNameToPi, model, queryCtx);
				break;
			case "assistant":
				processAssistantMessage(message, model, customToolNameToPi, queryCtx);
				break;
			case "result": {
					// The failure itself was recorded above the guard, along with the served
					// context window. What is left here is the success path: push the result
					// text when no assistant message already delivered it.
					if (resultError === undefined && !queryCtx.turnSawStreamEvent && message.subtype === "success") {
					ensureTurnStarted(queryCtx);
					const text = message.result || "";
					queryCtx.turnBlocks.push({ type: "text", text });
					const idx = queryCtx.turnBlocks.length - 1;
					queryCtx.currentPiStream?.push({ type: "text_start", contentIndex: idx, partial: queryCtx.turnOutput });
					queryCtx.currentPiStream?.push({ type: "text_delta", contentIndex: idx, delta: text, partial: queryCtx.turnOutput });
					queryCtx.currentPiStream?.push({ type: "text_end", contentIndex: idx, content: text, partial: queryCtx.turnOutput });
				}
				break;
			}
			case "system":
				if ((message as any).subtype === "init" && (message as any).session_id) {
					capturedSessionId = (message as any).session_id;
				}
				break;
			case "user":
				// SDK echo of the user prompt — no stream events to emit. Note it
				// carries only prompts and tool results: a steer CC drained at a
				// tool boundary is recorded in its session transcript as a
				// `queued_command` attachment and never reaches this stream, which
				// is why the mid-turn steering tripwire has to live in the
				// integration test.
				break;
			default:
				debug("consumeQuery: unhandled SDK message type", message.type);
				break;
		}
	}

	// DEBUG: trace when consumeQuery exits
	debug(`consumeQuery: for-await loop exited, wasAborted=${wasAborted()}, capturedSessionId=${capturedSessionId?.slice(0, 8) ?? "none"}`);

	return { capturedSessionId };
}

/** The trailing user turn as content blocks, or null if there isn't one.
 *  Blocks rather than text so image steers keep their images. */
function steerBlocks(messages: Context["messages"]): ContentBlockParam[] | null {
	const blocks = extractUserPromptBlocks(messages);
	if (blocks) return blocks;
	const text = extractUserPrompt(messages);
	return text ? [{ type: "text", text }] : null;
}

/** A steer that never made it into CC's session. The cursor has already counted
 *  it, so count-based sync would skip it forever — rebuild instead, which
 *  re-imports the message from pi's context. */
function steerMissedSession(text: string): void {
	if (!sharedSession) return;
	sharedSession = { ...sharedSession, needsRebuild: true };
	debug(`provider: steer never reached CC, marked session for rebuild: ${text.slice(0, 60)}`);
}

/** Releases this turn's tool results to their MCP handlers, after first pushing
 *  any steer to CC.
 *
 *  The ordering is mandatory, not an optimization. The steer and the MCP tool
 *  result travel back to CC over the same stdin FIFO. Awaiting the push ack
 *  (which resolves only once the SDK's write to stdin completed) before
 *  resolving any handler guarantees CC enqueues the steer *before* it reads the
 *  tool result, so its post-tool-call drain sees it and acts on it this turn.
 *  Resolve first and the steer misses the drain, silently degrading to
 *  follow-up semantics.
 *
 *  Both the post-tool-call drain and the FIFO ordering are CC CLI internals,
 *  not SDK contract — tests/int-tool-message.mjs is the tripwire if they move. */
async function deliverToolResults(
	c: QueryContext,
	results: McpResult[],
	steer: ContentBlockParam[] | null,
	contextLength: number,
): Promise<void> {
	if (steer) {
		const text = steer.map((b) => (b.type === "text" ? b.text : "[image]")).join("\n");
		if (!c.promptStream) {
			debug(`WARNING: steer with no prompt stream, dropping: ${text.slice(0, 60)}`);
			steerMissedSession(text);
		} else {
			try {
				await c.promptStream.push(userMessage(steer, "next"));
				debug(`provider: steer written to CC stdin before tool result: ${text.slice(0, 60)}`);
			} catch (error) {
				// The query is ending — pushing further input would wedge tool-result
				// delivery, so the steer doesn't reach this query. It is still in
				// pi's context, and the caller has already advanced the session
				// cursor past it, so force a rebuild or CC would never see it.
				debug(`provider: steer push rejected, delivering tool result anyway:`, error);
				steerMissedSession(text);
			}
		}
	}

	debug(`provider: tool results, ${results.length} results, ${c.pendingToolCalls.size} waiting handlers, ctx.msgs=${contextLength}`);
	for (const result of results) {
		const id = result.toolCallId;
		if (id && c.pendingToolCalls.has(id)) {
			const pending = c.pendingToolCalls.get(id)!;
			c.pendingToolCalls.delete(id);
			debug(`provider: resolving ${pending.toolName} [${id}]${result.isError ? " (error)" : ""}`, JSON.stringify(result.content).slice(0, 200));
			pending.resolve(result);
		} else if (id) {
			c.pendingResults.set(id, result);
			debug(`provider: queued result [${id}] (${c.pendingResults.size} pending)`);
		} else {
			debug(`WARNING: tool result without toolCallId, cannot match`);
		}
		if (c.pendingToolCalls.size > 0 && c.pendingResults.size > 0) {
			debug(`BUG: both maps non-empty! handlers=${c.pendingToolCalls.size} results=${c.pendingResults.size}`);
		}
	}
	if (c.pendingToolCalls.size > 0) {
		debug(`WARNING: ${c.pendingToolCalls.size} MCP handlers still waiting after delivering ${results.length} results`);
		piUI?.notify(`Claude bridge: ${c.pendingToolCalls.size} tool handler(s) still waiting — provider may be stuck`, "warning");
	}
}

/** Abort teardown for one query: settle everything that would otherwise be left
 *  awaiting a subprocess we are about to kill. The pump abandons iteration on
 *  abort, so an in-flight prompt-stream push would hang forever and take
 *  tool-result delivery with it. */
function drainForAbort(c: QueryContext, promptStream: PromptStream): void {
	promptStream.fail(new Error("Operation aborted"));
	c.releasePendingToolCalls("Operation aborted");
}

/** Provider entry point. Pi calls this for each new prompt and each tool result.
 *  Two cases: tool result delivery (active query) or fresh query. */
function streamClaudeAgentSdk(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	showStartupNoticeOnce();
	const stream = newAssistantMessageEventStream();

	// DEBUG: trace followUp message triggering
	const lastMsgRole = context.messages[context.messages.length - 1]?.role;
	debug(`provider: streamClaudeAgentSdk called, activeQuery=${!!ctx().activeQuery}, lastMsgRole=${lastMsgRole}, isReentrant=${ctx().activeQuery !== null}`);

	const activeQuery = ctx().activeQuery !== null;
	const allResults = activeQueryContexts.size > 0 ? extractAllToolResults(context) : [];
	const resultCtx = allResults.length > 0 ? contextForToolResults(allResults) : undefined;
	const isReentrantUserQuery = activeQuery && lastMsgRole === "user" && allResults.length === 0;
	if (isReentrantUserQuery) {
		debug(`provider: active query user-only call treated as reentrant fresh query, waitingHandlers=${ctx().pendingToolCalls.size}, ctx.msgs=${context.messages.length}`);
	}

	// --- Tool result delivery ---
	// Pi appends tool results to context and calls back. Extract this turn's results
	// (everything after the last assistant message) and match against waiting MCP
	// handlers. Results that arrive before their handler get queued in pendingResults.
	if (resultCtx) {
		claimCurrentPiStream(stream, "tool-result", resultCtx);
		resultCtx.resetTurnState(model);
		// User messages (steer/followUp) pi injected into context during the
		// active query: a steer sent while a tool was executing, drained by pi at
		// the turn boundary and appended alongside the tool result.
		const steer = lastMsgRole === "user" ? steerBlocks(context.messages) : null;
		// Delivery is async because the steer must reach CC's stdin *before* the
		// tool result does — see deliverToolResults. Detached so the provider
		// still returns its stream synchronously.
		void deliverToolResults(resultCtx, allResults, steer, context.messages.length);
		// The shared cursor tracks the top-level conversation. A reentrant subagent
		// delivering its own results would drag it to that subagent's message count
		// — observed pulling a parent from 5 back to 3, which cost the parent's next
		// turn a full rebuild and a flushed prompt cache.
		if (sharedSession && resultCtx === ctx()) sharedSession.cursor = context.messages.length;
		resultCtx.latestCursor = Math.max(resultCtx.latestCursor, context.messages.length);
		return stream;
	}

	// --- Orphaned tool result (e.g. user aborted a tool call) ---
	// The query is gone but pi still delivered the result. Nothing to do — just
	// emit end_turn so pi waits for the next real user message.
	const lastMsg = context.messages[context.messages.length - 1];
	if (lastMsg?.role === "toolResult") {
		debug(`provider: orphaned tool result after abort, emitting end_turn`);
		if (sharedSession && activeQueryContexts.size === 0) sharedSession.cursor = context.messages.length;
		// No query owns this result, so there is no context to reset: resetTurnState
		// on the top-level ctx() would replace a live parent's turnOutput mid-stream,
		// stranding the blocks it had already emitted. A throwaway context just
		// supplies the empty message this turn ends with.
		const c = new QueryContext();
		c.resetTurnState(model);
		queueMicrotask(() => {
			stream.push({ type: "done", reason: "stop", message: c.turnOutput });
			markStreamComplete(stream);
			stream.end();
		});
		return stream;
	}

	// --- Fresh query ---

	// 1. Determine reentrancy. Reentrant queries get their own QueryContext so
	//    background subagents can run concurrently with the parent query.
	const isReentrant = activeQuery;
	const queryCtx = isReentrant ? new QueryContext() : ctx();
	debug(`provider: fresh query setup, isReentrant=${isReentrant}, activeContexts=${activeQueryContexts.size}`);

	// Resolved first: an unaccountable system prompt throws, and doing that before
	// anything is claimed or reset leaves no half-built query behind — in particular
	// no stream claimed on the shared context that nobody will ever end.
	const { mcpTools, customToolNameToSdk, customToolNameToPi } = resolveMcpTools(context, askClaudeToolName);
	// Build from what Pi loaded for this run, so `--no-context-files` and
	// `--no-skills` reach Claude Code by leaving nothing to forward. A sub-agent's
	// custom override embeds its parent's assembled Pi prompt; recursive projection
	// replaces that exact inherited prompt with its already-safe portable parts.
	const promptCapture = promptCaptures.resolveOrDerive(context.systemPrompt);
	const systemPromptAppend = promptCapture
		? projectPromptCapture(promptCapture, {
			skillReadTool: mcpTools.some((tool) => tool.name === "read") ? "mcp" : "none",
		})
		: undefined;

	// 2. Fresh child context — constructor already gave us clean Maps and empty
	//    arrays. For a reused top-level context, clear explicitly.
	claimCurrentPiStream(stream, "fresh-query", queryCtx);
	queryCtx.pendingToolCalls.clear();
	queryCtx.pendingResults.clear();
	// Stale ids would let a late result from the previous query route here via
	// contextForToolResults — which now means pushing its steer into this
	// query's stdin, not just mismatching a map.
	queryCtx.turnToolCallIds = [];
	queryCtx.resetTurnState(model);
	queryCtx.latestCursor = 0;

	const cwd = (options as { cwd?: string } | undefined)?.cwd ?? process.cwd();
	// cliModel is the actual id sent to Claude Code (may carry [1m]); model.id is the
	// pi-registered id. Log cliModel so debug lines reflect what CC actually received.
	const cliModel = claudeCodeModelId(model, longContextSettings);
	const syncResult = syncSharedSession(context.messages, cwd, customToolNameToSdk, cliModel);
	const { sessionId: resumeSessionId } = syncResult;
	const promptBlocks = extractUserPromptBlocks(context.messages);
	let promptText = extractUserPrompt(context.messages) ?? "";

	// Guard: empty prompt means the last context message isn't a user message.
	// This should never happen with per-query state — dump diagnostics if it does.
	if (!promptText && !promptBlocks) {
		diagDump("empty_prompt", {
			contextLength: context.messages.length,
			lastMsgRole: lastMsg?.role,
			isReentrant,
			activeQueryContexts: activeQueryContexts.size,
			activeQueryExists: queryCtx.activeQuery !== null,
			sharedSession: sharedSession ? { sessionId: sharedSession.sessionId.slice(0, 8), cursor: sharedSession.cursor } : null,
			messageRoles: context.messages.map((m, i) => `[${i}]${m.role}`).join(" "),
		});
		// Recover: use a continuation prompt so the SDK doesn't send an empty text block
		promptText = "[continue]";
	}

	// Always stream the prompt rather than passing a string: a parked input
	// generator is what lets us write steers to CC's stdin mid-turn. The cost is
	// that `isSingleUserTurn` is false, so the SDK no longer closes stdin on the
	// first result — consumeQuery ends the stream explicitly instead, or the
	// query would never terminate.
	const promptStream = makePromptStream();
	void promptStream.push(userMessage(promptBlocks ?? [{ type: "text", text: promptText }]))
		.catch((error) => debug(`provider: initial prompt push rejected:`, error));
	queryCtx.promptStream = promptStream;
	const mcpServers = buildMcpServers(mcpTools, queryCtx);

	// MCP auto-loading suppression: CC reads MCP servers from ~/.claude.json (top-level
	// + per-project) and .mcp.json. Since pi executes tools (not CC), those are pure
	// token overhead. --strict-mcp-config tells the binary to use ONLY mcpServers passed
	// programmatically and ignore filesystem MCP entries — applied unconditionally because
	// settingSources is left at CC's default, which loads all sources.
	const strictMcpConfigEnabled = providerSettings.strictMcpConfig !== false;
	const claudeExecutable = providerSettings.pathToClaudeCodeExecutable;

	// Prefer the model's own thinkingLevelMap when present (pi-ai 0.72+ ships
	// per-model overrides — e.g. opus-4-7 wants xhigh→xhigh, not xhigh→max).
	// Fall back to our generic table for older pi-ai or unmapped levels.
	const effort = options?.reasoning
		? ((model as any).thinkingLevelMap?.[options.reasoning] as EffortLevel | undefined)
			?? REASONING_TO_EFFORT[options.reasoning]
		: undefined;

	const extraArgs: Record<string, string | null> = { model: cliModel };
	if (strictMcpConfigEnabled) extraArgs["strict-mcp-config"] = null;
	// Opus 4.7 defaults thinking.display to "omitted" (empty thinking text in stream).
	// Force summarized so thinking_delta events arrive. See anthropics/claude-agent-sdk-python#830.
	if (effort) extraArgs["thinking-display"] = "summarized";

	// Suppress claude.ai cloud MCP servers (Figma/Canva/etc. auto-discovered via OAuth
	// when the user is logged into Anthropic). These are a separate code path from
	// filesystem MCP and are NOT blocked by --strict-mcp-config or settingSources=undefined.
	// The native CC binary gates them on env var ENABLE_CLAUDEAI_MCP_SERVERS: setting it
	// to "0"/"false"/"no"/"off" makes the loader return early before any cloud fetch.
	// DISABLE_AUTO_COMPACT=1: pi owns context-management and propagates its own
	// /compact via session_compact (see handler in default export). Letting CC
	// also autocompact would double-flush the prompt cache and races pi's
	// threshold with CC's, including CC's anti-thrashing guard (issue #8).
	// Manual /compact in CC still works (we never invoke it).
	const childEnv = { ...process.env, ...CC_CHILD_ENV };
	const permissionPolicy = resolveProviderPermissionPolicy(providerSettings);
	const managedPolicyPromise = observedManagedPolicy(cwd);
	const queryOptions: NonNullable<Parameters<typeof query>[0]["options"]> = {
		cwd,
		env: childEnv,
		tools: [],
		permissionMode: permissionPolicy.permissionMode,
		...(permissionPolicy.allowDangerouslySkipPermissions
			? { allowDangerouslySkipPermissions: true }
			: {}),
		includePartialMessages: true,
		settings: { ...claudeCodeSettings(providerSettings), claudeMdExcludes: CLAUDE_MD_EXCLUDES },
		systemPrompt: {
			type: "preset", preset: "claude_code",
			append: systemPromptAppend ? systemPromptAppend : undefined,
		},
		extraArgs,
		...(effort ? { effort } : {}),
		...(mcpServers ? { mcpServers } : {}),
		...(resumeSessionId ? { resume: resumeSessionId } : {}),
		...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
		...makeCliDebugOptions("provider"),
	};

	debug("provider: fresh query",
		`model=${cliModel} msgs=${context.messages.length} tools=${mcpTools.length}`,
		`resume=${resumeSessionId?.slice(0, 8) ?? "none"} effort=${effort ?? "default"} permission=${permissionPolicy.requestedPermissionMode}`,
		`ctxFiles=${promptCapture?.contextFiles.length ?? 0} strictMcp=${strictMcpConfigEnabled}`,
		`prompt=${promptText.slice(0, 60)}${promptBlocks ? " [+images]" : ""}`);

	// 3. Start SDK query and claim it for this context
	let wasAborted = false;
	const sdkQuery = query({ prompt: promptStream.stream, options: queryOptions });
	queryCtx.activeQuery = sdkQuery;
	activeQueryContexts.add(queryCtx);

	// 4. Capture context for abort handling
	const abortCtx = queryCtx;

	const requestAbort = () => {
		// interrupt() asks the CLI to stop gracefully; close() kills it immediately.
		// Both are needed — interrupt alone lets the current API call finish.
		void sdkQuery.interrupt().catch(() => {});
		try { sdkQuery.close(); } catch {}
	};
	const onAbort = () => {
		wasAborted = true;
		drainForAbort(abortCtx, promptStream);
		requestAbort();
	};
	if (options?.signal) {
		if (options.signal.aborted) onAbort();
		else options.signal.addEventListener("abort", onAbort, { once: true });
	}

	// Background consumer — runs until query ends
	consumeQuery(
		sdkQuery,
		customToolNameToPi,
		model,
		() => wasAborted,
		queryCtx,
		permissionPolicy.requestedPermissionMode,
		managedPolicyPromise,
	)
		.then(async ({ capturedSessionId }) => {
			debug(`provider: consumeQuery completed, stopReason=${queryCtx.turnOutput?.stopReason}, error=${queryCtx.turnOutput?.errorMessage}, aborted=${wasAborted}`);

			// --- Abort detection in normal completion path ---
			if (wasAborted || options?.signal?.aborted) {
				if (sharedSession) sharedSession = { ...sharedSession, needsRebuild: true, forceRotate: true };
				debug(`provider: abort detected, marked sharedSession needsRebuild + forceRotate`);
				if (queryCtx.turnOutput) {
					queryCtx.turnOutput.stopReason = "aborted";
					queryCtx.turnOutput.errorMessage = "Operation aborted";
				}
				const stream = queryCtx.currentPiStream;
				stream?.push({ type: "error", reason: "aborted", error: queryCtx.turnOutput! });
				markStreamComplete(stream);
				stream?.end();
				queryCtx.currentPiStream = null;
				return;
			}

			// --- Capture session ID ---
			const sessionId = capturedSessionId ?? sharedSession?.sessionId;
			if (syncResult.preserveSharedSession) {
				if (capturedSessionId && capturedSessionId !== sharedSession?.sessionId) {
					deleteSession(capturedSessionId, cwd, process.env.CLAUDE_CONFIG_DIR);
					debug(`provider: query done, deleted ephemeral session ${capturedSessionId.slice(0, 8)} to preserve shared session`);
				}
				debug(`provider: query done, ignoring captured session ${capturedSessionId?.slice(0, 8) ?? "none"} to preserve shared session`);
			} else if (sessionId) {
				const cursor = Math.max(context.messages.length, queryCtx.latestCursor, sharedSession?.cursor ?? 0);
				debug(`provider: query done, session=${sessionId.slice(0, 8)}, cursor=${cursor}`);
				sharedSession = { sessionId, cursor, cwd };
			}

			if (!isReentrant && queryCtx.activeQuery === sdkQuery) {
				debug("provider: clearing activeQuery before final stream completion");
				queryCtx.activeQuery = null;
			}
			finalizeCurrentStream(queryCtx, queryCtx.turnOutput?.stopReason);
		})
		.catch((error) => {
			debug(`provider: query error, model=${cliModel}, aborted=${Boolean(options?.signal?.aborted)}, error=`, error);
			if ((wasAborted || options?.signal?.aborted) && sharedSession) {
				sharedSession = { ...sharedSession, needsRebuild: true, forceRotate: true };
			} else {
				sharedSession = null;
			}
			promptStream.fail(error instanceof Error ? error : new Error(String(error)));
			if (queryCtx.turnOutput) {
				queryCtx.turnOutput.stopReason = options?.signal?.aborted ? "aborted" : "error";
				// The SDK drops its copy of the result text if any message follows the error
				// result, so prefer the cause consumeQuery recorded off the result itself.
				queryCtx.turnOutput.errorMessage ??= error instanceof Error ? error.message : String(error);
			}
			if (!isReentrant && queryCtx.activeQuery === sdkQuery) {
				queryCtx.releasePendingToolCalls("Query ended");
				debug("provider: clearing activeQuery before error stream completion");
				queryCtx.activeQuery = null;
			}
			const stream = queryCtx.currentPiStream;
			stream?.push({ type: "error", reason: (queryCtx.turnOutput?.stopReason ?? "error") as "aborted" | "error", error: queryCtx.turnOutput! });
			markStreamComplete(stream);
			stream?.end();
			queryCtx.currentPiStream = null;
		})
		.finally(() => {
			if (options?.signal) options.signal.removeEventListener("abort", onAbort);
			// Settle any ack still parked in the generator — the CLI is gone, so
			// nothing will resume it. Clear the handle only if a later query
			// hasn't already claimed the shared context.
			promptStream.fail(new Error("query ended"));
			if (queryCtx.promptStream === promptStream) queryCtx.promptStream = null;
			// A later query claiming this context sets activeQuery to its own handle;
			// null means the .then/.catch above cleared ours and nothing replaced it.
			// Testing only for `=== sdkQuery` would never fire on the non-reentrant
			// path, leaving the top-level context in the routing set forever — where a
			// later orphaned tool result matches its stale turnToolCallIds and takes
			// the delivery branch, returning a stream nothing ends.
			if (queryCtx.activeQuery === sdkQuery || queryCtx.activeQuery === null) {
				queryCtx.releasePendingToolCalls("Query ended");
				queryCtx.activeQuery = null;
				activeQueryContexts.delete(queryCtx);
			}
			sdkQuery.close();
		});

	return stream;
}

// --- DelegateToClaude: prompt and wait ---

// One source for the delegation default so the query and the model/permission
// metadata rendered beside it cannot disagree about which model was requested.
const ASK_CLAUDE_DEFAULT_MODEL = "opus";

async function runAskClaudeDelegation(
	prompt: string,
	mode: "full" | "read" | "none",
	signal?: AbortSignal,
	options?: {
		systemPrompt?: string;
		appendSkills?: boolean;
		onSnapshot?: (snapshot: DelegationSnapshot) => void;
		model?: string;
		thinking?: string;
		isolated?: boolean;
		context?: Context["messages"];
		permissionMode?: PermissionMode;
		/** Pi's execute-context cwd; process.cwd() is only the fallback. */
		cwd?: string;
		/** Test seam forwarded to the delegation runner. */
		queryFactory?: DelegationQueryFactory;
	},
): Promise<DelegationRunResult> {
	const cwd = options?.cwd ?? process.cwd();
	const requestedModel = options?.model ?? ASK_CLAUDE_DEFAULT_MODEL;
	const model = resolveModel(requestedModel);
	const modelId = model?.id ?? normalizeClaudeModelRequest(requestedModel);
	const cliModel = model ? claudeCodeModelId(model, longContextSettings) : modelId;

	const isolated = options?.isolated ?? true;

	// Session resume for shared mode — reuse provider's session if it exists,
	// otherwise create one from pi's context.
	// Note: doesn't update sharedSession.cursor after completion, so the next
	// provider call will see missed messages and trigger a Case 4 rebuild.
	let resumeSessionId: string | null = null;
	if (!isolated && options?.context?.length) {
		if (sharedSession) {
			// Provider already has a session — just resume from it
			// Any missed messages from other providers were already handled by the provider's Case 4
			resumeSessionId = sharedSession.sessionId;
		} else {
			// No provider session yet — create one from pi's context
			const contextWithPrompt = [...options.context, { role: "user" as const, content: prompt, timestamp: Date.now() }];
			const sync = syncSharedSession(contextWithPrompt as Context["messages"], cwd, undefined, cliModel);
			resumeSessionId = sync.sessionId;
		}
	}

	// DelegateToClaude uses Claude Code's native Read tool rather than Pi's MCP bridge.
	// Same resolver as the provider path: a prompt neither recorded nor derivable
	// throws here too, rather than silently sending Claude Code no skills.
	//
	// Resolved only when the answer would be used. The throw is justified by what a
	// miss would cost, so where it costs nothing — skills switched off, or no reader
	// to open a skill file with — an unrelated miss must not fail the call.
	const delegationPolicy = resolveDelegationPolicy(mode, { permissionMode: options?.permissionMode });
	const skillReadTool = Array.isArray(delegationPolicy.tools) && delegationPolicy.tools.includes("Read")
		? "native"
		: delegationPolicy.capabilityMode === "full" ? "native" : "none";
	const skillCapture = options?.appendSkills !== false && skillReadTool !== "none"
		? promptCaptures.resolveOrDerive(options?.systemPrompt)
		: undefined;
	const skillsBlock = skillCapture
		? renderSkillsBlock(collectPromptSkills(skillCapture), skillReadTool)
		: undefined;

	// Effort
	const effort = options?.thinking && options.thinking !== "off"
		? REASONING_TO_EFFORT[options.thinking] : undefined;

	const queryInputs = {
		policy: delegationPolicy,
		cwd,
		env: { ...process.env, ...CC_CHILD_ENV },
		settings: { ...claudeCodeSettings(providerSettings), claudeMdExcludes: CLAUDE_MD_EXCLUDES },
		cliModel,
		effort,
		systemPromptAppend: skillsBlock,
		pathToClaudeCodeExecutable: providerSettings.pathToClaudeCodeExecutable,
		debugOptions: makeCliDebugOptions("askclaude"),
	};
	// Isolation and resume are mutually exclusive by type: an isolated call has no
	// session to resume, so the branch is made here rather than defended for later.
	const resolved = buildDelegationQueryOptions(isolated
		? { ...queryInputs, isolated: true }
		: { ...queryInputs, isolated: false, resumeSessionId });

	debug("delegation:",
		`mode=${mode} model=${modelId} cliModel=${cliModel} effort=${effort ?? "default"}`,
		`permission=${resolved.policy.requestedPermissionMode} isolated=${isolated} resume=${resumeSessionId?.slice(0, 8) ?? "none"}`,
		`skills=${Boolean(skillsBlock)} promptLen=${prompt.length}`);

	const result = await runDelegation({
		prompt,
		options: resolved.options,
		requestedPermissionMode: resolved.policy.requestedPermissionMode,
		signal,
		managedPolicy: observedManagedPolicy(cwd),
		onSnapshot: options?.onSnapshot,
		queryFactory: options?.queryFactory,
	});
	if (result.permission) {
		debug("delegation: permission mode",
			`requested=${result.permission.requested} effective=${result.permission.effective}`,
			`overridden=${result.permission.overridden}`,
			`managed=${managedPolicyLabels(result.managedPolicy).join(",") || "not-observed"}`);
	}
	for (const denial of result.permissionDenials) {
		debug("delegation: permission denied",
			`tool=${denial.toolName} reasonType=${denial.reasonType ?? "unknown"}`,
			denial.reason ?? denial.message);
	}
	if (result.snapshot.usage) {
		const usage = result.snapshot.usage;
		debug(`delegation: result usage: in=${usage.inputTokens} out=${usage.outputTokens} cacheRead=${usage.cacheReadInputTokens} cacheWrite=${usage.cacheCreationInputTokens} turns=${usage.turns}`);
	}
	debug("delegation: done",
		`stopReason=${result.stopReason} resultSubtype=${result.snapshot.resultSubtype ?? "none"}`,
		`sdkMessages=${result.messageCount} responseLen=${result.responseText.length}`,
		`toolCalls=${result.snapshot.tools.length}`);
	return result;
}

// --- Foreground delegation execution ---

interface ForegroundDelegationResult {
	content: { type: "text"; text: string }[];
	details: AskClaudeResultDetails;
}

interface ForegroundDelegationInput {
	toolCallId: string;
	/** Shown in the live overlay slot and retained in details as the call's prompt. */
	displayPrompt: string;
	/** The prompt actually sent to Claude Code (may wrap displayPrompt in a role/launch context). */
	delegationPrompt: string;
	mode: "full" | "read" | "none";
	isolated: boolean;
	requestedModel: string;
	thinking?: string;
	signal?: AbortSignal;
	onUpdate?: (update: ForegroundDelegationResult) => void;
	systemPrompt?: string;
	appendSkills?: boolean;
	permissionMode?: PermissionMode;
	/** Pi branch messages for isolated=false session resume; undefined when isolated. */
	context?: Context["messages"];
	cwd?: string;
	/** Persisted label facts (e.g. SpawnClaudeAgent foreground profile) merged into every published details object. */
	detailExtras?: Pick<AskClaudeResultDetails, "origin" | "profile">;
	/** Test seam forwarded to the delegation runner. */
	queryFactory?: DelegationQueryFactory;
}

/**
 * The one foreground execution path: blocking DelegateToClaude calls and foreground
 * SpawnClaudeAgent calls both run through here, so there is a single
 * synchronous delegation runner, retained-snapshot/live-update pipeline, live
 * overlay slot, finalization, and error-promotion contract. Callers differ only
 * in how they build the delegation prompt and which label extras they persist.
 */
async function executeForegroundDelegation(input: ForegroundDelegationInput): Promise<ForegroundDelegationResult> {
	const { toolCallId, displayPrompt, mode, isolated, requestedModel } = input;
	const extras = input.detailExtras ?? {};
	const start = Date.now();
	let lastSnapshot: DelegationSnapshot | undefined;
	let lastPublishedAt = 0;
	let pendingPublish: ReturnType<typeof setTimeout> | undefined;

	const publishSnapshot = (force = false) => {
		if (!lastSnapshot) return;
		const now = Date.now();
		const delay = 100 - (now - lastPublishedAt);
		if (!force && delay > 0) {
			pendingPublish ??= setTimeout(() => {
				pendingPublish = undefined;
				publishSnapshot(true);
			}, delay);
			return;
		}
		if (pendingPublish) clearTimeout(pendingPublish);
		pendingPublish = undefined;
		lastPublishedAt = now;
		const update = buildAskClaudePartialUpdate(lastSnapshot, {
			prompt: displayPrompt,
			executionTime: now - start,
			capabilityMode: mode,
			requestedModel,
			thinking: input.thinking,
			isolated,
		});
		const details = { ...update.details, ...extras };
		// Same bounded, retained, redacted record the tool row streams — the
		// details overlay's live view adds no second retention path.
		updateLiveAskClaudeCall({ toolCallId, startedAt: start, prompt: displayPrompt, details });
		input.onUpdate?.({ ...update, details });
	};
	const progressInterval = setInterval(() => publishSnapshot(true), 1000);
	const stopPublishing = () => {
		clearInterval(progressInterval);
		if (pendingPublish) clearTimeout(pendingPublish);
	};

	// Seed the live slot before the first snapshot so /claude-details and
	// ctrl+n can show the running call immediately. The slot keeps the final
	// details after completion until the session branch persists the result,
	// which then shadows it; the next call replaces the slot.
	updateLiveAskClaudeCall({
		toolCallId,
		startedAt: start,
		prompt: displayPrompt,
		details: {
			prompt: retainAskClaudePrompt(displayPrompt),
			executionTime: 0,
			capabilityMode: mode,
			requestedModel,
			thinking: input.thinking,
			isolated,
			...extras,
		},
	});

	try {
		const result = await runAskClaudeDelegation(input.delegationPrompt, mode, input.signal, {
			systemPrompt: input.systemPrompt,
			appendSkills: input.appendSkills,
			onSnapshot: (snapshot) => {
				lastSnapshot = snapshot;
				publishSnapshot();
			},
			model: requestedModel,
			thinking: input.thinking,
			isolated,
			permissionMode: input.permissionMode,
			context: input.context,
			cwd: input.cwd,
			queryFactory: input.queryFactory,
		});
		stopPublishing();
		const finalized = finalizeAskClaudeResult({
			result,
			prompt: displayPrompt,
			executionTime: Date.now() - start,
			capabilityMode: mode,
			requestedModel,
			thinking: input.thinking,
			isolated,
		});
		const details = { ...finalized.details, ...extras };
		updateLiveAskClaudeCall({ toolCallId, startedAt: start, prompt: displayPrompt, details });
		return { content: finalized.content, details };
	} catch (err) {
		stopPublishing();
		debug(`foreground delegation error: mode=${mode}, model=${requestedModel}, isolated=${isolated}, elapsed=${((Date.now() - start) / 1000).toFixed(1)}s, error=`, err);
		// Summarize the retained snapshot, not the raw one: the failure path
		// persists and displays the same bounded, redacted record as success.
		const retainedSnapshot = lastSnapshot ? retainDelegationSnapshot(lastSnapshot) : undefined;
		const errorDetails: AskClaudeResultDetails = {
			prompt: retainAskClaudePrompt(displayPrompt),
			executionTime: Date.now() - start,
			actions: retainedSnapshot ? buildSnapshotActionSummary(retainedSnapshot) : undefined,
			capabilityMode: mode,
			requestedModel,
			thinking: input.thinking,
			isolated,
			error: true,
			permissionDenials: retainedSnapshot?.permissionDenials,
			snapshot: retainedSnapshot,
			...extras,
		};
		updateLiveAskClaudeCall({ toolCallId, startedAt: start, prompt: displayPrompt, details: errorDetails });
		return {
			content: [{ type: "text" as const, text: assembleModelResult({ answer: `Error: ${errorMessage(err)}` }) }],
			details: errorDetails,
		};
	}
}

// --- SpawnClaudeAgent: background jobs and foreground calls ---

let spawnClaudeAgentToolName = "SpawnClaudeAgent";

/** Bounded launch facts for the persisted spawn result — never the diff text itself. */
interface SpawnClaudeAgentResultDetails {
	jobId?: string;
	mode?: CapabilityMode;
	/** Derived role/presentation label; capability is selected by `mode`. */
	profile?: AgentProfileId;
	requestedModel?: string;
	thinking?: string;
	launchCwd?: string;
	launchCapturedAt?: number;
	diffSource?: string;
	/** True when the launch artifact's diff or status text was truncated to its bound. */
	diffArtifactTruncated?: boolean;
	error?: boolean;
}

/**
 * Promote a failed spawn to pi's `toolResult.isError`, exactly like
 * `askClaudeResultIsError`: a rejected second spawn or a diff-capture failure
 * must reach the model as an error result, not as a successful-looking answer.
 */
function spawnClaudeAgentResultIsError(
	event: { toolName: string; isError: boolean; details?: unknown },
): { isError: true } | undefined {
	if (event.toolName !== spawnClaudeAgentToolName || event.isError) return undefined;
	return (event.details as SpawnClaudeAgentResultDetails | undefined)?.error ? { isError: true } : undefined;
}

/**
 * Run one background job through the shared delegation runner. Always a fresh
 * isolated Claude session; `mode` selects the same none/read/full capability
 * inventory DelegateToClaude uses. The derived profile contributes only a role prompt
 * and presentation label; permission policy comes from the same configured
 * DelegateToClaude delegation settings — never a hard-coded bypass.
 */
function runBackgroundJobDelegation(input: {
	prompt: string;
	profile: AgentProfile;
	requestedModel: string;
	thinking?: string;
	cwd: string;
	signal: AbortSignal;
	onSnapshot: (snapshot: DelegationSnapshot) => void;
	permissionMode?: PermissionMode;
}): Promise<DelegationRunResult> {
	const model = resolveModel(input.requestedModel);
	const cliModel = model
		? claudeCodeModelId(model, longContextSettings)
		: normalizeClaudeModelRequest(input.requestedModel);
	const policy = resolveDelegationPolicy(input.profile.capabilityMode, { permissionMode: input.permissionMode });
	const effort = input.thinking && input.thinking !== "off"
		? REASONING_TO_EFFORT[input.thinking] : undefined;
	const resolved = buildDelegationQueryOptions({
		policy,
		cwd: input.cwd,
		env: { ...process.env, ...CC_CHILD_ENV },
		settings: { ...claudeCodeSettings(providerSettings), claudeMdExcludes: CLAUDE_MD_EXCLUDES },
		cliModel,
		effort,
		pathToClaudeCodeExecutable: providerSettings.pathToClaudeCodeExecutable,
		debugOptions: makeCliDebugOptions("spawnagent"),
		isolated: true,
	});
	debug("spawnClaudeAgent:",
		`profile=${input.profile.id} model=${input.requestedModel} cliModel=${cliModel}`,
		`effort=${effort ?? "default"} permission=${resolved.policy.requestedPermissionMode} promptLen=${input.prompt.length}`);
	return runDelegation({
		prompt: input.prompt,
		options: resolved.options,
		requestedPermissionMode: resolved.policy.requestedPermissionMode,
		signal: input.signal,
		managedPolicy: observedManagedPolicy(input.cwd),
		onSnapshot: input.onSnapshot,
	});
}

function spawnedJobResultText(record: BackgroundJobRecord): string {
	const mode = AGENT_PROFILES[record.profile].capabilityMode;
	const worker = mode === "full";
	const capability = mode === "none" ? "no-access" : mode === "read" ? "read-only" : "full-capability";
	const parts = [
		`Started background Claude job ${record.id} (mode=${mode}, agent=${record.profile}, model=${record.requestedModel}${record.thinking ? `, thinking=${record.thinking}` : ""}).`,
		`It runs in a fresh isolated ${capability} Claude session in ${record.launch.cwd} on context captured at launch${record.launch.diff ? ` (review diff artifact: ${record.launch.diff.source})` : ""}.`,
		"One background job runs per session; a second spawn fails until this one finishes.",
	];
	if (worker) {
		parts.push("SINGLE-WRITER WARNING: this worker edits the current checkout while it runs. Until its completion message arrives, do not edit, create, or delete files or run mutating commands in this checkout — inspect and discuss only.");
	}
	parts.push(`When the job reaches a terminal state its bounded result is delivered into this conversation as a message you will see on a later turn — ${worker ? "" : "keep working normally; "}there are no status, result, or cancel tools to poll.`);
	return parts.join(" ");
}

/** One foreground SpawnClaudeAgent call handed to the shared foreground execution implementation. */
interface SpawnForegroundRun {
	toolCallId: string;
	/** The caller's task text — displayed/persisted as the call's prompt. */
	task: string;
	/** The full delegation prompt (role prompt + launch context + task, reviewer diff included). */
	prompt: string;
	profile: AgentProfile;
	requestedModel: string;
	thinking?: string;
	isolated: boolean;
	cwd: string;
	signal: AbortSignal;
	onUpdate?: (update: ForegroundDelegationResult) => void;
	systemPrompt?: string;
	/** Pi branch messages when isolated=false; resumed exactly like DelegateToClaude shared mode. */
	context?: Context["messages"];
}

/** Injected effects for `registerSpawnClaudeAgent` — the seam unit tests replace all of them. */
interface SpawnClaudeAgentDeps {
	/** SpawnClaudeAgent shares DelegateToClaude's opt-in; nothing registers when it is off. */
	enabled: boolean;
	/**
	 * Whether full capability is offered. Wired from the
	 * DelegateToClaude contract's allowFullMode lockout so a configuration that forbids
	 * full mode cannot be bypassed through SpawnClaudeAgent.
	 */
	allowFull: boolean;
	/** Effective requested permission mode, for rendering only. */
	requestedPermissionMode?: string;
	/** Shared atomic lease for every full-capability Claude writer. */
	writeLease?: CheckoutWriteLease;
	jobs: BackgroundJobManager;
	captureDiff: (input: { cwd: string; base?: string; capturedAt: number }) => Promise<ReviewerDiffArtifact>;
	runJob: (input: {
		prompt: string;
		profile: AgentProfile;
		requestedModel: string;
		thinking?: string;
		cwd: string;
		signal: AbortSignal;
		onSnapshot: (snapshot: DelegationSnapshot) => void;
	}) => Promise<DelegationRunResult>;
	/** Foreground execution — production wires the shared `executeForegroundDelegation`. */
	runForeground: (input: SpawnForegroundRun) => Promise<ForegroundDelegationResult>;
	cwd?: (ctx: Pick<ExtensionContext, "cwd">) => string;
	now?: () => number;
}

/** Mirror Pi's default (no-renderResult) tool result rendering for background spawn results. */
function renderSpawnBackgroundResult(
	result: { content: Array<{ type: string; text?: string }> },
	options: { expanded: boolean },
	theme: Parameters<typeof renderAskClaudeResult>[2],
): Text {
	const output = result.content[0]?.type === "text" ? result.content[0].text ?? "" : "";
	const lines = output.split("\n");
	const displayLines = options.expanded ? lines : lines.slice(0, 10);
	const remaining = lines.length - displayLines.length;
	let text = displayLines.map((line) => theme.fg("toolOutput", line)).join("\n");
	if (remaining > 0) {
		text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
	}
	return new Text(text, 0, 0);
}

/**
 * Narrow adapter seam that wires SpawnClaudeAgent into Pi: tool registration,
 * error-result promotion, and the session lifecycle cleanup of background
 * jobs. Everything impure — the job manager, reviewer diff capture, background
 * delegation, foreground execution, cwd, clock — arrives injected so the wiring
 * is deterministic to test; production injects the real implementations from
 * the extension entry.
 *
 * Both execution modes are callers of the shared delegation runner. A
 * background job returns promptly with a job ID and never enters foreground
 * finalization or provider QueryContext; a foreground call blocks and returns
 * its bounded result through the same foreground implementation DelegateToClaude uses.
 */
function registerSpawnClaudeAgent(pi: Pick<ExtensionAPI, "registerTool" | "on">, deps: SpawnClaudeAgentDeps): void {
	if (!deps.enabled) return;
	const { jobs } = deps;
	const cwdOf = deps.cwd ?? ((ctx: Pick<ExtensionContext, "cwd">) => ctx.cwd);
	const now = deps.now ?? Date.now;
	const renderPermissionMode = deps.requestedPermissionMode ?? DEFAULT_PERMISSION_MODE;
	const writeLease = deps.writeLease ?? new CheckoutWriteLease();

	pi.on("tool_result", (event) => spawnClaudeAgentResultIsError(event));
	// Background jobs are Pi-session-scoped. Both handlers are async and Pi
	// 0.84.2 awaits them, so this cleanup — bounded by the manager's shutdown
	// grace — really completes before the session is replaced or torn down;
	// jobs that settle inside the grace keep their genuine terminal state and
	// only unconfirmed ones are recorded as abandoned.
	pi.on("session_start", async (event) => {
		if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") {
			await jobs.reset();
		}
	});
	pi.on("session_shutdown", async () => {
		await jobs.shutdown();
	});

	const modeValues = deps.allowFull ? ["none", "read", "full"] as const : ["none", "read"] as const;
	const modeDescription = '"none": no tools. "read": read-only repository/web access.'
		+ (deps.allowFull
			? ' "full": Bash/Edit/Write; only for explicit user-requested implementation.'
			: "");
	const spawnClaudeAgentParams = Type.Object({
		task: Type.String({ description: "Complete task instructions; isolated agents do not see Pi history." }),
		mode: StringEnum(modeValues, { description: modeDescription }),
		review: Type.Optional(Type.Object({
			base: Type.Optional(Type.String({ description: "Git ref; the review diff starts at its merge base with HEAD." })),
		}, { description: 'Read-mode code review. Omit base to review working-tree changes against HEAD.' })),
		user_requested: Type.Optional(Type.Boolean({ description: "Required true for full mode; set only for explicit user-requested implementation delegation." })),
		execution: Type.Optional(StringEnum(["foreground", "background"] as const, { description: '"background" (default): return a job ID now and deliver the result later. "foreground": block and return the result directly.' })),
		isolated: Type.Optional(Type.Boolean({ description: "Foreground only. true (default): fresh session. false: include Pi history. Background is always isolated." })),
		model: Type.Optional(Type.String({ description: 'Model name or ID. Default: "opus".' })),
		thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const, { description: "Thinking effort level. Omit to use Claude Code's default." })),
	});
	pi.registerTool<typeof spawnClaudeAgentParams>({
		name: spawnClaudeAgentToolName,
		label: "Spawn Claude Agent",
		description: "Start a foreground or background (default) Claude Code agent. Background returns a job ID and delivers the result later; do not poll. One background job may run per Pi session."
			+ (deps.allowFull ? " Full mode requires explicit user delegation; do not edit concurrently with a background full-mode agent." : ""),
		parameters: spawnClaudeAgentParams,
		renderCall(args, theme) {
			let text = theme.fg("mdLink", theme.bold("SpawnClaudeAgent "));
			// Restored Phase 3c tool calls still carry `profile`; derive their
			// capability so old transcript rows never render `mode=undefined`.
			const legacyProfile = (args as typeof args & { profile?: unknown }).profile;
			const mode = args.mode ?? (typeof legacyProfile === "string" ? agentCapabilityMode(legacyProfile) : undefined);
			const tags = [`mode=${mode ?? "unavailable"}`, `execution=${args.execution ?? "background"}`];
			if (typeof legacyProfile === "string") tags.push(`agent=${legacyProfile}`);
			if (args.review) tags.push("review");
			if (args.user_requested) tags.push("user-requested");
			if (args.isolated !== undefined) tags.push(args.isolated ? "isolated" : "shared");
			tags.push(`model=${args.model ?? ASK_CLAUDE_DEFAULT_MODEL}`);
			if (args.thinking) tags.push(`thinking=${args.thinking}`);
			if (args.review?.base) tags.push(`base=${args.review.base}`);
			text += `${theme.fg("accent", `[${tags.join(", ")}]`)} `;
			const truncated = args.task.length > PREVIEW_MAX_CHARS ? args.task.substring(0, PREVIEW_MAX_CHARS) : args.task;
			const lines = truncated.split("\n").slice(0, PREVIEW_MAX_LINES);
			text += theme.fg("muted", `"${lines.join("\n")}"`);
			if (args.task.length > PREVIEW_MAX_CHARS || args.task.split("\n").length > PREVIEW_MAX_LINES) text += theme.fg("dim", " …");
			return new Text(text, 0, 0);
		},
		renderResult(result, options, theme, context) {
			// Foreground calls carry the DelegateToClaude-shaped details (marked with
			// origin) and reuse the same rich renderer; background results keep
			// Pi's plain default-style rendering.
			const details = result.details as AskClaudeResultDetails | SpawnClaudeAgentResultDetails | undefined;
			if (details && "origin" in details && details.origin === "spawn-foreground") {
				return renderAskClaudeResult(result, options, theme, context, renderPermissionMode);
			}
			return renderSpawnBackgroundResult(result, options, theme);
		},
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const requestedModel = params.model ?? ASK_CLAUDE_DEFAULT_MODEL;
			const rawMode: unknown = params.mode;
			const rawReview: unknown = params.review;
			const rawExecution: unknown = params.execution ?? "background";
			const mode = rawMode === "none" || rawMode === "read" || rawMode === "full"
				? rawMode as CapabilityMode
				: undefined;
			const review = rawReview === undefined
				? undefined
				: typeof rawReview === "object" && rawReview !== null && !Array.isArray(rawReview)
					? rawReview as { base?: unknown }
					: null;
			let profile: AgentProfile | undefined;
			if (mode && review !== null && (!review || mode === "read")) {
				profile = resolveAgentProfile(mode, review !== undefined);
			}
			const spawnError = (text: string): { content: { type: "text"; text: string }[]; details: SpawnClaudeAgentResultDetails } => ({
				content: [{ type: "text" as const, text: assembleModelResult({ answer: `Error: ${text}` }) }],
				details: { error: true, ...(mode ? { mode } : {}), ...(profile ? { profile: profile.id } : {}), requestedModel, thinking: params.thinking },
			});

			if (ctx.model?.baseUrl === "claude-delegation") {
				debug("spawnClaudeAgent: blocked circular delegation (active provider is claude-delegation)");
				return spawnError("SpawnClaudeAgent cannot be used when the active provider is claude-delegation — you're already running through Claude Code.");
			}
			if (!mode) {
				return spawnError(`Unknown SpawnClaudeAgent capability mode: ${typeof rawMode === "string" ? rawMode : String(rawMode)}.`);
			}
			if (rawExecution !== "foreground" && rawExecution !== "background") {
				return spawnError(`Unknown SpawnClaudeAgent execution mode: ${typeof rawExecution === "string" ? rawExecution : String(rawExecution)}.`);
			}
			const execution = rawExecution;
			if (review === null) {
				return spawnError("The review parameter must be an object when provided.");
			}
			if (review?.base !== undefined && typeof review.base !== "string") {
				return spawnError("The review.base parameter must be a string when provided.");
			}
			if (review && mode !== "read") {
				return spawnError('Review specialization requires mode="read".');
			}
			// Schema-level gating already hides full mode; this keeps a
			// restored or hand-written call from bypassing the allowFullMode lockout.
			if (mode === "full" && !deps.allowFull) {
				return spawnError('SpawnClaudeAgent mode="full" is disabled: delegation.allowFullMode is false in this configuration.');
			}
			if (mode === "full" && params.user_requested !== true) {
				return spawnError('SpawnClaudeAgent mode="full" requires user_requested=true, and that assertion may be supplied only when the user explicitly asked to delegate implementation to Claude.');
			}
			if (mode !== "full" && params.user_requested !== undefined) {
				return spawnError('The user_requested assertion applies only to mode="full".');
			}
			if (!profile) return spawnError("Could not resolve the requested Claude agent role.");
			// Background jobs are always fresh and isolated; silently ignoring
			// isolated=false would change semantics the caller asked for.
			if (execution === "background" && params.isolated === false) {
				return spawnError('execution="background" always runs a fresh isolated Claude session; isolated=false (shared Pi conversation context) requires execution="foreground".');
			}
			// The initiating tool call owns the launch: a cancelled call must not
			// start anything, and a spawn the manager would reject anyway must not
			// pay for reviewer diff capture.
			if (signal.aborted) {
				debug("spawnClaudeAgent: tool call cancelled before launch");
				return spawnError("SpawnClaudeAgent was cancelled before it launched anything; no agent was started.");
			}
			if (execution === "background") {
				const alreadyRunning = jobs.running();
				if (alreadyRunning) {
					return spawnError(new BackgroundJobLimitError(alreadyRunning.id).message);
				}
			}

			let writeLeaseHandle: CheckoutWriteLeaseHandle | undefined;
			if (profile.capabilityMode === "full") {
				writeLeaseHandle = writeLease.tryAcquire({
					id: `${spawnClaudeAgentToolName}:${execution}:${toolCallId}`,
					label: `${spawnClaudeAgentToolName} ${execution} full-mode worker`,
				});
				if (!writeLeaseHandle) return spawnError(checkoutWriteConflictText(writeLease));
			}

			try {
				const cwd = cwdOf(ctx);
				const capturedAt = now();
				// The extension captures the reviewer's diff at launch in either
				// execution mode; the agent never gets Bash to take its own. Capture
				// failures (non-git directory, invalid base) must fail the spawn
				// visibly here, not hand the reviewer an empty diff it would read as
				// "no changes".
				const diff = profile.requiresDiffArtifact
					? await deps.captureDiff({ cwd, base: typeof review?.base === "string" ? review.base : undefined, capturedAt })
					: undefined;
				// The capture awaited; the tool call may have been cancelled meanwhile.
				if (signal.aborted) {
					debug("spawnClaudeAgent: tool call cancelled during launch capture");
					return spawnError("SpawnClaudeAgent was cancelled during launch capture; no agent was started.");
				}
				const launch: BackgroundJobLaunch = { cwd, capturedAt, ...(diff ? { diff } : {}) };
				const prompt = buildAgentJobPrompt({ profile, task: params.task, launch });

				if (execution === "foreground") {
					// Foreground blocks this tool call and returns the bounded result
					// through the same implementation as DelegateToClaude: same runner, live
					// updates, retained snapshot, overlay slot, and error semantics.
					// Pi is blocked while it runs, so a foreground worker is naturally
					// the only writer of the checkout.
					const isolated = params.isolated ?? true;
					debug(`spawnClaudeAgent: foreground mode=${mode} agent=${profile.id} isolated=${isolated} diff=${diff ? diff.source : "none"}`);
					try {
						return await deps.runForeground({
							toolCallId,
							task: params.task,
							prompt,
							profile,
							requestedModel,
							thinking: params.thinking,
							isolated,
							cwd,
							signal,
							onUpdate,
							systemPrompt: ctx.getSystemPrompt(),
							context: isolated ? undefined : buildSessionContext(ctx.sessionManager.getBranch()).messages as Context["messages"],
						});
					} finally {
						writeLeaseHandle?.release();
						writeLeaseHandle = undefined;
					}
				}

				// From here the job's own AbortController owns its lifecycle; the
				// initiating tool call's signal deliberately plays no further part.
				const record = jobs.spawn({
					profile: profile.id,
					task: params.task,
					requestedModel,
					thinking: params.thinking,
					launch,
					execute: (run) => deps.runJob({
						prompt,
						profile,
						requestedModel,
						thinking: params.thinking,
						cwd,
						signal: run.signal,
						onSnapshot: run.onSnapshot,
					}),
				});
				if (writeLeaseHandle) {
					const settlement = jobs.settled(record.id);
					if (!settlement) {
						// The worker already exists. Fail closed: deliberately orphan the
						// handle while the process-global lease stays held, rather than let
						// the outer catch release write ownership under a running writer.
						writeLeaseHandle = undefined;
						throw new Error(`Background worker ${record.id} has no settlement handle; checkout write ownership remains held because termination cannot be confirmed.`);
					}
					const transferredLease = writeLeaseHandle;
					void settlement.finally(() => transferredLease.release());
					writeLeaseHandle = undefined;
				}
				debug(`spawnClaudeAgent: started ${record.id} profile=${record.profile} diff=${diff ? diff.source : "none"}`);
				return {
					content: [{ type: "text" as const, text: spawnedJobResultText(record) }],
					details: {
						jobId: record.id,
						mode,
						profile: record.profile,
						requestedModel: record.requestedModel,
						thinking: record.thinking,
						launchCwd: record.launch.cwd,
						launchCapturedAt: record.launch.capturedAt,
						...(diff ? { diffSource: diff.source, diffArtifactTruncated: diff.diffTruncated || diff.statusTruncated } : {}),
					} satisfies SpawnClaudeAgentResultDetails,
				};
			} catch (err) {
				writeLeaseHandle?.release();
				if (!(err instanceof BackgroundJobLimitError)) {
					debug(`spawnClaudeAgent error: mode=${mode} agent=${profile.id} execution=${execution} model=${requestedModel}`, err);
				}
				return spawnError(errorMessage(err));
			}
		},
	});
}

// --- Extension registration ---

const PREVIEW_MAX_CHARS = 1000;
const PREVIEW_MAX_LINES = 6;

let askClaudeToolName = "DelegateToClaude";

export default function (pi: ExtensionAPI) {
	// Disable non-essential Claude Code traffic (update checks, MCP registry, telemetry)
	process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";

	const config = loadConfig(process.cwd());
	debug("loadConfig:", JSON.stringify(config));
	providerSettings = config.provider ?? {};
	// We need these settings to know if we're eligible for 1M context on certain models
	longContextSettings = {
		plan: providerSettings.plan ?? "pro",
		longContextExtraUsage: providerSettings.longContextExtraUsage ?? false,
	};
	const registeredModels = applyLongContext(MODELS, longContextSettings);

	// Session-scoped background Claude jobs (SpawnClaudeAgent). One manager per
	// extension runtime, each with its own collision-resistant random job-ID
	// prefix, so records from before and after a /reload are overwhelmingly
	// unlikely to collide; the session lifecycle cleanup is wired inside
	// registerSpawnClaudeAgent.
	const backgroundJobs = new BackgroundJobManager({ onDebug: debug });
	// Process-wide across extension reloads: an unconfirmed worker from the old
	// runtime must keep blocking another full-capability writer in the new one.
	const checkoutWriteLease = globalCheckoutWriteLease();

	if (!config.startupNoticeShown) {
		if (config.provider?.plan === undefined) pendingNotices.push('Are you using a Max plan? You need to set provider.plan to "max" to unlock 1M context in Opus.');
		if (config.delegation?.enabled === undefined) pendingNotices.push("Claude delegation tools are opt-in only. Set delegation.enabled to use them.");
	}

	// Reset shared session on pi session lifecycle events
	const clearSession = (event: string) => {
		debug(`${event}: clearing session ${sharedSession?.sessionId?.slice(0, 8) ?? "none"}`);
		sharedSession = null;
		shownProviderPermissionOverrides.clear();
		// A live DelegateToClaude record from a previous session branch must not surface
		// in the details overlay of the next one.
		clearLiveAskClaudeCall();

		// Clear the global streamSimple if this instance registered it.
		// This allows /reload to work — the old instance clears the flag so
		// the new instance can register fresh without wrapping stale state.
		const g = globalThis as Record<symbol, any>;
		if (g[ACTIVE_STREAM_SIMPLE_KEY] === streamClaudeAgentSdk) {
			debug(`${event}: clearing ACTIVE_STREAM_SIMPLE_KEY`);
			g[ACTIVE_STREAM_SIMPLE_KEY] = undefined;
		}
	};
	pi.on("session_start", (event, ctx) => {
		piUI = ctx.ui;
		piMode = ctx.mode;
		if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") {
			clearSession(`session_start:${event.reason}`);
		}
	});
	// `--system-prompt` replaces pi's default rather than adding to it, but Claude
	// Code's preset carries its own tool and permission guidance that the bridge
	// still depends on, so both flags are forwarded as an append.
	pi.on("before_agent_start", (event) => {
		const options = event.systemPromptOptions;
		const hasRead = !options?.selectedTools || options.selectedTools.includes("read");
		promptCaptures.record(event.systemPrompt, {
			custom: options?.customPrompt,
			append: options?.appendSystemPrompt,
			contextFiles: options?.contextFiles ?? [],
			skills: hasRead ? options?.skills ?? [] : [],
		});
	});
	pi.on("session_shutdown", () => {
		reportLeaks("session_shutdown");
		clearSession("session_shutdown");
	});

	pi.on("session_before_compact", async (event, ctx) => {
		if (ctx.model?.baseUrl !== "claude-delegation") return undefined;
		debug(
			`session_before_compact: takeover reason=${event.reason} willRetry=${event.willRetry} ` +
			`isSplitTurn=${event.preparation.isSplitTurn} messages=${event.preparation.messagesToSummarize.length} ` +
			`turnPrefix=${event.preparation.turnPrefixMessages.length}`,
		);
		try {
			reinjectPriorCompactionFileOps(event.branchEntries, event.preparation);
			const compaction = await compact(
				event.preparation,
				ctx.model,
				undefined,
				undefined,
				event.customInstructions,
				event.signal,
				undefined,
				isolatedStreamFn,
				undefined,
			);
			debug(`session_before_compact: takeover complete summaryLen=${compaction.summary.length}`);
			return { compaction };
		} catch (err) {
			const msg = errorMessage(err);
			debug("session_before_compact: takeover failed; cancelling to avoid native compact fallback", err);
			ctx.ui?.notify?.(
				`Claude bridge compact failed (${msg}); cancelled to avoid known hang. Retry, switch model, or reduce context.`,
				"error",
			);
			return { cancel: true };
		}
	});

	// pi /compact and session-tree navigation (rewind / fork-at-point /
	// branch switch) both mutate pi's messages array out from under the
	// bridge. syncSharedSession's REUSE check would otherwise see
	// slice(cursor) === [] (or skip entries) and keep --resume'ing a CC
	// session that no longer matches pi's history. /compact in particular
	// triggers CC's autocompact-thrashing guard (issue #8). Force the next
	// call down the REBUILD path so CC sees the current history.
	const markRebuild = (event: string) => {
		if (sharedSession) {
			debug(`${event}: marking needsRebuild on session ${sharedSession.sessionId.slice(0, 8)}`);
			sharedSession = { ...sharedSession, needsRebuild: true };
		}
	};
	pi.on("session_compact", (event) => markRebuild(`session_compact:${event.reason}:willRetry=${event.willRetry}`));
	pi.on("session_tree", () => {
		markRebuild("session_tree");
		// Rewind, fork-at-point, and branch switching can remove the most recent
		// DelegateToClaude call from the active branch. Do not merge its stale live slot
		// back into the overlay after navigation.
		clearLiveAskClaudeCall();
	});

	// Branch summarization — rewind or fork-at-point with "summarize" — is the other
	// place pi asks the model for a summary, and unlike compaction it runs through
	// the *agent's* stream function (agent-session passes `streamFn:
	// this.agent.streamFunction`). On a bridge model that reaches this provider
	// carrying pi's internal summarization prompt, which no `before_agent_start`
	// ever recorded, so the prompt-capture resolver has nothing to resolve it to.
	// Take it over the way compaction is taken over: the summary runs as its own
	// Claude Code subprocess, never touching the live session or the resolver.
	pi.on("session_before_tree", async (event, ctx) => {
		if (ctx.model?.baseUrl !== "claude-delegation") return undefined;
		const { entriesToSummarize, userWantsSummary, customInstructions, replaceInstructions } = event.preparation;
		if (!userWantsSummary || entriesToSummarize.length === 0) return undefined;
		debug(`session_before_tree: takeover entries=${entriesToSummarize.length} target=${event.preparation.targetId.slice(0, 8)}`);
		try {
			const result = await generateBranchSummary(entriesToSummarize, {
				model: ctx.model,
				signal: event.signal,
				customInstructions,
				replaceInstructions,
				streamFn: isolatedStreamFn,
			});
			return branchSummaryOutcome(result);
		} catch (err) {
			debug("session_before_tree: takeover failed; cancelling navigation", err);
			ctx.ui?.notify?.(
				`Claude bridge branch summary failed (${errorMessage(err)}); navigation cancelled.`,
				"error",
			);
			return { cancel: true };
		}
	});

	// --- Provider ---
	//
	// Guard against re-registration when the module is loaded multiple times
	// (e.g., when spawning subagents). The shared ModelRegistry would otherwise
	// overwrite the parent's streamSimple, breaking tool result delivery.
	// See ACTIVE_STREAM_SIMPLE_KEY for the full mechanism.

	const g = globalThis as Record<symbol, any>;
	if (!g[ACTIVE_STREAM_SIMPLE_KEY]) {
		// First instance: store our streamSimple and register.
		g[ACTIVE_STREAM_SIMPLE_KEY] = streamClaudeAgentSdk;
		pi.registerProvider(PROVIDER_ID, {
			baseUrl: "claude-delegation",
			apiKey: "not-used",
			api: "claude-delegation",
			models: registeredModels,
			// Cast: pi-ai AssistantMessageEventStream diamond dep between pi-coding-agent and pi-agent-core
			streamSimple: streamClaudeAgentSdk as any,
		});
	} else {
		// Subsequent instance (subagent session): skip registration entirely.
		// The subagent already has access to claude-delegation models via the shared
		// ModelRegistry from the parent's registration. Calls to those models
		// route through the parent's streamSimple via reentrant QueryContexts.
		debug(`provider: skipping re-registration, parent instance active (module=${moduleInstanceId})`);
	}

	// --- DelegateToClaude tool ---

	const askConf = config.delegation;
	const askContract = buildAskClaudeContract(askConf);
	const { defaultMode, defaultIsolated, modeValues } = askContract;
	const askPermissionMode = resolveDelegationPolicy(defaultMode, askConf).requestedPermissionMode;
	askClaudeToolName = askConf?.name ?? "DelegateToClaude";

	// The unified Claude Sessions overlay (Ctrl+N, /claude-details, and the
	// /askclaude-details compatibility alias) registers under the same opt-in;
	// its /claude-jobs open handle is wired into registerBackgroundJobUI below.
	let claudeSessionsUI: ClaudeSessionsUIHandle | undefined;
	if (askConf?.enabled) {
		pi.on("tool_result", (event) => askClaudeResultIsError(event));
		claudeSessionsUI = registerClaudeSessionsUI(pi, { toolName: askClaudeToolName, spawnToolName: spawnClaudeAgentToolName, jobs: backgroundJobs });

		const askClaudeParams = Type.Object({
			prompt: Type.String({ description: askContract.promptDescription }),
			mode: Type.Optional(StringEnum(modeValues, { description: askContract.modeDescription })),
			model: Type.Optional(Type.String({ description: 'Model name or ID. Default: "opus".' })),
			thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const, { description: "Thinking effort level. Omit to use Claude Code's default." })),
			isolated: Type.Optional(Type.Boolean({ description: askContract.isolatedDescription })),
		});
		pi.registerTool<typeof askClaudeParams>({
			name: askConf?.name ?? "DelegateToClaude",
			label: askConf?.label ?? "Delegate to Claude",
			description: askContract.toolDescription,
			parameters: askClaudeParams,
			renderCall(args, theme) {
				let text = theme.fg("mdLink", theme.bold("DelegateToClaude "));
				const tags = askClaudeContextTags(args, askContract);
				tags.push(`permission=${askPermissionMode}`);
				if (args.model) tags.push(`model=${args.model}`);
				if (args.thinking) tags.push(`thinking=${args.thinking}`);
				if (tags.length) text += `${theme.fg("accent", `[${tags.join(", ")}]`)} `;
				const truncated = args.prompt.length > PREVIEW_MAX_CHARS ? args.prompt.substring(0, PREVIEW_MAX_CHARS) : args.prompt;
				const lines = truncated.split("\n").slice(0, PREVIEW_MAX_LINES);
				text += theme.fg("muted", `"${lines.join("\n")}"`);
				if (args.prompt.length > PREVIEW_MAX_CHARS || args.prompt.split("\n").length > PREVIEW_MAX_LINES) text += theme.fg("dim", " …");
				return new Text(text, 0, 0);
			},
			renderResult(result, options, theme, context) {
				return renderAskClaudeResult(result, options, theme, context, askPermissionMode);
			},
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				// Guard: circular delegation
				if (ctx.model?.baseUrl === "claude-delegation") {
					debug("delegateToClaude: blocked circular delegation (active provider is claude-delegation)");
					return {
						content: [{ type: "text" as const, text: "Error: DelegateToClaude cannot be used when the active provider is claude-delegation — you're already running through Claude Code." }],
						details: { error: true },
					};
				}

				// Compatibility wrapper: DelegateToClaude maps onto the same foreground
				// execution implementation foreground SpawnClaudeAgent uses.
				const mode = (params.mode ?? defaultMode) as "full" | "read" | "none";
				const isolated = params.isolated ?? defaultIsolated;
				const writeLeaseHandle = mode === "full"
					? checkoutWriteLease.tryAcquire({ id: `${askClaudeToolName}:${toolCallId}`, label: `${askClaudeToolName} full call` })
					: undefined;
				if (mode === "full" && !writeLeaseHandle) {
					return {
						content: [{ type: "text" as const, text: assembleModelResult({ answer: `Error: ${checkoutWriteConflictText(checkoutWriteLease)}` }) }],
						details: { error: true, capabilityMode: mode, requestedModel: params.model ?? ASK_CLAUDE_DEFAULT_MODEL, thinking: params.thinking, isolated },
					};
				}
				try {
					return await executeForegroundDelegation({
						toolCallId,
						displayPrompt: params.prompt,
						delegationPrompt: params.prompt,
						mode,
						isolated,
						requestedModel: params.model ?? ASK_CLAUDE_DEFAULT_MODEL,
						thinking: params.thinking,
						signal,
						onUpdate,
						systemPrompt: ctx.getSystemPrompt(),
						appendSkills: askConf?.appendSkills,
						permissionMode: askConf?.permissionMode,
						context: isolated ? undefined : buildSessionContext(ctx.sessionManager.getBranch()).messages as Context["messages"],
						cwd: ctx.cwd,
					});
				} finally {
					writeLeaseHandle?.release();
				}
			},
		});
	}

	// --- SpawnClaudeAgent tool ---
	//
	// Registered under the same opt-in as DelegateToClaude: these are the only two
	// first-class Claude tools the fork exposes. The adapter seam also wires the
	// background jobs' session lifecycle cleanup (async, awaited by Pi 0.84.2).
	registerSpawnClaudeAgent(pi, {
		enabled: Boolean(askConf?.enabled),
		// Spawn modes share DelegateToClaude's full-capability lockout.
		allowFull: askContract.allowFull,
		requestedPermissionMode: askPermissionMode,
		writeLease: checkoutWriteLease,
		jobs: backgroundJobs,
		captureDiff: captureReviewerDiff,
		// Background jobs resolve permission policy from the same configured
		// DelegateToClaude delegation settings as the foreground path.
		runJob: (input) => runBackgroundJobDelegation({ ...input, permissionMode: askConf?.permissionMode }),
		// Foreground SpawnClaudeAgent calls run through the same foreground
		// execution implementation as DelegateToClaude — one runner, one retained
		// snapshot/live-update path, one finalization — with label extras so the
		// overlay can distinguish the call kinds.
		runForeground: (input) => executeForegroundDelegation({
			toolCallId: input.toolCallId,
			displayPrompt: input.task,
			delegationPrompt: input.prompt,
			mode: input.profile.capabilityMode,
			isolated: input.isolated,
			requestedModel: input.requestedModel,
			thinking: input.thinking,
			signal: input.signal,
			onUpdate: input.onUpdate,
			systemPrompt: input.systemPrompt,
			appendSkills: askConf?.appendSkills,
			permissionMode: askConf?.permissionMode,
			context: input.context,
			cwd: input.cwd,
			detailExtras: { origin: "spawn-foreground", profile: input.profile.id },
		}),
	});
	// The background-job UI adapter renders the same manager's records: the
	// sticky live widget, /claude-jobs status/cancel, and the exactly-once
	// terminal delivery (persisted TUI entry + non-triggering nextTurn message).
	registerBackgroundJobUI(pi, {
		enabled: Boolean(askConf?.enabled),
		jobs: backgroundJobs,
		onDebug: debug,
		openSessionsOverlay: claudeSessionsUI?.openBackgroundJobs,
	});
}
