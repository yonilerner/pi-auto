import { completeSimple } from "@earendil-works/pi-ai/compat";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildReviewerContext } from "./context.ts";
import { buildReviewerSystemPrompt, reduceAssessment } from "./policy.ts";
import { protectedWritePaths } from "./scope.ts";
import type { ReviewableAction, ReviewerAssessment, ReviewResult, Settings } from "./types.ts";

/** Strict parsing: no inferred scores, partial JSON, or model-owned outcome. */
export function parseAssessment(text: string): ReviewerAssessment | undefined {
	let raw: unknown;
	try { raw = JSON.parse(text.trim().replace(/^```json\s*([\s\S]*?)\s*```$/i, "$1")); } catch { return undefined; }
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const value = raw as Record<string, unknown>;
	const keys = Object.keys(value).sort().join(",");
	if (keys !== "evidence,rationale,risk_level,user_authorization") return undefined;
	if (typeof value.risk_level !== "string" || !["low", "medium", "high", "critical"].includes(value.risk_level)) return undefined;
	if (typeof value.user_authorization !== "string" || !["high", "medium", "low", "unknown"].includes(value.user_authorization)) return undefined;
	if (!Array.isArray(value.evidence) || value.evidence.length > 32 || !value.evidence.every((id) => typeof id === "string" && id.trim() && id.length <= 128)) return undefined;
	if (typeof value.rationale !== "string" || !value.rationale.trim() || value.rationale.length > 2000) return undefined;
	return { risk_level: value.risk_level as ReviewerAssessment["risk_level"], user_authorization: value.user_authorization as ReviewerAssessment["user_authorization"], evidence: value.evidence, rationale: value.rationale.trim() };
}

export async function reviewAction(
	action: ReviewableAction,
	ctx: ExtensionContext,
	settings: Settings,
	signal?: AbortSignal,
): Promise<ReviewResult> {
	const start = Date.now();
	const controller = new AbortController();
	let timedOut = false;
	let rejectAbort: (error: Error) => void = () => {};
	const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
	const abort = (): void => { controller.abort(); rejectAbort(new Error(timedOut ? `Reviewer timed out after ${settings.reviewer.timeoutMs}ms.` : "Reviewer cancelled.")); };
	const timeout = setTimeout(() => { timedOut = true; abort(); }, settings.reviewer.timeoutMs);
	const parentSignals = [...new Set([signal, ctx.signal].filter((value): value is AbortSignal => Boolean(value)))];
	for (const parent of parentSignals) parent.addEventListener("abort", abort, { once: true });
	if (parentSignals.some((parent) => parent.aborted)) abort();
	try {
		return await Promise.race([aborted, assess()]);
	} catch (error) {
		return { kind: "failed", reason: error instanceof Error ? error.message : String(error), latencyMs: Date.now() - start };
	} finally {
		clearTimeout(timeout);
		for (const parent of parentSignals) parent.removeEventListener("abort", abort);
	}

	async function assess(): Promise<ReviewResult> {
		if (controller.signal.aborted) throw new Error("Reviewer cancelled.");
		const { provider, model: modelId } = settings.reviewer;
		if (!provider.trim() || !modelId.trim()) throw new Error("Configure a dedicated reviewer provider and model; session-model fallback is disabled.");
		const model = ctx.modelRegistry.find(provider, modelId);
		if (!model) throw new Error(`Reviewer model ${provider}/${modelId} is unavailable.`);
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) throw new Error(`Reviewer authentication failed: ${auth.error}`);
		if (!auth.apiKey) throw new Error(`No reviewer credentials for ${model.provider}/${model.id}.`);
		if (controller.signal.aborted) throw new Error("Reviewer cancelled.");
		const context = buildReviewerContext(ctx.sessionManager.getBranch(), action, settings.context);
		const projectInstructions = extractProjectInstructions(ctx.getSystemPrompt?.() ?? "");
		const prompt = {
			action,
			context,
			projectInstructions,
			ownerConstraints: {
				protectedWritePaths: protectedWritePaths(action.cwd, settings),
				sensitivePaths: settings.sensitivePaths,
				deniedReadPaths: settings.sandbox.denyRead,
				sandbox: settings.sandbox,
			},
		};
		// Large opaque actions cannot safely be approved after dropping their tail.
		if (JSON.stringify(action).length > 64_000 || JSON.stringify(projectInstructions).length > 64_000) throw new Error("Action or project instructions exceed the review budget; split the action or shorten the instructions.");
		const requestedReasoning = settings.reviewer.reasoning;
		// The compat API has no explicit "off" option. Its OpenAI adapter uses
		// the model's off mapping when omitted (Luna: API effort "none").
		// A mocked-transport regression test pins the actual outgoing payload.
		const reasoning = requestedReasoning !== "default" && requestedReasoning !== "off" && getSupportedThinkingLevels(model).includes(requestedReasoning) ? requestedReasoning : undefined;
		const response = await completeSimple(model, {
			systemPrompt: buildReviewerSystemPrompt(),
			messages: [{ role: "user", content: [{ type: "text", text: JSON.stringify(prompt) }], timestamp: Date.now() }],
		}, {
			apiKey: auth.apiKey,
			headers: auth.headers,
			signal: controller.signal,
			maxTokens: 2048,
			...(reasoning ? { reasoning } : {}),
		});
		if (controller.signal.aborted) throw new Error(timedOut ? `Reviewer timed out after ${settings.reviewer.timeoutMs}ms.` : "Reviewer cancelled.");
		if (response.stopReason === "error" || response.stopReason === "aborted") throw new Error(response.errorMessage || "Reviewer provider failed.");
		const text = response.content.filter((part) => part.type === "text").map((part) => part.text).join("");
		const assessment = parseAssessment(text);
		if (!assessment) throw new Error("Reviewer returned an invalid or incomplete assessment.");
		const decision = reduceAssessment(assessment, action, context);
		return { kind: "assessed", assessment, decision, latencyMs: Date.now() - start };
	}
}

/** Read constraints from the host's structured project blocks, not transcript text. */
export function extractProjectInstructions(systemPrompt: string): { path: string; text: string }[] {
	return [...systemPrompt.matchAll(/<project_instructions(?:\s+path="([^"]*)")?>([\s\S]*?)<\/project_instructions>/g)]
		.map((match) => ({ path: match[1] ?? "", text: (match[2] ?? "").trim() }))
		.filter((entry) => Boolean(entry.text));
}
