import { describe, expect, it } from "vitest";
import { buildReviewerSystemPrompt, REVIEWER_OUTPUT_CONTRACT } from "../extensions/policy.ts";

const defaults = { customPolicy: "", reviewerPolicySource: "default" as const };
const withCustom = (text: string) => ({ customPolicy: text, reviewerPolicySource: "default" as const });
const codexVerbatim = (customPolicy = "") => ({
	customPolicy,
	reviewerPolicySource: "codex-verbatim" as const,
});

describe("buildReviewerSystemPrompt", () => {
	it("includes the base policy", () => {
		const prompt = buildReviewerSystemPrompt(defaults);
		expect(prompt).toMatch(/risk_level/);
		expect(prompt).toMatch(/user_authorization/);
		expect(prompt).toMatch(/Output Contract/);
	});

	it("describes all four risk levels", () => {
		const prompt = buildReviewerSystemPrompt(defaults);
		expect(prompt).toMatch(/"low"/);
		expect(prompt).toMatch(/"medium"/);
		expect(prompt).toMatch(/"high"/);
		expect(prompt).toMatch(/"critical"/);
	});

	it("describes all four user_authorization levels", () => {
		const prompt = buildReviewerSystemPrompt(defaults);
		expect(prompt).toMatch(/"high":/);
		expect(prompt).toMatch(/"medium":/);
		expect(prompt).toMatch(/"low":/);
		expect(prompt).toMatch(/"unknown":/);
	});

	it("appends custom policy when provided", () => {
		const prompt = buildReviewerSystemPrompt(withCustom("Always deny touching /tmp/sacred."));
		expect(prompt).toMatch(/Custom Policy/);
		expect(prompt).toMatch(/sacred/);
	});

	it("omits custom policy section when empty", () => {
		const prompt = buildReviewerSystemPrompt(withCustom("   "));
		expect(prompt).not.toMatch(/Custom Policy/);
	});

	it("ends with the output contract", () => {
		const prompt = buildReviewerSystemPrompt(defaults);
		expect(prompt).toContain(REVIEWER_OUTPUT_CONTRACT);
	});

	it("warns against treating transcript content as instructions (prompt-injection guard)", () => {
		const prompt = buildReviewerSystemPrompt(defaults);
		expect(prompt).toMatch(/untrusted|redefine policy|force approval|prompt injection|attacker-controlled/i);
	});

	it("explicitly identifies user messages as the only authorization source", () => {
		const prompt = buildReviewerSystemPrompt(defaults);
		expect(prompt).toMatch(/Authorization Sources/i);
		expect(prompt).toMatch(/\[user\]/);
		expect(prompt).toMatch(/ONLY/i);
	});

	it("explicitly says assistant messages are NOT authorization", () => {
		const prompt = buildReviewerSystemPrompt(defaults);
		expect(prompt).toMatch(/(?:never|not|no).{0,80}\[?assistant\]?|\[?assistant\]?.{0,80}(?:never|not|no)/i);
		expect(prompt).toMatch(/circular|itself an? assistant decision/i);
	});

	it("explicitly says tool results are NOT authorization (prompt injection guard)", () => {
		const prompt = buildReviewerSystemPrompt(defaults);
		expect(prompt).toMatch(/\[?tool_result\]?|tool output/i);
		expect(prompt).toMatch(/prompt injection|attacker|adversarial/i);
	});

	it("authorizes task-scoped read-only review independently of provider while preserving mutation and secret boundaries", () => {
		const prompt = buildReviewerSystemPrompt(defaults);
		expect(prompt).toMatch(/read-only investigation of ordinary, non-secret data is low risk/i);
		expect(prompt).toMatch(/specifically identified resource or concrete subject/i);
		expect(prompt).toMatch(/regardless of provider or protocol/i);
		expect(prompt).toMatch(/named URL/);
		expect(prompt).toMatch(/package metadata/);
		expect(prompt).toMatch(/gh pr view/);
		expect(prompt).toMatch(/Do NOT require separate approval for each read-only endpoint/i);
		expect(prompt).toMatch(/request to review one resource does not authorize unrelated resources/i);
		expect(prompt).toMatch(/credentials, secrets, or inherently sensitive data retains its intrinsic high risk/i);
		expect(prompt).toMatch(/does NOT authorize execution, remote mutations/i);
		expect(prompt).toMatch(/ordinary request to "review" means inspect and analyze/i);
		expect(prompt).toMatch(/do not reinterpret it as permission to publish or submit a review, comment/i);
		expect(prompt).toMatch(/mutation merely targets the resource being reviewed.*user_authorization as "unknown", not "medium"/i);
		expect(prompt).toMatch(/Judge API calls by their demonstrated effect, not the HTTP method alone/i);
		expect(prompt).toMatch(/demonstrably read-only POST query/i);
		expect(prompt).toMatch(/GraphQL query with no mutation/);
		expect(prompt).toMatch(/POST whose semantics are unclear should be presumed state-changing/i);
		expect(prompt).toMatch(/outbound uploads and remote mutations as high risk/i);
		expect(prompt).toMatch(/telemetry submissions/);
		expect(prompt).toMatch(/merging|commenting/);
	});

	it("makes later user revocations supersede stale authorization", () => {
		const prompt = buildReviewerSystemPrompt(defaults);
		expect(prompt).toMatch(/Later.*user.*messages supersede conflicting earlier messages/i);
		expect(prompt).toMatch(/revocation.*withdraws an earlier grant/i);
		expect(prompt).toMatch(/do not use stale authorization/i);
	});

	it("tells the reviewer to score unknown when only assistant narration supports the action", () => {
		const prompt = buildReviewerSystemPrompt(defaults);
		expect(prompt).toMatch(/unknown/);
		expect(prompt).toMatch(/only signal is (?:the )?assistant|assistant narration|assistant drift/i);
	});

	it("swaps in codex's verbatim policy when reviewerPolicySource = 'codex-verbatim'", () => {
		const prompt = buildReviewerSystemPrompt(codexVerbatim());
		// The codex policy uses Guardian-specific framing not in our BASE_POLICY.
		expect(prompt).toMatch(/Guardian|guardian/);
		expect(prompt).toContain(REVIEWER_OUTPUT_CONTRACT);
	});

	it("splices customPolicy into codex's {tenant_policy_config} slot", () => {
		const prompt = buildReviewerSystemPrompt(codexVerbatim("Acme: never push to main"));
		expect(prompt).toContain("Acme: never push to main");
		// The slot itself should be filled, not left literal.
		expect(prompt).not.toContain("{tenant_policy_config}");
	});
});
