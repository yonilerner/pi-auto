/**
 * Two-layer persisted settings for pi-auto.
 *
 * Layers, lowest to highest precedence:
 *
 *   1. DEFAULT_SETTINGS          — compiled-in defaults from this file.
 *   2. user-global JSON file     — $PI_AGENT_DIR/extensions/pi-auto.json,
 *                                  defaulting to ~/.pi/agent/extensions/pi-auto.json.
 *   3. per-project JSON file     — .agents/pi-auto.json at the project root,
 *                                  discovered by walking up from cwd to either
 *                                  the git root, an explicit project marker,
 *                                  or the filesystem root.
 *   4. PI_AUTO_* env vars        — for one-off runs (CI, benchmarks). Each
 *                                  env var maps to exactly one settings field;
 *                                  see ENV_VAR_OVERRIDES below.
 *
 * Files may be partial — any field not present in a file just falls through
 * to the next layer down. Malformed JSON is tolerated with a warning; the
 * file is treated as empty so the user can still recover.
 *
 * Field-level merging is shallow at the top of PiAutoSettings, with one
 * intentional deep-merge on the `sandbox` sub-object so a user-global
 * `sandbox.mode = "escape-only"` can coexist with a per-project
 * `sandbox.deniedDomains = [...]`.
 *
 * See TODO.md (Settings file + in-pi settings UI) for the design context.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import type { PiAutoSettings, SandboxSettings, SettingsLayer, SettingsLayerMap } from "./types.ts";

export type PartialPiAutoSettings = Omit<Partial<PiAutoSettings>, "sandbox"> & {
	sandbox?: Partial<SandboxSettings>;
};

/**
 * Filenames as written. Tests stub the resolved paths through `loadSettings`,
 * not these constants.
 */
export const USER_GLOBAL_RELATIVE_PATH = "extensions/pi-auto.json";
export const PER_PROJECT_RELATIVE_PATH = ".agents/pi-auto.json";

/**
 * Env-var override table. Adding an env var here is the ONLY supported way to
 * introduce a new env-var-driven setting; doing it ad-hoc in another module
 * violates the precedence rule documented in TODO.md.
 */
interface EnvVarOverride {
	envVar: string;
	field: keyof PiAutoSettings;
	/**
	 * Convert the raw env string to the typed settings value, or return
	 * `undefined` if the env var is unset / unrecognized (so the override is
	 * skipped and lower layers win).
	 */
	apply: (raw: string | undefined, current: PiAutoSettings) => Partial<PiAutoSettings> | undefined;
}

const ENV_VAR_OVERRIDES: EnvVarOverride[] = [
	{
		envVar: "PI_AUTO_USE_CODEX_POLICY",
		field: "reviewerPolicySource",
		apply: (raw) => {
			if (raw === "1") return { reviewerPolicySource: "codex-verbatim" };
			if (raw === "0") return { reviewerPolicySource: "default" };
			return undefined;
		},
	},
];

export interface LoadedSettings {
	settings: PiAutoSettings;
	layers: SettingsLayerMap;
	/** Resolved file paths used by save(). Null when a layer wasn't applicable. */
	paths: {
		userGlobal: string | null;
		perProject: string | null;
	};
	/** Non-fatal load issues to surface to the user (malformed JSON, etc.). */
	warnings: string[];
}

export interface LoadSettingsOptions {
	defaults: PiAutoSettings;
	cwd: string;
	/** Source of env vars. Defaults to `process.env`. Tests pass their own. */
	env?: NodeJS.ProcessEnv;
	/**
	 * Override the user-global path resolver. Tests set this to a tmpdir; the
	 * real code resolves from $PI_AGENT_DIR / ~/.pi/agent.
	 */
	userGlobalPath?: string;
	/**
	 * Override per-project lookup. Semantics:
	 *   - `undefined`: auto-discover via `findPerProjectPath`.
	 *   - `null`:      explicitly skip the per-project layer entirely. Used by
	 *                  the UI to compute the inherited value of a field ("what
	 *                  would the effective value be if per-project didn't set
	 *                  this?"), see `nextArrayForAppend`.
	 *   - `string`:    use this exact path (tests use this to pin behavior).
	 */
	perProjectPath?: string | null;
}

/**
 * Resolve the user-global pi-auto.json path. Honors $PI_AGENT_DIR if set,
 * otherwise falls back to ~/.pi/agent.
 */
export function resolveUserGlobalPath(env: NodeJS.ProcessEnv = process.env): string {
	const root = env.PI_AGENT_DIR && env.PI_AGENT_DIR.length > 0 ? env.PI_AGENT_DIR : path.join(homedir(), ".pi", "agent");
	return path.join(root, USER_GLOBAL_RELATIVE_PATH);
}

/**
 * Find the per-project settings file by walking up from `cwd` looking for
 * `.agents/pi-auto.json`. Returns the absolute path if found, else null.
 *
 * The walk stops at:
 *   - the first `.agents/pi-auto.json` found
 *   - a directory containing `.git` (project root, but no settings)
 *   - the filesystem root
 *   - the user's home directory (to avoid accidentally picking up a stray
 *     `~/.agents/pi-auto.json` — that's not the intended layer)
 *
 * Returning null when there's a `.git` but no `.agents/pi-auto.json` is
 * intentional: it means "this project has no per-project pi-auto config,"
 * and writes should not silently spill upward into an unrelated parent.
 */
export function findPerProjectPath(cwd: string, home: string = homedir()): string | null {
	let current = path.resolve(cwd);
	const fsRoot = path.parse(current).root;
	for (;;) {
		// Stop BEFORE checking the file at the home directory, so a stray
		// `~/.agents/pi-auto.json` isn't picked up as per-project from any
		// subdirectory of home.
		if (current === home) return null;
		const candidate = path.join(current, PER_PROJECT_RELATIVE_PATH);
		if (existsSync(candidate)) return candidate;
		// Stop at git root — per-project config lives at the project root.
		if (existsSync(path.join(current, ".git"))) return null;
		if (current === fsRoot) return null;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

/**
 * Where a new per-project file should be written when the user has no
 * existing one yet. Anchored at the git root if there is one, otherwise at
 * cwd. Used by save() when the layer is "per-project" but the path resolver
 * found nothing.
 */
export function defaultPerProjectWritePath(cwd: string): string {
	let current = path.resolve(cwd);
	const fsRoot = path.parse(current).root;
	while (current !== fsRoot) {
		if (existsSync(path.join(current, ".git"))) {
			return path.join(current, PER_PROJECT_RELATIVE_PATH);
		}
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return path.join(path.resolve(cwd), PER_PROJECT_RELATIVE_PATH);
}

/**
 * Read + parse a partial settings JSON. Returns:
 *   - { ok: true, parsed } on success
 *   - { ok: false, warning } if the file is missing (no warning) or malformed
 *     (one-line warning surfaced to the user).
 */
function readPartialSettings(
	filePath: string,
): { ok: true; parsed: PartialPiAutoSettings } | { ok: false; warning?: string } {
	if (!existsSync(filePath)) return { ok: false };
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch (err) {
		return { ok: false, warning: `pi-auto settings: could not read ${filePath}: ${(err as Error).message}` };
	}
	if (raw.trim().length === 0) return { ok: true, parsed: {} };
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		return { ok: false, warning: `pi-auto settings: ${filePath} has invalid JSON (${(err as Error).message}); ignoring` };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { ok: false, warning: `pi-auto settings: ${filePath} must be a JSON object; ignoring` };
	}
	return { ok: true, parsed: parsed as PartialPiAutoSettings };
}

/**
 * Apply one layer's partial onto the accumulator and record layer attribution
 * for each field the partial actually overrides. Performs the shallow merge
 * with the one sandbox deep-merge described in the file header.
 */
function applyLayer(
	accumulator: PiAutoSettings,
	partial: PartialPiAutoSettings,
	layer: SettingsLayer,
	layers: SettingsLayerMap,
): void {
	for (const key of Object.keys(partial) as Array<keyof PiAutoSettings>) {
		const value = partial[key];
		if (value === undefined) continue;
		if (key === "sandbox" && typeof value === "object" && !Array.isArray(value)) {
			accumulator.sandbox = { ...accumulator.sandbox, ...(value as Partial<SandboxSettings>) };
			layers.sandbox = layer;
			continue;
		}
		// biome-ignore lint/suspicious/noExplicitAny: layered merge writes through Partial<PiAutoSettings>
		(accumulator as any)[key] = value;
		layers[key] = layer;
	}
}

/** Build a layer map populated with all fields pointing at "default". */
function initialLayerMap(defaults: PiAutoSettings): SettingsLayerMap {
	const map = {} as SettingsLayerMap;
	for (const key of Object.keys(defaults) as Array<keyof PiAutoSettings>) {
		map[key] = "default";
	}
	return map;
}

/**
 * Load merged settings from DEFAULT_SETTINGS plus the configured layered
 * sources. Pure-ish: reads from disk and env, but does not mutate anything.
 */
export function loadSettings(opts: LoadSettingsOptions): LoadedSettings {
	const env = opts.env ?? process.env;
	const userGlobalPath = opts.userGlobalPath ?? resolveUserGlobalPath(env);
	const perProjectPath =
		opts.perProjectPath === null
			? null
			: opts.perProjectPath !== undefined
				? opts.perProjectPath
				: findPerProjectPath(opts.cwd);

	const settings: PiAutoSettings = {
		...opts.defaults,
		sandbox: { ...opts.defaults.sandbox },
	};
	const layers = initialLayerMap(opts.defaults);
	const warnings: string[] = [];

	if (userGlobalPath) {
		const result = readPartialSettings(userGlobalPath);
		if (result.ok) {
			applyLayer(settings, result.parsed, "user-global", layers);
		} else if (result.warning) {
			warnings.push(result.warning);
		}
	}
	if (perProjectPath) {
		const result = readPartialSettings(perProjectPath);
		if (result.ok) {
			applyLayer(settings, result.parsed, "per-project", layers);
		} else if (result.warning) {
			warnings.push(result.warning);
		}
	}

	// Env-var overrides apply last so they always win. Today there's exactly
	// one (PI_AUTO_USE_CODEX_POLICY); see ENV_VAR_OVERRIDES.
	for (const override of ENV_VAR_OVERRIDES) {
		const raw = env[override.envVar];
		const change = override.apply(raw, settings);
		if (change) applyLayer(settings, change, "env", layers);
	}

	return {
		settings,
		layers,
		paths: { userGlobal: userGlobalPath ?? null, perProject: perProjectPath ?? null },
		warnings,
	};
}

/**
 * Persist a single field to the given layer. Reads the existing partial
 * JSON file (so we don't drop other already-persisted fields), merges the
 * change, writes the result.
 *
 * Caller is responsible for refreshing in-memory settings after this returns;
 * we deliberately don't reach back into the live PiAutoSettings here.
 */
export function saveSettingField<K extends keyof PiAutoSettings>(args: {
	filePath: string;
	field: K;
	value: PiAutoSettings[K];
}): void {
	const { filePath, field, value } = args;
	const existing = readPartialSettings(filePath);
	const base: PartialPiAutoSettings = existing.ok ? { ...existing.parsed } : {};
	// biome-ignore lint/suspicious/noExplicitAny: assignment into PartialPiAutoSettings[field]
	(base as any)[field] = value;
	const dir = path.dirname(filePath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(base, null, 2)}\n`, "utf8");
}

/**
 * Test-only: list the env vars known to apply settings overrides. Used by
 * settings-store.test.ts to assert there are no stragglers in other modules
 * that bypass this table.
 */
export function _envVarsForTest(): readonly string[] {
	return ENV_VAR_OVERRIDES.map((o) => o.envVar);
}

/* ------------------------------------------------------------------ */
/* Array-field editing with copy-on-first-add inheritance.            */
/* ------------------------------------------------------------------ */

/**
 * Compute the next array to persist when the user appends an item to a
 * list-typed setting from the UI.
 *
 * If the file already contains the field, we append to it. If not, we copy
 * the `inheritedItems` (the effective value the user currently sees, fed in
 * by lower layers — defaults + user-global) and append to that copy.
 *
 * This preserves the user's mental model: "add an item" in the UI should add
 * it to the list they see, not silently truncate the list to a single item.
 * Layered settings replace arrays rather than concatenating, so a naive
 * `[newItem]` write would clobber every inherited entry the moment the user
 * adds anything project-level.
 */
export function nextArrayForAppend<T>(
	currentInFile: readonly T[] | undefined,
	inheritedItems: readonly T[],
	item: T,
): T[] {
	const base = currentInFile !== undefined ? [...currentInFile] : [...inheritedItems];
	base.push(item);
	return base;
}

/**
 * Companion to `nextArrayForAppend`: compute the next array when the user
 * removes one item from a list-typed setting. Same inheritance rule — if the
 * file has no entry yet, we materialize the inherited list before removing,
 * so removing an inherited entry produces "everything except that one" in
 * the project file (which is what the user sees).
 *
 * Returns the input unchanged if the index is out of range.
 */
export function nextArrayForRemove<T>(
	currentInFile: readonly T[] | undefined,
	inheritedItems: readonly T[],
	index: number,
): T[] {
	const base = currentInFile !== undefined ? [...currentInFile] : [...inheritedItems];
	if (index < 0 || index >= base.length) return base;
	base.splice(index, 1);
	return base;
}

/**
 * Append or remove from a list-typed settings field in a partial JSON file,
 * with the copy-on-first-add inheritance behavior implemented by
 * `nextArrayForAppend` / `nextArrayForRemove`.
 *
 * The caller supplies `read`/`write` plucking the array out of and into the
 * partial. This keeps the helper type-agnostic about top-level vs. nested
 * (sandbox sub-field) paths without hardcoding each one here.
 *
 * Returns the array that was written, so the UI can refresh its view
 * without a separate disk read.
 */
export function modifySettingArrayField<T>(args: {
	filePath: string;
	read: (partial: PartialPiAutoSettings) => readonly T[] | undefined;
	write: (partial: PartialPiAutoSettings, value: T[]) => void;
	inheritedItems: readonly T[];
	op: { kind: "append"; item: T } | { kind: "remove"; index: number };
}): { written: T[] } {
	const existing = readPartialSettings(args.filePath);
	const base: PartialPiAutoSettings = existing.ok ? { ...existing.parsed } : {};
	if (base.sandbox) base.sandbox = { ...base.sandbox };
	const currentInFile = args.read(base);
	const next =
		args.op.kind === "append"
			? nextArrayForAppend(currentInFile, args.inheritedItems, args.op.item)
			: nextArrayForRemove(currentInFile, args.inheritedItems, args.op.index);
	args.write(base, next);
	const dir = path.dirname(args.filePath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(args.filePath, `${JSON.stringify(base, null, 2)}\n`, "utf8");
	return { written: next };
}
