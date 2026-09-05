import type { Context } from "@earendil-works/pi-ai";
import { createSession, deleteSession, openSession, repairToolPairing } from "cc-session-io";
import { convertPiMessages } from "./convert.js";
import { collectCarriedAttachments, placeCarriedAttachments, type CarriedAttachment } from "./attachments.js";

export interface SessionState {
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

interface SyncResult {
	sessionId: string | null;
	preserveSharedSession?: boolean;
}

export function turnStart(messages: Context["messages"]): number {
	let i = messages.length;
	while (i > 0 && messages[i - 1].role === "user") i--;
	return i;
}

interface SessionSyncDependencies {
	debug: (...args: unknown[]) => void;
	verifyWrittenSession: (path: string, sessionId: string, recordCount: number, cwd: string) => void;
	debugSessionPaths: (label: string, cwd: string, path: string) => void;
}

/** Owns one runtime's session cursor, rebuild flags, and import/rebuild lifecycle. */
export function createSharedSessionSynchronizer(deps: SessionSyncDependencies) {
	const { debug, verifyWrittenSession, debugSessionPaths } = deps;
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

	return {
		get current(): Readonly<SessionState> | null { return sharedSession; },
		restore(state: SessionState | null): void { sharedSession = state ? { ...state } : null; },
		clear(): void { sharedSession = null; },
		markRebuild(forceRotate = false): void {
			if (sharedSession) sharedSession = { ...sharedSession, needsRebuild: true, ...(forceRotate ? { forceRotate: true } : {}) };
		},
		advanceCursor(cursor: number): void {
			if (sharedSession) sharedSession = { ...sharedSession, cursor };
		},
		sync: syncSharedSession,
	};
}
