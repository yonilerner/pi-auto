import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const LIVE_EVAL_SCHEMA_VERSION = 1;
export const LIVE_EVAL_SOFT_ASSERT = process.env.PI_AUTO_LIVE_SOFT_ASSERT === "1";

export type LiveEvalSuite = "reviewer" | "digest";
export type LiveEvalExpected = "allow" | "deny" | "pass";
export type LiveEvalActual = "allow" | "deny" | "pass" | "fail" | "error";
export type LiveEvalFailureKind = "false_allow" | "false_deny" | "assertion_failure" | "reviewer_error" | "digest_error";
export type LiveEvalFailureSeverity = "safety" | "productivity" | "calibration";

export interface LiveEvalUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	costUsd?: number;
}

export interface LiveEvalAttempt {
	schemaVersion: typeof LIVE_EVAL_SCHEMA_VERSION;
	timestamp: string;
	suite: LiveEvalSuite;
	suiteLabel: string;
	provider: string;
	model: string;
	scenarioName: string;
	testName?: string;
	iteration: number;
	iterations: number;
	tags?: string[];
	failureSeverity?: LiveEvalFailureSeverity;
	expected: LiveEvalExpected;
	actual: LiveEvalActual;
	passed: boolean;
	failureKind?: LiveEvalFailureKind;
	riskLevel?: string;
	userAuthorization?: string;
	rationale?: string;
	raw?: string;
	action?: unknown;
	transcript?: string;
	digest?: string;
	whatItTests?: string;
	assertionFailures?: string[];
	usage?: LiveEvalUsage;
	latencyMs?: number;
	error?: string;
}

export interface LiveEvalScenarioSummary {
	name: string;
	suite: LiveEvalSuite;
	tags: string[];
	expected: Record<string, number>;
	actual: Record<string, number>;
	calls: number;
	passes: number;
	failures: number;
	falseAllows: number;
	falseDenies: number;
	assertionFailures: number;
	errors: number;
	highCriticalFalseAllows: number;
	costUsd: number;
	totalTokens: number;
	avgLatencyMs: number;
	riskLevels: Record<string, number>;
	userAuthorizations: Record<string, number>;
	failureKinds: Record<string, number>;
	rationales: string[];
}

export interface LiveEvalTagSummary {
	tag: string;
	calls: number;
	passes: number;
	failures: number;
	falseAllows: number;
	falseDenies: number;
	highCriticalFalseAllows: number;
}

export interface LiveEvalSummary {
	schemaVersion: typeof LIVE_EVAL_SCHEMA_VERSION;
	generatedAt: string;
	source?: string;
	run: {
		provider?: string;
		model?: string;
		suiteLabels: string[];
		iterations: number[];
	};
	totals: {
		attempts: number;
		passes: number;
		failures: number;
		falseAllows: number;
		falseDenies: number;
		assertionFailures: number;
		errors: number;
		highCriticalFalseAllows: number;
		costUsd: number;
		totalTokens: number;
		avgLatencyMs: number;
	};
	bySuite: Record<string, Omit<LiveEvalTagSummary, "tag">>;
	byTag: LiveEvalTagSummary[];
	scenarios: LiveEvalScenarioSummary[];
	failedAttempts: Array<Pick<LiveEvalAttempt, "suite" | "scenarioName" | "iteration" | "expected" | "actual" | "failureKind" | "riskLevel" | "userAuthorization" | "rationale" | "error">>;
}

export function makeLiveEvalAttempt(args: Omit<LiveEvalAttempt, "schemaVersion" | "timestamp" | "passed" | "failureKind"> & { passed?: boolean; failureKind?: LiveEvalFailureKind }): LiveEvalAttempt {
	const passed = args.passed ?? args.expected === args.actual;
	return {
		...args,
		schemaVersion: LIVE_EVAL_SCHEMA_VERSION,
		timestamp: new Date().toISOString(),
		passed,
		failureKind: args.failureKind ?? inferFailureKind(args.expected, args.actual, passed, args.suite),
	};
}

export function inferFailureKind(expected: LiveEvalExpected, actual: LiveEvalActual, passed: boolean, suite: LiveEvalSuite): LiveEvalFailureKind | undefined {
	if (passed) return undefined;
	if (expected === "deny" && actual === "allow") return "false_allow";
	if (expected === "allow" && actual === "deny") return "false_deny";
	if (actual === "error") return suite === "digest" ? "digest_error" : "reviewer_error";
	return "assertion_failure";
}

export function defaultFailureSeverity(expected: LiveEvalExpected, actual: LiveEvalActual, riskLevel?: string): LiveEvalFailureSeverity | undefined {
	if (expected === "deny" && actual === "allow") return riskLevel === "low" ? "calibration" : "safety";
	if (expected === "allow" && actual === "deny") return "productivity";
	if (actual === "error") return "calibration";
	return undefined;
}

export function recordLiveEvalAttempt(attempt: LiveEvalAttempt): void {
	const file = process.env.PI_AUTO_LIVE_RESULTS_FILE;
	if (!file) return;
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(attempt)}\n`, { flag: "a" });
}

export function readLiveEvalAttempts(file: string): LiveEvalAttempt[] {
	if (!existsSync(file)) return [];
	const text = readFileSync(file, "utf8");
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line, index) => {
			try {
				return JSON.parse(line) as LiveEvalAttempt;
			} catch (err) {
				throw new Error(`Invalid JSONL at ${file}:${index + 1}: ${err instanceof Error ? err.message : String(err)}`);
			}
		});
}

export function summarizeLiveEvalAttempts(attempts: LiveEvalAttempt[], source?: string): LiveEvalSummary {
	const scenarioMap = new Map<string, LiveEvalScenarioSummary>();
	const tagMap = new Map<string, LiveEvalTagSummary>();
	const suiteMap: Record<string, Omit<LiveEvalTagSummary, "tag">> = {};
	const suiteLabels = new Set<string>();
	const iterations = new Set<number>();
	let provider: string | undefined;
	let model: string | undefined;
	let totalLatency = 0;
	let latencyCalls = 0;

	const totals = {
		attempts: 0,
		passes: 0,
		failures: 0,
		falseAllows: 0,
		falseDenies: 0,
		assertionFailures: 0,
		errors: 0,
		highCriticalFalseAllows: 0,
		costUsd: 0,
		totalTokens: 0,
		avgLatencyMs: 0,
	};

	for (const attempt of attempts) {
		provider ??= attempt.provider;
		model ??= attempt.model;
		suiteLabels.add(attempt.suiteLabel);
		iterations.add(attempt.iterations);
		totals.attempts += 1;
		if (attempt.passed) totals.passes += 1;
		else totals.failures += 1;
		const isFalseAllow = attempt.failureKind === "false_allow";
		const isFalseDeny = attempt.failureKind === "false_deny";
		const isAssertion = attempt.failureKind === "assertion_failure";
		const isError = attempt.failureKind === "reviewer_error" || attempt.failureKind === "digest_error";
		const isHighCriticalFalseAllow = isFalseAllow && (attempt.riskLevel === "high" || attempt.riskLevel === "critical");
		if (isFalseAllow) totals.falseAllows += 1;
		if (isFalseDeny) totals.falseDenies += 1;
		if (isAssertion) totals.assertionFailures += 1;
		if (isError) totals.errors += 1;
		if (isHighCriticalFalseAllow) totals.highCriticalFalseAllows += 1;
		totals.costUsd += attempt.usage?.costUsd ?? 0;
		totals.totalTokens += attempt.usage?.totalTokens ?? 0;
		if (typeof attempt.latencyMs === "number" && attempt.latencyMs > 0) {
			totalLatency += attempt.latencyMs;
			latencyCalls += 1;
		}

		const key = `${attempt.suite}\u0000${attempt.scenarioName}`;
		let scenario = scenarioMap.get(key);
		if (!scenario) {
			scenario = {
				name: attempt.scenarioName,
				suite: attempt.suite,
				tags: [],
				expected: {},
				actual: {},
				calls: 0,
				passes: 0,
				failures: 0,
				falseAllows: 0,
				falseDenies: 0,
				assertionFailures: 0,
				errors: 0,
				highCriticalFalseAllows: 0,
				costUsd: 0,
				totalTokens: 0,
				avgLatencyMs: 0,
				riskLevels: {},
				userAuthorizations: {},
				failureKinds: {},
				rationales: [],
			};
			scenarioMap.set(key, scenario);
		}
		const attemptTags = uniqueTags(attempt.tags ?? []);
		for (const tag of attemptTags) {
			if (!scenario.tags.includes(tag)) scenario.tags.push(tag);
		}
		scenario.calls += 1;
		if (attempt.passed) scenario.passes += 1;
		else scenario.failures += 1;
		if (isFalseAllow) scenario.falseAllows += 1;
		if (isFalseDeny) scenario.falseDenies += 1;
		if (isAssertion) scenario.assertionFailures += 1;
		if (isError) scenario.errors += 1;
		if (isHighCriticalFalseAllow) scenario.highCriticalFalseAllows += 1;
		scenario.costUsd += attempt.usage?.costUsd ?? 0;
		scenario.totalTokens += attempt.usage?.totalTokens ?? 0;
		if (typeof attempt.latencyMs === "number" && attempt.latencyMs > 0) {
			scenario.avgLatencyMs += attempt.latencyMs;
		}
		increment(scenario.expected, attempt.expected);
		increment(scenario.actual, attempt.actual);
		if (attempt.riskLevel) increment(scenario.riskLevels, attempt.riskLevel);
		if (attempt.userAuthorization) increment(scenario.userAuthorizations, attempt.userAuthorization);
		if (attempt.failureKind) increment(scenario.failureKinds, attempt.failureKind);
		if (!attempt.passed && attempt.rationale && !scenario.rationales.includes(attempt.rationale)) {
			scenario.rationales.push(attempt.rationale);
		}

		const suite = suiteMap[attempt.suite] ?? {
			calls: 0,
			passes: 0,
			failures: 0,
			falseAllows: 0,
			falseDenies: 0,
			highCriticalFalseAllows: 0,
		};
		suite.calls += 1;
		if (attempt.passed) suite.passes += 1;
		else suite.failures += 1;
		if (isFalseAllow) suite.falseAllows += 1;
		if (isFalseDeny) suite.falseDenies += 1;
		if (isHighCriticalFalseAllow) suite.highCriticalFalseAllows += 1;
		suiteMap[attempt.suite] = suite;

		for (const tag of uniqueTags(attempt.tags && attempt.tags.length > 0 ? attempt.tags : ["untagged"])) {
			let tagSummary = tagMap.get(tag);
			if (!tagSummary) {
				tagSummary = { tag, calls: 0, passes: 0, failures: 0, falseAllows: 0, falseDenies: 0, highCriticalFalseAllows: 0 };
				tagMap.set(tag, tagSummary);
			}
			tagSummary.calls += 1;
			if (attempt.passed) tagSummary.passes += 1;
			else tagSummary.failures += 1;
			if (isFalseAllow) tagSummary.falseAllows += 1;
			if (isFalseDeny) tagSummary.falseDenies += 1;
			if (isHighCriticalFalseAllow) tagSummary.highCriticalFalseAllows += 1;
		}
	}

	for (const scenario of scenarioMap.values()) {
		scenario.tags.sort();
		scenario.rationales = scenario.rationales.slice(0, 10);
		const latencyAttempts = attempts.filter((a) => a.suite === scenario.suite && a.scenarioName === scenario.name && typeof a.latencyMs === "number" && a.latencyMs > 0);
		scenario.avgLatencyMs = latencyAttempts.length > 0
			? Math.round(latencyAttempts.reduce((sum, a) => sum + (a.latencyMs ?? 0), 0) / latencyAttempts.length)
			: 0;
	}

	totals.avgLatencyMs = latencyCalls > 0 ? Math.round(totalLatency / latencyCalls) : 0;

	return {
		schemaVersion: LIVE_EVAL_SCHEMA_VERSION,
		generatedAt: new Date().toISOString(),
		source,
		run: {
			provider,
			model,
			suiteLabels: [...suiteLabels].sort(),
			iterations: [...iterations].sort((a, b) => a - b),
		},
		totals,
		bySuite: suiteMap,
		byTag: [...tagMap.values()].sort((a, b) => b.failures - a.failures || a.tag.localeCompare(b.tag)),
		scenarios: [...scenarioMap.values()].sort((a, b) => b.failures - a.failures || a.name.localeCompare(b.name)),
		failedAttempts: attempts
			.filter((a) => !a.passed)
			.map((a) => ({
				suite: a.suite,
				scenarioName: a.scenarioName,
				iteration: a.iteration,
				expected: a.expected,
				actual: a.actual,
				failureKind: a.failureKind,
				riskLevel: a.riskLevel,
				userAuthorization: a.userAuthorization,
				rationale: a.rationale,
				error: a.error,
			})),
	};
}

export function summarizeLiveEvalFile(attemptsFile: string): LiveEvalSummary {
	return summarizeLiveEvalAttempts(readLiveEvalAttempts(attemptsFile), attemptsFile);
}

export function writeLiveEvalSummaryFiles(attemptsFile: string, outDir = dirname(attemptsFile)): LiveEvalSummary {
	const summary = summarizeLiveEvalFile(attemptsFile);
	mkdirSync(outDir, { recursive: true });
	writeFileSync(join(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
	writeFileSync(join(outDir, "summary.md"), renderLiveEvalSummaryMarkdown(summary));
	return summary;
}

export function renderLiveEvalSummaryMarkdown(summary: LiveEvalSummary): string {
	const lines: string[] = [];
	lines.push("# pi-auto live eval summary");
	lines.push("");
	lines.push(`Generated: ${summary.generatedAt}`);
	if (summary.source) lines.push(`Source: \`${summary.source}\``);
	lines.push("");
	lines.push("## Totals");
	lines.push("");
	lines.push("| Metric | Value |");
	lines.push("|---|---:|");
	lines.push(`| Attempts | ${summary.totals.attempts} |`);
	lines.push(`| Passes | ${summary.totals.passes} |`);
	lines.push(`| Failures | ${summary.totals.failures} |`);
	lines.push(`| False allows | ${summary.totals.falseAllows} |`);
	lines.push(`| False denies | ${summary.totals.falseDenies} |`);
	lines.push(`| High/critical false allows | ${summary.totals.highCriticalFalseAllows} |`);
	lines.push(`| Errors | ${summary.totals.errors} |`);
	lines.push(`| Cost | $${summary.totals.costUsd.toFixed(4)} |`);
	lines.push(`| Avg latency | ${summary.totals.avgLatencyMs} ms |`);
	lines.push("");
	if (summary.byTag.length > 0) {
		lines.push("## Tags");
		lines.push("");
		lines.push("| Tag | Pass | Fail | False allow | False deny | High/critical false allow |");
		lines.push("|---|---:|---:|---:|---:|---:|");
		for (const tag of summary.byTag) {
			lines.push(`| ${escapeMd(tag.tag)} | ${tag.passes}/${tag.calls} | ${tag.failures} | ${tag.falseAllows} | ${tag.falseDenies} | ${tag.highCriticalFalseAllows} |`);
		}
		lines.push("");
	}
	const failed = summary.scenarios.filter((s) => s.failures > 0);
	if (failed.length > 0) {
		lines.push("## Failed scenarios");
		lines.push("");
		lines.push("| Scenario | Suite | Pass | False allow | False deny | Risk | Auth |");
		lines.push("|---|---|---:|---:|---:|---|---|");
		for (const scenario of failed) {
			lines.push(`| ${escapeMd(scenario.name)} | ${scenario.suite} | ${scenario.passes}/${scenario.calls} | ${scenario.falseAllows} | ${scenario.falseDenies} | ${fmtCounts(scenario.riskLevels)} | ${fmtCounts(scenario.userAuthorizations)} |`);
		}
		lines.push("");
	}
	return `${lines.join("\n")}\n`;
}

function uniqueTags(tags: string[]): string[] {
	return [...new Set(tags.filter(Boolean))];
}

function increment(map: Record<string, number>, key: string): void {
	map[key] = (map[key] ?? 0) + 1;
}

function fmtCounts(counts: Record<string, number>): string {
	return Object.entries(counts)
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([k, v]) => `${k}:${v}`)
		.join(", ");
}

function escapeMd(s: string): string {
	return s.replaceAll("|", "\\|");
}
