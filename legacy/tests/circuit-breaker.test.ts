import { describe, expect, it } from "vitest";
import { CircuitBreaker } from "../extensions/circuit-breaker.ts";

describe("CircuitBreaker", () => {
	it("does not trip on a single denial", () => {
		const cb = new CircuitBreaker(3, 10);
		expect(cb.recordDenial("t1").kind).toBe("continue");
	});

	it("trips after maxConsecutive denials in a row", () => {
		const cb = new CircuitBreaker(3, 10);
		expect(cb.recordDenial("t1").kind).toBe("continue");
		expect(cb.recordDenial("t1").kind).toBe("continue");
		const action = cb.recordDenial("t1");
		expect(action.kind).toBe("interrupt");
		if (action.kind === "interrupt") {
			expect(action.consecutive).toBe(3);
			expect(action.total).toBe(3);
		}
	});

	it("trips after maxTotal denials even when interleaved with non-denials", () => {
		const cb = new CircuitBreaker(3, 5);
		// 2 denials, allow, 2 denials, allow, ... interleaved so consecutive resets.
		for (let i = 0; i < 4; i++) {
			expect(cb.recordDenial("t1").kind).toBe("continue");
			cb.recordNonDenial("t1");
		}
		// 4 total denials so far, max consecutive was reset to 0.
		// 5th denial should hit the total cap.
		const action = cb.recordDenial("t1");
		expect(action.kind).toBe("interrupt");
		if (action.kind === "interrupt") {
			expect(action.total).toBe(5);
			expect(action.consecutive).toBe(1);
		}
	});

	it("recordNonDenial resets the consecutive counter", () => {
		const cb = new CircuitBreaker(3, 10);
		cb.recordDenial("t1");
		cb.recordDenial("t1");
		cb.recordNonDenial("t1");
		// Two more denials would have tripped if not reset.
		expect(cb.recordDenial("t1").kind).toBe("continue");
		expect(cb.recordDenial("t1").kind).toBe("continue");
	});

	it("only fires interrupt once per turn, even if more denials come after", () => {
		const cb = new CircuitBreaker(3, 10);
		cb.recordDenial("t1");
		cb.recordDenial("t1");
		expect(cb.recordDenial("t1").kind).toBe("interrupt");
		// Further denials should NOT keep firing interrupt — they continue.
		expect(cb.recordDenial("t1").kind).toBe("continue");
		expect(cb.recordDenial("t1").kind).toBe("continue");
	});

	it("isolates denials per turnId", () => {
		const cb = new CircuitBreaker(3, 10);
		cb.recordDenial("t1");
		cb.recordDenial("t1");
		// Different turn — should start fresh.
		expect(cb.recordDenial("t2").kind).toBe("continue");
		// t1 third denial trips it, t2 is unaffected.
		expect(cb.recordDenial("t1").kind).toBe("interrupt");
		expect(cb.recordDenial("t2").kind).toBe("continue");
	});

	it("clearTurn resets state for that turn", () => {
		const cb = new CircuitBreaker(3, 10);
		cb.recordDenial("t1");
		cb.recordDenial("t1");
		cb.clearTurn("t1");
		// Fresh state.
		expect(cb.recordDenial("t1").kind).toBe("continue");
		expect(cb.recordDenial("t1").kind).toBe("continue");
		expect(cb.recordDenial("t1").kind).toBe("interrupt");
	});
});
