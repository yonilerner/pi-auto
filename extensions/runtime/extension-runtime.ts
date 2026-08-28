import type { ExtensionAPI, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { updateDigestForTurn } from "../digest.ts";
import { reviewAction } from "../reviewer.ts";
import { decideScope } from "../scope.ts";
import { registerRuntimeCommands } from "./commands-status.ts";
import { handleReviewResult } from "./review-gate.ts";
import { SandboxController } from "./sandbox-controller.ts";
import { createSandboxInterceptor } from "./sandbox-interceptor.ts";
import { createSandboxLifecycle } from "./sandbox-lifecycle.ts";
import { SessionState } from "./session-state.ts";
import { clearStatus, setStatus } from "./status-presentation.ts";

export { fallbackToUser, handleCircuitBreaker, handleReviewResult } from "./review-gate.ts";
export { formatSandboxReviewLog, parseSandboxLogCount, type SandboxReviewLogEntry } from "./sandbox-interceptor.ts";
export { shouldNotify } from "./status-presentation.ts";

/**
 * Pi composition root: registers events and composes focused runtime ports.
 * Policy, transcript construction, sandbox escape flow, and presentation live
 * behind the dedicated modules imported above.
 */
export default function piAuto(pi: ExtensionAPI): void {
	const state = new SessionState();
	const sandboxController = new SandboxController();
	const lifecycle = createSandboxLifecycle(state.settings, sandboxController);
	const sandboxInterceptor = createSandboxInterceptor({
		settings: state.settings,
		breaker: state.breaker,
		getTurnId: () => state.turnController.turnId,
		isDisabled: () => state.disabled,
		sandboxController,
	});

	pi.on("session_start", async (_event, ctx) => {
		const warnings = state.load(ctx);
		if (warnings.length > 0 && ctx.hasUI) {
			for (const warning of warnings) ctx.ui.notify(warning, "warning");
		}
		await lifecycle.applySandboxMode(ctx, { source: "session-start" });
	});
	pi.on("session_shutdown", () => {
		void state.digestCoordinator.drain();
		void sandboxController.reset();
	});
	pi.on("turn_start", (event) => {
		state.turnController.start(event.turnIndex);
	});
	pi.on("turn_end", (_event, ctx) => {
		state.turnController.end();
		if (state.settings.enableDigest) {
			state.digestCoordinator.schedule(() => updateDigestForTurn(ctx, state.settings, pi));
		}
	});
	pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | undefined> => {
		if (state.disabled) return undefined;
		if (event.toolName === "bash" && state.settings.sandbox.mode !== "off") {
			return sandboxInterceptor.handleToolCall(event, ctx);
		}
		const scope = decideScope(event, ctx.cwd, state.settings);
		if (!scope.review) return undefined;
		setStatus(ctx, `reviewing ${event.toolName}…`);
		const result = await reviewAction(scope.action, ctx, state.settings);
		clearStatus(ctx);
		return handleReviewResult(
			result,
			scope.action,
			ctx,
			state.breaker,
			state.settings,
			state.turnController.turnId,
		);
	});
	pi.on("tool_result", async (event, ctx) => {
		return await sandboxInterceptor.handleToolResult(event, ctx);
	});

	registerRuntimeCommands(pi, {
		state,
		sandboxController,
		recentDenials: sandboxInterceptor.recentDenials,
		sandboxReviewLog: sandboxInterceptor.sandboxReviewLog,
		lifecycle,
	});
}
