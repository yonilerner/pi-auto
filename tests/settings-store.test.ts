import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	_envVarsForTest,
	defaultPerProjectWritePath,
	findPerProjectPath,
	loadSettings,
	resolveUserGlobalPath,
	saveSettingField,
} from "../extensions/settings-store.ts";
import type { PiAutoSettings } from "../extensions/types.ts";

const DEFAULTS: PiAutoSettings = {
	reviewerProvider: "openai",
	reviewerModel: "gpt-5-mini",
	fallbackToActiveModel: true,
	reviewerTimeoutMs: 30_000,
	maxConsecutiveDenialsPerTurn: 3,
	maxTotalDenialsPerTurn: 10,
	maxTranscriptEntries: 40,
	maxEntryChars: 2_000,
	maxTranscriptTotalChars: 80_000,
	maxPinnedRelatedEntries: 6,
	maxSummaryEntries: 3,
	enableDigest: true,
	useCodexAutoReview: false,
	sensitivePathPatterns: ["~/.ssh", "~/.aws"],
	noticeLevel: "normal",
	customPolicy: "",
	reviewerPolicySource: "default",
	extraSafeCommandPrefixes: [],
	stripAssistantText: false,
	stripToolResults: false,
	sandbox: {
		mode: "off",
		allowedDomains: [],
		deniedDomains: [],
		allowRead: [],
		denyRead: [],
		allowWrite: [],
		denyWrite: [],
		showStatusIndicator: true,
		annotateBashDisplay: true,
	},
};

let workdir: string;
beforeEach(() => {
	workdir = mkdtempSync(path.join(tmpdir(), "pi-auto-settings-test-"));
});
afterEach(() => {
	rmSync(workdir, { recursive: true, force: true });
});

function writeJson(filePath: string, body: unknown): void {
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, JSON.stringify(body, null, 2), "utf8");
}

describe("resolveUserGlobalPath", () => {
	it("honors PI_AGENT_DIR when set", () => {
		const p = resolveUserGlobalPath({ PI_AGENT_DIR: "/etc/foo" } as NodeJS.ProcessEnv);
		expect(p).toBe("/etc/foo/extensions/pi-auto.json");
	});

	it("falls back to ~/.pi/agent when unset", () => {
		const p = resolveUserGlobalPath({} as NodeJS.ProcessEnv);
		expect(p).toMatch(/\.pi\/agent\/extensions\/pi-auto\.json$/);
	});

	it("treats empty PI_AGENT_DIR as unset", () => {
		const p = resolveUserGlobalPath({ PI_AGENT_DIR: "" } as NodeJS.ProcessEnv);
		expect(p).toMatch(/\.pi\/agent\/extensions\/pi-auto\.json$/);
	});
});

describe("findPerProjectPath", () => {
	it("finds .agents/pi-auto.json in cwd", () => {
		const cfg = path.join(workdir, ".agents/pi-auto.json");
		writeJson(cfg, { reviewerModel: "claude-haiku-4-5" });
		expect(findPerProjectPath(workdir, "/nonexistent-home")).toBe(cfg);
	});

	it("walks up to find .agents/pi-auto.json above cwd", () => {
		const cfg = path.join(workdir, ".agents/pi-auto.json");
		writeJson(cfg, {});
		const nested = path.join(workdir, "a/b/c");
		mkdirSync(nested, { recursive: true });
		expect(findPerProjectPath(nested, "/nonexistent-home")).toBe(cfg);
	});

	it("stops at the git root if no settings file is found there", () => {
		mkdirSync(path.join(workdir, ".git"));
		// Place a settings file ABOVE the workdir, which the walk should NOT
		// reach because the workdir is itself a git root.
		const aboveCfg = path.join(path.dirname(workdir), ".agents/pi-auto.json");
		writeJson(aboveCfg, {});
		try {
			expect(findPerProjectPath(workdir, "/nonexistent-home")).toBeNull();
		} finally {
			rmSync(path.dirname(aboveCfg), { recursive: true, force: true });
		}
	});

	it("stops at the home directory", () => {
		const cfg = path.join(workdir, ".agents/pi-auto.json");
		writeJson(cfg, {});
		const nested = path.join(workdir, "child");
		mkdirSync(nested, { recursive: true });
		// home directory is between us and the settings file → should stop.
		expect(findPerProjectPath(nested, workdir)).toBeNull();
	});

	it("returns null when no .agents/pi-auto.json exists anywhere on the path", () => {
		const nested = path.join(workdir, "a/b");
		mkdirSync(nested, { recursive: true });
		expect(findPerProjectPath(nested, "/nonexistent-home")).toBeNull();
	});
});

describe("loadSettings", () => {
	it("returns defaults with all layers = 'default' when no files exist and no env vars", () => {
		const loaded = loadSettings({
			defaults: DEFAULTS,
			cwd: workdir,
			env: {} as NodeJS.ProcessEnv,
			userGlobalPath: path.join(workdir, "nonexistent.json"),
			perProjectPath: undefined,
		});
		expect(loaded.settings).toEqual(DEFAULTS);
		for (const layer of Object.values(loaded.layers)) {
			expect(layer).toBe("default");
		}
		expect(loaded.warnings).toEqual([]);
	});

	it("applies user-global JSON over defaults and records the 'user-global' layer", () => {
		const userPath = path.join(workdir, "user.json");
		writeJson(userPath, { reviewerModel: "claude-haiku-4-5", reviewerTimeoutMs: 60_000 });
		const loaded = loadSettings({
			defaults: DEFAULTS,
			cwd: workdir,
			env: {} as NodeJS.ProcessEnv,
			userGlobalPath: userPath,
			perProjectPath: undefined,
		});
		expect(loaded.settings.reviewerModel).toBe("claude-haiku-4-5");
		expect(loaded.settings.reviewerTimeoutMs).toBe(60_000);
		expect(loaded.settings.reviewerProvider).toBe("openai"); // untouched
		expect(loaded.layers.reviewerModel).toBe("user-global");
		expect(loaded.layers.reviewerTimeoutMs).toBe("user-global");
		expect(loaded.layers.reviewerProvider).toBe("default");
	});

	it("applies per-project JSON over user-global with correct layer attribution", () => {
		const userPath = path.join(workdir, "user.json");
		const projPath = path.join(workdir, "proj.json");
		writeJson(userPath, { reviewerModel: "claude-haiku-4-5", customPolicy: "user-level" });
		writeJson(projPath, { customPolicy: "project-level" });
		const loaded = loadSettings({
			defaults: DEFAULTS,
			cwd: workdir,
			env: {} as NodeJS.ProcessEnv,
			userGlobalPath: userPath,
			perProjectPath: projPath,
		});
		expect(loaded.settings.reviewerModel).toBe("claude-haiku-4-5");
		expect(loaded.layers.reviewerModel).toBe("user-global");
		expect(loaded.settings.customPolicy).toBe("project-level");
		expect(loaded.layers.customPolicy).toBe("per-project");
	});

	it("applies env-var overrides last and records the 'env' layer", () => {
		const userPath = path.join(workdir, "user.json");
		writeJson(userPath, { reviewerPolicySource: "codex-verbatim" });
		const loaded = loadSettings({
			defaults: DEFAULTS,
			cwd: workdir,
			env: { PI_AUTO_USE_CODEX_POLICY: "0" } as NodeJS.ProcessEnv,
			userGlobalPath: userPath,
			perProjectPath: undefined,
		});
		// Env-var "0" should explicitly reset to "default", winning over the
		// user-global "codex-verbatim".
		expect(loaded.settings.reviewerPolicySource).toBe("default");
		expect(loaded.layers.reviewerPolicySource).toBe("env");
	});

	it("env-var override beats per-project (final word always)", () => {
		const userPath = path.join(workdir, "user.json");
		const projPath = path.join(workdir, "proj.json");
		writeJson(userPath, {});
		writeJson(projPath, { reviewerPolicySource: "default" });
		const loaded = loadSettings({
			defaults: DEFAULTS,
			cwd: workdir,
			env: { PI_AUTO_USE_CODEX_POLICY: "1" } as NodeJS.ProcessEnv,
			userGlobalPath: userPath,
			perProjectPath: projPath,
		});
		expect(loaded.settings.reviewerPolicySource).toBe("codex-verbatim");
		expect(loaded.layers.reviewerPolicySource).toBe("env");
	});

	it("ignores unset env vars (lets lower layers win)", () => {
		const userPath = path.join(workdir, "user.json");
		writeJson(userPath, { reviewerPolicySource: "codex-verbatim" });
		const loaded = loadSettings({
			defaults: DEFAULTS,
			cwd: workdir,
			env: {} as NodeJS.ProcessEnv,
			userGlobalPath: userPath,
			perProjectPath: undefined,
		});
		expect(loaded.settings.reviewerPolicySource).toBe("codex-verbatim");
		expect(loaded.layers.reviewerPolicySource).toBe("user-global");
	});

	it("deep-merges sandbox sub-object across layers", () => {
		const userPath = path.join(workdir, "user.json");
		const projPath = path.join(workdir, "proj.json");
		writeJson(userPath, { sandbox: { mode: "escape-only" } });
		writeJson(projPath, { sandbox: { deniedDomains: ["evil.example.com"] } });
		const loaded = loadSettings({
			defaults: DEFAULTS,
			cwd: workdir,
			env: {} as NodeJS.ProcessEnv,
			userGlobalPath: userPath,
			perProjectPath: projPath,
		});
		// Both partials merged onto the default sandbox.
		expect(loaded.settings.sandbox.mode).toBe("escape-only");
		expect(loaded.settings.sandbox.deniedDomains).toEqual(["evil.example.com"]);
		expect(loaded.settings.sandbox.allowedDomains).toEqual([]); // default preserved
		expect(loaded.settings.sandbox.showStatusIndicator).toBe(true); // default preserved
	});

	it("tolerates malformed JSON with a warning", () => {
		const userPath = path.join(workdir, "user.json");
		mkdirSync(path.dirname(userPath), { recursive: true });
		writeFileSync(userPath, "{ not json", "utf8");
		const loaded = loadSettings({
			defaults: DEFAULTS,
			cwd: workdir,
			env: {} as NodeJS.ProcessEnv,
			userGlobalPath: userPath,
			perProjectPath: undefined,
		});
		expect(loaded.settings).toEqual(DEFAULTS);
		expect(loaded.warnings).toHaveLength(1);
		expect(loaded.warnings[0]).toMatch(/invalid JSON/);
	});

	it("rejects non-object JSON with a warning", () => {
		const userPath = path.join(workdir, "user.json");
		mkdirSync(path.dirname(userPath), { recursive: true });
		writeFileSync(userPath, "[1, 2, 3]", "utf8");
		const loaded = loadSettings({
			defaults: DEFAULTS,
			cwd: workdir,
			env: {} as NodeJS.ProcessEnv,
			userGlobalPath: userPath,
			perProjectPath: undefined,
		});
		expect(loaded.settings).toEqual(DEFAULTS);
		expect(loaded.warnings[0]).toMatch(/must be a JSON object/);
	});

	it("tolerates empty files (treats as empty object)", () => {
		const userPath = path.join(workdir, "user.json");
		mkdirSync(path.dirname(userPath), { recursive: true });
		writeFileSync(userPath, "", "utf8");
		const loaded = loadSettings({
			defaults: DEFAULTS,
			cwd: workdir,
			env: {} as NodeJS.ProcessEnv,
			userGlobalPath: userPath,
			perProjectPath: undefined,
		});
		expect(loaded.settings).toEqual(DEFAULTS);
		expect(loaded.warnings).toEqual([]);
	});

	it("returns resolved paths so callers know where to write", () => {
		const userPath = path.join(workdir, "user.json");
		const projPath = path.join(workdir, "proj.json");
		writeJson(userPath, {});
		writeJson(projPath, {});
		const loaded = loadSettings({
			defaults: DEFAULTS,
			cwd: workdir,
			env: {} as NodeJS.ProcessEnv,
			userGlobalPath: userPath,
			perProjectPath: projPath,
		});
		expect(loaded.paths.userGlobal).toBe(userPath);
		expect(loaded.paths.perProject).toBe(projPath);
	});
});

describe("saveSettingField", () => {
	it("writes a new file when one doesn't exist, creating parent dirs", () => {
		const filePath = path.join(workdir, "nested/dir/pi-auto.json");
		saveSettingField({ filePath, field: "reviewerModel", value: "gpt-4.1-mini" });
		const loaded = loadSettings({
			defaults: DEFAULTS,
			cwd: workdir,
			env: {} as NodeJS.ProcessEnv,
			userGlobalPath: filePath,
			perProjectPath: undefined,
		});
		expect(loaded.settings.reviewerModel).toBe("gpt-4.1-mini");
	});

	it("merges into an existing partial without dropping other fields", () => {
		const filePath = path.join(workdir, "config.json");
		writeJson(filePath, { reviewerModel: "claude-haiku-4-5", reviewerTimeoutMs: 45_000 });
		saveSettingField({ filePath, field: "customPolicy", value: "Never push to main." });
		const loaded = loadSettings({
			defaults: DEFAULTS,
			cwd: workdir,
			env: {} as NodeJS.ProcessEnv,
			userGlobalPath: filePath,
			perProjectPath: undefined,
		});
		expect(loaded.settings.reviewerModel).toBe("claude-haiku-4-5");
		expect(loaded.settings.reviewerTimeoutMs).toBe(45_000);
		expect(loaded.settings.customPolicy).toBe("Never push to main.");
	});

	it("can persist the sandbox object", () => {
		const filePath = path.join(workdir, "config.json");
		saveSettingField({
			filePath,
			field: "sandbox",
			value: {
				mode: "escape-only",
				allowedDomains: ["api.github.com"],
				deniedDomains: [],
				allowRead: [],
				denyRead: [],
				allowWrite: [],
				denyWrite: [],
				showStatusIndicator: true,
				annotateBashDisplay: true,
			},
		});
		const loaded = loadSettings({
			defaults: DEFAULTS,
			cwd: workdir,
			env: {} as NodeJS.ProcessEnv,
			userGlobalPath: filePath,
			perProjectPath: undefined,
		});
		expect(loaded.settings.sandbox.mode).toBe("escape-only");
		expect(loaded.settings.sandbox.allowedDomains).toEqual(["api.github.com"]);
	});
});

describe("defaultPerProjectWritePath", () => {
	it("anchors at the git root when one exists", () => {
		mkdirSync(path.join(workdir, ".git"));
		const nested = path.join(workdir, "a/b/c");
		mkdirSync(nested, { recursive: true });
		expect(defaultPerProjectWritePath(nested)).toBe(path.join(workdir, ".agents/pi-auto.json"));
	});

	it("falls back to cwd if no git root", () => {
		const nested = path.join(workdir, "loose");
		mkdirSync(nested, { recursive: true });
		expect(defaultPerProjectWritePath(nested)).toBe(path.join(nested, ".agents/pi-auto.json"));
	});
});

describe("env-var registry", () => {
	it("currently lists exactly the one supported override (PI_AUTO_USE_CODEX_POLICY)", () => {
		// If you add another env var, also add it to the table and update
		// this assertion. The intent is to keep one canonical list rather
		// than scattering process.env reads across modules; see TODO.md.
		expect(_envVarsForTest()).toEqual(["PI_AUTO_USE_CODEX_POLICY"]);
	});
});
