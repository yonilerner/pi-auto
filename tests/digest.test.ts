/**
 * Deterministic tests for the rolling digest.
 *
 * We can't easily mock pi-ai's `completeSimple` from here, so for the LLM-
 * dependent path (`updateDigestForTurn`) we test only the deterministic
 * pieces: getLatestDigest reading from session entries, and the digest's
 * delta-rendering of "entries since last summarized".
 */

import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DIGEST_CUSTOM_TYPE, getLatestDigest, MAX_DIGEST_CHARS } from "../extensions/digest.ts";

type ReadonlySessionManager = ExtensionContext["sessionManager"];

function digestEntry(id: string, digest: string, upToEntryId: string | null, updatedAt: number) {
	return {
		type: "custom",
		id,
		customType: DIGEST_CUSTOM_TYPE,
		data: { digest, upToEntryId, updatedAt },
	};
}

function fakeSessionManager(entries: unknown[]): ReadonlySessionManager {
	return { getEntries: () => entries, getLeafId: () => null } as unknown as ReadonlySessionManager;
}

describe("getLatestDigest", () => {
	it("returns undefined when no digest entries exist", () => {
		const sm = fakeSessionManager([{ type: "message", id: "m1" }]);
		expect(getLatestDigest(sm)).toBeUndefined();
	});

	it("returns the only digest when there is one", () => {
		const sm = fakeSessionManager([
			digestEntry("d1", "- task: build a parser", "m5", 1234),
		]);
		const result = getLatestDigest(sm);
		expect(result?.digest).toBe("- task: build a parser");
		expect(result?.upToEntryId).toBe("m5");
		expect(result?.updatedAt).toBe(1234);
	});

	it("returns the LATEST digest when multiple are present (last-wins by document order)", () => {
		const sm = fakeSessionManager([
			digestEntry("d1", "first", "m1", 100),
			{ type: "message", id: "m2" },
			digestEntry("d2", "second", "m2", 200),
			{ type: "message", id: "m3" },
			digestEntry("d3", "third", "m3", 300),
		]);
		expect(getLatestDigest(sm)?.digest).toBe("third");
	});

	it("ignores CustomEntries with a different customType", () => {
		const sm = fakeSessionManager([
			{ type: "custom", id: "x1", customType: "some-other-ext", data: { digest: "not ours" } },
		]);
		expect(getLatestDigest(sm)).toBeUndefined();
	});

	it("tolerates malformed digest data (missing fields)", () => {
		const sm = fakeSessionManager([
			{ type: "custom", id: "d1", customType: DIGEST_CUSTOM_TYPE, data: {} }, // no digest
			{ type: "custom", id: "d2", customType: DIGEST_CUSTOM_TYPE, data: { digest: 42 } }, // wrong type
			{ type: "custom", id: "d3", customType: DIGEST_CUSTOM_TYPE, data: null },
			digestEntry("d4", "valid", null, 0), // this one should win
		]);
		expect(getLatestDigest(sm)?.digest).toBe("valid");
	});

	it("defaults upToEntryId to null and updatedAt to 0 if missing", () => {
		const sm = fakeSessionManager([
			{ type: "custom", id: "d1", customType: DIGEST_CUSTOM_TYPE, data: { digest: "x" } },
		]);
		const result = getLatestDigest(sm);
		expect(result?.upToEntryId).toBeNull();
		expect(result?.updatedAt).toBe(0);
	});
});

describe("digest constants", () => {
	it("MAX_DIGEST_CHARS is a positive small number", () => {
		expect(MAX_DIGEST_CHARS).toBeGreaterThan(500);
		expect(MAX_DIGEST_CHARS).toBeLessThan(10_000);
	});
});
