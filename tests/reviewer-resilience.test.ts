import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@earendil-works/pi-ai/compat", () => ({ completeSimple: vi.fn() }));
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { reviewAction } from "../extensions/reviewer.ts";
import { ASSESSMENT_SCHEMA, validateAssessment } from "../extensions/review-response.ts";
import { DEFAULT_SETTINGS } from "../extensions/settings.ts";
import type { ReviewableAction } from "../extensions/types.ts";

const complete = vi.mocked(completeSimple);
const assessment = { risk_level: "low", user_authorization: "unknown", evidence: [], rationale: "Routine local exploration." };
const action: ReviewableAction = { toolName: "memory_add", toolCallId: "call", toolSource: "custom", description: "Store a local preference", input: { content: "Prefers concise replies" }, cwd: "/project", label: "memory_add", execution: "tool" };
const response = (text = JSON.stringify(assessment), stopReason = "stop") => ({ content: [{ type: "text", text }], stopReason, usage: {} }) as never;
function fixture() {
	const settings = structuredClone(DEFAULT_SETTINGS);
	const model = { ...getBuiltinModel("openai", "gpt-6-luna")! };
	const ctx = {
		modelRegistry: { find: vi.fn(() => model), getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "CREDENTIAL_CANARY", headers: { authorization: "HEADER_CANARY" } })) },
		sessionManager: { getBranch: () => [{ type: "message", id: "request", message: { role: "user", content: "Inspect the project. TRANSCRIPT_CANARY" } }] },
	} as unknown as ExtensionContext;
	return { settings, model, ctx };
}
beforeEach(() => { complete.mockReset(); });
afterEach(() => vi.useRealTimers());

describe("precise assessment validation", () => {
	it.each([
		["", "empty_response"], ["not JSON", "invalid_json"], ["[]", "not_object"],
		[JSON.stringify({ ...assessment, evidence: undefined }), "missing_fields"],
		[JSON.stringify({ ...assessment, outcome: "allow" }), "unexpected_fields"],
		[JSON.stringify({ ...assessment, risk_level: "bogus" }), "invalid_field"],
		[JSON.stringify({ ...assessment, user_authorization: "bogus" }), "invalid_field"],
		[JSON.stringify({ ...assessment, evidence: [""] }), "invalid_field"],
		[JSON.stringify({ ...assessment, rationale: " " }), "invalid_field"],
	])("reports the validation category for %s", (text, code) => {
		expect(validateAssessment(text)).toMatchObject({ ok: false, issue: { code } });
	});
	it("keeps unknown field names/values and malformed contents out of validation metadata", () => {
		const text = JSON.stringify({ ...assessment, PRIVATE_FIELD_CANARY: "PRIVATE_VALUE_CANARY" });
		const invalid = validateAssessment(text);
		expect(invalid).toEqual({ ok: false, issue: { code: "unexpected_fields", extraFieldCount: 1 } });
		expect(JSON.stringify(invalid)).not.toContain("CANARY");
	});
});

describe("bounded reviewer formatting recovery", () => {
	it.each(["", "malformed PRIVATE_RESPONSE_CANARY", JSON.stringify({ ...assessment, evidence: undefined }), JSON.stringify({ ...assessment, outcome: "allow" })])("retries one malformed response without feeding it back: %s", async (invalid) => {
		const { ctx, settings } = fixture();
		complete.mockResolvedValueOnce(response(invalid)).mockResolvedValueOnce(response());
		const result = await reviewAction(action, ctx, settings);
		expect(result).toMatchObject({ kind: "assessed", decision: { outcome: "allow" } });
		expect(complete).toHaveBeenCalledTimes(2);
		expect(complete.mock.calls[1]?.[1].messages).toEqual(complete.mock.calls[0]?.[1].messages);
		expect(complete.mock.calls[1]?.[1].systemPrompt).toContain("formatting retry");
		expect(complete.mock.calls[1]?.[1].systemPrompt).not.toContain("PRIVATE_RESPONSE_CANARY");
		expect(result.diagnostics?.attempts).toHaveLength(2);
		expect(result.diagnostics?.attempts[0]?.error).toBeDefined();
		expect(result.diagnostics?.attempts[1]?.error).toBeUndefined();
		for (const call of complete.mock.calls) expect(call[2]).toMatchObject({ maxRetries: 0, timeoutMs: 30000 });
	});
	it("fails closed after two bad responses and identifies the exact missing field", async () => {
		const { ctx, settings } = fixture();
		complete.mockResolvedValue(response(JSON.stringify({ ...assessment, evidence: undefined })));
		const result = await reviewAction(action, ctx, settings);
		expect(result).toMatchObject({ kind: "failed", failureCode: "missing_fields", reason: expect.stringContaining("evidence"), diagnostics: { failure: "missing_fields" } });
		expect(complete).toHaveBeenCalledTimes(2);
	});
	it("does not accept token-limited output, even if its visible JSON parses", async () => {
		const { ctx, settings } = fixture();
		complete.mockResolvedValueOnce(response(JSON.stringify(assessment), "length")).mockResolvedValueOnce(response());
		const result = await reviewAction(action, ctx, settings);
		expect(result.kind).toBe("assessed");
		expect(result.diagnostics?.attempts[0]?.validation?.code).toBe("output_truncated");
		expect(complete.mock.calls[1]?.[2]?.maxTokens).toBe(4096);
	});
	it("never retries a valid policy denial", async () => {
		const { ctx, settings } = fixture();
		complete.mockResolvedValue(response(JSON.stringify({ ...assessment, risk_level: "high" })));
		expect(await reviewAction(action, ctx, settings)).toMatchObject({ kind: "assessed", decision: { outcome: "deny" } });
		expect(complete).toHaveBeenCalledOnce();
	});
	it.each(["throw", "error", "refusal"])("does not retry a provider %s", async (kind) => {
		const { ctx, settings } = fixture();
		if (kind === "throw") complete.mockRejectedValue(new Error("Provider error with PRIVATE_ERROR_CANARY"));
		else if (kind === "error") complete.mockResolvedValue(response("", "error"));
		else complete.mockImplementationOnce(async (model, _context, options) => {
			await options?.onProviderStreamEvent?.({ type: "response.refusal.delta", delta: "PRIVATE_REFUSAL_CANARY" }, model);
			return response("");
		});
		const result = await reviewAction(action, ctx, settings);
		expect(result).toMatchObject({ kind: "failed", failureCode: kind === "refusal" ? "provider_refusal" : "provider_error" });
		expect(complete).toHaveBeenCalledOnce();
		expect(JSON.stringify(result.diagnostics)).not.toContain("CANARY");
	});
	it("shares one deadline across credential lookup and both attempts", async () => {
		vi.useFakeTimers();
		const { ctx, settings } = fixture(); settings.reviewer.timeoutMs = 100;
		complete.mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve(response("bad JSON")), 60)));
		complete.mockImplementationOnce(() => new Promise(() => {}));
		const pending = reviewAction(action, ctx, settings);
		await vi.advanceTimersByTimeAsync(60);
		expect(complete).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(40);
		expect(await pending).toMatchObject({ kind: "failed", failureCode: "timeout", latencyMs: 100, diagnostics: { failure: "timeout" } });
	});
	it("cancels without retry and snapshots diagnostics against late provider completions", async () => {
		const { ctx, settings } = fixture();
		let release!: (value: never) => void;
		complete.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
		const controller = new AbortController();
		const pending = reviewAction(action, ctx, settings, controller.signal);
		await Promise.resolve(); await Promise.resolve();
		controller.abort();
		const result = await pending;
		expect(result).toMatchObject({ kind: "failed", failureCode: "cancelled" });
		const snapshot = JSON.stringify(result.diagnostics);
		release(response());
		await Promise.resolve(); await Promise.resolve();
		expect(JSON.stringify(result.diagnostics)).toBe(snapshot);
		expect(complete).toHaveBeenCalledOnce();
	});
	it("records HTTP status without retaining response headers", async () => {
		const { ctx, settings } = fixture();
		complete.mockImplementationOnce(async (model, _context, options) => {
			await options?.onResponse?.({ status: 400, headers: { authorization: "PRIVATE_HEADER_CANARY" } }, model);
			return response("", "error");
		});
		const result = await reviewAction(action, ctx, settings);
		expect(result.diagnostics?.attempts[0]).toMatchObject({ httpStatus: 400, error: "provider_error" });
		expect(JSON.stringify(result.diagnostics)).not.toContain("CANARY");
	});
	it("retains only metadata from malformed responses, tool input, credentials, and context", async () => {
		const { ctx, settings } = fixture();
		const privateAction = { ...action, input: { content: "ARGUMENT_CANARY" } };
		complete.mockResolvedValue({ content: [{ type: "thinking", thinking: "THINKING_CANARY" }, { type: "text", text: JSON.stringify({ ...assessment, SECRET_CANARY: "RAW_OUTPUT_CANARY" }) }], stopReason: "stop" } as never);
		const result = await reviewAction(privateAction, ctx, settings);
		expect(result.diagnostics?.attempts[0]).toMatchObject({ contentTypes: ["thinking", "text"], validation: { code: "unexpected_fields", extraFieldCount: 1 } });
		expect(result.diagnostics?.attempts[0]?.responseHash).toMatch(/^[a-f0-9]{64}$/);
		expect(JSON.stringify(result.diagnostics)).not.toContain("CANARY");
	});
});

describe("provider-side assessment schema", () => {
	it("adds a strict schema without replacing existing text options or the original payload", async () => {
		const { ctx, settings } = fixture(); complete.mockResolvedValue(response());
		const result = await reviewAction(action, ctx, settings);
		const payload = { text: { verbosity: "low" }, input: "PRIVATE_PROMPT" };
		const constrained = await complete.mock.calls[0]?.[2]?.onPayload?.(payload, fixture().model);
		expect(constrained).toMatchObject({ input: "PRIVATE_PROMPT", text: { verbosity: "low", format: { type: "json_schema", strict: true, schema: ASSESSMENT_SCHEMA } } });
		expect(payload.text).not.toHaveProperty("format");
		expect(result.diagnostics?.format).toBe("json_schema");
	});
	it("can explicitly disable schema constraints without weakening local validation", async () => {
		const { ctx, settings } = fixture(); settings.reviewer.structuredOutput = "off";
		complete.mockResolvedValue(response("bad JSON"));
		const result = await reviewAction(action, ctx, settings);
		expect(result).toMatchObject({ kind: "failed", failureCode: "invalid_json", diagnostics: { format: "prompt" } });
		expect(complete.mock.calls[0]?.[2]?.onPayload).toBeUndefined();
	});
	it("does not force Responses schema syntax onto other OpenAI API shapes", async () => {
		const { ctx, settings, model } = fixture(); Object.assign(model, { api: "openai-completions" });
		complete.mockResolvedValue(response());
		expect((await reviewAction(action, ctx, settings)).diagnostics?.format).toBe("prompt");
		expect(complete.mock.calls[0]?.[2]?.onPayload).toBeUndefined();
	});
	it("does not force OpenAI schemas onto another provider's compatible endpoint", async () => {
		const { ctx, settings, model } = fixture(); model.provider = "custom-provider";
		complete.mockResolvedValue(response());
		const result = await reviewAction(action, ctx, settings);
		expect(result.diagnostics?.format).toBe("prompt");
		expect(complete.mock.calls[0]?.[2]?.onPayload).toBeUndefined();
	});
});
