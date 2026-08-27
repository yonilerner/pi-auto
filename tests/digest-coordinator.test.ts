import { describe, expect, it } from "vitest";
import { DigestCoordinator } from "../extensions/runtime/digest-coordinator.ts";

describe("DigestCoordinator", () => {
	it("serializes updates and continues after a failed update", async () => {
		const coordinator = new DigestCoordinator();
		const calls: string[] = [];
		let releaseFirst!: () => void;
		let startedFirst!: () => void;
		const first = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const started = new Promise<void>((resolve) => {
			startedFirst = resolve;
		});
		coordinator.schedule(async () => {
			calls.push("first-start");
			startedFirst();
			await first;
			calls.push("first-end");
		});
		coordinator.schedule(async () => {
			calls.push("second");
			throw new Error("best effort");
		});
		coordinator.schedule(async () => calls.push("third"));
		await started;
		expect(calls).toEqual(["first-start"]);
		releaseFirst();
		await coordinator.drain();
		expect(calls).toEqual(["first-start", "first-end", "second", "third"]);
	});
});
