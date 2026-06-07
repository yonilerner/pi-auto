import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CircuitBreaker } from "../extensions/circuit-breaker.ts";
import { fallbackToUser, handleCircuitBreaker, handleReviewResult } from "../extensions/pi-auto.ts";
import type { ReviewResult } from "../extensions/reviewer.ts";
import type { PiAutoSettings, ReviewableAction, ReviewerAssessment } from "../extensions/types.ts";

const SETTINGS: PiAutoSettings = {
	reviewerProvider: "openai",
	reviewerModel: "gpt-5-mini",
	fallbackToActiveModel: true,
	reviewerTimeoutMs: 30_000,
	maxConsecutiveDenialsPerTurn: 3,
	maxTotalDenialsPerTurn: 10,
	maxTranscriptEntries: 40,
	maxEntryChars: 2_000,
	maxTranscriptTotalChars: 80_000,
	maxPinnedRelatedEntries: 6,
	maxSummaryEntries: 3,
	enableDigest: false,
	sensitivePathPatterns: [],
	announceAllows: true,
	customPolicy: "",
};

const ACTION: ReviewableAction = {
	toolName: "bash",
	toolCallId: "tc-1",
	label: "bash: rm -rf /",
	payload: { tool: "bash", command: "rm -rf /" },
};

interface FakeCtx {
	ctx: ExtensionContext;
	notify: ReturnType<typeof vi.fn>;
	select: ReturnType<typeof vi.fn>;
	abort: ReturnType<typeof vi.fn>;
}

function makeCtx(opts: { hasUI?: boolean; selectAnswer?: string } = {}): FakeCtx {
	const hasUI = opts.hasUI ?? true;
	const notify = vi.fn();
	const select = vi.fn().mockResolvedValue(opts.selectAnswer ?? "Yes, run it");
	const abort = vi.fn();
	const ctx = {
		hasUI,
		mode: hasUI ? "tui" : "print",
		cwd: "/tmp",
		ui: { notify, select, setStatus: vi.fn() },
		abort,
		isIdle: () => true,
		hasPendingMessages: () => false,
		shutdown: vi.fn(),
		getContextUsage: () => undefined,
		compact: vi.fn(),
		getSystemPrompt: () => "",
		sessionManager: { getBranch: () => [] } as unknown as ExtensionContext["sessionManager"],
		modelRegistry: {} as ExtensionContext["modelRegistry"],
		model: undefined,
		signal: undefined,
	} as unknown as ExtensionContext;
	return { ctx, notify, select, abort };
}

function assessment(opts: Partial<ReviewerAssessment> & Pick<ReviewerAssessment, "outcome">): ReviewerAssessment {
	return {
		risk_level: "low",
		user_authorization: "high",
		rationale: "test",
		...opts,
	};
}

describe("handleReviewResult: allow", () => {
	let breaker: CircuitBreaker;
	beforeEach(() => {
		breaker = new CircuitBreaker(3, 10);
	});

	it("returns undefined (does not block)", async () => {
		const { ctx } = makeCtx();
		const result: ReviewResult = { kind: "assessed", assessment: assessment({ outcome: "allow" }) };
		const out = await handleReviewResult(result, ACTION, ctx, breaker, SETTINGS, "t1");
		expect(out).toBeUndefined();
	});

	it("notifies the user inline when announceAllows is on", async () => {
		const { ctx, notify } = makeCtx();
		const result: ReviewResult = {
			kind: "assessed",
			assessment: assessment({ outcome: "allow", risk_level: "medium", rationale: "OK by user" }),
		};
		await handleReviewResult(result, ACTION, ctx, breaker, SETTINGS, "t1");
		expect(notify).toHaveBeenCalledOnce();
		expect(notify.mock.calls[0][0]).toMatch(/allowed/);
		expect(notify.mock.calls[0][0]).toMatch(/medium/);
		expect(notify.mock.calls[0][0]).toMatch(/OK by user/);
	});

	it("does NOT notify when announceAllows is off", async () => {
		const { ctx, notify } = makeCtx();
		const settings = { ...SETTINGS, announceAllows: false };
		const result: ReviewResult = { kind: "assessed", assessment: assessment({ outcome: "allow" }) };
		await handleReviewResult(result, ACTION, ctx, breaker, settings, "t1");
		expect(notify).not.toHaveBeenCalled();
	});

	it("resets the consecutive-denial counter", async () => {
		const { ctx } = makeCtx();
		breaker.recordDenial("t1");
		breaker.recordDenial("t1");
		const result: ReviewResult = { kind: "assessed", assessment: assessment({ outcome: "allow" }) };
		await handleReviewResult(result, ACTION, ctx, breaker, SETTINGS, "t1");
		// Two more denials should NOT trip the breaker (counter was reset).
		expect(breaker.recordDenial("t1").kind).toBe("continue");
		expect(breaker.recordDenial("t1").kind).toBe("continue");
	});
});

describe("handleReviewResult: deny", () => {
	let breaker: CircuitBreaker;
	beforeEach(() => {
		breaker = new CircuitBreaker(3, 10);
	});

	it("returns a block with rationale-containing reason", async () => {
		const { ctx } = makeCtx();
		const result: ReviewResult = {
			kind: "assessed",
			assessment: assessment({ outcome: "deny", risk_level: "critical", rationale: "boom" }),
		};
		const out = await handleReviewResult(result, ACTION, ctx, breaker, SETTINGS, "t1");
		expect(out?.block).toBe(true);
		expect(out?.reason).toMatch(/boom/);
		expect(out?.reason).toMatch(/critical/);
		expect(out?.reason).toMatch(/safer alternative|stop and ask/i);
	});

	it("warns via ui.notify on deny", async () => {
		const { ctx, notify } = makeCtx();
		const result: ReviewResult = {
			kind: "assessed",
			assessment: assessment({ outcome: "deny", risk_level: "high" }),
		};
		await handleReviewResult(result, ACTION, ctx, breaker, SETTINGS, "t1");
		expect(notify).toHaveBeenCalledOnce();
		expect(notify.mock.calls[0][1]).toBe("warning");
	});

	it("counts the denial in the circuit breaker", async () => {
		const { ctx } = makeCtx();
		const result: ReviewResult = { kind: "assessed", assessment: assessment({ outcome: "deny" }) };
		await handleReviewResult(result, ACTION, ctx, breaker, SETTINGS, "t1");
		await handleReviewResult(result, ACTION, ctx, breaker, SETTINGS, "t1");
		// Now any further denials in this turn should trip the breaker via the public counter.
		expect(breaker.recordDenial("t1").kind).toBe("interrupt");
	});

	it("trips the circuit breaker after enough denials and prompts the user", async () => {
		const { ctx, select } = makeCtx({ selectAnswer: "Stop this turn" });
		const result: ReviewResult = { kind: "assessed", assessment: assessment({ outcome: "deny" }) };
		await handleReviewResult(result, ACTION, ctx, breaker, SETTINGS, "t1");
		await handleReviewResult(result, ACTION, ctx, breaker, SETTINGS, "t1");
		// Third denial in a row trips the breaker.
		const out = await handleReviewResult(result, ACTION, ctx, breaker, SETTINGS, "t1");
		expect(select).toHaveBeenCalled();
		expect(out?.block).toBe(true);
		expect(out?.reason).toMatch(/circuit breaker tripped/);
	});

	it("non-interactive mode hard-blocks on deny without prompting", async () => {
		const { ctx, select } = makeCtx({ hasUI: false });
		const result: ReviewResult = { kind: "assessed", assessment: assessment({ outcome: "deny" }) };
		const out = await handleReviewResult(result, ACTION, ctx, breaker, SETTINGS, "t1");
		expect(out?.block).toBe(true);
		expect(select).not.toHaveBeenCalled();
	});
});

describe("handleReviewResult: reviewer failure", () => {
	it("falls back to a user prompt with UI", async () => {
		const { ctx, select } = makeCtx({ selectAnswer: "Yes, run it" });
		const result: ReviewResult = { kind: "failed", reason: "timeout" };
		const out = await handleReviewResult(result, ACTION, ctx, new CircuitBreaker(3, 10), SETTINGS, "t1");
		expect(select).toHaveBeenCalled();
		expect(select.mock.calls[0][0]).toMatch(/timeout/);
		expect(out).toBeUndefined();
	});

	it("user can decline the fallback prompt", async () => {
		const { ctx } = makeCtx({ selectAnswer: "No, block" });
		const result: ReviewResult = { kind: "failed", reason: "no api key" };
		const out = await handleReviewResult(result, ACTION, ctx, new CircuitBreaker(3, 10), SETTINGS, "t1");
		expect(out?.block).toBe(true);
		expect(out?.reason).toMatch(/User declined/);
	});

	it("fails closed without UI", async () => {
		const { ctx, select } = makeCtx({ hasUI: false });
		const result: ReviewResult = { kind: "failed", reason: "parse error" };
		const out = await handleReviewResult(result, ACTION, ctx, new CircuitBreaker(3, 10), SETTINGS, "t1");
		expect(out?.block).toBe(true);
		expect(out?.reason).toMatch(/parse error/);
		expect(select).not.toHaveBeenCalled();
	});
});

describe("fallbackToUser", () => {
	it("includes the action label in the prompt", async () => {
		const { ctx, select } = makeCtx();
		await fallbackToUser(ACTION, "test", ctx);
		expect(select.mock.calls[0][0]).toContain(ACTION.label);
	});
});

describe("handleCircuitBreaker", () => {
	it("aborts and blocks when user chooses to stop", async () => {
		const { ctx, abort } = makeCtx({ selectAnswer: "Stop this turn" });
		const a = assessment({ outcome: "deny" });
		const out = await handleCircuitBreaker(ACTION, a, 3, 3, ctx);
		expect(abort).toHaveBeenCalledOnce();
		expect(out.block).toBe(true);
	});

	it("returns undefined-block to continue when user approves the one action", async () => {
		const { ctx, abort } = makeCtx({ selectAnswer: "Approve this one action and continue" });
		const a = assessment({ outcome: "deny" });
		const out = await handleCircuitBreaker(ACTION, a, 3, 3, ctx);
		expect(abort).not.toHaveBeenCalled();
		// Should be a non-blocking result (undefined or {block: false-ish}).
		expect(out?.block).not.toBe(true);
	});

	it("non-interactive mode aborts immediately", async () => {
		const { ctx, abort, select } = makeCtx({ hasUI: false });
		const a = assessment({ outcome: "deny" });
		await handleCircuitBreaker(ACTION, a, 3, 3, ctx);
		expect(abort).toHaveBeenCalledOnce();
		expect(select).not.toHaveBeenCalled();
	});
});
