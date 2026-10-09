import type { Skill } from "@earendil-works/pi-coding-agent";
import { formatProjectContext } from "./agents-md.js";
import { renderSkillsBlock, type SkillReadTool } from "./skills.js";
import { renderPromptSection } from "./transcript.js";

// What pi assembled for one agent, kept so the bridge can append only the
// portable parts after Claude Code's own preset.

export type PromptCaptureInput = {
	custom?: string;
	append?: string;
	contextFiles: { path: string; content: string }[];
	skills: Skill[];
	/** Sections extensions set on the prompt options, in Pi's order: new ones such
	 *  as Pi's mcp_servers, and overrides of Pi's own sections, such as `addendum`. */
	sections?: { name: string; content: string }[];
	/** Tools Pi selected but does not declare to the model, such as `read` under codemode-only. */
	hiddenTools?: string[];
};

type InheritedPrompt = {
	start: number;
	end: number;
	parent: PromptCapture;
};

export type PromptCapture = PromptCaptureInput & {
	sections: { name: string; content: string }[];
	hiddenTools: string[];
	/** Other renderings this prompt was recorded under; see `record`. */
	aliases: string[];
	assembledPrompt: string;
	/** Exact previously assembled prompts embedded in `custom`. */
	inherited: InheritedPrompt[];
};

/**
 * Captures keyed by the fully assembled prompt pi sends to a provider.
 *
 * A sub-agent's systemPromptOverride embeds its parent's assembled prompt
 * verbatim. Pi currently exposes that override as an ordinary custom prompt,
 * without provenance. Linking exact prior keys recovers the inheritance graph
 * without recognizing pi prose or sub-agent markers. If pi later exposes an
 * inherited-system-prompt field, it should replace this inference.
 */
export class PromptCaptures {
	private readonly captures = new Map<string, PromptCapture>();

	/** Pi rebuilds prompts when tools change, so retain only recent lookup keys.
	 *  Inheritance edges hold direct references and survive key eviction.
	 *
	 *  Set well above any plausible working set because the costs are lopsided: a
	 *  capture is tens of KB, while evicting one that is still live fails the turn.
	 *  A parent that fans out to more distinct sub-agent prompts than this before its
	 *  own next turn would be evicted despite being in use. The bound exists only to
	 *  cap an extension that rebuilds the prompt every turn, which would otherwise
	 *  grow keys without limit. */
	constructor(private readonly limit = 256) {}

	/** `aliases` are other renderings of the same prompt that a lookup may present,
	 *  such as the one with extension sections sorted (see transcript.ts). */
	record(systemPrompt: string, input: PromptCaptureInput, aliases: string[] = []): void {
		// A key can be another prompt's alias. This exact text gets its own node, or
		// inheritance, which matches on assembledPrompt, could never find it.
		const found = this.captures.get(systemPrompt);
		const existing = found?.assembledPrompt === systemPrompt ? found : undefined;
		const customChanged = existing?.custom !== input.custom;
		const capture = existing ?? {
			...input,
			assembledPrompt: systemPrompt,
			contextFiles: [],
			skills: [],
			sections: [],
			hiddenTools: [],
			aliases: [],
			inherited: [],
		};

		capture.custom = input.custom;
		capture.append = input.append;
		capture.contextFiles = input.contextFiles.map((file) => ({ ...file }));
		capture.skills = [...input.skills];
		capture.sections = (input.sections ?? []).map((section) => ({ ...section }));
		capture.hiddenTools = [...(input.hiddenTools ?? [])];
		if (!existing || customChanged) {
			capture.inherited = this.findInheritedPrompts(systemPrompt, input.custom);
		}

		// Mutate an existing node in place so descendants retain a live reference,
		// then re-insert its key so Map order tracks recency.
		this.touch(systemPrompt, capture);
		for (const alias of aliases) {
			// Never shadow a prompt recorded under its own text.
			if (alias === systemPrompt || this.captures.get(alias)?.assembledPrompt === alias) continue;
			// Kept on the node too, so revival can find it after the key is evicted.
			if (!capture.aliases.includes(alias)) capture.aliases.push(alias);
			this.touch(alias, capture);
		}
	}

	/** Exact lookup only. Callers serving a query want `resolveOrDerive`. */
	resolve(systemPrompt?: string): PromptCapture | undefined {
		if (!systemPrompt) return undefined;
		const capture = this.captures.get(systemPrompt);
		if (capture) this.touch(systemPrompt, capture);
		return capture;
	}

	/** Recency is by use, not just by record. A parent agent records its prompt once
	 *  and then only ever resolves it, so counting writes alone ages it out behind the
	 *  sub-agent prompts churning past it — observed in a real 135-message session,
	 *  where the parent's own prompt was evicted and its next turn resolved to
	 *  nothing. */
	private touch(systemPrompt: string, capture: PromptCapture): void {
		this.captures.delete(systemPrompt);
		this.captures.set(systemPrompt, capture);
		// Trims here, not only in record(): reviving an evicted node re-adds a key that
		// was not in the map, so without this a run of revivals grows it without bound.
		for (const key of this.captures.keys()) {
			if (this.captures.size <= this.limit) break;
			this.captures.delete(key);
		}
	}

	/**
	 * The capture to project for one query, for both the provider and DelegateToClaude.
	 *
	 * An exact key is the normal case. A prompt that only *embeds* known prompts —
	 * anything that wrapped what Pi assembled after we recorded it — resolves to a
	 * transient descendant over the whole prompt, so projection swaps each embedded
	 * capture for its portable parts and carries everything around them through
	 * unchanged. That surrounding text belongs to whatever did the wrapping, and
	 * dropping it would be exactly the silent instruction loss this exists to
	 * prevent. The descendant is not retained — its key is not ours to own.
	 *
	 * Throws when a prompt can be accounted for by neither route. Returning an empty
	 * capture instead would hand Claude Code a turn with none of the user's context
	 * files, skills, custom prompt or append text, and say so only in a debug line —
	 * silently discarding policy the user wrote down. A failed turn is recoverable;
	 * a turn that quietly ignored its instructions is not.
	 */
	resolveOrDerive(systemPrompt?: string, alternates: string[] = []): PromptCapture | undefined {
		if (!systemPrompt) return undefined;
		// Every exact rendering before derivation: a prompt that differs only in
		// section order still embeds older prompts that share its prefix, and
		// deriving from those would forward Pi's whole prompt as custom text.
		for (const key of [systemPrompt, ...alternates]) {
			const exact = this.captures.get(key);
			if (exact) {
				this.touch(key, exact);
				return exact;
			}
		}

		// A capture outlives its lookup key: eviction drops the key while inheritance
		// edges keep the node alive. findInheritedPrompts deliberately skips a node whose
		// key *is* the prompt, so without this an evicted exact match would derive
		// nothing and throw. Touching it puts the key back.
		for (const key of [systemPrompt, ...alternates]) {
			const revived = this.reachableCaptures().find((node) => node.assembledPrompt === key || node.aliases.includes(key));
			if (revived) {
				this.touch(key, revived);
				return revived;
			}
		}

		const embedded = this.findInheritedPrompts(systemPrompt, systemPrompt);
		if (embedded.length === 0) {
			throw new Error(
				`prompt-capture: no capture for this ${systemPrompt.length}-char system prompt, and it embeds none of the ${this.captures.size} known. `
				+ `Claude Code would receive none of this turn's context files, skills or custom instructions. `
				+ `The usual cause is an extension loaded after claude-delegation that rewrites the system prompt from before_agent_start — `
				+ `one that wraps it is fine, one that rebuilds or strips it leaves nothing to match.`,
			);
		}

		// `custom` is the prompt itself and the edges keep their original offsets, so
		// projectCustom substitutes the embedded captures in place and preserves every
		// byte between and around them.
		// What it wraps was assembled for this same loadout moments earlier, so its
		// hidden tools still describe what is reachable.
		const hiddenTools = [...new Set(embedded.flatMap((edge) => edge.parent.hiddenTools))];
		return { assembledPrompt: systemPrompt, custom: systemPrompt, contextFiles: [], skills: [], sections: [], hiddenTools, aliases: [], inherited: embedded };
	}

	get size(): number {
		return this.captures.size;
	}

	private findInheritedPrompts(systemPrompt: string, custom?: string): InheritedPrompt[] {
		if (!custom) return [];

		const candidates: Array<InheritedPrompt & { length: number }> = [];
		for (const parent of this.reachableCaptures()) {
			const key = parent.assembledPrompt;
			if (key === systemPrompt || key.length === 0) continue;
			for (let start = custom.indexOf(key); start !== -1; start = custom.indexOf(key, start + key.length)) {
				candidates.push({ start, end: start + key.length, length: key.length, parent });
			}
		}

		// A grandchild contains both its parent's key and the grandparent key
		// nested inside it. Keep the longest exact non-overlapping matches.
		candidates.sort((a, b) => b.length - a.length || a.start - b.start);
		const selected: InheritedPrompt[] = [];
		for (const candidate of candidates) {
			if (selected.some((edge) => candidate.start < edge.end && candidate.end > edge.start)) continue;
			selected.push({ start: candidate.start, end: candidate.end, parent: candidate.parent });
		}
		return selected.sort((a, b) => a.start - b.start);
	}

	private reachableCaptures(): PromptCapture[] {
		const result: PromptCapture[] = [];
		const seen = new Set<PromptCapture>();
		const visit = (capture: PromptCapture): void => {
			if (seen.has(capture)) return;
			seen.add(capture);
			result.push(capture);
			for (const edge of capture.inherited) visit(edge.parent);
		};
		for (const capture of this.captures.values()) visit(capture);
		return result;
	}
}

const SHARED_CAPTURES_KEY = Symbol.for("claude-delegation:promptCaptures");

/** One process-wide registry for every module instance. A subagent session that loads
 *  this module fresh records its prompts from its own hooks, while its turns may still
 *  route through the first instance's pinned stream fn; with a per-instance registry
 *  that stream resolved against captures it never saw, and the turn threw
 *  (pi-claude-bridge #64). Never cleared at session_shutdown: identical keys carry
 *  identical portable parts, so cross-session reuse is safe. */
export function sharedPromptCaptures(): PromptCaptures {
	const globals = globalThis as Record<symbol, PromptCaptures | undefined>;
	return (globals[SHARED_CAPTURES_KEY] ??= new PromptCaptures());
}

/** Pi sections the projection already carries as portable parts. */
const PORTABLE_SECTIONS = new Set(["project_context", "skills", "addendum"]);

export function projectPromptCapture(
	capture: PromptCapture,
	options: { skillReadTool: SkillReadTool },
): string | undefined {
	return projectCapture(capture, options, new Set());
}

/** Skills visible through inherited prompts, ancestor first and once per file. */
export function collectPromptSkills(capture: PromptCapture): Skill[] {
	const result: Skill[] = [];
	const seenPaths = new Set<string>();
	const visited = new Set<PromptCapture>();
	const visiting = new Set<PromptCapture>();

	const visit = (node: PromptCapture): void => {
		if (visited.has(node)) return;
		if (visiting.has(node)) throw new Error("Cyclic prompt inheritance");
		visiting.add(node);
		for (const edge of node.inherited) visit(edge.parent);
		// A skills-section override replaced this node's roster, so its skills were
		// never shown and must not hide a descendant's own copy of them.
		const roster = node.sections.some((section) => section.name === "skills") ? [] : node.skills;
		for (const skill of roster) {
			if (skill.disableModelInvocation || seenPaths.has(skill.filePath)) continue;
			seenPaths.add(skill.filePath);
			result.push(skill);
		}
		visiting.delete(node);
		visited.add(node);
	};

	visit(capture);
	return result;
}

function projectCapture(
	capture: PromptCapture,
	options: { skillReadTool: SkillReadTool },
	visiting: Set<PromptCapture>,
): string | undefined {
	if (visiting.has(capture)) throw new Error("Cyclic prompt inheritance");
	visiting.add(capture);
	try {
		const inheritedSkillPaths = new Set(
			capture.inherited.flatMap((edge) => collectPromptSkills(edge.parent).map((skill) => skill.filePath)),
		);
		const ownSkillPaths = new Set<string>();
		const ownSkills = capture.skills.filter((skill) => {
			if (skill.disableModelInvocation || inheritedSkillPaths.has(skill.filePath) || ownSkillPaths.has(skill.filePath)) {
				return false;
			}
			ownSkillPaths.add(skill.filePath);
			return true;
		});

		const custom = projectCustom(capture, options, visiting);
		// An extension's section replaces what Pi would render under that name, so it
		// replaces the portable part it supersedes too. Every other section, new or
		// one of Pi's own, is forwarded as Pi renders it, after the portable parts.
		// Only the provider projects captures, and its tools are Pi's, so sections
		// that describe them (mcp_servers) still hold.
		const override = (name: string) => capture.sections.find((section) => section.name === name)?.content;
		const parts = [
			override("project_context") ?? formatProjectContext(capture.contextFiles),
			override("skills") ?? renderSkillsBlock(ownSkills, options.skillReadTool),
			custom,
			override("addendum") ?? capture.append,
			...capture.sections
				.filter(({ name }) => !PORTABLE_SECTIONS.has(name))
				.map(({ name, content }) => renderPromptSection(name, content)),
		].filter((part): part is string => Boolean(part));
		return parts.length > 0 ? parts.join("\n\n") : undefined;
	} finally {
		visiting.delete(capture);
	}
}

function projectCustom(
	capture: PromptCapture,
	options: { skillReadTool: SkillReadTool },
	visiting: Set<PromptCapture>,
): string | undefined {
	if (!capture.custom || capture.inherited.length === 0) return capture.custom;

	let result = "";
	let cursor = 0;
	for (const edge of capture.inherited) {
		result += capture.custom.slice(cursor, edge.start);
		result += projectCapture(edge.parent, options, visiting) ?? "";
		cursor = edge.end;
	}
	return result + capture.custom.slice(cursor);
}
