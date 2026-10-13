/**
 * Reviewer model resolution.
 *
 * Returns the model + auth pair we should use for review calls. Two paths:
 *
 *  1. `useCodexAutoReview = true`: build a synthetic `Model<>` for OpenAI's
 *     hidden `codex-auto-review` slug, and borrow the OpenAI API key from any
 *     OpenAI model already in pi's registry. This is the same model Codex uses
 *     internally for its Auto-review feature — fine-tuned GPT-5.4 Thinking.
 *
 *  2. Default path: look up `reviewerProvider`/`reviewerModel` in pi's registry
 *     and fall back to the active session model if not found.
 */

import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PiAutoSettings } from "./types.ts";

export type ReviewerAuthShape = {
	model: Model<"openai-responses">;
	apiKey: string;
	headers?: Record<string, string>;
	source: "codex-auto-review" | "configured" | "active-fallback";
};

/**
 * Synthetic model definition for OpenAI's hidden `codex-auto-review` slug.
 * Mirrors the shape of other `openai-responses` entries in pi-ai's catalog;
 * pricing is set to 0 because OpenAI doesn't publish a public price for this
 * model and the user is on their own org's bill anyway.
 */
function buildCodexAutoReviewModel(): Model<"openai-responses"> {
	return {
		id: "codex-auto-review",
		name: "Codex Auto Review",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		thinkingLevelMap: { off: "none", xhigh: "xhigh" },
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400_000,
		maxTokens: 128_000,
	};
}

export async function resolveReviewerModel(
	ctx: ExtensionContext,
	settings: PiAutoSettings,
): Promise<ReviewerAuthShape | { error: string }> {
	if (settings.useCodexAutoReview) {
		// Find any OpenAI model in the registry to borrow auth from.
		const openaiAuthSource =
			ctx.modelRegistry.find("openai", "gpt-5.4-mini") ??
			ctx.modelRegistry.find("openai", "gpt-5-mini") ??
			ctx.modelRegistry.find("openai", "gpt-5") ??
			ctx.modelRegistry.find("openai", "gpt-4.1-mini");
		if (!openaiAuthSource) {
			return {
				error: "useCodexAutoReview is on but no OpenAI model is configured in pi to borrow an API key from.",
			};
		}
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(openaiAuthSource);
		if (!auth.ok) return { error: `Cannot resolve OpenAI auth: ${auth.error}` };
		if (!auth.apiKey)
			return {
				error: "useCodexAutoReview is on but OpenAI auth resolved with no API key (ChatGPT-only login may not work here; an API key is required).",
			};
		return {
			model: buildCodexAutoReviewModel(),
			apiKey: auth.apiKey,
			headers: auth.headers,
			source: "codex-auto-review",
		};
	}

	const configured = ctx.modelRegistry.find(settings.reviewerProvider, settings.reviewerModel);
	const model =
		configured ?? (settings.fallbackToActiveModel ? (ctx.model as Model<"openai-responses"> | undefined) : undefined);
	if (!model) {
		return {
			error: `Reviewer model ${settings.reviewerProvider}/${settings.reviewerModel} not found and no fallback available.`,
		};
	}
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) return { error: `Reviewer auth failed: ${auth.error}` };
	if (!auth.apiKey) return { error: `No API key for reviewer model ${model.provider}/${model.id}` };
	return {
		model: model as Model<"openai-responses">,
		apiKey: auth.apiKey,
		headers: auth.headers,
		source: configured ? "configured" : "active-fallback",
	};
}
