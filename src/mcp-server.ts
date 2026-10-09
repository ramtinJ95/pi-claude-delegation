// In-process MCP server that exposes pi tools to Claude Code.
//
// Pi declares tool parameters as TypeBox objects, which are already JSON
// Schema at runtime — the same thing MCP puts on the wire. This serves them
// verbatim instead of going through the SDK's `createSdkMcpServer`, which only
// accepts Zod and therefore forces a JSON Schema → Zod → JSON Schema round
// trip. That round trip is lossy below the top level: nested objects collapse
// to open records and `anyOf`/`const` vanish, so Claude saw only the first
// level of any tool with a nested schema — including the builtin `edit`.
//
// Handlers go on the underlying protocol server rather than through
// `McpServer.registerTool`, which is the Zod-only path. Skipping registerTool
// also skips its argument validation, which is what we want: pi validates and
// executes tools itself, and the arguments MCP sees are discarded. A rejection
// there would only prevent the handler from running, stranding the call.
//
// This rests on the Agent SDK treating what we hand it as an opaque JSON-RPC
// endpoint: `connectSdkMcpServer` in sdk.mjs calls `instance.connect(transport)`
// and nothing else, so none of McpServer's higher-level machinery is required.
// The `McpServer` wrapper is kept only because the SDK's `mcpServers` option is
// typed against that class. If this breaks after an SDK update, check whether
// the SDK began inspecting the instance, for example by reading registered tools.
//
// The served list can change mid-turn: pi's tool_search activates tools and
// tells the model they are available on its next call. `replaceTools` swaps the
// list and sends tools/list_changed, and Claude Code re-lists before its next
// request (pinned in tests/int-cc-contracts.mjs). A removed tool stops being
// listed but stays callable: Claude Code never dispatches a tool it was not
// offered (also pinned there), so a call for one can only be a call Claude
// issued before the removal, whose result pi may already have delivered.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpResult } from "./extract-tool-results.js";

// Claude Code stamps every tools/call with the id of the tool_use block it came
// from. That is the only reliable way to pair a call with its result: call order
// is not guaranteed to match the order the tool_use blocks were emitted, so
// counting calls mispairs results as soon as the two diverge.
//
// This is a Claude Code extension, not part of the MCP spec — CC sets it in
// `src/services/mcp/client.ts` (see reference-code/claude-code-rip). If CC ever
// stops sending it, every tool call fails with the error below rather than
// silently pairing results to the wrong call, which is the intended tradeoff.
const TOOL_USE_ID_META = "claudecode/toolUseId";

export interface McpToolDef {
	name: string;
	description: string;
	inputSchema: unknown;
	handler: (toolCallId: string) => Promise<McpResult>;
}

// MCP requires an object schema. Pi types tool parameters as any TypeBox schema,
// so a scalar or array one typechecks but cannot go on the wire — that is a bug
// in the tool, and reporting it at startup names the culprit. Degrading it to
// "takes no arguments" instead would surface much later as Claude calling the
// tool with no arguments and pi's own validation rejecting them.
function assertObjectSchema(tool: McpToolDef): void {
	const schema = tool.inputSchema as Record<string, unknown> | undefined;
	if (!schema || schema.type !== "object") {
		throw new Error(`${tool.name}: MCP tool parameters must be an object schema, got ${JSON.stringify(schema)}`);
	}
}

// How long a tool result is held for Claude Code to re-list a changed tool set.
// It re-lists within milliseconds; the bound only keeps a broken contract from
// stranding the turn, and a timeout is reported, not hidden.
const RELIST_TIMEOUT_MS = 5_000;

export type ToolServer = ReturnType<typeof createToolServer>;

export function createToolServer(name: string, initialTools: McpToolDef[]) {
	const server = new McpServer({ name, version: "1.0.0" }, { capabilities: { tools: { listChanged: true } } });
	let tools = initialTools;
	const byName = new Map(tools.map((tool) => [tool.name, tool]));
	let relistWaiters: Array<() => void> = [];
	for (const tool of tools) assertObjectSchema(tool);

	server.server.setRequestHandler(ListToolsRequestSchema, () => {
		const listed = tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			inputSchema: tool.inputSchema as Record<string, unknown>,
		}));
		const waiters = relistWaiters;
		relistWaiters = [];
		for (const resolve of waiters) resolve();
		return { tools: listed };
	});

	server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const tool = byName.get(request.params.name);
		if (!tool) throw new Error(`Unknown tool: ${request.params.name}`);
		const toolCallId = request.params._meta?.[TOOL_USE_ID_META];
		if (typeof toolCallId !== "string") {
			throw new Error(`${tool.name}: tools/call is missing _meta["${TOOL_USE_ID_META}"] — cannot pair the result with its tool call`);
		}
		// Narrowed deliberately: McpResult also carries `toolCallId`, which is our
		// own bookkeeping for pairing and not part of MCP's CallToolResult.
		const { content, isError } = await tool.handler(toolCallId);
		return { content, isError };
	});

	// The SDK reads only type/name/instance; replaceTools rides along for the bridge.
	return {
		type: "sdk" as const,
		name,
		instance: server,
		/** Serve `next` instead and notify Claude Code. Throws, leaving the served
		 *  list unchanged, if a tool cannot go on the wire or the notice cannot be sent. Resolves true once Claude
		 *  Code has re-listed, false if it did not within the timeout or `signal`
		 *  aborted first. */
		async replaceTools(next: McpToolDef[], options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<boolean> {
			for (const tool of next) assertObjectSchema(tool);
			const previous = tools;
			tools = next;
			for (const tool of next) byName.set(tool.name, tool);
			let settle: (relisted: boolean) => void = () => {};
			const relisted = new Promise<boolean>((resolve) => { settle = resolve; });
			relistWaiters.push(() => settle(true));
			const timer = setTimeout(() => settle(false), options.timeoutMs ?? RELIST_TIMEOUT_MS);
			const onAbort = () => settle(false);
			options.signal?.addEventListener("abort", onAbort, { once: true });
			if (options.signal?.aborted) settle(false);
			try {
				try {
					await server.server.sendToolListChanged();
				} catch (error) {
					// Claude Code was never told, so keep listing what it last saw: the
					// caller's view of what is served stays true, and it retries.
					tools = previous;
					throw error;
				}
				return await relisted;
			} finally {
				clearTimeout(timer);
				options.signal?.removeEventListener("abort", onAbort);
			}
		},
	};
}
