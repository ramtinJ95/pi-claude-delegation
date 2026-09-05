import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createProgressPublisher, PROGRESS_INTERVAL_MS } from "../src/progress-publisher.js";

describe("latest-value progress publisher", () => {
	it("publishes the first value immediately and coalesces a burst to its latest value", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
		const seen = [];
		const publisher = createProgressPublisher((value) => seen.push(value));
		publisher.push(0);
		for (let i = 1; i <= 100; i++) publisher.push(i);
		assert.deepEqual(seen, [0]);
		t.mock.timers.tick(PROGRESS_INTERVAL_MS);
		assert.deepEqual(seen, [0, 100]);
		publisher.stop();
	});

	it("flushes pending progress immediately and removes delayed callbacks on stop", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
		const seen = [];
		const publisher = createProgressPublisher((value) => seen.push(value));
		publisher.push("first");
		publisher.push("pending");
		publisher.flush();
		publisher.push("discarded");
		publisher.stop();
		publisher.push("late", true);
		t.mock.timers.tick(1000);
		assert.deepEqual(seen, ["first", "pending"]);
	});
});
