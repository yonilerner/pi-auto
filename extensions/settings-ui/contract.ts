import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PiAutoSettings, SettingsLayerMap } from "../types.ts";

/** Runtime dependencies supplied by the extension composition root. */
export interface SettingsUIDeps {
	/** Reads from / writes to the live settings object owned by the extension runtime. */
	getSettings: () => PiAutoSettings;
	/** Replace the live settings (object identity preserved by caller). */
	applySettings: (next: PiAutoSettings) => void;
	getLayers: () => SettingsLayerMap;
	setLayers: (next: SettingsLayerMap) => void;
	getPaths: () => { userGlobal: string | null; perProject: string | null };
	setPaths: (next: { userGlobal: string | null; perProject: string | null }) => void;
	defaults: PiAutoSettings;
	/** Reconciles runtime side effects after a successful settings reload. */
	onSettingsApplied?: (ctx: ExtensionContext) => Promise<void> | void;
}
