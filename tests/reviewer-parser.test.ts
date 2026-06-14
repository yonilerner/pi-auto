import { describe, expect, it } from "vitest";
import {
	applyDeterministicReviewGuards,
	applyDeterministicScopeGuard,
	extractJsonObject,
	parseAssessment,
} from "../extensions/reviewer.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ReviewableAction, ReviewerAssessment } from "../extensions/types.ts";

describe("extractJsonObject", () => {
	it("returns plain JSON unchanged", () => {
		const json = `{"a":1}`;
		expect(extractJsonObject(json)).toBe(json);
	});

	it("strips ```json fences", () => {
		const text = "```json\n{\"a\":1}\n```";
		expect(extractJsonObject(text)).toBe(`{"a":1}`);
	});

	it("strips plain ``` fences", () => {
		const text = "```\n{\"a\":1}\n```";
		expect(extractJsonObject(text)).toBe(`{"a":1}`);
	});

	it("extracts JSON from surrounding prose", () => {
		const text = `Here's my assessment: {"risk_level":"low","outcome":"allow"} Hope this helps!`;
		expect(extractJsonObject(text)).toBe(`{"risk_level":"low","outcome":"allow"}`);
	});

	it("returns undefined when no object is found", () => {
		expect(extractJsonObject("just words")).toBeUndefined();
	});
});

describe("applyDeterministicScopeGuard", () => {
	const allow: ReviewerAssessment = {
		risk_level: "medium",
		user_authorization: "medium",
		outcome: "allow",
		rationale: "model allowed it",
	};

	function ctxWithUser(text: string): ExtensionContext {
		return {
			sessionManager: {
				getBranch: () => [
					{ type: "message", message: { role: "user", content: text } },
				],
			},
		} as unknown as ExtensionContext;
	}

	function packageWrite(path = "/home/me/other-project/package.json"): ReviewableAction {
		return {
			toolName: "write",
			toolCallId: "tc-test",
			label: `write: ${path}`,
			payload: { tool: "write", path, cwd: "/home/me/project", outsideCwd: true },
		};
	}

	it("denies sibling package.json writes for ambiguous all-package requests", () => {
		const guarded = applyDeterministicScopeGuard(
			allow,
			packageWrite(),
			ctxWithUser("update all the package.json files"),
		);
		expect(guarded.outcome).toBe("deny");
		expect(guarded.user_authorization).toBe("unknown");
	});

	it("does not deny when the user names all repos under a broader root", () => {
		const guarded = applyDeterministicScopeGuard(
			allow,
			packageWrite(),
			ctxWithUser("bump lodash in every package.json across all my repos under /home/me"),
		);
		expect(guarded).toBe(allow);
	});

	it("does not deny when the user names the sibling package file", () => {
		const guarded = applyDeterministicScopeGuard(
			allow,
			packageWrite(),
			ctxWithUser("also update /home/me/other-project/package.json"),
		);
		expect(guarded).toBe(allow);
	});

	it("does not affect non-package writes", () => {
		const guarded = applyDeterministicScopeGuard(
			allow,
			packageWrite("/home/me/other-project/src/index.ts"),
			ctxWithUser("update all the package.json files"),
		);
		expect(guarded).toBe(allow);
	});

	it("denies force-push to main when the user only asked to push", () => {
		const guarded = applyDeterministicReviewGuards(
			{ ...allow, risk_level: "high" },
			{
				toolName: "bash",
				toolCallId: "tc-test",
				label: "bash: git push --force origin main",
				payload: {
					tool: "bash",
					command: "git push --force origin main",
					cwd: "/home/me/project",
				},
			},
			ctxWithUser("push my latest commit"),
		);
		expect(guarded.outcome).toBe("deny");
		expect(guarded.user_authorization).toBe("unknown");
	});

	it("does not deny force-push to main when the user explicitly authorized it", () => {
		const guarded = applyDeterministicReviewGuards(
			{ ...allow, risk_level: "high" },
			{
				toolName: "bash",
				toolCallId: "tc-test",
				label: "bash: git push --force origin main",
				payload: {
					tool: "bash",
					command: "git push --force origin main",
					cwd: "/home/me/project",
				},
			},
			ctxWithUser("force-push main now"),
		);
		expect(guarded).toEqual({ ...allow, risk_level: "high" });
	});

	it("denies deploy apply commands when the user said not to run yet", () => {
		const guarded = applyDeterministicReviewGuards(
			{ ...allow, risk_level: "high" },
			{
				toolName: "bash",
				toolCallId: "tc-test",
				label: "bash: kubectl apply",
				payload: {
					tool: "bash",
					command: "kubectl --context=prod apply -f deploy/prod.yaml",
					cwd: "/home/me/project",
				},
			},
			ctxWithUser("prepare the prod deploy for the new config, but don't run it yet"),
		);
		expect(guarded.outcome).toBe("deny");
	});
});

describe("parseAssessment", () => {
	const good = `{"risk_level":"low","user_authorization":"high","outcome":"allow","rationale":"OK"}`;

	it("parses a valid assessment", () => {
		const parsed = parseAssessment(good);
		expect(parsed).toEqual({
			risk_level: "low",
			user_authorization: "high",
			outcome: "allow",
			rationale: "OK",
		});
	});

	it("parses with surrounding fences", () => {
		const parsed = parseAssessment("```json\n" + good + "\n```");
		expect(parsed?.outcome).toBe("allow");
	});

	it("parses with surrounding prose", () => {
		const parsed = parseAssessment(`My judgment: ${good}\n\nDone.`);
		expect(parsed?.outcome).toBe("allow");
	});

	it("trims whitespace in rationale", () => {
		const parsed = parseAssessment(
			`{"risk_level":"low","user_authorization":"high","outcome":"allow","rationale":"  trimmed  "}`,
		);
		expect(parsed?.rationale).toBe("trimmed");
	});

	it("accepts abbreviated {outcome:allow} form (codex-auto-review uses this for clear low-risk)", () => {
		const parsed = parseAssessment(`{"outcome":"allow"}`);
		expect(parsed?.outcome).toBe("allow");
		expect(parsed?.risk_level).toBe("low");
		expect(parsed?.user_authorization).toBe("unknown");
		expect(parsed?.rationale).toBeTruthy();
	});

	it("accepts abbreviated {outcome:deny} form (defaults to high risk)", () => {
		const parsed = parseAssessment(`{"outcome":"deny"}`);
		expect(parsed?.outcome).toBe("deny");
		expect(parsed?.risk_level).toBe("high");
		expect(parsed?.user_authorization).toBe("unknown");
	});

	it("falls back to default risk_level when value is invalid", () => {
		const parsed = parseAssessment(
			`{"risk_level":"very-bad","user_authorization":"high","outcome":"allow","rationale":"x"}`,
		);
		expect(parsed?.outcome).toBe("allow");
		expect(parsed?.risk_level).toBe("low"); // defaulted because invalid
	});

	it("falls back to unknown when user_authorization is invalid", () => {
		const parsed = parseAssessment(
			`{"risk_level":"low","user_authorization":"unsure","outcome":"allow","rationale":"x"}`,
		);
		expect(parsed?.user_authorization).toBe("unknown");
	});

	it("rejects invalid outcome (the only strictly-required field)", () => {
		expect(
			parseAssessment(
				`{"risk_level":"low","user_authorization":"high","outcome":"maybe","rationale":"x"}`,
			),
		).toBeUndefined();
	});

	it("supplies a default rationale when missing", () => {
		const parsed = parseAssessment(
			`{"risk_level":"low","user_authorization":"high","outcome":"allow"}`,
		);
		expect(parsed?.outcome).toBe("allow");
		expect(parsed?.rationale).toBeTruthy();
	});

	it("rejects non-JSON garbage", () => {
		expect(parseAssessment("nope")).toBeUndefined();
	});

	it("recovers from a missing closing quote on rationale (streaming-json fallback)", () => {
		// This actually happens with gpt-5-mini sometimes — the model drops the
		// closing `"` before the final `}`.
		const truncated =
			`{"risk_level":"critical","user_authorization":"low","outcome":"deny","rationale":"exfiltration of credentials.}`;
		const parsed = parseAssessment(truncated);
		expect(parsed?.outcome).toBe("deny");
		expect(parsed?.risk_level).toBe("critical");
		expect(parsed?.rationale).toMatch(/exfiltration/);
	});

	it("accepts each valid risk_level / outcome combo", () => {
		for (const risk of ["low", "medium", "high", "critical"]) {
			for (const auth of ["low", "medium", "high", "unknown"]) {
				for (const outcome of ["allow", "deny"]) {
					const json = `{"risk_level":"${risk}","user_authorization":"${auth}","outcome":"${outcome}","rationale":"r"}`;
					const parsed = parseAssessment(json);
					expect(parsed?.risk_level).toBe(risk);
					expect(parsed?.user_authorization).toBe(auth);
					expect(parsed?.outcome).toBe(outcome);
				}
			}
		}
	});
});
