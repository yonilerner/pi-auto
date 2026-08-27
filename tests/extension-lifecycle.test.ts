import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const reviewAction = vi.hoisted(() => vi.fn());

vi.mock("../extensions/reviewer.ts", () => ({ reviewAction }));

import piAuto from "../extensions/pi-auto.ts";

type EventHandler = (event: any, ctx: ExtensionContext) => Promise<unknown> | unknown;
type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void>;

class FakeExtensionAPI {
	readonly events = new Map<string, EventHandler>();
	readonly commands = new Map<string, { description?: string; handler: CommandHandler }>();

	on(event: string, handler: EventHandler): void {
		this.events.set(event, handler);
	}

	registerCommand(name: string, command: { description?: string; handler: CommandHandler }): void {
		this.commands.set(name, command);
	}

	asExtensionAPI(): ExtensionAPI {
		return this as unknown as ExtensionAPI;
	}
}

function makeContext(cwd: string, hasUI = false): ExtensionContext {
	return {
		hasUI,
		mode: hasUI ? "tui" : "print",
		cwd,
		ui: {
			notify: vi.fn(),
			select: vi.fn(),
			setStatus: vi.fn(),
		},
		abort: vi.fn(),
		isIdle: () => true,
		hasPendingMessages: () => false,
		shutdown: vi.fn(),
		getContextUsage: () => undefined,
		compact: vi.fn(),
		getSystemPrompt: () => "",
		sessionManager: { getBranch: () => [], getEntries: () => [] } as unknown as ExtensionContext["sessionManager"],
		modelRegistry: {} as ExtensionContext["modelRegistry"],
		model: undefined,
		signal: undefined,
	} as unknown as ExtensionContext;
}

function deniedReview() {
	return {
		kind: "assessed",
		assessment: {
			outcome: "deny",
			risk_level: "high",
			user_authorization: "none",
			rationale: "deterministic test denial",
		},
		diagnostics: {
			modelSource: "configured",
			promptFormat: "pi-auto",
			latencyMs: 0,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			rawText: "",
		},
	};
}

function toolCall(id: string) {
	return {
		toolName: "bash",
		toolCallId: id,
		input: { command: "rm -rf /tmp/test-target" },
	};
}

describe("default pi-auto extension lifecycle", () => {
	let root: string | undefined;
	let previousAgentDir: string | undefined;

	afterEach(() => {
		reviewAction.mockReset();
		if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
		else process.env.PI_AGENT_DIR = previousAgentDir;
		if (root) rmSync(root, { recursive: true, force: true });
		root = undefined;
		previousAgentDir = undefined;
	});

	it("registers its default surface, loads session settings, and scopes denials to turns", async () => {
		root = mkdtempSync(path.join(tmpdir(), "pi-auto-extension-"));
		const agentDir = path.join(root, "agent");
		mkdirSync(path.join(root, ".agents"), { recursive: true });
		writeFileSync(
			path.join(root, ".agents", "pi-auto.json"),
			JSON.stringify({
				reviewerModel: "integration-reviewer",
				enableDigest: false,
				maxConsecutiveDenialsPerTurn: 2,
				maxTotalDenialsPerTurn: 2,
				sandbox: { mode: "off" },
			}),
		);
		previousAgentDir = process.env.PI_AGENT_DIR;
		process.env.PI_AGENT_DIR = agentDir;

		const api = new FakeExtensionAPI();
		piAuto(api.asExtensionAPI());

		expect([...api.events.keys()].sort()).toEqual([
			"session_shutdown",
			"session_start",
			"tool_call",
			"tool_result",
			"turn_end",
			"turn_start",
		]);
		expect([...api.commands.keys()].sort()).toEqual([
			"pi-auto",
			"pi-auto-disable",
			"pi-auto-enable",
			"pi-auto-reload-settings",
			"pi-auto-sandbox",
			"pi-auto-sandbox-log",
			"pi-auto-settings",
			"pi-auto-toggle-announce",
			"sandbox-log",
			"sandbox-review-log",
		]);

		const inspectionCtx = makeContext(root, true);
		await api.events.get("session_start")?.({}, inspectionCtx);
		(inspectionCtx.ui.notify as ReturnType<typeof vi.fn>).mockClear();
		await api.commands.get("pi-auto")?.handler("", inspectionCtx);
		const statusMessage = (inspectionCtx.ui.notify as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
		expect(statusMessage).toContain("openai/integration-reviewer");
		expect(statusMessage).toContain("rolling digest:            off");

		const ctx = makeContext(root);
		reviewAction.mockResolvedValue(deniedReview());
		const toolHandler = api.events.get("tool_call");
		const turnStart = api.events.get("turn_start");
		const turnEnd = api.events.get("turn_end");
		if (!toolHandler || !turnStart || !turnEnd) throw new Error("missing lifecycle handler");

		turnStart({ turnIndex: 7 }, ctx);
		expect(await toolHandler(toolCall("first"), ctx)).toMatchObject({ block: true });
		turnEnd({}, ctx);
		expect(await toolHandler(toolCall("after-end"), ctx)).toMatchObject({
			block: true,
			reason: expect.not.stringContaining("circuit breaker tripped"),
		});

		turnStart({ turnIndex: 8 }, ctx);
		expect(await toolHandler(toolCall("new-turn-first"), ctx)).toMatchObject({ block: true });
		expect(await toolHandler(toolCall("new-turn-second"), ctx)).toMatchObject({
			block: true,
			reason: expect.stringContaining("circuit breaker tripped"),
		});
	});
});
