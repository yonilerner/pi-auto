import {
	ensureSandboxReady,
	shutdownSandbox,
	type SandboxState,
} from "../sandbox.ts";
import type { PiAutoSettings } from "../types.ts";

/** Owns sandbox runtime state so Pi event wiring does not mutate it directly. */
export class SandboxController {
	private readonly stateRef: { current: SandboxState } = { current: { kind: "disabled" } };

	get state(): SandboxState {
		return this.stateRef.current;
	}

	async ensure(settings: PiAutoSettings, cwd: string): Promise<SandboxState> {
		return ensureSandboxReady(settings, cwd, this.stateRef);
	}

	async reset(): Promise<void> {
		await shutdownSandbox(this.stateRef);
		this.stateRef.current = { kind: "disabled" };
	}

	markBroken(reason: string): void {
		this.stateRef.current = { kind: "broken", reason };
	}
}
