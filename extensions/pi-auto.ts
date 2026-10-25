import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { reviewAction } from "./reviewer.ts";
import { formatReviewDebug, persistReviewDebug, reviewFailureLabel, reviewerDebugPath, type ReviewDebugRecord } from "./diagnostics.ts";
import { parseBashDirective, protectedWritePaths, decideScope } from "./scope.ts";
import { prepareSandboxCommand, shutdownSandbox, checkSandboxAvailability, type PreparedSandboxCommand } from "./sandbox.ts";
import { appendExecutionNotice } from "./execution.ts";
import { compact, failureSummary, formatApproval, formatDebugSummary, formatDecision, formatStatus } from "./presentation.ts";
import { agentDirectory, loadSettings, type LoadedSettings } from "./settings.ts";
import type { ReviewableAction, ReviewFailureCode, ReviewResult, Settings } from "./types.ts";

const EXECUTION_GUIDANCE = `pi-auto wraps the existing bash command without replacing its tool. Bash is sandboxed by default. For a fresh command requiring full host access, put '# pi-auto: host <reason>' on the first line, followed by the command. This requests automatic review of full user privileges and does not grant access by itself. After a sandbox denial, inspect possible partial effects and propose a narrower fresh command; never automatically replay an entire script. Submit one sandboxed bash tool call at a time; concurrent preflight requests are rejected for retry after the running command finishes.`;

interface DecisionRecord {
	at: string;
	tool: string;
	execution: "sandbox" | "host" | "tool";
	outcome: "allow" | "deny";
	source: "automatic" | "user" | "policy" | "unavailable" | "invalid-response";
	fingerprint: string;
	evidence?: string[];
	risk?: string;
	authorization?: string;
	latencyMs?: number;
	reviewId?: string;
	reviewAttempts?: number;
	reviewFailure?: ReviewFailureCode;
}

export interface RuntimeDependencies {
	loadSettings: typeof loadSettings;
	reviewAction: typeof reviewAction;
	prepareSandboxCommand: typeof prepareSandboxCommand;
	shutdownSandbox: typeof shutdownSandbox;
	checkSandboxAvailability: typeof checkSandboxAvailability;
	/** Default records contain no arguments, commands, rationale, or transcript. */
	persistDecision?: (cwd: string, record: DecisionRecord) => Promise<void>;
	persistReviewDebug?: typeof persistReviewDebug;
}

/** A single bounded local file; it contains metadata only and is never reviewer context. */
async function persistDecision(cwd: string, record: DecisionRecord): Promise<void> {
	const directory = join(agentDirectory(), "pi-auto-v2");
	const file = join(directory, "decisions.jsonl");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	let lines: string[] = [];
	try { lines = (await readFile(file, "utf8")).split("\n").filter(Boolean).slice(-199); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	lines.push(JSON.stringify(record));
	await writeFile(file, `${lines.join("\n")}\n`, { mode: 0o600 });
}

export default function piAuto(pi: ExtensionAPI): void { registerPiAuto(pi); }

/** Exported composition function lets tests exercise actual routing and execution. */
export function registerPiAuto(pi: ExtensionAPI, overrides: Partial<RuntimeDependencies> = {}): void {
	const deps: RuntimeDependencies = { loadSettings, reviewAction, prepareSandboxCommand, shutdownSandbox, checkSandboxAvailability, persistDecision, persistReviewDebug, ...overrides };
	let loaded: LoadedSettings | undefined;
	let currentCwd = "";
	let settings: Settings;
	let logQueue: Promise<void> = Promise.resolve();
	let logWarned = false;
	let authorizationEpoch = 0;
	const decisions: DecisionRecord[] = [];
	const recentReviews: ReviewDebugRecord[] = [];
	let debugLogWarned = false;
	const pendingBash = new Map<string, { wrapper: PreparedSandboxCommand; originalCommand: string; input: Record<string, unknown> }>();
	const fingerprint = (input: unknown, cwd: string) => JSON.stringify({ cwd, input });

	function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
		if (ctx.hasUI) ctx.ui.notify(`auto · ${message}`, type);
	}
	function status(ctx: ExtensionContext): void {
		ctx.ui.setStatus("pi-auto", !settings.enabled ? "auto off" : loaded?.errors.length ? "auto !" : "auto");
	}
	function load(ctx: ExtensionContext): void {
		authorizationEpoch++;
		loaded = deps.loadSettings(ctx.cwd);
		settings = loaded.settings;
		currentCwd = ctx.cwd;
		if (loaded.errors.length) notify(ctx, "settings error · /auto debug paths", "error");
		status(ctx);
	}
	function ensureLoaded(ctx: ExtensionContext): void { if (!loaded || currentCwd !== ctx.cwd) load(ctx); }
	function record(ctx: ExtensionContext, action: ReviewableAction, outcome: "allow" | "deny", source: DecisionRecord["source"], result?: ReviewResult): void {
		const entry: DecisionRecord = {
			at: new Date().toISOString(), tool: action.toolName, execution: action.execution, outcome, source,
			fingerprint: createHash("sha256").update(fingerprint(action.input, action.cwd)).digest("hex"),
			...(result ? { latencyMs: result.latencyMs } : {}),
			...(result?.diagnostics ? { reviewId: result.diagnostics.id, reviewAttempts: result.diagnostics.attempts.length } : {}),
			...(result?.kind === "failed" && result.failureCode ? { reviewFailure: result.failureCode } : {}),
			...(result?.kind === "assessed" ? { risk: result.assessment.risk_level, authorization: result.assessment.user_authorization, evidence: result.assessment.evidence } : {}),
		};
		decisions.push(entry);
		if (decisions.length > 50) decisions.shift();
		const cwd = ctx.cwd;
		logQueue = logQueue.then(() => deps.persistDecision?.(cwd, entry)).catch(() => {
			if (!logWarned) { notify(ctx, "log not saved · /auto log", "warning"); logWarned = true; }
		});
	}

	function captureDiagnostics(ctx: ExtensionContext, action: ReviewableAction, result: ReviewResult): void {
		if (!result.diagnostics) return;
		const entry: ReviewDebugRecord = {
			at: new Date().toISOString(), tool: action.toolName, execution: action.execution,
			outcome: result.kind === "failed" ? "failed" : result.decision.outcome, review: result.diagnostics,
		};
		recentReviews.push(entry);
		if (recentReviews.length > 20) recentReviews.shift();
		if (settings.reviewer.debug) logQueue = logQueue.then(() => deps.persistReviewDebug?.(entry)).catch(() => {
			if (!debugLogWarned) { notify(ctx, "debug log not saved · /auto debug", "warning"); debugLogWarned = true; }
		});
	}

	async function authorize(event: Pick<ToolCallEvent, "toolName" | "toolCallId" | "input">, ctx: ExtensionContext, signal = ctx.signal): Promise<ToolCallEventResult | undefined> {
		ensureLoaded(ctx);
		const epoch = authorizationEpoch;
		if (loaded!.errors.length) return { block: true, reason: "pi-auto configuration is invalid. Correct pi-auto-v2.json and use /auto reload before retrying." };
		const metadata = pi.getAllTools().find((tool) => tool.name === event.toolName);

		const snapshot = { ...event, input: structuredClone(event.input) as Record<string, unknown> };
		let scope = decideScope(snapshot, ctx.cwd, settings, metadata?.description ?? "");
		if (scope.kind === "block") {
			record(ctx, { toolName: event.toolName, toolCallId: event.toolCallId, input: snapshot.input, description: metadata?.description ?? "", cwd: ctx.cwd, label: event.toolName, execution: event.toolName === "bash" ? parseBashDirective(String(snapshot.input.command ?? "")).execution : "tool" }, "deny", "policy");
			notify(ctx, `${event.toolName} blocked · ${compact(scope.reason)}`, "warning");
			return { block: true, reason: `pi-auto policy: ${scope.reason}` };
		}
		const isCustomOverride = metadata?.sourceInfo?.source !== "builtin";
		if (isCustomOverride) {
			const request = event.toolName === "bash" ? parseBashDirective(String(snapshot.input.command)) : undefined;
			const action: ReviewableAction = scope.kind === "review" ? scope.action : {
				toolName: event.toolName, toolCallId: event.toolCallId, input: request ? { ...snapshot.input, command: request.command } : snapshot.input,
				description: metadata?.description ?? "", cwd: ctx.cwd, label: `${event.toolName}: custom tool`, execution: request?.execution ?? "tool",
			};
			scope = { kind: "review", action: { ...action, toolSource: "custom", reason: [action.reason, "Tool implementation is supplied by an extension; builtin name does not grant a routine exemption."].filter(Boolean).join("; ") } };
		}
		if (scope.kind === "skip") return undefined;
		const action = scope.action;
		ctx.ui.setStatus("pi-auto", `auto · ${compact(event.toolName, 28)}`);
		let result: ReviewResult;
		try { result = await deps.reviewAction(action, ctx, settings, signal); }
		catch (error) { result = { kind: "failed", reason: error instanceof Error ? error.message : String(error), latencyMs: 0 }; }
		finally { status(ctx); }
		captureDiagnostics(ctx, action, result);
		if (epoch !== authorizationEpoch) return { block: true, reason: "pi-auto session or policy changed during review. Propose the action again for a fresh decision." };
		if (signal?.aborted) return { block: true, reason: "pi-auto review cancelled; action did not run." };
		if (result.kind === "assessed" && result.decision.outcome === "allow") {
			record(ctx, action, "allow", "automatic", result);
			if (settings.notices === "all") notify(ctx, `${action.toolName} allowed · ${result.assessment.risk_level}`);
			return undefined;
		}
		const invalidResponse = result.kind === "failed" && ["empty_response", "invalid_json", "not_object", "missing_fields", "unexpected_fields", "invalid_field", "output_truncated"].includes(result.failureCode ?? "");
		const reason = result.kind === "failed"
			? `${reviewFailureLabel(result.failureCode)}${result.failureCode ? ` [${result.failureCode}]` : ""}: ${result.reason}${result.diagnostics ? `\nReview ID: ${result.diagnostics.id}. Use /auto debug to inspect content-free diagnostics.` : ""}`
			: result.decision.reason;
		let approved = false;
		if (ctx.hasUI) {
			approved = await ctx.ui.confirm(`Allow ${action.toolName} once?`, formatApproval(action, result), { signal });
		}
		if (epoch !== authorizationEpoch) return { block: true, reason: "pi-auto session or policy changed during approval. Propose the action again for a fresh decision." };
		if (approved && !signal?.aborted) { record(ctx, action, "allow", "user", result); return undefined; }
		record(ctx, action, "deny", result.kind === "failed" ? invalidResponse ? "invalid-response" : "unavailable" : "automatic", result);
		notify(ctx, `${action.toolName} blocked · ${failureSummary(result)}`, "warning");
		return { block: true, reason: `pi-auto blocked this action before execution. ${reason}${ctx.hasUI ? "" : " User approval is required; interactive or RPC approval is available."}` };
	}

	async function cancelPending(): Promise<void> {
		const pending = [...pendingBash.values()];
		pendingBash.clear();
		await Promise.all(pending.map(({ wrapper, originalCommand, input }) => { input.command = originalCommand; return wrapper.cancel(); }));
	}
	pi.on("tool_call", async (event, ctx) => {
		ensureLoaded(ctx);
		// Off means no pi-auto policy checks, reviews, prompts, or input wrapping.
		if (!settings.enabled) return undefined;
		const epoch = authorizationEpoch;
		const beforeReview = fingerprint(event.input, ctx.cwd);
		const decision = await authorize(event, ctx);
		if (decision?.block || event.toolName !== "bash") return decision;
		if (epoch !== authorizationEpoch || beforeReview !== fingerprint(event.input, ctx.cwd)) {
			return { block: true, reason: "pi-auto input or policy changed during review; propose the action again." };
		}
		const request = parseBashDirective(String(event.input.command));
		if (request.error) return { block: true, reason: `pi-auto: ${request.error}` };
		if (request.execution === "host") {
			event.input.command = request.command;
			return undefined;
		}
		try {
			const wrapper = await deps.prepareSandboxCommand({
				command: request.command, cwd: ctx.cwd, signal: ctx.signal,
				sandbox: settings.sandbox, protectedPaths: protectedWritePaths(ctx.cwd, settings), sensitivePaths: settings.sensitivePaths,
			});
			if (epoch !== authorizationEpoch || beforeReview !== fingerprint(event.input, ctx.cwd)) {
				await wrapper.cancel();
				return { block: true, reason: "pi-auto input or policy changed while preparing sandbox execution; propose the action again." };
			}
			pendingBash.set(event.toolCallId, { wrapper, originalCommand: request.command, input: event.input as Record<string, unknown> });
			event.input.command = wrapper.command;
			return undefined;
		} catch (error) {
			return { block: true, reason: `pi-auto could not prepare sandbox execution: ${error instanceof Error ? error.message : String(error)}` };
		}
	});
	pi.on("tool_result", async (event) => {
		if (event.toolName !== "bash") return undefined;
		const pending = pendingBash.get(event.toolCallId);
		if (!pending) return undefined;
		pendingBash.delete(event.toolCallId);
		pending.input.command = pending.originalCommand;
		event.input.command = pending.originalCommand;
		const output = event.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
		try {
			const outcome = await pending.wrapper.finish(output, event.isError);
			const content = appendExecutionNotice(event.content, outcome, event.isError);
			return content === event.content ? undefined : { content, isError: event.isError || outcome.blocked };
		} catch (error) {
			await pending.wrapper.cancel();
			return { content: [...event.content, { type: "text" as const, text: `pi-auto sandbox finalization failed: ${error instanceof Error ? error.message : String(error)}. The command was not replayed.` }], isError: true };
		}
	});
	pi.on("tool_execution_end", async (event) => {
		const pending = pendingBash.get(event.toolCallId);
		if (!pending) return;
		pendingBash.delete(event.toolCallId);
		pending.input.command = pending.originalCommand;
		await pending.wrapper.cancel();
	});
	pi.on("turn_end", async () => { await cancelPending(); });
	pi.on("session_start", async (_event, ctx) => {
		authorizationEpoch++;
		await cancelPending(); load(ctx);
		if (!settings.enabled) return;
		const availability = deps.checkSandboxAvailability();
		if (!availability.available) notify(ctx, "sandbox unavailable · /auto debug paths", "error");
		for (const warning of availability.warnings) notify(ctx, compact(warning), "warning");
	});
	pi.on("session_tree", async (_event, ctx) => { authorizationEpoch++; if (ctx.isIdle?.()) await cancelPending(); status(ctx); });
	pi.on("before_agent_start", async (event, ctx) => {
		ensureLoaded(ctx);
		authorizationEpoch++; await cancelPending();
		const guidance = settings.enabled ? EXECUTION_GUIDANCE : "pi-auto is OFF. Tools are not reviewed, path-gated, or sandboxed by pi-auto. Bash runs with normal host privileges; no pi-auto host directive is needed.";
		return { systemPrompt: `${event.systemPrompt}\n\n${guidance}` };
	});
	pi.on("session_shutdown", async () => { authorizationEpoch++; await cancelPending(); await logQueue; await deps.shutdownSandbox(); });

	const usage = "usage: /auto on|off|status|reload|log|debug";
	pi.registerCommand("auto", {
		description: "Review + sandbox: on, off, status, reload, log, debug",
		async handler(args, ctx) {
			ensureLoaded(ctx);
			const [command = "status", option, ...extra] = args.trim().split(/\s+/).filter(Boolean);
			if (extra.length || (option !== undefined && command !== "debug" && command !== "log")) { notify(ctx, usage, "warning"); return; }
			if (command === "on" || command === "off") {
				await ctx.waitForIdle();
				authorizationEpoch++;
				await cancelPending();
				await deps.shutdownSandbox();
				settings.enabled = command === "on";
				status(ctx);
				notify(ctx, settings.enabled ? "on" : "off · review + sandbox disabled", settings.enabled ? "info" : "warning");
			} else if (command === "reload") {
				await ctx.waitForIdle();
				authorizationEpoch++; await cancelPending();
				await deps.shutdownSandbox(); load(ctx);
				if (!loaded!.errors.length) notify(ctx, "reloaded");
			} else if (command === "debug") {
				if (option === "on" || option === "off") {
					settings.reviewer.debug = option === "on";
					notify(ctx, `debug ${option}`);
				} else if (option === "paths") {
					const availability = deps.checkSandboxAvailability();
					notify(ctx, [`User settings: ${loaded!.paths.user}`, `Project settings: ${loaded!.paths.project}`, `Debug log: ${reviewerDebugPath()}`, `Sandbox: ${availability.available ? "available" : "unavailable"}`, ...(availability.defaultWritePaths?.length ? [`Compatibility writes:\n${availability.defaultWritePaths.join("\n")}`] : []), ...loaded!.errors, ...availability.errors, ...availability.warnings].join("\n"));
				} else if (option) {
					const id = option.replace(/^#/, "");
					const matches = option === "last" ? recentReviews.slice(-1) : recentReviews.filter((entry) => entry.review.id.startsWith(id));
					notify(ctx, matches.length === 1 ? formatReviewDebug(matches[0]!) : matches.length > 1 ? "ambiguous review ID · use more characters" : "review not found", matches.length === 1 ? "info" : "warning");
				} else {
					notify(ctx, [`debug ${settings.reviewer.debug ? "on" : "off"} · /auto debug <id> for details`, ...(recentReviews.length ? recentReviews.slice(-5).map(formatDebugSummary) : ["no reviews"])].join("\n"));
				}
			} else if (command === "log") {
				if (option !== undefined && option !== "all") { notify(ctx, "usage: /auto log [all]", "warning"); return; }
				notify(ctx, decisions.length ? decisions.slice(option === "all" ? -50 : -10).map(formatDecision).join("\n") : "no decisions");
			} else if (command === "status") {
				notify(ctx, formatStatus(settings, deps.checkSandboxAvailability().available, !!loaded!.errors.length));
			} else notify(ctx, usage, "warning");
		},
	});
}
