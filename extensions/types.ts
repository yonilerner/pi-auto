/**
 * Shared types for pi-auto.
 *
 * Mirrors the structured contract from Codex's Guardian reviewer:
 *   { risk_level, user_authorization, outcome, rationale }
 */

export type RiskLevel = "low" | "medium" | "high" | "critical";
export type UserAuthorization = "high" | "medium" | "low" | "unknown";
export type Outcome = "allow" | "deny";

/**
 * Granularity of inline notice messages.
 *
 *  - "silent":  no routine notices. Critical posture warnings still show
 *              (sandbox unavailable, settings file malformed, sandbox-OFF
 *              startup warning) — those tell the user something is
 *              actively wrong or unsafe and can't be muted via this knob.
 *  - "denials": + every blocked or denied action (reviewer deny, sandbox
 *              denial, escape-reviewer denial, escape-reviewer unavailable,
 *              circuit-breaker trip).
 *  - "normal": + every allowed action (reviewer allow with rationale,
 *              sandbox-denied-but-escape-allowed info, re-execution
 *              outcomes). This is the default.
 *  - "verbose":+ sandbox mode-change confirmations and initialization
 *              warnings. For debugging.
 *
 * Replaces the older boolean pair `announceAllows` + `sandbox.alwaysAnnounceDenials`.
 */
export type NoticeLevel = "silent" | "denials" | "normal" | "verbose";

/**
 * Sandbox modes for bash tool calls (see README and docs/sandbox.md).
 *
 *  - "off":               current behavior. Reviewer gates every bash call, nothing
 *                        runs in an OS sandbox.
 *  - "escape-only":      every bash call runs wrapped in the OS sandbox. The
 *                        reviewer is invoked ONLY when the sandbox denies the
 *                        command — to decide whether it's safe to re-run the
 *                        command outside the sandbox.
 *  - "review-then-escape": every bash call goes through the reviewer first.
 *                        If the reviewer allows, the command runs wrapped in
 *                        the OS sandbox. If the sandbox then denies, a second
 *                        reviewer pass decides whether to escape and run
 *                        outside.
 *
 * read / write / edit tool calls are NOT affected by sandbox mode — they
 * always go through the existing pi-auto path-scoping reviewer (the OS
 * sandbox cannot wrap in-process tool calls).
 */
export type SandboxMode = "off" | "escape-only" | "review-then-escape";

/**
 * Subset of `@anthropic-ai/sandbox-runtime`'s SandboxRuntimeConfig that we
 * expose through PiAutoSettings. We intentionally only surface the fields
 * that are routinely tuned per-project; everything else is left to the
 * runtime defaults. The settings object is mapped into a full
 * SandboxRuntimeConfig inside extensions/sandbox.ts.
 */
export interface SandboxSettings {
	/** Mode. See SandboxMode. */
	mode: SandboxMode;
	/**
	 * Network: allowed domains. Empty array (default) = no network. Supports
	 * `*.example.com` wildcards. `"*"` allows everything (warning shown).
	 */
	allowedDomains: string[];
	/**
	 * Network: denied domains. Checked first; takes precedence over allow.
	 */
	deniedDomains: string[];
	/**
	 * Network: disable the runtime's default NO_PROXY/no_proxy injection for
	 * loopback, .local, link-local, and private network ranges. Default false
	 * preserves ASRT's bypass env vars; true sends those destinations through
	 * the sandbox proxy for clients that honor proxy env vars.
	 */
	disableDefaultNoProxy: boolean;
	/**
	 * Filesystem: paths the sandbox may read. By default we trust the runtime's
	 * built-in read defaults (read is allowed everywhere, then the runtime
	 * applies its own denies for sensitive system locations).
	 */
	allowRead: string[];
	/**
	 * Filesystem: paths the sandbox is forbidden from reading. Stacks with the
	 * runtime's built-in sensitive-path denies.
	 */
	denyRead: string[];
	/**
	 * Filesystem: paths the sandbox may write. Default includes the current
	 * workspace (`.`); removing it removes workspace write access.
	 */
	allowWrite: string[];
	/**
	 * Filesystem: paths the sandbox is forbidden from writing, even when they
	 * fall inside an allowWrite root. Hard-blocks; never prompted.
	 */
	denyWrite: string[];
	/**
	 * Bash argv prefixes that should bypass the initial sandbox attempt and run
	 * only after reviewer approval. Use for tools that are incompatible with the
	 * sandbox in misleading ways (for example, tools that require OS keyrings).
	 */
	reviewOnlyCommandPrefixes: string[][];
	/**
	 * Filenames to drop from `@anthropic-ai/sandbox-runtime`'s hardcoded
	 * `DANGEROUS_FILES` mandatory-deny set before sandbox initialization.
	 *
	 * Entries must match the exact basename ASRT denies. As of this writing
	 * the candidates are: `.gitconfig`, `.gitmodules`, `.bashrc`, `.bash_profile`,
	 * `.zshrc`, `.zprofile`, `.profile`, `.ripgreprc`, `.mcp.json`. Unknown
	 * entries are ignored (so it's safe to list a name ASRT may add later).
	 *
	 * Common use: add `.gitmodules` so `git`/`but`/`gh` stop logging a benign
	 * `permission denied` on every invocation (libgit2 stats `.gitmodules` to
	 * detect submodules). Trade-off: each entry removed is one fewer guard
	 * against shell-rc/config-file exploits inside the sandbox. Only add files
	 * you understand the impact of — e.g. `.gitconfig` allows `[core] sshCommand`
	 * style code execution, whereas `.gitmodules` is inert unless you also run
	 * `git submodule update`.
	 */
	allowedDangerousFiles: string[];
	/**
	 * Status-bar lock indicator when mode != off.
	 */
	showStatusIndicator: boolean;
	/**
	 * Inline `[sandboxed]` tag on the bash tool-call display.
	 */
	annotateBashDisplay: boolean;
}

export interface ReviewerAssessment {
	risk_level: RiskLevel;
	user_authorization: UserAuthorization;
	outcome: Outcome;
	rationale: string;
}

/** Why the reviewer was bypassed or what happened during review. */
export type ReviewSource =
	| { kind: "skipped"; reason: string }
	| { kind: "assessed"; assessment: ReviewerAssessment }
	| { kind: "failed"; reason: string }
	| { kind: "user_approved"; reason: string }
	| { kind: "user_denied"; reason: string };

export interface ReviewableAction {
	toolName: string;
	toolCallId: string;
	/** A short pretty label for display, e.g. `bash: rm -rf foo`. */
	label: string;
	/** The full structured action payload that the reviewer sees. */
	payload: Record<string, unknown>;
}

/**
 * Where a settings field's effective value came from. Used by the
 * /pi-auto-settings UI to display which layer each setting loaded from
 * and to scope writes to the correct file.
 *
 *  - "default":     compiled-in DEFAULT_SETTINGS.
 *  - "user-global": $PI_AGENT_DIR/extensions/pi-auto.json (default
 *                   ~/.pi/agent/extensions/pi-auto.json).
 *  - "per-project": .agents/pi-auto.json at the project root.
 *  - "env":         PI_AUTO_* environment variable override.
 */
export type SettingsLayer = "default" | "user-global" | "per-project" | "env";

/**
 * Per-field map showing which SettingsLayer each PiAutoSettings field was
 * loaded from. Built during loadSettings(); read by the UI. Fields that
 * weren't overridden by any non-default layer appear as "default".
 */
export type SettingsLayerMap = { [K in keyof PiAutoSettings]: SettingsLayer };

export interface PiAutoSettings {
	/** Provider for the reviewer model, e.g. "openai". */
	reviewerProvider: string;
	/** Model id, e.g. "gpt-5-mini". */
	reviewerModel: string;
	/** Whether to fall back to the active agent model if the reviewer model is unavailable. */
	fallbackToActiveModel: boolean;
	/** Timeout for the reviewer call. */
	reviewerTimeoutMs: number;
	/** Maximum consecutive denials in a turn before interrupting. */
	maxConsecutiveDenialsPerTurn: number;
	/** Maximum total denials in a turn before interrupting. */
	maxTotalDenialsPerTurn: number;
	/** Cap on the most-recent-entries window of the transcript. */
	maxTranscriptEntries: number;
	/** Per-entry char cap when building the transcript. Entries are truncated from the middle (head + tail kept). */
	maxEntryChars: number;
	/** Hard cap on total characters in the assembled transcript. Final guard against runaway prompts. */
	maxTranscriptTotalChars: number;
	/** Maximum action-keyword-pinned entries surfaced from outside the recent window. */
	maxPinnedRelatedEntries: number;
	/** Maximum compaction / branch summaries included in the transcript. */
	maxSummaryEntries: number;
	/** Whether to update the rolling auth digest at the end of each turn. */
	enableDigest: boolean;
	/**
	 * If true, use OpenAI's `codex-auto-review` model for the reviewer instead of
	 * `reviewerProvider`/`reviewerModel`. This is the same fine-tuned model Codex
	 * uses for its Auto-review feature — GPT-5.4 Thinking with low reasoning, trained
	 * specifically for safety review of agent actions. Requires an OpenAI API key.
	 */
	useCodexAutoReview: boolean;
	/** Sensitive path patterns (substring match). Reads matching these are reviewed even inside cwd. */
	sensitivePathPatterns: string[];
	/**
	 * Extra known-safe command prefixes that bypass the reviewer entirely.
	 * Each prefix matches if it is a token-by-token prefix of the proposed argv.
	 * Example: `[["npm", "test"], ["pnpm", "lint"]]`.
	 */
	extraSafeCommandPrefixes: string[][];
	/**
	 * Granularity of inline notice messages. Replaces the older
	 * `announceAllows` boolean + the sandbox `alwaysAnnounceDenials` boolean
	 * with a single dial. See `NoticeLevel`.
	 */
	noticeLevel: NoticeLevel;
	/** Custom policy text appended after the base policy. Empty = use defaults. */
	customPolicy: string;
	/**
	 * Which reviewer policy template to use.
	 *
	 *  - "default":         our tuned policy (extensions/policy.ts BASE_POLICY).
	 *  - "codex-verbatim":  the codex Guardian policy mirrored at
	 *                      extensions/policies/codex-guardian-policy.md.
	 *                      The customPolicy field is spliced into codex's
	 *                      `{tenant_policy_config}` slot when this is set.
	 *
	 * Mostly useful for benchmarks; our policy beats codex's verbatim policy
	 * on our scenario set (see docs/HISTORY.md). The env var
	 * `PI_AUTO_USE_CODEX_POLICY=1` overrides this field to "codex-verbatim".
	 */
	reviewerPolicySource: "default" | "codex-verbatim";
	/**
	 * Strip assistant prose from the transcript shown to the reviewer.
	 *
	 * Tool calls emitted by the assistant are still included (they're the audit
	 * trail of what the agent did). Only the natural-language text content of
	 * assistant messages is dropped. Rationale: assistant prose can rationalize
	 * a bad action ("as we discussed, you authorized this") and persuade the
	 * reviewer. Anthropic's auto-mode classifier strips it for this reason.
	 * See README for the ablation notes.
	 */
	stripAssistantText: boolean;
	/**
	 * Strip tool-result entries from the transcript shown to the reviewer.
	 *
	 * Tool calls are still included (so the reviewer sees what the agent ran);
	 * only the output of those calls is dropped. Rationale: tool results are
	 * the canonical prompt-injection vector — content from files, web pages, or
	 * external services that can claim "the user authorized X". Our policy
	 * already ignores authorization claims from tool results, but stripping
	 * them entirely removes the attack surface structurally. Tradeoff:
	 * the reviewer loses visibility into evidence the agent gathered before
	 * acting (e.g. `git status` output confirming uncommitted work).
	 */
	stripToolResults: boolean;
	/**
	 * OS-level sandbox configuration. The `mode` sub-field controls whether
	 * bash tool calls are wrapped, reviewed-then-wrapped, or untouched. See
	 * SandboxMode and SandboxSettings.
	 */
	sandbox: SandboxSettings;
}
