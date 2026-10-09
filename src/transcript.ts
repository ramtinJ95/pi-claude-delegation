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

/** Section names Pi's builder places itself. Any other name is an extension's. */
export function isBuiltinPromptSection(name: string): boolean {
	return SECTION_RANK.has(name);
}

/** How Pi's builder renders every section but the preamble. */
export function renderPromptSection(name: string, content: string): string {
	return `<${name}>\n${content}\n</${name}>`;
}

const byName = <T extends { name: string }>(a: T, b: T) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

// Pi's builder appends extension sections after `cwd` in the order their
// before_agent_start handlers added them to that prompt's options, and each
// prompt starts from empty options. Replay keeps first-appearance order
// instead, so a section that appears for the first time ahead of an older one
// (Pi's mcp_servers, once servers exist) renders in a different order than Pi
// assembled. Neither side can see the other's order, so both also key the
// prompt with those trailing sections sorted by name.

/** The recorded prompt with its extension sections sorted by name, when that
 *  differs from the prompt as Pi assembled it. `sections` are the run's
 *  extension sections in options order, and must be the prompt's verbatim tail. */
export function sortedExtensionSectionsKey(
	systemPrompt: string,
	sections: { name: string; content: string }[],
): string | undefined {
	if (sections.length < 2) return undefined;
	const tail = sections.map(({ name, content }) => renderPromptSection(name, content)).join("\n\n");
	if (!systemPrompt.endsWith(`\n\n${tail}`)) return undefined;
	const sorted = [...sections].sort(byName).map(({ name, content }) => renderPromptSection(name, content)).join("\n\n");
	return sorted === tail ? undefined : systemPrompt.slice(0, -tail.length) + sorted;
}

/** Other renderings of the replayed prompt that Pi may have assembled, for
 *  lookup after the canonical text `toBridgeContext` produces:
 *  - trailing extension sections sorted by name (see above);
 *  - replay's own first-appearance order. That is Pi's order whenever no section
 *    arrived after the first prompt, including an extension's override of a
 *    section Pi had not rendered, which Pi appends rather than placing. */
export function alternatePromptKeys(context: Context): string[] {
	if (!context.messages.some((message) => message.role === "system")) return [];
	const system = getCurrentSystemMessage(context.messages);
	if (!system?.sections) return [];
	const render = (sections: SystemMessage["sections"]) => getSystemMessageText({ ...system, sections }) || undefined;
	const entries = Object.entries(canonicalSections(system.sections) ?? {}).map(([name, value]) => ({ name, value }));
	let start = entries.length;
	while (start > 0 && !isBuiltinPromptSection(entries[start - 1].name)) start--;
	const tail = entries.slice(start);
	const sorted = [...tail].sort(byName);
	const keys = [
		sorted.some((entry, i) => entry !== tail[i])
			? render(Object.fromEntries([...entries.slice(0, start), ...sorted].map(({ name, value }) => [name, value])))
			: undefined,
		render(system.sections),
	];
	const canonical = render(canonicalSections(system.sections));
	return [...new Set(keys)].filter((key): key is string => key !== undefined && key !== canonical);
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
