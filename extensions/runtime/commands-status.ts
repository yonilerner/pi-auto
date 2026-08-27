import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getLatestDigest } from "../digest.ts";
import { registerSettingsCommand } from "../settings-ui/index.ts";
import { SandboxController } from "./sandbox-controller.ts";
import { formatSandboxReviewLog, parseSandboxLogCount, type SandboxReviewLogEntry } from "./sandbox-interceptor.ts";
import type { PiAutoSettings } from "../types.ts";
import { DEFAULT_SETTINGS, SessionState } from "./session-state.ts";
import { type createSandboxLifecycle } from "./sandbox-lifecycle.ts";
import { setDisabledStatus } from "./status-presentation.ts";

export interface RuntimeCommandsDeps {
	state: SessionState;
	sandboxController: SandboxController;
	recentDenials: readonly { command: string; reason: string; escapedAllow: boolean; at: number }[];
	sandboxReviewLog: readonly SandboxReviewLogEntry[];
	lifecycle: ReturnType<typeof createSandboxLifecycle>;
}

/** Registers the stable user-facing command surface and its exact presentation. */
export function registerRuntimeCommands(pi: ExtensionAPI, deps: RuntimeCommandsDeps): void {
	const { state, sandboxController, recentDenials, sandboxReviewLog, lifecycle } = deps;
	const settings = state.settings;
	const breaker = state.breaker;
	pi.registerCommand("pi-auto", {
		description: "Show pi-auto configuration and recent activity",
		handler: async (_args, ctx) => {
			const digestState = getLatestDigest(ctx.sessionManager);
			const lines = [
				`pi-auto: ${state.disabled ? "DISABLED — all tool calls run without review" : "enabled"}`,
				``,
				`settings:`,
				`  reviewer:                  ${settings.reviewerProvider}/${settings.reviewerModel}`,
				`  fallback to active model:  ${settings.fallbackToActiveModel}`,
				`  timeout:                   ${settings.reviewerTimeoutMs}ms`,
				`  circuit breaker:           ${settings.maxConsecutiveDenialsPerTurn} consecutive / ${settings.maxTotalDenialsPerTurn} total per turn`,
				`  transcript cap:            ${settings.maxTranscriptEntries} entries / ${settings.maxEntryChars} chars each / ${settings.maxTranscriptTotalChars} total`,
				`  pinned related entries:    up to ${settings.maxPinnedRelatedEntries}`,
				`  summary entries kept:      up to ${settings.maxSummaryEntries}`,
				`  rolling digest:            ${settings.enableDigest ? "on" : "off"}`,
				`  notice level:              ${settings.noticeLevel}`,
				`  sensitive paths:           ${settings.sensitivePathPatterns.join(", ")}`,
			];
			if (digestState) {
				lines.push(
					"",
					`current auth digest (${digestState.digest.length} chars, last update ${new Date(digestState.updatedAt).toISOString()}):`,
					digestState.digest,
				);
			}
			if (ctx.hasUI) {
				ctx.ui.notify(lines.join("\n"), "info");
			} else {
				console.log(lines.join("\n"));
			}
		},
	});

	pi.registerCommand("pi-auto-toggle-announce", {
		description:
			"DEPRECATED. Cycle pi-auto noticeLevel (silent → denials → normal → verbose). Prefer /pi-auto-settings.",
		handler: async (_args, ctx) => {
			const order: PiAutoSettings["noticeLevel"][] = [
				"silent",
				"denials",
				"normal",
				"verbose",
			];
			const i = order.indexOf(settings.noticeLevel);
			settings.noticeLevel = order[(i + 1) % order.length] ?? "normal";
			if (ctx.hasUI) {
				ctx.ui.notify(`pi-auto noticeLevel: ${settings.noticeLevel}`, "info");
			}
		},
	});

	pi.registerCommand("pi-auto-disable", {
		description:
			"Pause pi-auto review. All tool calls will run without review until /pi-auto-enable.",
		handler: async (_args, ctx) => {
			if (state.disabled) {
				if (ctx.hasUI) ctx.ui.notify("pi-auto is already disabled", "info");
				return;
			}
			state.disabled = true;
			if (ctx.hasUI) {
				ctx.ui.notify(
					"pi-auto: DISABLED — tool calls will run without review until /pi-auto-enable",
					"warning",
				);
				setDisabledStatus(ctx, true);
			}
		},
	});

	pi.registerCommand("pi-auto-sandbox", {
		description: "Show pi-auto sandbox status, current config, and recent denials",
		handler: async (_args, ctx) => {
			const s = settings.sandbox;
			const formatStringList = (items: readonly string[], empty: string) =>
				items.length ? items.join(", ") : empty;
			const formatCommandPrefixes = (prefixes: readonly (readonly string[])[]) =>
				prefixes.length ? prefixes.map((prefix) => prefix.join(" ")).join(", ") : "(none)";
			const runtimeState = sandboxController.state;
			const lines = [
				`pi-auto sandbox: mode = ${s.mode}`,
				``,
				`runtime state: ${runtimeState.kind}${runtimeState.kind === "broken" ? ` (${runtimeState.reason})` : ""}`,
				``,
				`command routing:`,
				`  extraSafeCommandPrefixes:              ${formatCommandPrefixes(settings.extraSafeCommandPrefixes)}`,
				`  sandbox.reviewOnlyCommandPrefixes:    ${formatCommandPrefixes(s.reviewOnlyCommandPrefixes)}`,
				``,
				`network:`,
				`  allowed domains:          ${formatStringList(s.allowedDomains, "(none — no network)")}`,
				`  denied domains:           ${formatStringList(s.deniedDomains, "(none)")}`,
				`  disable default NO_PROXY: ${s.disableDefaultNoProxy}`,
				`filesystem:`,
				`  allow read:      ${formatStringList(s.allowRead, "(runtime defaults)")}`,
				`  deny read:       ${formatStringList(s.denyRead, "(none)")}`,
				`  allow write:     ${formatStringList(s.allowWrite, "(none)")}`,
				`  deny write:      ${formatStringList(s.denyWrite, "(none)")}`,
				`  allowed dangerous files: ${formatStringList(s.allowedDangerousFiles, "(none)")}`,
				`ui:`,
				`  status indicator: ${s.showStatusIndicator}`,
				`  annotate bash:    ${s.annotateBashDisplay}`,
				`  notice level:     ${settings.noticeLevel} (see /pi-auto-settings)`,
			];
			if (recentDenials.length > 0) {
				lines.push("", `recent denials (most recent first):`);
				for (const d of [...recentDenials].reverse()) {
					const when = new Date(d.at).toISOString();
					const outcome = d.escapedAllow ? "escape ALLOWED" : "escape DENIED";
					lines.push(`  [${when}] ${outcome} (${d.reason}): ${d.command.slice(0, 200)}`);
				}
			} else {
				lines.push("", `recent denials: none`);
			}
			if (ctx.hasUI) {
				ctx.ui.notify(lines.join("\n"), "info");
			} else {
				console.log(lines.join("\n"));
			}
		},
	});

	const sandboxLogHandler = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
		const count = parseSandboxLogCount(args, 10);
		const text = formatSandboxReviewLog(sandboxReviewLog, count);
		if (ctx.hasUI) {
			ctx.ui.notify(text, "info");
		} else {
			console.log(text);
		}
	};
	for (const name of ["pi-auto-sandbox-log", "sandbox-log", "sandbox-review-log"] as const) {
		pi.registerCommand(name, {
			description: "Show recent in-memory sandbox denials and escape-review results (optional count; default 10)",
			handler: sandboxLogHandler,
		});
	}

	registerSettingsCommand(pi, {
		getSettings: () => settings,
		applySettings: (next) => state.applySettings(next),
		getLayers: () => state.settingsLayers,
		setLayers: (next) => {
			state.settingsLayers = next;
		},
		getPaths: () => state.settingsPaths,
		setPaths: (next) => {
			state.settingsPaths = next;
		},
		defaults: DEFAULT_SETTINGS,
		// Called after every successful /pi-auto-settings save. We reconcile
		// side-effecty bits (sandbox runtime, status indicator, breaker
		// thresholds) that the loader can't touch on its own.
		onSettingsApplied: async (ctx) => {
			breaker.setThresholds(settings.maxConsecutiveDenialsPerTurn, settings.maxTotalDenialsPerTurn);
			await lifecycle.applySandboxMode(ctx, { source: "settings-change" });
		},
	});

	pi.registerCommand("pi-auto-enable", {
		description: "Re-enable pi-auto review after /pi-auto-disable.",
		handler: async (_args, ctx) => {
			if (!state.disabled) {
				if (ctx.hasUI) ctx.ui.notify("pi-auto is already enabled", "info");
				return;
			}
			state.disabled = false;
			if (ctx.hasUI) {
				ctx.ui.notify("pi-auto: enabled — review is active", "info");
				setDisabledStatus(ctx, false);
			}
		},
	});
}
