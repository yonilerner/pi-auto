import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	_envVarsForTest,
	defaultPerProjectWritePath,
	findPerProjectPath,
	loadSettings,
	modifySettingArrayField,
	nextArrayForAppend,
	nextArrayForRemove,
	resolveUserGlobalPath,
	saveSettingField,
} from "../extensions/settings-store.ts";
import type { PiAutoSettings } from "../extensions/types.ts";
import { readFileSync } from "node:fs";

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
		disableDefaultNoProxy: false,
		allowRead: [],
		denyRead: [],
		allowWrite: ["."],
		denyWrite: [],
		reviewOnlyCommandPrefixes: [],
		allowedDangerousFiles: [],
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
		expect(loaded.settings.sandbox.disableDefaultNoProxy).toBe(false); // default preserved
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
				disableDefaultNoProxy: false,
				allowRead: [],
				denyRead: [],
				allowWrite: [],
				denyWrite: [],
				reviewOnlyCommandPrefixes: [],
				allowedDangerousFiles: [],
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

describe("nextArrayForAppend", () => {
	it("copies inherited items when the file has no entry for the field", () => {
		// This is the case the TODO targets: the project layer has never set
		// `sensitivePathPatterns`, but the user-global layer contributes 3
		// patterns. Adding one project-level pattern must preserve all 3, not
		// clobber them down to a one-element list.
		expect(nextArrayForAppend(undefined, ["a", "b", "c"], "d")).toEqual(["a", "b", "c", "d"]);
	});

	it("appends to the file-level array when one is already present", () => {
		// Once the project layer has an explicit array, it stops inheriting —
		// further adds extend the project array as-is.
		expect(nextArrayForAppend(["x"], ["a", "b"], "y")).toEqual(["x", "y"]);
	});

	it("treats an empty file array as a real (non-inheriting) override", () => {
		// Distinct from `undefined`: the project file explicitly set the array
		// to []. That's an intentional reset, so subsequent adds must not pull
		// inherited entries back in.
		expect(nextArrayForAppend([], ["a", "b"], "x")).toEqual(["x"]);
	});

	it("handles empty inherited arrays", () => {
		expect(nextArrayForAppend(undefined, [], "a")).toEqual(["a"]);
	});

	it("does not mutate the inputs", () => {
		const inherited = ["a", "b"] as const;
		const current = ["x"] as const;
		nextArrayForAppend(current, inherited, "y");
		expect(inherited).toEqual(["a", "b"]);
		expect(current).toEqual(["x"]);
	});
});

describe("nextArrayForRemove", () => {
	it("materializes the inherited list before removing, when the file has no entry", () => {
		// Same mental model as append: the items the user sees in the UI are
		// the inherited ones, and "remove this one" must produce a project
		// array that mirrors that minus the chosen index.
		expect(nextArrayForRemove(undefined, ["a", "b", "c"], 1)).toEqual(["a", "c"]);
	});

	it("removes from the file array when one is already present", () => {
		expect(nextArrayForRemove(["x", "y", "z"], ["a", "b"], 0)).toEqual(["y", "z"]);
	});

	it("returns unchanged when index is out of range", () => {
		expect(nextArrayForRemove(["x"], [], 5)).toEqual(["x"]);
		expect(nextArrayForRemove(undefined, ["a"], -1)).toEqual(["a"]);
	});
});

describe("modifySettingArrayField", () => {
	it("copies inherited items into a previously-unset project array on first append", () => {
		// End-to-end: project file is empty, user-global contributes 2 patterns.
		// User adds one via the UI; the file must end up with all 3.
		const filePath = path.join(workdir, ".agents/pi-auto.json");
		writeJson(filePath, {});
		modifySettingArrayField({
			filePath,
			read: (p) => p.sensitivePathPatterns,
			write: (p, v) => {
				p.sensitivePathPatterns = v;
			},
			inheritedItems: ["~/.ssh", "~/.aws"],
			op: { kind: "append", item: "~/.secret" },
		});
		const parsed = JSON.parse(readFileSync(filePath, "utf8"));
		expect(parsed.sensitivePathPatterns).toEqual(["~/.ssh", "~/.aws", "~/.secret"]);
	});

	it("does not drop other fields when persisting the array", () => {
		// Verifies the partial-merge path — if the project file already sets
		// reviewerModel, an unrelated list-field edit must not lose it.
		const filePath = path.join(workdir, "config.json");
		writeJson(filePath, { reviewerModel: "claude-haiku-4-5" });
		modifySettingArrayField({
			filePath,
			read: (p) => p.sensitivePathPatterns,
			write: (p, v) => {
				p.sensitivePathPatterns = v;
			},
			inheritedItems: [],
			op: { kind: "append", item: "x" },
		});
		const parsed = JSON.parse(readFileSync(filePath, "utf8"));
		expect(parsed.reviewerModel).toBe("claude-haiku-4-5");
		expect(parsed.sensitivePathPatterns).toEqual(["x"]);
	});

	it("handles nested sandbox sub-field arrays without dropping sibling sandbox keys", () => {
		// The most subtle case: the file has `sandbox.mode` set but no
		// `sandbox.allowedDomains` entry. Adding a domain must (a) copy the
		// inherited domains, (b) leave `sandbox.mode` intact, (c) not flatten
		// the sandbox sub-object up to the root.
		const filePath = path.join(workdir, "config.json");
		writeJson(filePath, { sandbox: { mode: "escape-only" } });
		modifySettingArrayField({
			filePath,
			read: (p) => p.sandbox?.allowedDomains,
			write: (p, v) => {
				p.sandbox = { ...(p.sandbox ?? {}), allowedDomains: v } as PiAutoSettings["sandbox"];
			},
			inheritedItems: ["api.github.com"],
			op: { kind: "append", item: "registry.npmjs.org" },
		});
		const parsed = JSON.parse(readFileSync(filePath, "utf8"));
		expect(parsed.sandbox.mode).toBe("escape-only");
		expect(parsed.sandbox.allowedDomains).toEqual(["api.github.com", "registry.npmjs.org"]);
	});

	it("creates parent dirs and the file when neither exists yet", () => {
		const filePath = path.join(workdir, "a/b/c/pi-auto.json");
		modifySettingArrayField({
			filePath,
			read: (p) => p.sensitivePathPatterns,
			write: (p, v) => {
				p.sensitivePathPatterns = v;
			},
			inheritedItems: ["~/.ssh"],
			op: { kind: "append", item: "~/.aws" },
		});
		const parsed = JSON.parse(readFileSync(filePath, "utf8"));
		expect(parsed.sensitivePathPatterns).toEqual(["~/.ssh", "~/.aws"]);
	});

	it("removes from inherited list on first remove", () => {
		const filePath = path.join(workdir, "config.json");
		writeJson(filePath, {});
		modifySettingArrayField({
			filePath,
			read: (p) => p.sensitivePathPatterns,
			write: (p, v) => {
				p.sensitivePathPatterns = v;
			},
			inheritedItems: ["~/.ssh", "~/.aws", "~/.gnupg"],
			op: { kind: "remove", index: 1 },
		});
		const parsed = JSON.parse(readFileSync(filePath, "utf8"));
		expect(parsed.sensitivePathPatterns).toEqual(["~/.ssh", "~/.gnupg"]);
	});
});

describe("loadSettings perProjectPath=null", () => {
	it("explicitly skips the per-project layer when null is passed", () => {
		// The UI uses this to compute the inherited value for a project-level
		// list edit: "what does this field look like with only defaults +
		// user-global applied?"
		const userPath = path.join(workdir, "user.json");
		const projPath = path.join(workdir, ".agents/pi-auto.json");
		writeJson(userPath, { sensitivePathPatterns: ["~/.ssh", "~/.aws"] });
		writeJson(projPath, { sensitivePathPatterns: ["only-project"] });
		const loaded = loadSettings({
			defaults: DEFAULTS,
			cwd: workdir,
			env: {} as NodeJS.ProcessEnv,
			userGlobalPath: userPath,
			perProjectPath: null,
		});
		expect(loaded.settings.sensitivePathPatterns).toEqual(["~/.ssh", "~/.aws"]);
		expect(loaded.paths.perProject).toBeNull();
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
