/**
 * Interactive `/pi-auto-settings` command UI.
 *
 * Flow (matches the design in TODO.md → "Settings file + in-pi settings UI"):
 *
 *   1. Pick which layer to edit: user-global or per-project.
 *      (Prompted first so every edit in this session writes to the chosen
 *      layer. Saves the user from re-picking on every change.)
 *
 *   2. Show a list of editable fields. Each row displays:
 *        - the field's effective current value (from the merged settings),
 *        - which layer that value came from (default / user-global /
 *          per-project / env). The layer attribution is important: if you
 *          chose to edit "user-global" but a field is currently overridden
 *          per-project or by env, your change will be shadowed.
 *
 *   3. Pressing enter on a row opens a per-field editor:
 *        - bool / enum   → SelectList of the allowed values
 *        - string        → Input overlay (single-line)
 *        - number        → Input overlay with parseFloat validation
 *        - stringList    → Input overlay with comma-separated parsing
 *
 *   4. On submit, the new value is written to the chosen layer's JSON file
 *      (creating it if needed). Live settings are refreshed in place so the
 *      change takes effect for the current session without a relaunch.
 *
 * Out of scope for v1 (see TODO.md):
 *   - `extraSafeCommandPrefixes` (nested argv arrays). Editable via the JSON
 *     file directly.
 *   - `environment` (Claude Code-style prose infrastructure overlay). Wired
 *     when we add the field — not yet in PiAutoSettings.
 */

import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Input,
	type SelectItem,
	SelectList,
	type SelectListTheme,
	Text,
} from "@earendil-works/pi-tui";

/**
 * Build a complete SelectListTheme using the active session theme. The pi-tui
 * SelectListTheme requires all five color hooks; without them the constructor
 * type-errors. Centralizing the construction keeps the call sites tidy.
 */
function makeSelectTheme(theme: Theme): SelectListTheme {
	return {
		selectedPrefix: (t) => theme.fg("accent", t),
		selectedText: (t) => theme.fg("accent", t),
		description: (t) => theme.fg("muted", t),
		scrollInfo: (t) => theme.fg("dim", t),
		noMatch: (t) => theme.fg("warning", t),
	};
}
import {
	defaultPerProjectWritePath,
	loadSettings,
	saveSettingField,
} from "./settings-store.ts";
import type {
	PiAutoSettings,
	SandboxSettings,
	SettingsLayer,
	SettingsLayerMap,
} from "./types.ts";

/**
 * Layers a user can edit in the UI. ("default" and "env" are read-only.)
 */
type EditableLayer = "user-global" | "per-project";

/**
 * Field descriptor. Each settings field that's editable from the UI has one.
 * The descriptor encapsulates display, validation, and how to splice the
 * change back into the typed settings shape (so the UI doesn't need to
 * special-case nested fields like `sandbox.mode`).
 */
interface FieldDescriptor {
	/** Unique row id; can use dotted form for nested fields ("sandbox.mode"). */
	id: string;
	label: string;
	help?: string;
	kind: "bool" | "string" | "number" | "stringList" | "enum";
	enumValues?: readonly string[];
	/** Read the current effective display value as a string. */
	read: (settings: PiAutoSettings) => string;
	/**
	 * For the layer attribution: which top-level PiAutoSettings field does
	 * this descriptor's value live under? Nested sandbox fields all map to
	 * "sandbox", so toggling any sub-field shows the sandbox layer.
	 */
	settingsKey: keyof PiAutoSettings;
	/**
	 * Given the current effective settings and a raw user-entered string,
	 * compute the new value to persist under settingsKey. May throw to
	 * reject the input (the message is surfaced in a notify).
	 */
	applyChange: (settings: PiAutoSettings, raw: string) => PiAutoSettings[keyof PiAutoSettings];
}

const FIELDS: FieldDescriptor[] = [
	// Reviewer model
	{
		id: "reviewerProvider",
		label: "Reviewer provider",
		help: "Provider id used to look up the reviewer model in pi's ModelRegistry.",
		kind: "string",
		settingsKey: "reviewerProvider",
		read: (s) => s.reviewerProvider,
		applyChange: (_s, raw) => raw.trim(),
	},
	{
		id: "reviewerModel",
		label: "Reviewer model",
		help: "Model id used for the review call (e.g. gpt-5-mini, claude-haiku-4-5).",
		kind: "string",
		settingsKey: "reviewerModel",
		read: (s) => s.reviewerModel,
		applyChange: (_s, raw) => raw.trim(),
	},
	{
		id: "fallbackToActiveModel",
		label: "Fall back to active model",
		help: "If reviewer model unavailable, use the session's current model.",
		kind: "bool",
		settingsKey: "fallbackToActiveModel",
		read: (s) => String(s.fallbackToActiveModel),
		applyChange: (_s, raw) => parseBool(raw),
	},
	{
		id: "useCodexAutoReview",
		label: "Use codex-auto-review model",
		help: "Use OpenAI's hidden codex-auto-review fine-tune instead of reviewerModel.",
		kind: "bool",
		settingsKey: "useCodexAutoReview",
		read: (s) => String(s.useCodexAutoReview),
		applyChange: (_s, raw) => parseBool(raw),
	},
	{
		id: "reviewerPolicySource",
		label: "Reviewer policy source",
		help: "default = our tuned policy; codex-verbatim = codex's policy template (benchmarks only).",
		kind: "enum",
		enumValues: ["default", "codex-verbatim"],
		settingsKey: "reviewerPolicySource",
		read: (s) => s.reviewerPolicySource,
		applyChange: (_s, raw) => {
			if (raw !== "default" && raw !== "codex-verbatim") {
				throw new Error(`reviewerPolicySource must be "default" or "codex-verbatim"`);
			}
			return raw;
		},
	},
	{
		id: "reviewerTimeoutMs",
		label: "Reviewer timeout (ms)",
		kind: "number",
		settingsKey: "reviewerTimeoutMs",
		read: (s) => String(s.reviewerTimeoutMs),
		applyChange: (_s, raw) => parseNumber(raw, { min: 500 }),
	},

	// Scope and policy
	{
		id: "customPolicy",
		label: "Custom policy text",
		help: "Free-form text appended after the base policy.",
		kind: "string",
		settingsKey: "customPolicy",
		read: (s) => previewString(s.customPolicy),
		applyChange: (_s, raw) => raw,
	},
	{
		id: "sensitivePathPatterns",
		label: "Sensitive path patterns",
		help: "Substring patterns; reading these is reviewed even inside cwd. Comma-separated.",
		kind: "stringList",
		settingsKey: "sensitivePathPatterns",
		read: (s) => s.sensitivePathPatterns.join(", "),
		applyChange: (_s, raw) => parseStringList(raw),
	},

	// Transcript shaping
	{
		id: "maxTranscriptEntries",
		label: "Transcript entry cap",
		kind: "number",
		settingsKey: "maxTranscriptEntries",
		read: (s) => String(s.maxTranscriptEntries),
		applyChange: (_s, raw) => parseNumber(raw, { min: 1 }),
	},
	{
		id: "maxEntryChars",
		label: "Per-entry char cap",
		kind: "number",
		settingsKey: "maxEntryChars",
		read: (s) => String(s.maxEntryChars),
		applyChange: (_s, raw) => parseNumber(raw, { min: 100 }),
	},
	{
		id: "maxTranscriptTotalChars",
		label: "Total transcript char cap",
		kind: "number",
		settingsKey: "maxTranscriptTotalChars",
		read: (s) => String(s.maxTranscriptTotalChars),
		applyChange: (_s, raw) => parseNumber(raw, { min: 1_000 }),
	},
	{
		id: "maxPinnedRelatedEntries",
		label: "Max pinned related entries",
		kind: "number",
		settingsKey: "maxPinnedRelatedEntries",
		read: (s) => String(s.maxPinnedRelatedEntries),
		applyChange: (_s, raw) => parseNumber(raw, { min: 0 }),
	},
	{
		id: "maxSummaryEntries",
		label: "Max summary entries",
		kind: "number",
		settingsKey: "maxSummaryEntries",
		read: (s) => String(s.maxSummaryEntries),
		applyChange: (_s, raw) => parseNumber(raw, { min: 0 }),
	},
	{
		id: "enableDigest",
		label: "Enable rolling auth digest",
		kind: "bool",
		settingsKey: "enableDigest",
		read: (s) => String(s.enableDigest),
		applyChange: (_s, raw) => parseBool(raw),
	},
	{
		id: "stripAssistantText",
		label: "Strip assistant text from transcript",
		help: "Defend against assistant-narrated authorization claims.",
		kind: "bool",
		settingsKey: "stripAssistantText",
		read: (s) => String(s.stripAssistantText),
		applyChange: (_s, raw) => parseBool(raw),
	},
	{
		id: "stripToolResults",
		label: "Strip tool results from transcript",
		help: "Defend against prompt injection via tool output.",
		kind: "bool",
		settingsKey: "stripToolResults",
		read: (s) => String(s.stripToolResults),
		applyChange: (_s, raw) => parseBool(raw),
	},

	// Notifications & circuit breaker
	{
		id: "announceAllows",
		label: "Announce allows inline",
		kind: "bool",
		settingsKey: "announceAllows",
		read: (s) => String(s.announceAllows),
		applyChange: (_s, raw) => parseBool(raw),
	},
	{
		id: "maxConsecutiveDenialsPerTurn",
		label: "Consecutive denials per turn before tripping",
		kind: "number",
		settingsKey: "maxConsecutiveDenialsPerTurn",
		read: (s) => String(s.maxConsecutiveDenialsPerTurn),
		applyChange: (_s, raw) => parseNumber(raw, { min: 1 }),
	},
	{
		id: "maxTotalDenialsPerTurn",
		label: "Total denials per turn before tripping",
		kind: "number",
		settingsKey: "maxTotalDenialsPerTurn",
		read: (s) => String(s.maxTotalDenialsPerTurn),
		applyChange: (_s, raw) => parseNumber(raw, { min: 1 }),
	},

	// Sandbox sub-fields
	{
		id: "sandbox.mode",
		label: "Sandbox mode",
		kind: "enum",
		enumValues: ["off", "escape-only", "review-then-escape"],
		settingsKey: "sandbox",
		read: (s) => s.sandbox.mode,
		applyChange: (s, raw) => {
			if (raw !== "off" && raw !== "escape-only" && raw !== "review-then-escape") {
				throw new Error(`sandbox.mode must be "off", "escape-only", or "review-then-escape"`);
			}
			return { ...s.sandbox, mode: raw } satisfies SandboxSettings;
		},
	},
	{
		id: "sandbox.allowedDomains",
		label: "Sandbox: allowed domains",
		help: "Comma-separated; '*' allows everything; '*.example.com' wildcards supported.",
		kind: "stringList",
		settingsKey: "sandbox",
		read: (s) => s.sandbox.allowedDomains.join(", "),
		applyChange: (s, raw) => ({ ...s.sandbox, allowedDomains: parseStringList(raw) }),
	},
	{
		id: "sandbox.deniedDomains",
		label: "Sandbox: denied domains",
		help: "Checked first; takes precedence over allow. Comma-separated.",
		kind: "stringList",
		settingsKey: "sandbox",
		read: (s) => s.sandbox.deniedDomains.join(", "),
		applyChange: (s, raw) => ({ ...s.sandbox, deniedDomains: parseStringList(raw) }),
	},
	{
		id: "sandbox.allowRead",
		label: "Sandbox: extra read-allow paths",
		kind: "stringList",
		settingsKey: "sandbox",
		read: (s) => s.sandbox.allowRead.join(", "),
		applyChange: (s, raw) => ({ ...s.sandbox, allowRead: parseStringList(raw) }),
	},
	{
		id: "sandbox.denyRead",
		label: "Sandbox: read-deny paths",
		kind: "stringList",
		settingsKey: "sandbox",
		read: (s) => s.sandbox.denyRead.join(", "),
		applyChange: (s, raw) => ({ ...s.sandbox, denyRead: parseStringList(raw) }),
	},
	{
		id: "sandbox.allowWrite",
		label: "Sandbox: extra write-allow paths",
		help: "Empty = use cwd + /tmp (defaults).",
		kind: "stringList",
		settingsKey: "sandbox",
		read: (s) => s.sandbox.allowWrite.join(", "),
		applyChange: (s, raw) => ({ ...s.sandbox, allowWrite: parseStringList(raw) }),
	},
	{
		id: "sandbox.denyWrite",
		label: "Sandbox: write-deny paths",
		kind: "stringList",
		settingsKey: "sandbox",
		read: (s) => s.sandbox.denyWrite.join(", "),
		applyChange: (s, raw) => ({ ...s.sandbox, denyWrite: parseStringList(raw) }),
	},
	{
		id: "sandbox.showStatusIndicator",
		label: "Sandbox: status-bar indicator",
		kind: "bool",
		settingsKey: "sandbox",
		read: (s) => String(s.sandbox.showStatusIndicator),
		applyChange: (s, raw) => ({ ...s.sandbox, showStatusIndicator: parseBool(raw) }),
	},
	{
		id: "sandbox.annotateBashDisplay",
		label: "Sandbox: annotate bash display",
		kind: "bool",
		settingsKey: "sandbox",
		read: (s) => String(s.sandbox.annotateBashDisplay),
		applyChange: (s, raw) => ({ ...s.sandbox, annotateBashDisplay: parseBool(raw) }),
	},
	{
		id: "sandbox.alwaysAnnounceDenials",
		label: "Sandbox: announce every denial",
		kind: "bool",
		settingsKey: "sandbox",
		read: (s) => String(s.sandbox.alwaysAnnounceDenials),
		applyChange: (s, raw) => ({ ...s.sandbox, alwaysAnnounceDenials: parseBool(raw) }),
	},
];

export interface SettingsUIDeps {
	/** Reads from / writes to the live settings object owned by pi-auto.ts. */
	getSettings: () => PiAutoSettings;
	/** Replace the live settings (object identity preserved by caller). */
	applySettings: (next: PiAutoSettings) => void;
	getLayers: () => SettingsLayerMap;
	setLayers: (next: SettingsLayerMap) => void;
	getPaths: () => { userGlobal: string | null; perProject: string | null };
	setPaths: (next: { userGlobal: string | null; perProject: string | null }) => void;
	defaults: PiAutoSettings;
}

export function registerSettingsCommand(pi: ExtensionAPI, deps: SettingsUIDeps): void {
	pi.registerCommand("pi-auto-settings", {
		description:
			"Interactively edit pi-auto settings (user-global or per-project). Writes to JSON.",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				console.log(
					"pi-auto-settings: no UI available. Edit the JSON file at " +
						(deps.getPaths().userGlobal ?? "$PI_AGENT_DIR/extensions/pi-auto.json") +
						" directly.",
				);
				return;
			}
			const layer = await pickLayer(ctx);
			if (!layer) return; // cancelled
			await editLoop(ctx, layer, deps);
		},
	});
}

/* -------- step 1: layer picker -------- */

async function pickLayer(ctx: ExtensionContext): Promise<EditableLayer | null> {
	const items: SelectItem[] = [
		{
			value: "user-global",
			label: "user-global",
			description: "$PI_AGENT_DIR/extensions/pi-auto.json — applies everywhere on this machine",
		},
		{
			value: "per-project",
			label: "per-project",
			description: ".agents/pi-auto.json in this project — overrides user-global for this repo",
		},
	];
	return await ctx.ui.custom<EditableLayer | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(
			new Text(theme.fg("accent", theme.bold("pi-auto: which settings layer to edit?")), 1, 0),
		);
		const list = new SelectList(items, items.length, makeSelectTheme(theme));
		list.onSelect = (item) => done(item.value as EditableLayer);
		list.onCancel = () => done(null);
		container.addChild(list);
		container.addChild(
			new Text(theme.fg("dim", "↑↓ pick • enter open • esc cancel"), 1, 0),
		);
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		return {
			render: (w) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

/* -------- step 2: field list (loops until user dismisses) -------- */

async function editLoop(
	ctx: ExtensionContext,
	layer: EditableLayer,
	deps: SettingsUIDeps,
): Promise<void> {
	for (;;) {
		const picked = await pickField(ctx, layer, deps);
		if (!picked) return; // esc closes the whole UI
		const ok = await editField(ctx, layer, picked, deps);
		if (ok === "saved") {
			// Reload settings so the next iteration's display reflects the change
			// and any other layer that shadows this field shows up correctly.
			reloadSettings(ctx, deps);
		}
	}
}

async function pickField(
	ctx: ExtensionContext,
	layer: EditableLayer,
	deps: SettingsUIDeps,
): Promise<FieldDescriptor | null> {
	const settings = deps.getSettings();
	const layers = deps.getLayers();
	const items: SelectItem[] = FIELDS.map((f) => {
		const current = f.read(settings);
		const currentLayer = layers[f.settingsKey];
		const shadowedNote = isShadowed(currentLayer, layer)
			? ` (currently overridden by ${currentLayer})`
			: "";
		const help = f.help ? ` — ${f.help}` : "";
		return {
			value: f.id,
			label: `${f.label}: ${current}`,
			description: `[${currentLayer}]${shadowedNote}${help}`,
		};
	});
	const layerLabel = layer === "user-global" ? "user-global" : "per-project";
	return await ctx.ui.custom<FieldDescriptor | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(
			new Text(
				theme.fg("accent", theme.bold(`pi-auto settings — editing ${layerLabel}`)),
				1,
				0,
			),
		);
		const list = new SelectList(items, Math.min(items.length, 16), makeSelectTheme(theme));
		list.onSelect = (item) => {
			const f = FIELDS.find((d) => d.id === item.value);
			done(f ?? null);
		};
		list.onCancel = () => done(null);
		container.addChild(list);
		container.addChild(
			new Text(theme.fg("dim", "↑↓ scroll • / search • enter edit • esc close"), 1, 0),
		);
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		return {
			render: (w) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

/* -------- step 3: per-field editor -------- */

async function editField(
	ctx: ExtensionContext,
	layer: EditableLayer,
	field: FieldDescriptor,
	deps: SettingsUIDeps,
): Promise<"saved" | "cancelled"> {
	const settings = deps.getSettings();
	let rawInput: string | null;

	if (field.kind === "bool") {
		rawInput = await pickFromList(ctx, field.label, ["true", "false"], field.read(settings));
	} else if (field.kind === "enum") {
		const values = field.enumValues ?? [];
		rawInput = await pickFromList(ctx, field.label, [...values], field.read(settings));
	} else {
		rawInput = await promptInput(ctx, field, field.read(settings));
	}

	if (rawInput === null) return "cancelled";

	let nextValue: PiAutoSettings[keyof PiAutoSettings];
	try {
		nextValue = field.applyChange(settings, rawInput);
	} catch (err) {
		ctx.ui.notify(`pi-auto settings: ${(err as Error).message}`, "warning");
		return "cancelled";
	}

	const filePath = resolveLayerWritePath(ctx, layer, deps);
	if (!filePath) {
		ctx.ui.notify(
			`pi-auto settings: could not resolve a write path for ${layer}. Aborting save.`,
			"warning",
		);
		return "cancelled";
	}

	try {
		saveSettingField({ filePath, field: field.settingsKey, value: nextValue });
	} catch (err) {
		ctx.ui.notify(`pi-auto settings: write failed — ${(err as Error).message}`, "warning");
		return "cancelled";
	}

	ctx.ui.notify(
		`pi-auto settings: saved ${field.label} to ${layer} (${filePath})`,
		"info",
	);
	return "saved";
}

async function pickFromList(
	ctx: ExtensionContext,
	title: string,
	values: string[],
	current: string,
): Promise<string | null> {
	const items: SelectItem[] = values.map((v) => ({
		value: v,
		label: v + (v === current ? "  (current)" : ""),
	}));
	return await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		const list = new SelectList(items, Math.min(items.length, 8), makeSelectTheme(theme));
		list.onSelect = (item) => done(String(item.value));
		list.onCancel = () => done(null);
		container.addChild(list);
		container.addChild(new Text(theme.fg("dim", "enter pick • esc cancel"), 1, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		return {
			render: (w) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

async function promptInput(
	ctx: ExtensionContext,
	field: FieldDescriptor,
	initial: string,
): Promise<string | null> {
	return await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold(field.label)), 1, 0));
		if (field.help) {
			container.addChild(new Text(theme.fg("muted", field.help), 1, 0));
		}
		const input = new Input();
		input.setValue(initial);
		input.focused = true;
		input.onSubmit = (value) => done(value);
		input.onEscape = () => done(null);
		container.addChild(input);
		container.addChild(new Text(theme.fg("dim", "enter save • esc cancel"), 1, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		return {
			render: (w) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				input.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

/* -------- file resolution + reload -------- */

function resolveLayerWritePath(
	ctx: ExtensionContext,
	layer: EditableLayer,
	deps: SettingsUIDeps,
): string | null {
	const paths = deps.getPaths();
	if (layer === "user-global") return paths.userGlobal;
	if (paths.perProject) return paths.perProject;
	return defaultPerProjectWritePath(ctx.cwd);
}

function reloadSettings(ctx: ExtensionContext, deps: SettingsUIDeps): void {
	const loaded = loadSettings({ defaults: deps.defaults, cwd: ctx.cwd });
	deps.applySettings(loaded.settings);
	deps.setLayers(loaded.layers);
	deps.setPaths(loaded.paths);
}

/* -------- helpers -------- */

function previewString(s: string): string {
	if (s.length === 0) return "(empty)";
	if (s.length <= 60) return s;
	return `${s.slice(0, 57)}…`;
}

function parseBool(raw: string): boolean {
	const lower = raw.trim().toLowerCase();
	if (lower === "true" || lower === "1" || lower === "yes" || lower === "on") return true;
	if (lower === "false" || lower === "0" || lower === "no" || lower === "off") return false;
	throw new Error(`expected a boolean (true/false), got "${raw}"`);
}

function parseNumber(raw: string, opts: { min?: number; max?: number } = {}): number {
	const n = Number.parseFloat(raw.trim());
	if (Number.isNaN(n) || !Number.isFinite(n)) {
		throw new Error(`expected a number, got "${raw}"`);
	}
	if (opts.min !== undefined && n < opts.min) {
		throw new Error(`value must be >= ${opts.min}`);
	}
	if (opts.max !== undefined && n > opts.max) {
		throw new Error(`value must be <= ${opts.max}`);
	}
	return n;
}

function parseStringList(raw: string): string[] {
	return raw
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

function isShadowed(currentLayer: SettingsLayer, editingLayer: EditableLayer): boolean {
	// Shadowing matters when the value's effective layer is HIGHER precedence
	// than what the user is editing. Order: default < user-global < per-project < env.
	const order: Record<SettingsLayer, number> = {
		default: 0,
		"user-global": 1,
		"per-project": 2,
		env: 3,
	};
	return order[currentLayer] > order[editingLayer];
}
