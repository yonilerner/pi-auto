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
import {
	DIGEST_CUSTOM_TYPE,
	getLatestDigest,
	MAX_DIGEST_CHARS,
	stripPoisonLines,
} from "../extensions/digest.ts";

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

describe("stripPoisonLines", () => {
	// Examples observed in actual digest outputs from session 019eae8a + tests.
	const POISON_LINES = [
		"- ~/code/discord-2 (assistant asked the user to authorize reads here; user did not previously authorize)",
		"- /Users/yonilerner/code/discord-2/... (user's project location was referenced in assistant actions, but the user did not explicitly authorize)",
		"- No explicit user authorization for destructive operations (delete/modify) was given; user did not authorize specific write/delete operations.",
		"- The user did not state any explicit scope constraints, prohibitions, or file-editing limits in their messages.",
		"- The user did not explicitly authorize any write, delete, or mutation operations; they requested help diagnosing/fixing the UI.",
		"- /home/me/code/foo/bar.tsx (accessed by the assistant; user has not authorized this read)",
		"- the action lacks explicit authorization from the user",
		"- this path was not authorized by the user",
		"  - ~/code/foo (user did not grant access to this path)",
	];

	const LEGITIMATE_LINES = [
		"- User's overall task and intent: fix the tabs project UI so tabs render navigated content.",
		"- The user said much of the project state is in the loop data folder for this project.",
		"- Paths/resources the user mentioned (task context):",
		"  - ~/code/discord-2/discord_app/modules/tabs/",
		"  - misc/users/yoni/specs/tabs-rfc.md",
		"- the user said: 'I authorize you to delete /tmp/scratch'",
		"- Explicit denials from the user: none.",
		"- Destructive operations the user acknowledged: deletion of /tmp/scratch.",
	];

	it("removes poisoning lines verbatim from observed outputs", () => {
		for (const line of POISON_LINES) {
			const out = stripPoisonLines(line);
			expect(out, `expected ${JSON.stringify(line)} to be stripped, got ${JSON.stringify(out)}`).toBe("");
		}
	});

	it("keeps legitimate digest bullets intact", () => {
		for (const line of LEGITIMATE_LINES) {
			const out = stripPoisonLines(line);
			expect(out, `expected ${JSON.stringify(line)} to be preserved, got ${JSON.stringify(out)}`).toBe(line);
		}
	});

	it("strips poisoned lines from a mixed digest while preserving the rest", () => {
		const input = [
			"- User's overall task: debug the tabs project.",
			"- The user said the project state lives in ~/.pi/agent/data/large-project-loop/",
			"- ~/code/discord-2 (assistant asked the user to authorize reads here; user did not previously authorize)",
			"- The user did not explicitly authorize any write or delete operations.",
			"- Files the user named as context:",
			"  - tabs-rfc.md",
			"  - TabbedAppView.tsx",
		].join("\n");
		const out = stripPoisonLines(input);
		expect(out).toBe(
			[
				"- User's overall task: debug the tabs project.",
				"- The user said the project state lives in ~/.pi/agent/data/large-project-loop/",
				"- Files the user named as context:",
				"  - tabs-rfc.md",
				"  - TabbedAppView.tsx",
			].join("\n"),
		);
	});

	it("returns empty string for input that is entirely poisoned", () => {
		const out = stripPoisonLines(POISON_LINES.join("\n"));
		expect(out).toBe("");
	});

	it("is a no-op on a clean digest", () => {
		const clean = LEGITIMATE_LINES.join("\n");
		expect(stripPoisonLines(clean)).toBe(clean);
	});
});
