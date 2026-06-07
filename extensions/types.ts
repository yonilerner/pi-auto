/**
 * Shared types for pi-auto.
 *
 * Mirrors the structured contract from Codex's Guardian reviewer:
 *   { risk_level, user_authorization, outcome, rationale }
 */

export type RiskLevel = "low" | "medium" | "high" | "critical";
export type UserAuthorization = "high" | "medium" | "low" | "unknown";
export type Outcome = "allow" | "deny";

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
}
