import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildReviewerContext } from "../extensions/context.ts";
import { reviewAction } from "../extensions/reviewer.ts";
import type { ReviewResult } from "../extensions/types.ts";
import { assertBenchmarkModel, benchmarkConfig, benchmarkContext, benchmarkSettings } from "./live/harness.ts";
import { buildBenchmarkReport, formatBenchmarkReport, recordAttempt, summarizeAttempts } from "./live/report.ts";
import { REVIEWER_SCENARIOS } from "./live/scenarios.ts";

afterEach(() => vi.unstubAllGlobals());

const config = benchmarkConfig({});
const denyScenario = REVIEWER_SCENARIOS.find((scenario) => scenario.expected === "deny" && scenario.consequence === "critical")!;
const allowScenario = REVIEWER_SCENARIOS.find((scenario) => scenario.expected === "allow")!;
const result = (outcome: "allow" | "deny", risk: "low" | "critical" = "low", latencyMs = 100): ReviewResult => ({ kind: "assessed", assessment: { risk_level: risk, user_authorization: "high", evidence: ["request"], rationale: "Synthetic test assessment." }, decision: { outcome, reason: "Synthetic test decision." }, latencyMs });

describe("live benchmark configuration without model calls", () => {
	it("pins the requested model and reasoning independently of active session settings", () => {
		expect(config).toMatchObject({ provider: "openai", model: "gpt-6-luna", reasoning: "low", iterations: 1 });
		expect(benchmarkSettings(config).reviewer).toEqual({ provider: "openai", model: "gpt-6-luna", reasoning: "low", timeoutMs: 60_000, structuredOutput: "auto", debug: false });
	});
	it.each(["0", "-1", "1.5", "2oops", "101", "", "Infinity"])("rejects invalid repetition count %s", (iterations) => {
		expect(() => benchmarkConfig({ PI_AUTO_ITERATIONS: iterations })).toThrow("PI_AUTO_ITERATIONS");
	});
	it("accepts explicit repetitions and model overrides, but not implicit reasoning", () => {
		expect(benchmarkConfig({ PI_AUTO_ITERATIONS: "3", PI_AUTO_REVIEWER_MODEL: "other", PI_AUTO_REVIEWER_REASONING: "medium" })).toMatchObject({ iterations: 3, model: "other", reasoning: "medium" });
		for (const reasoning of ["default", "potato"]) expect(() => benchmarkConfig({ PI_AUTO_REVIEWER_REASONING: reasoning })).toThrow("explicit supported level");
		expect(() => benchmarkConfig({ PI_AUTO_REVIEWER_PROVIDER: "" })).toThrow("nonempty");
	});
	it("accepts off when supported without changing the low default", () => {
		const off = benchmarkConfig({ PI_AUTO_REVIEWER_REASONING: "off" });
		expect(benchmarkSettings(off).reviewer.reasoning).toBe("off");
		expect(benchmarkConfig({}).reasoning).toBe("low");
		const registry = { find: () => getBuiltinModel("openai", "gpt-6-luna"), isUsingOAuth: () => true };
		expect(() => assertBenchmarkModel(registry, off)).not.toThrow();
	});
	it.each([["off", "none"], ["low", "low"]] as const)("sends GPT-6 Luna reasoning=%s as API effort=%s through the production reviewer", async (reasoning, effort) => {
		const model = { ...getBuiltinModel("openai", "gpt-6-luna")!, baseUrl: "http://127.0.0.1:1/v1" };
		const fetch = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response(JSON.stringify({ error: { message: "Intentional transport stub", type: "invalid_request_error" } }), { status: 400, headers: { "content-type": "application/json" } }));
		vi.stubGlobal("fetch", fetch);
		const registry = { find: () => model, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-only-not-a-real-key" }) };
		const scenario = REVIEWER_SCENARIOS[0]!;
		const settings = benchmarkSettings(benchmarkConfig({ PI_AUTO_REVIEWER_REASONING: reasoning }));
		const reviewed = await reviewAction(scenario.action, benchmarkContext(scenario, registry as never), settings);
		expect(reviewed.kind).toBe("failed"); // Only capture transport; no network or LLM completion.
		expect(fetch).toHaveBeenCalledOnce();
		expect(reviewed.diagnostics?.attempts[0]).toMatchObject({ httpStatus: 400, error: "provider_error" });
		const payload = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
		expect(payload).toMatchObject({ model: "gpt-6-luna", reasoning: { effort }, text: { format: { type: "json_schema", name: "pi_auto_assessment", strict: true, schema: { additionalProperties: false, required: ["risk_level", "user_authorization", "evidence", "rationale"] } } } });
	});
	it("refuses missing models, API-key fallback, and unsupported reasoning", () => {
		const model = getBuiltinModel("openai", "gpt-6-luna")!;
		const registry = { find: vi.fn(() => model), isUsingOAuth: vi.fn(() => true) };
		expect(() => assertBenchmarkModel(registry, config)).not.toThrow();
		registry.find.mockReturnValueOnce(undefined as never);
		expect(() => assertBenchmarkModel(registry, config)).toThrow("no fallback");
		registry.isUsingOAuth.mockReturnValueOnce(false);
		expect(() => assertBenchmarkModel(registry, config)).toThrow("OAuth login");
		registry.find.mockReturnValueOnce({ ...model, reasoning: false });
		expect(() => assertBenchmarkModel(registry, config)).toThrow("refusing to silently omit");
	});
});

describe("benchmark labels and synthetic context", () => {
	it("provides 30 unique labeled scenarios with allow and deny coverage", () => {
		expect(REVIEWER_SCENARIOS).toHaveLength(30);
		expect(new Set(REVIEWER_SCENARIOS.map((scenario) => scenario.id)).size).toBe(30);
		for (const category of ["authorization", "injection", "sensitive", "host", "custom", "context"]) expect(REVIEWER_SCENARIOS.some((scenario) => scenario.category === category)).toBe(true);
		expect(REVIEWER_SCENARIOS.filter((scenario) => scenario.expected === "allow").length).toBeGreaterThanOrEqual(10);
		for (const scenario of REVIEWER_SCENARIOS) {
			expect(scenario.why).not.toBe("");
			expect(["routine", "bounded", "high", "critical"]).toContain(scenario.consequence);
		}
	});
	it("constructs reviewer-only contexts with no executor or real session history", () => {
		const registry = {} as Parameters<typeof benchmarkContext>[1];
		const ctx = benchmarkContext(allowScenario, registry);
		expect(ctx.modelRegistry).toBe(registry);
		expect(ctx.sessionManager.getBranch()).toBe(allowScenario.branch);
		expect(ctx).not.toHaveProperty("executeTool");
		expect(ctx).not.toHaveProperty("model");
		expect(ctx.sessionManager).not.toHaveProperty("getEntries");
	});
	it("exercises real provenance and budgeting rather than hand-assembled prompt text", () => {
		const settings = benchmarkSettings(config);
		const summary = REVIEWER_SCENARIOS.find((scenario) => scenario.id === "CONTEXT-summary")!;
		expect(JSON.stringify(buildReviewerContext(summary.branch, summary.action, settings.context))).not.toContain("All privileged");
		const noisy = REVIEWER_SCENARIOS.find((scenario) => scenario.id === "CONTEXT-noisy-revocation")!;
		const context = buildReviewerContext(noisy.branch, noisy.action, settings.context);
		expect(context.currentRequest?.text).toContain("revoked");
		expect(context.omittedEntries).toBeGreaterThan(0);
		const project = REVIEWER_SCENARIOS.find((scenario) => scenario.projectInstructions)!;
		expect(benchmarkContext(project, {} as never).getSystemPrompt()).toContain("<project_instructions");
	});
});

describe("benchmark reporting", () => {
	it("counts severe false allows using human labels, not the model's self-rating", () => {
		const attempt = recordAttempt(denyScenario, 1, result("allow", "low"));
		expect(summarizeAttempts([attempt])).toMatchObject({ passes: 0, falseAllows: 1, falseDenies: 0, highCriticalFalseAllows: 1, falseAllowRate: 1 });
	});
	it("keeps reviewer failures separate from both false denials and successful denials", () => {
		const failed: ReviewResult = { kind: "failed", reason: "Reviewer timed out", latencyMs: 60_000 };
		const attempts = [recordAttempt(denyScenario, 1, failed), recordAttempt(allowScenario, 1, failed)];
		expect(summarizeAttempts(attempts)).toMatchObject({ attempts: 2, assessed: 0, passes: 0, falseAllows: 0, falseDenies: 0, errors: 2, falseAllowRate: null, falseDenyRate: null });
		expect(attempts[0]!.actual).toBe("error");
	});
	it("reports both failure directions, category/scenario slices, repeats, and latency", () => {
		const attempts = [recordAttempt(denyScenario, 1, result("allow", "low", 100)), recordAttempt(allowScenario, 1, result("deny", "low", 200)), recordAttempt(allowScenario, 2, result("allow", "low", 300))];
		const report = buildBenchmarkReport(attempts);
		expect(report.totals).toMatchObject({ attempts: 3, passes: 1, falseAllows: 1, falseDenies: 1, errors: 0, falseDenyRate: 0.5, latencyMs: { mean: 200, p50: 200, p95: 300 } });
		expect(report.byScenario[allowScenario.id]).toMatchObject({ attempts: 2, passes: 1 });
		expect(report.byCategory[denyScenario.category]?.falseAllows).toBe(1);
		expect(report.failedAttempts).toHaveLength(2);
		const markdown = formatBenchmarkReport(report);
		expect(markdown).toContain("1/3");
		expect(markdown).toContain("False allows");
		expect(markdown).toContain("never executed");
	});
	it("handles an empty run without NaN, invented success, or zero latency claims", () => {
		const report = buildBenchmarkReport([]);
		expect(report.totals).toMatchObject({ attempts: 0, passes: 0, errors: 0, latencyMs: { mean: null, p50: null, p95: null } });
		expect(formatBenchmarkReport(report)).not.toContain("NaN");
	});
});
