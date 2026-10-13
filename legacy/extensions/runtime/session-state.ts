import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CircuitBreaker } from "../circuit-breaker.ts";
import { loadSettings } from "../settings-store.ts";
import type { PiAutoSettings, SettingsLayerMap } from "../types.ts";
import { DigestCoordinator } from "./digest-coordinator.ts";
import { ReviewTurnController } from "./review-turn-controller.ts";

export const DEFAULT_SETTINGS: PiAutoSettings = {
	reviewerProvider: "openai",
	reviewerModel: "gpt-5-mini",
	// "auto" preserves the historical behavior (low for codex-auto-review,
	// minimal otherwise). Override in the UI/JSON if the configured model
	// doesn't accept minimal — gpt-5.6-luna is the current motivating case.
	reviewerReasoning: "auto",
	// Default false: an unintended fallback to the session model on a typo or
	// outage is usually worse than the reviewer failing closed (we fall back
	// to a user prompt). Users who want auto-fallback can opt in via
	// /pi-auto-settings.
	fallbackToActiveModel: false,
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
	sensitivePathPatterns: [
		"~/.ssh",
		"~/.aws",
		"~/.gnupg",
		"~/.kube",
		"~/.config/gh",
		"~/.netrc",
		"~/.npmrc",
		"~/.pypirc",
		"/etc/shadow",
		"/etc/sudoers",
		"credentials",
		".env",
	],
	noticeLevel: "normal",
	customPolicy: "",
	reviewerPolicySource: "default",
	extraSafeCommandPrefixes: [],
	// Default to false on both: the policy already polices authorization-source
	// (assistant text doesn't count as auth, tool results don't count as auth),
	// and stripping carries a small loss of context for evidence chains like
	// `git status` -> action. See the README for the ablation comparing
	// gpt-5-mini across baseline, strip-assistant, and strip-both.
	stripAssistantText: false,
	stripToolResults: false,
	sandbox: {
		// Default escape-only — every bash call runs wrapped, the reviewer is
		// only invoked when the sandbox denies. This is the cheapest of the two
		// "on" modes and gives you the OS-level backstop on a fresh install.
		// Set to "off" via /pi-auto-settings if you want the prior behavior
		// (no wrapping; reviewer gates everything).
		mode: "escape-only",
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


/** Mutable per-session state; the settings object retains its identity across reloads. */
export class SessionState {
	readonly settings: PiAutoSettings = structuredClone(DEFAULT_SETTINGS);
	settingsLayers: SettingsLayerMap = buildInitialLayerMap();
	settingsPaths: { userGlobal: string | null; perProject: string | null } = { userGlobal: null, perProject: null };
	readonly breaker = new CircuitBreaker(this.settings.maxConsecutiveDenialsPerTurn, this.settings.maxTotalDenialsPerTurn);
	readonly digestCoordinator = new DigestCoordinator();
	readonly turnController = new ReviewTurnController(this.breaker);
	disabled = false;

	load(ctx: ExtensionContext): string[] {
		const loaded = loadSettings({ defaults: DEFAULT_SETTINGS, cwd: ctx.cwd });
		assignSettings(this.settings, loaded.settings);
		this.settingsLayers = loaded.layers;
		this.settingsPaths = loaded.paths;
		this.breaker.setThresholds(this.settings.maxConsecutiveDenialsPerTurn, this.settings.maxTotalDenialsPerTurn);
		return loaded.warnings;
	}

	applySettings(next: PiAutoSettings): void {
		assignSettings(this.settings, next);
	}
}

/** Replace fields in place so handlers retain the current live settings object. */
export function assignSettings(target: PiAutoSettings, source: PiAutoSettings): void {
	for (const key of Object.keys(source) as Array<keyof PiAutoSettings>) {
		(target as any)[key] = (source as any)[key];
	}
}

function buildInitialLayerMap(): SettingsLayerMap {
	const map = {} as SettingsLayerMap;
	for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof PiAutoSettings>) map[key] = "default";
	return map;
}
