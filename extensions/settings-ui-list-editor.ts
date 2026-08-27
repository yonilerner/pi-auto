import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Input, type SelectItem, SelectList, type SelectListTheme, Text } from "@earendil-works/pi-tui";
import { loadSettings, modifySettingArrayField } from "./settings-store.ts";
import type { LoadedSettings } from "./settings-store.ts";
import type { SettingsUIDeps } from "./settings-ui-contract.ts";
import {
	type ArrayFieldDescriptor,
	type EditableLayer,
	renderListSummary,
	type StringListFieldDescriptor,
} from "./settings-ui-fields.ts";
import { formatSavedSettingNotification } from "./settings-ui-format.ts";

export interface SettingsUIListEditorHelpers {
	resolveLayerWritePath: (
		ctx: ExtensionContext,
		layer: EditableLayer,
		deps: SettingsUIDeps,
	) => string | null;
	reloadAndApplySettings: (ctx: ExtensionContext, deps: SettingsUIDeps) => Promise<LoadedSettings>;
}

function makeSelectTheme(theme: Theme): SelectListTheme {
	return {
		selectedPrefix: (t) => theme.fg("accent", t),
		selectedText: (t) => theme.fg("accent", t),
		description: (t) => theme.fg("muted", t),
		scrollInfo: (t) => theme.fg("dim", t),
		noMatch: (t) => theme.fg("warning", t),
	};
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
	field: StringListFieldDescriptor,
	deps: SettingsUIDeps,
): readonly string[] {
	return computeInheritedArrayItems(ctx, layer, field, deps);
}

function computeInheritedArrayItems<T>(
	ctx: ExtensionContext,
	layer: EditableLayer,
	field: ArrayFieldDescriptor<T>,
	deps: SettingsUIDeps,
): readonly T[] {
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

export async function editArrayField<T>(
	ctx: ExtensionContext,
	layer: EditableLayer,
	field: ArrayFieldDescriptor<T>,
	deps: SettingsUIDeps,
	helpers: SettingsUIListEditorHelpers,
): Promise<"saved" | "cancelled"> {

	const filePath = helpers.resolveLayerWritePath(ctx, layer, deps);
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
		const inheritedItems = computeInheritedArrayItems(ctx, layer, field, deps);
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
			const rawItem = await promptInputRaw(ctx, {
				title: `${field.label}: add item`,
				help: field.help,
				initial: "",
			});
			if (rawItem === null || rawItem.trim().length === 0) continue;
			try {
				const parsedItem = field.arrayAccess.parseInput(rawItem);
				const renderedItem = field.arrayAccess.renderItem(parsedItem);
				const { written } = modifySettingArrayField({
					filePath,
					read: field.arrayAccess.readPartial,
					write: field.arrayAccess.writePartial,
					inheritedItems,
					op: { kind: "append", item: parsedItem },
				});
				anySaved = true;
				selectedIndex = Math.max(0, written.length - 1);
				ctx.ui.notify(
					formatSavedSettingNotification(
						`${field.label}: added "${renderedItem}"`,
						renderListSummary(written),
						layer,
						filePath,
					),
					"info",
				);
				await helpers.reloadAndApplySettings(ctx, deps);
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
						`${field.label}: removed "${field.arrayAccess.renderItem(removed)}"`,
						renderListSummary(written),
						layer,
						filePath,
					),
					"info",
				);
				await helpers.reloadAndApplySettings(ctx, deps);
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

function arrayItemEquals<T>(left: T, right: T | undefined): boolean {
	if (right === undefined) return false;
	if (Array.isArray(left) && Array.isArray(right)) {
		return left.length === right.length && left.every((v, i) => v === right[i]);
	}
	return left === right;
}

async function listEditorView<T>(
	ctx: ExtensionContext,
	args: {
		field: ArrayFieldDescriptor<T>;
		layer: EditableLayer;
		items: readonly T[];
		inheritedItems: readonly T[];
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
					label: field.arrayAccess.renderItem(item),
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
			items.every((v, i) => arrayItemEquals(v, inheritedItems[i]))
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

