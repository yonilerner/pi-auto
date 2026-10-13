import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerPiAuto, type RuntimeDependencies } from "../extensions/pi-auto.ts";
import type { SandboxCommandOptions, SandboxOutcome } from "../extensions/sandbox.ts";
import { DEFAULT_SETTINGS } from "../extensions/settings.ts";
import type { ReviewResult, Settings } from "../extensions/types.ts";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
const allowed: ReviewResult = { kind: "assessed", assessment: { risk_level: "medium", user_authorization: "high", evidence: ["request"], rationale: "Requested work" }, decision: { outcome: "allow", reason: "authorized" }, latencyMs: 5 };
const denied: ReviewResult = { kind: "assessed", assessment: { risk_level: "high", user_authorization: "unknown", evidence: [], rationale: "Not requested" }, decision: { outcome: "deny", reason: "No user authorization" }, latencyMs: 5 };

function fixture(options: { settings?: Settings; result?: ReviewResult; hasUI?: boolean; errors?: string[]; customBash?: boolean } = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-auto-runtime-")); directories.push(cwd);
	const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>();
	let command!: (args: string, ctx: any) => Promise<void>;
	const pi = {
		on: vi.fn((name, handler) => handlers.set(name, handler)),
		registerTool: vi.fn(),
		registerCommand: vi.fn((_name, definition) => { command = definition.handler; }),
		getAllTools: () => [
			{ name: "bash", description: "Existing bash tool", parameters: Type.Object({ command: Type.String() }), sourceInfo: { source: options.customBash ? "extension" : "builtin" } },
			...['read', 'write', 'edit', 'grep', 'find', 'ls'].map((name) => ({ name, description: `Builtin ${name}`, sourceInfo: { source: "builtin" } })),
			{ name: "send_mail", description: "Send a message using the authenticated account", sourceInfo: { source: "extension" } },
		],
	} as unknown as ExtensionAPI;
	const review = vi.fn(async (..._args: Parameters<RuntimeDependencies["reviewAction"]>): Promise<ReviewResult> => options.result ?? allowed);
	const finish = vi.fn(async (_output: string, _isError: boolean): Promise<SandboxOutcome> => ({ blocked: false, denials: [] }));
	const cancel = vi.fn(async () => {});
	const prepare = vi.fn(async (input: SandboxCommandOptions) => ({ id: "wrapper", command: `wrapped(${input.command})`, sandboxCommand: input.command, finish, cancel }));
	const persist = vi.fn(async (_cwd: string, _record: unknown) => {});
	const reset = vi.fn(async () => {});
	registerPiAuto(pi, {
		loadSettings: () => ({ settings: structuredClone(options.settings ?? DEFAULT_SETTINGS), errors: options.errors ?? [], paths: { user: "/tmp/pi-auto-v2.json", project: join(cwd, ".agents/pi-auto-v2.json") } }),
		reviewAction: review, prepareSandboxCommand: prepare, persistDecision: persist, shutdownSandbox: reset,
		checkSandboxAvailability: () => ({ available: true, errors: [], warnings: [] }),
	});
	const ctx = { cwd, hasUI: options.hasUI ?? false, signal: undefined, isIdle: () => true, waitForIdle: vi.fn(async () => {}), ui: { setStatus: vi.fn(), notify: vi.fn(), confirm: vi.fn(async () => false) } } as unknown as ExtensionContext;
	const event = (toolName: string, input: Record<string, unknown>, toolCallId = "call") => ({ type: "tool_call", toolName, input, toolCallId }) as ToolCallEvent;
	const call = (toolName: string, input: Record<string, unknown>, id = "call") => handlers.get("tool_call")!(event(toolName, input, id), ctx);
	const result = (input: Record<string, unknown>, id = "call", content = [{ type: "text", text: "ok" }], isError = false) => handlers.get("tool_result")!({ type: "tool_result", toolName: "bash", toolCallId: id, input, content, details: { existing: true }, isError }, ctx);
	return { ctx, pi, review, prepare, finish, cancel, persist, reset, handlers, call, result, command: (args: string) => command(args, ctx) };
}

describe("existing-tool wrapper lifecycle", () => {
	it("registers no bash replacement and keeps ordinary workspace reads immediate", async () => {
		const f = fixture();
		expect(f.pi.registerTool).not.toHaveBeenCalled();
		expect(await f.call("read", { path: "README.md" })).toBeUndefined();
		expect(f.review).not.toHaveBeenCalled();
	});
	it("reviews consequential commands before preparing their wrapper", async () => {
		const f = fixture({ result: denied });
		expect(await f.call("bash", { command: "rm -rf src" })).toMatchObject({ block: true });
		expect(f.review).toHaveBeenCalledOnce();
		expect(f.prepare).not.toHaveBeenCalled();
	});
	it("keeps sandbox wrapping and directive host review active when builtin pre-review is paused", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS); settings.enabled = false;
		const f = fixture({ settings });
		const input = { command: "rm -rf scratch", timeout: 17, customArgument: "preserved" };
		await f.call("bash", input);
		expect(input).toEqual({ command: "wrapped(rm -rf scratch)", timeout: 17, customArgument: "preserved" });
		expect(f.review).not.toHaveBeenCalled();
		await f.result(input);
		expect(input.command).toBe("rm -rf scratch");
		const host = { command: "# pi-auto: host Need additional access\nprintf ok", timeout: 17 };
		await f.call("bash", host, "host");
		expect(f.review).toHaveBeenCalledOnce();
		expect(f.review.mock.calls[0]?.[0]).toMatchObject({ execution: "host", input: { command: "printf ok", timeout: 17 } });
		expect(host).toEqual({ command: "printf ok", timeout: 17 });
		expect(f.prepare).toHaveBeenCalledOnce();
	});
	it("appends denial evidence while retaining existing output and never replaying", async () => {
		const f = fixture();
		f.finish.mockResolvedValueOnce({ blocked: true, denials: ["write denied"] });
		const input = { command: "echo ok" };
		await f.call("bash", input);
		const content = [{ type: "text", text: "existing partial output" }];
		const patch = await f.result(input, "call", content, true);
		expect(patch).toMatchObject({ isError: true, content: [content[0], { type: "text", text: expect.stringContaining("not replayed") }] });
		expect(patch).not.toHaveProperty("details");
		expect(f.prepare).toHaveBeenCalledOnce();
		expect(f.review).not.toHaveBeenCalled();
		expect(input.command).toBe("echo ok");
	});
	it("returns clean custom results unchanged and cancels abandoned preparations after a later blocker", async () => {
		const f = fixture();
		const input = { command: "echo ok" };
		await f.call("bash", input);
		expect(await f.result(input)).toBeUndefined();
		expect(f.finish).toHaveBeenCalledOnce();
		await f.call("bash", input, "blocked-later");
		await f.handlers.get("tool_execution_end")!({ toolName: "bash", toolCallId: "blocked-later", isError: true }, f.ctx);
		expect(f.cancel).toHaveBeenCalledOnce();
		expect(input.command).toBe("echo ok");
	});
	it("automatically reviews custom bash even while builtin pre-review is paused", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS); settings.enabled = false;
		const f = fixture({ settings, customBash: true });
		await f.call("bash", { command: "echo ok", plugin: "value" });
		expect(f.review.mock.calls[0]?.[0]).toMatchObject({ toolSource: "custom", execution: "sandbox", description: "Existing bash tool", input: { plugin: "value" } });
		expect(f.prepare).toHaveBeenCalledOnce();
	});
	it("reviews other custom tools and sensitive uncontained reads when paused", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS); settings.enabled = false;
		const f = fixture({ settings });
		await f.call("read", { path: ".env" }, "secret");
		await f.call("send_mail", { to: "someone@example.com", body: "Requested message" }, "mail");
		expect(f.review).toHaveBeenCalledTimes(2);
	});
	it("requires fresh approval for each exact host command", async () => {
		const f = fixture({ result: denied, hasUI: true });
		vi.mocked(f.ctx.ui.confirm).mockResolvedValueOnce(true);
		const input = { command: "# pi-auto: host Requested\nprintf allowed" };
		expect(await f.call("bash", input)).toBeUndefined();
		expect(f.ctx.ui.confirm).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('"cwd"'), expect.any(Object));
		expect(input.command).toBe("printf allowed");
		expect(await f.call("bash", { command: "# pi-auto: host Requested\nprintf changed" }, "next")).toMatchObject({ block: true });
		expect(f.review).toHaveBeenCalledTimes(2);
		expect(f.prepare).not.toHaveBeenCalled();
	});
	it("invalidates pending review on a branch change", async () => {
		const f = fixture(); let finishReview!: (result: ReviewResult) => void;
		f.review.mockImplementationOnce(() => new Promise((resolve) => { finishReview = resolve; }));
		const pending = f.call("bash", { command: "# pi-auto: host Requested\necho host" });
		await f.handlers.get("session_tree")!({}, f.ctx); finishReview(allowed);
		expect(await pending).toMatchObject({ block: true, reason: expect.stringContaining("session or policy changed") });
		expect(f.prepare).not.toHaveBeenCalled();
	});
	it("rejects changed input after asynchronous review", async () => {
		const f = fixture(); const input = { command: "npm install", plugin: "original" };
		f.review.mockImplementationOnce(async () => { input.plugin = "changed"; return allowed; });
		expect(await f.call("bash", input)).toMatchObject({ block: true, reason: expect.stringContaining("input or policy changed") });
		expect(f.prepare).not.toHaveBeenCalled();
	});
	it("hard-blocks protected configuration and malformed settings", async () => {
		const f = fixture({ hasUI: true });
		expect(await f.call("write", { path: ".agents/pi-auto-v2.json", content: '{}' })).toMatchObject({ block: true });
		expect(f.ctx.ui.confirm).not.toHaveBeenCalled();
		const invalid = fixture({ errors: ["bad JSON"] });
		expect(await invalid.call("read", { path: "README.md" })).toMatchObject({ block: true });
	});
	it("restores shared command arguments and releases preparation on shutdown", async () => {
		const f = fixture(); const input = { command: "npm install confidential-package" };
		await f.call("bash", input);
		await f.handlers.get("session_shutdown")!({}, f.ctx);
		expect(input.command).toBe("npm install confidential-package");
		expect(f.cancel).toHaveBeenCalledOnce();
		expect(f.reset).toHaveBeenCalledOnce();
		expect(JSON.stringify(f.persist.mock.calls[0]?.[1])).not.toContain("confidential-package");
	});
});
