/**
 * Build a fake-but-real `ExtensionContext` for live tests so they invoke the
 * actual `reviewAction` flow instead of duplicating prompt assembly.
 *
 * The session manager is synthetic (built from test entries). Everything else
 * — modelRegistry, auth, anything reviewer.ts touches — is real, constructed
 * the same way pi's extension runtime constructs them.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

export interface SyntheticEntry {
	type: string;
	id?: string;
	summary?: string;
	message?: { role?: string; content?: unknown; toolName?: string; isError?: boolean };
}

let cachedAuthStorage: AuthStorage | undefined;
let cachedRegistry: ModelRegistry | undefined;

export function getSharedModelRegistry(): ModelRegistry {
	if (!cachedRegistry) {
		cachedAuthStorage = AuthStorage.create();
		cachedRegistry = ModelRegistry.create(cachedAuthStorage);
	}
	return cachedRegistry;
}

export interface BuildFakeContextOptions {
	entries: SyntheticEntry[];
	cwd?: string;
	/**
	 * Synthetic system prompt returned from `ctx.getSystemPrompt()`. Lets tests
	 * inject `<project_instructions>...</project_instructions>` blocks the way
	 * pi composes AGENTS.md content at runtime, so the reviewer's project-
	 * instructions extraction path is exercised end-to-end.
	 */
	systemPrompt?: string;
}

export function buildFakeContext(opts: BuildFakeContextOptions): ExtensionContext {
	const { entries, cwd = "/home/me/project", systemPrompt = "" } = opts;
	const sessionManager = {
		getBranch: () => entries,
		getEntries: () => entries,
		getLeafId: () => null,
		getSessionId: () => "pi-auto-live-test",
		getCwd: () => cwd,
	} as unknown as ExtensionContext["sessionManager"];

	const modelRegistry = getSharedModelRegistry();

	const ctx: Partial<ExtensionContext> = {
		ui: {
			notify: () => undefined,
			select: async () => undefined,
			confirm: async () => false,
			input: async () => undefined,
			editor: async () => undefined,
			setStatus: () => undefined,
			setWidget: () => undefined,
			setTitle: () => undefined,
			setEditorText: () => undefined,
		} as unknown as ExtensionContext["ui"],
		mode: "rpc",
		hasUI: false,
		cwd,
		sessionManager,
		modelRegistry,
		model: undefined,
		signal: undefined,
		isIdle: () => true,
		abort: () => undefined,
		hasPendingMessages: () => false,
		shutdown: () => undefined,
		getContextUsage: () => undefined,
		compact: () => undefined,
		getSystemPrompt: () => systemPrompt,
	};
	return ctx as ExtensionContext;
}
