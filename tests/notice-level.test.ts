import { describe, expect, it } from "vitest";
import { shouldNotify } from "../extensions/pi-auto.ts";
import type { NoticeLevel } from "../extensions/types.ts";

describe("shouldNotify", () => {
	const LEVELS: NoticeLevel[] = ["silent", "denials", "normal", "verbose"];

	it("always returns true for tier='critical' regardless of noticeLevel", () => {
		// Critical-tier notices are posture warnings the user has to see
		// (sandbox unavailable, settings load errors, sandbox OFF startup
		// warning). They are never suppressed by the user's noticeLevel.
		for (const level of LEVELS) {
			expect(shouldNotify(level, "critical")).toBe(true);
		}
	});

	it("silent suppresses every routine tier", () => {
		expect(shouldNotify("silent", "denials")).toBe(false);
		expect(shouldNotify("silent", "normal")).toBe(false);
		expect(shouldNotify("silent", "verbose")).toBe(false);
	});

	it("denials shows denial-tier and below but not normal/verbose", () => {
		expect(shouldNotify("denials", "denials")).toBe(true);
		expect(shouldNotify("denials", "normal")).toBe(false);
		expect(shouldNotify("denials", "verbose")).toBe(false);
	});

	it("normal shows denials + normal, not verbose", () => {
		expect(shouldNotify("normal", "denials")).toBe(true);
		expect(shouldNotify("normal", "normal")).toBe(true);
		expect(shouldNotify("normal", "verbose")).toBe(false);
	});

	it("verbose shows everything", () => {
		expect(shouldNotify("verbose", "denials")).toBe(true);
		expect(shouldNotify("verbose", "normal")).toBe(true);
		expect(shouldNotify("verbose", "verbose")).toBe(true);
	});

	it("is monotonic: a higher noticeLevel never hides a notice a lower level showed", () => {
		// Sanity check on the precedence order. If we add a new level later,
		// this guards against accidentally reordering NOTICE_LEVEL_ORDER.
		const TIERS = ["denials", "normal", "verbose"] as const;
		for (let i = 0; i < LEVELS.length - 1; i++) {
			const lower = LEVELS[i] as NoticeLevel;
			const higher = LEVELS[i + 1] as NoticeLevel;
			for (const tier of TIERS) {
				if (shouldNotify(lower, tier)) {
					expect(shouldNotify(higher, tier), `${higher} should also show ${tier} since ${lower} does`).toBe(true);
				}
			}
		}
	});
});
