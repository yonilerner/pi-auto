/** The complete configuration and review contract for the minimal extension. */
export type RiskLevel = "low" | "medium" | "high" | "critical";
export type Authorization = "high" | "medium" | "low" | "unknown";
export type Outcome = "allow" | "deny";
export type ExecutionMode = "sandbox" | "host" | "tool";

export interface SandboxSettings {
	allowedDomains: string[];
	deniedDomains: string[];
	allowRead: string[];
	denyRead: string[];
	allowWrite: string[];
	denyWrite: string[];
}

export interface Settings {
	enabled: boolean;
	reviewer: {
		/** Empty provider/model uses the active session model. */
		provider: string;
		model: string;
		/** default/off omit the optional override and use provider defaults. */
		reasoning: "default" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
		timeoutMs: number;
	};
	context: {
		maxEntries: number;
		maxEntryChars: number;
		maxTotalChars: number;
		maxPinnedMessages: number;
	};
	sensitivePaths: string[];
	protectedPaths: string[];
	sandbox: SandboxSettings;
	notices: "denials" | "all";
}

export interface ActionResources {
	reads: string[];
	writes: string[];
	sensitive: string[];
	protected: string[];
}

export interface ReviewableAction {
	toolName: string;
	toolCallId: string;
	description: string;
	toolSource?: "builtin" | "custom";
	input: Record<string, unknown>;
	cwd: string;
	label: string;
	execution: ExecutionMode;
	reason?: string;
	resources?: ActionResources;
}

export type ScopeDecision =
	| { kind: "skip"; reason: string }
	| { kind: "review"; action: ReviewableAction }
	| { kind: "block"; reason: string };

export interface ReviewerAssessment {
	risk_level: RiskLevel;
	user_authorization: Authorization;
	/** IDs of actual user messages in the supplied active-branch context. */
	evidence: string[];
	rationale: string;
}

export interface PolicyDecision {
	outcome: Outcome;
	reason: string;
}

export type ReviewResult =
	| { kind: "assessed"; assessment: ReviewerAssessment; decision: PolicyDecision; latencyMs: number }
	| { kind: "failed"; reason: string; latencyMs: number };

export interface ContextEntry {
	id: string;
	sequence?: number;
	role: "user" | "assistant" | "tool_call" | "tool_result";
	text: string;
	toolName?: string;
	truncated?: boolean;
}

export interface ReviewerContext {
	/** Always the latest original user message on the active branch. */
	currentRequest: ContextEntry | null;
	/** Original earlier user messages selected from the same active branch. */
	userMessages: ContextEntry[];
	/** Execution evidence only; never authorization. */
	recentEvidence: ContextEntry[];
	omittedEntries: number;
}
