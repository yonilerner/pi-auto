import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { reviewAction } from "./reviewer.ts";
import { parseBashDirective, protectedWritePaths, decideScope } from "./scope.ts";
import { prepareSandboxCommand, shutdownSandbox, checkSandboxAvailability, type PreparedSandboxCommand } from "./sandbox.ts";
import { appendExecutionNotice } from "./execution.ts";
import { agentDirectory, loadSettings, type LoadedSettings } from "./settings.ts";
import type { ReviewableAction, ReviewResult, Settings } from "./types.ts";

const EXECUTION_GUIDANCE = `pi-auto wraps the existing bash command without replacing its tool. Bash is sandboxed by default. For a fresh command requiring full host access, put '# pi-auto: host <reason>' on the first line, followed by the command. This requests automatic review of full user privileges and does not grant access by itself. After a sandbox denial, inspect possible partial effects and propose a narrower fresh command; never automatically replay an entire script. Submit one sandboxed bash tool call at a time; concurrent preflight requests are rejected for retry after the running command finishes.`;

interface DecisionRecord {
	at: string;
	tool: string;
	execution: "sandbox" | "host" | "tool";
	outcome: "allow" | "deny";
	source: "automatic" | "user" | "policy" | "unavailable";
	fingerprint: string;
	evidence?: string[];
	risk?: string;
	authorization?: string;
	latencyMs?: number;
}

export interface RuntimeDependencies {
	loadSettings: typeof loadSettings;
	reviewAction: typeof reviewAction;
	prepareSandboxCommand: typeof prepareSandboxCommand;
	shutdownSandbox: typeof shutdownSandbox;
	checkSandboxAvailability: typeof checkSandboxAvailability;
	/** Default records contain no arguments, commands, rationale, or transcript. */
	persistDecision?: (cwd: string, record: DecisionRecord) => Promise<void>;
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
	const deps: RuntimeDependencies = { loadSettings, reviewAction, prepareSandboxCommand, shutdownSandbox, checkSandboxAvailability, persistDecision, ...overrides };
	let loaded: LoadedSettings | undefined;
	let currentCwd = "";
	let settings: Settings;
	let logQueue: Promise<void> = Promise.resolve();
	let logWarned = false;
	let authorizationEpoch = 0;
	const decisions: DecisionRecord[] = [];
	const pendingBash = new Map<string, { wrapper: PreparedSandboxCommand; originalCommand: string; input: Record<string, unknown> }>();
	const fingerprint = (input: unknown, cwd: string) => JSON.stringify({ cwd, input });

	function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
		if (ctx.hasUI) ctx.ui.notify(`pi-auto: ${message}`, type);
	}
	function status(ctx: ExtensionContext): void {
		ctx.ui.setStatus("pi-auto", loaded?.errors.length ? "pi-auto: settings error" : settings.enabled ? "pi-auto: on · sandbox" : "pi-auto: sandbox pre-review off");
	}
	function load(ctx: ExtensionContext): void {
		authorizationEpoch++;
		loaded = deps.loadSettings(ctx.cwd);
		settings = loaded.settings;
		currentCwd = ctx.cwd;
		for (const error of loaded.errors) notify(ctx, `invalid configuration; tool execution blocked: ${error}`, "error");
		status(ctx);
	}
	function ensureLoaded(ctx: ExtensionContext): void { if (!loaded || currentCwd !== ctx.cwd) load(ctx); }
	function record(ctx: ExtensionContext, action: ReviewableAction, outcome: "allow" | "deny", source: DecisionRecord["source"], result?: ReviewResult): void {
		const entry: DecisionRecord = {
			at: new Date().toISOString(), tool: action.toolName, execution: action.execution, outcome, source,
			fingerprint: createHash("sha256").update(fingerprint(action.input, action.cwd)).digest("hex"),
			...(result ? { latencyMs: result.latencyMs } : {}),
			...(result?.kind === "assessed" ? { risk: result.assessment.risk_level, authorization: result.assessment.user_authorization, evidence: result.assessment.evidence } : {}),
		};
		decisions.push(entry);
		if (decisions.length > 50) decisions.shift();
		const cwd = ctx.cwd;
		logQueue = logQueue.then(() => deps.persistDecision?.(cwd, entry)).catch(() => {
			if (!logWarned) { notify(ctx, "could not persist decision metadata; /auto log still shows this session", "warning"); logWarned = true; }
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
			notify(ctx, scope.reason, "warning");
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
		// Only contained commands may skip pre-review; uncontained tools still need intent.
		if (!settings.enabled && action.execution === "sandbox" && action.toolSource !== "custom") return undefined;
		ctx.ui.setStatus("pi-auto", `pi-auto: reviewing ${event.toolName}`);
		let result: ReviewResult;
		try { result = await deps.reviewAction(action, ctx, settings, signal); }
		catch (error) { result = { kind: "failed", reason: error instanceof Error ? error.message : String(error), latencyMs: 0 }; }
		finally { status(ctx); }
		if (epoch !== authorizationEpoch) return { block: true, reason: "pi-auto session or policy changed during review. Propose the action again for a fresh decision." };
		if (signal?.aborted) return { block: true, reason: "pi-auto review cancelled; action did not run." };
		if (result.kind === "assessed" && result.decision.outcome === "allow") {
			record(ctx, action, "allow", "automatic", result);
			if (settings.notices === "all") notify(ctx, `${action.label} approved (${result.assessment.risk_level}/${result.assessment.user_authorization})`);
			return undefined;
		}
		const reason = result.kind === "failed" ? `Automatic reviewer unavailable: ${result.reason}` : result.decision.reason;
		const hostWarning = action.execution === "host" ? "\nThis command will run with your full host privileges and no pi-auto sandbox. It may affect files, network services, and credentials outside this project." : "";
		let approved = false;
		if (ctx.hasUI) {
			approved = await ctx.ui.confirm("pi-auto · approve this action once?", `${action.label}\n\n${reason}${hostWarning}\n\nExact action:\n${JSON.stringify(action, null, 2)}\n\nAllow this exact action once?`, { signal });
		}
		if (epoch !== authorizationEpoch) return { block: true, reason: "pi-auto session or policy changed during approval. Propose the action again for a fresh decision." };
		if (approved && !signal?.aborted) { record(ctx, action, "allow", "user", result); return undefined; }
		record(ctx, action, "deny", result.kind === "failed" ? "unavailable" : "automatic", result);
		notify(ctx, `${action.label} blocked: ${reason}`, "warning");
		return { block: true, reason: `pi-auto blocked this action before execution. ${reason}${ctx.hasUI ? "" : " User approval is required; interactive or RPC approval is available."}` };
	}

	async function cancelPending(): Promise<void> {
		const pending = [...pendingBash.values()];
		pendingBash.clear();
		await Promise.all(pending.map(({ wrapper, originalCommand, input }) => { input.command = originalCommand; return wrapper.cancel(); }));
	}
	pi.on("tool_call", async (event, ctx) => {
		ensureLoaded(ctx);
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
		const availability = deps.checkSandboxAvailability();
		if (!availability.available) notify(ctx, `sandbox unavailable; sandbox commands will fail closed: ${availability.errors.join("; ")}`, "error");
		for (const warning of availability.warnings) notify(ctx, warning, "warning");
	});
	pi.on("session_tree", async (_event, ctx) => { authorizationEpoch++; if (ctx.isIdle?.()) await cancelPending(); status(ctx); });
	pi.on("before_agent_start", async (event) => {
		authorizationEpoch++; await cancelPending();
		return { systemPrompt: `${event.systemPrompt}\n\n${EXECUTION_GUIDANCE}` };
	});
	pi.on("session_shutdown", async () => { authorizationEpoch++; await cancelPending(); await logQueue; await deps.shutdownSandbox(); });

	pi.registerCommand("auto", {
		description: "pi-auto on, off, status, reload, or log; off pauses sandbox pre-review only",
		async handler(args, ctx) {
			ensureLoaded(ctx);
			const command = args.trim() || "status";
			if (command === "on" || command === "off") {
				authorizationEpoch++;
				settings.enabled = command === "on";
				status(ctx);
				notify(ctx, `sandbox pre-review ${settings.enabled ? "enabled" : "paused"} for this session. Sandbox, hard restrictions, and reviews of host/custom/sensitive filesystem actions remain active.`);
			} else if (command === "reload") {
				await ctx.waitForIdle();
				authorizationEpoch++; await cancelPending();
				await deps.shutdownSandbox(); load(ctx);
				notify(ctx, loaded!.errors.length ? "settings reload failed; execution is blocked" : "fresh v2 settings reloaded", loaded!.errors.length ? "error" : "info");
			} else if (command === "log") {
				notify(ctx, decisions.length ? decisions.map((entry) => `${entry.at} ${entry.tool} ${entry.execution}: ${entry.outcome} (${entry.source}${entry.risk ? `, ${entry.risk}/${entry.authorization}` : ""})`).join("\n") : "no reviewed actions in this session");
			} else if (command === "status") {
				const availability = deps.checkSandboxAvailability();
				notify(ctx, `sandbox pre-review ${settings.enabled ? "on" : "off"}; uncontained action review on; sandbox ${availability.available ? "available" : "unavailable"}; reviewer ${settings.reviewer.model || "active session model"}\nUser settings: ${loaded!.paths.user}\nProject settings: ${loaded!.paths.project}${availability.defaultWritePaths?.length ? `\nRuntime compatibility writes: ${availability.defaultWritePaths.join(", ")}` : ""}${loaded!.errors.length ? `\nErrors: ${loaded!.errors.join("; ")}` : ""}`);
			} else notify(ctx, "usage: /auto on | off | status | reload | log", "warning");
		},
	});
}
