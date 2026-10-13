import { describe, expect, it } from "vitest";
import { extractJsonObject, parseAssessment } from "../extensions/reviewer.ts";

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
