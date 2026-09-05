import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";
import {
	ASKCLAUDE_FULL_DISALLOWED_TOOLS,
	ASKCLAUDE_READ_TOOLS,
	DEFAULT_PERMISSION_MODE,
	managedPolicyLabels,
	observePermissionMode,
	resolveDelegationPolicy,
	resolvePermissionMode,
	resolveProviderPermissionPolicy,
	summarizeManagedPolicy,
} from "../src/query-policy.js";

function topLevelFunctionSource(source, name) {
	const file = ts.createSourceFile("src/index.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const declaration = file.statements.find(
		(statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name,
	);
	assert.ok(declaration, `${name} is missing from src/index.ts`);
	return declaration.getText(file);
}

describe("Claude query permission policy", () => {
	it("defaults every query path to auto", () => {
		assert.equal(DEFAULT_PERMISSION_MODE, "auto");
		assert.equal(resolveProviderPermissionPolicy().permissionMode, "auto");
		assert.equal(resolveDelegationPolicy("read").permissionMode, "auto");
	});

	it("accepts SDK permission modes without coupling them to capability", () => {
		const read = resolveDelegationPolicy("read", { permissionMode: "dontAsk" });
		const full = resolveDelegationPolicy("full", { permissionMode: "dontAsk" });

		assert.equal(read.permissionMode, "dontAsk");
		assert.equal(full.permissionMode, "dontAsk");
		assert.deepEqual(read.tools, [...ASKCLAUDE_READ_TOOLS]);
		assert.deepEqual(full.tools, { type: "preset", preset: "claude_code" });
	});

	it("requires an explicit SDK acknowledgement for configured bypass", () => {
		assert.deepEqual(resolveProviderPermissionPolicy({ permissionMode: "bypassPermissions" }), {
			requestedPermissionMode: "bypassPermissions",
			permissionMode: "bypassPermissions",
			allowDangerouslySkipPermissions: true,
		});
	});

	it("fails malformed JSON permission modes closed to auto", () => {
		assert.equal(resolvePermissionMode("automatic"), "auto");
		assert.equal(resolveProviderPermissionPolicy({ permissionMode: "automatic" }).permissionMode, "auto");
	});

	it("records runtime overrides without attributing their cause", () => {
		assert.deepEqual(observePermissionMode("auto", "default"), {
			requested: "auto",
			effective: "default",
			overridden: true,
		});
		assert.deepEqual(observePermissionMode("auto", "auto"), {
			requested: "auto",
			effective: "auto",
			overridden: false,
		});
		assert.equal(observePermissionMode("auto", undefined), undefined);
	});

	it("summarizes managed constraints without exposing rule contents", () => {
		const summary = summarizeManagedPolicy({
			effective: {},
			provenance: {},
			sources: [{
				source: "managed",
				policyOrigin: "plist",
				settings: {
					permissions: {
						disableBypassPermissionsMode: "disable",
						deny: ["Read(**/secret/**)"],
					},
					allowManagedPermissionRulesOnly: true,
					sandbox: {
						enabled: true,
						failIfUnavailable: true,
						allowUnsandboxedCommands: false,
						allowManagedReadPathsOnly: true,
						network: { allowManagedDomainsOnly: true },
					},
				},
			}],
		});

		assert.deepEqual(summary, {
			origin: "plist",
			disableBypassPermissions: true,
			permissionRulesOnly: true,
			denyRuleCount: 1,
			askRuleCount: 0,
			sandboxRequired: true,
			unsandboxedCommandsDisabled: true,
			managedDomainsOnly: true,
			managedReadPathsOnly: true,
		});
		assert.deepEqual(managedPolicyLabels(summary), [
			"sandbox required",
			"unsandboxed commands disabled",
			"managed permission rules only",
			"bypass disabled",
			"managed network domains only",
			"managed read paths only",
			"1 managed deny rule",
		]);
		assert.doesNotMatch(managedPolicyLabels(summary).join(" "), /secret/);
	});

	it("wires all extension query paths through resolved policy", () => {
		const srcDir = new URL("../src/", import.meta.url);
		const allSource = readdirSync(srcDir)
			.filter((name) => name.endsWith(".ts"))
			.map((name) => readFileSync(new URL(name, srcDir), "utf8"))
			.join("\n");
		const indexSource = readFileSync(new URL("index.ts", srcDir), "utf8");
		const delegationOptions = readFileSync(new URL("delegation-options.ts", srcDir), "utf8");
		const compaction = topLevelFunctionSource(indexSource, "summaryQueryOptions");
		const provider = topLevelFunctionSource(indexSource, "streamClaudeAgentSdk");
		const delegation = topLevelFunctionSource(indexSource, "runAskClaudeDelegation");
		const delegationInputs = topLevelFunctionSource(indexSource, "delegationQueryInputs");
		const background = topLevelFunctionSource(indexSource, "runBackgroundJobDelegation");

		assert.doesNotMatch(allSource, /permissionMode:\s*["'][^"']+["']/,
			"an extension query path hard-codes a permission mode");
		assert.doesNotMatch(allSource, /canUseTool\s*:/,
			"the bridge must not override Claude or organization permission decisions");

		assert.match(compaction, /resolveProviderPermissionPolicy\(compactProviderSettings\)/,
			"compaction does not resolve provider permission policy");
		assert.match(compaction, /permissionMode:\s*permissionPolicy\.permissionMode/,
			"compaction does not apply resolved permission policy");
		assert.match(provider, /resolveProviderPermissionPolicy\(providerSettings\)/,
			"provider does not resolve permission policy");
		assert.match(provider, /permissionMode:\s*permissionPolicy\.permissionMode/,
			"provider does not apply resolved permission policy");
		assert.match(delegation, /buildDelegationQueryOptions\(/,
			"delegation does not use the pure options boundary");
		assert.match(delegationInputs, /resolveDelegationPolicy\(input\.mode,/,
			"delegation does not resolve capability and permission policy");
		assert.match(delegation, /delegationQueryInputs\(/);
		assert.match(background, /delegationQueryInputs\(/);
		assert.match(background, /buildDelegationQueryOptions\(/);
		assert.match(delegationOptions, /const policy = input\.policy/,
			"delegation options do not consume the already-resolved policy");
		assert.match(delegationOptions, /permissionMode:\s*policy\.permissionMode/,
			"delegation options do not apply resolved permission policy");
		assert.doesNotMatch(provider, /runDelegation\(/,
			"the provider must not be routed through the delegation runner");
	});
});

describe("DelegateToClaude capability policy", () => {
	it("uses a structural read-only tool inventory without nested Agent", () => {
		const policy = resolveDelegationPolicy("read");

		assert.deepEqual(policy.tools, [...ASKCLAUDE_READ_TOOLS]);
		assert.ok(!policy.tools.includes("Agent"));
		assert.ok(!policy.tools.includes("Bash"));
		assert.ok(!policy.tools.includes("Edit"));
		assert.equal(policy.disallowedTools, undefined);
	});

	it("uses an empty tool inventory for no-access mode", () => {
		assert.deepEqual(resolveDelegationPolicy("none").tools, []);
	});

	it("keeps unsupported interactive tools out of full mode", () => {
		const policy = resolveDelegationPolicy("full");

		assert.deepEqual(policy.tools, { type: "preset", preset: "claude_code" });
		assert.deepEqual(policy.disallowedTools, [...ASKCLAUDE_FULL_DISALLOWED_TOOLS]);
	});
});
