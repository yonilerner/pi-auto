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
 *   - `extraSafeCommandPrefixes` / `sandbox.reviewOnlyCommandPrefixes` (both
 *     `string[][]`). Need a 2D editor; JSON file only for now.
 *   - `customPolicy` (free-form prose appended to the base policy). Single-
 *     line input is the wrong shape for it; the JSON file is.
 *   - `environment` (Claude Code-style prose infrastructure overlay). Wired
 *     when we add the field — not yet in PiAutoSettings.
 *
 * List-typed `string[]` fields (`sensitivePathPatterns`, the sandbox
 * `allow*` / `deny*` arrays, `allowedDangerousFiles`) ARE supported, via a
 * dedicated add/remove list view. The per-project layer follows the
 * "copy inherited items on first add" rule from `nextArrayForAppend` so a
 * first per-project add doesn't silently clobber the inherited list.
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
	modifySettingArrayField,
	saveSettingField,
	type LoadedSettings,
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
	kind: "bool" | "string" | "number" | "enum" | "stringList";
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
	 * For scalar fields (bool / string / number / enum): given the current
	 * effective settings and a raw user-entered string, compute the new
	 * value to persist under settingsKey. Unused for list-typed fields.
	 */
	applyChange?: (
		settings: PiAutoSettings,
		raw: string,
	) => PiAutoSettings[keyof PiAutoSettings];
	/**
	 * For `stringList` fields: pluck the array out of effective settings (to
	 * render the current items), out of a partial settings JSON (to know
	 * what the file already contains for the inheritance rule), and back
	 * into a partial (to persist). Sandbox sub-fields work fine — each
	 * descriptor encapsulates its own path.
	 */
	arrayAccess?: {
		getEffective: (settings: PiAutoSettings) => readonly string[];
		readPartial: (partial: Partial<PiAutoSettings>) => readonly string[] | undefined;
		writePartial: (partial: Partial<PiAutoSettings>, value: string[]) => void;
	};
}

/**
 * Helper: render the layer-attribution display value for a list-typed
 * field. "(empty)" for [], otherwise "<n> items".
 */
function renderListSummary(items: readonly string[]): string {
	return items.length === 0 ? "(empty)" : `${items.length} item${items.length === 1 ? "" : "s"}`;
}

/**
 * Build the `sandbox` array-access helpers. All seven sandbox arrays share
 * the same read/write shape; factoring this out keeps the descriptor table
 * below readable.
 */
function sandboxArrayAccess<K extends keyof SandboxSettings>(key: K): {
	getEffective: (s: PiAutoSettings) => readonly string[];
	readPartial: (p: Partial<PiAutoSettings>) => readonly string[] | undefined;
	writePartial: (p: Partial<PiAutoSettings>, v: string[]) => void;
} {
	return {
		getEffective: (s) => s.sandbox[key] as readonly string[],
		readPartial: (p) => p.sandbox?.[key] as readonly string[] | undefined,
		writePartial: (p, v) => {
			p.sandbox = { ...(p.sandbox ?? {}), [key]: v } as PiAutoSettings["sandbox"];
		},
	};
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
		id: "noticeLevel",
		label: "Inline notice level",
		help: "silent / denials / normal / verbose. Critical posture warnings always show regardless.",
		kind: "enum",
		enumValues: ["silent", "denials", "normal", "verbose"],
		settingsKey: "noticeLevel",
		read: (s) => s.noticeLevel,
		applyChange: (_s, raw) => {
			if (raw !== "silent" && raw !== "denials" && raw !== "normal" && raw !== "verbose") {
				throw new Error(`noticeLevel must be one of silent / denials / normal / verbose`);
			}
			return raw;
		},
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
		id: "sandbox.disableDefaultNoProxy",
		label: "Sandbox: disable default NO_PROXY",
		help: "Do not inject ASRT's default NO_PROXY/no_proxy bypass for loopback, .local, link-local, and private ranges.",
		kind: "bool",
		settingsKey: "sandbox",
		read: (s) => String(s.sandbox.disableDefaultNoProxy),
		applyChange: (s, raw) => ({ ...s.sandbox, disableDefaultNoProxy: parseBool(raw) }),
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

	// ---- string[] list fields ---------------------------------------
	// Edited via the dedicated list view (add/remove). The per-project layer
	// follows the copy-inherited-on-first-add rule from nextArrayForAppend.
	{
		id: "sensitivePathPatterns",
		label: "Sensitive path patterns",
		help: "Substring patterns whose reads are reviewed even inside cwd.",
		kind: "stringList",
		settingsKey: "sensitivePathPatterns",
		read: (s) => renderListSummary(s.sensitivePathPatterns),
		arrayAccess: {
			getEffective: (s) => s.sensitivePathPatterns,
			readPartial: (p) => p.sensitivePathPatterns,
			writePartial: (p, v) => {
				p.sensitivePathPatterns = v;
			},
		},
	},
	{
		id: "sandbox.allowedDomains",
		label: "Sandbox: allowed domains",
		help: "Network destinations the sandbox may reach. `*.example.com` wildcards OK.",
		kind: "stringList",
		settingsKey: "sandbox",
		read: (s) => renderListSummary(s.sandbox.allowedDomains),
		arrayAccess: sandboxArrayAccess("allowedDomains"),
	},
	{
		id: "sandbox.deniedDomains",
		label: "Sandbox: denied domains",
		help: "Hard-deny network destinations. Checked before allowedDomains.",
		kind: "stringList",
		settingsKey: "sandbox",
		read: (s) => renderListSummary(s.sandbox.deniedDomains),
		arrayAccess: sandboxArrayAccess("deniedDomains"),
	},
	{
		id: "sandbox.allowRead",
		label: "Sandbox: allow read",
		help: "Extra filesystem paths the sandbox may read.",
		kind: "stringList",
		settingsKey: "sandbox",
		read: (s) => renderListSummary(s.sandbox.allowRead),
		arrayAccess: sandboxArrayAccess("allowRead"),
	},
	{
		id: "sandbox.denyRead",
		label: "Sandbox: deny read",
		help: "Extra filesystem paths the sandbox is forbidden from reading.",
		kind: "stringList",
		settingsKey: "sandbox",
		read: (s) => renderListSummary(s.sandbox.denyRead),
		arrayAccess: sandboxArrayAccess("denyRead"),
	},
	{
		id: "sandbox.allowWrite",
		label: "Sandbox: allow write",
		help: "Filesystem paths the sandbox may write. Default `.` = workspace.",
		kind: "stringList",
		settingsKey: "sandbox",
		read: (s) => renderListSummary(s.sandbox.allowWrite),
		arrayAccess: sandboxArrayAccess("allowWrite"),
	},
	{
		id: "sandbox.denyWrite",
		label: "Sandbox: deny write",
		help: "Hard-deny filesystem write paths even inside allowWrite roots.",
		kind: "stringList",
		settingsKey: "sandbox",
		read: (s) => renderListSummary(s.sandbox.denyWrite),
		arrayAccess: sandboxArrayAccess("denyWrite"),
	},
	{
		id: "sandbox.allowedDangerousFiles",
		label: "Sandbox: allowed dangerous files",
		help: "ASRT DANGEROUS_FILES entries to drop (e.g. .gitmodules). Read the type doc first.",
		kind: "stringList",
		settingsKey: "sandbox",
		read: (s) => renderListSummary(s.sandbox.allowedDangerousFiles),
		arrayAccess: sandboxArrayAccess("allowedDangerousFiles"),
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
	/**
	 * Optional hook fired after every successful save + reload. Use it to
	 * reconcile side-effecty subsystems (sandbox runtime, status indicator,
	 * circuit breaker thresholds, etc.) that observe settings but don't poll.
	 */
	onSettingsApplied?: (ctx: ExtensionContext) => Promise<void> | void;
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

	pi.registerCommand("pi-auto-reload-settings", {
		description:
			"Reload pi-auto settings from JSON/env and reapply live side effects.",
		handler: async (_args, ctx) => {
			const loaded = await reloadAndApplySettings(ctx, deps);
			const lines = [
				"pi-auto settings: reloaded",
				`  user-global: ${loaded.paths.userGlobal ?? "(none)"}`,
				`  per-project: ${loaded.paths.perProject ?? "(none found)"}`,
			];
			if (loaded.warnings.length > 0) {
				lines.push("", ...loaded.warnings);
			}
			notifyOrLog(ctx, lines.join("\n"), loaded.warnings.length > 0 ? "warning" : "info");
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
	// Remember the field the user last interacted with so an esc out of the
	// per-field editor (or a successful save) reopens the field list with the
	// same row selected, instead of bouncing back to the top.
	let lastFieldId: string | undefined;
	for (;;) {
		const picked = await pickField(ctx, layer, deps, lastFieldId);
		if (!picked) return; // esc closes the whole UI
		lastFieldId = picked.id;
		const ok = await editField(ctx, layer, picked, deps);
		if (ok === "saved") {
			// Reload settings so the next iteration's display reflects the change
			// and any other layer that shadows this field shows up correctly.
			await reloadAndApplySettings(ctx, deps);
		}
	}
}

async function pickField(
	ctx: ExtensionContext,
	layer: EditableLayer,
	deps: SettingsUIDeps,
	initialFieldId?: string,
): Promise<FieldDescriptor | null> {
	const settings = deps.getSettings();
	const layers = deps.getLayers();
	// Items are split into a short label (the field's display name) and a
	// longer description carrying the current value, layer attribution, and
	// any help text. Earlier versions packed the value into the label, which
	// truncated mid-value once the field name got longer than the primary
	// column — "defaul" instead of "default", "f" instead of "false". The
	// description column has much more headroom, so the value lives there
	// and the primary column stays clean.
	const items: SelectItem[] = FIELDS.map((f) => {
		const current = f.read(settings);
		const currentLayer = layers[f.settingsKey];
		const layerAttribution = formatLayerAttribution(
			currentLayer,
			current,
			f.read(deps.defaults),
		);
		const shadowedNote = isShadowed(currentLayer, layer)
			? ` (overridden by ${currentLayer})`
			: "";
		const help = f.help ? ` — ${f.help}` : "";
		return {
			value: f.id,
			label: f.label,
			description: `= ${current}  ${layerAttribution}${shadowedNote}${help}`,
		};
	});
	const layerLabel = layer === "user-global" ? "user-global" : "per-project";
	const initialIndex = initialFieldId
		? Math.max(
			0,
			items.findIndex((it) => it.value === initialFieldId),
		)
		: 0;
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

		// Search bar. `/` toggles it; printable keys append; backspace deletes;
		// enter exits search mode keeping the filter; esc clears the filter and
		// exits search mode (esc on the list itself still cancels the picker).
		let searchMode = false;
		let searchTerm = "";
		const searchBar = new Text("", 1, 0);
		const hintBar = new Text(
			theme.fg("dim", "↑↓ scroll • / search • enter edit • esc close"),
			1,
			0,
		);
		const refreshChrome = () => {
			if (searchMode) {
				searchBar.setText(
					`${theme.fg("accent", "/")} ${theme.fg("text", searchTerm)}${theme.fg("accent", "_")}`,
				);
				hintBar.setText(theme.fg("dim", "type to filter • enter keep • esc clear"));
			} else if (searchTerm.length > 0) {
				searchBar.setText(theme.fg("muted", `(filter: ${searchTerm}) `));
				hintBar.setText(
					theme.fg("dim", "↑↓ scroll • / refine • enter edit • esc close"),
				);
			} else {
				searchBar.setText("");
				hintBar.setText(
					theme.fg("dim", "↑↓ scroll • / search • enter edit • esc close"),
				);
			}
		};
		refreshChrome();
		container.addChild(searchBar);

		// Allow the primary (label) column to take up to ~40 cols so the longest
		// field names aren't truncated. The description column flows from there.
		const list = new SelectList(items, Math.min(items.length, 16), makeSelectTheme(theme), {
			minPrimaryColumnWidth: 24,
			maxPrimaryColumnWidth: 40,
		});
		if (initialIndex > 0) list.setSelectedIndex(initialIndex);
		list.onSelect = (item) => {
			const f = FIELDS.find((d) => d.id === item.value);
			done(f ?? null);
		};
		list.onCancel = () => done(null);
		container.addChild(list);
		container.addChild(hintBar);
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		const applyFilter = () => {
			list.setFilter(searchTerm);
			refreshChrome();
			tui.requestRender();
		};

		const handleSearchInput = (data: string): boolean => {
			// Returns true if the input was consumed by the search bar.
			if (data === "\x1b") {
				// esc — clear and exit search mode (don't cancel the whole picker).
				searchMode = false;
				searchTerm = "";
				applyFilter();
				return true;
			}
			if (data === "\r" || data === "\n") {
				// enter — exit search mode, keep filter, let arrows / enter operate
				// on the list again.
				searchMode = false;
				refreshChrome();
				tui.requestRender();
				return true;
			}
			if (data === "\x7f" || data === "\b") {
				if (searchTerm.length > 0) searchTerm = searchTerm.slice(0, -1);
				applyFilter();
				return true;
			}
			// Only consume printable single-byte characters; pass everything else
			// through so arrow keys / etc. still work even while in search mode.
			if (data.length === 1 && data >= " " && data <= "~") {
				searchTerm += data;
				applyFilter();
				return true;
			}
			return false;
		};

		return {
			render: (w) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				if (!searchMode && data === "/") {
					searchMode = true;
					refreshChrome();
					tui.requestRender();
					return;
				}
				if (searchMode && handleSearchInput(data)) return;
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
	if (field.kind === "stringList") {
		return await editListField(ctx, layer, field, deps);
	}

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

	if (!field.applyChange) {
		ctx.ui.notify(
			`pi-auto settings: internal error — field ${field.id} has no applyChange handler`,
			"warning",
		);
		return "cancelled";
	}

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

	const savedValue = renderSavedFieldValue(settings, field, nextValue);
	ctx.ui.notify(
		formatSavedSettingNotification(field.label, savedValue, layer, filePath),
		"info",
	);
	return "saved";
}

/* -------- step 3b: per-field list editor (stringList) -------- */

/**
 * Inheritance for list-typed per-project edits: "the value of this array
 * with everything BUT the per-project layer applied." Used by the copy-on-
 * first-add behavior — if the user has never set this array project-level,
 * adding an item should preserve all the user-global / default entries they
 * currently see in the UI rather than collapse the list to one item.
 *
 * For user-global edits the inherited value is the compiled-in default for
 * this field, which we compute by loading with both files skipped.
 */
export function computeInheritedListItems(
	ctx: ExtensionContext,
	layer: EditableLayer,
	field: FieldDescriptor,
	deps: SettingsUIDeps,
): readonly string[] {
	if (!field.arrayAccess) return [];
	if (layer === "per-project") {
		// Inherited = defaults + user-global, no per-project.
		const inherited = loadSettings({
			defaults: deps.defaults,
			cwd: ctx.cwd,
			perProjectPath: null,
		});
		return field.arrayAccess.getEffective(inherited.settings);
	}
	// user-global — inherited is just the compiled-in defaults.
	return field.arrayAccess.getEffective(deps.defaults);
}

async function editListField(
	ctx: ExtensionContext,
	layer: EditableLayer,
	field: FieldDescriptor,
	deps: SettingsUIDeps,
): Promise<"saved" | "cancelled"> {
	if (!field.arrayAccess) {
		ctx.ui.notify(
			`pi-auto settings: internal error — stringList field ${field.id} has no arrayAccess`,
			"warning",
		);
		return "cancelled";
	}

	const filePath = resolveLayerWritePath(ctx, layer, deps);
	if (!filePath) {
		ctx.ui.notify(
			`pi-auto settings: could not resolve a write path for ${layer}. Aborting.`,
			"warning",
		);
		return "cancelled";
	}

	let anySaved = false;
	let selectedIndex = 0;
	for (;;) {
		const settings = deps.getSettings();
		const items = [...field.arrayAccess.getEffective(settings)];
		const inheritedItems = computeInheritedListItems(ctx, layer, field, deps);
		const action = await listEditorView(ctx, {
			field,
			layer,
			items,
			inheritedItems,
			initialIndex: selectedIndex,
		});
		if (action.kind === "close") {
			return anySaved ? "saved" : "cancelled";
		}
		if (action.kind === "add") {
			const newItem = await promptInputRaw(ctx, {
				title: `${field.label}: add item`,
				help: field.help,
				initial: "",
			});
			if (newItem === null || newItem.trim().length === 0) continue;
			try {
				const { written } = modifySettingArrayField({
					filePath,
					read: field.arrayAccess.readPartial,
					write: field.arrayAccess.writePartial,
					inheritedItems,
					op: { kind: "append", item: newItem.trim() },
				});
				anySaved = true;
				selectedIndex = Math.max(0, written.length - 1);
				ctx.ui.notify(
					formatSavedSettingNotification(
						`${field.label}: added "${newItem.trim()}"`,
						renderListSummary(written),
						layer,
						filePath,
					),
					"info",
				);
				await reloadAndApplySettings(ctx, deps);
			} catch (err) {
				ctx.ui.notify(
					`pi-auto settings: write failed — ${(err as Error).message}`,
					"warning",
				);
			}
			continue;
		}
		if (action.kind === "remove") {
			const removed = items[action.index];
			try {
				const { written } = modifySettingArrayField({
					filePath,
					read: field.arrayAccess.readPartial,
					write: field.arrayAccess.writePartial,
					inheritedItems,
					op: { kind: "remove", index: action.index },
				});
				anySaved = true;
				selectedIndex = Math.min(action.index, Math.max(0, written.length - 1));
				ctx.ui.notify(
					formatSavedSettingNotification(
						`${field.label}: removed "${removed}"`,
						renderListSummary(written),
						layer,
						filePath,
					),
					"info",
				);
				await reloadAndApplySettings(ctx, deps);
			} catch (err) {
				ctx.ui.notify(
					`pi-auto settings: write failed — ${(err as Error).message}`,
					"warning",
				);
			}
		}
	}
}

type ListEditorAction =
	| { kind: "close" }
	| { kind: "add" }
	| { kind: "remove"; index: number };

async function listEditorView(
	ctx: ExtensionContext,
	args: {
		field: FieldDescriptor;
		layer: EditableLayer;
		items: readonly string[];
		inheritedItems: readonly string[];
		initialIndex: number;
	},
): Promise<ListEditorAction> {
	const { field, layer, items, inheritedItems, initialIndex } = args;
	// The list view always renders at least one row so the SelectList has
	// something to navigate; if the field is empty we show a sentinel "(no
	// items — press `a` to add)" row. The sentinel value is filtered out of
	// the remove path.
	const EMPTY_SENTINEL = "__pi_auto_empty_sentinel__";
	const rows: SelectItem[] =
		items.length === 0
			? [{ value: EMPTY_SENTINEL, label: "(no items — press `a` to add)" }]
			: items.map((item, i) => ({
					value: `${i}`,
					label: item,
				}));
	return await ctx.ui.custom<ListEditorAction>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(
			new Text(
				theme.fg("accent", theme.bold(`${field.label} — editing ${layer}`)),
				1,
				0,
			),
		);
		if (field.help) {
			container.addChild(new Text(theme.fg("muted", field.help), 1, 0));
		}
		// Inheritance note: shown when editing a layer that will pull from a
		// non-empty inherited value AND the user hasn't yet overridden the
		// array project-level. This is the actual mental-model contract we
		// want users to see in the UI: "a first add will start from these."
		if (
			layer === "per-project" &&
			inheritedItems.length > 0 &&
			items.length === inheritedItems.length &&
			items.every((v, i) => v === inheritedItems[i])
		) {
			container.addChild(
				new Text(
					theme.fg(
						"muted",
						`(inheriting ${inheritedItems.length} item${inheritedItems.length === 1 ? "" : "s"} from lower layers — first edit copies them)`,
					),
					1,
					0,
				),
			);
		}
		const list = new SelectList(rows, Math.min(rows.length, 14), makeSelectTheme(theme));
		list.setSelectedIndex(Math.min(initialIndex, Math.max(0, rows.length - 1)));
		list.onCancel = () => done({ kind: "close" });
		// Pressing enter on a row removes it (after sentinel check). This is
		// the same convention we use for the field-picker: enter = act on row.
		list.onSelect = (item) => {
			if (item.value === EMPTY_SENTINEL) {
				done({ kind: "add" });
				return;
			}
			const idx = Number.parseInt(item.value, 10);
			if (Number.isFinite(idx)) done({ kind: "remove", index: idx });
		};
		container.addChild(list);
		container.addChild(
			new Text(
				theme.fg("dim", "a add • d/x/del remove • enter remove • esc back"),
				1,
				0,
			),
		);
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		return {
			render: (w) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				// Custom keys for list operations. Anything we don't claim falls
				// through to SelectList (arrow keys, enter, esc).
				if (data === "a" || data === "+") {
					done({ kind: "add" });
					return;
				}
				if (data === "d" || data === "x" || data === "\x7f" || data === "\x1b[3~") {
					const sel = list.getSelectedItem();
					if (sel && sel.value !== EMPTY_SENTINEL) {
						const idx = Number.parseInt(sel.value, 10);
						if (Number.isFinite(idx)) {
							done({ kind: "remove", index: idx });
							return;
						}
					}
					return;
				}
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

/**
 * Like `promptInput` but takes a free-form title/help instead of a
 * FieldDescriptor — used for list "add item" prompts where the descriptor's
 * label is the parent field name, not the input prompt.
 */
async function promptInputRaw(
	ctx: ExtensionContext,
	args: { title: string; help?: string; initial: string },
): Promise<string | null> {
	return await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold(args.title)), 1, 0));
		if (args.help) {
			container.addChild(new Text(theme.fg("muted", args.help), 1, 0));
		}
		const input = new Input();
		input.setValue(args.initial);
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
	const currentIndex = items.findIndex((item) => item.value === current);
	return await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		const list = new SelectList(items, Math.min(items.length, 8), makeSelectTheme(theme));
		if (currentIndex > 0) list.setSelectedIndex(currentIndex);
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

async function reloadAndApplySettings(
	ctx: ExtensionContext,
	deps: SettingsUIDeps,
): Promise<LoadedSettings> {
	const loaded = loadSettings({ defaults: deps.defaults, cwd: ctx.cwd });
	deps.applySettings(loaded.settings);
	deps.setLayers(loaded.layers);
	deps.setPaths(loaded.paths);
	if (deps.onSettingsApplied) await deps.onSettingsApplied(ctx);
	return loaded;
}

function renderSavedFieldValue(
	settings: PiAutoSettings,
	field: FieldDescriptor,
	nextValue: PiAutoSettings[keyof PiAutoSettings],
): string {
	const nextSettings: PiAutoSettings = {
		...settings,
		sandbox: { ...settings.sandbox },
	};
	// biome-ignore lint/suspicious/noExplicitAny: FieldDescriptor ties settingsKey to nextValue at runtime.
	(nextSettings as any)[field.settingsKey] = nextValue;
	return formatSavedSettingValue(field.read(nextSettings));
}

export function formatSavedSettingValue(value: string): string {
	let rendered = value;
	if (rendered === "" || rendered.trim() !== rendered || /[\r\n\t]/.test(rendered)) {
		rendered = JSON.stringify(rendered);
	}
	return rendered.length <= 160 ? rendered : `${rendered.slice(0, 159)}…`;
}

export function formatSavedSettingNotification(
	label: string,
	value: string,
	layer: string,
	filePath: string,
): string {
	return `pi-auto settings: saved ${label} = ${value} to ${layer} (${filePath})`;
}

function notifyOrLog(ctx: ExtensionContext, message: string, level: "info" | "warning"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, level);
		return;
	}
	const log = level === "warning" ? console.error : console.log;
	log(message);
}

/* -------- helpers -------- */

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

export function formatLayerAttribution(
	currentLayer: SettingsLayer,
	currentValue: string,
	defaultValue: string,
): string {
	if (
		(currentLayer === "user-global" || currentLayer === "per-project") &&
		currentValue === defaultValue
	) {
		return `[${currentLayer}, default]`;
	}
	return `[${currentLayer}]`;
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
