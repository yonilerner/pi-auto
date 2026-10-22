import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildReviewerSystemPrompt } from "../../extensions/policy.ts";
import { reviewAction } from "../../extensions/reviewer.ts";
import { benchmarkConfig, benchmarkContext, benchmarkSettings, createBenchmarkRegistry } from "./harness.ts";
import { buildBenchmarkReport, formatBenchmarkReport, recordAttempt, type BenchmarkAttempt } from "./report.ts";
import { REVIEWER_SCENARIOS } from "./scenarios.ts";

const LIVE = process.env.PI_AUTO_LIVE_TESTS === "1";
const config = benchmarkConfig(LIVE ? process.env : {});
const settings = benchmarkSettings(config);
const cases = REVIEWER_SCENARIOS.flatMap((scenario) => Array.from({ length: config.iterations }, (_, index) => ({ scenario, iteration: index + 1 })));

describe.skipIf(!LIVE)(`live reviewer ${config.provider}/${config.model} reasoning=${config.reasoning}`, () => {
	let registry: ModelRegistry;
	let directory: string | undefined;
	const attempts: BenchmarkAttempt[] = [];
	const startedAt = new Date().toISOString();

	beforeAll(async () => {
		registry = await createBenchmarkRegistry(config);
		const parent = config.resultsParent ?? tmpdir();
		mkdirSync(parent, { recursive: true });
		directory = mkdtempSync(join(parent, "pi-auto-reviewer-bench-"));
		const hash = (value: string) => createHash("sha256").update(value).digest("hex");
		writeFileSync(join(directory, "manifest.json"), JSON.stringify({
			schemaVersion: 1, startedAt,
			provider: config.provider, model: config.model, reasoning: config.reasoning, authentication: "oauth",
			api: registry.find(config.provider, config.model)!.api,
			iterations: config.iterations, testFilter: process.argv,
			settings, policyHash: hash(buildReviewerSystemPrompt()), scenarioHash: hash(JSON.stringify(REVIEWER_SCENARIOS)),
			scenarios: REVIEWER_SCENARIOS,
		}, null, 2));
		writeFileSync(join(directory, "attempts.jsonl"), "");
		process.stdout.write(`Live reviewer artifacts: ${directory}\n`);
	}, 30_000);

	afterAll(() => {
		if (!directory) return;
		const report = buildBenchmarkReport(attempts);
		const markdown = formatBenchmarkReport(report);
		writeFileSync(join(directory, "summary.json"), JSON.stringify({ schemaVersion: 1, startedAt, finishedAt: new Date().toISOString(), provider: config.provider, model: config.model, reasoning: config.reasoning, ...report }, null, 2));
		writeFileSync(join(directory, "summary.md"), markdown);
		process.stdout.write(`${markdown}\nArtifacts: ${directory}\n`);
	});

	// Sequential by design: bounded subscription usage and interpretable latency.
	for (const { scenario, iteration } of cases) {
		it(`${scenario.id} [${scenario.expected}] ${scenario.name} (iteration ${iteration}/${config.iterations})`, async () => {
			const result = await reviewAction(scenario.action, benchmarkContext(scenario, registry), settings);
			const attempt = recordAttempt(scenario, iteration, result);
			attempts.push(attempt);
			appendFileSync(join(directory!, "attempts.jsonl"), `${JSON.stringify(attempt)}\n`);
			expect(attempt.actual, `${scenario.why}\n${attempt.failure ?? "pass"}: ${attempt.reason}\n${JSON.stringify(attempt.assessment ?? {})}`).toBe(scenario.expected);
		}, 65_000);
	}
});
