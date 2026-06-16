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

import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { parseLooseCommandArgvPrefixes, parseShellLcPlainCommands } from "./bash-parser.ts";
import { CircuitBreaker } from "./circuit-breaker.ts";
import { getLatestDigest, updateDigestForTurn } from "./digest.ts";
import { reviewAction, type ReviewResult } from "./reviewer.ts";
import {
	buildRetryReason,
	checkSandboxAvailability,
	cleanupAfterSandboxCommand,
	detectSandboxDenialForCommand,
	ensureSandboxReady,
	getNetworkAttemptsSince,
	runBareCommand,
	shutdownSandbox,
	wrapBashCommand,
	type SandboxState,
} from "./sandbox.ts";
import { decideScope } from "./scope.ts";
import { registerSettingsCommand } from "./settings-ui.ts";
import { loadSettings } from "./settings-store.ts";
import type { PiAutoSettings, ReviewableAction, ReviewerAssessment, SandboxMode, SettingsLayerMap } from "./types.ts";

const DEFAULT_SETTINGS: PiAutoSettings = {
	reviewerProvider: "openai",
	reviewerModel: "gpt-5-mini",
	// Default false: an unintended fallback to the session model on a typo or
	// outage is usually worse than the reviewer failing closed (we fall back
	// to a user prompt). Users who want auto-fallback can opt in via
	// /pi-auto-settings.
	fallbackToActiveModel: false,
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
	noticeLevel: "normal",
	customPolicy: "",
	reviewerPolicySource: "default",
	extraSafeCommandPrefixes: [],
	// Default to false on both: the policy already polices authorization-source
	// (assistant text doesn't count as auth, tool results don't count as auth),
	// and stripping carries a small loss of context for evidence chains like
	// `git status` -> action. See the README for the ablation comparing
	// gpt-5-mini across baseline, strip-assistant, and strip-both.
	stripAssistantText: false,
	stripToolResults: false,
	sandbox: {
		// Default escape-only — every bash call runs wrapped, the reviewer is
		// only invoked when the sandbox denies. This is the cheapest of the two
		// "on" modes and gives you the OS-level backstop on a fresh install.
		// Set to "off" via /pi-auto-settings if you want the prior behavior
		// (no wrapping; reviewer gates everything).
		mode: "escape-only",
		allowedDomains: [],
		deniedDomains: [],
		allowRead: [],
		denyRead: [],
		allowWrite: ["."],
		denyWrite: [],
		reviewOnlyCommandPrefixes: [],
		showStatusIndicator: true,
		annotateBashDisplay: true,
	},
};

const RISK_GLYPH: Record<ReviewerAssessment["risk_level"], string> = {
	low: "·",
	medium: "○",
	high: "△",
	critical: "✕",
};

/**
 * State for the most recent in-flight sandbox-wrapped bash call, keyed by
 * toolCallId. Populated in `tool_call` when we rewrite a command, read in
 * `tool_result` to recover the original command + decide whether to escape.
 *
 * Map is intentionally unbounded across a session — entries are evicted on
 * `tool_result`. If a tool_call somehow never gets a tool_result the entry
 * leaks for the session lifetime; the memory footprint per entry is small
 * (a string command + small struct).
 */
interface WrappedBashState {
	originalCommand: string;
	mode: "escape-only" | "review-then-escape";
	/**
	 * `Date.now()` captured at tool_call time. Used to scope the
	 * ASRT-callback-captured network attempts to just this command's lifetime
	 * when building the escape-review retry_reason in the tool_result handler.
	 */
	startTime: number;
}

export default function (pi: ExtensionAPI): void {
	// Live settings + layer attribution. Both start at DEFAULT_SETTINGS until
	// session_start runs loadSettings() with the resolved project root, then
	// every field is replaced in place. We keep one object identity for the
	// session so closures (handlers, registered commands) see the latest
	// values without rebinding.
	const settings: PiAutoSettings = structuredClone(DEFAULT_SETTINGS);
	let settingsLayers: SettingsLayerMap = buildInitialLayerMap();
	let settingsPaths: { userGlobal: string | null; perProject: string | null } = {
		userGlobal: null,
		perProject: null,
	};
	const breaker = new CircuitBreaker(settings.maxConsecutiveDenialsPerTurn, settings.maxTotalDenialsPerTurn);

	// Runtime override: when true, ALL tool calls bypass pi-auto entirely
	// (no scope check, no reviewer call, no circuit breaker). Set via
	// /pi-auto-disable, cleared via /pi-auto-enable. In-memory only — a fresh
	// pi launch always starts enabled. The persistent status bar makes the
	// off state hard to miss.
	let disabled = false;

	// Sandbox runtime state. Lazily initialized on first bash call when
	// settings.sandbox.mode != "off" — but validated at session_start so we
	// can hard-error early if the host doesn't support the sandbox.
	const sandboxState: { current: SandboxState } = { current: { kind: "disabled" } };
	// Last sandbox mode for which we reconciled status indicator + warnings.
	// Used in applySandboxMode() to decide whether a change actually happened
	// (and whether to announce it).
	let appliedSandboxMode: SandboxMode = "off";
	const wrappedBashByToolCallId = new Map<string, WrappedBashState>();
	// Most-recent sandbox-denial info, surfaced by /pi-auto-sandbox.
	const recentDenials: Array<{ command: string; reason: string; escapedAllow: boolean; at: number }> = [];
	const RECENT_DENIAL_CAP = 10;

	// Track the current turn so we can scope the circuit breaker per turn.
	let currentTurnId = "boot";
	// Validate sandbox at session start (hard-error policy from interview). We
	// don't initialize the runtime here — that happens lazily on first bash
	// call — but we do the availability + dependency check now so a misconfigured
	// session fails loudly the moment the user launches pi, not on the first
	// bash command.
	pi.on("session_start", async (_event, ctx) => {
		// Load layered settings before anything else looks at them. Subsequent
		// session_start handlers (sandbox availability, UI) will see merged
		// settings. Errors and warnings surface as ui.notify.
		const loaded = loadSettings({ defaults: DEFAULT_SETTINGS, cwd: ctx.cwd });
		assignSettings(settings, loaded.settings);
		settingsLayers = loaded.layers;
		settingsPaths = loaded.paths;
		if (loaded.warnings.length > 0 && ctx.hasUI) {
			for (const w of loaded.warnings) ctx.ui.notify(w, "warning");
		}
		// Rebind the breaker thresholds in case the loaded settings changed them.
		breaker.setThresholds(settings.maxConsecutiveDenialsPerTurn, settings.maxTotalDenialsPerTurn);

		await applySandboxMode(ctx, { source: "session-start" });
	});

	pi.on("session_shutdown", () => {
		void shutdownSandbox(sandboxState);
	});

	/**
	 * Reconcile the OS sandbox runtime + status indicator + announcements
	 * with the current `settings.sandbox.mode`. Called once at session_start
	 * and again after any /pi-auto-settings save. Idempotent.
	 *
	 * Announcement rules:
	 *   - source = "session-start": always announce the active mode (warning
	 *     when OFF so the off posture is visible; info when on).
	 *   - source = "settings-change": announce only on actual mode transition
	 *     (so editing unrelated settings doesn't re-notify).
	 */
	async function applySandboxMode(
		ctx: ExtensionContext,
		opts: { source: "session-start" | "settings-change" },
	): Promise<void> {
		const desired = settings.sandbox.mode;
		const previous = appliedSandboxMode;

		if (desired === "off") {
			// Tear down any existing runtime. shutdownSandbox is a no-op if not
			// initialized.
			await shutdownSandbox(sandboxState);
			sandboxState.current = { kind: "disabled" };
		} else {
			// If switching mode while a runtime exists, reset — ASRT's config is
			// captured at initialize() time. ensureSandboxReady will re-init lazily
			// on the next bash call.
			if (sandboxState.current.kind === "ready" || sandboxState.current.kind === "initializing") {
				await shutdownSandbox(sandboxState);
				sandboxState.current = { kind: "disabled" };
			} else if (sandboxState.current.kind === "broken") {
				// Give it another shot — the user may have just fixed dependencies
				// via the UI (e.g. flipping mode off then on after installing srt).
				sandboxState.current = { kind: "disabled" };
			}

			// Eager availability check so we surface dependency errors immediately
			// rather than on the first bash call (matches the original design).
			const avail = checkSandboxAvailability(settings.sandbox);
			const broken = !avail.supportedPlatform || avail.errors.length > 0;
			if (broken) {
				const msg = [
					`pi-auto sandbox mode="${desired}" but the OS sandbox is unavailable:`,
					...avail.errors.map((e) => `  - ${e}`),
					``,
					`Fix the missing dependencies, or set sandbox.mode = "off" in /pi-auto-settings.`,
				].join("\n");
				if (ctx.hasUI) ctx.ui.notify(msg, "warning");
				else console.error(msg);
				sandboxState.current = { kind: "broken", reason: avail.errors.join("; ") };
			} else if (
				avail.warnings.length > 0 &&
				ctx.hasUI &&
				opts.source === "session-start" &&
				shouldNotify(settings.noticeLevel, "verbose")
			) {
				ctx.ui.notify(`pi-auto sandbox: ${avail.warnings.join("; ")}`, "info");
			}
		}

		refreshSandboxStatus(ctx);

		if (ctx.hasUI) {
			const transition = previous !== desired;
			const shouldAnnounce = opts.source === "session-start" || transition;
			if (shouldAnnounce) {
				if (desired === "off") {
					// Critical posture: the sandbox is off and the user (or a default
					// flip) put it there. Always surface this regardless of noticeLevel.
					ctx.ui.notify(
						"pi-auto sandbox: OFF — no OS-level backstop on bash calls. Re-enable via /pi-auto-settings.",
						"warning",
					);
				} else if (transition && previous === "off" && shouldNotify(settings.noticeLevel, "verbose")) {
					ctx.ui.notify(`pi-auto sandbox: ${desired} — bash calls wrapped`, "info");
				} else if (transition && shouldNotify(settings.noticeLevel, "verbose")) {
					ctx.ui.notify(`pi-auto sandbox: mode changed → ${desired}`, "info");
				}
			}
		}

		appliedSandboxMode = desired;
	}

	/**
	 * Recompute the sandbox status-bar entry from `settings.sandbox.mode`,
	 * `settings.sandbox.showStatusIndicator`, and the runtime state.
	 */
	function refreshSandboxStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (!settings.sandbox.showStatusIndicator) {
			setSandboxStatus(ctx, undefined);
			return;
		}
		setSandboxStatus(ctx, {
			mode: settings.sandbox.mode,
			broken: sandboxState.current.kind === "broken",
		});
	}

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
		if (disabled) return undefined;

		// Sandbox branching for bash. Other tools fall through to the existing
		// scope-based reviewer flow.
		if (event.toolName === "bash" && settings.sandbox.mode !== "off") {
			return await handleBashWithSandbox(event, ctx);
		}

		const scope = decideScope(event, ctx.cwd, settings);
		if (!scope.review) {
			return undefined;
		}

		setStatus(ctx, `reviewing ${event.toolName}…`);
		const result = await reviewAction(scope.action, ctx, settings);
		clearStatus(ctx);

		return handleReviewResult(result, scope.action, ctx, breaker, settings, currentTurnId);
	});

	pi.on("tool_result", async (event, ctx) => {
		if (disabled) return undefined;
		if (event.toolName !== "bash") return undefined;
		const wrap = wrappedBashByToolCallId.get(event.toolCallId);
		if (!wrap) return undefined;
		wrappedBashByToolCallId.delete(event.toolCallId);
		cleanupAfterSandboxCommand();

		const combinedOutput = extractTextContent(event);
		const denial = detectSandboxDenialForCommand(
			wrap.originalCommand,
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
			clearStatus(ctx);
			return {
				content: [
					{
						type: "text",
						text: bare.stdout + (bare.stderr ? `\n[stderr]\n${bare.stderr}` : ""),
					},
				],
				isError: bare.exitCode !== 0,
			};
		} catch (err) {
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
	});

	/**
	 * Bash handler for sandbox modes "escape-only" and "review-then-escape".
	 *
	 * Returns the ToolCallEventResult pi expects. Side effects: mutates
	 * `event.input.command` to substitute the sandbox-wrapped form; populates
	 * `wrappedBashByToolCallId` so the tool_result hook can recover the
	 * original on denial.
	 */
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
			return await handleReviewResult(result, action, ctx, breaker, settings, currentTurnId);
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
					currentTurnId,
				);
				if (gating && gating.block === true) return gating;
			}
		}

		// Initialize the sandbox lazily on first wrap. We've already validated
		// availability at session_start, so a failure here is exceptional.
		const ready = await ensureSandboxReady(settings, ctx.cwd, sandboxState);
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
			const wrapped = await wrapBashCommand(originalCommand, ctx.cwd);
			// Mutate the event input in place so pi runs the wrapped command. Per
			// the pi extension docs (tool_call) this is the supported path for
			// argument patching. The user will see the wrapped form in the bash
			// tool display — there isn't currently a pi API to display X while
			// executing Y. annotateBashDisplay is reserved for a future hook.
			(event.input as { command?: unknown }).command = wrapped;
			wrappedBashByToolCallId.set(event.toolCallId, {
				originalCommand,
				mode: settings.sandbox.mode === "review-then-escape" ? "review-then-escape" : "escape-only",
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

	// Allow user to inspect/tweak settings at runtime.
	pi.registerCommand("pi-auto", {
		description: "Show pi-auto configuration and recent activity",
		handler: async (_args, ctx) => {
			const digestState = getLatestDigest(ctx.sessionManager);
			const lines = [
				`pi-auto: ${disabled ? "DISABLED — all tool calls run without review" : "enabled"}`,
				``,
				`settings:`,
				`  reviewer:                  ${settings.reviewerProvider}/${settings.reviewerModel}`,
				`  fallback to active model:  ${settings.fallbackToActiveModel}`,
				`  timeout:                   ${settings.reviewerTimeoutMs}ms`,
				`  circuit breaker:           ${settings.maxConsecutiveDenialsPerTurn} consecutive / ${settings.maxTotalDenialsPerTurn} total per turn`,
				`  transcript cap:            ${settings.maxTranscriptEntries} entries / ${settings.maxEntryChars} chars each / ${settings.maxTranscriptTotalChars} total`,
				`  pinned related entries:    up to ${settings.maxPinnedRelatedEntries}`,
				`  summary entries kept:      up to ${settings.maxSummaryEntries}`,
				`  rolling digest:            ${settings.enableDigest ? "on" : "off"}`,
				`  notice level:              ${settings.noticeLevel}`,
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
		description:
			"DEPRECATED. Cycle pi-auto noticeLevel (silent → denials → normal → verbose). Prefer /pi-auto-settings.",
		handler: async (_args, ctx) => {
			const order: PiAutoSettings["noticeLevel"][] = [
				"silent",
				"denials",
				"normal",
				"verbose",
			];
			const i = order.indexOf(settings.noticeLevel);
			settings.noticeLevel = order[(i + 1) % order.length] ?? "normal";
			if (ctx.hasUI) {
				ctx.ui.notify(`pi-auto noticeLevel: ${settings.noticeLevel}`, "info");
			}
		},
	});

	pi.registerCommand("pi-auto-disable", {
		description:
			"Pause pi-auto review. All tool calls will run without review until /pi-auto-enable.",
		handler: async (_args, ctx) => {
			if (disabled) {
				if (ctx.hasUI) ctx.ui.notify("pi-auto is already disabled", "info");
				return;
			}
			disabled = true;
			if (ctx.hasUI) {
				ctx.ui.notify(
					"pi-auto: DISABLED — tool calls will run without review until /pi-auto-enable",
					"warning",
				);
				setDisabledStatus(ctx, true);
			}
		},
	});

	pi.registerCommand("pi-auto-sandbox", {
		description: "Show pi-auto sandbox status, current config, and recent denials",
		handler: async (_args, ctx) => {
			const s = settings.sandbox;
			const lines = [
				`pi-auto sandbox: mode = ${s.mode}`,
				``,
				`runtime state: ${sandboxState.current.kind}${
					sandboxState.current.kind === "broken" ? ` (${sandboxState.current.reason})` : ""
				}`,
				``,
				`network:`,
				`  allowed domains: ${s.allowedDomains.length ? s.allowedDomains.join(", ") : "(none — no network)"}`,
				`  denied domains:  ${s.deniedDomains.length ? s.deniedDomains.join(", ") : "(none)"}`,
				`filesystem:`,
				`  allow read:      ${s.allowRead.length ? s.allowRead.join(", ") : "(runtime defaults)"}`,
				`  deny read:       ${s.denyRead.length ? s.denyRead.join(", ") : "(none)"}`,
				`  allow write:     ${s.allowWrite.length ? s.allowWrite.join(", ") : "(none)"}`,
				`  deny write:      ${s.denyWrite.length ? s.denyWrite.join(", ") : "(none)"}`,
				`ui:`,
				`  status indicator: ${s.showStatusIndicator}`,
				`  annotate bash:    ${s.annotateBashDisplay}`,
				`  notice level:     ${settings.noticeLevel} (see /pi-auto-settings)`,
			];
			if (recentDenials.length > 0) {
				lines.push("", `recent denials (most recent first):`);
				for (const d of [...recentDenials].reverse()) {
					const when = new Date(d.at).toISOString();
					const outcome = d.escapedAllow ? "escape ALLOWED" : "escape DENIED";
					lines.push(`  [${when}] ${outcome} (${d.reason}): ${d.command.slice(0, 200)}`);
				}
			} else {
				lines.push("", `recent denials: none`);
			}
			if (ctx.hasUI) {
				ctx.ui.notify(lines.join("\n"), "info");
			} else {
				console.log(lines.join("\n"));
			}
		},
	});

	registerSettingsCommand(pi, {
		getSettings: () => settings,
		applySettings: (next) => assignSettings(settings, next),
		getLayers: () => settingsLayers,
		setLayers: (next) => {
			settingsLayers = next;
		},
		getPaths: () => settingsPaths,
		setPaths: (next) => {
			settingsPaths = next;
		},
		defaults: DEFAULT_SETTINGS,
		// Called after every successful /pi-auto-settings save. We reconcile
		// side-effecty bits (sandbox runtime, status indicator, breaker
		// thresholds) that the loader can't touch on its own.
		onSettingsApplied: async (ctx) => {
			breaker.setThresholds(settings.maxConsecutiveDenialsPerTurn, settings.maxTotalDenialsPerTurn);
			await applySandboxMode(ctx, { source: "settings-change" });
		},
	});

	pi.registerCommand("pi-auto-enable", {
		description: "Re-enable pi-auto review after /pi-auto-disable.",
		handler: async (_args, ctx) => {
			if (!disabled) {
				if (ctx.hasUI) ctx.ui.notify("pi-auto is already enabled", "info");
				return;
			}
			disabled = false;
			if (ctx.hasUI) {
				ctx.ui.notify("pi-auto: enabled — review is active", "info");
				setDisabledStatus(ctx, false);
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
		if (shouldNotify(settings.noticeLevel, "normal") && ctx.hasUI) {
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

/**
 * Persistent status-bar indicator shown for as long as pi-auto is disabled.
 * Uses a different status key than `setStatus` (the transient "reviewing…"
 * indicator) so the two don't overwrite each other.
 *
 * The text is wrapped in ANSI bright-red so the off state visibly stands out
 * in the status bar. Pi's TUI passes ANSI escapes through (see
 * `wrapTextWithAnsi` in pi's tui docs); on terminals without color support
 * the codes are simply ignored and the plain text still appears.
 */
/**
 * Sandbox lock indicator. Lives in its own status-bar key so it doesn't
 * collide with the disabled-state indicator or the transient "reviewing…"
 * text. ANSI green padlock means sandbox is engaged this session.
 */
function setSandboxStatus(
	ctx: { hasUI: boolean; ui: { setStatus: (key: string, text: string | undefined) => void } },
	display: { mode: SandboxMode; broken: boolean } | undefined,
): void {
	if (!ctx.hasUI) return;
	const GREEN = "\x1b[92m";
	const RED = "\x1b[91m";
	const YELLOW = "\x1b[93m";
	const RESET = "\x1b[0m";
	let text: string | undefined;
	if (display === undefined) {
		text = undefined;
	} else if (display.broken) {
		text = `${RED}·sandbox BROKEN${RESET}`;
	} else if (display.mode === "off") {
		text = `${YELLOW}·sandbox OFF${RESET}`;
	} else {
		text = `${GREEN}·sandbox${RESET}`;
	}
	try {
		ctx.ui.setStatus("pi-auto-sandbox", text);
	} catch {
		// older pi versions may not support setStatus in all contexts
	}
}

/**
 * Concatenate the text parts of a tool_result event's content for sandbox
 * denial-pattern detection. Image content is ignored (bash never emits it
 * here, but the type allows it).
 */
function extractTextContent(event: ToolResultEvent): string {
	let out = "";
	for (const c of event.content) {
		if (c.type === "text") out += c.text;
	}
	return out;
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

export type SandboxReviewOnlyPrefixDecision =
	| { kind: "match" }
	| { kind: "unsupported"; reason: string }
	| { kind: "no-match" };

export function matchesSandboxReviewOnlyPrefix(
	command: string,
	prefixes: readonly (readonly string[])[],
): boolean {
	return decideSandboxReviewOnlyPrefix(command, prefixes).kind === "match";
}

export function decideSandboxReviewOnlyPrefix(
	command: string,
	prefixes: readonly (readonly string[])[],
): SandboxReviewOnlyPrefixDecision {
	if (prefixes.length === 0) return { kind: "no-match" };
	const plainCommands = parseShellLcPlainCommands(["bash", "-lc", command]);
	if (plainCommands && plainCommands.length > 0) {
		const matched = plainCommands.filter((argv) => matchesAnyCommandPrefix(argv, prefixes));
		if (matched.length === plainCommands.length) return { kind: "match" };
		if (matched.length > 0) return { kind: "unsupported", reason: buildReviewOnlyUnsupportedReason(prefixes, command, "not every command in the script matches a review-only prefix") };
		return { kind: "no-match" };
	}

	const loosePrefixes = parseLooseCommandArgvPrefixes(command);
	if (loosePrefixes.some((argv) => couldMatchAnyCommandPrefix(argv, prefixes))) {
		return { kind: "unsupported", reason: buildReviewOnlyUnsupportedReason(prefixes, command, "the command uses shell syntax that review-only routing does not support") };
	}
	return { kind: "no-match" };
}

function buildReviewOnlyUnsupportedReason(
	prefixes: readonly (readonly string[])[],
	command: string,
	detail: string,
): string {
	return [
		"pi-auto blocked this bash command before sandboxing because it appears to use a configured sandbox.reviewOnlyCommandPrefixes entry, but cannot be routed safely.",
		`Reason: ${detail}.`,
		`Configured prefixes: ${prefixes.map((p) => p.join(" ")).join(", ")}.`,
		`Command: ${truncate(command, 500)}`,
		"Rewrite it as plain argv-only command(s) where every command starts with a review-only prefix. For multiline text, prefer a temporary file plus --body-file over shell quoting, substitution, or redirection.",
	].join("\n");
}

function matchesAnyCommandPrefix(
	argv: readonly string[],
	prefixes: readonly (readonly string[])[],
): boolean {
	return prefixes.some((prefix) => matchesCommandPrefix(argv, prefix));
}

function matchesCommandPrefix(argv: readonly string[], prefix: readonly string[]): boolean {
	// Do not basename argv[0]: [["gh"]] must not match ./gh or /tmp/gh.
	// Pathful commands must be configured and matched exactly.
	if (prefix.length === 0 || argv.length < prefix.length) return false;
	for (let i = 0; i < prefix.length; i++) {
		if ((argv[i] ?? "") !== prefix[i]) return false;
	}
	return true;
}

function couldMatchAnyCommandPrefix(
	argvPrefix: readonly string[],
	prefixes: readonly (readonly string[])[],
): boolean {
	return prefixes.some((prefix) => couldMatchCommandPrefix(argvPrefix, prefix));
}

function couldMatchCommandPrefix(argvPrefix: readonly string[], prefix: readonly string[]): boolean {
	// Keep unsupported-syntax detection aligned with exact command matching.
	if (prefix.length === 0 || argvPrefix.length === 0) return false;
	const n = Math.min(argvPrefix.length, prefix.length);
	for (let i = 0; i < n; i++) {
		if ((argvPrefix[i] ?? "") !== prefix[i]) return false;
	}
	return true;
}

function truncate(s: string, n: number): string {
	return s.length <= n ? s : `${s.slice(0, n)}…`;
}

function setDisabledStatus(
	ctx: { hasUI: boolean; ui: { setStatus: (key: string, text: string | undefined) => void } },
	off: boolean,
): void {
	if (!ctx.hasUI) return;
	const BRIGHT_RED = "\x1b[91m";
	const RESET = "\x1b[0m";
	try {
		ctx.ui.setStatus(
			"pi-auto-disabled",
			off ? `${BRIGHT_RED}pi-auto OFF${RESET}` : undefined,
		);
	} catch {
		// older pi versions may not support setStatus in all contexts
	}
}

/**
 * Replace `target`'s fields with `source`'s, in place. Keeps the object
 * identity so any closures already holding a reference to the live
 * settings object see the new values. Used after settings reload.
 */
/**
 * Notice levels arranged from least to most chatty. The numeric index
 * doubles as the precedence used by `shouldNotify`.
 */
const NOTICE_LEVEL_ORDER = ["silent", "denials", "normal", "verbose"] as const;

/**
 * Should a notification at the given severity-tier be emitted given the
 * user's configured noticeLevel?
 *
 * Tiers, lowest → highest:
 *   - "critical":  always shown. Sandbox unavailable, settings load errors,
 *                 sandbox-OFF startup warning — the user needs to know.
 *   - "denials":   denied / blocked actions. Reviewer deny, sandbox denial,
 *                 escape-reviewer deny or unavailable, circuit-breaker trip.
 *   - "normal":    successful actions worth confirming. Reviewer allow,
 *                  sandbox-denied-but-escape-allowed, re-execution outcome.
 *   - "verbose":   debugging-flavored. Sandbox mode-change confirmations,
 *                  init warnings.
 */
export function shouldNotify(
	noticeLevel: PiAutoSettings["noticeLevel"],
	tier: "critical" | "denials" | "normal" | "verbose",
): boolean {
	if (tier === "critical") return true;
	const tierIndex = NOTICE_LEVEL_ORDER.indexOf(tier);
	const configuredIndex = NOTICE_LEVEL_ORDER.indexOf(noticeLevel);
	return configuredIndex >= tierIndex;
}

function assignSettings(target: PiAutoSettings, source: PiAutoSettings): void {
	for (const key of Object.keys(source) as Array<keyof PiAutoSettings>) {
		// biome-ignore lint/suspicious/noExplicitAny: shallow copy of a typed shape
		(target as any)[key] = (source as any)[key];
	}
}

/**
 * Pre-session_start layer map. Everything points at "default" until
 * loadSettings runs. Allows the UI to be opened before session_start would
 * complete (defensive — shouldn't normally happen).
 */
function buildInitialLayerMap(): SettingsLayerMap {
	const map = {} as SettingsLayerMap;
	for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof PiAutoSettings>) {
		map[key] = "default";
	}
	return map;
}
