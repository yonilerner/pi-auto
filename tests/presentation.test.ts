import { describe, expect, it } from "vitest";
import { compact, failureSummary, formatApproval, formatDebugSummary, formatDecision, formatStatus } from "../extensions/presentation.ts";
import { DEFAULT_SETTINGS } from "../extensions/settings.ts";
import type { ReviewDebugRecord } from "../extensions/diagnostics.ts";
import type { ReviewableAction, ReviewResult } from "../extensions/types.ts";

const failed: ReviewResult = { kind: "failed", failureCode: "missing_fields", reason: "PRIVATE_PROVIDER_ERROR", latencyMs: 20 };
const denied: ReviewResult = { kind: "assessed", assessment: { risk_level: "high", user_authorization: "unknown", evidence: [], rationale: "Not requested" }, decision: { outcome: "deny", reason: "No user authorization" }, latencyMs: 5 };

describe("compact presentation", () => {
	it("flattens and bounds routine messages without expanding short text", () => {
		expect(compact("  a\n\t b  ")).toBe("a b");
		expect(compact("x".repeat(200))).toHaveLength(100);
		expect(compact("x".repeat(200))).toMatch(/…$/);
	});
	it("keeps status on one line without settings paths or compatibility write lists", () => {
		expect(formatStatus(DEFAULT_SETTINGS, true, false)).toBe("on · sandbox · openai/gpt-6-luna · reasoning off");
		expect(formatStatus(DEFAULT_SETTINGS, false, false)).toContain("sandbox unavailable");
		expect(formatStatus(DEFAULT_SETTINGS, true, true)).toBe("settings error · blocked");
		const settings = structuredClone(DEFAULT_SETTINGS); settings.reviewer.debug = true;
		expect(formatStatus(settings, true, false)).toMatch(/ · debug$/);
		settings.enabled = false;
		expect(formatStatus(settings, false, true)).toBe("off · review + sandbox disabled");
	});
	it("shows failure codes and a drill-down hint instead of raw provider errors", () => {
		expect(failureSummary(failed)).toBe("review failed · missing_fields · /auto debug");
		expect(failureSummary({ ...failed, failureCode: undefined })).toBe("review failed · /auto debug");
		expect(failureSummary(failed)).not.toContain("PRIVATE_PROVIDER_ERROR");
		expect(failureSummary(denied)).toBe("No user authorization");
	});
	it("retains every exact approval argument, cwd, and host warning without internal payload duplication", () => {
		const action: ReviewableAction = {
			toolName: "bash", toolCallId: "internal-call-id", description: "INTERNAL_DESCRIPTION".repeat(100), cwd: "/some/project", label: "bash: duplicated command", execution: "host",
			input: { command: "printf exact\n".repeat(100), timeout: 42, plugin: "EXTRA_ARGUMENT" },
		};
		const prompt = formatApproval(action, denied);
		expect(prompt).toContain(JSON.stringify(action.input, null, 2));
		expect(prompt).toContain("cwd: /some/project");
		expect(prompt).toContain("Full host access · no sandbox.");
		expect(prompt).not.toContain("INTERNAL_DESCRIPTION");
		expect(prompt).not.toContain("internal-call-id");
		expect(prompt).not.toContain("duplicated command");
		expect(formatApproval({ ...action, execution: "tool" }, failed)).not.toContain("Full host access");
	});
	it("summarizes a trace in one line while leaving full diagnostics for explicit drill-down", () => {
		const record: ReviewDebugRecord = {
			at: "2026-10-20T01:02:03.000Z", tool: "memory_add", execution: "tool", outcome: "failed",
			review: { id: "abcdef01-2345-6789", provider: "openai", model: "gpt-6-luna", reasoning: "off", format: "json_schema", failure: "missing_fields", attempts: [{ attempt: 1, latencyMs: 10, maxTokens: 2048 }, { attempt: 2, latencyMs: 12, maxTokens: 2048 }] },
		};
		expect(formatDebugSummary(record)).toBe("01:02:03 · memory_add · missing_fields · 22ms · 2 tries · #abcdef01");
		expect(formatDebugSummary({ ...record, outcome: "allow", review: { ...record.review, failure: undefined, attempts: [] } })).toContain("allow · 0ms");
	});
	it("keeps manual host approvals and retry counts visible in compact decision logs", () => {
		expect(formatDecision({ at: "2026-10-20T01:02:03.000Z", tool: "bash", execution: "host", outcome: "allow", source: "user", reviewFailure: "invalid_json", latencyMs: 20, reviewAttempts: 2, reviewId: "abcdef01-2345-6789" })).toBe("01:02:03 · bash · allow · invalid_json · manual · host · 20ms · 2 tries · #abcdef01");
		expect(formatDecision({ at: "2026-10-20T01:02:03.000Z", tool: "write", execution: "tool", outcome: "deny", source: "policy" })).toBe("01:02:03 · write · deny · policy");
	});
});
