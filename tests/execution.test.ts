import { describe, expect, it } from "vitest";
import { appendExecutionNotice } from "../extensions/execution.ts";

describe("delegated execution notices", () => {
	it("returns the original effective tool content untouched on success", () => {
		const content = [{ type: "text" as const, text: "custom output" }];
		expect(appendExecutionNotice(content, { blocked: false, denials: [] }, false)).toBe(content);
	});
	it("preserves every original block and appends sandbox evidence", () => {
		const content = [{ type: "text" as const, text: "partial output" }, { type: "image" as const, data: "fixture", mimeType: "image/png" }];
		const result = appendExecutionNotice(content, { blocked: true, denials: ["network denied: example.invalid"] }, false);
		expect(result.slice(0, 2)).toEqual(content);
		expect(result[0]).toBe(content[0]);
		expect(result[1]).toBe(content[1]);
		expect(result[2]).toMatchObject({ type: "text", text: expect.stringContaining("example.invalid") });
		expect(content).toHaveLength(2);
	});
	it("warns about partial effects for errors even without diagnostic denial", () => {
		const result = appendExecutionNotice([{ type: "text", text: "custom timeout" }], { blocked: false, denials: [] }, true);
		expect(result.at(-1)).toMatchObject({ text: "The command may have partially completed. It was not replayed." });
	});
	it("explains the host directive without replaying or replacing results", () => {
		const result = appendExecutionNotice([], { blocked: true, denials: ["filesystem denied"] }, true);
		expect(result[0]).toMatchObject({ text: expect.stringContaining("# pi-auto: host <reason>") });
	});
});
