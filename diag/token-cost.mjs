#!/usr/bin/env node
// Price-weighted token cost per task for claude-delegation turns, from pi session files.
//
//   node diag/token-cost.mjs [sessions-dir] [--since YYYY-MM-DD] [--provider claude-delegation,claude-bridge]
//
// Pi records each Claude request's usage on its assistant message, which is the
// only per-request record by billing type the bridge keeps. The registered models
// ship zero prices (subscription billing), so cost here is in units of the base
// uncached input price, using Anthropic's ratios:
//
//   uncached input 1 · output 5 · cache read 0.1 · cache write 1.25 (5m) / 2 (1h)
//
// A request's 1h share is `usage.cacheWrite1h` when the bridge recorded it; older
// sessions lack it and are priced at --write-ttl (default 1h, which is what Claude
// Code picks on a subscription).
//
// What "task" means: everything from one user message to the next. Every request
// resends the prefix, so the report is per task, not per request.
//
// Source attribution (the re-read table) comes from the API's own numbers: the
// prompt grows between consecutive requests by the previous output plus whatever
// was appended (tool results, user text), and each appended token is re-read by
// every later request until the prefix shrinks (compaction or rebuild). Splitting
// one growth step across several results is by character share — an estimate.
//
// The TTL line replays the observed inter-request gaps under the other TTL. Gaps
// are measured between response timestamps, which overstates idle time by one
// generation, so it slightly overcounts 5m expiries.

import { readFileSync, readdirSync, statSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? fallback : args[i + 1];
};
const positional = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const ROOT = realpathSync(positional[0] ?? join(homedir(), ".pi", "agent", "sessions"));
const SINCE = flag("since") ? Date.parse(flag("since")) : 0;
const PROVIDERS = new Set(flag("provider", "claude-delegation,claude-bridge").split(","));
const DEFAULT_TTL = flag("write-ttl", "1h");
if (Number.isNaN(SINCE) || !["5m", "1h"].includes(DEFAULT_TTL)) {
	console.error("usage: token-cost.mjs [dir] [--since YYYY-MM-DD] [--provider a,b] [--write-ttl 5m|1h]");
	process.exit(2);
}

const PRICE = { input: 1, output: 5, cacheRead: 0.1, write5m: 1.25, write1h: 2 };
const COLD_MIN_PROMPT = 4_000;

function walk(dir, out = []) {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		const s = statSync(p);
		if (s.isDirectory()) walk(p, out);
		else if (name.endsWith(".jsonl")) out.push(p);
	}
	return out;
}

function readEntries(file) {
	try {
		return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
	} catch {
		return null;
	}
}

const ours = (m) => m.role === "assistant" && PROVIDERS.has(m.provider);
const promptOf = (u) => (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
function writeSplit(u, ttl) {
	const w = u.cacheWrite ?? 0;
	const h = u.cacheWrite1h ?? (ttl === "1h" ? w : 0);
	return { w5m: w - h, w1h: h };
}
function cost(u, ttl = DEFAULT_TTL) {
	const { w5m, w1h } = writeSplit(u, ttl);
	return (u.input ?? 0) * PRICE.input + (u.output ?? 0) * PRICE.output + (u.cacheRead ?? 0) * PRICE.cacheRead
		+ w5m * PRICE.write5m + w1h * PRICE.write1h;
}

const totals = { requests: 0, input: 0, output: 0, cacheRead: 0, w5m: 0, w1h: 0, recordedTtl: 0 };
const tasks = [];
const tools = new Map();
const reread = new Map();
const firstPrompts = [];
const cold = [];
const ttlSim = { observed: 0, as5m: 0, as1h: 0, gaps: { "≤5m": 0, "5–60m": 0, ">60m": 0 } };
let sessions = 0;

for (const file of walk(ROOT)) {
	if (statSync(file).mtimeMs < SINCE) continue;
	const entries = readEntries(file);
	if (!entries?.some((e) => e.type === "message" && ours(e.message))) continue;
	sessions++;

	let task = null;
	let appended = [];
	let prev = null;
	let segment = [];
	let events = [];
	const closeSegment = (requestIndex) => {
		for (const add of segment) reread.set(add.source, (reread.get(add.source) ?? 0) + add.tokens * (requestIndex - add.at - 1));
		segment = [];
	};
	let requestIndex = 0;

	for (const e of entries) {
		if (e.type !== "message") {
			events.push(e.type);
			if (e.type === "compaction") { closeSegment(requestIndex); prev = null; }
			continue;
		}
		const m = e.message;
		if (m.role === "user") {
			if (task?.requests) tasks.push(task);
			task = { requests: 0, cost: 0, tools: new Set() };
			appended.push({ source: "user message", chars: JSON.stringify(m.content).length });
			events.push("user");
			continue;
		}
		if (m.role === "toolResult") {
			const chars = (m.content ?? []).reduce((n, c) => n + (c.text?.length ?? 0), 0);
			appended.push({ source: `tool:${m.toolName}`, chars });
			const t = tools.get(m.toolName) ?? { calls: 0, errors: 0, chars: 0 };
			t.calls++;
			if (m.isError) t.errors++;
			t.chars += chars;
			tools.set(m.toolName, t);
			task?.tools.add(m.toolName);
			continue;
		}
		if (!ours(m)) {
			// Another provider's turn: its usage is not ours, and our prefix continuity ends.
			if (m.role === "assistant") { closeSegment(requestIndex); prev = null; appended = []; events.push(`assistant:${m.provider}`); }
			continue;
		}
		const u = m.usage ?? {};
		const prompt = promptOf(u);
		if (prompt === 0) continue;

		const { w5m, w1h } = writeSplit(u, DEFAULT_TTL);
		totals.requests++;
		totals.input += u.input ?? 0;
		totals.output += u.output ?? 0;
		totals.cacheRead += u.cacheRead ?? 0;
		totals.w5m += w5m;
		totals.w1h += w1h;
		if (u.cacheWrite1h != null) totals.recordedTtl++;
		task ??= { requests: 0, cost: 0, tools: new Set() };
		task.requests++;
		task.cost += cost(u);

		const t = Date.parse(e.timestamp);
		const gapMin = prev ? (t - prev.t) / 60_000 : null;
		if (!prev) {
			firstPrompts.push(prompt);
			segment.push({ source: "prefix at segment start", tokens: prompt, at: requestIndex });
		} else {
			const growth = prompt - prev.prompt;
			if (growth < -2_000) {
				closeSegment(requestIndex);
				segment.push({ source: "prefix at segment start", tokens: prompt, at: requestIndex });
			} else {
				if (prev.output > 0) segment.push({ source: "assistant output", tokens: prev.output, at: requestIndex });
				const added = growth - prev.output;
				const chars = appended.reduce((n, a) => n + a.chars, 0);
				if (added > 0 && chars > 0) {
					for (const a of appended) segment.push({ source: a.source, tokens: added * a.chars / chars, at: requestIndex });
				}
			}
			if ((u.cacheRead ?? 0) < 0.5 * prompt && prompt > COLD_MIN_PROMPT) {
				cold.push({ file: file.slice(ROOT.length + 1), at: e.timestamp, prompt, cacheRead: u.cacheRead ?? 0, gapMin, before: [...new Set(events)].join(",") });
			}
		}

		// Replay this request under each TTL: a gap past the TTL re-writes the whole prompt.
		ttlSim.observed += cost(u);
		for (const [key, ttl, limit] of [["as5m", "5m", 5], ["as1h", "1h", 60]]) {
			const expired = gapMin != null && gapMin > limit && !(gapMin > 60);
			const writes = expired ? (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) : (u.cacheWrite ?? 0);
			const reads = expired ? 0 : (u.cacheRead ?? 0);
			ttlSim[key] += (u.input ?? 0) + (u.output ?? 0) * PRICE.output + reads * PRICE.cacheRead + writes * (ttl === "1h" ? PRICE.write1h : PRICE.write5m);
		}
		if (gapMin != null) ttlSim.gaps[gapMin <= 5 ? "≤5m" : gapMin <= 60 ? "5–60m" : ">60m"]++;

		prev = { t, prompt, output: u.output ?? 0 };
		appended = [];
		events = [];
		requestIndex++;
	}
	closeSegment(requestIndex);
	if (task?.requests) tasks.push(task);
}

const n = (x) => Math.round(x).toLocaleString("en-US");
const pct = (a, b) => (b ? (100 * a / b).toFixed(1) : "0.0") + "%";
const quantile = (xs, q) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0;
};

if (totals.requests === 0) {
	console.log(`no ${[...PROVIDERS].join("/")} requests under ${ROOT}`);
	process.exit(0);
}

console.log(`sessions=${sessions} requests=${totals.requests} tasks=${tasks.length} (TTL recorded on ${totals.recordedTtl}; others priced as ${DEFAULT_TTL})`);
const parts = {
	"uncached input": totals.input * PRICE.input,
	output: totals.output * PRICE.output,
	"cache read": totals.cacheRead * PRICE.cacheRead,
	"cache write 5m": totals.w5m * PRICE.write5m,
	"cache write 1h": totals.w1h * PRICE.write1h,
};
const tokens = { "uncached input": totals.input, output: totals.output, "cache read": totals.cacheRead, "cache write 5m": totals.w5m, "cache write 1h": totals.w1h };
const all = Object.values(parts).reduce((a, b) => a + b, 0);
console.log("\ncost by billing type (base-input-price units)");
for (const [k, v] of Object.entries(parts)) console.log(`  ${k.padEnd(15)} tokens=${n(tokens[k]).padStart(13)}  cost=${n(v).padStart(12)}  ${pct(v, all).padStart(6)}`);

const prompts = totals.input + totals.cacheRead + totals.w5m + totals.w1h;
console.log(`\ncache hit rate ${pct(totals.cacheRead, prompts)} of prompt tokens`);
console.log(`requests/task  median=${quantile(tasks.map((t) => t.requests), 0.5)} p90=${quantile(tasks.map((t) => t.requests), 0.9)} mean=${(totals.requests / tasks.length).toFixed(1)}`);
console.log(`cost/task      median=${n(quantile(tasks.map((t) => t.cost), 0.5))} p90=${n(quantile(tasks.map((t) => t.cost), 0.9))} mean=${n(all / tasks.length)}`);
console.log(`static prefix  first request of a segment: median=${n(quantile(firstPrompts, 0.5))} tokens (n=${firstPrompts.length})`);

console.log("\nper tool: calls, share of tasks calling it, error rate, result chars");
const taskShare = new Map();
for (const t of tasks) for (const name of t.tools) taskShare.set(name, (taskShare.get(name) ?? 0) + 1);
for (const [name, t] of [...tools].sort((a, b) => b[1].calls - a[1].calls)) {
	console.log(`  ${name.padEnd(24)} calls=${String(t.calls).padStart(5)}  tasks=${pct(taskShare.get(name) ?? 0, tasks.length).padStart(6)}  errors=${pct(t.errors, t.calls).padStart(6)}  chars=${n(t.chars).padStart(10)}`);
}

console.log("\ncache-read exposure by source (tokens × later requests re-reading them)");
const exposure = [...reread].sort((a, b) => b[1] - a[1]);
const exposureTotal = exposure.reduce((s, [, v]) => s + v, 0);
for (const [source, v] of exposure.slice(0, 15)) console.log(`  ${source.padEnd(26)} ${n(v).padStart(14)}  ${pct(v, exposureTotal).padStart(6)}`);

console.log(`\ncold requests (cache read < 50% of a >${n(COLD_MIN_PROMPT)}-token prompt): ${cold.length}`);
for (const c of cold) console.log(`  ${c.at} prompt=${n(c.prompt)} read=${n(c.cacheRead)} gap=${c.gapMin?.toFixed(1)}m after=[${c.before}] ${c.file}`);

console.log(`\nTTL replay over observed gaps ${JSON.stringify(ttlSim.gaps)}`);
console.log(`  all-5m ${n(ttlSim.as5m)} vs all-1h ${n(ttlSim.as1h)} → 5m is ${pct(ttlSim.as5m - ttlSim.as1h, ttlSim.as1h)} relative to 1h`);
