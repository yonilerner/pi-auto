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
	it("reports invalid settings instead of quietly widening permissions", () => {
		const { cwd, paths } = fixture();
		writeFileSync(paths.project, '{"sandbox":{"allowedDomains":"*"}}');
		const loaded = loadSettings(cwd);
		expect(loaded.errors[0]).toContain("array of nonempty strings");
		expect(loaded.settings.sandbox.allowedDomains).toEqual([]);
	});
	it("rejects unknown or inconsistent reviewer fields", () => {
		expect(() => applySettings(DEFAULT_SETTINGS, { reviewer: { provider: "missing" } })).toThrow("configured together");
		expect(() => applySettings(DEFAULT_SETTINGS, { sandbox: { constructor: [] } })).toThrow("unknown sandbox setting");
		expect(() => applySettings(DEFAULT_SETTINGS, { reviewer: { timeoutMs: 0 } })).toThrow("integer");
		expect(() => applySettings(DEFAULT_SETTINGS, { sandboxMode: "off" })).toThrow("unknown setting");
		expect(() => applySettings(DEFAULT_SETTINGS, { context: { maxTotalChars: 1 } })).toThrow("512");
		expect(() => applySettings(DEFAULT_SETTINGS, { sandbox: { allowRead: ["src/**"] } })).toThrow("literal file or directory");
	});
});
