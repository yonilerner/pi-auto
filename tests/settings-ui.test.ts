import { describe, expect, it } from "vitest";

import {
	formatLayerAttribution,
	formatSavedSettingNotification,
	formatSavedSettingValue,
} from "../extensions/settings-ui.ts";

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
