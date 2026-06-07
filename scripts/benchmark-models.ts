/**
 * Benchmark the live reviewer scenarios across multiple candidate models.
 *
 * Usage:
 *   PI_AUTO_LIVE_TESTS=1 npx tsx scripts/benchmark-models.ts
 *
 * Edits MODELS below to add/remove candidates. Each model is run once
 * across the full scenario suite and a summary table is printed.
 */

import { spawnSync } from "node:child_process";

const MODELS: Array<{ provider: string; model: string }> = [
	{ provider: "openai", model: "gpt-5-mini" },
	{ provider: "openai", model: "gpt-5-nano" },
	{ provider: "openai", model: "gpt-4.1-mini" },
	{ provider: "anthropic", model: "claude-haiku-4-5" },
];

interface Row {
	model: string;
	pass: string;
	avgLatencyMs: number;
	totalCostUsd: number;
}

const rows: Row[] = [];

for (const { provider, model } of MODELS) {
	process.stdout.write(`\n--- ${provider}/${model} ---\n`);
	const result = spawnSync(
		"./node_modules/.bin/vitest",
		["run", "tests/live"],
		{
			env: {
				...process.env,
				PI_AUTO_LIVE_TESTS: "1",
				PI_AUTO_REVIEWER_PROVIDER: provider,
				PI_AUTO_REVIEWER_MODEL: model,
			},
			encoding: "utf8",
		},
	);
	const out = (result.stdout || "") + (result.stderr || "");
	process.stdout.write(out);

	const totalLine = out.match(/^TOTAL\s+\S+.*$/m)?.[0];
	const testsLine = out.match(/Tests\s+(\d+ failed \| )?(\d+) passed \((\d+)\)/);
	const passSummary = testsLine
		? `${testsLine[2]}/${testsLine[3]}`
		: "?/?";
	const avgMatch = totalLine?.match(/(\d+)\s*$/);
	const avgLatency = avgMatch ? Number(avgMatch[1]) : 0;
	const costMatch = totalLine?.match(/\$([0-9.]+)\s+\d+\s*$/);
	const cost = costMatch ? Number(costMatch[1]) : 0;
	rows.push({
		model: `${provider}/${model}`,
		pass: passSummary,
		avgLatencyMs: avgLatency,
		totalCostUsd: cost,
	});
}

console.log("\n\nFinal comparison:");
console.log("model".padEnd(36), "pass".padStart(8), "avg_ms".padStart(8), "cost(usd)".padStart(12));
console.log("-".repeat(72));
for (const r of rows) {
	console.log(
		r.model.padEnd(36),
		r.pass.padStart(8),
		String(r.avgLatencyMs).padStart(8),
		`$${r.totalCostUsd.toFixed(4)}`.padStart(12),
	);
}
