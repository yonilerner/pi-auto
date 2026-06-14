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
	 * Filesystem: paths the sandbox may write. Empty array = no writes
	 * permitted. Default is the current working directory + /tmp.
	 */
	allowWrite: string[];
	/**
	 * Filesystem: paths the sandbox is forbidden from writing, even when they
	 * fall inside an allowWrite root. Hard-blocks; never prompted.
	 */
	denyWrite: string[];
	/**
	 * Status-bar lock indicator when mode != off.
	 */
	showStatusIndicator: boolean;
	/**
	 * Inline `[sandboxed]` tag on the bash tool-call display.
	 */
	annotateBashDisplay: boolean;
	/**
	 * On every sandbox denial, even when the reviewer approves the escape,
	 * surface the violation reason in the UI as a notify.
	 */
	alwaysAnnounceDenials: boolean;
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
	/** Verbose: print rationale inline for every allow. */
	announceAllows: boolean;
	/** Custom policy text appended after the base policy. Empty = use defaults. */
	customPolicy: string;
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
