// User-facing extension config. Loaded once at extension registration from
// the global agent dir (getAgentDir(), e.g. ~/.pi/agent/claude-delegation.json)
// and the project Pi config directory, project overriding global. Missing or
// unparseable files are ignored (error to console.error, empty object
// returned) so the extension always starts.

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

export interface Config {
	/** Date (YYYY-MM-DD) the one-time startup notice was shown. Written by the extension, not the user. */
	startupNoticeShown?: string;
	delegation?: {
		enabled?: boolean;
		name?: string;
		label?: string;
		description?: string;
		defaultMode?: "full" | "read" | "none";
		defaultIsolated?: boolean;
		allowFullMode?: boolean;
		appendSkills?: boolean;
		/** How Claude Code governs tools within the selected capability mode. */
		permissionMode?: PermissionMode;
	};
	/** Low-level Claude Agent SDK plumbing. Most users won't need these. */
	provider?: {
		strictMcpConfig?: boolean;
		autoMemoryEnabled?: boolean;
		pathToClaudeCodeExecutable?: string;
		/** How Claude Code governs Pi's MCP tools. Managed settings still win. */
		permissionMode?: PermissionMode;
		// Subscription plan tier. Setting to "max" enables Opus 4.6 at 1M context
		plan?: "pro" | "max";
		// Set to true to opt into metered 1M context usage ("extra usage" in
		// Anthropic billing). Enables Sonnet 4.6 [1m] on every plan and Opus 4.6
		// [1m] on Pro.
		longContextExtraUsage?: boolean;
		/** Prompt cache TTL for every Claude Code query the extension runs. Unset keeps
		 *  Claude Code's choice (1h on a subscription). A 1h write bills at 2x base input,
		 *  a 5m one at 1.25x; 5m is cheaper unless requests are often 5-60 min apart. */
		promptCacheTtl?: "5m" | "1h";
	};
}

export function tryParseJson(path: string): Partial<Config> {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch (e) {
		console.error(`claude-delegation: failed to parse ${path}: ${e}`);
		return {};
	}
}

export function claudeCodeSettings(provider: Config["provider"] = {}): { autoMemoryEnabled: boolean; promptCacheTtl?: "5m" | "1h" } {
	const ttl = provider.promptCacheTtl;
	if (ttl !== undefined && ttl !== "5m" && ttl !== "1h") {
		console.error(`claude-delegation: ignoring provider.promptCacheTtl ${JSON.stringify(ttl)}; expected "5m" or "1h"`);
	}
	return {
		autoMemoryEnabled: provider.autoMemoryEnabled ?? false,
		...(ttl === "5m" || ttl === "1h" ? { promptCacheTtl: ttl } : {}),
	};
}

export function globalConfigPath(): string {
	return join(getAgentDir(), "claude-delegation.json");
}

/** Record today's date in the global config so the startup notice shows once, preserving every
 *  other field. Returns the config path for display either way.
 *
 *  Parses directly rather than through tryParseJson, which reports an unparseable file as `{}`:
 *  spreading that would replace a user's whole config with just this marker the first time they
 *  leave a trailing comma in it. Losing the notice is the cheaper failure, so the write is
 *  skipped and the notice simply shows again next session. */
export function markStartupNoticeShown(): string {
	const path = globalConfigPath();
	let existing: Partial<Config> = {};
	if (existsSync(path)) {
		try {
			existing = JSON.parse(readFileSync(path, "utf-8"));
		} catch (e) {
			console.error(`claude-delegation: leaving ${path} alone, it does not parse: ${e}`);
			return path;
		}
	}
	// en-CA renders YYYY-MM-DD in local time; toISOString() would report UTC.
	const next = { ...existing, startupNoticeShown: new Date().toLocaleDateString("en-CA") };
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
	return path;
}

export function loadConfig(cwd: string): Config {
	const global = tryParseJson(globalConfigPath());
	const project = tryParseJson(join(cwd, CONFIG_DIR_NAME, "claude-delegation.json"));
	return {
		startupNoticeShown: project.startupNoticeShown ?? global.startupNoticeShown,
		delegation: { ...global.delegation, ...project.delegation },
		provider: { ...global.provider, ...project.provider },
	};
}
