import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS } from "../../extensions/settings.ts";
import type { Settings } from "../../extensions/types.ts";
import type { ReviewerScenario } from "./scenarios.ts";

export interface BenchmarkConfig {
	provider: string;
	model: string;
	reasoning: Exclude<Settings["reviewer"]["reasoning"], "default">;
	iterations: number;
	resultsParent?: string;
}

/** Never inherit the active session model, silently fall back, or use an API key. */
export function benchmarkConfig(env: NodeJS.ProcessEnv): BenchmarkConfig {
	const iterations = env.PI_AUTO_ITERATIONS ?? "1";
	if (!/^[1-9]\d*$/.test(iterations) || !Number.isSafeInteger(Number(iterations)) || Number(iterations) > 100) throw new Error("PI_AUTO_ITERATIONS must be an integer from 1 to 100.");
	const reasoning = env.PI_AUTO_REVIEWER_REASONING ?? "low";
	if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(reasoning)) throw new Error("PI_AUTO_REVIEWER_REASONING must be an explicit supported level (off/minimal/low/medium/high/xhigh/max).");
	const provider = env.PI_AUTO_REVIEWER_PROVIDER ?? "openai";
	const model = env.PI_AUTO_REVIEWER_MODEL ?? "gpt-6-luna";
	if (!provider.trim() || !model.trim()) throw new Error("Benchmark provider and model must be nonempty.");
	return { provider, model, reasoning: reasoning as BenchmarkConfig["reasoning"], iterations: Number(iterations), resultsParent: env.PI_AUTO_LIVE_RESULTS_DIR };
}

/** ModelRegistry delegates login refresh to the installed SDK; credentials never enter reports. */
export async function createBenchmarkRegistry(config: BenchmarkConfig): Promise<ModelRegistry> {
	const runtime = await ModelRuntime.create({ allowModelNetwork: false });
	const registry = new ModelRegistry(runtime);
	assertBenchmarkModel(registry, config);
	return registry;
}

export function assertBenchmarkModel(registry: Pick<ModelRegistry, "find" | "isUsingOAuth">, config: BenchmarkConfig): void {
	const model = registry.find(config.provider, config.model);
	if (!model) throw new Error(`Benchmark model ${config.provider}/${config.model} is unavailable; no fallback is permitted.`);
	if (!registry.isUsingOAuth(model)) throw new Error(`Benchmark requires your existing ${config.provider} OAuth login. Run /login ${config.provider} in Pi; API-key fallback is disabled.`);
	if (!getSupportedThinkingLevels(model).includes(config.reasoning)) throw new Error(`Benchmark model does not support requested reasoning ${config.reasoning}; refusing to silently omit it.`);
}

export function benchmarkSettings(config: BenchmarkConfig): Settings {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.reviewer = { provider: config.provider, model: config.model, reasoning: config.reasoning, timeoutMs: 60_000 };
	return settings;
}

/** Only reviewer dependencies exist: no executors, UI approval, real history, or tool registration. */
export function benchmarkContext(scenario: ReviewerScenario, registry: ModelRegistry): ExtensionContext {
	return {
		cwd: scenario.action.cwd,
		modelRegistry: registry,
		sessionManager: { getBranch: () => scenario.branch },
		getSystemPrompt: () => scenario.projectInstructions ? `<project_instructions path="/home/benchmark/project/AGENTS.md">${scenario.projectInstructions}</project_instructions>` : "",
	} as unknown as ExtensionContext;
}
