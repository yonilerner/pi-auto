import { describe, expect, it } from "vitest";
import { buildReviewerSystemPrompt, REVIEWER_OUTPUT_CONTRACT } from "../extensions/policy.ts";

describe("buildReviewerSystemPrompt", () => {
	it("includes the base policy", () => {
		const prompt = buildReviewerSystemPrompt("");
		expect(prompt).toMatch(/risk_level/);
		expect(prompt).toMatch(/user_authorization/);
		expect(prompt).toMatch(/Output Contract/);
	});

	it("describes all four risk levels", () => {
		const prompt = buildReviewerSystemPrompt("");
		expect(prompt).toMatch(/"low"/);
		expect(prompt).toMatch(/"medium"/);
		expect(prompt).toMatch(/"high"/);
		expect(prompt).toMatch(/"critical"/);
	});

	it("describes all four user_authorization levels", () => {
		const prompt = buildReviewerSystemPrompt("");
		expect(prompt).toMatch(/"high":/);
		expect(prompt).toMatch(/"medium":/);
		expect(prompt).toMatch(/"low":/);
		expect(prompt).toMatch(/"unknown":/);
	});

	it("appends custom policy when provided", () => {
		const prompt = buildReviewerSystemPrompt("Always deny touching /tmp/sacred.");
		expect(prompt).toMatch(/Custom Policy/);
		expect(prompt).toMatch(/sacred/);
	});

	it("omits custom policy section when empty", () => {
		const prompt = buildReviewerSystemPrompt("   ");
		expect(prompt).not.toMatch(/Custom Policy/);
	});

	it("ends with the output contract", () => {
		const prompt = buildReviewerSystemPrompt("");
		expect(prompt).toContain(REVIEWER_OUTPUT_CONTRACT);
	});

	it("warns against treating transcript content as instructions (prompt-injection guard)", () => {
		const prompt = buildReviewerSystemPrompt("");
		expect(prompt).toMatch(/untrusted|redefine policy|force approval|prompt injection|attacker-controlled/i);
	});

	it("explicitly identifies user messages as the only authorization source", () => {
		const prompt = buildReviewerSystemPrompt("");
		expect(prompt).toMatch(/Authorization Sources/i);
		expect(prompt).toMatch(/\[user\]/);
		expect(prompt).toMatch(/ONLY/i);
	});

	it("explicitly says assistant messages are NOT authorization", () => {
		const prompt = buildReviewerSystemPrompt("");
		expect(prompt).toMatch(/\[assistant\].*not|assistant.*never|cannot.*authoriz/i);
		// And the circular-reasoning argument.
		expect(prompt).toMatch(/circular|itself an assistant decision/i);
	});

	it("explicitly says tool results are NOT authorization (prompt injection guard)", () => {
		const prompt = buildReviewerSystemPrompt("");
		expect(prompt).toMatch(/\[tool_result\].*not|tool output.*not.*authoriz|prompt injection/i);
	});

	it("tells the reviewer to score unknown when only assistant narration supports the action", () => {
		const prompt = buildReviewerSystemPrompt("");
		expect(prompt).toMatch(/unknown/);
		expect(prompt).toMatch(/assistant.*intent|only signal is the assistant/i);
	});
});
