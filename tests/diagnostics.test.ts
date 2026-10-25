import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatReviewDebug, persistReviewDebug, reviewerDebugPath, type ReviewDebugRecord } from "../extensions/diagnostics.ts";

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-auto-diagnostics-")); roots.push(root);
	vi.stubEnv("PI_AGENT_DIR", root);
	const record: ReviewDebugRecord = {
		at: "2026-10-20T00:00:00.000Z", tool: "memory_add", execution: "tool", outcome: "failed",
		review: { id: "review-id", provider: "openai", model: "gpt-6-luna", api: "openai-responses", reasoning: "off", format: "json_schema", failure: "missing_fields", attempts: [{ attempt: 1, latencyMs: 10, maxTokens: 2048, textChars: 15, stopReason: "stop", error: "missing_fields", validation: { code: "missing_fields", missing: ["evidence"] } }] },
	};
	return { root, record, file: reviewerDebugPath() };
}

describe("content-free reviewer debug persistence", () => {
	it("uses the configured agent directory and owner-only permissions", async () => {
		const { root, record, file } = fixture();
		await persistReviewDebug(record);
		expect(file).toBe(join(root, "pi-auto-v2", "reviewer-debug.jsonl"));
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(record);
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
	});
	it("caps the persistent record count at 200 and corrects existing permissions", async () => {
		const { record, file } = fixture();
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, Array.from({ length: 200 }, (_, index) => JSON.stringify({ index })).join("\n") + "\n");
		chmodSync(file, 0o644); chmodSync(dirname(file), 0o755);
		await persistReviewDebug(record);
		const lines = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		expect(lines).toHaveLength(200);
		expect(lines[0]).toEqual({ index: 1 });
		expect(lines.at(-1)).toEqual(record);
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
	});
	it("formats the review ID, model, attempt, and validation issue for /auto debug", () => {
		const { record } = fixture();
		const rendered = formatReviewDebug(record);
		for (const detail of ["review-id", "gpt-6-luna", "missing_fields", "evidence", "json_schema"]) expect(rendered).toContain(detail);
	});
});
