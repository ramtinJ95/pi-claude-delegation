// Canonical selection + display order for the model picker.
// `resolveModel` returns the first partial match, so `opus` resolves to the first-listed opus entry.
// Extracted from index.ts so tests can import without activating the extension.

export const FABLE_MODEL_ID = "claude-fable-5-1";
const LEGACY_FABLE_MODEL_ID = "claude-fable-5";

export const MODEL_IDS_IN_ORDER = [FABLE_MODEL_ID, "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-5", "claude-sonnet-4-6", "claude-haiku-4-5"];

function modelCatalogEntry<T extends { id: string; name?: string; [key: string]: any }>(
	piAiModels: T[],
	id: string,
): T | undefined {
	const exact = piAiModels.find((model) => model.id === id);
	if (exact || id !== FABLE_MODEL_ID) return exact;

	// Pi's model catalog can lag a same-family Claude Code point release. Reuse
	// only the old Fable entry's display/capability metadata while replacing its
	// identity, so the removed model can never reach Claude Code.
	const legacy = piAiModels.find((model) => model.id === LEGACY_FABLE_MODEL_ID);
	if (!legacy) return undefined;
	const legacyName = legacy.name ?? legacy.id;
	const name = legacyName.replace(/\b5\b/, "5.1");
	return { ...legacy, id: FABLE_MODEL_ID, name } as T;
}

// Project pi-ai's model entries down to the fields pi's registerProvider expects,
// and keep MODEL_IDS_IN_ORDER ordering. IDs missing from pi-ai are silently dropped.
// Context-dependent display labels are applied after plan/long-context config is known.
export function buildModels<T extends { id: string; [key: string]: any }>(piAiModels: T[]) {
	return MODEL_IDS_IN_ORDER
		.map((id) => modelCatalogEntry(piAiModels, id))
		.filter((m) => m != null)
		// Forward thinkingLevelMap so pi-ai's per-model overrides (e.g. opus-4-8
		// mapping xhigh→xhigh and max→max) are visible to the effort lookup.
		.map(({ id, name, reasoning, input, contextWindow, maxTokens, thinkingLevelMap }) => ({
			id,
			name,
			reasoning, input, contextWindow, maxTokens,
			thinkingLevelMap,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}));
}

export type LongContextSettings = {
	plan: "pro" | "max";
	longContextExtraUsage: boolean;
};

export type ClaudeCodeRuntimeModel = {
	cliModelId: string;
	contextWindow: number;
};

const TWO_HUNDRED_K_CONTEXT = 200_000;
const ONE_M_CONTEXT = 1_000_000;

// Measured Claude Agent SDK subscription/OAuth behavior. Do not infer this from
// pi-ai's advertised contextWindow: bare Opus 4.7 serves 1M, bare Opus 4.8 does
// not, and [1m] entitlement differs by model. See diag/CONTEXT-SIZE.md.
export function resolveClaudeCodeRuntimeModel(modelId: string, settings: LongContextSettings): ClaudeCodeRuntimeModel {
	const normalizedModelId = normalizeClaudeModelRequest(modelId);
	switch (normalizedModelId) {
		case "claude-opus-5":
			return { cliModelId: "claude-opus-5[1m]", contextWindow: ONE_M_CONTEXT };
		case "claude-opus-4-8":
			return { cliModelId: "claude-opus-4-8[1m]", contextWindow: ONE_M_CONTEXT };
		case "claude-opus-4-7":
			return { cliModelId: "claude-opus-4-7", contextWindow: ONE_M_CONTEXT };
		case "claude-opus-4-6": {
			const useOneM = settings.plan === "max" || settings.longContextExtraUsage;
			return {
				cliModelId: useOneM ? "claude-opus-4-6[1m]" : "claude-opus-4-6",
				contextWindow: useOneM ? ONE_M_CONTEXT : TWO_HUNDRED_K_CONTEXT,
			};
		}
		case FABLE_MODEL_ID:
			return { cliModelId: `${FABLE_MODEL_ID}[1m]`, contextWindow: ONE_M_CONTEXT };
		case "claude-sonnet-5":
			return { cliModelId: "claude-sonnet-5[1m]", contextWindow: ONE_M_CONTEXT };
		case "claude-sonnet-4-6":
			return {
				cliModelId: settings.longContextExtraUsage ? "claude-sonnet-4-6[1m]" : "claude-sonnet-4-6",
				contextWindow: settings.longContextExtraUsage ? ONE_M_CONTEXT : TWO_HUNDRED_K_CONTEXT,
			};
		case "claude-haiku-4-5":
			return { cliModelId: "claude-haiku-4-5", contextWindow: TWO_HUNDRED_K_CONTEXT };
		default:
			console.error(`claude-delegation: encountered model ${normalizedModelId} with no known context size, defaulting to 200K`);
			return { cliModelId: normalizedModelId, contextWindow: TWO_HUNDRED_K_CONTEXT };
	}
}

export function claudeCodeModelId(model: { id: string }, settings: LongContextSettings): string {
	return resolveClaudeCodeRuntimeModel(model.id, settings).cliModelId;
}

export function resolveModel<T extends { id: string }>(models: T[], input: string): T | undefined {
	const lower = normalizeClaudeModelRequest(input).toLowerCase();
	return models.find((m) => m.id === lower || m.id.includes(lower));
}

/** Keep every Fable shortcut and stale Fable 5 request on Fable 5.1. */
export function normalizeClaudeModelRequest(input: string): string {
	const lower = input.trim().toLowerCase();
	if (
		lower === "fable"
		|| lower === FABLE_MODEL_ID
		|| lower === LEGACY_FABLE_MODEL_ID
		|| lower === `${LEGACY_FABLE_MODEL_ID}[1m]`
	) {
		return FABLE_MODEL_ID;
	}
	return input;
}

// Produce the model metadata registered with pi. The registered contextWindow must
// match the window the bridge actually requests from Claude Code, or pi's status
// bar and auto-compaction threshold will misreport. The runtime policy is based
// on measured SDK behavior - see diag/CONTEXT-SIZE.md
export function applyLongContext<T extends { id: string; name: string; contextWindow?: number | null }>(
	models: T[],
	settings: LongContextSettings,
): T[] {
	return models.map((m) => {
		const { contextWindow } = resolveClaudeCodeRuntimeModel(m.id, settings);
		const name = contextWindow > TWO_HUNDRED_K_CONTEXT && !/\b1M\b/i.test(m.name) ? `${m.name} 1M` : m.name;
		return contextWindow === m.contextWindow && name === m.name ? m : { ...m, contextWindow, name };
	});
}
