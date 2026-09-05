export const PROGRESS_INTERVAL_MS = 100;

/** Latest-value coalescing for UI work only; lifecycle events must bypass it. */
export function createProgressPublisher<T>(
	publish: (value: T) => void,
	now: () => number = Date.now,
) {
	let pending: { value: T } | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let lastPublishedAt = Number.NEGATIVE_INFINITY;
	let stopped = false;
	const clearTimer = () => {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
	};
	const flush = () => {
		clearTimer();
		if (!pending || stopped) return;
		const { value } = pending;
		pending = undefined;
		lastPublishedAt = now();
		publish(value);
	};
	return {
		push(value: T, force = false): void {
			if (stopped) return;
			pending = { value };
			const delay = PROGRESS_INTERVAL_MS - (now() - lastPublishedAt);
			if (force || delay <= 0) flush();
			else if (timer === undefined) {
				timer = setTimeout(flush, delay);
				timer.unref?.();
			}
		},
		flush,
		stop(): void {
			stopped = true;
			clearTimer();
			pending = undefined;
		},
	};
}
