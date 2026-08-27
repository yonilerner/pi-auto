import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PiAutoSettings, SandboxMode } from "../types.ts";

const NOTICE_LEVEL_ORDER = ["silent", "denials", "normal", "verbose"] as const;

/** Whether a notification tier is enabled by the current notice-level setting. */
export function shouldNotify(
	noticeLevel: PiAutoSettings["noticeLevel"],
	tier: "critical" | "denials" | "normal" | "verbose",
): boolean {
	if (tier === "critical") return true;
	return NOTICE_LEVEL_ORDER.indexOf(noticeLevel) >= NOTICE_LEVEL_ORDER.indexOf(tier);
}

/** Transient status shown while pi-auto is reviewing or re-running a command. */
export function setStatus(ctx: ExtensionContext, text: string | undefined): void {
	if (!ctx.hasUI) return;
	try {
		ctx.ui.setStatus("pi-auto", text);
	} catch {
		// Older pi versions may not support setStatus in all contexts.
	}
}

export function clearStatus(ctx: ExtensionContext): void {
	setStatus(ctx, undefined);
}

/** Render the persistent sandbox indicator without colliding with review status. */
export function setSandboxStatus(
	ctx: { hasUI: boolean; ui: { setStatus: (key: string, text: string | undefined) => void } },
	display: { mode: SandboxMode; broken: boolean } | undefined,
): void {
	if (!ctx.hasUI) return;
	const GREEN = "\x1b[92m";
	const RED = "\x1b[91m";
	const YELLOW = "\x1b[93m";
	const RESET = "\x1b[0m";
	const text = display === undefined
		? undefined
		: display.broken
			? `${RED}·sandbox BROKEN${RESET}`
			: display.mode === "off"
				? `${YELLOW}·sandbox OFF${RESET}`
				: `${GREEN}·sandbox${RESET}`;
	try {
		ctx.ui.setStatus("pi-auto-sandbox", text);
	} catch {
		// Older pi versions may not support setStatus in all contexts.
	}
}

export function setDisabledStatus(
	ctx: { hasUI: boolean; ui: { setStatus: (key: string, text: string | undefined) => void } },
	off: boolean,
): void {
	if (!ctx.hasUI) return;
	try {
		ctx.ui.setStatus("pi-auto-disabled", off ? "\x1b[91mpi-auto OFF\x1b[0m" : undefined);
	} catch {
		// Older pi versions may not support setStatus in all contexts.
	}
}
