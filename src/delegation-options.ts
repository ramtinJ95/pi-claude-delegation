import type {
	EffortLevel,
	Options,
	SettingSource,
} from "@anthropic-ai/claude-agent-sdk";
import type { DelegationPolicy } from "./query-policy.js";

export const ASK_CLAUDE_DEFAULT_MODEL = "opus";

interface DelegationQueryOptionsCommon {
	policy: DelegationPolicy;
	cwd: string;
	env: Options["env"];
	settings: NonNullable<Options["settings"]>;
	cliModel: string;
	effort?: EffortLevel;
	systemPromptAppend?: string;
	pathToClaudeCodeExecutable?: string;
	debugOptions?: Pick<Options, "debug" | "debugFile" | "stderr">;
}

type DelegationSessionOptions =
	| { isolated: true; resumeSessionId?: never }
	| { isolated: false; resumeSessionId?: string | null };

export type DelegationQueryOptionsInput = DelegationQueryOptionsCommon & DelegationSessionOptions;

export interface ResolvedDelegationQueryOptions {
	options: Options;
	policy: DelegationPolicy;
}

/**
 * Build the Agent SDK options for a Claude-native delegation query.
 *
 * This function deliberately owns no session lookup, settings resolution,
 * prompt capture, query lifecycle, or UI. Callers must resolve those inputs
 * before entering this pure boundary.
 */
export function buildDelegationQueryOptions(
	input: DelegationQueryOptionsInput,
): ResolvedDelegationQueryOptions {
	const policy = input.policy;
	const extraArgs: Record<string, string | null> = {
		"strict-mcp-config": null,
		model: input.cliModel,
	};
	if (input.effort) extraArgs["thinking-display"] = "summarized";

	return {
		policy,
		options: {
			cwd: input.cwd,
			env: input.env,
			// Delegation observability is driven from the same SDK stream as the
			// final result. Without partial messages, text/thinking and tool starts
			// only become visible after a completed assistant turn.
			includePartialMessages: true,
			permissionMode: policy.permissionMode,
			...(policy.allowDangerouslySkipPermissions
				? { allowDangerouslySkipPermissions: true }
				: {}),
			settings: input.settings,
			// Suppress Claude Code's own skill listing: a system-reminder naming every
			// skill under the user's ~/.claude estate. The provider path gets this for
			// free — `tools: []` removes the Skill tool and the listing with it — but
			// delegation runs on Claude Code's native tools, so it has to ask. Pi-side
			// skills arrive only through the system-prompt append below, which is meant
			// to be the only channel.
			skills: [],
			tools: policy.tools,
			...(policy.disallowedTools
				? { disallowedTools: policy.disallowedTools }
				: {}),
			...(input.effort ? { effort: input.effort } : {}),
			// Preset unconditionally: omitting it leaves the child on the SDK's bare
			// default, without the tool and permission guidance the bridge relies on
			// everywhere else. Whether Pi has skills to append is unrelated to whether
			// the child needs that guidance.
			systemPrompt: {
				type: "preset",
				preset: "claude_code",
				append: input.systemPromptAppend,
			},
			settingSources: ["user", "project"] as SettingSource[],
			extraArgs,
			...(input.resumeSessionId ? { resume: input.resumeSessionId } : {}),
			...(input.isolated ? { persistSession: false } : {}),
			...(input.pathToClaudeCodeExecutable
				? { pathToClaudeCodeExecutable: input.pathToClaudeCodeExecutable }
				: {}),
			...input.debugOptions,
		},
	};
}
