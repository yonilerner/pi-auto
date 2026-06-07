/**
 * Bash script parser for the safe-command fast path.
 *
 * Ported from Codex's `codex-rs/shell-command/src/bash.rs`. We use the same
 * `tree-sitter-bash` grammar Codex uses, so any script that parses identically
 * there parses identically here.
 *
 * Strategy:
 *   1. Parse the script with tree-sitter-bash to get an AST.
 *   2. Walk the tree. Reject any named node whose `type` is not in a small
 *      allow-list, and reject any operator/punctuation token that is not in a
 *      small allow-list. This catches subshells, redirections, command
 *      substitutions, variable expansions, control flow, herestrings, arithmetic
 *      expansion, etc. — even ones we don't explicitly enumerate.
 *   3. Extract argv from each `command` node, handling double-quoted strings,
 *      raw strings, numbers, and the `concatenation` node (e.g. `-g"*.py"`).
 *
 * Upstream reference: codex-rs/shell-command/src/bash.rs
 */

import path from "node:path";
import Parser from "tree-sitter";
import BashLanguage from "tree-sitter-bash";

// tree-sitter-bash's exported type uses `language: unknown` while tree-sitter's
// Language interface requires `language: Language`. The runtime object is
// correct — this is a known mismatch in the published .d.ts. Cast through unknown.
const Bash = BashLanguage as unknown as Parser.Language;

type Node = Parser.SyntaxNode;
type Tree = Parser.Tree;

// Tree-sitter parsers are expensive to construct — share one per process.
let cachedParser: Parser | undefined;
function getParser(): Parser {
	if (!cachedParser) {
		const p = new Parser();
		p.setLanguage(Bash);
		cachedParser = p;
	}
	return cachedParser;
}

/** Parse a bash script and return the tree-sitter Tree, or null if parsing fails. */
export function tryParseShell(script: string): Tree | null {
	try {
		return getParser().parse(script);
	} catch {
		return null;
	}
}

/** Allowed named node kinds in a "word-only command sequence". */
const ALLOWED_KINDS: ReadonlySet<string> = new Set([
	// top-level containers
	"program",
	"list",
	"pipeline",
	// commands & words
	"command",
	"command_name",
	"word",
	"string",
	"string_content",
	"raw_string",
	"number",
	"concatenation",
]);

/** Allowed punctuation / operator tokens. */
const ALLOWED_PUNCT_TOKENS: ReadonlySet<string> = new Set(["&&", "||", ";", "|", '"', "'"]);

/**
 * Walk the AST and try to extract a list of plain (word-only) commands joined
 * only by the safe operators `&&`, `||`, `;`, `|`. Returns null if the script
 * contains anything we don't recognize as safe.
 *
 * Mirrors `try_parse_word_only_commands_sequence` in upstream.
 */
export function tryParseWordOnlyCommandsSequence(tree: Tree, src: string): string[][] | null {
	if (tree.rootNode.hasError) return null;

	const commandNodes: Node[] = [];
	const stack: Node[] = [tree.rootNode];
	while (stack.length > 0) {
		// biome-ignore lint/style/noNonNullAssertion: length-checked above
		const node = stack.pop()!;
		const kind = node.type;
		if (node.isNamed) {
			if (!ALLOWED_KINDS.has(kind)) return null;
			if (kind === "command") commandNodes.push(node);
		} else {
			// Reject any unknown operator/punctuation token. Whitespace tokens
			// (which tree-sitter reports as empty/trim-empty types) are fine.
			const trimmed = kind.trim();
			const looksOperator = /[&;|]/.test(kind);
			if (looksOperator && !ALLOWED_PUNCT_TOKENS.has(kind)) return null;
			if (!ALLOWED_PUNCT_TOKENS.has(kind) && trimmed.length > 0) {
				// Anything else — parens, braces, redirects, backticks, $ — is rejected.
				return null;
			}
		}
		for (const child of node.children) stack.push(child);
	}

	// Stack walk visits nodes in reverse source order. Sort by start position to restore order.
	commandNodes.sort((a, b) => a.startIndex - b.startIndex);

	const commands: string[][] = [];
	for (const node of commandNodes) {
		const words = parsePlainCommandFromNode(node, src);
		if (!words) return null;
		commands.push(words);
	}
	return commands;
}

/** Detect `bash`/`zsh`/`sh` + `-lc`/`-c` invocations and return the script body. */
export function extractBashCommand(command: readonly string[]): { shell: string; script: string } | null {
	if (command.length !== 3) return null;
	const [shell, flag, script] = command;
	if (flag !== "-lc" && flag !== "-c") return null;
	const base = path.basename(shell);
	if (base !== "bash" && base !== "zsh" && base !== "sh") return null;
	return { shell, script };
}

/**
 * Parse `bash -lc "<script>"` (or equivalent) and return the list of plain
 * commands if the script only uses word-only commands joined by safe operators.
 */
export function parseShellLcPlainCommands(command: readonly string[]): string[][] | null {
	const extracted = extractBashCommand(command);
	if (!extracted) return null;
	const tree = tryParseShell(extracted.script);
	if (!tree) return null;
	return tryParseWordOnlyCommandsSequence(tree, extracted.script);
}

/** Per-command argv extraction. Mirrors `parse_plain_command_from_node`. */
function parsePlainCommandFromNode(cmd: Node, src: string): string[] | null {
	if (cmd.type !== "command") return null;
	const words: string[] = [];
	for (const child of cmd.namedChildren) {
		switch (child.type) {
			case "command_name": {
				const wordNode = child.namedChild(0);
				if (!wordNode || wordNode.type !== "word") return null;
				words.push(wordNode.text);
				break;
			}
			case "word":
			case "number":
				words.push(child.text);
				break;
			case "string": {
				const parsed = parseDoubleQuotedString(child, src);
				if (parsed === null) return null;
				words.push(parsed);
				break;
			}
			case "raw_string": {
				const parsed = parseRawString(child);
				if (parsed === null) return null;
				words.push(parsed);
				break;
			}
			case "concatenation": {
				let concat = "";
				for (const part of child.namedChildren) {
					switch (part.type) {
						case "word":
						case "number":
							concat += part.text;
							break;
						case "string": {
							const parsed = parseDoubleQuotedString(part, src);
							if (parsed === null) return null;
							concat += parsed;
							break;
						}
						case "raw_string": {
							const parsed = parseRawString(part);
							if (parsed === null) return null;
							concat += parsed;
							break;
						}
						default:
							return null;
					}
				}
				if (concat.length === 0) return null;
				words.push(concat);
				break;
			}
			default:
				return null;
		}
	}
	return words;
}

/** Parse a double-quoted string, rejecting any embedded expansion. */
function parseDoubleQuotedString(node: Node, _src: string): string | null {
	if (node.type !== "string") return null;
	for (const part of node.namedChildren) {
		if (part.type !== "string_content") return null;
	}
	const raw = node.text;
	if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return null;
	return raw.slice(1, -1);
}

/** Parse a single-quoted (raw) string. */
function parseRawString(node: Node): string | null {
	if (node.type !== "raw_string") return null;
	const raw = node.text;
	if (raw.length < 2 || !raw.startsWith("'") || !raw.endsWith("'")) return null;
	return raw.slice(1, -1);
}
