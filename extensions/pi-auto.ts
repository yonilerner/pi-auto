/**
 * pi-auto: LLM-based tool-call auto-approval.
 *
 * Inspired by Codex's Auto-review / Guardian system. For each tool call:
 *   1. Decide whether it's in scope (see scope.ts).
 *   2. If in scope, ask a reviewer LLM to score risk_level and user_authorization
 *      and return outcome ∈ {allow, deny}.
 *   3. allow  → run the tool; optionally annotate the session.
 *      deny   → block the tool call with the reviewer's rationale, so the
 *               agent can find a safer path.
 *      failed → fall back to prompting the user (or block in non-interactive mode).
 *
 * A per-turn circuit breaker interrupts the turn after too many denials and
 * prompts the user, mirroring Codex.
 */

import type { ExtensionAPI, ExtensionContext, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { CircuitBreaker } from "./circuit-breaker.ts";
import { getLatestDigest, updateDigestForTurn } from "./digest.ts";
import { reviewAction, type ReviewResult } from "./reviewer.ts";
import { decideScope } from "./scope.ts";
import type { PiAutoSettings, ReviewableAction, ReviewerAssessment } from "./types.ts";

const DEFAULT_SETTINGS: PiAutoSettings = {
	reviewerProvider: "openai",
	reviewerModel: "gpt-5-mini",
	fallbackToActiveModel: true,
	reviewerTimeoutMs: 30_000,
	maxConsecutiveDenialsPerTurn: 3,
	maxTotalDenialsPerTurn: 10,
	maxTranscriptEntries: 40,
	maxEntryChars: 2_000,
	maxTranscriptTotalChars: 80_000,
	maxPinnedRelatedEntries: 6,
	maxSummaryEntries: 3,
	enableDigest: true,
	useCodexAutoReview: false,
	sensitivePathPatterns: [
		"~/.ssh",
		"~/.aws",
		"~/.gnupg",
		"~/.kube",
		"~/.config/gh",
		"~/.netrc",
		"~/.npmrc",
		"~/.pypirc",
		"/etc/shadow",
		"/etc/sudoers",
		"credentials",
		".env",
	],
	announceAllows: true,
	customPolicy: "",
	extraSafeCommandPrefixes: [],
	// Default to false on both: the policy already polices authorization-source
	// (assistant text doesn't count as auth, tool results don't count as auth),
	// and stripping carries a small loss of context for evidence chains like
	// `git status` -> action. See the README for the ablation comparing
	// gpt-5-mini across baseline, strip-assistant, and strip-both.
	stripAssistantText: false,
	stripToolResults: false,
};

const RISK_GLYPH: Record<ReviewerAssessment["risk_level"], string> = {
	low: "·",
	medium: "○",
	high: "△",
	critical: "✕",
};

export default function (pi: ExtensionAPI): void {
	const settings: PiAutoSettings = { ...DEFAULT_SETTINGS };
	const breaker = new CircuitBreaker(settings.maxConsecutiveDenialsPerTurn, settings.maxTotalDenialsPerTurn);

	// Track the current turn so we can scope the circuit breaker per turn.
	let currentTurnId = "boot";
	pi.on("turn_start", (event) => {
		currentTurnId = `turn-${event.turnIndex}`;
		breaker.clearTurn(currentTurnId);
	});
	pi.on("turn_end", (_event, ctx) => {
		breaker.clearTurn(currentTurnId);
		if (!settings.enableDigest) return;
		// Fire-and-forget: update the rolling digest after the turn. We do NOT
		// await this — a long summarizer call must not block the next user turn.
		// If the user kicks off a new turn before this finishes, the next
		// reviewer call sees the stale digest, which is fine.
		void updateDigestForTurn(ctx, settings, pi).catch(() => {
			/* swallow — best effort */
		});
	});

	pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | undefined> => {
		const scope = decideScope(event, ctx.cwd, settings);
		if (!scope.review) {
			return undefined;
		}

		setStatus(ctx, `reviewing ${event.toolName}…`);
		const result = await reviewAction(scope.action, ctx, settings);
		clearStatus(ctx);

		return handleReviewResult(result, scope.action, ctx, breaker, settings, currentTurnId);
	});

	// Allow user to inspect/tweak settings at runtime.
	pi.registerCommand("pi-auto", {
		description: "Show pi-auto configuration and recent activity",
		handler: async (_args, ctx) => {
			const digestState = getLatestDigest(ctx.sessionManager);
			const lines = [
				`pi-auto settings:`,
				`  reviewer:                  ${settings.reviewerProvider}/${settings.reviewerModel}`,
				`  fallback to active model:  ${settings.fallbackToActiveModel}`,
				`  timeout:                   ${settings.reviewerTimeoutMs}ms`,
				`  circuit breaker:           ${settings.maxConsecutiveDenialsPerTurn} consecutive / ${settings.maxTotalDenialsPerTurn} total per turn`,
				`  transcript cap:            ${settings.maxTranscriptEntries} entries / ${settings.maxEntryChars} chars each / ${settings.maxTranscriptTotalChars} total`,
				`  pinned related entries:    up to ${settings.maxPinnedRelatedEntries}`,
				`  summary entries kept:      up to ${settings.maxSummaryEntries}`,
				`  rolling digest:            ${settings.enableDigest ? "on" : "off"}`,
				`  announce allows:           ${settings.announceAllows}`,
				`  sensitive paths:           ${settings.sensitivePathPatterns.join(", ")}`,
			];
			if (digestState) {
				lines.push(
					"",
					`current auth digest (${digestState.digest.length} chars, last update ${new Date(digestState.updatedAt).toISOString()}):`,
					digestState.digest,
				);
			}
			if (ctx.hasUI) {
				ctx.ui.notify(lines.join("\n"), "info");
			} else {
				console.log(lines.join("\n"));
			}
		},
	});

	pi.registerCommand("pi-auto-toggle-announce", {
		description: "Toggle inline pi-auto rationale messages for allowed actions",
		handler: async (_args, ctx) => {
			settings.announceAllows = !settings.announceAllows;
			if (ctx.hasUI) {
				ctx.ui.notify(`pi-auto announce-allows: ${settings.announceAllows}`, "info");
			}
		},
	});
}

export async function handleReviewResult(
	result: ReviewResult,
	action: ReviewableAction,
	ctx: ExtensionContext,
	breaker: CircuitBreaker,
	settings: PiAutoSettings,
	turnId: string,
): Promise<ToolCallEventResult | undefined> {
	if (result.kind === "failed") {
		// Reviewer failed → fall back to prompting the user (or block if no UI).
		return fallbackToUser(action, result.reason, ctx);
	}

	const { assessment } = result;

	if (assessment.outcome === "allow") {
		breaker.recordNonDenial(turnId);
		if (settings.announceAllows && ctx.hasUI) {
			const glyph = RISK_GLYPH[assessment.risk_level];
			ctx.ui.notify(
				`pi-auto ${glyph} allowed (${assessment.risk_level} risk, auth=${assessment.user_authorization}): ${assessment.rationale}`,
				"info",
			);
		}
		return undefined;
	}

	// outcome === "deny"
	const cbAction = breaker.recordDenial(turnId);
	const denyReason = formatDenyReason(action, assessment);

	if (cbAction.kind === "interrupt") {
		// Tripped the circuit breaker. Prompt the user and stop the turn.
		return await handleCircuitBreaker(action, assessment, cbAction.consecutive, cbAction.total, ctx);
	}

	// Hard block. Codex-style: the agent should find a safer path or stop and ask.
	if (ctx.hasUI) {
		ctx.ui.notify(
			`pi-auto ✕ denied (${assessment.risk_level} risk, auth=${assessment.user_authorization}): ${assessment.rationale}`,
			"warning",
		);
	}
	return { block: true, reason: denyReason };
}

export async function fallbackToUser(
	action: ReviewableAction,
	reason: string,
	ctx: ExtensionContext,
): Promise<ToolCallEventResult | undefined> {
	if (!ctx.hasUI) {
		return {
			block: true,
			reason: `pi-auto reviewer unavailable and no UI for fallback: ${reason}`,
		};
	}

	const choice = await ctx.ui.select(
		[
			`pi-auto reviewer unavailable: ${reason}`,
			"",
			`Tool call: ${action.label}`,
			"",
			"Approve this tool call?",
		].join("\n"),
		["Yes, run it", "No, block"],
	);

	if (choice === "Yes, run it") {
		return undefined;
	}
	return { block: true, reason: "User declined after reviewer fallback" };
}

export async function handleCircuitBreaker(
	action: ReviewableAction,
	assessment: ReviewerAssessment,
	consecutive: number,
	total: number,
	ctx: ExtensionContext,
): Promise<ToolCallEventResult> {
	const summary = [
		`pi-auto circuit breaker tripped.`,
		`Consecutive denials this turn: ${consecutive}, total: ${total}.`,
		``,
		`Latest action:    ${action.label}`,
		`Latest rationale: ${assessment.rationale}`,
		`Risk:             ${assessment.risk_level}, authorization: ${assessment.user_authorization}`,
	].join("\n");

	if (!ctx.hasUI) {
		ctx.abort();
		return { block: true, reason: summary };
	}

	const choice = await ctx.ui.select(`${summary}\n\nWhat do you want to do?`, [
		"Stop this turn",
		"Approve this one action and continue",
	]);

	if (choice === "Approve this one action and continue") {
		// User overrode the reviewer for this action. Allow it through.
		// (Note: this doesn't reset the breaker so a runaway loop still stops.)
		return undefined as unknown as ToolCallEventResult;
	}

	// Stop the turn.
	ctx.abort();
	return { block: true, reason: summary };
}

function formatDenyReason(action: ReviewableAction, assessment: ReviewerAssessment): string {
	return [
		`pi-auto blocked this tool call.`,
		`Action:        ${action.label}`,
		`Risk:          ${assessment.risk_level}`,
		`Authorization: ${assessment.user_authorization}`,
		`Reason:        ${assessment.rationale}`,
		``,
		`Do not pursue the same outcome via workaround or indirect execution. Either find a materially safer alternative, or stop and ask the user.`,
	].join("\n");
}

function setStatus(ctx: ExtensionContext, text: string | undefined): void {
	if (!ctx.hasUI) return;
	try {
		ctx.ui.setStatus("pi-auto", text);
	} catch {
		// older pi versions may not support setStatus in all contexts
	}
}

function clearStatus(ctx: ExtensionContext): void {
	setStatus(ctx, undefined);
}
