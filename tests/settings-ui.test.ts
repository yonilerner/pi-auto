import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	formatLayerAttribution,
	formatSavedSettingNotification,
	formatSavedSettingValue,
	registerSettingsCommand,
	type SettingsUIDeps,
} from "../extensions/settings-ui/index.ts";
import type { PiAutoSettings, SettingsLayerMap } from "../extensions/types.ts";
import {
	formatCommandPrefix,
	parseCommandPrefixInput,
} from "../extensions/settings-ui/field-codecs.ts";

describe("formatLayerAttribution", () => {
	it("marks user-global values that match the default", () => {
		expect(formatLayerAttribution("user-global", "normal", "normal")).toBe(
			"[user-global, default]",
		);
	});

	it("marks per-project values that match the default", () => {
		expect(formatLayerAttribution("per-project", "false", "false")).toBe(
			"[per-project, default]",
		);
	});

	it("does not mark non-default user-configured values as default", () => {
		expect(formatLayerAttribution("user-global", "verbose", "normal")).toBe("[user-global]");
	});

	it("does not duplicate default for default or env layers", () => {
		expect(formatLayerAttribution("default", "normal", "normal")).toBe("[default]");
		expect(formatLayerAttribution("env", "default", "default")).toBe("[env]");
	});
});

describe("formatSavedSettingNotification", () => {
	it("includes the saved value", () => {
		expect(
			formatSavedSettingNotification(
				"Reviewer model",
				"gpt-5-mini",
				"user-global",
				"/tmp/pi-agent/pi-auto.json",
			),
		).toBe(
			"pi-auto settings: saved Reviewer model = gpt-5-mini to user-global (/tmp/pi-agent/pi-auto.json)",
		);
	});
});

describe("formatSavedSettingValue", () => {
	it("makes empty and whitespace-sensitive values visible", () => {
		expect(formatSavedSettingValue("")).toBe('""');
		expect(formatSavedSettingValue("  model")).toBe('"  model"');
		expect(formatSavedSettingValue("model\nnext")).toBe('"model\\nnext"');
	});
});

describe("settings command registration", () => {
	it("registers both commands and obtains the no-UI path from injected dependencies", async () => {
		const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
		const pi = {
			registerCommand: vi.fn((name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
				commands.set(name, command);
			}),
		} as unknown as ExtensionAPI;
		const getPaths = vi.fn(() => ({ userGlobal: "/tmp/injected-pi-auto.json", perProject: null }));
		const deps: SettingsUIDeps = {
			getSettings: vi.fn(() => ({} as PiAutoSettings)),
			applySettings: vi.fn(),
			getLayers: vi.fn(() => ({} as SettingsLayerMap)),
			setLayers: vi.fn(),
			getPaths,
			setPaths: vi.fn(),
			defaults: {} as PiAutoSettings,
		};
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
		try {
			registerSettingsCommand(pi, deps);
			expect([...commands.keys()].sort()).toEqual(["pi-auto-reload-settings", "pi-auto-settings"]);

			await commands.get("pi-auto-settings")?.handler("", {
				hasUI: false,
			} as ExtensionContext);
			expect(getPaths).toHaveBeenCalledOnce();
			expect(log).toHaveBeenCalledWith(
				"pi-auto-settings: no UI available. Edit the JSON file at /tmp/injected-pi-auto.json directly.",
			);
		} finally {
			log.mockRestore();
		}
	});
});

describe("command prefix UI parsing", () => {
	it("parses shell-word command prefixes", () => {
		expect(parseCommandPrefixInput("gh pr view")).toEqual(["gh", "pr", "view"]);
		expect(parseCommandPrefixInput("npm test -- --grep 'with spaces'")).toEqual([
			"npm",
			"test",
			"--",
			"--grep",
			"with spaces",
		]);
	});

	it("accepts JSON array input for exact argv entries", () => {
		expect(parseCommandPrefixInput('["cmd", "arg with spaces"]')).toEqual([
			"cmd",
			"arg with spaces",
		]);
	});

	it("rejects empty command prefixes", () => {
		expect(() => parseCommandPrefixInput("   ")).toThrow("command prefix cannot be empty");
		expect(() => parseCommandPrefixInput("[]")).toThrow("command prefix cannot be empty");
	});

	it("renders prefixes as shell-ish words", () => {
		expect(formatCommandPrefix(["gh", "pr", "view"])).toBe("gh pr view");
		expect(formatCommandPrefix(["cmd", "arg with spaces"])).toBe("cmd 'arg with spaces'");
	});
});
