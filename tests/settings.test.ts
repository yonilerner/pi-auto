import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applySettings, DEFAULT_SETTINGS, loadSettings, settingsPaths } from "../extensions/settings.ts";

const temporary: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-auto-settings-")); temporary.push(root);
	const cwd = join(root, "project"), app = join(root, "agent");
	mkdirSync(join(cwd, ".agents"), { recursive: true }); mkdirSync(app);
	vi.stubEnv("PI_AGENT_DIR", app);
	return { root, cwd, app, paths: settingsPaths(cwd) };
}

describe("fresh v2 settings", () => {
	it("defaults to a dedicated configurable Luna Instant reviewer", () => {
		const { cwd, paths } = fixture();
		expect(loadSettings(cwd).settings.reviewer).toEqual({ provider: "openai", model: "gpt-6-luna", reasoning: "off", timeoutMs: 30_000, structuredOutput: "auto", debug: false });
		writeFileSync(paths.user, JSON.stringify({ reviewer: { provider: "another-provider", model: "fast-reviewer", reasoning: "low" } }));
		expect(loadSettings(cwd).settings.reviewer).toEqual({ provider: "another-provider", model: "fast-reviewer", reasoning: "low", timeoutMs: 30_000, structuredOutput: "auto", debug: false });
	});
	it("reads new user and project files without touching legacy settings", () => {
		const { cwd, app, paths } = fixture();
		mkdirSync(join(app, "extensions"));
		const old = join(app, "extensions", "pi-auto.json");
		writeFileSync(old, '{"enabled":false}');
		writeFileSync(join(cwd, ".agents", "pi-auto.json"), '{"enabled":false}');
		writeFileSync(paths.user, JSON.stringify({ sandbox: { allowedDomains: ["registry.npmjs.org"] }, notices: "all" }));
		writeFileSync(paths.project, JSON.stringify({ sandbox: { allowedDomains: ["example.com"] } }));
		const loaded = loadSettings(cwd);
		expect(loaded.errors).toEqual([]);
		expect(loaded.settings.enabled).toBe(true);
		expect(loaded.settings.notices).toBe("all");
		expect(loaded.settings.sandbox.allowedDomains).toEqual(["example.com"]);
		expect(readFileSync(old, "utf8")).toBe('{"enabled":false}');
	});
	it("merges reviewer debug/structured-output settings and rejects invalid modes", () => {
		const configured = applySettings(DEFAULT_SETTINGS, { reviewer: { debug: true, structuredOutput: "off" } });
		expect(configured.reviewer).toMatchObject({ provider: "openai", model: "gpt-6-luna", reasoning: "off", debug: true, structuredOutput: "off" });
		expect(() => applySettings(DEFAULT_SETTINGS, { reviewer: { debug: "raw" } })).toThrow("debug must be boolean");
		expect(() => applySettings(DEFAULT_SETTINGS, { reviewer: { structuredOutput: true } })).toThrow("must be auto or off");
	});
	it("reports invalid settings instead of quietly widening permissions", () => {
		const { cwd, paths } = fixture();
		writeFileSync(paths.project, '{"sandbox":{"allowedDomains":"*"}}');
		const loaded = loadSettings(cwd);
		expect(loaded.errors[0]).toContain("array of nonempty strings");
		expect(loaded.settings.sandbox.allowedDomains).toEqual([]);
	});
	it("rejects unknown or inconsistent reviewer fields", () => {
		for (const reviewer of [{ provider: "" }, { model: "" }, { provider: "", model: "" }, { provider: " " }]) {
			expect(() => applySettings(DEFAULT_SETTINGS, { reviewer })).toThrow("must both be nonempty");
		}
		expect(() => applySettings(DEFAULT_SETTINGS, { sandbox: { constructor: [] } })).toThrow("unknown sandbox setting");
		expect(() => applySettings(DEFAULT_SETTINGS, { reviewer: { timeoutMs: 0 } })).toThrow("integer");
		expect(() => applySettings(DEFAULT_SETTINGS, { sandboxMode: "off" })).toThrow("unknown setting");
		expect(() => applySettings(DEFAULT_SETTINGS, { context: { maxTotalChars: 1 } })).toThrow("512");
		expect(() => applySettings(DEFAULT_SETTINGS, { sandbox: { allowRead: ["src/**"] } })).toThrow("literal file or directory");
	});
});
