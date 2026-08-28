import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SettingsLayer } from "../types.ts";
import type { EditableLayer } from "./fields.ts";

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

export function notifyOrLog(
	ctx: ExtensionContext,
	message: string,
	level: "info" | "warning",
): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, level);
		return;
	}
	const log = level === "warning" ? console.error : console.log;
	log(message);
}

export function isShadowed(currentLayer: SettingsLayer, editingLayer: EditableLayer): boolean {
	const order: Record<SettingsLayer, number> = {
		default: 0,
		"user-global": 1,
		"per-project": 2,
		env: 3,
	};
	return order[currentLayer] > order[editingLayer];
}
