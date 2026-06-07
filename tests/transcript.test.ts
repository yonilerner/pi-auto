import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildTranscript } from "../extensions/transcript.ts";
import type { PiAutoSettings, ReviewableAction } from "../extensions/types.ts";

type ReadonlySessionManager = ExtensionContext["sessionManager"];

interface FakeEntry {
	type: string;
	id?: string;
	parentId?: string | null;
	timestamp?: string;
	message?: {
		role?: string;
		content?: unknown;
		toolName?: string;
		isError?: boolean;
	};
	summary?: string;
}

function fakeSessionManager(entries: FakeEntry[]): ReadonlySessionManager {
	return { getBranch: () => entries } as unknown as ReadonlySessionManager;
}

const BASE_SETTINGS: PiAutoSettings = {
	reviewerProvider: "openai",
	reviewerModel: "gpt-5-mini",
	fallbackToActiveModel: true,
	reviewerTimeoutMs: 30_000,
	maxConsecutiveDenialsPerTurn: 3,
	maxTotalDenialsPerTurn: 10,
	maxTranscriptEntries: 5,
	maxEntryChars: 200,
	maxTranscriptTotalChars: 100_000,
	maxPinnedRelatedEntries: 3,
	maxSummaryEntries: 3,
	enableDigest: true,
	sensitivePathPatterns: [],
	announceAllows: true,
	customPolicy: "",
};

const NOOP_ACTION: ReviewableAction = {
	toolName: "bash",
	toolCallId: "tc-x",
	label: "bash: noop",
	payload: { tool: "bash", command: "noop" },
};

function userMsg(id: string, text: string): FakeEntry {
	return { type: "message", id, message: { role: "user", content: text } };
}
function asstMsg(id: string, text: string): FakeEntry {
	return { type: "message", id, message: { role: "assistant", content: [{ type: "text", text }] } };
}
function toolCallMsg(id: string, name: string, args: Record<string, unknown>): FakeEntry {
	return {
		type: "message",
		id,
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "ok" },
				{ type: "toolCall", name, arguments: args },
			],
		},
	};
}
function toolResultMsg(id: string, toolName: string, text: string, isError = false): FakeEntry {
	return {
		type: "message",
		id,
		message: {
			role: "toolResult",
			toolName,
			isError,
			content: [{ type: "text", text }],
		},
	};
}
function compactionEntry(id: string, summary: string): FakeEntry {
	return { type: "compaction", id, summary };
}
function branchSummaryEntry(id: string, summary: string): FakeEntry {
	return { type: "branch_summary", id, summary };
}

describe("buildTranscript: basics", () => {
	it("returns (no prior transcript) for empty branches with no digest", () => {
		const out = buildTranscript({
			sessionManager: fakeSessionManager([]),
			settings: BASE_SETTINGS,
			action: NOOP_ACTION,
		});
		expect(out).toBe("(no prior transcript)");
	});

	it("includes user / assistant / tool_call / tool_result lines from recent window", () => {
		const sm = fakeSessionManager([
			userMsg("u1", "delete the build dir"),
			toolCallMsg("a1", "bash", { command: "rm -rf build" }),
			toolResultMsg("r1", "bash", "<no output>"),
			asstMsg("a2", "done"),
		]);
		const out = buildTranscript({ sessionManager: sm, settings: BASE_SETTINGS, action: NOOP_ACTION });
		expect(out).toContain("[recent transcript]");
		expect(out).toContain("[user] delete the build dir");
		expect(out).toContain("[tool_call] bash");
		expect(out).toContain("[tool_result] bash: <no output>");
		expect(out).toContain("[assistant] done");
	});
});

describe("buildTranscript: F1 — compaction and branch_summary entries", () => {
	it("includes compaction summaries when present", () => {
		const sm = fakeSessionManager([
			compactionEntry("c1", "user asked to clean up /tmp/test-* paths"),
			userMsg("u1", "now do the cleanup"),
		]);
		const out = buildTranscript({ sessionManager: sm, settings: BASE_SETTINGS, action: NOOP_ACTION });
		expect(out).toContain("[earlier summaries]");
		expect(out).toContain("user asked to clean up /tmp/test-* paths");
	});

	it("includes branch_summary summaries when present", () => {
		const sm = fakeSessionManager([
			branchSummaryEntry("b1", "earlier branch: user authorized DB resets in dev"),
			userMsg("u1", "continue"),
		]);
		const out = buildTranscript({ sessionManager: sm, settings: BASE_SETTINGS, action: NOOP_ACTION });
		expect(out).toContain("[earlier summaries]");
		expect(out).toContain("user authorized DB resets in dev");
	});

	it("caps the number of summary entries", () => {
		const entries: FakeEntry[] = [];
		for (let i = 0; i < 10; i++) {
			entries.push(compactionEntry(`c${i}`, `summary ${i}`));
		}
		entries.push(userMsg("u1", "go"));
		const settings = { ...BASE_SETTINGS, maxSummaryEntries: 2 };
		const out = buildTranscript({ sessionManager: fakeSessionManager(entries), settings, action: NOOP_ACTION });
		// Only the last 2 summaries should appear.
		expect(out).toContain("summary 8");
		expect(out).toContain("summary 9");
		expect(out).not.toContain("summary 0");
	});
});

describe("buildTranscript: F2 — first user message anchor", () => {
	it("pins the first user message when it's outside the recent window", () => {
		const entries: FakeEntry[] = [
			userMsg("u-first", "OVERALL TASK: build a new parser for the foo format"),
		];
		// Fill up to push u-first out of the recent window.
		for (let i = 0; i < 20; i++) {
			entries.push(asstMsg(`a${i}`, `working on step ${i}`));
		}
		entries.push(userMsg("u-last", "what's next?"));
		const settings = { ...BASE_SETTINGS, maxTranscriptEntries: 5 };
		const out = buildTranscript({ sessionManager: fakeSessionManager(entries), settings, action: NOOP_ACTION });
		expect(out).toContain("[first user message]");
		expect(out).toContain("OVERALL TASK: build a new parser");
		expect(out).toContain("[user] what's next?");
	});

	it("does NOT duplicate the first user message if it's already in the recent window", () => {
		const sm = fakeSessionManager([
			userMsg("u1", "ONLY MESSAGE"),
			asstMsg("a1", "ok"),
		]);
		const out = buildTranscript({ sessionManager: sm, settings: BASE_SETTINGS, action: NOOP_ACTION });
		// Should appear exactly once.
		const occurrences = out.match(/ONLY MESSAGE/g);
		expect(occurrences?.length).toBe(1);
		expect(out).not.toContain("[first user message]");
	});
});

describe("buildTranscript: D — action-keyed pinned retrieval", () => {
	it("pins an older entry that references the action's path", () => {
		const entries: FakeEntry[] = [
			userMsg("u-first", "kickoff message"),
			userMsg("u-auth", "you can delete anything under /tmp/test-data when you're done"),
		];
		// Add 30 unrelated entries to push u-auth out of the recent window.
		for (let i = 0; i < 30; i++) {
			entries.push(asstMsg(`a${i}`, `reading file unrelated-${i}.txt`));
		}
		entries.push(userMsg("u-now", "do the cleanup"));

		const rmAction: ReviewableAction = {
			toolName: "bash",
			toolCallId: "tc-1",
			label: "bash: rm -rf /tmp/test-data",
			payload: { tool: "bash", command: "rm -rf /tmp/test-data", cwd: "/home/me/project" },
		};
		const settings = { ...BASE_SETTINGS, maxTranscriptEntries: 5 };
		const out = buildTranscript({ sessionManager: fakeSessionManager(entries), settings, action: rmAction });
		expect(out).toContain("[earlier context related to this action]");
		expect(out).toContain("you can delete anything under /tmp/test-data");
		// And it doesn't break the recent window.
		expect(out).toContain("[user] do the cleanup");
	});

	it("respects maxPinnedRelatedEntries", () => {
		const entries: FakeEntry[] = [];
		// First user message is unrelated to the action so it doesn't inflate the count.
		entries.push(userMsg("u-first", "hi"));
		// 20 entries that all mention the action's path, as assistant messages so
		// they aren't picked up as the first-user-message anchor.
		for (let i = 0; i < 20; i++) {
			entries.push(asstMsg(`m${i}`, `MARKED ${i} about /tmp/test-data and cleanup`));
		}
		// Recent window noise (no path mentions).
		for (let i = 0; i < 5; i++) {
			entries.push(asstMsg(`a${i}`, "thinking"));
		}
		const rmAction: ReviewableAction = {
			toolName: "bash",
			toolCallId: "tc-1",
			label: "bash: rm -rf /tmp/test-data",
			payload: { tool: "bash", command: "rm -rf /tmp/test-data", cwd: "/home/me/project" },
		};
		const settings = { ...BASE_SETTINGS, maxTranscriptEntries: 5, maxPinnedRelatedEntries: 3 };
		const out = buildTranscript({ sessionManager: fakeSessionManager(entries), settings, action: rmAction });
		const pinnedCount = (out.match(/MARKED \d+ about/g) ?? []).length;
		expect(pinnedCount).toBe(3);
	});

	it("does not pin anything when nothing matches the action keywords", () => {
		const entries: FakeEntry[] = [];
		for (let i = 0; i < 30; i++) {
			entries.push(userMsg(`m${i}`, `weather is nice today, day ${i}`));
		}
		const action: ReviewableAction = {
			toolName: "bash",
			toolCallId: "tc-1",
			label: "bash: psql -c 'DROP TABLE customers'",
			payload: { tool: "bash", command: "psql -c 'DROP TABLE customers'", cwd: "/x" },
		};
		const out = buildTranscript({ sessionManager: fakeSessionManager(entries), settings: BASE_SETTINGS, action });
		expect(out).not.toContain("[earlier context related to this action]");
	});
});

describe("buildTranscript: digest section", () => {
	it("renders the digest at the top when provided", () => {
		const sm = fakeSessionManager([userMsg("u1", "hi")]);
		const out = buildTranscript({
			sessionManager: sm,
			settings: BASE_SETTINGS,
			action: NOOP_ACTION,
			digest: "- user authorized rm -rf /tmp/test-*\n- task is to benchmark parser",
		});
		expect(out.indexOf("[digest]")).toBe(0);
		expect(out).toContain("authorized rm -rf /tmp/test-*");
	});

	it("omits the digest section when digest is empty", () => {
		const sm = fakeSessionManager([userMsg("u1", "hi")]);
		const out = buildTranscript({
			sessionManager: sm,
			settings: BASE_SETTINGS,
			action: NOOP_ACTION,
			digest: "   ",
		});
		expect(out).not.toContain("[digest]");
	});
});

describe("buildTranscript: middle truncation", () => {
	it("preserves both head and tail of long entries", () => {
		const longText = `${"HEAD ".repeat(50)}MIDDLE FILLER ${"x".repeat(2000)} MIDDLE FILLER ${"TAIL ".repeat(50)}`;
		const sm = fakeSessionManager([userMsg("u1", longText)]);
		const settings = { ...BASE_SETTINGS, maxEntryChars: 300 };
		const out = buildTranscript({ sessionManager: sm, settings, action: NOOP_ACTION });
		expect(out).toContain("HEAD");
		expect(out).toContain("TAIL");
		expect(out).toMatch(/truncated \d+ chars/);
	});
});

describe("buildTranscript: total cap", () => {
	it("never exceeds maxTranscriptTotalChars", () => {
		const entries: FakeEntry[] = [];
		for (let i = 0; i < 200; i++) {
			entries.push(userMsg(`m${i}`, "x".repeat(500)));
		}
		const settings = { ...BASE_SETTINGS, maxTranscriptTotalChars: 5_000, maxEntryChars: 1_000, maxTranscriptEntries: 50 };
		const out = buildTranscript({ sessionManager: fakeSessionManager(entries), settings, action: NOOP_ACTION });
		expect(out.length).toBeLessThanOrEqual(5_000);
	});
});

describe("buildTranscript: skipped-count marker", () => {
	it("notes when older entries are dropped without being pinned", () => {
		const entries: FakeEntry[] = [];
		for (let i = 0; i < 50; i++) {
			entries.push(userMsg(`m${i}`, `m${i}`));
		}
		const settings = { ...BASE_SETTINGS, maxTranscriptEntries: 5, maxPinnedRelatedEntries: 0 };
		const out = buildTranscript({ sessionManager: fakeSessionManager(entries), settings, action: NOOP_ACTION });
		expect(out).toMatch(/45 older entries omitted/);
	});
});
