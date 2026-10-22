import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Settings } from "./types.ts";

export const DEFAULT_SETTINGS: Settings = {
	enabled: true,
	reviewer: { provider: "openai", model: "gpt-6-luna", reasoning: "off", timeoutMs: 30_000 },
	context: { maxEntries: 24, maxEntryChars: 4_000, maxTotalChars: 24_000, maxPinnedMessages: 12 },
	sensitivePaths: [".env", ".env.*", "~/.ssh", "~/.aws", "~/.config", "~/.pi/agent/auth.json"],
	protectedPaths: [".git/hooks", ".git/config", "AGENTS.md"],
	sandbox: { allowedDomains: [], deniedDomains: [], allowRead: [], denyRead: [], allowWrite: [], denyWrite: [] },
	notices: "denials",
};

export function agentDirectory(home = homedir(), env = process.env): string {
	const configured = env.PI_AGENT_DIR || env.PI_CODING_AGENT_DIR;
	return configured ? resolve(configured.startsWith("~/") ? join(home, configured.slice(2)) : configured) : join(home, ".pi", "agent");
}

export function settingsPaths(cwd: string, home = homedir(), env = process.env): { user: string; project: string } {
	return { user: join(agentDirectory(home, env), "pi-auto-v2.json"), project: join(cwd, ".agents", "pi-auto-v2.json") };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Validate complete files before applying them: malformed settings fail closed. */
export function applySettings(base: Settings, input: unknown): Settings {
	if (!isRecord(input)) throw new Error("settings must be a JSON object");
	const result = structuredClone(base);
	for (const [key, value] of Object.entries(input)) {
		if (!Object.hasOwn(DEFAULT_SETTINGS, key)) throw new Error(`unknown setting: ${key}`);
		if (key === "enabled") {
			if (typeof value !== "boolean") throw new Error("enabled must be boolean");
			result.enabled = value;
		} else if (key === "notices") {
			if (value !== "denials" && value !== "all") throw new Error("notices must be denials or all");
			result.notices = value;
		} else if (key === "sensitivePaths" || key === "protectedPaths") {
			result[key] = stringArray(value, key);
		} else if (key === "sandbox") {
			if (!isRecord(value)) throw new Error("sandbox must be an object");
			for (const [name, paths] of Object.entries(value)) {
				if (!Object.hasOwn(result.sandbox, name)) throw new Error(`unknown sandbox setting: ${name}`);
				const values = stringArray(paths, `sandbox.${name}`);
				if (name === "allowRead" && values.some((path) => /[*?[\]]/.test(path))) throw new Error("sandbox.allowRead accepts literal file or directory paths; glob exceptions are unsupported");
				result.sandbox[name as keyof Settings["sandbox"]] = values;
			}
		} else if (key === "reviewer") {
			if (!isRecord(value)) throw new Error("reviewer must be an object");
			for (const [name, option] of Object.entries(value)) {
				if (name === "provider" || name === "model") {
					if (typeof option !== "string") throw new Error(`reviewer.${name} must be a string`);
					result.reviewer[name] = option;
				} else if (name === "reasoning") {
					if (!["default", "off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(option))) throw new Error("unsupported reviewer reasoning");
					result.reviewer.reasoning = option as Settings["reviewer"]["reasoning"];
				} else if (name === "timeoutMs") result.reviewer.timeoutMs = positiveInteger(option, "reviewer.timeoutMs", 300_000);
				else throw new Error(`unknown reviewer setting: ${name}`);
			}
		} else if (key === "context") {
			if (!isRecord(value)) throw new Error("context must be an object");
			for (const [name, option] of Object.entries(value)) {
				if (!Object.hasOwn(result.context, name)) throw new Error(`unknown context setting: ${name}`);
				const minimum = name === "maxTotalChars" ? 512 : name === "maxEntryChars" ? 256 : 1;
				result.context[name as keyof Settings["context"]] = positiveInteger(option, `context.${name}`, 100_000, minimum);
			}
		}
	}
	if (!result.reviewer.provider.trim() || !result.reviewer.model.trim()) throw new Error("reviewer.provider and reviewer.model must both be nonempty; session-model fallback is disabled");
	return result;
}

function stringArray(value: unknown, name: string): string[] {
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.trim().length > 0)) {
		throw new Error(`${name} must be an array of nonempty strings`);
	}
	return [...new Set(value as string[])];
}

function positiveInteger(value: unknown, name: string, maximum: number, minimum = 1): number {
	if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
	return Number(value);
}

export interface LoadedSettings { settings: Settings; errors: string[]; paths: ReturnType<typeof settingsPaths> }

/** New names deliberately never read, migrate, or overwrite v1 settings. */
export function loadSettings(cwd: string, home = homedir()): LoadedSettings {
	const paths = settingsPaths(cwd, home);
	let settings = structuredClone(DEFAULT_SETTINGS);
	const errors: string[] = [];
	for (const path of [paths.user, paths.project]) {
		try {
			settings = applySettings(settings, JSON.parse(readFileSync(path, "utf8")));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return { settings, errors, paths };
}
