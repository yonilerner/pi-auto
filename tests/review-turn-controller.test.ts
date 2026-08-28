import { describe, expect, it } from "vitest";
import { CircuitBreaker } from "../extensions/circuit-breaker.ts";
import { ReviewTurnController } from "../extensions/runtime/review-turn-controller.ts";

describe("ReviewTurnController", () => {
	it("scopes breaker state to the active turn", () => {
		const breaker = new CircuitBreaker(2, 4);
		const turns = new ReviewTurnController(breaker);
		expect(turns.start(3)).toBe("turn-3");
		breaker.recordDenial(turns.turnId);
		turns.end();
		expect(turns.start(4)).toBe("turn-4");
		expect(breaker.recordDenial(turns.turnId).kind).toBe("continue");
	});
});
