import type { ExtensionContext, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { CircuitBreaker } from "../circuit-breaker.ts";
import type { ReviewResult } from "../reviewer.ts";
import type { PiAutoSettings, ReviewableAction, ReviewerAssessment } from "../types.ts";
import { shouldNotify } from "./status-presentation.ts";

const RISK_GLYPH: Record<ReviewerAssessment["risk_level"], string> = {
	low: "·",
	medium: "○",
	high: "△",
	critical: "✕",
};

/** Apply a reviewer result, including fail-closed fallback and per-turn limits. */
export async function handleReviewResult(
	result: ReviewResult,
	action: ReviewableAction,
	ctx: ExtensionContext,
	breaker: CircuitBreaker,
	settings: PiAutoSettings,
	turnId: string,
): Promise<ToolCallEventResult | undefined> {
	if (result.kind === "failed") return fallbackToUser(action, result.reason, ctx);
	const { assessment } = result;
	if (assessment.outcome === "allow") {
		breaker.recordNonDenial(turnId);
		if (shouldNotify(settings.noticeLevel, "normal") && ctx.hasUI) {
			ctx.ui.notify(formatReviewerAllowNotice(assessment), "info");
		}
		return undefined;
	}
	const cbAction = breaker.recordDenial(turnId);
	const denyReason = formatDenyReason(action, assessment);
	if (cbAction.kind === "interrupt") {
		return handleCircuitBreaker(action, assessment, cbAction.consecutive, cbAction.total, ctx);
	}
	if (ctx.hasUI) {
		ctx.ui.notify(
			`pi-auto ✕ denied (${assessment.risk_level} risk, auth=${assessment.user_authorization}): ${assessment.rationale}`,
			"warning",
		);
	}
	return { block: true, reason: denyReason };
}

export function formatReviewerAllowNotice(assessment: ReviewerAssessment): string {
	return `pi-auto ${RISK_GLYPH[assessment.risk_level]} allowed (${assessment.risk_level} risk, auth=${assessment.user_authorization}): ${assessment.rationale}`;
}

export async function fallbackToUser(action: ReviewableAction, reason: string, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> {
	if (!ctx.hasUI) return { block: true, reason: `pi-auto reviewer unavailable and no UI for fallback: ${reason}` };
	const choice = await ctx.ui.select([
		`pi-auto reviewer unavailable: ${reason}`,
		"",
		`Tool call: ${action.label}`,
		"",
		"Approve this tool call?",
	].join("\n"), ["Yes, run it", "No, block"]);
	return choice === "Yes, run it" ? undefined : { block: true, reason: "User declined after reviewer fallback" };
}

export async function handleCircuitBreaker(
	action: ReviewableAction,
	assessment: ReviewerAssessment,
	consecutive: number,
	total: number,
	ctx: ExtensionContext,
): Promise<ToolCallEventResult> {
	const summary = [
		"pi-auto circuit breaker tripped.",
		`Consecutive denials this turn: ${consecutive}, total: ${total}.`,
		"",
		`Latest action:    ${action.label}`,
		`Latest rationale: ${assessment.rationale}`,
		`Risk:             ${assessment.risk_level}, authorization: ${assessment.user_authorization}`,
	].join("\n");
	if (!ctx.hasUI) {
		ctx.abort();
		return { block: true, reason: summary };
	}
	const choice = await ctx.ui.select(`${summary}\n\nWhat do you want to do?`, ["Stop this turn", "Approve this one action and continue"]);
	if (choice === "Approve this one action and continue") return undefined as unknown as ToolCallEventResult;
	ctx.abort();
	return { block: true, reason: summary };
}

function formatDenyReason(action: ReviewableAction, assessment: ReviewerAssessment): string {
	return [
		"pi-auto blocked this tool call.",
		`Action:        ${action.label}`,
		`Risk:          ${assessment.risk_level}`,
		`Authorization: ${assessment.user_authorization}`,
		`Reason:        ${assessment.rationale}`,
		"",
		"Do not pursue the same outcome via workaround or indirect execution. Either find a materially safer alternative, or stop and ask the user.",
	].join("\n");
}
