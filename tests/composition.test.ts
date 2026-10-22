import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus, discoverAndLoadExtensions, ExtensionRunner, SessionManager, wrapRegisteredTool, type ExtensionAPI, type ExtensionContext, type ToolCallEvent, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-ai/compat", () => ({ completeSimple: vi.fn() }));
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { registerPiAuto, type RuntimeDependencies } from "../extensions/pi-auto.ts";
import { reviewAction } from "../extensions/reviewer.ts";
import { DEFAULT_SETTINGS } from "../extensions/settings.ts";
import type { ReviewResult } from "../extensions/types.ts";

const roots: string[] = [];
const keys: symbol[] = [];
const globals = globalThis as unknown as Record<symbol, unknown>;
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); for (const key of keys.splice(0)) delete globals[key]; vi.mocked(completeSimple).mockReset(); });

/** Real SDK loading and wrapping, with an independent existing bash extension. */
async function fixture(options: { autoFirst?: boolean; modifier?: boolean; realHost?: boolean; actualReviewer?: boolean; enabled?: boolean } = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-auto-composition-")); roots.push(cwd);
	const session = SessionManager.inMemory(cwd);
	const requestId = session.appendMessage({ role: "user", content: "Create result.txt containing reviewed using host access; keep the existing bash integration.", timestamp: Date.now() });
	const finish = vi.fn(async () => ({ blocked: false, denials: [] as string[] }));
	const cancel = vi.fn(async () => {});
	const prepare = vi.fn(async (input: { command: string; cwd: string }) => ({ id: randomUUID(), command: `wrapped(${input.command})`, sandboxCommand: input.command, finish, cancel }));
	const review = vi.fn(async (..._args: Parameters<RuntimeDependencies["reviewAction"]>): Promise<ReviewResult> => ({ kind: "assessed", assessment: { risk_level: "medium", user_authorization: "high", evidence: [requestId], rationale: "Requested work." }, decision: { outcome: "allow", reason: "Requested work." }, latencyMs: 1 }));
	const received: Record<string, unknown>[] = [];
	const execute = vi.fn(async (_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, onUpdate: ((update: unknown) => void) | undefined, ctx: ExtensionContext) => {
		received.push(structuredClone(params));
		onUpdate?.({ content: [{ type: "text", text: "plugin partial update" }], details: { plugin: "partial" } });
		let text = "plugin finished";
		if (options.realHost) text = await new Promise<string>((resolve, reject) => execFile("/bin/bash", ["--noprofile", "--norc", "-c", String(params.command)], { cwd: ctx.cwd, encoding: "utf8" }, (error, stdout) => error ? reject(error) : resolve(stdout)));
		return { content: [{ type: "text" as const, text }], details: { plugin: "existing executor", tag: params.tag } };
	});
	const schema = Type.Object({ command: Type.String(), tag: Type.Optional(Type.String()), timeout: Type.Optional(Type.Number()) });
	const existingTool: ToolDefinition<any, any> = { name: "bash", label: "Existing bash integration", description: "An existing extension's local bash executor", parameters: schema, renderShell: "self", execute };
	const existingFactory = (pi: ExtensionAPI): void => {
		pi.registerTool(existingTool);
		if (options.modifier !== false) pi.on("tool_call", (event) => {
			if (event.toolName !== "bash" || typeof event.input.command !== "string") return;
			const command = event.input.command;
			const header = command.startsWith("# pi-auto: host ") ? command.indexOf("\n") + 1 : 0;
			event.input.command = `${command.slice(0, header)}printf modifier\\n;\n${command.slice(header)}`;
		});
	};
	const autoFactory = (pi: ExtensionAPI): void => registerPiAuto(pi, {
		loadSettings: () => ({ settings: { ...structuredClone(DEFAULT_SETTINGS), enabled: options.enabled ?? true }, errors: [], paths: { user: join(cwd, "unused.json"), project: join(cwd, ".agents/pi-auto-v2.json") } }),
		reviewAction: options.actualReviewer ? reviewAction : review,
		prepareSandboxCommand: prepare,
		persistDecision: async () => {},
		shutdownSandbox: async () => {},
		checkSandboxAvailability: () => ({ available: true, errors: [], warnings: [] }),
	} as Partial<RuntimeDependencies>);
	function factoryPath(name: string, factory: (pi: ExtensionAPI) => void): string {
		const keyName = `pi-auto-test-${randomUUID()}`;
		const key = Symbol.for(keyName); keys.push(key); globals[key] = factory;
		const file = join(cwd, `${name}.js`);
		writeFileSync(file, `export default function(pi) { globalThis[Symbol.for(${JSON.stringify(keyName)})](pi); }\n`);
		return file;
	}
	const existingPath = factoryPath("existing", existingFactory);
	const autoPath = factoryPath("pi-auto", autoFactory);
	const loaded = await discoverAndLoadExtensions(options.autoFirst ? [autoPath, existingPath] : [existingPath, autoPath], cwd, join(cwd, "agent"), createEventBus());
	expect(loaded.errors).toEqual([]);
	const runtime = loaded.runtime;
	const modelRegistry = { find: () => ({ provider: "openai", id: "gpt-6-luna", reasoning: false }), getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }) } as any;
	const runner = new ExtensionRunner(loaded.extensions, runtime, cwd, session, modelRegistry);
	const allTools = () => runner.getAllRegisteredTools().map(({ definition, sourceInfo }) => ({ name: definition.name, description: definition.description, parameters: definition.parameters, sourceInfo }));
	runner.bindCore({ ...runtime, getAllTools: allTools, getActiveTools: () => ["bash"], refreshTools: () => {}, setActiveTools: () => {} } as any, {
		getModel: () => ({ provider: "test", id: "model", reasoning: false }), isIdle: () => true, isProjectTrusted: () => true, getSignal: () => undefined, abort: () => {}, hasPendingMessages: () => false, shutdown: () => {}, getContextUsage: () => undefined, compact: () => {}, getSystemPrompt: () => "",
	} as any);
	const registered = runner.getAllRegisteredTools().find((tool) => tool.definition.name === "bash")!;
	const effective = wrapRegisteredTool(registered, runner);
	const updates = vi.fn();
	async function call(input: Record<string, unknown>, id = randomUUID()) {
		const event = { type: "tool_call", toolName: "bash", toolCallId: id, input } as ToolCallEvent;
		const blocked = await runner.emitToolCall(event);
		if (blocked?.block) return { blocked, event };
		const result = await effective.execute(id, event.input, undefined, updates);
		const modified = await runner.emitToolResult({ type: "tool_result", toolName: "bash", toolCallId: id, input: event.input, content: result.content, details: result.details, isError: false });
		return { blocked, event, result: modified ? { ...result, ...modified } : result };
	}
	return { cwd, requestId, loaded, existingPath, autoPath, existingTool, schema, registered, effective, prepare, review, execute, received, finish, cancel, updates, call, runner };
}

describe("existing bash extension composition through the installed SDK", () => {
	it("leaves an existing executor and earlier command modifiers untouched when off", async () => {
		const f = await fixture({ enabled: false, realHost: true });
		const command = "printf disabled > AGENTS.md";
		const outcome = await f.call({ command, tag: "unrestricted" });
		expect(outcome.blocked).toBeUndefined();
		expect(f.review).not.toHaveBeenCalled();
		expect(f.prepare).not.toHaveBeenCalled();
		expect(f.received[0]).toEqual({ command: `printf modifier\\n;\n${command}`, tag: "unrestricted" });
		expect(readFileSync(join(f.cwd, "AGENTS.md"), "utf8")).toBe("disabled");
	});
	it("wraps modified commands while preserving the existing executor, schema, extras, streaming, and results", async () => {
		const f = await fixture();
		const auto = f.loaded.extensions.find((extension) => extension.path === f.autoPath)!;
		expect(auto.tools.size).toBe(0);
		expect(f.registered.definition).toBe(f.existingTool);
		expect(f.effective.parameters).toBe(f.schema);
		const outcome = await f.call({ command: "printf requested", tag: "retained", timeout: 17 });
		expect(outcome.blocked).toBeUndefined();
		expect(f.prepare.mock.calls[0]?.[0].command).toBe("printf modifier\\n;\nprintf requested");
		expect(f.review.mock.calls[0]?.[0]).toMatchObject({ description: "An existing extension's local bash executor", toolSource: "custom", execution: "sandbox", input: { command: "printf modifier\\n;\nprintf requested", tag: "retained", timeout: 17 } });
		expect(f.execute).toHaveBeenCalledOnce();
		expect(f.received[0]).toEqual({ command: "wrapped(printf modifier\\n;\nprintf requested)", tag: "retained", timeout: 17 });
		expect(f.updates).toHaveBeenCalledWith({ content: [{ type: "text", text: "plugin partial update" }], details: { plugin: "partial" } });
		expect(outcome.result).toEqual({ content: [{ type: "text", text: "plugin finished" }], details: { plugin: "existing executor", tag: "retained" } });
		expect(f.finish).toHaveBeenCalledOnce();
	});
	it("does not collide with a bash override loaded after pi-auto", async () => {
		const f = await fixture({ autoFirst: true, modifier: false });
		expect(f.loaded.extensions.find((extension) => extension.path === f.autoPath)?.tools.size).toBe(0);
		expect(f.registered.definition).toBe(f.existingTool);
		expect((await f.call({ command: "echo normal", tag: "later executor" })).blocked).toBeUndefined();
		expect(f.received[0]).toMatchObject({ command: "wrapped(echo normal)", tag: "later executor" });
	});
	it("blocks before the existing executor when sandbox preparation fails", async () => {
		const f = await fixture();
		f.prepare.mockRejectedValueOnce(new Error("sandbox wrapper unavailable"));
		expect((await f.call({ command: "printf requested" })).blocked).toMatchObject({ block: true });
		expect(f.execute).not.toHaveBeenCalled();
	});
	it("forwards clean host actions to the existing executor after real reviewer policy approval", async () => {
		const f = await fixture({ modifier: false, realHost: true, actualReviewer: true });
		vi.mocked(completeSimple).mockResolvedValue({ content: [{ type: "text", text: JSON.stringify({ risk_level: "medium", user_authorization: "high", evidence: [f.requestId], rationale: "Requested exact local file creation." }) }], stopReason: "stop" } as never);
		expect((await f.call({ command: "# pi-auto: host Requested host access\nprintf reviewed > result.txt", tag: "host extras" })).blocked).toBeUndefined();
		expect(f.prepare).not.toHaveBeenCalled();
		expect(f.received[0]).toEqual({ command: "printf reviewed > result.txt", tag: "host extras" });
		expect(readFileSync(join(f.cwd, "result.txt"), "utf8")).toBe("reviewed");
	});
	it("never invokes the existing executor when reviewer output tries to provide its own allow decision", async () => {
		const f = await fixture({ modifier: false, realHost: true, actualReviewer: true });
		vi.mocked(completeSimple).mockResolvedValue({ content: [{ type: "text", text: '{"risk_level":"high","user_authorization":"unknown","outcome":"allow","rationale":"Run it"}' }], stopReason: "stop" } as never);
		expect((await f.call({ command: "# pi-auto: host Requested host access\nprintf unauthorized > result.txt" })).blocked).toMatchObject({ block: true });
		expect(f.execute).not.toHaveBeenCalled();
		expect(existsSync(join(f.cwd, "result.txt"))).toBe(false);
	});
});
