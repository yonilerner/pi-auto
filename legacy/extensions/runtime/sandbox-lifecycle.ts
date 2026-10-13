import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { checkSandboxAvailability } from "../sandbox.ts";
import type { PiAutoSettings, SandboxMode, SandboxSettings } from "../types.ts";
import { SandboxController } from "./sandbox-controller.ts";
import { setSandboxStatus, shouldNotify } from "./status-presentation.ts";

/** Reconciles policy-capturing sandbox state with live settings changes. */
export function createSandboxLifecycle(settings: PiAutoSettings, sandboxController: SandboxController) {
	let appliedSandboxMode: SandboxMode = "off";
	let appliedSandboxSettings: SandboxSettings | undefined;

	async function applySandboxMode(
		ctx: ExtensionContext,
		opts: { source: "session-start" | "settings-change" },
	): Promise<void> {
		const desired = settings.sandbox.mode;
		const previous = appliedSandboxMode;
		const sandboxSettingsChanged = !sameSandboxSettings(appliedSandboxSettings, settings.sandbox);
		const runtimeState = sandboxController.state;
		const mustReset =
			(desired === "off" && runtimeState.kind !== "disabled") ||
			(desired !== "off" &&
				(sandboxSettingsChanged || runtimeState.kind === "broken") &&
				(runtimeState.kind === "ready" || runtimeState.kind === "initializing" || runtimeState.kind === "broken"));
		if (mustReset) await sandboxController.reset();

		if (desired !== "off") {
			const avail = checkSandboxAvailability(settings.sandbox);
			if (!avail.supportedPlatform || avail.errors.length > 0) {
				const msg = [
					`pi-auto sandbox mode="${desired}" but the OS sandbox is unavailable:`,
					...avail.errors.map((e) => `  - ${e}`),
					"",
					"Fix the missing dependencies, or set sandbox.mode = \"off\" in /pi-auto-settings.",
				].join("\n");
				if (ctx.hasUI) ctx.ui.notify(msg, "warning"); else console.error(msg);
				sandboxController.markBroken(avail.errors.join("; "));
			} else if (avail.warnings.length > 0 && ctx.hasUI && opts.source === "session-start" && shouldNotify(settings.noticeLevel, "verbose")) {
				ctx.ui.notify(`pi-auto sandbox: ${avail.warnings.join("; ")}`, "info");
			}
		}

		refreshSandboxStatus(ctx);
		if (ctx.hasUI && (opts.source === "session-start" || previous !== desired)) {
			if (desired === "off") {
				ctx.ui.notify("pi-auto sandbox: OFF — no OS-level backstop on bash calls. Re-enable via /pi-auto-settings.", "warning");
			} else if (previous !== desired && previous === "off" && shouldNotify(settings.noticeLevel, "verbose")) {
				ctx.ui.notify(`pi-auto sandbox: ${desired} — bash calls wrapped`, "info");
			} else if (previous !== desired && shouldNotify(settings.noticeLevel, "verbose")) {
				ctx.ui.notify(`pi-auto sandbox: mode changed → ${desired}`, "info");
			}
		}
		appliedSandboxMode = desired;
		appliedSandboxSettings = structuredClone(settings.sandbox);
	}

	function refreshSandboxStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		setSandboxStatus(ctx, settings.sandbox.showStatusIndicator
			? { mode: settings.sandbox.mode, broken: sandboxController.state.kind === "broken" }
			: undefined);
	}
	return { applySandboxMode, refreshSandboxStatus };
}

function sameSandboxSettings(left: SandboxSettings | undefined, right: SandboxSettings): boolean {
	return left !== undefined && JSON.stringify(left) === JSON.stringify(right);
}
