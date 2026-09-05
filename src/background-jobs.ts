import { randomUUID } from "node:crypto";
import type { AgentProfileId } from "./agent-profiles.js";
import { retainDelegationSnapshot, type DelegationSnapshot } from "./delegation-events.js";
import { PROMPT_MAX_CHARS, TOOL_FIELD_MAX_CHARS, retainText } from "./delegation-retention.js";
import type { DelegationRunResult } from "./delegation-runner.js";
import type { ManagedPolicySummary, PermissionObservation } from "./query-policy.js";
import type { ReviewerDiffArtifact } from "./reviewer-diff.js";
import { createProgressPublisher } from "./progress-publisher.js";

// One running background Claude job per Pi session. A second spawn fails
// visibly; configurability is deferred until dogfooding shows a need and the
// process/quota cost is measured.
export const MAX_RUNNING_BACKGROUND_JOBS = 1;
// Bounded in-memory records for this phase — no persistence. Terminal records
// beyond this are evicted oldest-first; a running job is never evicted.
export const BACKGROUND_JOB_RECORDS_MAX = 20;
// How long shutdown waits for aborted jobs to settle before declaring them
// abandoned. The runner's interrupt usually confirms well inside this window;
// the bound exists so a wedged Claude Code process cannot block Pi's shutdown.
export const BACKGROUND_JOB_SHUTDOWN_GRACE_MS = 2_000;

export type BackgroundJobStatus = "running" | "succeeded" | "failed" | "cancelled" | "abandoned";

/** Context captured when the job launched; never updated afterwards. */
export interface BackgroundJobLaunch {
	cwd: string;
	capturedAt: number;
	diff?: ReviewerDiffArtifact;
}

/** Immutable record revisions are also the session overlay's cache keys. */
export interface BackgroundJobRecord {
	readonly id: string;
	readonly profile: AgentProfileId;
	readonly task: string;
	readonly requestedModel: string;
	readonly thinking?: string;
	readonly status: BackgroundJobStatus;
	readonly createdAt: number;
	readonly endedAt?: number;
	readonly launch: BackgroundJobLaunch;
	readonly snapshot?: DelegationSnapshot;
	// Runner-observed policy state, stored only when the runner actually
	// returned it (succeeded/cancelled). Failed and abandoned jobs never got a
	// run result, so these stay absent rather than being borrowed or invented.
	readonly permission?: PermissionObservation;
	readonly managedPolicy?: ManagedPolicySummary;
	readonly error?: string;
}

export type BackgroundJobExecutor = (run: {
	signal: AbortSignal;
	onSnapshot: (snapshot: DelegationSnapshot) => void;
}) => Promise<DelegationRunResult>;

/**
 * Lifecycle notifications for an extension-owned UI adapter. `settled` fires
 * exactly once per job — terminal states are first-wins — and carries
 * `duringShutdown: true` when the settlement happened inside `shutdown`/`reset`
 * so a completion is never delivered into a session that is being torn down or
 * replaced. `cleared` fires when a reset drops all session-scoped records.
 */
export type BackgroundJobTransition =
	| { type: "spawned"; record: BackgroundJobRecord }
	| { type: "updated"; record: BackgroundJobRecord }
	| { type: "settled"; record: BackgroundJobRecord; duringShutdown: boolean }
	| { type: "cleared" };

export class BackgroundJobLimitError extends Error {
	readonly runningJobId: string;
	constructor(runningJobId: string) {
		super(`A background Claude job is already running (${runningJobId}). This session allows one at a time: cancel it or wait for it to finish before spawning another.`);
		this.name = "BackgroundJobLimitError";
		this.runningJobId = runningJobId;
	}
}

// Default sleep unrefs its timer: it still fires while Pi runs, but a pending
// shutdown grace never holds an otherwise-finished process open.
function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});
}

// 12 hex chars (48 random bits) from the CSPRNG-backed UUID: readable in a job
// ID and collision-resistant across extension runtimes, unlike Math.random.
function randomIdPrefix(): string {
	return randomUUID().replaceAll("-", "").slice(0, 12);
}

/**
 * In-process, Pi-session-scoped background job manager.
 *
 * A background job is another caller of the shared delegation runner: the
 * executor is injected by the caller (and by tests), so this class owns only
 * lifecycle — the one-running-job cap, per-job AbortController, terminal
 * states, bounded records, and shutdown cleanup. Jobs do not survive the Pi
 * session; `shutdown` aborts whatever is running and waits a bounded grace
 * period for the runner to confirm settlement. Jobs that settle in time keep
 * their genuine terminal state (usually `cancelled`); only jobs still
 * unconfirmed when the grace expires are reported as `abandoned`. Terminal
 * states are first-wins: a late executor settlement never overwrites one.
 *
 * Job IDs carry a collision-resistant random per-manager prefix so records
 * from different extension runtimes (e.g. across /reload) are overwhelmingly
 * unlikely to collide; the counter is monotonic for the manager's lifetime,
 * so a session reset never reuses an ID within one manager.
 */
export class BackgroundJobManager {
	private readonly records = new Map<string, BackgroundJobRecord>();
	private readonly controllers = new Map<string, AbortController>();
	private readonly settlements = new Map<string, Promise<void>>();
	private readonly progress = new Map<string, ReturnType<typeof createProgressPublisher<DelegationSnapshot>>>();
	private readonly listeners = new Set<(transition: BackgroundJobTransition) => void>();
	private shutdownDepth = 0;
	private counter = 0;
	private readonly idPrefix: string;
	private readonly now: () => number;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly shutdownGraceMs: number;
	private readonly onDebug?: (message: string) => void;

	constructor(options?: {
		now?: () => number;
		onDebug?: (message: string) => void;
		idPrefix?: string;
		sleep?: (ms: number) => Promise<void>;
		shutdownGraceMs?: number;
	}) {
		this.now = options?.now ?? Date.now;
		this.onDebug = options?.onDebug;
		this.idPrefix = options?.idPrefix ?? randomIdPrefix();
		this.sleep = options?.sleep ?? defaultSleep;
		this.shutdownGraceMs = options?.shutdownGraceMs ?? BACKGROUND_JOB_SHUTDOWN_GRACE_MS;
	}

	/** Observe job lifecycle transitions. Returns an unsubscribe function. */
	subscribe(listener: (transition: BackgroundJobTransition) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	// A listener failure must never corrupt job lifecycle state; it is logged
	// and the transition continues to the remaining listeners.
	private emit(transition: BackgroundJobTransition): void {
		for (const listener of [...this.listeners]) {
			try {
				listener(transition);
			} catch (error) {
				this.onDebug?.(`background job listener error on ${transition.type}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	/**
	 * Start one background job and return its record immediately. Throws
	 * `BackgroundJobLimitError` when a job is already running — the caller must
	 * promote that to a visible error result, not queue the spawn.
	 */
	spawn(input: {
		profile: AgentProfileId;
		task: string;
		requestedModel: string;
		thinking?: string;
		launch: BackgroundJobLaunch;
		execute: BackgroundJobExecutor;
	}): BackgroundJobRecord {
		const running = this.running();
		if (running) {
			throw new BackgroundJobLimitError(running.id);
		}
		const id = `claude-job-${this.idPrefix}-${++this.counter}`;
		const record: BackgroundJobRecord = {
			id,
			profile: input.profile,
			task: retainText(input.task, PROMPT_MAX_CHARS),
			requestedModel: input.requestedModel,
			...(input.thinking ? { thinking: input.thinking } : {}),
			status: "running",
			createdAt: this.now(),
			// Copied so no later caller-side mutation can rewrite the launch facts
			// the job's prompt was built from.
			launch: {
				cwd: input.launch.cwd,
				capturedAt: input.launch.capturedAt,
				...(input.launch.diff ? { diff: { ...input.launch.diff } } : {}),
			},
		};
		this.records.set(id, record);
		this.evict();
		const controller = new AbortController();
		this.controllers.set(id, controller);
		this.progress.set(id, createProgressPublisher((snapshot: DelegationSnapshot) => this.storeSnapshot(id, snapshot), this.now));
		this.emit({ type: "spawned", record });
		this.settlements.set(id, this.run(id, input.execute, controller.signal));
		return record;
	}

	get(id: string): BackgroundJobRecord | undefined {
		return this.records.get(id);
	}

	list(): BackgroundJobRecord[] {
		return [...this.records.values()];
	}

	/** The currently running job, if any — lets callers skip launch work a spawn would reject anyway. */
	running(): BackgroundJobRecord | undefined {
		for (const record of this.records.values()) {
			if (record.status === "running") return record;
		}
		return undefined;
	}

	/** Resolves when the job's executor has settled. Undefined for unknown/evicted jobs. */
	settled(id: string): Promise<void> | undefined {
		return this.settlements.get(id);
	}

	/** Abort one running job. Returns false when it is unknown or already terminal. */
	cancel(id: string): boolean {
		const record = this.records.get(id);
		if (!record || record.status !== "running") return false;
		this.controllers.get(id)?.abort();
		return true;
	}

	/**
	 * Pi-session shutdown: abort every running job so the runner interrupts and
	 * closes its Claude Code query, then wait up to the shutdown grace for the
	 * executors to settle. A job that settles in time keeps its genuine terminal
	 * state; only jobs still unconfirmed when the grace expires are marked
	 * `abandoned`. Pi 0.84.2 awaits async `session_shutdown` handlers, so this
	 * wait is real, not fire-and-forget.
	 */
	async shutdown(): Promise<void> {
		// Every settlement inside this window — the abort's own cancellation, a
		// natural finish racing it, or the abandoned marking below — is flagged
		// `duringShutdown` so no listener delivers it into a dying or replacement
		// session.
		this.shutdownDepth++;
		try {
			const running = [...this.records.values()].filter((record) => record.status === "running");
			if (running.length === 0) return;
			for (const record of running) this.controllers.get(record.id)?.abort();
			const settlements = running
				.map((record) => this.settlements.get(record.id))
				.filter((settlement): settlement is Promise<void> => settlement !== undefined);
			await Promise.race([Promise.all(settlements), this.sleep(this.shutdownGraceMs)]);
			for (const { id } of running) {
				if (this.records.get(id)?.status !== "running") continue;
				this.onDebug?.(`background job ${id}: unsettled after ${this.shutdownGraceMs}ms shutdown grace; marking abandoned`);
				this.finish(id, "abandoned", {});
			}
		} finally {
			this.shutdownDepth--;
		}
	}

	/**
	 * Session reset/switch: same bounded cleanup as shutdown, then drop all
	 * session-scoped records. An executor that settles even later finds no
	 * record and is logged, never resurrected.
	 */
	async reset(): Promise<void> {
		await this.shutdown();
		this.records.clear();
		this.controllers.clear();
		this.settlements.clear();
		this.emit({ type: "cleared" });
	}

	private async run(id: string, execute: BackgroundJobExecutor, signal: AbortSignal): Promise<void> {
		try {
			const result = await execute({
				signal,
				onSnapshot: (snapshot) => this.progress.get(id)?.push(snapshot),
			});
			this.finish(id, result.stopReason === "cancelled" ? "cancelled" : "succeeded", {
				snapshot: retainDelegationSnapshot(result.snapshot),
				// Copied bounded summaries the runner observed, kept only when it
				// actually produced them — Phase 3b renders these instead of
				// rerunning or inventing policy state. Never raw policy rules.
				...(result.permission ? { permission: { ...result.permission } } : {}),
				...(result.managedPolicy ? { managedPolicy: { ...result.managedPolicy } } : {}),
			});
		} catch (error) {
			this.finish(id, "failed", {
				error: retainText(error instanceof Error ? error.message : String(error), TOOL_FIELD_MAX_CHARS),
			});
		} finally {
			this.controllers.delete(id);
		}
	}

	private storeSnapshot(id: string, snapshot: DelegationSnapshot): void {
		const record = this.records.get(id);
		if (!record || record.status !== "running") return;
		const updated = { ...record, snapshot: retainDelegationSnapshot(snapshot) };
		this.records.set(id, updated);
		this.emit({ type: "updated", record: updated });
	}

	private finish(
		id: string,
		status: Exclude<BackgroundJobStatus, "running">,
		patch: Pick<Partial<BackgroundJobRecord>, "snapshot" | "permission" | "managedPolicy" | "error">,
	): void {
		// Preserve the latest partial snapshot on failure/abandonment and never
		// leave a delayed update capable of firing after a terminal transition.
		const progress = this.progress.get(id);
		progress?.flush();
		progress?.stop();
		this.progress.delete(id);
		const record = this.records.get(id);
		if (!record) {
			this.onDebug?.(`background job ${id}: ignored ${status} settlement for a cleared record`);
			return;
		}
		if (record.status !== "running") {
			this.onDebug?.(`background job ${id}: ignored late ${status} after terminal ${record.status}`);
			return;
		}
		const settled = { ...record, ...patch, status, endedAt: this.now() };
		this.records.set(id, settled);
		this.emit({ type: "settled", record: settled, duringShutdown: this.shutdownDepth > 0 });
	}

	private evict(): void {
		while (this.records.size > BACKGROUND_JOB_RECORDS_MAX) {
			const oldest = [...this.records.values()].find((record) => record.status !== "running");
			if (!oldest) return;
			this.records.delete(oldest.id);
			this.settlements.delete(oldest.id);
		}
	}
}
