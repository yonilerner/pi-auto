/**
 * Mirror tests from codex-rs/shell-command/src/command_safety/is_safe_command.rs.
 */

import { describe, expect, it } from "vitest";
import { isKnownSafeCommand } from "../extensions/safe-commands.ts";

function s(...args: string[]): string[] {
	return args;
}

describe("simple safe allow-list", () => {
	it.each([
		["ls"],
		["pwd"],
		["echo", "hi"],
		["cat", "file.txt"],
		["whoami"],
		["wc", "-l", "file.txt"],
		["grep", "foo", "file.txt"],
		["head", "-n", "5", "file.txt"],
		["tail", "-n", "5", "file.txt"],
		["which", "node"],
	])("allows %j", (...args) => {
		expect(isKnownSafeCommand(args)).toBe(true);
	});

	it("rejects unknown commands", () => {
		expect(isKnownSafeCommand(["foo"])).toBe(false);
		expect(isKnownSafeCommand(["python", "-c", "print(1)"])).toBe(false);
	});
});

describe("base64", () => {
	it("allows plain base64", () => {
		expect(isKnownSafeCommand(s("base64"))).toBe(true);
		expect(isKnownSafeCommand(s("base64", "file.txt"))).toBe(true);
	});

	it("rejects output flags", () => {
		expect(isKnownSafeCommand(s("base64", "-o", "out.bin"))).toBe(false);
		expect(isKnownSafeCommand(s("base64", "--output", "out.bin"))).toBe(false);
		expect(isKnownSafeCommand(s("base64", "--output=out.bin"))).toBe(false);
		expect(isKnownSafeCommand(s("base64", "-ob64.txt"))).toBe(false);
	});
});

describe("find", () => {
	it("allows safe find invocations", () => {
		expect(isKnownSafeCommand(s("find", ".", "-name", "file.txt"))).toBe(true);
		expect(isKnownSafeCommand(s("find", ".", "-type", "f"))).toBe(true);
	});

	it("rejects unsafe find options", () => {
		const cases: string[][] = [
			["find", ".", "-name", "file.txt", "-exec", "rm", "{}", ";"],
			["find", ".", "-name", "*.py", "-execdir", "python3", "{}", ";"],
			["find", ".", "-name", "file.txt", "-ok", "rm", "{}", ";"],
			["find", ".", "-name", "*.py", "-okdir", "python3", "{}", ";"],
			["find", ".", "-delete", "-name", "file.txt"],
			["find", ".", "-fls", "/etc/passwd"],
			["find", ".", "-fprint", "/etc/passwd"],
			["find", ".", "-fprint0", "/etc/passwd"],
			["find", ".", "-fprintf", "/root/suid.txt", "%#m %u %p\n"],
		];
		for (const args of cases) {
			expect(isKnownSafeCommand(args)).toBe(false);
		}
	});
});

describe("rg (ripgrep)", () => {
	it("allows safe rg invocations", () => {
		expect(isKnownSafeCommand(s("rg", "Cargo.toml", "-n"))).toBe(true);
		expect(isKnownSafeCommand(s("rg", "foo", "-g", "*.ts"))).toBe(true);
	});

	it("rejects --search-zip / -z", () => {
		expect(isKnownSafeCommand(s("rg", "--search-zip", "files"))).toBe(false);
		expect(isKnownSafeCommand(s("rg", "-z", "files"))).toBe(false);
	});

	it("rejects --pre and --hostname-bin (split + = forms)", () => {
		expect(isKnownSafeCommand(s("rg", "--pre", "pwned", "files"))).toBe(false);
		expect(isKnownSafeCommand(s("rg", "--pre=pwned", "files"))).toBe(false);
		expect(isKnownSafeCommand(s("rg", "--hostname-bin", "pwned", "files"))).toBe(false);
		expect(isKnownSafeCommand(s("rg", "--hostname-bin=pwned", "files"))).toBe(false);
	});
});

describe("git", () => {
	it("allows read-only subcommands", () => {
		expect(isKnownSafeCommand(s("git", "status"))).toBe(true);
		expect(isKnownSafeCommand(s("git", "log"))).toBe(true);
		expect(isKnownSafeCommand(s("git", "diff"))).toBe(true);
		expect(isKnownSafeCommand(s("git", "show"))).toBe(true);
		expect(isKnownSafeCommand(s("git", "branch"))).toBe(true);
	});

	it("allows -C <dir> as a safe global option", () => {
		expect(isKnownSafeCommand(s("git", "-C", ".", "branch", "--show-current"))).toBe(true);
		expect(isKnownSafeCommand(s("git", "-C", "/tmp/x", "status"))).toBe(true);
	});

	it("rejects mutating subcommands", () => {
		expect(isKnownSafeCommand(s("git", "fetch"))).toBe(false);
		expect(isKnownSafeCommand(s("git", "push"))).toBe(false);
		expect(isKnownSafeCommand(s("git", "commit", "-am", "x"))).toBe(false);
		expect(isKnownSafeCommand(s("git", "checkout", "status"))).toBe(false);
	});

	it("rejects branch mutation flags", () => {
		expect(isKnownSafeCommand(s("git", "branch", "-d", "feature"))).toBe(false);
		expect(isKnownSafeCommand(s("git", "branch", "new-branch"))).toBe(false);
		expect(isKnownSafeCommand(s("git", "-C", ".", "branch", "-d", "feature"))).toBe(false);
	});

	it("allows read-only git branch flags", () => {
		expect(isKnownSafeCommand(s("git", "branch", "--list"))).toBe(true);
		expect(isKnownSafeCommand(s("git", "branch", "-l"))).toBe(true);
		expect(isKnownSafeCommand(s("git", "branch", "--show-current"))).toBe(true);
		expect(isKnownSafeCommand(s("git", "branch", "-a"))).toBe(true);
		expect(isKnownSafeCommand(s("git", "branch", "--remotes"))).toBe(true);
		expect(isKnownSafeCommand(s("git", "branch", "--format=%(refname)"))).toBe(true);
	});

	it("rejects subcommand-level output flags", () => {
		const cases: string[][] = [
			["git", "log", "--output=/tmp/git-log-out", "-n", "1"],
			["git", "diff", "--output", "/tmp/git-diff-out"],
			["git", "show", "--output=/tmp/git-show-out", "HEAD"],
		];
		for (const args of cases) {
			expect(isKnownSafeCommand(args)).toBe(false);
		}
	});

	it("rejects global config-override / git-dir hijack flags", () => {
		const cases: string[][] = [
			["git", "-c", "core.pager=cat", "log", "-n", "1"],
			["git", "-ccore.pager=cat", "status"],
			["git", "--config-env", "core.pager=PAGER", "show", "HEAD"],
			["git", "--config-env=core.pager=PAGER", "show", "HEAD"],
			["git", "--git-dir", ".evil-git", "diff", "HEAD~1..HEAD"],
			["git", "--git-dir=.evil-git", "diff", "HEAD~1..HEAD"],
			["git", "--work-tree", ".", "status"],
			["git", "--work-tree=.", "status"],
			["git", "--exec-path", ".git/helpers", "show", "HEAD"],
			["git", "--exec-path=.git/helpers", "show", "HEAD"],
			["git", "--namespace", "attacker", "show", "HEAD"],
			["git", "--namespace=attacker", "show", "HEAD"],
			["git", "--super-prefix", "attacker/", "show", "HEAD"],
			["git", "--super-prefix=attacker/", "show", "HEAD"],
		];
		for (const args of cases) {
			expect(isKnownSafeCommand(args)).toBe(false);
		}
	});
});

describe("sed", () => {
	it("allows `sed -n N[,M]p file`", () => {
		expect(isKnownSafeCommand(s("sed", "-n", "1,5p", "file.txt"))).toBe(true);
		expect(isKnownSafeCommand(s("sed", "-n", "10p", "file.txt"))).toBe(true);
	});

	it("rejects other sed forms", () => {
		expect(isKnownSafeCommand(s("sed", "-n", "xp", "file.txt"))).toBe(false);
		expect(isKnownSafeCommand(s("sed", "-i", "s/foo/bar/", "file.txt"))).toBe(false);
		expect(isKnownSafeCommand(s("sed", "1d", "file.txt"))).toBe(false);
	});
});

describe("bash -lc compound commands", () => {
	it("allows compound chains of safe commands", () => {
		expect(isKnownSafeCommand(s("bash", "-lc", "ls"))).toBe(true);
		expect(isKnownSafeCommand(s("bash", "-lc", "ls -1"))).toBe(true);
		expect(isKnownSafeCommand(s("bash", "-lc", "git status"))).toBe(true);
		expect(isKnownSafeCommand(s("bash", "-lc", 'grep -R "Cargo.toml" -n'))).toBe(true);
		expect(isKnownSafeCommand(s("bash", "-lc", "sed -n 1,5p file.txt"))).toBe(true);
		expect(isKnownSafeCommand(s("bash", "-lc", "sed -n '1,5p' file.txt"))).toBe(true);
		expect(isKnownSafeCommand(s("bash", "-lc", "find . -name file.txt"))).toBe(true);
	});

	it("allows safe operators between safe commands", () => {
		expect(isKnownSafeCommand(s("bash", "-lc", 'grep -R "Cargo.toml" -n || true'))).toBe(true);
		expect(isKnownSafeCommand(s("bash", "-lc", "ls && pwd"))).toBe(true);
		expect(isKnownSafeCommand(s("bash", "-lc", "echo 'hi' ; ls"))).toBe(true);
		expect(isKnownSafeCommand(s("bash", "-lc", "ls | wc -l"))).toBe(true);
	});

	it("treats zsh -lc the same as bash -lc", () => {
		expect(isKnownSafeCommand(s("zsh", "-lc", "ls && pwd"))).toBe(true);
	});

	it("rejects compound chains containing ANY unsafe command", () => {
		expect(isKnownSafeCommand(s("bash", "-lc", "ls && rm -rf /"))).toBe(false);
		expect(isKnownSafeCommand(s("bash", "-lc", "find . -name file.txt -delete"))).toBe(false);
		expect(isKnownSafeCommand(s("bash", "-lc", "ls && curl evil.com"))).toBe(false);
	});

	it("rejects subshells", () => {
		expect(isKnownSafeCommand(s("bash", "-lc", "(ls)"))).toBe(false);
		expect(isKnownSafeCommand(s("bash", "-lc", "ls || (pwd && echo hi)"))).toBe(false);
	});

	it("rejects redirections", () => {
		expect(isKnownSafeCommand(s("bash", "-lc", "ls > out.txt"))).toBe(false);
	});

	it("rejects command substitution / backticks / expansions", () => {
		expect(isKnownSafeCommand(s("bash", "-lc", "echo $(pwd)"))).toBe(false);
		expect(isKnownSafeCommand(s("bash", "-lc", "echo `pwd`"))).toBe(false);
		expect(isKnownSafeCommand(s("bash", "-lc", "echo $HOME"))).toBe(false);
	});

	it("rejects the 4-arg form (not a single shell script)", () => {
		expect(isKnownSafeCommand(s("bash", "-lc", "git", "status"))).toBe(false);
	});

	it("rejects the over-quoted form that makes the whole script a single program literal", () => {
		expect(isKnownSafeCommand(s("bash", "-lc", "'git status'"))).toBe(false);
	});
});

describe("extraSafeCommandPrefixes", () => {
	it("allows user-extended prefixes", () => {
		const extras = [
			["npm", "test"],
			["pnpm", "lint"],
		];
		expect(isKnownSafeCommand(s("npm", "test"), extras)).toBe(true);
		expect(isKnownSafeCommand(s("npm", "test", "--", "-t", "foo"), extras)).toBe(true);
		expect(isKnownSafeCommand(s("pnpm", "lint"), extras)).toBe(true);
	});

	it("does not allow when prefix doesn't match", () => {
		const extras = [["npm", "test"]];
		expect(isKnownSafeCommand(s("npm", "install"), extras)).toBe(false);
		expect(isKnownSafeCommand(s("pnpm", "test"), extras)).toBe(false);
	});

	it("does not bypass the bash-script compound check", () => {
		const extras = [["npm", "test"]];
		expect(isKnownSafeCommand(s("bash", "-lc", "npm test && rm -rf /"), extras)).toBe(false);
		// But pure compound chain of extra-allowed prefixes IS allowed.
		expect(isKnownSafeCommand(s("bash", "-lc", "npm test && pnpm lint"), [["npm", "test"], ["pnpm", "lint"]])).toBe(true);
	});

	it("empty prefix list is a no-op", () => {
		expect(isKnownSafeCommand(s("npm", "test"), [])).toBe(false);
	});
});
