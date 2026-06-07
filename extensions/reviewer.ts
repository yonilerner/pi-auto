/**
 * The reviewer: makes a model call, parses the structured assessment,
 * fail-closes on any error.
 */

import { completeSimple, parseJsonWithRepair, parseStreamingJson } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getLatestDigest } from "./digest.ts";
import { buildReviewerSystemPrompt } from "./policy.ts";
import { buildTranscript } from "./transcript.ts";
import type { PiAutoSettings, ReviewableAction, ReviewerAssessment } from "./types.ts";

export type ReviewResult =
	| { kind: "assessed"; assessment: ReviewerAssessment }
	| { kind: "failed"; reason: string };

export async function reviewAction(
	action: ReviewableAction,
	ctx: ExtensionContext,
	settings: PiAutoSettings,
): Promise<ReviewResult> {
	const model =
		ctx.modelRegistry.find(settings.reviewerProvider, settings.reviewerModel) ??
		(settings.fallbackToActiveModel ? ctx.model : undefined);

	if (!model) {
		return {
			kind: "failed",
			reason: `Reviewer model ${settings.reviewerProvider}/${settings.reviewerModel} not found and no fallback model available`,
		};
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		return { kind: "failed", reason: `Reviewer auth failed: ${auth.error}` };
	}
	if (!auth.apiKey) {
		return { kind: "failed", reason: `No API key for reviewer model ${model.provider}/${model.id}` };
	}

	const digestState = getLatestDigest(ctx.sessionManager);
	const transcript = buildTranscript({
		sessionManager: ctx.sessionManager,
		settings,
		action,
		digest: digestState?.digest,
	});

	const userPrompt = [
		"# Transcript",
		transcript,
		"",
		"# Planned Action",
		`Tool: ${action.toolName}`,
		`Action payload:`,
		"```json",
		safeJson(action.payload),
		"```",
		"",
		"Score this action's risk_level and user_authorization, then derive the outcome. Reply ONLY with the JSON object specified in the output contract.",
	].join("\n");

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), settings.reviewerTimeoutMs);
	// Compose abort signals: parent ctx.signal OR our timeout.
	const parentAbort = () => controller.abort();
	if (ctx.signal) ctx.signal.addEventListener("abort", parentAbort, { once: true });

	try {
		const response = await completeSimple(
			model,
			{
				systemPrompt: buildReviewerSystemPrompt(settings.customPolicy),
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: userPrompt }],
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				signal: controller.signal,
				maxTokens: 4096,
				reasoning: "minimal",
			},
		);

		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("")
			.trim();

		if (!text) {
			return { kind: "failed", reason: "Reviewer returned empty response" };
		}

		const parsed = parseAssessment(text);
		if (!parsed) {
			return { kind: "failed", reason: `Reviewer returned unparseable response: ${truncate(text, 200)}` };
		}
		return { kind: "assessed", assessment: parsed };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		const aborted = controller.signal.aborted;
		return {
			kind: "failed",
			reason: aborted ? `Reviewer timed out after ${settings.reviewerTimeoutMs}ms` : `Reviewer error: ${msg}`,
		};
	} finally {
		clearTimeout(timeoutId);
		if (ctx.signal) ctx.signal.removeEventListener("abort", parentAbort);
	}
}

export function parseAssessment(text: string): ReviewerAssessment | undefined {
	// Try to extract just the JSON object — models sometimes wrap it in fences or prose.
	const jsonText = extractJsonObject(text);
	if (!jsonText) return undefined;

	let raw: unknown;
	try {
		raw = parseJsonWithRepair<unknown>(jsonText);
	} catch {
		// Strict parse failed (e.g. unterminated string before closing `}`).
		// Fall back to the lenient streaming parser, which tolerates partial JSON.
		try {
			raw = parseStreamingJson<unknown>(jsonText);
		} catch {
			return undefined;
		}
	}

	if (!raw || typeof raw !== "object") return undefined;
	const obj = raw as Record<string, unknown>;

	const risk = obj.risk_level;
	const userAuth = obj.user_authorization;
	const outcome = obj.outcome;
	const rationale = obj.rationale;

	if (!isRisk(risk)) return undefined;
	if (!isUserAuth(userAuth)) return undefined;
	if (!isOutcome(outcome)) return undefined;
	if (typeof rationale !== "string") return undefined;

	return {
		risk_level: risk,
		user_authorization: userAuth,
		outcome,
		rationale: rationale.trim(),
	};
}

export function extractJsonObject(text: string): string | undefined {
	// Strip ``` fences if present.
	const stripped = text
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```\s*$/i, "")
		.trim();
	if (stripped.startsWith("{")) return stripped;

	// Fall back: find first { ... last }
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start >= 0 && end > start) return text.slice(start, end + 1);
	return undefined;
}

function isRisk(v: unknown): v is ReviewerAssessment["risk_level"] {
	return v === "low" || v === "medium" || v === "high" || v === "critical";
}

function isUserAuth(v: unknown): v is ReviewerAssessment["user_authorization"] {
	return v === "high" || v === "medium" || v === "low" || v === "unknown";
}

function isOutcome(v: unknown): v is ReviewerAssessment["outcome"] {
	return v === "allow" || v === "deny";
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function truncate(s: string, n: number): string {
	return s.length <= n ? s : `${s.slice(0, n)}…`;
}
