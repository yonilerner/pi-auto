import { describe, expect, it } from "vitest";
import { actionKeywords, scoreText } from "../extensions/retrieval.ts";
import type { ReviewableAction } from "../extensions/types.ts";

function bashAction(command: string, extra: Record<string, unknown> = {}): ReviewableAction {
	return {
		toolName: "bash",
		toolCallId: "tc-1",
		label: `bash: ${command}`,
		payload: { tool: "bash", command, cwd: "/home/me/project", ...extra },
	};
}

describe("actionKeywords", () => {
	it("filters out 'bash' as too-common (would match every bash action)", () => {
		expect(actionKeywords(bashAction("rm -rf /tmp/foo"))).not.toContain("bash");
	});

	it("includes the executable name (the meaningful part of the command)", () => {
		expect(actionKeywords(bashAction("rm -rf /tmp/foo"))).toContain("rm");
	});

	it("includes path components for filesystem actions", () => {
		const kws = actionKeywords(bashAction("rm -rf /tmp/test-data"));
		expect(kws).toContain("tmp");
		expect(kws).toContain("test-data");
	});

	it("includes the executable name for bash commands", () => {
		const kws = actionKeywords(bashAction("psql -c 'DROP TABLE customers'"));
		expect(kws).toContain("psql");
		expect(kws.some((k) => k === "drop" || k.startsWith("drop"))).toBe(true);
	});

	it("strips stopwords", () => {
		const kws = actionKeywords(bashAction("rm -rf the foo"));
		expect(kws).not.toContain("the");
	});

	it("strips short tokens", () => {
		const kws = actionKeywords(bashAction("rm a"));
		expect(kws).not.toContain("a");
	});

	it("dedupes repeated tokens", () => {
		const kws = actionKeywords(bashAction("rm /foo/bar /foo/baz /foo/qux"));
		const fooCount = kws.filter((k) => k === "foo").length;
		expect(fooCount).toBe(1);
	});

	it("walks nested payload objects", () => {
		const action: ReviewableAction = {
			toolName: "write",
			toolCallId: "tc-1",
			label: "write: /etc/hosts",
			payload: {
				tool: "write",
				path: "/etc/hosts",
				cwd: "/home/me/project",
				input: { path: "/etc/hosts", content: "127.0.0.1 localhost" },
			},
		};
		const kws = actionKeywords(action);
		expect(kws).toContain("etc");
		expect(kws).toContain("hosts");
		expect(kws).toContain("localhost");
	});

	it("splits dotted filenames into pieces", () => {
		const kws = actionKeywords(bashAction("rm /tmp/parser.test.ts"));
		expect(kws).toContain("parser");
		expect(kws).toContain("test");
	});
});

describe("scoreText", () => {
	it("scores 0 when no keywords match", () => {
		expect(scoreText("the weather is nice today", ["foo", "bar", "baz"])).toBe(0);
	});

	it("scores higher for more keyword hits", () => {
		const kws = ["delete", "tmp", "test-data"];
		const oneHit = scoreText("delete something", kws);
		const allHits = scoreText("please delete /tmp/test-data when done", kws);
		expect(allHits).toBeGreaterThan(oneHit);
	});

	it("weights later (rarer) keywords higher", () => {
		const kws = ["bash", "tmp", "test-data"]; // bash=0, tmp=1, test-data=2
		const earlyOnly = scoreText("a bash invocation", kws);
		const lateOnly = scoreText("paths under test-data", kws);
		expect(lateOnly).toBeGreaterThan(earlyOnly);
	});

	it("is case insensitive", () => {
		expect(scoreText("DELETE the FILES", ["delete", "files"])).toBeGreaterThan(0);
	});

	it("matches substring (not whole word)", () => {
		// scoreText uses includes(), so "test-data" matches "test-data-2024"
		expect(scoreText("/tmp/test-data-2024", ["test-data"])).toBeGreaterThan(0);
	});
});
