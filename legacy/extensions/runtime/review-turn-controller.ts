import { CircuitBreaker } from "../circuit-breaker.ts";

/** Owns the per-turn reviewer state independently of Pi event registration. */
export class ReviewTurnController {
	private currentTurnId = "boot";

	constructor(readonly breaker: CircuitBreaker) {}

	start(turnIndex: number): string {
		this.currentTurnId = `turn-${turnIndex}`;
		this.breaker.clearTurn(this.currentTurnId);
		return this.currentTurnId;
	}

	end(): void {
		this.breaker.clearTurn(this.currentTurnId);
	}

	get turnId(): string {
		return this.currentTurnId;
	}
}
