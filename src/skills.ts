import { formatSkillsForPrompt, type Skill } from "@earendil-works/pi-coding-agent";

export const MCP_SERVER_NAME = "custom-tools";
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/** How Claude reads a skill file, mirroring Pi's choice of reader: Pi's `read`
 *  or `bash` served over MCP, Claude Code's native Read, or `indirect` when Pi
 *  hides its reader but keeps it reachable, as codemode-only does. */
export type SkillReadTool = "mcp" | "mcp-bash" | "native" | "indirect" | "none";

export function renderSkillsBlock(skills: Skill[], readTool: SkillReadTool): string | undefined {
	if (readTool === "none" || skills.length === 0) return undefined;
	const piReader = readTool === "indirect" ? "indirect" : readTool === "mcp-bash" ? "bash" : "read";
	const block = formatSkillsForPrompt(skills, piReader).trim();
	if (!block) return undefined;
	if (readTool === "mcp") return rewriteSkillsBlock(block);
	if (readTool === "mcp-bash") return block.replace("Use bash to load", `Use bash (${MCP_TOOL_PREFIX}bash) to load`);
	return block;
}

export function rewriteSkillsBlock(skillsBlock: string): string {
	return skillsBlock.replace(
		"Use the read tool to load a skill's file",
		`Use the read tool (mcp__${MCP_SERVER_NAME}__read) to load a skill's file`,
	);
}
