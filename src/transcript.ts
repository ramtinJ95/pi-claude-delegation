import type { Context, SystemMessage } from "@earendil-works/pi-ai";
import { getCurrentSystemMessage, getSystemMessageText } from "@earendil-works/pi-ai";

// Pi 0.86+ sends prompt sections and tool deltas inside transcript system
// messages. Collapse them at the bridge boundary; CC session cursors and
// prompt/tool projection still operate on the legacy Context shape.
// Adapted from pi-claude-bridge #106, using Pi's public replay helpers.

// Match Pi's buildSystemPromptSections order for exact prompt-capture lookup.
// Deleting then re-adding a section otherwise moves it to the Map tail.
const SECTION_RANK = new Map([
	["preamble", 0], ["tools", 1], ["rules", 2], ["docs", 3], ["addendum", 4],
	["project_context", 5], ["skills", 6], ["cwd", 7],
]);

function canonicalSections(sections: SystemMessage["sections"]): SystemMessage["sections"] {
	if (!sections) return sections;
	let predecessorRank = -1;
	const ranked = Object.entries(sections).map(([name, value]) => {
		const rank = SECTION_RANK.get(name) ?? predecessorRank;
		predecessorRank = rank;
		return { name, value, rank };
	});
	// Unknown sections inherit their predecessor's rank: a future built-in or
	// extension section retains its place in an already-canonical prompt.
	ranked.sort((a, b) => a.rank - b.rank);
	return Object.fromEntries(ranked.map(({ name, value }) => [name, value]));
}

export function toBridgeContext(context: Context): Context {
	if (!context.messages.some((message) => message.role === "system")) return context;
	const system = getCurrentSystemMessage(context.messages);
	return {
		...context,
		systemPrompt: system
			? getSystemMessageText({ ...system, sections: canonicalSections(system.sections) }) || undefined
			: undefined,
		tools: system?.toolsAdded,
		messages: nonSystemMessages(context.messages),
	};
}

/** System messages are prompt/tool state, never Claude Code session history. */
export function nonSystemMessages<T extends { role: string }>(messages: readonly T[]): T[] {
	return messages.filter((message) => message.role !== "system");
}
