import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
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
	const availability = vi.fn(() => ({ available: true, errors: [] as string[], warnings: [] as string[] }));
	registerPiAuto(pi, {
		loadSettings: () => ({ settings: structuredClone(options.settings ?? DEFAULT_SETTINGS), errors: options.errors ?? [], paths: { user: "/tmp/pi-auto-v2.json", project: join(cwd, ".agents/pi-auto-v2.json") } }),
		reviewAction: review, prepareSandboxCommand: prepare, persistDecision: persist, shutdownSandbox: reset,
		checkSandboxAvailability: availability,
	});
	const ctx = { cwd, hasUI: options.hasUI ?? false, signal: undefined, isIdle: () => true, waitForIdle: vi.fn(async () => {}), ui: { setStatus: vi.fn(), notify: vi.fn(), confirm: vi.fn(async () => false) } } as unknown as ExtensionCommandContext;
	const event = (toolName: string, input: Record<string, unknown>, toolCallId = "call") => ({ type: "tool_call", toolName, input, toolCallId }) as ToolCallEvent;
	const call = (toolName: string, input: Record<string, unknown>, id = "call") => handlers.get("tool_call")!(event(toolName, input, id), ctx);
	const result = (input: Record<string, unknown>, id = "call", content = [{ type: "text", text: "ok" }], isError = false) => handlers.get("tool_result")!({ type: "tool_result", toolName: "bash", toolCallId: id, input, content, details: { existing: true }, isError }, ctx);
	return { ctx, pi, review, prepare, finish, cancel, persist, reset, availability, handlers, call, result, command: (args: string) => command(args, ctx) };
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
	it("fully bypasses review, host parsing, sandboxing, and argument changes when configured off", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS); settings.enabled = false;
		const f = fixture({ settings, result: denied, hasUI: true });
		for (const command of ["rm -rf scratch", "# pi-auto: host Need additional access\nprintf ok", "# pi-auto: host"]) {
			const input = { command, timeout: 17, customArgument: "preserved" };
			expect(await f.call("bash", input)).toBeUndefined();
			expect(input).toEqual({ command, timeout: 17, customArgument: "preserved" });
			expect(await f.result(input)).toBeUndefined();
		}
		expect(f.review).not.toHaveBeenCalled();
		expect(f.prepare).not.toHaveBeenCalled();
		expect(f.finish).not.toHaveBeenCalled();
		expect(f.ctx.ui.confirm).not.toHaveBeenCalled();
		expect(f.persist).not.toHaveBeenCalled();
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
	it("bypasses custom bash, MCP tools, sensitive reads, and protected writes when off", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS); settings.enabled = false;
		const f = fixture({ settings, customBash: true, result: denied, hasUI: true });
		expect(await f.call("bash", { command: "echo ok", plugin: "value" })).toBeUndefined();
		expect(await f.call("read", { path: ".env" }, "secret")).toBeUndefined();
		expect(await f.call("send_mail", { to: "someone@example.com", body: "Requested message" }, "mail")).toBeUndefined();
		expect(await f.call("memory_add", { target: "user", content: "Prefers concise answers" }, "memory")).toBeUndefined();
		expect(await f.call("write", { path: ".agents/pi-auto-v2.json", content: "{}" }, "settings")).toBeUndefined();
		expect(f.review).not.toHaveBeenCalled();
		expect(f.prepare).not.toHaveBeenCalled();
		expect(f.ctx.ui.confirm).not.toHaveBeenCalled();
	});
	it("turns every gate off with /auto off and restores every gate with /auto on", async () => {
		const f = fixture({ result: denied, hasUI: true });
		await f.command("off");
		expect(f.ctx.waitForIdle).toHaveBeenCalledOnce();
		expect(f.reset).toHaveBeenCalledOnce();
		expect(f.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-auto", expect.stringContaining("OFF"));
		expect(await f.call("bash", { command: "rm -rf scratch" })).toBeUndefined();
		expect(await f.call("memory_add", { content: "A useful preference" })).toBeUndefined();
		expect(await f.call("write", { path: "AGENTS.md", content: "changed" })).toBeUndefined();
		expect(f.review).not.toHaveBeenCalled();
		expect(f.prepare).not.toHaveBeenCalled();
		expect(f.ctx.ui.confirm).not.toHaveBeenCalled();
		await f.command("status");
		expect(f.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("all review, path restrictions, and bash sandboxing off"), "info");
		await f.command("on");
		expect(await f.call("memory_add", { content: "Another preference" })).toMatchObject({ block: true });
		expect(f.review).toHaveBeenCalledOnce();
		expect(f.ctx.ui.confirm).toHaveBeenCalledOnce();
		expect(await f.call("write", { path: "AGENTS.md", content: "changed" })).toMatchObject({ block: true });
		const input = { command: "echo sandboxed" };
		expect(await f.call("bash", input)).toBeUndefined();
		expect(input.command).toBe("wrapped(echo sandboxed)");
	});
	it("allows fully turning off even with invalid configuration", async () => {
		const f = fixture({ errors: ["bad JSON"] });
		await f.command("off");
		expect(await f.call("read", { path: "README.md" })).toBeUndefined();
		expect(await f.call("bash", { command: "echo host" })).toBeUndefined();
		expect(f.review).not.toHaveBeenCalled();
		expect(f.prepare).not.toHaveBeenCalled();
		await f.command("on");
		expect(await f.call("read", { path: "README.md" })).toMatchObject({ block: true, reason: expect.stringContaining("configuration is invalid") });
	});
	it("updates model guidance and status to match the actual off/on state", async () => {
		const f = fixture({ hasUI: true });
		await f.command("off");
		const disabled = await f.handlers.get("before_agent_start")!({ systemPrompt: "Original instructions" }, f.ctx);
		expect(disabled.systemPrompt).toContain("pi-auto is OFF");
		expect(disabled.systemPrompt).not.toContain("Bash is sandboxed by default");
		await f.command("on");
		const enabled = await f.handlers.get("before_agent_start")!({ systemPrompt: "Original instructions" }, f.ctx);
		expect(enabled.systemPrompt).toContain("Bash is sandboxed by default");
		await f.command("status");
		expect(f.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("openai/gpt-6-luna (reasoning: off)"), "info");
	});
	it("releases pending wrappers before turning off and reloads the configured state", async () => {
		const f = fixture(); const input = { command: "echo wrapped" };
		await f.call("bash", input);
		await f.command("off");
		expect(input.command).toBe("echo wrapped");
		expect(f.cancel).toHaveBeenCalledOnce();
		expect(f.reset).toHaveBeenCalledOnce();
		await f.command("reload");
		await f.call("bash", input);
		expect(input.command).toBe("wrapped(echo wrapped)");
	});
	it("does not check sandbox dependencies at startup when configured off", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS); settings.enabled = false;
		const f = fixture({ settings, hasUI: true });
		f.availability.mockImplementation(() => { throw new Error("Sandbox is unavailable"); });
		await f.handlers.get("session_start")!({}, f.ctx);
		expect(f.availability).not.toHaveBeenCalled();
		expect(f.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("OFF"), "warning");
		expect(await f.call("bash", { command: "echo host" })).toBeUndefined();
	});
	it("keeps session toggles in memory rather than persisting them to the next session", async () => {
		const f = fixture({ result: denied });
		await f.command("off");
		expect(await f.call("memory_add", { content: "Allowed while off" })).toBeUndefined();
		await f.handlers.get("session_start")!({}, f.ctx);
		expect(await f.call("memory_add", { content: "Reviewed again" })).toMatchObject({ block: true });
	});
	it.each(["review", "approval"])("invalidates stale %s when auto is turned off", async (stage) => {
		const f = fixture({ result: denied, hasUI: true });
		let release!: () => void;
		if (stage === "review") f.review.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(allowed); }));
		else vi.mocked(f.ctx.ui.confirm).mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(true); }));
		const pending = f.call("memory_add", { content: "Pending memory" });
		await Promise.resolve();
		await f.command("off");
		release();
		expect(await pending).toMatchObject({ block: true, reason: expect.stringContaining("session or policy changed") });
		expect(await f.call("memory_add", { content: "Fresh memory while off" })).toBeUndefined();
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
