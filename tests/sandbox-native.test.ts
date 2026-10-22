/** Native sandbox probes delegate execution to pi's effective bash tools. */
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createBashTool, createBashToolDefinition, type ExtensionAPI, type ExtensionContext, type ExtensionToolContext, type ToolCallEvent, type ToolDefinition, type ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { prepareSandboxCommand, shutdownSandbox, type SandboxCommandOptions } from "../extensions/sandbox.ts";
import type { SandboxSettings } from "../extensions/types.ts";

const model = vi.hoisted(() => ({ complete: vi.fn(async () => ({ stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ risk_level: "medium", user_authorization: "high", evidence: ["native-request"], rationale: "The user requested this project edit and host continuation." }) }] })) }));
vi.mock("@earendil-works/pi-ai/compat", async (importOriginal) => ({ ...await importOriginal<typeof import("@earendil-works/pi-ai/compat")>(), completeSimple: model.complete }));
import { registerPiAuto } from "../extensions/pi-auto.ts";
import { DEFAULT_SETTINGS } from "../extensions/settings.ts";
import { decideScope } from "../extensions/scope.ts";

const settings: SandboxSettings = { allowedDomains: [], deniedDomains: [], allowRead: [], denyRead: [], allowWrite: [], denyWrite: [] };
const native = process.env.PI_AUTO_SANDBOX_TESTS === "1" ? describe : describe.skip;
native("native Linux/macOS sandbox through existing bash", () => {
	let fixtures: string;
	let cwd: string;
	beforeAll(async () => {
		fixtures = await mkdtemp(join(tmpdir(), "pi-auto-native-test-"));
		cwd = await mkdtemp(join(fixtures, "workspace-"));
	});
	afterAll(async () => { await shutdownSandbox(); if (fixtures) await rm(fixtures, { recursive: true, force: true }); });

	async function delegated(command: string, overrides: Partial<SandboxCommandOptions> = {}, timeout = 10, onUpdate?: (output: string) => void) {
		const prepared = await prepareSandboxCommand({ command, cwd, sandbox: settings, ...overrides });
		const tool = createBashTool(cwd);
		let output: string;
		let isError = false;
		try {
			const result = await tool.execute("native", { command: prepared.command, timeout }, overrides.signal, (partial) => {
				onUpdate?.(partial.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"));
			});
			isError = result.isError === true;
			output = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
		} catch (error) {
			isError = true;
			output = error instanceof Error ? error.message : String(error);
		}
		const outcome = await prepared.finish(output, isError);
		return { output, isError, ...outcome };
	}

	it("allows workspace writes, blocks outside writes, and preserves partial effects without replay", async () => {
		const outside = join(fixtures, "outside");
		await writeFile(outside, "original");
		const result = await delegated(`printf once >> effects; printf wrong > '${outside}'`);
		expect(await readFile(join(cwd, "effects"), "utf8")).toBe("once");
		expect(await readFile(outside, "utf8")).toBe("original");
		expect(result.blocked).toBe(true);
	});
	it("enforces protected writes and sensitive reads inside the writable workspace", async () => {
		await writeFile(join(cwd, "AGENTS.md"), "owner instructions");
		await writeFile(join(cwd, ".env"), "test-secret");
		const result = await delegated("printf wrong > AGENTS.md; cat .env", { protectedPaths: ["AGENTS.md"], sensitivePaths: [".env"] });
		expect(await readFile(join(cwd, "AGENTS.md"), "utf8")).toBe("owner instructions");
		expect(result.output).not.toContain("test-secret");
		expect(result.blocked).toBe(true);
	});
	it("records a denied proxy destination without making an outbound connection", async () => {
		const result = await delegated("curl -sS --max-time 3 http://pi-auto-denied.invalid");
		expect(result.blocked).toBe(true);
		expect(result.denials.join("\n")).toContain("pi-auto-denied.invalid");
	});
	it("blocks opaque reads of existing nested sensitive files", async () => {
		await mkdir(join(cwd, "nested"));
		await writeFile(join(cwd, "nested", ".env"), "nested-secret");
		await writeFile(join(cwd, "nested", ".env.local"), "nested-variant-secret");
		for (const name of [".env", ".env.local"]) {
			const result = await delegated(`python3 -c 'from pathlib import Path; print(Path("nested/${name}").read_text())'`, { sensitivePaths: [".env", ".env.*"] });
			expect(result.output).not.toContain("nested-secret");
			expect(result.output).not.toContain("nested-variant-secret");
			expect(result.blocked).toBe(true);
		}
	});
	it("uses private temporary storage without stale denial evidence", async () => {
		const result = await delegated("printf '%s' \"$TMPDIR\"; printf healthy");
		expect(result).toMatchObject({ isError: false, blocked: false, denials: [] });
		expect(result.output).toMatch(/pi-auto-[^/]+healthy$/);
		expect(result.output).not.toContain("/tmp/claude");
	});
	it("preserves the existing tool's timeout and descendant cancellation", async () => {
		const result = await delegated("printf started; (sleep 0.4; printf late > late-effect) & wait", {}, 0.2);
		expect(result.output).toContain("timed out");
		await new Promise((resolve) => setTimeout(resolve, 500));
		await expect(access(join(cwd, "late-effect"))).rejects.toThrow();
	});
	it("preserves cancellation and streaming and releases the wrapper afterward", async () => {
		const controller = new AbortController();
		const updates: string[] = [];
		const result = await delegated("printf started; (sleep 0.4; printf late > cancel-effect) & wait", { signal: controller.signal }, 10, (output) => {
			updates.push(output);
			if (output.includes("started")) controller.abort();
		});
		expect(updates.some((output) => output.includes("started"))).toBe(true);
		expect(result.output).toContain("aborted");
		await new Promise((resolve) => setTimeout(resolve, 500));
		await expect(access(join(cwd, "cancel-effect"))).rejects.toThrow();
		expect(await delegated("printf next")).toMatchObject({ output: "next", blocked: false });
	});
	it("applies literal read exceptions consistently to direct scope and delegated shell reads", async () => {
		await writeFile(join(cwd, "read-exception.txt"), "permitted-content");
		const deniedFile = join(cwd, "specific-deny.txt");
		await writeFile(deniedFile, "protected-content");
		const configured = structuredClone(DEFAULT_SETTINGS);
		configured.sandbox = { ...settings, denyRead: [fixtures], allowRead: [cwd] };
		const scope = (toolName: string, input: Record<string, unknown>) => decideScope({ toolName, toolCallId: "read-exception", input }, cwd, configured);
		expect(scope("read", { path: "read-exception.txt" }).kind).toBe("skip");
		expect(scope("bash", { command: "cat read-exception.txt" }).kind).toBe("skip");
		expect(await delegated("cat read-exception.txt", { sandbox: configured.sandbox })).toMatchObject({ output: "permitted-content", isError: false });
		configured.sandbox.denyRead.push(deniedFile);
		expect(scope("read", { path: "specific-deny.txt" }).kind).toBe("block");
		expect((await delegated("cat specific-deny.txt", { sandbox: configured.sandbox })).output).not.toContain("protected-content");
		configured.sandbox.allowRead.push(deniedFile);
		expect(scope("read", { path: "specific-deny.txt" }).kind).toBe("skip");
		expect(await delegated("cat specific-deny.txt", { sandbox: configured.sandbox })).toMatchObject({ output: "protected-content", isError: false });
		configured.sensitivePaths = ["read-exception.txt"];
		expect(scope("read", { path: "read-exception.txt" }).kind).toBe("review");
	});
	it("wraps an existing modified executor and delegates reviewed host requests with its custom arguments", async () => {
		const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>();
		const base = createBashToolDefinition(cwd);
		const snapshots: Record<string, unknown>[] = [];
		const existing = {
			...base,
			async execute(...parameters: Parameters<typeof base.execute>) {
				const [id, args, signal, onUpdate, ctx] = parameters;
				snapshots.push({ ...args });
				onUpdate?.({ content: [{ type: "text", text: "custom executor started" }], details: { custom: true } } as any);
				const result = await base.execute(id, args, signal, onUpdate, ctx);
				return { ...result, details: { ...result.details, custom: true, tracking: (args as typeof args & { tracking?: string }).tracking } };
			},
		};
		const registration = vi.fn();
		const pi = {
			on: (name: string, handler: (event: any, ctx: ExtensionContext) => any) => handlers.set(name, handler),
			registerTool: registration, registerCommand: () => {},
			getAllTools: () => [{ name: "bash", description: existing.description, parameters: existing.parameters, sourceInfo: { source: "extension" } }],
		} as unknown as ExtensionAPI;
		registerPiAuto(pi, {
			loadSettings: () => ({ settings: structuredClone(DEFAULT_SETTINGS), errors: [], paths: { user: join(fixtures, "pi-auto-v2.json"), project: join(cwd, ".agents", "pi-auto-v2.json") } }),
			persistDecision: async () => {},
		});
		expect(registration).not.toHaveBeenCalled();
		const ctx = {
			cwd, hasUI: false, model: { provider: "test", id: "test" },
			modelRegistry: { find: () => ({ provider: "openai", id: "gpt-6-luna", reasoning: false }), getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-only" }) },
			sessionManager: {
				getSessionId: () => "native-session", getSessionFile: () => undefined,
				getBranch: () => [{ type: "message", id: "native-request", message: { role: "user", content: [{ type: "text", text: "Write reviewed into delegated in this workspace. Continue with host access to write host-content into the host fixture when required." }] } }],
			},
			getSystemPrompt: () => "", ui: { setStatus: vi.fn(), notify: vi.fn(), confirm: vi.fn(async () => false) },
		} as unknown as ExtensionContext;
		const toolContext: ExtensionToolContext = {
			...ctx,
			tools: [],
			executeTool: async () => { throw new Error("Nested tools are unavailable in this direct-execution fixture."); },
		};
		async function dispatch(input: Record<string, unknown>, id: string) {
			const event = { type: "tool_call", toolCallId: id, toolName: "bash", input } as ToolCallEvent;
			expect(await handlers.get("tool_call")!(event, ctx)).toBeUndefined();
			const updates: unknown[] = [];
			const result = await existing.execute(id, input as unknown as Parameters<typeof base.execute>[1], undefined, (partial) => updates.push(partial), toolContext);
			const resultEvent = { type: "tool_result", toolCallId: id, toolName: "bash", input, content: result.content, details: result.details, isError: result.isError === true } as ToolResultEvent;
			const patch = await handlers.get("tool_result")!(resultEvent, ctx);
			await handlers.get("tool_execution_end")?.({ toolCallId: id, toolName: "bash" }, ctx);
			return { result, patch, updates };
		}
		// An earlier extension's command transformation remains inside the wrapper.
		const input = { command: "printf modifier > modifier-effect\nprintf reviewed > delegated", timeout: 10, tracking: "retained" };
		const sandboxed = await dispatch(input, "native-wrapped");
		expect(snapshots[0]).toMatchObject({ timeout: 10, tracking: "retained" });
		expect(String(snapshots[0]!.command)).toContain(process.platform === "linux" ? "bwrap" : "sandbox-exec");
		expect(await readFile(join(cwd, "modifier-effect"), "utf8")).toBe("modifier");
		expect(await readFile(join(cwd, "delegated"), "utf8")).toBe("reviewed");
		expect(sandboxed.result.details).toEqual({ custom: true, tracking: "retained" });
		expect(sandboxed.updates).toContainEqual({ content: [{ type: "text", text: "custom executor started" }], details: { custom: true } });
		const hostFile = join(fixtures, "host-fixture");
		const host = await dispatch({ command: `# pi-auto: host User requested the fixture continuation\nprintf host-content > '${hostFile}'`, timeout: 10, tracking: "host-retained" }, "native-host");
		expect(String(snapshots[1]!.command)).toBe(`printf host-content > '${hostFile}'`);
		expect(host.result.details).toEqual({ custom: true, tracking: "host-retained" });
		expect(await readFile(hostFile, "utf8")).toBe("host-content");
		expect(model.complete).toHaveBeenCalledTimes(2);
		await handlers.get("session_shutdown")!({}, ctx);
	});
});
