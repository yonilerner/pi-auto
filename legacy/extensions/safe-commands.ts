/**
 * Known-safe command classifier.
 *
 * Ported from Codex's `codex-rs/shell-command/src/command_safety/is_safe_command.rs`.
 *
 * Two layers:
 *   1. Curated allow-list of "obviously safe" executables (ls, pwd, echo, …) plus
 *      per-command flag rules for commands that have unsafe flags (find -exec,
 *      rg --pre, git --output=, base64 -o, etc.).
 *   2. For `bash -lc "<script>"` (and zsh/sh), parse the script with
 *      tree-sitter-bash, ensure it's only word-only commands joined by
 *      `&&`, `||`, `;`, `|`, and check that EACH command in the chain is itself
 *      safe.
 *
 * One command anywhere in a compound script that isn't safe → the whole thing
 * is not safe. Same as upstream.
 */

import path from "node:path";
import { parseShellLcPlainCommands } from "./bash-parser.ts";

/**
 * Public entry point. Returns true iff `command` (argv-style, e.g.
 * `["bash", "-lc", "ls && pwd"]`) is provably safe to run without review.
 *
 * `extraPrefixes` lets the user extend the allow-list with their own prefixes,
 * e.g. `[["npm", "test"], ["pnpm", "lint"]]`. A prefix matches if it is a
 * proper sequence-prefix of the argv (after substituting `zsh` → `bash` in the
 * first slot, to match upstream behavior).
 */
export function isKnownSafeCommand(
	command: readonly string[],
	extraPrefixes: readonly (readonly string[])[] = [],
): boolean {
	if (command.length === 0) return false;

	const normalized: string[] = command.map((arg, i) => (i === 0 && arg === "zsh" ? "bash" : arg));

	if (matchesAnyExtraPrefix(normalized, extraPrefixes)) return true;

	if (isSafeToCallWithExec(normalized)) return true;

	// `bash -lc "<script>"` / `zsh -lc ...` / `sh -c ...` form: try to parse the
	// script and check each inner command independently. Each inner command can
	// be safe either via the built-in classifier or via the user's extra prefixes.
	const inner = parseShellLcPlainCommands(normalized);
	if (
		inner !== null &&
		inner.length > 0 &&
		inner.every((cmd) => isSafeToCallWithExec(cmd) || matchesAnyExtraPrefix(cmd, extraPrefixes))
	) {
		return true;
	}

	return false;
}

/** Per-argv check, no compound-command handling. Mirrors `is_safe_to_call_with_exec`. */
function isSafeToCallWithExec(command: readonly string[]): boolean {
	const cmd0 = command[0];
	if (!cmd0) return false;

	const key = executableNameLookupKey(cmd0);
	if (!key) return false;

	if (SIMPLE_SAFE.has(key)) return true;

	switch (key) {
		case "base64":
			return isSafeBase64(command);
		case "find":
			return isSafeFind(command);
		case "rg":
			return isSafeRipgrep(command);
		case "git":
			return isSafeGit(command);
		case "sed":
			return isSafeSed(command);
		default:
			return false;
	}
}

/** Lookup key for an executable: just the basename. */
function executableNameLookupKey(cmd0: string): string | null {
	const base = path.basename(cmd0);
	if (!base) return null;
	return base;
}

/** Simple read-only / pure-stdout commands. Direct port of upstream allow-list. */
const SIMPLE_SAFE: ReadonlySet<string> = new Set([
	"cat",
	"cd",
	"cut",
	"echo",
	"expr",
	"false",
	"grep",
	"head",
	"id",
	"ls",
	"nl",
	"paste",
	"pwd",
	"rev",
	"seq",
	"stat",
	"tail",
	"tr",
	"true",
	"uname",
	"uniq",
	"wc",
	"which",
	"whoami",
]);

// ───────────────────────── base64 ─────────────────────────

const UNSAFE_BASE64_OPTIONS: ReadonlySet<string> = new Set(["-o", "--output"]);

function isSafeBase64(command: readonly string[]): boolean {
	for (let i = 1; i < command.length; i++) {
		const arg = command[i];
		if (UNSAFE_BASE64_OPTIONS.has(arg)) return false;
		if (arg.startsWith("--output=")) return false;
		// `-oFILE` shortcut (not the standalone `-o`)
		if (arg.startsWith("-o") && arg !== "-o") return false;
	}
	return true;
}

// ───────────────────────── find ─────────────────────────

const UNSAFE_FIND_OPTIONS: ReadonlySet<string> = new Set([
	// Options that can execute arbitrary commands.
	"-exec",
	"-execdir",
	"-ok",
	"-okdir",
	// Option that deletes matching files.
	"-delete",
	// Options that write pathnames to a file.
	"-fls",
	"-fprint",
	"-fprint0",
	"-fprintf",
]);

function isSafeFind(command: readonly string[]): boolean {
	for (let i = 1; i < command.length; i++) {
		if (UNSAFE_FIND_OPTIONS.has(command[i])) return false;
	}
	return true;
}

// ───────────────────────── rg (ripgrep) ─────────────────────────

const UNSAFE_RG_OPTIONS_WITHOUT_ARGS: ReadonlySet<string> = new Set([
	// Calls out to other decompression tools.
	"--search-zip",
	"-z",
]);

const UNSAFE_RG_OPTIONS_WITH_ARGS: ReadonlySet<string> = new Set([
	// Takes an arbitrary command that is executed for each match.
	"--pre",
	// Takes a command that can be used to obtain the local hostname.
	"--hostname-bin",
]);

function isSafeRipgrep(command: readonly string[]): boolean {
	for (let i = 1; i < command.length; i++) {
		const arg = command[i];
		if (UNSAFE_RG_OPTIONS_WITHOUT_ARGS.has(arg)) return false;
		if (UNSAFE_RG_OPTIONS_WITH_ARGS.has(arg)) return false;
		for (const opt of UNSAFE_RG_OPTIONS_WITH_ARGS) {
			if (arg.startsWith(`${opt}=`)) return false;
		}
	}
	return true;
}

// ───────────────────────── git ─────────────────────────

const GIT_READONLY_SUBCOMMANDS: ReadonlySet<string> = new Set(["status", "log", "diff", "show", "branch"]);

/**
 * Global git options that can override config / hijack helpers and therefore
 * make any subcommand unsafe. Mirrors `git_global_option_requires_prompt`.
 *
 * Note: `-C <dir>` is treated as safe — it only changes the working directory.
 * `-c key=value` IS unsafe — it overrides config (pagers, helpers, etc.).
 */
function gitGlobalOptionRequiresPrompt(arg: string): boolean {
	// `-c` (separate value) and `-c<config>` (concat form) — both unsafe.
	if (arg === "-c") return true;
	if (arg.startsWith("-c") && !arg.startsWith("-c-") && arg.length > 2 && !arg.startsWith("-C")) {
		// e.g. `-ccore.pager=cat`
		return true;
	}
	const UNSAFE_LONG: readonly string[] = [
		"--config",
		"--config-env",
		"--exec-path",
		"--git-dir",
		"--work-tree",
		"--namespace",
		"--super-prefix",
	];
	for (const opt of UNSAFE_LONG) {
		if (arg === opt || arg.startsWith(`${opt}=`)) return true;
	}
	return false;
}

/** Options that take a separate value argument (and so consume the next token). */
function gitGlobalOptionTakesSeparateValue(arg: string): boolean {
	return (
		arg === "-C" || arg === "-c" || arg === "--git-dir" || arg === "--work-tree" || arg === "--exec-path" || arg === "--namespace" || arg === "--super-prefix" || arg === "--config" || arg === "--config-env"
	);
}

function isSafeGit(command: readonly string[]): boolean {
	// 1. Check for any unsafe global option anywhere in the argv.
	for (let i = 1; i < command.length; i++) {
		if (gitGlobalOptionRequiresPrompt(command[i])) return false;
	}

	// 2. Find the subcommand, skipping safe global options.
	const found = findGitSubcommand(command);
	if (!found) return false;
	const subcommandArgs = command.slice(found.index + 1);

	// 3. Subcommand-level flag rules.
	if (!gitSubcommandArgsAreReadOnly(subcommandArgs)) return false;

	if (found.subcommand === "branch") {
		if (!gitBranchIsReadOnly(subcommandArgs)) return false;
	}
	return true;
}

function findGitSubcommand(command: readonly string[]): { index: number; subcommand: string } | null {
	let i = 1;
	while (i < command.length) {
		const arg = command[i];
		// Skip safe global options that take a value (e.g. `-C dir`).
		if (gitGlobalOptionTakesSeparateValue(arg)) {
			i += 2;
			continue;
		}
		// `-C<dir>` concatenated form.
		if (arg.startsWith("-C") && arg !== "-C") {
			i += 1;
			continue;
		}
		// `--<long>=value` form.
		if (arg.startsWith("--") && arg.includes("=")) {
			i += 1;
			continue;
		}
		// Other dash-prefixed options.
		if (arg.startsWith("-") && arg !== "-") {
			i += 1;
			continue;
		}
		// First non-option token is the subcommand.
		if (GIT_READONLY_SUBCOMMANDS.has(arg)) {
			return { index: i, subcommand: arg };
		}
		return null;
	}
	return null;
}

const UNSAFE_GIT_FLAGS: ReadonlySet<string> = new Set(["--output", "--ext-diff", "--textconv", "--exec", "--paginate"]);

function gitSubcommandArgsAreReadOnly(args: readonly string[]): boolean {
	for (const arg of args) {
		if (UNSAFE_GIT_FLAGS.has(arg)) return false;
		if (arg.startsWith("--output=")) return false;
		if (arg.startsWith("--exec=")) return false;
	}
	return true;
}

const GIT_BRANCH_READONLY_FLAGS: ReadonlySet<string> = new Set([
	"--list",
	"-l",
	"--show-current",
	"-a",
	"--all",
	"-r",
	"--remotes",
	"-v",
	"-vv",
	"--verbose",
]);

function gitBranchIsReadOnly(branchArgs: readonly string[]): boolean {
	if (branchArgs.length === 0) return true; // `git branch` lists branches.
	let sawReadonlyFlag = false;
	for (const arg of branchArgs) {
		if (GIT_BRANCH_READONLY_FLAGS.has(arg)) {
			sawReadonlyFlag = true;
			continue;
		}
		if (arg.startsWith("--format=")) {
			sawReadonlyFlag = true;
			continue;
		}
		// Any other flag or positional argument may create/rename/delete branches.
		return false;
	}
	return sawReadonlyFlag;
}

// ───────────────────────── sed ─────────────────────────

/** Allow only `sed -n {N|N,M}p [file]`. */
function isSafeSed(command: readonly string[]): boolean {
	if (command.length > 4) return false;
	if (command[1] !== "-n") return false;
	if (!isValidSedNArg(command[2])) return false;
	return true;
}

/** Matches /^(\d+,)?\d+p$/ */
function isValidSedNArg(arg: string | undefined): boolean {
	if (!arg) return false;
	if (!arg.endsWith("p")) return false;
	const core = arg.slice(0, -1);
	const parts = core.split(",");
	if (parts.length === 1) {
		const n = parts[0];
		return n.length > 0 && /^\d+$/.test(n);
	}
	if (parts.length === 2) {
		const [a, b] = parts;
		return a.length > 0 && b.length > 0 && /^\d+$/.test(a) && /^\d+$/.test(b);
	}
	return false;
}

// ───────────────────────── extra prefixes ─────────────────────────

function matchesAnyExtraPrefix(command: readonly string[], extras: readonly (readonly string[])[]): boolean {
	for (const prefix of extras) {
		if (prefix.length === 0) continue;
		if (prefix.length > command.length) continue;
		let ok = true;
		for (let i = 0; i < prefix.length; i++) {
			if (prefix[i] !== command[i]) {
				ok = false;
				break;
			}
		}
		if (ok) return true;
	}
	return false;
}
