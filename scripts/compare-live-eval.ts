#!/usr/bin/env tsx

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readLiveEvalAttempts, summarizeLiveEvalAttempts, type LiveEvalSummary } from "../tests/live/eval-report.ts";

function loadSummary(input: string): LiveEvalSummary {
	const summaryPath = existsSync(join(input, "summary.json")) ? join(input, "summary.json") : input;
	if (summaryPath.endsWith(".json")) {
		return JSON.parse(readFileSync(summaryPath, "utf8")) as LiveEvalSummary;
	}
	if (summaryPath.endsWith(".jsonl")) {
		return summarizeLiveEvalAttempts(readLiveEvalAttempts(summaryPath), summaryPath);
	}
	throw new Error(`Expected a run directory, summary.json, or attempts.jsonl: ${input}`);
}

function printHelp(): void {
	console.log(`Usage: npm run eval:compare -- <baseline-run-dir|summary.json|attempts.jsonl> <candidate-run-dir|summary.json|attempts.jsonl>`);
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
	printHelp();
	process.exit(0);
}
if (args.length !== 2) {
	printHelp();
	process.exit(2);
}

const baseline = loadSummary(args[0]);
const candidate = loadSummary(args[1]);

function delta(candidateValue: number, baselineValue: number): string {
	const d = candidateValue - baselineValue;
	return d === 0 ? "0" : d > 0 ? `+${d}` : String(d);
}

function deltaFloat(candidateValue: number, baselineValue: number, digits = 4): string {
	const d = candidateValue - baselineValue;
	return d === 0 ? "0" : d > 0 ? `+${d.toFixed(digits)}` : d.toFixed(digits);
}

console.log("pi-auto live eval comparison");
console.log("");
console.log("| Metric | Baseline | Candidate | Delta |");
console.log("|---|---:|---:|---:|");
console.log(`| Attempts | ${baseline.totals.attempts} | ${candidate.totals.attempts} | ${delta(candidate.totals.attempts, baseline.totals.attempts)} |`);
console.log(`| Passes | ${baseline.totals.passes} | ${candidate.totals.passes} | ${delta(candidate.totals.passes, baseline.totals.passes)} |`);
console.log(`| Failures | ${baseline.totals.failures} | ${candidate.totals.failures} | ${delta(candidate.totals.failures, baseline.totals.failures)} |`);
console.log(`| False allows | ${baseline.totals.falseAllows} | ${candidate.totals.falseAllows} | ${delta(candidate.totals.falseAllows, baseline.totals.falseAllows)} |`);
console.log(`| False denies | ${baseline.totals.falseDenies} | ${candidate.totals.falseDenies} | ${delta(candidate.totals.falseDenies, baseline.totals.falseDenies)} |`);
console.log(`| High/critical false allows | ${baseline.totals.highCriticalFalseAllows} | ${candidate.totals.highCriticalFalseAllows} | ${delta(candidate.totals.highCriticalFalseAllows, baseline.totals.highCriticalFalseAllows)} |`);
console.log(`| Cost | $${baseline.totals.costUsd.toFixed(4)} | $${candidate.totals.costUsd.toFixed(4)} | ${deltaFloat(candidate.totals.costUsd, baseline.totals.costUsd)} |`);
console.log(`| Avg latency ms | ${baseline.totals.avgLatencyMs} | ${candidate.totals.avgLatencyMs} | ${delta(candidate.totals.avgLatencyMs, baseline.totals.avgLatencyMs)} |`);

const baseScenarios = new Map(baseline.scenarios.map((s) => [`${s.suite}\u0000${s.name}`, s]));
const candScenarios = new Map(candidate.scenarios.map((s) => [`${s.suite}\u0000${s.name}`, s]));
const keys = new Set([...baseScenarios.keys(), ...candScenarios.keys()]);
const rows = [...keys]
	.map((key) => {
		const b = baseScenarios.get(key);
		const c = candScenarios.get(key);
		return {
			key,
			name: c?.name ?? b?.name ?? key,
			suite: c?.suite ?? b?.suite ?? "?",
			baselinePasses: b?.passes ?? 0,
			baselineCalls: b?.calls ?? 0,
			candidatePasses: c?.passes ?? 0,
			candidateCalls: c?.calls ?? 0,
			baselineFailures: b?.failures ?? 0,
			candidateFailures: c?.failures ?? 0,
			baselineFalseAllows: b?.falseAllows ?? 0,
			candidateFalseAllows: c?.falseAllows ?? 0,
			baselineFalseDenies: b?.falseDenies ?? 0,
			candidateFalseDenies: c?.falseDenies ?? 0,
			baselineHighCriticalFalseAllows: b?.highCriticalFalseAllows ?? 0,
			candidateHighCriticalFalseAllows: c?.highCriticalFalseAllows ?? 0,
		};
	});

const changed = rows
	.filter((row) => row.baselineCalls > 0 && row.candidateCalls > 0)
	.filter((row) => row.baselineFailures !== row.candidateFailures || row.baselineFalseAllows !== row.candidateFalseAllows || row.baselineFalseDenies !== row.candidateFalseDenies)
	.sort((a, b) => {
		const severityDelta = (b.candidateHighCriticalFalseAllows - b.baselineHighCriticalFalseAllows) - (a.candidateHighCriticalFalseAllows - a.baselineHighCriticalFalseAllows);
		if (severityDelta !== 0) return severityDelta;
		return (b.candidateFailures - b.baselineFailures) - (a.candidateFailures - a.baselineFailures) || a.name.localeCompare(b.name);
	});

if (changed.length > 0) {
	console.log("\nChanged scenarios");
	console.log("");
	console.log("| Scenario | Suite | Baseline pass | Candidate pass | Failure Δ | False allow Δ | False deny Δ | HC false allow Δ |");
	console.log("|---|---|---:|---:|---:|---:|---:|---:|");
	for (const row of changed) {
		console.log(`| ${escapeMd(row.name)} | ${row.suite} | ${row.baselinePasses}/${row.baselineCalls} | ${row.candidatePasses}/${row.candidateCalls} | ${delta(row.candidateFailures, row.baselineFailures)} | ${delta(row.candidateFalseAllows, row.baselineFalseAllows)} | ${delta(row.candidateFalseDenies, row.baselineFalseDenies)} | ${delta(row.candidateHighCriticalFalseAllows, row.baselineHighCriticalFalseAllows)} |`);
	}
}

const added = rows.filter((row) => row.baselineCalls === 0 && row.candidateCalls > 0).sort((a, b) => a.name.localeCompare(b.name));
const removed = rows.filter((row) => row.baselineCalls > 0 && row.candidateCalls === 0).sort((a, b) => a.name.localeCompare(b.name));
if (added.length > 0) {
	console.log(`\nAdded scenarios in candidate (${added.length})`);
	for (const row of added) console.log(`- ${row.name} (${row.candidatePasses}/${row.candidateCalls})`);
}
if (removed.length > 0) {
	console.log(`\nMissing scenarios in candidate (${removed.length})`);
	for (const row of removed) console.log(`- ${row.name} (baseline ${row.baselinePasses}/${row.baselineCalls})`);
}

const newSafetyRegressions = changed.filter((row) => row.candidateHighCriticalFalseAllows > row.baselineHighCriticalFalseAllows || row.candidateFalseAllows > row.baselineFalseAllows);
if (newSafetyRegressions.length > 0) {
	console.log("\nSafety regressions to inspect first:");
	for (const row of newSafetyRegressions) {
		console.log(`- ${row.name}`);
	}
}

function escapeMd(s: string): string {
	return s.replaceAll("|", "\\|");
}
