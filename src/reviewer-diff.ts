import { spawn } from "node:child_process";
import { appendRetainedText, redactSensitiveText, retainTextWithOmissions } from "./delegation-retention.js";

// Named launch-artifact bounds, independent of the delegation retention caps:
// the diff is one immutable prompt artifact, not a streamed display field.
export const REVIEWER_DIFF_MAX_CHARS = 40_000;
export const REVIEWER_STATUS_MAX_CHARS = 4_000;
export const REVIEWER_CAPTURE_TIMEOUT_MS = 30_000;
const GIT_METADATA_MAX_CHARS = 1_000_000;
const GIT_STDERR_MAX_CHARS = 4_000;

/**
 * Immutable repository change snapshot captured by the extension at job launch.
 *
 * Read-mode review specialization has no Bash capability, so this artifact is the only
 * diff it ever sees. It is frozen at `capturedAt`: the reviewer's Read/Glob/Grep
 * calls still hit the live working tree, which may have moved on since.
 */
export interface ReviewerDiffArtifact {
	cwd: string;
	capturedAt: number;
	/** What the diff compares, including the resolved base when one was given. */
	source: string;
	baseRef?: string;
	headRef: string;
	/** `git status --porcelain` at launch; bounded, redacted, marker on truncation. */
	statusText: string;
	statusTruncated: boolean;
	/** Unified diff at launch, including untracked files; bounded and redacted. */
	diffText: string;
	diffTruncated: boolean;
}

export interface GitResult {
	/** Only normal process exits have a numeric code; execution failures reject. */
	code: number;
	stdout: string;
	stderr: string;
	stdoutOmittedChars?: number;
	stdoutEndsWithNewline?: boolean;
}

export type GitRunner = (args: string[], options?: {
	signal?: AbortSignal;
	maxStdoutChars?: number;
	truncate?: boolean;
}) => Promise<GitResult>;

/** A capture failure the tool should surface verbatim as its error result. */
export class ReviewerDiffError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ReviewerDiffError";
	}
}

/** Drain stdout without buffering a whole diff; errors and signals never become exit 1. */
export function createGitRunner(cwd: string): GitRunner {
	return (args, options = {}) => new Promise((resolve, reject) => {
		const maxChars = options.maxStdoutChars ?? GIT_METADATA_MAX_CHARS;
		const signal = options.signal ?? AbortSignal.timeout(REVIEWER_CAPTURE_TIMEOUT_MS);
		signal.throwIfAborted();
		const grouped = process.platform !== "win32";
		const child = spawn("git", args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			detached: grouped,
		});
		let stdout = "";
		let omittedChars = 0;
		let stdoutEndsWithNewline = false;
		let stderr = "";
		let failure: Error | undefined;
		const stop = () => {
			if (!child.pid) return;
			try {
				// Git can start filters/fsmonitor helpers even with external diffs
				// disabled. Kill its POSIX process group, not just the parent.
				if (grouped) process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
					failure = error as Error;
					reject(new ReviewerDiffError(`Cannot terminate Git capture: ${failure.message}`));
				}
			}
		};
		signal.addEventListener("abort", stop, { once: true });
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			const retained = appendRetainedText(stdout, chunk, maxChars, omittedChars);
			stdout = retained.text;
			omittedChars = retained.omittedChars;
			stdoutEndsWithNewline = chunk.endsWith("\n");
			if (omittedChars && !options.truncate && !failure) {
				failure = new Error(`Git metadata exceeded ${maxChars} characters; capture refused rather than skipping files.`);
				// Keep draining without retaining more. Short metadata commands may
				// already have exited when their buffered stdout arrives; killing a
				// stale process group here would race that exit. The capture deadline
				// still stops a command that does not finish on its own.
			}
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk.slice(0, Math.max(0, GIT_STDERR_MAX_CHARS - stderr.length));
		});
		child.on("error", (error) => { failure ??= error; });
		// Wait for close, including inherited helper pipes, before completing abort.
		child.on("close", (code, terminationSignal) => {
			signal.removeEventListener("abort", stop);
			if (signal.aborted) failure = signal.reason;
			if (failure || terminationSignal || code === null) {
				reject(new ReviewerDiffError(`Reviewer diff capture failed (git ${args[0]}): ${failure?.message ?? `terminated by ${terminationSignal ?? "unknown signal"}`}`));
			} else {
				resolve({ code, stdout, stderr, stdoutOmittedChars: omittedChars, stdoutEndsWithNewline });
			}
		});
	});
}

function firstLine(text: string): string {
	return text.split("\n", 1)[0]?.trim() ?? "";
}

function gitFailure(step: string, result: { stderr: string }): ReviewerDiffError {
	return new ReviewerDiffError(`Reviewer diff capture failed (${step}): ${firstLine(result.stderr) || "unknown git error"}`);
}

/**
 * Capture the reviewer's launch-time status/diff artifact.
 *
 * With an explicit `base`, the diff spans from the merge base of `base` and
 * HEAD to the launch-time working tree — branch/PR semantics, so changes that
 * exist only on the base side do not show up as reversals. Without one, it
 * captures the staged and unstaged working-tree changes from HEAD.
 *
 * Failures throw rather than degrade: a non-git directory, an unborn HEAD, or
 * an unresolvable base must become a visible error, never an empty diff that a
 * reviewer would read as "no changes".
 */
export async function captureReviewerDiff(input: {
	cwd: string;
	base?: string;
	capturedAt?: number;
	git?: GitRunner;
	signal?: AbortSignal;
	/** Whole-capture deadline, not a fresh timeout for each untracked file. */
	timeoutMs?: number;
}): Promise<ReviewerDiffArtifact> {
	const timeout = AbortSignal.timeout(input.timeoutMs ?? REVIEWER_CAPTURE_TIMEOUT_MS);
	const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
	const runner = input.git ?? createGitRunner(input.cwd);
	const git: GitRunner = async (args, options) => {
		signal.throwIfAborted();
		const result = await runner(args, { ...options, signal });
		signal.throwIfAborted();
		return result;
	};
	const base = input.base?.trim();
	// Refs are passed as positional git arguments; reject anything that would
	// parse as an option instead of silently diffing something else.
	if (base !== undefined && (base === "" || base.startsWith("-"))) {
		throw new ReviewerDiffError(`Invalid comparison base ${JSON.stringify(input.base)}: expected a git ref.`);
	}

	const inTree = await git(["rev-parse", "--is-inside-work-tree"]);
	if (inTree.code !== 0 || inTree.stdout.trim() !== "true") {
		throw new ReviewerDiffError(`Reviewer diff capture failed: ${input.cwd} is not inside a git work tree.`);
	}
	const head = await git(["rev-parse", "--short=12", "HEAD"]);
	if (head.code !== 0) {
		throw new ReviewerDiffError(`Reviewer diff capture failed: cannot resolve HEAD in ${input.cwd} (${firstLine(head.stderr) || "repository may have no commits"}).`);
	}
	const headRef = head.stdout.trim();

	let diffFrom = "HEAD";
	let source = `working tree at launch vs HEAD ${headRef} (tracked + untracked changes)`;
	if (base !== undefined) {
		const verified = await git(["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
		if (verified.code !== 0) {
			throw new ReviewerDiffError(`Invalid comparison base "${base}": not a commit in this repository.`);
		}
		const mergeBase = await git(["merge-base", base, "HEAD"]);
		if (mergeBase.code !== 0) {
			throw new ReviewerDiffError(`Invalid comparison base "${base}": no merge base with HEAD.`);
		}
		diffFrom = mergeBase.stdout.trim();
		source = `working tree at launch vs merge-base of "${base}" and HEAD (${diffFrom.slice(0, 12)})`;
	}

	const status = await git(["status", "--porcelain"], { maxStdoutChars: REVIEWER_STATUS_MAX_CHARS, truncate: true });
	if (status.code !== 0) throw gitFailure("git status", status);
	const diff = await git(["diff", "--no-color", "--no-ext-diff", "--no-textconv", diffFrom], { maxStdoutChars: REVIEWER_DIFF_MAX_CHARS, truncate: true });
	if (diff.code !== 0) throw gitFailure("git diff", diff);
	const untracked = await git(["ls-files", "--others", "--exclude-standard", "-z"]);
	if (untracked.code !== 0) throw gitFailure("git ls-files", untracked);

	const untrackedPaths = untracked.stdout.split("\0").filter(Boolean);
	let prefix = "";
	let omittedChars = 0;
	const append = (result: GitResult, emptyFileNotice = "") => {
		// Redaction is best effort over the retained prefix, just like streamed
		// delegation fields. Omitted text is counted, never held for redaction.
		const missing = result.stdoutOmittedChars ?? 0;
		const text = redactSensitiveText(result.stdout || (missing ? "" : emptyFileNotice));
		const endsWithNewline = !result.stdout && !missing ? text.endsWith("\n") : result.stdoutEndsWithNewline ?? text.endsWith("\n");
		const retained = appendRetainedText(prefix, text, REVIEWER_DIFF_MAX_CHARS, omittedChars);
		prefix = retained.text;
		omittedChars = retained.omittedChars + missing;
		if ((text || missing) && !endsWithNewline) {
			const newline = appendRetainedText(prefix, "\n", REVIEWER_DIFF_MAX_CHARS, omittedChars);
			prefix = newline.text;
			omittedChars = newline.omittedChars;
		}
	};
	append(diff);
	for (const path of untrackedPaths) {
		const untrackedDiff = await git(
			["diff", "--no-index", "--no-color", "--no-ext-diff", "--no-textconv", "--", "/dev/null", path],
			{ maxStdoutChars: omittedChars ? 0 : Math.max(0, REVIEWER_DIFF_MAX_CHARS - prefix.length), truncate: true },
		);
		// Exit 1 means differences, not a transport failure. Keep validating every
		// file after the prefix fills; a partial review must not hide a Git error.
		if (untrackedDiff.code !== 0 && untrackedDiff.code !== 1) throw gitFailure(`untracked file ${JSON.stringify(path)}`, untrackedDiff);
		append(untrackedDiff, `Untracked empty file captured at launch: ${JSON.stringify(path)}\n`);
	}
	const statusText = redactSensitiveText(status.stdout);

	return {
		cwd: input.cwd,
		capturedAt: input.capturedAt ?? Date.now(),
		source,
		...(base !== undefined ? { baseRef: base } : {}),
		headRef,
		statusText: retainTextWithOmissions(statusText, REVIEWER_STATUS_MAX_CHARS, status.stdoutOmittedChars ?? 0, false),
		statusTruncated: statusText.length > REVIEWER_STATUS_MAX_CHARS || (status.stdoutOmittedChars ?? 0) > 0,
		diffText: retainTextWithOmissions(prefix, REVIEWER_DIFF_MAX_CHARS, omittedChars, false),
		diffTruncated: omittedChars > 0,
	};
}
