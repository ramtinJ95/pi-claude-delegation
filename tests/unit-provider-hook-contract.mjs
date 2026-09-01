#!/usr/bin/env node

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { __test } from "../src/index.ts";
import { installedRuntimeVersions } from "./lib/runtime-versions.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function typeProperties(path, typeName) {
	const source = readFileSync(path, "utf8");
	const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	let declaration;
	for (const statement of file.statements) {
		if ((ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) && statement.name.text === typeName) {
			declaration = statement;
			break;
		}
	}
	assert.ok(declaration, `${typeName} is missing from ${path}`);
	const members = ts.isInterfaceDeclaration(declaration)
		? declaration.members
		: ts.isTypeLiteralNode(declaration.type)
			? declaration.type.members
			: [];
	return new Set(members.map((member) => member.name?.getText(file)).filter(Boolean));
}

function identifiersInFunction(path, functionName) {
	const source = readFileSync(path, "utf8");
	const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const declaration = file.statements.find(
		(statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === functionName,
	);
	assert.ok(declaration, `${functionName} is missing from ${path}`);
	const identifiers = new Set();
	function visit(node) {
		if (ts.isIdentifier(node) || ts.isStringLiteral(node)) identifiers.add(node.text);
		ts.forEachChild(node, visit);
	}
	visit(declaration);
	return identifiers;
}

describe("Pi provider lifecycle hook compatibility", () => {
	it("characterizes the API gap without claiming fake support", () => {
		const piTypes = join(ROOT, "node_modules/@earendil-works/pi-ai/dist/types.d.ts");
		const sdkTypes = join(ROOT, "node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts");
		const providerSource = join(ROOT, "src/index.ts");
		const piOptions = typeProperties(piTypes, "ProviderRequestOptions");
		const agentOptions = typeProperties(sdkTypes, "Options");
		const providerIdentifiers = identifiersInFunction(providerSource, "streamClaudeAgentSdk");

		assert.ok(piOptions.has("onPayload"));
		assert.ok(piOptions.has("onResponse"));
		assert.ok(!agentOptions.has("onPayload"), "Agent SDK now exposes onPayload; reassess bridge support");
		assert.ok(!agentOptions.has("onResponse"), "Agent SDK now exposes onResponse; reassess bridge support");
		assert.ok(!agentOptions.has("fetch"), "Agent SDK now exposes fetch injection; reassess response observation");
		assert.ok(!providerIdentifiers.has("onPayload"), "provider adapter now touches onPayload; verify replacement semantics");
		assert.ok(!providerIdentifiers.has("onResponse"), "provider adapter now touches onResponse; verify response truthfulness");
		assert.deepEqual(__test.PROVIDER_HOOK_SUPPORT, {
			reviewedAgentSdk: "0.3.257",
			onPayload: false,
			onResponse: false,
		});
		assert.equal(
			installedRuntimeVersions().agentSdk,
			__test.PROVIDER_HOOK_SUPPORT.reviewedAgentSdk,
			"Agent SDK changed; manually review all request/transport hooks before updating the compatibility claim",
		);
	});

	it("pins Pi's custom streamSimple hook requirement", () => {
		const extensionTypes = readFileSync(
			join(ROOT, "node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts"),
			"utf8",
		);
		assert.match(extensionTypes, /Implementations must invoke `options\.onPayload`/);
		assert.match(extensionTypes, /must invoke `options\.onResponse` after receiving the response/);
	});
});
