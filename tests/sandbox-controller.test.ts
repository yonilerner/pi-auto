import { afterEach, describe, expect, it, vi } from "vitest";

const sandbox = vi.hoisted(() => ({
	ensureSandboxReady: vi.fn(),
	shutdownSandbox: vi.fn(),
}));

vi.mock("../extensions/sandbox.ts", () => sandbox);

import { SandboxController } from "../extensions/runtime/sandbox-controller.ts";
import type { PiAutoSettings, SandboxSettings } from "../extensions/types.ts";
import type { SandboxState } from "../extensions/sandbox.ts";

const sandboxSettings: SandboxSettings = {
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
};

const settings = { sandbox: sandboxSettings } as PiAutoSettings;

describe("SandboxController", () => {
	afterEach(() => {
		sandbox.ensureSandboxReady.mockReset();
		sandbox.shutdownSandbox.mockReset();
	});

	it("owns the runtime state boundary", async () => {
		const controller = new SandboxController();
		expect(controller.state).toEqual({ kind: "disabled" });
		controller.markBroken("missing dependency");
		expect(controller.state).toEqual({ kind: "broken", reason: "missing dependency" });
		await controller.reset();
		expect(controller.state).toEqual({ kind: "disabled" });
	});

	it("waits for deferred initialization before shutting down", async () => {
		let resolveInitialization:
			| ((state: { kind: "ready"; cwd: string; settings: SandboxSettings }) => void)
			| undefined;
		const initialization = new Promise<{ kind: "ready"; cwd: string; settings: SandboxSettings }>(
			(resolve) => {
				resolveInitialization = resolve;
			},
		);
		sandbox.ensureSandboxReady.mockImplementation(
			(_settings: PiAutoSettings, _cwd: string, state: { current: SandboxState }) => {
				const init = initialization.then((ready) => {
					state.current = ready;
					return ready;
				});
				state.current = { kind: "initializing", init };
				return init;
			},
		);
		sandbox.shutdownSandbox.mockImplementation(async (state: { current: SandboxState }) => {
			state.current = { kind: "disabled" };
		});

		const controller = new SandboxController();
		const pendingEnsure = controller.ensure(settings, "/repo");
		expect(controller.state.kind).toBe("initializing");
		const pendingReset = controller.reset();
		expect(sandbox.shutdownSandbox).not.toHaveBeenCalled();

		resolveInitialization?.({ kind: "ready", cwd: "/repo", settings: sandboxSettings });
		await Promise.all([pendingEnsure, pendingReset]);

		expect(sandbox.shutdownSandbox).toHaveBeenCalledTimes(1);
		expect(controller.state).toEqual({ kind: "disabled" });
	});
});
