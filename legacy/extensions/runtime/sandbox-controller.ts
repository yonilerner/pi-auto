import {
	ensureSandboxReady,
	shutdownSandbox,
	type SandboxState,
} from "../sandbox.ts";
import type { PiAutoSettings } from "../types.ts";

/** Owns sandbox runtime state so Pi event wiring does not mutate it directly. */
export class SandboxController {
	private readonly stateRef: { current: SandboxState } = { current: { kind: "disabled" } };
	private resetInFlight: Promise<void> | undefined;

	get state(): SandboxState {
		return this.stateRef.current;
	}

	async ensure(settings: PiAutoSettings, cwd: string): Promise<SandboxState> {
		return ensureSandboxReady(settings, cwd, this.stateRef);
	}

	reset(): Promise<void> {
		if (this.resetInFlight) return this.resetInFlight;
		const reset = this.resetAfterInitialization();
		this.resetInFlight = reset;
		void reset.then(
			() => {
				if (this.resetInFlight === reset) this.resetInFlight = undefined;
			},
			() => {
				if (this.resetInFlight === reset) this.resetInFlight = undefined;
			},
		);
		return reset;
	}

	private async resetAfterInitialization(): Promise<void> {
		const state = this.stateRef.current;
		if (state.kind === "initializing") {
			try {
				await state.init;
			} catch {
				// ensureSandboxReady normally converts failures to broken state, but
				// reset must still leave the controller disabled if initialization
				// itself rejects unexpectedly.
			}
		}
		await shutdownSandbox(this.stateRef);
		this.stateRef.current = { kind: "disabled" };
	}

	markBroken(reason: string): void {
		this.stateRef.current = { kind: "broken", reason };
	}
}
