import type { ExtensionContext, ToolCallEvent, ToolCallEventResult, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { CircuitBreaker } from "../circuit-breaker.ts";
import {
	buildMixedReviewOnlySequenceCommand,
	cleanupAfterSandboxCommands,
	decideSandboxReviewOnlyPrefix,
	formatMixedReviewOnlyRoutingNotice,
} from "../sandbox-routing.ts";
import { reviewAction } from "../reviewer.ts";
import { bareExecResultToToolContent, runBareCommand } from "../sandbox-bare-exec.ts";
import { detectSandboxDenialForCommand } from "../sandbox-denial.ts";
import {
	buildRetryReason,
	getNetworkAttemptsSince,
	wrapBashCommandForExecution,
} from "../sandbox.ts";
import { decideScope } from "../scope.ts";
import type { PiAutoSettings, ReviewableAction, ReviewerAssessment } from "../types.ts";
import { formatReviewerAllowNotice, handleReviewResult } from "./review-gate.ts";
import { SandboxController } from "./sandbox-controller.ts";
import { clearStatus, setStatus, shouldNotify } from "./status-presentation.ts";

export interface SandboxReviewLogEntry {
	at: number;
	command: string;
	sandboxedCommands?: string[];
	denialReason: string;
	retryReason: string;
	sandboxOutput: string;
	mixedReviewOnlySequence?: boolean;
	review:
		| { outcome: "skipped"; note: string }
		| { outcome: "failed"; reason: string }
		| { outcome: "allow" | "deny"; riskLevel: ReviewerAssessment["risk_level"]; userAuthorization: ReviewerAssessment["user_authorization"]; rationale: string };
	escapeRerun?: { exitCode: number | null; signal: NodeJS.Signals | null; durationMs: number };
}

interface WrappedBashState {
	originalCommand: string;
	mode: "escape-only" | "review-then-escape";
	mixedReviewOnlySequence?: boolean;
	sandboxedCommands?: string[];
	sandboxAnnotationCommands?: string[];
	sandboxWrapCount: number;
	startTime: number;
}

export interface ToolResultPatch {
	content?: ToolResultEvent["content"];
	details?: unknown;
	isError?: boolean;
}

const SANDBOX_LOG_OUTPUT_CHARS = 4_000;
const RECENT_DENIAL_CAP = 10;
const SANDBOX_REVIEW_LOG_CAP = 50;

export interface SandboxInterceptorDeps {
	settings: PiAutoSettings;
	breaker: CircuitBreaker;
	getTurnId: () => string;
	isDisabled: () => boolean;
	sandboxController: SandboxController;
}

/** Owns bash wrapping, result interception, escape review, and its in-memory audit log. */
export function createSandboxInterceptor(deps: SandboxInterceptorDeps) {
	const { settings, breaker, getTurnId, isDisabled, sandboxController } = deps;
	const wrappedBashByToolCallId = new Map<string, WrappedBashState>();
	const recentDenials: Array<{ command: string; reason: string; escapedAllow: boolean; at: number }> = [];
	const sandboxReviewLog: SandboxReviewLogEntry[] = [];

	async function handleToolResult(event: ToolResultEvent, ctx: ExtensionContext): Promise<ToolResultPatch | undefined> {
		if (isDisabled()) return undefined;
		if (event.toolName !== "bash") return undefined;
		const wrap = wrappedBashByToolCallId.get(event.toolCallId);
		if (!wrap) return undefined;
		wrappedBashByToolCallId.delete(event.toolCallId);
		cleanupAfterSandboxCommands(wrap.sandboxWrapCount);

		const combinedOutput = extractTextContent(event);
		const denial = detectSandboxDenialForCommands(
			wrap.sandboxAnnotationCommands && wrap.sandboxAnnotationCommands.length > 0
				? wrap.sandboxAnnotationCommands
				: [wrap.originalCommand],
			event.isError,
			combinedOutput,
		);
		if (!denial.denied) return undefined;
		// Use the ASRT-annotated output (which appends a <sandbox_violations>
		// block when the violation store had matching entries) so the reviewer
		// sees the strongest possible evidence about what was denied.
		const evidence = denial.annotatedOutput;

		// Sandbox denied. Build a terse retry_reason mirroring codex's
		// orchestrator (see codex-rs/core/src/tools/orchestrator.rs:
		// build_denial_reason_from_output / Network access to "..." is blocked).
		// For network: use the host(s) ASRT's askCallback captured during this
		// command's lifetime. For filesystem: pull the denied path out of stderr
		// (codex's orchestrator discards it; we keep it). For ambiguous cases
		// fall back to a generic phrase.
		const networkAttempts = getNetworkAttemptsSince(wrap.startTime);
		const retryReason = buildRetryReason(denial.reason, evidence, networkAttempts);

		if (wrap.mixedReviewOnlySequence) {
			recordDenial(wrap.originalCommand, retryReason, /*escapedAllow*/ false);
			recordSandboxReviewLog({
				at: Date.now(),
				command: wrap.originalCommand,
				sandboxedCommands: wrap.sandboxedCommands,
				denialReason: denial.reason,
				retryReason,
				sandboxOutput: evidence,
				mixedReviewOnlySequence: true,
				review: {
					outcome: "skipped",
					note: "mixed review-only/sandboxed sequence; not retried because that would unsandbox non-review-only segments",
				},
			});
			if (ctx.hasUI && shouldNotify(settings.noticeLevel, "denials")) {
				ctx.ui.notify(
					`pi-auto: ${retryReason} Not retrying the mixed review-only sequence outside the sandbox.`,
					"warning",
				);
			}
			return {
				content: [
					{
						type: "text",
						text: [
							`pi-auto sandbox blocked a sandboxed segment in this mixed review-only command sequence.`,
							retryReason,
							`pi-auto did not retry the full sequence outside the sandbox because that would also unsandbox non-review-only segments.`,
							``,
							`Sandbox output:`,
							evidence,
						].join("\n"),
					},
				],
				isError: true,
			};
		}

		const escapeAction: ReviewableAction = {
			toolName: "bash",
			toolCallId: event.toolCallId,
			label: `bash: ${truncate(wrap.originalCommand, 200)}`,
			payload: {
				tool: "bash",
				command: wrap.originalCommand,
				cwd: ctx.cwd,
				retryReason,
			},
		};

		setStatus(ctx, "reviewing sandbox escape…");
		const reviewResult = await reviewAction(escapeAction, ctx, settings);
		clearStatus(ctx);

		if (reviewResult.kind === "failed") {
			recordDenial(wrap.originalCommand, retryReason, /*escapedAllow*/ false);
			recordSandboxReviewLog({
				at: Date.now(),
				command: wrap.originalCommand,
				sandboxedCommands: wrap.sandboxedCommands,
				denialReason: denial.reason,
				retryReason,
				sandboxOutput: evidence,
				review: { outcome: "failed", reason: reviewResult.reason },
			});
			if (ctx.hasUI && shouldNotify(settings.noticeLevel, "denials")) {
				ctx.ui.notify(
					`pi-auto: ${retryReason} (escape reviewer unavailable: ${reviewResult.reason}; leaving sandbox error in place)`,
					"warning",
				);
			}
			return undefined;
		}

		const { assessment } = reviewResult;
		if (assessment.outcome === "deny") {
			recordDenial(wrap.originalCommand, retryReason, /*escapedAllow*/ false);
			recordSandboxReviewLog({
				at: Date.now(),
				command: wrap.originalCommand,
				sandboxedCommands: wrap.sandboxedCommands,
				denialReason: denial.reason,
				retryReason,
				sandboxOutput: evidence,
				review: {
					outcome: "deny",
					riskLevel: assessment.risk_level,
					userAuthorization: assessment.user_authorization,
					rationale: assessment.rationale,
				},
			});
			if (ctx.hasUI && shouldNotify(settings.noticeLevel, "denials")) {
				ctx.ui.notify(
					`pi-auto ✕ ${retryReason} Reviewer denied escape (${assessment.risk_level}/${assessment.user_authorization}): ${assessment.rationale}`,
					"warning",
				);
			}
			// Replace the result content so the agent sees a pi-auto-shaped denial
			// reason rather than just the raw sandbox stderr.
			return {
				content: [
					{
						type: "text",
						text: [
							`pi-auto sandbox blocked this command and the escape reviewer denied running it outside the sandbox.`,
							retryReason,
							`Escape rationale: ${assessment.rationale}`,
							``,
							`Sandbox output:`,
							evidence,
						].join("\n"),
					},
				],
				isError: true,
			};
		}

		// Escape allowed — re-run the original command outside the sandbox.
		recordDenial(wrap.originalCommand, retryReason, /*escapedAllow*/ true);
		if (ctx.hasUI && shouldNotify(settings.noticeLevel, "normal")) {
			ctx.ui.notify(
				`pi-auto: ${retryReason} Reviewer approved escape: ${assessment.rationale}`,
				"info",
			);
		}
		setStatus(ctx, "re-running outside sandbox…");
		try {
			const bare = await runBareCommand(wrap.originalCommand, ctx.cwd, ctx.signal);
			recordSandboxReviewLog({
				at: Date.now(),
				command: wrap.originalCommand,
				sandboxedCommands: wrap.sandboxedCommands,
				denialReason: denial.reason,
				retryReason,
				sandboxOutput: evidence,
				review: {
					outcome: "allow",
					riskLevel: assessment.risk_level,
					userAuthorization: assessment.user_authorization,
					rationale: assessment.rationale,
				},
				escapeRerun: {
					exitCode: bare.exitCode,
					signal: bare.signal,
					durationMs: bare.durationMs,
				},
			});
			clearStatus(ctx);
			const { text, isError } = bareExecResultToToolContent(bare);
			return {
				content: [{ type: "text", text }],
				isError,
			};
		} catch (err) {
			recordSandboxReviewLog({
				at: Date.now(),
				command: wrap.originalCommand,
				sandboxedCommands: wrap.sandboxedCommands,
				denialReason: denial.reason,
				retryReason,
				sandboxOutput: evidence,
				review: {
					outcome: "allow",
					riskLevel: assessment.risk_level,
					userAuthorization: assessment.user_authorization,
					rationale: assessment.rationale,
				},
			});
			clearStatus(ctx);
			return {
				content: [
					{
						type: "text",
						text: `pi-auto escape re-run failed: ${err instanceof Error ? err.message : String(err)}`,
					},
				],
				isError: true,
			};
		}
	}

	async function handleBashWithSandbox(
		event: ToolCallEvent,
		ctx: ExtensionContext,
	): Promise<ToolCallEventResult | undefined> {
		if (event.toolName !== "bash") return undefined;
		const originalCommand = (event.input as { command?: unknown }).command;
		if (typeof originalCommand !== "string" || !originalCommand.trim()) {
			return undefined;
		}

		// Some tools are incompatible with the sandbox in ways that look like
		// ordinary application errors (for example, `gh` cannot always read an OS
		// keyring from ASRT's Linux sandbox). For configured prefixes, skip the
		// first sandbox attempt: review the full command, then run it bare only if
		// the reviewer allows.
		const reviewOnlyDecision = decideSandboxReviewOnlyPrefix(
			originalCommand,
			settings.sandbox.reviewOnlyCommandPrefixes,
		);
		if (reviewOnlyDecision.kind === "match") {
			const action = bashReviewAction(originalCommand, event.toolCallId, ctx.cwd);
			setStatus(ctx, "reviewing review-only bash…");
			const result = await reviewAction(action, ctx, settings);
			clearStatus(ctx);
			return await handleReviewResult(result, action, ctx, breaker, settings, getTurnId());
		}
		if (reviewOnlyDecision.kind === "mixed-sequence") {
			const action = bashReviewAction(originalCommand, event.toolCallId, ctx.cwd);
			setStatus(ctx, "reviewing mixed review-only bash…");
			const result = await reviewAction(action, ctx, settings);
			clearStatus(ctx);
			if (result.kind === "assessed" && result.assessment.outcome === "allow") {
				breaker.recordNonDenial(getTurnId());
				if (ctx.hasUI && shouldNotify(settings.noticeLevel, "normal")) {
					ctx.ui.notify(
						[
							formatMixedReviewOnlyRoutingNotice(reviewOnlyDecision.segments),
							formatReviewerAllowNotice(result.assessment),
						].join("\n\n"),
						"info",
					);
				}
			} else {
				const gating = await handleReviewResult(result, action, ctx, breaker, settings, getTurnId());
				if (gating && gating.block === true) return gating;
			}

			const ready = await sandboxController.ensure(settings, ctx.cwd);
			if (ready.kind !== "ready") {
				if (ctx.hasUI) {
					ctx.ui.notify(
						`pi-auto sandbox unavailable; blocking bash. Reason: ${ready.kind === "broken" ? ready.reason : "not ready"}`,
						"warning",
					);
				}
				return {
					block: true,
					reason: `pi-auto sandbox unavailable: ${ready.kind === "broken" ? ready.reason : "not ready"}`,
				};
			}

			try {
				const rewritten = await buildMixedReviewOnlySequenceCommand(
					reviewOnlyDecision.segments,
					ctx.cwd,
					settings.sandbox,
				);
				(event.input as { command?: unknown }).command = rewritten.command;
				wrappedBashByToolCallId.set(event.toolCallId, {
					originalCommand,
					mode: settings.sandbox.mode === "review-then-escape" ? "review-then-escape" : "escape-only",
					mixedReviewOnlySequence: true,
					sandboxedCommands: rewritten.sandboxedCommands,
					sandboxAnnotationCommands: rewritten.sandboxAnnotationCommands,
					sandboxWrapCount: rewritten.sandboxWrapCount,
					startTime: Date.now(),
				});
				return undefined;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (ctx.hasUI) {
					ctx.ui.notify(`pi-auto mixed review-only sandbox wrap failed: ${msg}`, "warning");
				}
				return { block: true, reason: `pi-auto mixed review-only sandbox wrap failed: ${msg}` };
			}
		}
		if (reviewOnlyDecision.kind === "unsupported") {
			return { block: true, reason: reviewOnlyDecision.reason };
		}

		// Pre-review step for review-then-escape mode. Mirrors the no-sandbox
		// flow: deterministic safe-command fast path first (via decideScope), then
		// the LLM reviewer. If the reviewer denies, we block here; the sandbox
		// wrap is skipped entirely.
		if (settings.sandbox.mode === "review-then-escape") {
			const scope = decideScope(event, ctx.cwd, settings);
			if (scope.review) {
				setStatus(ctx, `reviewing ${event.toolName}…`);
				const result = await reviewAction(scope.action, ctx, settings);
				clearStatus(ctx);
				const gating = await handleReviewResult(
					result,
					scope.action,
					ctx,
					breaker,
					settings,
					getTurnId(),
				);
				if (gating && gating.block === true) return gating;
			}
		}

		// Initialize the sandbox lazily on first wrap. We've already validated
		// availability at session_start, so a failure here is exceptional.
		const ready = await sandboxController.ensure(settings, ctx.cwd);
		if (ready.kind !== "ready") {
			if (ctx.hasUI) {
				ctx.ui.notify(
					`pi-auto sandbox unavailable; blocking bash. Reason: ${ready.kind === "broken" ? ready.reason : "not ready"}`,
					"warning",
				);
			}
			return {
				block: true,
				reason: `pi-auto sandbox unavailable: ${ready.kind === "broken" ? ready.reason : "not ready"}`,
			};
		}

		try {
			const wrapped = await wrapBashCommandForExecution(originalCommand, ctx.cwd, settings.sandbox);
			// Mutate the event input in place so pi runs the wrapped command. Per
			// the pi extension docs (tool_call) this is the supported path for
			// argument patching. The user will see the wrapped form in the bash
			// tool display — there isn't currently a pi API to display X while
			// executing Y. annotateBashDisplay is reserved for a future hook.
			(event.input as { command?: unknown }).command = wrapped.wrappedCommand;
			wrappedBashByToolCallId.set(event.toolCallId, {
				originalCommand,
				mode: settings.sandbox.mode === "review-then-escape" ? "review-then-escape" : "escape-only",
				sandboxAnnotationCommands: [wrapped.sandboxCommand],
				sandboxWrapCount: 1,
				startTime: Date.now(),
			});
			return undefined;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (ctx.hasUI) {
				ctx.ui.notify(`pi-auto sandbox wrap failed: ${msg}`, "warning");
			}
			return { block: true, reason: `pi-auto sandbox wrap failed: ${msg}` };
		}
	}

	function recordDenial(command: string, reason: string, escapedAllow: boolean): void {
		recentDenials.push({ command, reason, escapedAllow, at: Date.now() });
		if (recentDenials.length > RECENT_DENIAL_CAP) {
			recentDenials.splice(0, recentDenials.length - RECENT_DENIAL_CAP);
		}
	}

	function recordSandboxReviewLog(entry: SandboxReviewLogEntry): void {
		sandboxReviewLog.push({
			...entry,
			sandboxOutput: tail(entry.sandboxOutput, SANDBOX_LOG_OUTPUT_CHARS),
		});
		if (sandboxReviewLog.length > SANDBOX_REVIEW_LOG_CAP) {
			sandboxReviewLog.splice(0, sandboxReviewLog.length - SANDBOX_REVIEW_LOG_CAP);
		}
	}
	return { handleToolCall: handleBashWithSandbox, handleToolResult, recentDenials, sandboxReviewLog };
}

function extractTextContent(event: ToolResultEvent): string {
	let out = "";
	for (const c of event.content) {
		if (c.type === "text") out += c.text;
	}
	return out;
}

function detectSandboxDenialForCommands(
	commands: readonly string[],
	isError: boolean,
	combinedOutput: string,
): { denied: boolean; reason: string; annotatedOutput: string } {
	let fallback: { denied: boolean; reason: string; annotatedOutput: string } | undefined;
	for (const command of commands) {
		const denial = detectSandboxDenialForCommand(command, isError, combinedOutput);
		if (!denial.denied) {
			fallback = denial;
			continue;
		}
		return denial;
	}
	return fallback ?? { denied: false, reason: "", annotatedOutput: combinedOutput };
}

function bashReviewAction(command: string, toolCallId: string, cwd: string): ReviewableAction {
	return {
		toolName: "bash",
		toolCallId,
		label: `bash: ${truncate(command, 200)}`,
		payload: {
			tool: "bash",
			command,
			cwd,
			reviewOnlyByPrefix: true,
		},
	};
}

export function parseSandboxLogCount(args: string, fallback = 10): number {
	const trimmed = args.trim();
	if (!trimmed) return fallback;
	const first = trimmed.split(/\s+/, 1)[0] ?? "";
	const parsed = Number.parseInt(first, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
	return Math.min(parsed, 50);
}

export function formatSandboxReviewLog(
	entries: readonly SandboxReviewLogEntry[],
	count = 10,
): string {
	if (entries.length === 0) {
		return "pi-auto sandbox review log: empty";
	}
	const shown = entries.slice(-count).reverse();
	const lines = [
		`pi-auto sandbox review log: showing ${shown.length} of ${entries.length} entr${entries.length === 1 ? "y" : "ies"}`,
	];
	shown.forEach((entry, index) => {
		lines.push("", `${index + 1}. [${new Date(entry.at).toISOString()}] ${formatSandboxReviewOutcome(entry)}`);
		lines.push(`command: ${truncate(entry.command, 500)}`);
		if (entry.sandboxedCommands && entry.sandboxedCommands.length > 0) {
			lines.push(`sandboxed segment(s): ${entry.sandboxedCommands.map((c) => truncate(c, 160)).join(" | ")}`);
		}
		lines.push(`sandbox denial: ${entry.denialReason}`);
		lines.push(`retry reason: ${entry.retryReason}`);
		const review = entry.review;
		switch (review.outcome) {
			case "allow":
			case "deny":
				lines.push(`review: ${review.outcome} (${review.riskLevel}/${review.userAuthorization})`);
				lines.push(`rationale: ${review.rationale}`);
				break;
			case "failed":
				lines.push(`review: failed (${review.reason})`);
				break;
			case "skipped":
				lines.push(`review: skipped (${review.note})`);
				break;
		}
		if (entry.escapeRerun) {
			const rerun = entry.escapeRerun;
			lines.push(
				`escape rerun: exit=${rerun.exitCode ?? "null"} signal=${rerun.signal ?? "null"} duration=${rerun.durationMs}ms`,
			);
		}
		lines.push("sandbox output:");
		lines.push(indentBlock(tail(entry.sandboxOutput, SANDBOX_LOG_OUTPUT_CHARS), "  "));
	});
	return lines.join("\n");
}

function formatSandboxReviewOutcome(entry: SandboxReviewLogEntry): string {
	if (entry.review.outcome === "allow") return "escape ALLOWED";
	if (entry.review.outcome === "deny") return "escape DENIED";
	if (entry.review.outcome === "failed") return "escape REVIEW FAILED";
	return entry.mixedReviewOnlySequence ? "sandbox DENIED; escape SKIPPED" : "sandbox DENIED";
}

function tail(s: string, n: number): string {
	if (s.length <= n) return s;
	return `…[last ${n} chars]\n${s.slice(-n)}`;
}

function indentBlock(s: string, prefix: string): string {
	return s
		.split("\n")
		.map((line) => `${prefix}${line}`)
		.join("\n");
}

function truncate(s: string, n: number): string {
	return s.length <= n ? s : `${s.slice(0, n)}…`;
}
