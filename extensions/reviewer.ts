/**
 * The reviewer: makes a model call, parses the structured assessment,
 * fail-closes on any error.
 */

import { completeSimple, parseJsonWithRepair, parseStreamingJson } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildCodexAutoReviewSystemPrompt, buildCodexAutoReviewUserPrompt } from "./codex-prompt.ts";
import { getLatestDigest } from "./digest.ts";
import { buildReviewerSystemPrompt } from "./policy.ts";
import { resolveReviewerModel } from "./reviewer-model.ts";
import { buildTranscript } from "./transcript.ts";
import type { PiAutoSettings, ReviewableAction, ReviewerAssessment } from "./types.ts";

import type { Usage } from "@earendil-works/pi-ai";

export interface ReviewResultDiagnostics {
	/** Where the model came from. */
	modelSource: "codex-auto-review" | "configured" | "active-fallback";
	/** Which prompt format we used. */
	promptFormat: "pi-auto" | "codex-auto-review";
	/** Wall time of the reviewer LLM call in ms. */
	latencyMs: number;
	/** Token usage for the reviewer LLM call. Zero when reviewer didn't run. */
	usage: Usage;
	/** Raw text the reviewer emitted, post strip. Useful for debugging parse failures. */
	rawText: string;
}

export type ReviewResult =
	| { kind: "assessed"; assessment: ReviewerAssessment; diagnostics: ReviewResultDiagnostics }
	| { kind: "failed"; reason: string; diagnostics?: ReviewResultDiagnostics };

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export async function reviewAction(
	action: ReviewableAction,
	ctx: ExtensionContext,
	settings: PiAutoSettings,
): Promise<ReviewResult> {
	const resolved = await resolveReviewerModel(ctx, settings);
	if ("error" in resolved) {
		return { kind: "failed", reason: resolved.error };
	}
	const { model, apiKey, headers } = resolved;
	const modelSource = resolved.source;

	const digestState = getLatestDigest(ctx.sessionManager);
	const useCodexFormat = resolved.source === "codex-auto-review";
	const projectInstructions = extractProjectInstructions(ctx.getSystemPrompt?.() ?? "");

	let systemPrompt: string;
	let userPrompt: string;
	if (useCodexFormat) {
		systemPrompt = buildCodexAutoReviewSystemPrompt(settings.customPolicy);
		const sessionId = ctx.sessionManager.getSessionId?.() ?? "pi-auto-session";
		userPrompt = buildCodexAutoReviewUserPrompt({
			sessionManager: ctx.sessionManager,
			settings,
			action,
			digest: digestState?.digest,
			sessionId,
			projectInstructions,
		});
	} else {
		systemPrompt = buildReviewerSystemPrompt(settings);
		const transcript = buildTranscript({
			sessionManager: ctx.sessionManager,
			settings,
			action,
			digest: digestState?.digest,
			projectInstructions,
		});
		userPrompt = [
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
	}

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), settings.reviewerTimeoutMs);
	// Compose abort signals: parent ctx.signal OR our timeout.
	const parentAbort = () => controller.abort();
	if (ctx.signal) ctx.signal.addEventListener("abort", parentAbort, { once: true });

	const t0 = Date.now();
	try {
		// codex-auto-review is fine-tuned for this task at "low" reasoning per OpenAI's blog.
		const reasoningLevel = useCodexFormat ? "low" : "minimal";
		const response = await completeSimple(
			model,
			{
				systemPrompt,
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: userPrompt }],
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey,
				headers,
				signal: controller.signal,
				maxTokens: 4096,
				reasoning: reasoningLevel,
			},
		);

		const latencyMs = Date.now() - t0;
		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("")
			.trim();

		const diagnostics: ReviewResultDiagnostics = {
			modelSource,
			promptFormat: useCodexFormat ? "codex-auto-review" : "pi-auto",
			latencyMs,
			usage: response.usage,
			rawText: text,
		};

		if (!text) {
			return { kind: "failed", reason: "Reviewer returned empty response", diagnostics };
		}

		const parsed = parseAssessment(text);
		if (!parsed) {
			return {
				kind: "failed",
				reason: `Reviewer returned unparseable response: ${truncate(text, 200)}`,
				diagnostics,
			};
		}
		return {
			kind: "assessed",
			assessment: applyDeterministicReviewGuards(parsed, action, ctx),
			diagnostics,
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		const aborted = controller.signal.aborted;
		const latencyMs = Date.now() - t0;
		const diagnostics: ReviewResultDiagnostics = {
			modelSource,
			promptFormat: useCodexFormat ? "codex-auto-review" : "pi-auto",
			latencyMs,
			usage: ZERO_USAGE,
			rawText: "",
		};
		return {
			kind: "failed",
			reason: aborted ? `Reviewer timed out after ${settings.reviewerTimeoutMs}ms` : `Reviewer error: ${msg}`,
			diagnostics,
		};
	} finally {
		clearTimeout(timeoutId);
		if (ctx.signal) ctx.signal.removeEventListener("abort", parentAbort);
	}
}

export function applyDeterministicReviewGuards(
	assessment: ReviewerAssessment,
	action: ReviewableAction,
	ctx: ExtensionContext,
): ReviewerAssessment {
	return applyDeterministicScopeGuard(
		applyDeterministicSafetyGuards(assessment, action, ctx),
		action,
		ctx,
	);
}

export function applyDeterministicSafetyGuards(
	assessment: ReviewerAssessment,
	action: ReviewableAction,
	ctx: ExtensionContext,
): ReviewerAssessment {
	if (assessment.outcome !== "allow") return assessment;
	const userText = collectUserMessageText(ctx).toLowerCase();
	const command = getBashCommand(action);
	if (command && isForcePushMain(command) && !userExplicitlyAuthorizedForcePushMain(userText)) {
		return {
			risk_level: "high",
			user_authorization: "unknown",
			outcome: "deny",
			rationale: "Pushing is not authorization to force-push main.",
		};
	}
	if (command && isDeployApplyCommand(command) && userExplicitlyDeferredExecution(userText)) {
		return {
			risk_level: "high",
			user_authorization: "unknown",
			outcome: "deny",
			rationale: "The user explicitly asked not to run or apply the deploy yet.",
		};
	}
	return assessment;
}

export function applyDeterministicScopeGuard(
	assessment: ReviewerAssessment,
	action: ReviewableAction,
	ctx: ExtensionContext,
): ReviewerAssessment {
	if (assessment.outcome !== "allow") return assessment;
	if (!isOutsideCwdPackageJsonWrite(action)) return assessment;
	const userText = collectUserMessageText(ctx).toLowerCase();
	if (!isGenericPackageJsonScope(userText)) return assessment;
	if (namesBroadPackageScope(userText)) return assessment;
	return {
		risk_level: assessment.risk_level === "critical" ? "critical" : "high",
		user_authorization: "unknown",
		outcome: "deny",
		rationale:
			"A generic request to update all package.json files does not authorize writing package.json in a sibling project outside the current repo.",
	};
}

function getBashCommand(action: ReviewableAction): string | undefined {
	const payload = action.payload;
	const tool = typeof payload.tool === "string" ? payload.tool : action.toolName;
	if (tool !== "bash") return undefined;
	return typeof payload.command === "string" ? payload.command : undefined;
}

function isForcePushMain(command: string): boolean {
	const c = command.toLowerCase();
	return (
		/\bgit\s+push\b/.test(c) &&
		/--force(?:-with-lease)?\b/.test(c) &&
		/\bmain\b/.test(c)
	);
}

function userExplicitlyAuthorizedForcePushMain(userText: string): boolean {
	return /\bforce[- ]push\b/.test(userText) && /\bmain\b/.test(userText);
}

function isDeployApplyCommand(command: string): boolean {
	const c = command.toLowerCase();
	return (
		/\bkubectl\b[^\n;|&]*\bapply\b/.test(c) ||
		/\bterraform\b[^\n;|&]*\bapply\b/.test(c) ||
		/\bhelm\b[^\n;|&]*\bupgrade\b/.test(c)
	);
}

function userExplicitlyDeferredExecution(userText: string): boolean {
	return (
		/\b(?:do not|don't)\s+(?:run|apply|deploy)\b/.test(userText) ||
		/\b(?:do not|don't)\s+run\s+it\s+yet\b/.test(userText) ||
		/\b(?:do not|don't)\s+apply\s+it\s+yet\b/.test(userText) ||
		/\bbut\s+(?:do not|don't)\s+run\s+it\s+yet\b/.test(userText)
	);
}

function isOutsideCwdPackageJsonWrite(action: ReviewableAction): boolean {
	const payload = action.payload;
	const tool = typeof payload.tool === "string" ? payload.tool : action.toolName;
	if (tool !== "write" && tool !== "edit") return false;
	const path = typeof payload.path === "string" ? payload.path : undefined;
	if (!path || !/\/package\.json$/i.test(path)) return false;
	if (payload.outsideCwd === true) return true;
	const cwd = typeof payload.cwd === "string" ? payload.cwd : undefined;
	return Boolean(cwd && path.startsWith("/") && !path.startsWith(`${cwd.replace(/\/$/, "")}/`));
}

function isGenericPackageJsonScope(userText: string): boolean {
	return (
		/\b(?:all|every)\b[^.\n]{0,80}\bpackage\.json\b/.test(userText) ||
		/\bpackage\.json files\b/.test(userText)
	);
}

function namesBroadPackageScope(userText: string): boolean {
	return (
		/\bacross\s+(?:all\s+)?(?:my\s+)?repos?\b/.test(userText) ||
		/\b(?:all|every)\s+(?:my\s+)?repos?\b/.test(userText) ||
		/\brepos?\s+under\s+\//.test(userText) ||
		/\bunder\s+\//.test(userText) ||
		/\.\.\//.test(userText) ||
		/\bother-project\b/.test(userText) ||
		/\bsibling\s+project\b/.test(userText)
	);
}

function collectUserMessageText(ctx: ExtensionContext): string {
	const parts: string[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (!entry || typeof entry !== "object") continue;
		const e = entry as { type?: string; message?: unknown };
		if (e.type !== "message" || !e.message) continue;
		const msg = e.message as { role?: string; content?: unknown };
		if (msg.role !== "user") continue;
		const text = extractPlainText(msg.content);
		if (text) parts.push(text);
	}
	return parts.join("\n");
}

function extractPlainText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const p = part as { type?: string; text?: string };
			return p.type === "text" && typeof p.text === "string" ? p.text : "";
		})
		.filter(Boolean)
		.join("\n");
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

	// Outcome is the only required field. Risk/auth/rationale default to safe
	// values that match Codex's `parse_guardian_assessment`, so the
	// abbreviated `{"outcome":"allow"}` form codex-auto-review emits for clear
	// low-risk actions still parses.
	const outcome = obj.outcome;
	if (!isOutcome(outcome)) return undefined;

	const risk = isRisk(obj.risk_level) ? obj.risk_level : outcome === "allow" ? "low" : "high";
	const userAuth = isUserAuth(obj.user_authorization) ? obj.user_authorization : "unknown";

	let rationale: string;
	if (typeof obj.rationale === "string" && obj.rationale.trim()) {
		rationale = obj.rationale.trim();
	} else {
		rationale =
			outcome === "allow"
				? "Auto-review returned a low-risk allow decision."
				: "Auto-review returned a deny decision without a rationale.";
	}

	return { risk_level: risk, user_authorization: userAuth, outcome, rationale };
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

/**
 * Extract `<project_instructions>` blocks from the host's system prompt.
 *
 * Pi composes AGENTS.md (and similar files) into the active agent's system
 * prompt as `<project_instructions path="...">...</project_instructions>` blocks.
 * The reviewer needs visibility into those constraints so it can recognize
 * project-level restrictions (e.g. "never write to the shared checkout in a
 * background session") and refuse semantically-equivalent bypass attempts.
 *
 * Returns the concatenated content of all such blocks, each prefixed with its
 * source path. Returns the empty string if the system prompt is empty or
 * contains no project-instructions blocks.
 */
export function extractProjectInstructions(systemPrompt: string): string {
	if (!systemPrompt) return "";
	const blockRe = /<project_instructions(?:\s+path="([^"]*)")?>([\s\S]*?)<\/project_instructions>/g;
	const blocks: string[] = [];
	let match: RegExpExecArray | null = blockRe.exec(systemPrompt);
	while (match !== null) {
		const path = match[1];
		const body = (match[2] ?? "").trim();
		if (body) {
			blocks.push(path ? `# ${path}\n${body}` : body);
		}
		match = blockRe.exec(systemPrompt);
	}
	return blocks.join("\n\n");
}
