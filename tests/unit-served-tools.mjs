/**
 * Mid-turn tool changes: pi's tool_search activates tools and promises them on
 * the model's next call, which under this provider is the next request of the
 * query already running. The bridge must swap its MCP tool list, notify Claude
 * Code, and hold the tool result until Claude Code has re-listed.
 *
 * Driven through the real MCP server over JSON-RPC, the way the Agent SDK
 * connects it. That Claude Code re-lists and offers the new tool in the same
 * turn is pinned live in tests/int-cc-contracts.mjs.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { QueryContext } from "../src/query-state.js";
import { createToolServer } from "../src/mcp-server.js";

const { __test } = await import("../src/index.js");

const tool = (name) => ({ name, description: `${name} tool`, parameters: { type: "object", properties: {} } });

/** Connects like the SDK. `relist` decides whether the client answers
 *  tools/list_changed by re-listing, as Claude Code does. */
async function connectClient(server, { relist = true, failNotifications = false } = {}) {
	const pending = new Map();
	const notifications = [];
	const listings = [];
	let nextId = 0;
	const transport = {
		start: async () => {},
		close: async () => {},
		send: async (msg) => {
			if (msg.id !== undefined && pending.has(msg.id)) return pending.get(msg.id)(msg);
			if (msg.method) {
				if (failNotifications) throw new Error("transport closed");
				notifications.push(msg.method);
				if (relist && msg.method === "notifications/tools/list_changed") {
					void request("tools/list", {}).then((reply) => listings.push(reply.result.tools.map((t) => t.name)));
				}
			}
		},
	};
	const request = (method, params) =>
		new Promise((resolve) => {
			const id = ++nextId;
			pending.set(id, resolve);
			transport.onmessage({ jsonrpc: "2.0", id, method, params });
		});
	await server.instance.connect(transport);
	await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } });
	transport.onmessage({ jsonrpc: "2.0", method: "notifications/initialized" });
	const callTool = (name, toolUseId) =>
		request("tools/call", { name, arguments: {}, _meta: { "claudecode/toolUseId": toolUseId } });
	return { request, callTool, notifications, listings };
}

async function startQuery(tools) {
	const c = new QueryContext();
	const { customToolNameToPi } = __test.resolveMcpTools({ messages: [], tools });
	c.toolNameToPi = customToolNameToPi;
	const servers = __test.buildMcpServers(tools, c);
	return { c, client: await connectClient(Object.values(servers)[0]) };
}

describe("mid-turn tool changes", () => {
	it("serves a tool activated mid-turn before the result is released", async () => {
		const { c, client } = await startQuery([tool("tool_search")]);
		const nameMap = c.toolNameToPi;

		await __test.refreshServedTools(c, { messages: [], tools: [tool("tool_search"), tool("lookup")] });

		assert.deepEqual(client.notifications, ["notifications/tools/list_changed"]);
		assert.deepEqual(client.listings, [["tool_search", "lookup"]], "refresh resolved before Claude Code re-listed");
		assert.deepEqual(c.servedTools.map((t) => t.name), ["tool_search", "lookup"]);
		// consumeQuery holds the original map object, so it must be updated in place.
		assert.equal(c.toolNameToPi, nameMap);
		assert.equal(nameMap.get("mcp__custom-tools__lookup"), "lookup");

		// The new tool is callable and pairs its result like any other.
		c.turnToolCallIds = ["toolu_lookup"];
		const reply = client.callTool("lookup", "toolu_lookup");
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.ok(c.pendingToolCalls.has("toolu_lookup"));
		await __test.deliverToolResults(c, [{ toolCallId: "toolu_lookup", content: [{ type: "text", text: "found" }] }], null, 3);
		assert.equal((await reply).result.content[0].text, "found");
	});

	it("leaves the server alone when the tool set is unchanged", async () => {
		const tools = [tool("read"), tool("bash")];
		const { c, client } = await startQuery(tools);
		await __test.refreshServedTools(c, { messages: [], tools: tools.map((t) => ({ ...t })) });
		assert.deepEqual(client.notifications, []);
	});

	it("drops tools that pi deactivated", async () => {
		const { c, client } = await startQuery([tool("read"), tool("lookup")]);
		await __test.refreshServedTools(c, { messages: [], tools: [tool("read")] });
		assert.deepEqual(client.listings, [["read"]]);
		assert.equal(c.toolNameToPi.has("mcp__custom-tools__lookup"), false);
		// No longer offered, so Claude Code answers new calls to it itself (pinned
		// in tests/int-cc-contracts.mjs); calls it already issued still pair below.
	});

	it("never serves the delegation tools, even when they arrive mid-turn", async () => {
		const { c, client } = await startQuery([tool("read")]);
		await __test.refreshServedTools(c, { messages: [], tools: [tool("read"), tool("DelegateToClaude"), tool("SpawnClaudeAgent")] });
		assert.deepEqual(client.notifications, []);
	});

	it("reports a client that never re-lists instead of holding the result forever", async () => {
		const server = createToolServer("custom-tools", []);
		const client = await connectClient(server, { relist: false });
		const relisted = await server.replaceTools([{ name: "x", description: "x", inputSchema: { type: "object" }, handler: async () => ({ content: [] }) }], { timeoutMs: 20 });
		assert.equal(relisted, false);
		assert.deepEqual(client.notifications, ["notifications/tools/list_changed"]);
	});

	it("stops waiting for a re-list as soon as the turn is aborted", async () => {
		const server = createToolServer("custom-tools", []);
		await connectClient(server, { relist: false });
		const abort = new AbortController();
		const started = Date.now();
		const pending = server.replaceTools([], { signal: abort.signal });
		abort.abort();
		assert.equal(await pending, false);
		assert.ok(Date.now() - started < 1_000, "the wait outlived the abort");
	});

	it("still answers a call Claude issued before its tool was removed", async () => {
		// Pi can finish a tool before Claude's tools/call for it arrives, so the
		// result may be queued when the tool set changes underneath it.
		const { c, client } = await startQuery([tool("loader"), tool("read")]);
		c.turnToolCallIds = ["toolu_loader"];
		await __test.deliverToolResults(c, [{ toolCallId: "toolu_loader", content: [{ type: "text", text: "loaded" }] }], null, 3);
		await __test.refreshServedTools(c, { messages: [], tools: [tool("read")] });
		assert.deepEqual(client.listings, [["read"]]);
		const reply = await client.callTool("loader", "toolu_loader");
		assert.equal(reply.result.content[0].text, "loaded");
		assert.equal(c.pendingResults.size, 0);
	});

	it("keeps the served tools and retries when a replacement is rejected", async () => {
		const { c, client } = await startQuery([tool("read")]);
		const bad = { name: "bad", description: "bad", parameters: { type: "string" } };
		await __test.refreshServedTools(c, { messages: [], tools: [tool("read"), bad] });
		assert.deepEqual(c.servedTools.map((t) => t.name), ["read"], "a rejected set was recorded as served");
		assert.equal(c.toolNameToPi.has("mcp__custom-tools__bad"), false);
		assert.deepEqual(client.notifications, []);

		await __test.refreshServedTools(c, { messages: [], tools: [tool("read"), tool("lookup")] });
		assert.deepEqual(client.listings, [["read", "lookup"]]);
	});

	it("keeps listing the old tools when Claude Code cannot be told about new ones", async () => {
		const tools = [tool("read")];
		const c = new QueryContext();
		c.toolNameToPi = __test.resolveMcpTools({ messages: [], tools }).customToolNameToPi;
		const server = Object.values(__test.buildMcpServers(tools, c))[0];
		const client = await connectClient(server, { failNotifications: true });
		await __test.refreshServedTools(c, { messages: [], tools: [tool("read"), tool("lookup")] });
		assert.deepEqual(c.servedTools.map((t) => t.name), ["read"]);
		const listed = await client.request("tools/list", {});
		assert.deepEqual(listed.result.tools.map((t) => t.name), ["read"], "the server lists tools Claude Code was never told about");
	});

	it("never delivers into the query that replaced an aborted one", async () => {
		const { c } = await startQuery([tool("tool_search")]);
		const aborted = {};
		c.activeQuery = aborted;
		__test.setSharedSession({ sessionId: "served-tools-abort", cursor: 2, cwd: process.cwd() });
		try {
			const abort = new AbortController();
			const steer = [{ type: "text", text: "use the new tool" }];
			const pending = __test.refreshThenDeliver(
				c,
				{ messages: [], tools: [tool("tool_search"), tool("lookup")] },
				[{ toolCallId: "toolu_search", content: [{ type: "text", text: "Loaded lookup" }] }],
				steer,
				abort.signal,
			);
			// The abort tears the query down and the next prompt claims the context
			// while the refresh is still waiting on Claude Code.
			const pushed = [];
			c.activeQuery = {};
			c.promptStream = { push: async (message) => { pushed.push(message); } };
			const nextTools = [tool("edit")];
			const nextNames = new Map([["mcp__custom-tools__edit", "edit"]]);
			c.servedTools = nextTools;
			c.toolNameToPi = nextNames;
			abort.abort();
			await pending;

			assert.equal(c.servedTools, nextTools, "the aborted refresh overwrote the next query's tool list");
			assert.deepEqual([...c.toolNameToPi], [["mcp__custom-tools__edit", "edit"]], "the aborted refresh rewrote the next query's name map");
			assert.deepEqual(pushed, [], "the aborted turn's steer reached the next query");
			assert.equal(c.pendingResults.size, 0, "the aborted turn's results were queued for the next query");
			assert.equal(__test.getSharedSession().needsRebuild, true, "the undelivered steer was not routed through a rebuild");
		} finally {
			__test.resetSharedSession();
		}
	});
});
