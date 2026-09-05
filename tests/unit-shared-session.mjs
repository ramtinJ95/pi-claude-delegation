import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSharedSessionSynchronizer } from "../src/shared-session.js";

const create = () => createSharedSessionSynchronizer({ debug() {}, verifyWrittenSession() {}, debugSessionPaths() {} });

describe("shared session state ownership", () => {
	it("keeps cursors and lifecycle flags scoped to one synchronizer", () => {
		const first = create();
		const second = create();
		const state = { sessionId: "parent", cursor: 2, cwd: "/repo" };
		first.restore(state);
		state.cursor = 100;
		first.markRebuild(true);
		first.advanceCursor(3);
		assert.deepEqual(first.current, { sessionId: "parent", cursor: 3, cwd: "/repo", needsRebuild: true, forceRotate: true });
		assert.equal(second.current, null);
		first.markRebuild();
		assert.equal(first.current.forceRotate, true, "a normal rebuild must not clear an abort's rotation requirement");
		first.clear();
		assert.equal(first.current, null);
	});

	it("reuses synchronized history and preserves a parent for shorter contexts", () => {
		const sync = create();
		sync.restore({ sessionId: "parent", cursor: 2, cwd: "/repo" });
		const history = [{ role: "user", content: "first" }, { role: "assistant", content: [] }];
		assert.deepEqual(sync.sync([...history, { role: "user", content: "next" }], "/repo"), { sessionId: "parent" });
		assert.deepEqual(sync.sync([{ role: "user", content: "synthetic" }], "/repo"), { sessionId: null, preserveSharedSession: true });
		assert.equal(sync.current.sessionId, "parent");
	});
});
