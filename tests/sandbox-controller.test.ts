import { describe, expect, it } from "vitest";
import { SandboxController } from "../extensions/runtime/sandbox-controller.ts";

describe("SandboxController", () => {
	it("owns the runtime state boundary", async () => {
		const controller = new SandboxController();
		expect(controller.state).toEqual({ kind: "disabled" });
		controller.markBroken("missing dependency");
		expect(controller.state).toEqual({ kind: "broken", reason: "missing dependency" });
		await controller.reset();
		expect(controller.state).toEqual({ kind: "disabled" });
	});
});
