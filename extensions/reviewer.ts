import { createHash, randomUUID } from "node:crypto";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildReviewerContext } from "./context.ts";
import { buildReviewerSystemPrompt, reduceAssessment } from "./policy.ts";
import { constrainAssessmentPayload, describeValidation, validateAssessment } from "./review-response.ts";
import { protectedWritePaths } from "./scope.ts";
import type { AssessmentValidationIssue, ReviewableAction, ReviewAttemptDiagnostic, ReviewDiagnostics, ReviewFailureCode, ReviewResult, Settings } from "./types.ts";

export { parseAssessment } from "./review-response.ts";

class ReviewFailure extends Error {
	constructor(readonly code: ReviewFailureCode, message: string) { super(message); }
}

export async function reviewAction(
	action: ReviewableAction,
	ctx: ExtensionContext,
	settings: Settings,
	signal?: AbortSignal,
): Promise<ReviewResult> {
	const start = Date.now();
	const controller = new AbortController();
	const diagnostics: ReviewDiagnostics = {
		id: randomUUID(), provider: settings.reviewer.provider, model: settings.reviewer.model,
		reasoning: settings.reviewer.reasoning, format: "prompt", attempts: [],
	};
	let timedOut = false;
	let attemptStart = start;
	let rejectAbort: (error: Error) => void = () => {};
	const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
	const abort = (): void => {
		controller.abort();
		rejectAbort(new ReviewFailure(timedOut ? "timeout" : "cancelled", timedOut ? `Reviewer timed out after ${settings.reviewer.timeoutMs}ms (shared across both attempts).` : "Reviewer cancelled."));
	};
	const timeout = setTimeout(() => { timedOut = true; abort(); }, settings.reviewer.timeoutMs);
	const parentSignals = [...new Set([signal, ctx.signal].filter((value): value is AbortSignal => Boolean(value)))];
	for (const parent of parentSignals) parent.addEventListener("abort", abort, { once: true });
	if (parentSignals.some((parent) => parent.aborted)) abort();
	try {
		return await Promise.race([aborted, assess()]);
	} catch (error) {
		const failureCode = error instanceof ReviewFailure ? error.code : "provider_error";
		diagnostics.failure = failureCode;
		const last = diagnostics.attempts.at(-1);
		if (last && !last.error) { last.error = failureCode; last.latencyMs = Date.now() - attemptStart; }
		return { kind: "failed", failureCode, reason: error instanceof Error ? error.message : String(error), latencyMs: Date.now() - start, diagnostics: structuredClone(diagnostics) };
	} finally {
		clearTimeout(timeout);
		for (const parent of parentSignals) parent.removeEventListener("abort", abort);
	}

	async function assess(): Promise<ReviewResult> {
		if (controller.signal.aborted) throw new ReviewFailure("cancelled", "Reviewer cancelled.");
		const { provider, model: modelId } = settings.reviewer;
		if (!provider.trim() || !modelId.trim()) throw new ReviewFailure("model_unavailable", "Configure a dedicated reviewer provider and model; session-model fallback is disabled.");
		const model = ctx.modelRegistry.find(provider, modelId);
		if (!model) throw new ReviewFailure("model_unavailable", `Reviewer model ${provider}/${modelId} is unavailable.`);
		diagnostics.api = model.api;
		let auth: Awaited<ReturnType<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>>;
		try { auth = await ctx.modelRegistry.getApiKeyAndHeaders(model); }
		catch { throw new ReviewFailure("auth_error", `Reviewer credentials could not be resolved for ${provider}/${modelId}.`); }
		if (!auth.ok) throw new ReviewFailure("auth_error", `Reviewer authentication failed: ${auth.error}`);
		if (!auth.apiKey) throw new ReviewFailure("auth_error", `No reviewer credentials for ${model.provider}/${model.id}.`);
		if (controller.signal.aborted) throw new ReviewFailure("cancelled", "Reviewer cancelled.");
		const context = buildReviewerContext(ctx.sessionManager.getBranch(), action, settings.context);
		const projectInstructions = extractProjectInstructions(ctx.getSystemPrompt?.() ?? "");
		const prompt = {
			action, context, projectInstructions,
			ownerConstraints: {
				protectedWritePaths: protectedWritePaths(action.cwd, settings), sensitivePaths: settings.sensitivePaths,
				deniedReadPaths: settings.sandbox.denyRead, sandbox: settings.sandbox,
			},
		};
		if (JSON.stringify(action).length > 64_000 || JSON.stringify(projectInstructions).length > 64_000) throw new ReviewFailure("request_too_large", "Action or project instructions exceed the review budget; split the action or shorten the instructions.");
		const requestText = JSON.stringify(prompt);
		const requestedReasoning = settings.reviewer.reasoning;
		// Compat has no explicit off option; Luna's off mapping sends API effort none.
		const reasoning = requestedReasoning !== "default" && requestedReasoning !== "off" && getSupportedThinkingLevels(model).includes(requestedReasoning) ? requestedReasoning : undefined;
		// Do not assume arbitrary OpenAI-compatible endpoints or other APIs support strict schemas.
		const openAIResponses = model.provider === "openai" && model.api === "openai-responses";
		const structured = settings.reviewer.structuredOutput !== "off" && openAIResponses;
		diagnostics.format = structured ? "json_schema" : "prompt";
		let repair: AssessmentValidationIssue | undefined;
		for (let attempt = 1; attempt <= 2; attempt++) {
			if (controller.signal.aborted) throw new ReviewFailure("cancelled", "Reviewer cancelled.");
			attemptStart = Date.now();
			const trace: ReviewAttemptDiagnostic = { attempt, latencyMs: 0, maxTokens: repair?.code === "output_truncated" ? 4096 : 2048 };
			diagnostics.attempts.push(trace);
			let refused = false;
			const response = await completeSimple(model, {
				systemPrompt: buildReviewerSystemPrompt() + (repair ? `\n\nYour previous response failed validation (${repair.code}). ${describeValidation(repair)} Return a fresh complete JSON assessment with exactly the four required fields. This is a formatting retry, not a request to change the risk or authorization judgment.` : ""),
				messages: [{ role: "user", content: [{ type: "text", text: requestText }], timestamp: start }],
			}, {
				apiKey: auth.apiKey, headers: auth.headers, signal: controller.signal,
				maxTokens: trace.maxTokens, maxRetries: 0, timeoutMs: settings.reviewer.timeoutMs,
				...(reasoning ? { reasoning } : {}),
				...(structured ? { onPayload: constrainAssessmentPayload } : {}),
				// onResponse may not run for HTTP errors. Observe only status, not
				// URLs, request bodies, headers, or response bodies, on this known API.
				...(openAIResponses ? { fetch: async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
					const response = await globalThis.fetch(input, init);
					if (response.status >= 100 && response.status <= 599) trace.httpStatus = response.status;
					return response;
				} } : {}),
				onResponse: (response) => { if (response.status >= 100 && response.status <= 599) trace.httpStatus = response.status; },
				onProviderStreamEvent: (event) => {
					if (event && typeof event === "object" && "type" in event && (event.type === "response.refusal.delta" || event.type === "response.refusal.done")) refused = true;
				},
			});
			if (controller.signal.aborted) throw new ReviewFailure(timedOut ? "timeout" : "cancelled", "Reviewer cancelled.");
			trace.latencyMs = Date.now() - attemptStart;
			trace.stopReason = ["stop", "length", "toolUse", "error", "aborted"].includes(response.stopReason) ? response.stopReason as ReviewAttemptDiagnostic["stopReason"] : "unknown";
			trace.contentTypes = [...new Set(response.content.map((part) => ["text", "thinking", "toolCall"].includes(part.type) ? part.type as "text" | "thinking" | "toolCall" : "other" as const))];
			const text = response.content.filter((part) => part.type === "text").map((part) => part.text).join("");
			trace.textChars = text.length;
			trace.responseHash = createHash("sha256").update(text).digest("hex");
			if (refused) throw new ReviewFailure("provider_refusal", "The reviewer provider refused to produce an assessment.");
			if (response.stopReason === "error" || response.stopReason === "aborted") throw new ReviewFailure(response.stopReason === "aborted" ? "cancelled" : "provider_error", response.errorMessage || "Reviewer provider failed.");
			const validated = response.stopReason === "length" ? { ok: false as const, issue: { code: "output_truncated" as const } } : validateAssessment(text);
			if (validated.ok) {
				return { kind: "assessed", assessment: validated.assessment, decision: reduceAssessment(validated.assessment, action, context), latencyMs: Date.now() - start, diagnostics: structuredClone(diagnostics) };
			}
			trace.error = validated.issue.code;
			trace.validation = validated.issue;
			repair = validated.issue;
		}
		throw new ReviewFailure(repair!.code, `${describeValidation(repair!)} Both reviewer attempts returned unusable assessments.`);
	}
}

/** Read constraints from the host's structured project blocks, not transcript text. */
export function extractProjectInstructions(systemPrompt: string): { path: string; text: string }[] {
	return [...systemPrompt.matchAll(/<project_instructions(?:\s+path="([^"]*)")?>([\s\S]*?)<\/project_instructions>/g)]
		.map((match) => ({ path: match[1] ?? "", text: (match[2] ?? "").trim() }))
		.filter((entry) => Boolean(entry.text));
}
