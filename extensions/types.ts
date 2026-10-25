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
	/** false disables all pi-auto review, path gating, and bash sandboxing. */
	enabled: boolean;
	reviewer: {
		/** Dedicated reviewer; never inherits or falls back to the active session model. */
		provider: string;
		model: string;
		/** default/off omit the compat override; Luna maps off to API effort none. */
		reasoning: "default" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
		timeoutMs: number;
		/** auto constrains supported OpenAI Responses models; off uses prompt-only JSON. */
		structuredOutput: "auto" | "off";
		/** Persist content-free reviewer diagnostics; session /auto debug toggles this too. */
		debug: boolean;
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

export type AssessmentField = "risk_level" | "user_authorization" | "evidence" | "rationale";
export type ReviewValidationCode = "empty_response" | "invalid_json" | "not_object" | "missing_fields" | "unexpected_fields" | "invalid_field" | "output_truncated";
export interface AssessmentValidationIssue {
	code: ReviewValidationCode;
	field?: AssessmentField;
	rule?: "type" | "enum" | "max_items" | "item_type" | "item_empty" | "item_length" | "empty" | "max_length";
	missing?: AssessmentField[];
	extraFieldCount?: number;
}
export type ReviewFailureCode = ReviewValidationCode | "model_unavailable" | "auth_error" | "request_too_large" | "provider_error" | "provider_refusal" | "timeout" | "cancelled";
export interface ReviewAttemptDiagnostic {
	attempt: number;
	latencyMs: number;
	maxTokens: number;
	stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted" | "unknown";
	contentTypes?: ("text" | "thinking" | "toolCall" | "other")[];
	textChars?: number;
	responseHash?: string;
	httpStatus?: number;
	error?: ReviewFailureCode;
	validation?: AssessmentValidationIssue;
}
/** Only host-generated metadata: never prompts, arguments, response text, rationale, or provider errors. */
export interface ReviewDiagnostics {
	id: string;
	provider: string;
	model: string;
	api?: string;
	reasoning: Settings["reviewer"]["reasoning"];
	format: "json_schema" | "prompt";
	attempts: ReviewAttemptDiagnostic[];
	failure?: ReviewFailureCode;
}
export type ReviewResult =
	| { kind: "assessed"; assessment: ReviewerAssessment; decision: PolicyDecision; latencyMs: number; diagnostics?: ReviewDiagnostics }
	| { kind: "failed"; reason: string; latencyMs: number; failureCode?: ReviewFailureCode; diagnostics?: ReviewDiagnostics };

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
