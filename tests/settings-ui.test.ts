import { describe, expect, it } from "vitest";

import { formatLayerAttribution } from "../extensions/settings-ui.ts";

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
