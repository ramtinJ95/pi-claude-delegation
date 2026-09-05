import type { AssistantMessage, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { query, type Options, type SDKAssistantMessageError, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { messageContentToText } from "./convert.js";
import { assertSdkResultReceived, errorMessage, sdkResultErrorText as resultErrorText } from "./delegation-events.js";
import type { DelegationQuery, DelegationQueryFactory } from "./delegation-runner.js";

interface SummaryDependencies {
	createStream: () => AssistantMessageEventStream;
	resolveOptions: (model: Model<any>, context: Context, options?: SimpleStreamOptions) => Options;
	onResult?: (message: SDKResultMessage, model: Model<any>) => void;
	debug?: (...args: unknown[]) => void;
	queryFactory?: DelegationQueryFactory;
}

// Summary execution owns its query and cancellation, but never provider session
// state or delegation retention caps. The caller supplies configuration only.
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
	const content = messages[0].content;
	const promptText = typeof content === "string" ? content : messageContentToText(content);
	if (!promptText) throw new Error("isolatedStreamFn: summarization prompt is empty");
	return promptText;
}

export function createIsolatedSummaryStreamFn(deps: SummaryDependencies) {
	return (model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream => {
		const stream = deps.createStream();
		void runIsolatedSummary(model, context, options, stream, deps);
		return stream;
	};
}

async function runIsolatedSummary(
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	stream: AssistantMessageEventStream,
	deps: SummaryDependencies,
): Promise<void> {
	const debug = deps.debug ?? (() => {});
	let sdkQuery: DelegationQuery | undefined;
	let wasAborted = false;
	const onAbort = () => {
		wasAborted = true;
		void sdkQuery?.interrupt().catch(() => {});
		try { sdkQuery?.close(); } catch {}
	};

	try {
		const promptText = extractIsolatedSummaryPrompt(context.messages);
		if (options?.signal?.aborted) onAbort();
		else sdkQuery = (deps.queryFactory ?? query)({ prompt: promptText, options: deps.resolveOptions(model, context, options) });

		if (options?.signal) {
			if (options.signal.aborted) onAbort();
			else options.signal.addEventListener("abort", onAbort, { once: true });
		}

		let assistantText = "";
		let sawResult = false;
		let assistantError: SDKAssistantMessageError | undefined;
		let finalText = "";
		let errorText: string | undefined;
		let firstEventLogged = false;

		for await (const message of sdkQuery ?? []) {
			if (!firstEventLogged) {
				debug(`compact summary: first event type=${message.type}`);
				firstEventLogged = true;
			}
			if (wasAborted) break;

			if (message.type === "assistant") {
				assistantError = message.error ?? assistantError;
				for (const block of (message as any).message?.content ?? []) {
					if (block.type === "text" && typeof block.text === "string") assistantText += block.text;
				}
			} else if (message.type === "result") {
				sawResult = true;
				deps.onResult?.(message, model);
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

		assertSdkResultReceived(sawResult, assistantError);
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
		const msg = wasAborted ? "Operation aborted" : errorMessage(err);
		debug("runIsolatedSummary threw; pushing terminal error", err);
		const reason = wasAborted ? "aborted" : "error";
		stream.push({ type: "error", reason, error: newAssistantOutput(model, "", reason, msg) });
		stream.end();
	} finally {
		options?.signal?.removeEventListener("abort", onAbort);
		try { sdkQuery?.close(); } catch {}
	}
}
