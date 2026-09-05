import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	REVIEWER_DIFF_MAX_CHARS,
	REVIEWER_STATUS_MAX_CHARS,
	ReviewerDiffError,
	captureReviewerDiff,
	createGitRunner,
} from "../src/reviewer-diff.js";

const ok = (stdout) => ({ code: 0, stdout, stderr: "" });
const fail = (stderr = "fatal: nope") => ({ code: 128, stdout: "", stderr });

/** Fake git keyed by joined args; records calls; unknown invocations fail loudly. */
function fakeGit(responses) {
	const calls = [];
	const runner = async (args) => {
		const key = args.join(" ");
		calls.push(key);
		const response = responses[key];
		if (!response) throw new Error(`unexpected git invocation: git ${key}`);
		return response;
	};
	runner.calls = calls;
	return runner;
}

function repoResponses(overrides = {}) {
	return {
		"rev-parse --is-inside-work-tree": ok("true\n"),
		"rev-parse --short=12 HEAD": ok("abcdef123456\n"),
		"status --porcelain": ok(" M src/app.ts\n"),
		"diff --no-color --no-ext-diff --no-textconv HEAD": ok("diff --git a/src/app.ts b/src/app.ts\n+new line\n"),
		"ls-files --others --exclude-standard -z": ok(""),
		...overrides,
	};
}

describe("reviewer diff capture", () => {
	it("pins the named artifact bounds", () => {
		assert.equal(REVIEWER_DIFF_MAX_CHARS, 40_000);
		assert.equal(REVIEWER_STATUS_MAX_CHARS, 4_000);
	});

	it("captures staged and unstaged changes from HEAD when no base is given", async () => {
		const git = fakeGit(repoResponses());
		const artifact = await captureReviewerDiff({ cwd: "/tmp/project", capturedAt: 42, git });

		assert.equal(artifact.cwd, "/tmp/project");
		assert.equal(artifact.capturedAt, 42);
		assert.equal(artifact.headRef, "abcdef123456");
		assert.equal(artifact.baseRef, undefined);
		assert.match(artifact.source, /HEAD abcdef123456/);
		assert.match(artifact.source, /tracked \+ untracked/);
		assert.equal(artifact.diffText, "diff --git a/src/app.ts b/src/app.ts\n+new line\n");
		assert.equal(artifact.statusText, " M src/app.ts\n");
		assert.equal(artifact.diffTruncated, false);
		assert.equal(artifact.statusTruncated, false);
		assert.ok(git.calls.includes("diff --no-color --no-ext-diff --no-textconv HEAD"));
		assert.ok(git.calls.includes("ls-files --others --exclude-standard -z"));
	});

	it("includes untracked file contents in the frozen artifact", async () => {
		const git = fakeGit(repoResponses({
			"status --porcelain": ok("?? src/new thing.ts\n?? src/empty.ts\n"),
			"diff --no-color --no-ext-diff --no-textconv HEAD": ok(""),
			"ls-files --others --exclude-standard -z": ok("src/new thing.ts\0src/empty.ts\0"),
			"diff --no-index --no-color --no-ext-diff --no-textconv -- /dev/null src/new thing.ts": {
				code: 1,
				stdout: "diff --git a/src/new thing.ts b/src/new thing.ts\n+new file contents\n",
				stderr: "",
			},
			"diff --no-index --no-color --no-ext-diff --no-textconv -- /dev/null src/empty.ts": ok(""),
		}));
		const artifact = await captureReviewerDiff({ cwd: "/tmp/project", git });

		assert.match(artifact.diffText, /new file contents/);
		assert.match(artifact.diffText, /Untracked empty file captured at launch: "src\/empty\.ts"/);
		assert.equal(artifact.diffTruncated, false);
	});

	it("diffs from the merge base of an explicit comparison base and records it", async () => {
		const git = fakeGit(repoResponses({
			"rev-parse --verify --quiet main^{commit}": ok("1111111111111111\n"),
			"merge-base main HEAD": ok("2222222222222222\n"),
			"diff --no-color --no-ext-diff --no-textconv 2222222222222222": ok("+branch change\n"),
		}));
		const artifact = await captureReviewerDiff({ cwd: "/tmp/project", base: "main", git });

		assert.equal(artifact.baseRef, "main");
		assert.match(artifact.source, /merge-base of "main" and HEAD \(222222222222\)/);
		assert.equal(artifact.diffText, "+branch change\n");
		assert.ok(git.calls.includes("diff --no-color --no-ext-diff --no-textconv 2222222222222222"));
		assert.ok(!git.calls.some((call) => call === "diff --no-color --no-ext-diff --no-textconv HEAD"));
	});

	it("fails clearly outside a git work tree instead of returning an empty diff", async () => {
		const git = fakeGit({ "rev-parse --is-inside-work-tree": fail("fatal: not a git repository") });
		await assert.rejects(
			captureReviewerDiff({ cwd: "/tmp/nowhere", git }),
			(error) => error instanceof ReviewerDiffError && /not inside a git work tree/.test(error.message),
		);
	});

	it("fails clearly when HEAD cannot be resolved", async () => {
		const git = fakeGit(repoResponses({
			"rev-parse --short=12 HEAD": fail("fatal: ambiguous argument 'HEAD'"),
		}));
		await assert.rejects(
			captureReviewerDiff({ cwd: "/tmp/project", git }),
			/cannot resolve HEAD/,
		);
	});

	it("fails clearly for a base that is not a commit", async () => {
		const git = fakeGit(repoResponses({
			"rev-parse --verify --quiet no-such-branch^{commit}": fail(""),
		}));
		await assert.rejects(
			captureReviewerDiff({ cwd: "/tmp/project", base: "no-such-branch", git }),
			/Invalid comparison base "no-such-branch": not a commit/,
		);
	});

	it("fails clearly for a base with no merge base with HEAD", async () => {
		const git = fakeGit(repoResponses({
			"rev-parse --verify --quiet orphan^{commit}": ok("3333333333333333\n"),
			"merge-base orphan HEAD": fail(""),
		}));
		await assert.rejects(
			captureReviewerDiff({ cwd: "/tmp/project", base: "orphan", git }),
			/no merge base with HEAD/,
		);
	});

	it("rejects option-shaped and empty bases before touching git", async () => {
		for (const base of ["--exec=evil", "-x", "", "  "]) {
			const git = fakeGit({});
			await assert.rejects(
				captureReviewerDiff({ cwd: "/tmp/project", base, git }),
				/Invalid comparison base/,
			);
			assert.equal(git.calls.length, 0);
		}
	});

	it("bounds the diff at the named limit with a visible truncation marker", async () => {
		const hugeDiff = "+x".repeat(REVIEWER_DIFF_MAX_CHARS);
		const git = fakeGit(repoResponses({ "diff --no-color --no-ext-diff --no-textconv HEAD": ok(hugeDiff) }));
		const artifact = await captureReviewerDiff({ cwd: "/tmp/project", git });

		assert.equal(artifact.diffTruncated, true);
		assert.ok(artifact.diffText.length <= REVIEWER_DIFF_MAX_CHARS);
		assert.match(artifact.diffText, /\[… truncated \d+ chars\]/);
	});

	it("bounds the status output at its own named limit", async () => {
		const hugeStatus = "?? f\n".repeat(REVIEWER_STATUS_MAX_CHARS);
		const git = fakeGit(repoResponses({ "status --porcelain": ok(hugeStatus) }));
		const artifact = await captureReviewerDiff({ cwd: "/tmp/project", git });

		assert.equal(artifact.statusTruncated, true);
		assert.ok(artifact.statusText.length <= REVIEWER_STATUS_MAX_CHARS);
		assert.match(artifact.statusText, /\[… truncated \d+ chars\]/);
	});

	it("redacts credential-shaped content before it enters the artifact", async () => {
		const git = fakeGit(repoResponses({
			"diff --no-color --no-ext-diff --no-textconv HEAD": ok('+const key = "sk-ant-abcdefghijklmnop";\n'),
		}));
		const artifact = await captureReviewerDiff({ cwd: "/tmp/project", git });

		assert.ok(!artifact.diffText.includes("sk-ant-abcdefghijklmnop"));
		assert.ok(artifact.diffText.includes("[REDACTED]"));
	});

	it("returns an honest empty artifact for a clean tree in a valid repository", async () => {
		const git = fakeGit(repoResponses({
			"status --porcelain": ok(""),
			"diff --no-color --no-ext-diff --no-textconv HEAD": ok(""),
		}));
		const artifact = await captureReviewerDiff({ cwd: "/tmp/project", git });

		assert.equal(artifact.diffText, "");
		assert.equal(artifact.statusText, "");
		assert.equal(artifact.diffTruncated, false);
		assert.equal(artifact.statusTruncated, false);
	});
});

describe("bounded reviewer capture lifecycle", () => {
	it("bounds acquisition as well as the artifact and still checks omitted files", async () => {
		const invocations = [];
		const responses = repoResponses({
			"diff --no-color --no-ext-diff --no-textconv HEAD": ok(""),
			"ls-files --others --exclude-standard -z": ok("one\0two\0"),
		});
		const git = async (args, options) => {
			invocations.push({ args, options });
			if (args.includes("--no-index")) return {
				code: 1, stdout: "+x".repeat(options.maxStdoutChars / 2),
				stderr: "", stdoutOmittedChars: 60_000, stdoutEndsWithNewline: true,
			};
			return responses[args.join(" ")];
		};
		const artifact = await captureReviewerDiff({ cwd: "/repo", git });
		const files = invocations.filter(({ args }) => args.includes("--no-index"));
		assert.equal(files.length, 2, "truncation must not silently skip validation");
		assert.equal(files[0].options.maxStdoutChars, REVIEWER_DIFF_MAX_CHARS);
		assert.equal(files[1].options.maxStdoutChars, 0);
		assert.equal(artifact.diffText.length, REVIEWER_DIFF_MAX_CHARS);
		assert.equal(artifact.diffTruncated, true);
		assert.match(artifact.diffText, /truncated 1200\d+ chars/);
	});

	it("fails on invalid exit codes even after filling the prefix", async () => {
		for (const code of [-1, 2, 128]) {
			const git = fakeGit(repoResponses({
				"diff --no-color --no-ext-diff --no-textconv HEAD": ok("+x".repeat(40_000)),
				"ls-files --others --exclude-standard -z": ok("bad\0"),
				"diff --no-index --no-color --no-ext-diff --no-textconv -- /dev/null bad": { code, stdout: "partial", stderr: "capture broke" },
			}));
			await assert.rejects(captureReviewerDiff({ cwd: "/repo", git }), /capture broke/);
		}
	});

	it("passes cancellation through and schedules nothing after abort", async () => {
		const controller = new AbortController();
		const calls = [];
		const git = async (args, options) => {
			calls.push(args);
			assert.equal(options.signal.aborted, false);
			controller.abort(new Error("cancelled capture"));
			assert.equal(options.signal.aborted, true);
			return ok("true");
		};
		await assert.rejects(captureReviewerDiff({ cwd: "/repo", signal: controller.signal, git }), /cancelled capture/);
		assert.equal(calls.length, 1);
		await assert.rejects(captureReviewerDiff({ cwd: "/repo", signal: controller.signal, git }), /cancelled capture/);
		assert.equal(calls.length, 1);
	});

	it("uses one deadline for the whole capture", async () => {
		const signals = [];
		const git = async (_args, { signal }) => {
			signals.push(signal);
			if (signals.length === 1) return ok("true");
			return new Promise((_resolve, reject) => {
				const keepAlive = setTimeout(() => reject(new Error("deadline did not fire")), 2000);
				signal.addEventListener("abort", () => { clearTimeout(keepAlive); reject(signal.reason); }, { once: true });
			});
		};
		await assert.rejects(captureReviewerDiff({ cwd: "/repo", git, timeoutMs: 20 }), /timeout/);
		assert.equal(signals.length, 2);
		assert.equal(signals[0], signals[1]);
	});
});

describe("real Git output boundary", () => {
	it("cancels Git helpers that inherit its pipes, not only the parent Git process", { skip: process.platform === "win32" }, async () => {
		const cwd = mkdtempSync(join(tmpdir(), "review-helper-"));
		const controller = new AbortController();
		try {
			writeFileSync(join(cwd, "helper.sh"), 'echo ready > "$1"\nsleep 10\n');
			const pending = createGitRunner(cwd)(["-c", "alias.wait-for-cancel=!sh helper.sh ready", "wait-for-cancel"], { signal: controller.signal });
			const rejected = assert.rejects(pending, /cancelled group/);
			const deadline = Date.now() + 2000;
			while (!existsSync(join(cwd, "ready")) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
			assert.ok(existsSync(join(cwd, "ready")), "Git helper must be running before abort");
			controller.abort(new Error("cancelled group"));
			let timer;
			try {
				await Promise.race([rejected, new Promise((_, reject) => {
					timer = setTimeout(() => reject(new Error("Git helper still holds the capture pipes open")), 2000);
				})]);
			} finally { clearTimeout(timer); }
		} finally {
			controller.abort(new Error("cancelled group"));
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("streams a bounded prefix, rejects execution errors, and reaps an aborted process", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "review-capture-"));
		try {
			writeFileSync(join(cwd, "large.txt"), "a line of text\n".repeat(10_000));
			const git = createGitRunner(cwd);
			const args = ["diff", "--no-index", "--no-color", "--no-ext-diff", "--no-textconv", "--", "/dev/null", "large.txt"];
			const result = await git(args, { maxStdoutChars: 128, truncate: true });
			assert.equal(result.code, 1);
			assert.equal(result.stdout.length, 128);
			assert.ok(result.stdoutOmittedChars > 100_000);
			assert.equal(result.stdoutEndsWithNewline, true);
			await assert.rejects(git(["--version"], { maxStdoutChars: 4 }), /metadata exceeded/);
			await assert.rejects(createGitRunner(join(cwd, "missing"))(["--version"]), /ENOENT/);
			const controller = new AbortController();
			const pending = git(args, { signal: controller.signal, maxStdoutChars: 128, truncate: true });
			controller.abort();
			await assert.rejects(pending, /aborted/);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
