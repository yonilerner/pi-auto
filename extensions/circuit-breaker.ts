/**
 * Per-turn denial circuit breaker.
 *
 * Mirrors Codex's GuardianRejectionCircuitBreaker:
 *   - 3 consecutive denials in a turn → trip
 *   - 10 total denials in a turn → trip
 *   - any non-denial resets the consecutive counter
 *
 * When tripped we ask the caller to interrupt the turn.
 */

export type CircuitBreakerAction =
	| { kind: "continue" }
	| { kind: "interrupt"; consecutive: number; total: number };

interface TurnState {
	consecutive: number;
	total: number;
	tripped: boolean;
}

export class CircuitBreaker {
	private turns = new Map<string, TurnState>();
	constructor(
		private readonly maxConsecutive: number,
		private readonly maxTotal: number,
	) {}

	clearTurn(turnId: string): void {
		this.turns.delete(turnId);
	}

	recordDenial(turnId: string): CircuitBreakerAction {
		const state = this.getOrCreate(turnId);
		state.consecutive += 1;
		state.total += 1;
		if (!state.tripped && (state.consecutive >= this.maxConsecutive || state.total >= this.maxTotal)) {
			state.tripped = true;
			return { kind: "interrupt", consecutive: state.consecutive, total: state.total };
		}
		return { kind: "continue" };
	}

	recordNonDenial(turnId: string): void {
		const state = this.getOrCreate(turnId);
		state.consecutive = 0;
	}

	private getOrCreate(turnId: string): TurnState {
		let state = this.turns.get(turnId);
		if (!state) {
			state = { consecutive: 0, total: 0, tripped: false };
			this.turns.set(turnId, state);
		}
		return state;
	}
}
