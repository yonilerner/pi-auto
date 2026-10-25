import type { ReviewDebugRecord } from "./diagnostics.ts";
import type { ReviewableAction, ReviewFailureCode, ReviewResult, Settings } from "./types.ts";

/** Routine UI stays one line; exact approval arguments and explicit debug views do not. */
export function compact(text: string, limit = 100): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length <= limit ? line : `${line.slice(0, limit - 1)}…`;
}

export function formatStatus(settings: Settings, sandboxAvailable: boolean, settingsError: boolean): string {
	if (!settings.enabled) return "off · review + sandbox disabled";
	if (settingsError) return "settings error · blocked";
	return ["on", sandboxAvailable ? "sandbox" : "sandbox unavailable", compact(`${settings.reviewer.provider}/${settings.reviewer.model}`, 64), `reasoning ${settings.reviewer.reasoning}`, ...(settings.reviewer.debug ? ["debug"] : [])].join(" · ");
}

const shortId = (id: string) => `#${id.slice(0, 8)}`;
const time = (at: string) => at.slice(11, 19);

export function formatDebugSummary(record: ReviewDebugRecord): string {
	const elapsed = record.review.attempts.reduce((sum, attempt) => sum + attempt.latencyMs, 0);
	return [time(record.at), compact(record.tool, 28), record.review.failure ?? record.outcome, `${elapsed}ms`, ...(record.review.attempts.length > 1 ? [`${record.review.attempts.length} tries`] : []), shortId(record.review.id)].join(" · ");
}

interface DecisionSummary {
	at: string;
	tool: string;
	execution: string;
	outcome: string;
	source: string;
	risk?: string;
	reviewFailure?: ReviewFailureCode;
	reviewId?: string;
	reviewAttempts?: number;
	latencyMs?: number;
}
export function formatDecision(record: DecisionSummary): string {
	const detail = record.reviewFailure ?? record.risk;
	return [time(record.at), compact(record.tool, 28), record.outcome, ...(detail ? [detail] : []), ...(record.source === "user" ? ["manual"] : detail ? [] : [record.source]), ...(record.execution === "host" ? ["host"] : []), ...(record.latencyMs !== undefined ? [`${record.latencyMs}ms`] : []), ...(record.reviewAttempts !== undefined && record.reviewAttempts > 1 ? [`${record.reviewAttempts} tries`] : []), ...(record.reviewId ? [shortId(record.reviewId)] : [])].join(" · ");
}

export function failureSummary(result: ReviewResult): string {
	return result.kind === "failed" ? `review failed${result.failureCode ? ` · ${result.failureCode}` : ""} · /auto debug` : compact(result.decision.reason);
}

/** Keep all exact execution inputs and the host warning, not the whole internal review payload. */
export function formatApproval(action: ReviewableAction, result: ReviewResult): string {
	const reason = result.kind === "failed" ? `${failureSummary(result)}${result.diagnostics ? ` ${shortId(result.diagnostics.id)}` : ""}` : compact(result.decision.reason, 220);
	return [reason, ...(action.execution === "host" ? ["Full host access · no sandbox."] : []), `cwd: ${action.cwd}`, JSON.stringify(action.input, null, 2)].join("\n\n");
}
