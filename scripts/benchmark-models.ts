/**
 * Benchmark the live reviewer scenarios across multiple candidate models /
 * transcript-stripping configurations.
 *
 * Usage:
 *   PI_AUTO_LIVE_TESTS=1 npx tsx scripts/benchmark-models.ts
 *   PI_AUTO_LIVE_TESTS=1 npx tsx scripts/benchmark-models.ts --only gpt-5-mini
 *   PI_AUTO_LIVE_TESTS=1 npx tsx scripts/benchmark-models.ts --only gpt-5-mini,codex
 *
 * Edits MODELS below to add/remove candidates. Each model is run once across
 * the full scenario suite and a summary table is printed.
 *
 * Filtering:
 *   --only <substring[,substring...]>   Only run rows whose label contains
 *                                       any of the given substrings.
 *                                       Matching is case-insensitive.
 *   --list                              Print rows that would run, then exit.
 */

import { spawnSync } from "node:child_process";

interface ModelSpec {
	/** Provider for PI_AUTO_REVIEWER_PROVIDER. Cosmetic when useCodexAutoReview is true. */
	provider: string;
	/** Model id for PI_AUTO_REVIEWER_MODEL. Cosmetic when useCodexAutoReview is true. */
	model: string;
	/** Display label for the row + filter matching. Must be unique. */
	label: string;
	/** Use OpenAI's hidden codex-auto-review slug. Sets PI_AUTO_USE_CODEX_AUTO_REVIEW=1. */
	useCodexAutoReview?: boolean;
	/** Strip assistant prose from the transcript. PI_AUTO_STRIP_ASSISTANT_TEXT=1. */
	stripAssistantText?: boolean;
	/** Strip tool_result entries from the transcript. PI_AUTO_STRIP_TOOL_RESULTS=1. */
	stripToolResults?: boolean;
}

const MODELS: ModelSpec[] = [
	// --- gpt-5-mini ablation: baseline vs strip-assistant vs strip-both ---
	// We measure these to validate Anthropic's claim that stripping assistant
	// prose (and optionally tool results) improves the classifier without
	// losing meaningful authorization signal.
	{ provider: "openai", model: "gpt-5-mini", label: "gpt-5-mini (baseline)" },
	{
		provider: "openai",
		model: "gpt-5-mini",
		label: "gpt-5-mini (strip-asst)",
		stripAssistantText: true,
	},
	{
		provider: "openai",
		model: "gpt-5-mini",
		label: "gpt-5-mini (strip-asst+tr)",
		stripAssistantText: true,
		stripToolResults: true,
	},

	// --- Other models, baseline transcript ---
	{ provider: "openai", model: "gpt-5-nano", label: "gpt-5-nano (baseline)" },
	{ provider: "openai", model: "gpt-4.1-mini", label: "gpt-4.1-mini (baseline)" },
	{ provider: "anthropic", model: "claude-haiku-4-5", label: "claude-haiku-4-5 (baseline)" },
	{
		provider: "openai",
		model: "codex-auto-review",
		label: "codex-auto-review",
		useCodexAutoReview: true,
	},
];

// --- CLI parsing ---
const args = process.argv.slice(2);
let onlyFilters: string[] = [];
let listOnly = false;
for (let i = 0; i < args.length; i++) {
	const a = args[i];
	if (a === "--only") {
		const v = args[++i];
		if (!v) {
			console.error("--only requires a comma-separated list");
			process.exit(2);
		}
		onlyFilters = v.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
	} else if (a === "--list") {
		listOnly = true;
	} else {
		console.error(`Unknown argument: ${a}`);
		process.exit(2);
	}
}

const selected = MODELS.filter((m) => {
	if (onlyFilters.length === 0) return true;
	const label = m.label.toLowerCase();
	return onlyFilters.some((f) => label.includes(f));
});

if (selected.length === 0) {
	console.error(`No models matched --only filter: ${onlyFilters.join(", ")}`);
	console.error("Available labels:");
	for (const m of MODELS) console.error(`  - ${m.label}`);
	process.exit(2);
}

if (listOnly) {
	console.log(`Would run ${selected.length}/${MODELS.length} rows:`);
	for (const m of selected) console.log(`  - ${m.label}`);
	process.exit(0);
}

interface Row {
	label: string;
	pass: string;
	avgLatencyMs: number;
	totalCostUsd: number;
}

const rows: Row[] = [];

for (const spec of selected) {
	process.stdout.write(`\n--- ${spec.label} ---\n`);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PI_AUTO_LIVE_TESTS: "1",
		PI_AUTO_REVIEWER_PROVIDER: spec.provider,
		PI_AUTO_REVIEWER_MODEL: spec.model,
	};
	if (spec.useCodexAutoReview) env.PI_AUTO_USE_CODEX_AUTO_REVIEW = "1";
	else delete env.PI_AUTO_USE_CODEX_AUTO_REVIEW;
	if (spec.stripAssistantText) env.PI_AUTO_STRIP_ASSISTANT_TEXT = "1";
	else delete env.PI_AUTO_STRIP_ASSISTANT_TEXT;
	if (spec.stripToolResults) env.PI_AUTO_STRIP_TOOL_RESULTS = "1";
	else delete env.PI_AUTO_STRIP_TOOL_RESULTS;

	const result = spawnSync(
		"./node_modules/.bin/vitest",
		["run", "tests/live"],
		{ env, encoding: "utf8" },
	);
	const out = (result.stdout || "") + (result.stderr || "");
	process.stdout.write(out);

	const totalLine = out.match(/^TOTAL\s+\S+.*$/m)?.[0];
	const testsLine = out.match(/Tests\s+(\d+ failed \| )?(\d+) passed \((\d+)\)/);
	const passSummary = testsLine ? `${testsLine[2]}/${testsLine[3]}` : "?/?";
	const avgMatch = totalLine?.match(/(\d+)\s*$/);
	const avgLatency = avgMatch ? Number(avgMatch[1]) : 0;
	const costMatch = totalLine?.match(/\$([0-9.]+)\s+\d+\s*$/);
	const cost = costMatch ? Number(costMatch[1]) : 0;
	rows.push({
		label: spec.label,
		pass: passSummary,
		avgLatencyMs: avgLatency,
		totalCostUsd: cost,
	});
}

console.log("\n\nFinal comparison:");
const labelW = Math.max(36, ...rows.map((r) => r.label.length));
console.log("model".padEnd(labelW), "pass".padStart(8), "avg_ms".padStart(8), "cost(usd)".padStart(12));
console.log("-".repeat(labelW + 32));
for (const r of rows) {
	console.log(
		r.label.padEnd(labelW),
		r.pass.padStart(8),
		String(r.avgLatencyMs).padStart(8),
		`$${r.totalCostUsd.toFixed(4)}`.padStart(12),
	);
}
