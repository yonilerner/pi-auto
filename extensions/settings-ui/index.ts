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
 *        - bool / enum       → SelectList of the allowed values
 *        - string            → Input overlay (single-line)
 *        - number            → Input overlay with parseFloat validation
 *        - stringList        → dedicated add/remove list view
 *        - commandPrefixList → dedicated add/remove list view for string[][]
 *
 *   4. On submit, the new value is written to the chosen layer's JSON file
 *      (creating it if needed). Live settings are refreshed in place so the
 *      change takes effect for the current session without a relaunch.
 *
 * Out of scope for v1 (see TODO.md):
 *   - `customPolicy` (free-form prose appended to the base policy). Single-
 *     line input is the wrong shape for it; the JSON file is.
 *   - `environment` (Claude Code-style prose infrastructure overlay). Wired
 *     when we add the field — not yet in PiAutoSettings.
 *
 * List-typed fields (`string[]` plus command-prefix `string[][]` arrays) are
 * supported via dedicated add/remove views. The per-project layer follows the
 * "copy inherited items on first add" rule from `nextArrayForAppend` so a
 * first per-project add doesn't silently clobber the inherited list.
 */

import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Input, type SelectItem, SelectList, type SelectListTheme, Text } from "@earendil-works/pi-tui";

export { formatCommandPrefix, parseCommandPrefixInput } from "./field-codecs.ts";
export type { SettingsUIDeps } from "./contract.ts";
export {
	formatLayerAttribution,
	formatSavedSettingNotification,
	formatSavedSettingValue,
} from "./format.ts";
export { computeInheritedListItems } from "./list-editor.ts";

import {
	defaultPerProjectWritePath,
	loadSettings,
	saveSettingField,
	type LoadedSettings,
} from "../settings-store.ts";
import type { PiAutoSettings } from "../types.ts";
import type { SettingsUIDeps } from "./contract.ts";
import {
	type EditableLayer,
	type FieldDescriptor,
	FIELDS,
} from "./fields.ts";
import {
	formatLayerAttribution,
	formatSavedSettingNotification,
	formatSavedSettingValue,
	isShadowed,
	notifyOrLog,
} from "./format.ts";
import { editArrayField } from "./list-editor.ts";

/** Build the SelectList theme shared by the layer, field, and scalar pickers. */
function makeSelectTheme(theme: Theme): SelectListTheme {
	return {
		selectedPrefix: (t) => theme.fg("accent", t),
		selectedText: (t) => theme.fg("accent", t),
		description: (t) => theme.fg("muted", t),
		scrollInfo: (t) => theme.fg("dim", t),
		noMatch: (t) => theme.fg("warning", t),
	};
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
		return await editArrayField(ctx, layer, field, deps, {
			resolveLayerWritePath,
			reloadAndApplySettings,
		});
	}
	if (field.kind === "commandPrefixList") {
		return await editArrayField(ctx, layer, field, deps, {
			resolveLayerWritePath,
			reloadAndApplySettings,
		});
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

