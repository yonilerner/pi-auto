/**
 * Mirror tests from codex-rs/shell-command/src/bash.rs.
 *
 * Each Codex test is reproduced here so the upstream-sync script can spot
 * divergence if Codex updates their behavior.
 */

import { describe, expect, it } from "vitest";
import {
	parseShellLcPlainCommands,
	parseTopLevelAndOrCommandSequence,
	tryParseShell,
	tryParseWordOnlyCommandsSequence,
} from "../extensions/bash-parser.ts";

function parseSeq(src: string): string[][] | null {
	const tree = tryParseShell(src);
	if (!tree) return null;
	return tryParseWordOnlyCommandsSequence(tree, src);
}

describe("tryParseWordOnlyCommandsSequence: accepted forms", () => {
	it("accepts a single simple command", () => {
		expect(parseSeq("ls -1")).toEqual([["ls", "-1"]]);
	});

	it("accepts multiple commands joined by allowed operators (&&, ;, |)", () => {
		expect(parseSeq("ls && pwd; echo 'hi there' | wc -l")).toEqual([["ls"], ["pwd"], ["echo", "hi there"], ["wc", "-l"]]);
	});

	it("extracts double- and single-quoted strings", () => {
		expect(parseSeq('echo "hello world"')).toEqual([["echo", "hello world"]]);
		expect(parseSeq("echo 'hi there'")).toEqual([["echo", "hi there"]]);
	});

	it("accepts double-quoted strings with literal newlines", () => {
		expect(parseSeq('git commit -m "line1\nline2"')).toEqual([["git", "commit", "-m", "line1\nline2"]]);
	});

	it("accepts mixed-quote concatenation", () => {
		expect(parseSeq(`echo "/usr"'/'"local"/bin`)).toEqual([["echo", "/usr/local/bin"]]);
		expect(parseSeq(`echo '/usr'"/"'local'/bin`)).toEqual([["echo", "/usr/local/bin"]]);
	});

	it("accepts numbers as words", () => {
		expect(parseSeq("echo 123 456")).toEqual([["echo", "123", "456"]]);
	});

	it("accepts concatenated flag and value (e.g. -g\"*.py\")", () => {
		expect(parseSeq('rg -n "foo" -g"*.py"')).toEqual([["rg", "-n", "foo", "-g*.py"]]);
	});

	it("accepts concatenated flag with single quotes", () => {
		expect(parseSeq("grep -n 'pattern' -g'*.txt'")).toEqual([["grep", "-n", "pattern", "-g*.txt"]]);
	});
});

describe("tryParseWordOnlyCommandsSequence: rejected forms", () => {
	it("rejects double-quoted strings with variable expansions", () => {
		expect(parseSeq('echo "hi ${USER}"')).toBeNull();
		expect(parseSeq('echo "$HOME"')).toBeNull();
	});

	it("rejects parentheses and subshells", () => {
		expect(parseSeq("(ls)")).toBeNull();
		expect(parseSeq("ls || (pwd && echo hi)")).toBeNull();
	});

	it("rejects redirections", () => {
		expect(parseSeq("ls > out.txt")).toBeNull();
		expect(parseSeq("echo hi & echo bye")).toBeNull();
	});

	it("rejects command substitution, process substitution, and expansions", () => {
		expect(parseSeq("echo $(pwd)")).toBeNull();
		expect(parseSeq("echo `pwd`")).toBeNull();
		expect(parseSeq("echo $HOME")).toBeNull();
		expect(parseSeq('echo "hi $USER"')).toBeNull();
	});

	it("rejects variable assignment prefix", () => {
		expect(parseSeq("FOO=bar ls")).toBeNull();
	});

	it("rejects trailing operator parse error", () => {
		expect(parseSeq("ls &&")).toBeNull();
	});

	it("rejects empty command at start", () => {
		expect(parseSeq("&& ls")).toBeNull();
	});

	it("rejects double separator", () => {
		expect(parseSeq("ls ;; pwd")).toBeNull();
	});

	it("rejects empty pipeline segment", () => {
		expect(parseSeq("ls | | wc")).toBeNull();
	});

	it("rejects concatenation with variable substitution", () => {
		expect(parseSeq('rg -g"$VAR" pattern')).toBeNull();
		expect(parseSeq('rg -g"${VAR}" pattern')).toBeNull();
	});

	it("rejects concatenation with command substitution", () => {
		expect(parseSeq('rg -g"$(pwd)" pattern')).toBeNull();
		expect(parseSeq(`rg -g"$(echo '*.py')" pattern`)).toBeNull();
	});
});

describe("parseTopLevelAndOrCommandSequence", () => {
	it("splits top-level AND/OR segments and preserves operators/source", () => {
		expect(parseTopLevelAndOrCommandSequence("gh auth status && ./script.sh || echo fallback")).toEqual([
			{ source: "gh auth status", operatorBefore: undefined, argv: ["gh", "auth", "status"] },
			{ source: "./script.sh", operatorBefore: "&&", argv: ["./script.sh"] },
			{ source: "echo fallback", operatorBefore: "||", argv: ["echo", "fallback"] },
		]);
	});

	it("keeps nested control flow inside a segment", () => {
		expect(parseTopLevelAndOrCommandSequence("if true; then echo hi; fi && gh auth status")).toEqual([
			{ source: "if true; then echo hi; fi", operatorBefore: undefined, argv: null },
			{ source: "gh auth status", operatorBefore: "&&", argv: ["gh", "auth", "status"] },
		]);
	});

	it("does not split semicolon or pipeline lists", () => {
		expect(parseTopLevelAndOrCommandSequence("gh auth status; echo hi")).toBeNull();
		expect(parseTopLevelAndOrCommandSequence("gh auth status | cat")).toBeNull();
	});
});

describe("parseShellLcPlainCommands", () => {
	it("parses zsh -lc plain commands", () => {
		expect(parseShellLcPlainCommands(["zsh", "-lc", "ls"])).toEqual([["ls"]]);
	});

	it("parses bash -lc plain commands", () => {
		expect(parseShellLcPlainCommands(["bash", "-lc", "ls && pwd"])).toEqual([["ls"], ["pwd"]]);
	});

	it("parses sh -c plain commands", () => {
		expect(parseShellLcPlainCommands(["sh", "-c", "echo hi"])).toEqual([["echo", "hi"]]);
	});

	it("returns null for non-shell invocations", () => {
		expect(parseShellLcPlainCommands(["python", "-c", "print(1)"])).toBeNull();
		expect(parseShellLcPlainCommands(["ls"])).toBeNull();
	});

	it("returns null for the 4-arg form (`bash -lc git status` not `bash -lc 'git status'`)", () => {
		expect(parseShellLcPlainCommands(["bash", "-lc", "git", "status"])).toBeNull();
	});

	it("returns null when the script contains anything unsafe", () => {
		expect(parseShellLcPlainCommands(["bash", "-lc", "ls > out.txt"])).toBeNull();
		expect(parseShellLcPlainCommands(["bash", "-lc", "ls && (rm -rf /)"])).toBeNull();
	});
});
