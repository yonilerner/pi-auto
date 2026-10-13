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

export interface AndOrCommandSegment {
	/** Source text for this top-level AND/OR segment. */
	source: string;
	/** Operator that connects the previous segment to this one. Undefined for the first segment. */
	operatorBefore?: "&&" | "||";
	/** Plain argv for simple word-only command segments; null for compound/unsupported segment syntax. */
	argv: string[] | null;
}

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

/**
 * Split a shell script on top-level `&&` / `||` operators only.
 *
 * This is deliberately narrower than `tryParseWordOnlyCommandsSequence`: it
 * preserves each segment's source text so callers can execute segments through
 * different routes, while refusing semicolons/pipelines/backgrounding at this
 * routing layer. Nested shell syntax is kept inside a segment; callers decide
 * whether that segment is acceptable for their route.
 */
export function parseTopLevelAndOrCommandSequence(script: string): AndOrCommandSegment[] | null {
	const tree = tryParseShell(script);
	if (!tree || tree.rootNode.hasError) return null;

	const root = tree.rootNode;
	const container =
		root.namedChildren.length === 1 && root.namedChildren[0]?.type === "list"
			? root.namedChildren[0]
			: root;
	const parsed = parseAndOrContainer(container, script);
	if (!parsed || parsed.segments.length === 0) return null;
	return parsed.sawAndOr ? parsed.segments : null;
}

function parseAndOrContainer(
	container: Node,
	script: string,
): { segments: AndOrCommandSegment[]; sawAndOr: boolean } | null {
	const segments: AndOrCommandSegment[] = [];
	let pendingOperator: "&&" | "||" | undefined;
	let expectSegment = true;
	let sawAndOr = false;

	for (const child of container.children) {
		if (child.isNamed) {
			if (!expectSegment) return null;
			let childSegments: AndOrCommandSegment[];
			if (child.type === "list") {
				const nested = parseAndOrContainer(child, script);
				if (!nested) return null;
				childSegments = nested.segments;
				sawAndOr = sawAndOr || nested.sawAndOr;
			} else {
				childSegments = [
					{
						source: script.slice(child.startIndex, child.endIndex),
						argv: child.type === "command" ? parsePlainCommandFromNode(child, script) : null,
					},
				];
			}
			if (childSegments.length === 0) return null;
			segments.push({ ...childSegments[0], operatorBefore: pendingOperator }, ...childSegments.slice(1));
			pendingOperator = undefined;
			expectSegment = false;
			continue;
		}

		const token = child.type.trim();
		if (token.length === 0) continue;
		if (token === "&&" || token === "||") {
			if (expectSegment) return null;
			pendingOperator = token;
			expectSegment = true;
			sawAndOr = true;
			continue;
		}

		// Semicolons, pipes, backgrounding, redirects at this level are not part
		// of the prototype route. They continue through the older all-or-nothing
		// review-only matcher.
		return null;
	}

	if (pendingOperator || expectSegment || segments.length === 0) return null;
	return { segments, sawAndOr };
}

/**
 * Best-effort extraction of static argv prefixes from every command node in a
 * shell script, even when the script uses syntax rejected by the strict
 * word-only parser. This is intentionally NOT an allow/safety classifier; it
 * exists so routing rules can detect "this looks like a configured command,
 * but the syntax is unsupported for that route" and fail with a targeted
 * repair message instead of silently taking another execution path.
 */
export function parseLooseCommandArgvPrefixes(script: string): string[][] {
	const tree = tryParseShell(script);
	if (!tree) return [];
	const commandNodes: Node[] = [];
	const stack: Node[] = [tree.rootNode];
	while (stack.length > 0) {
		// biome-ignore lint/style/noNonNullAssertion: length-checked above
		const node = stack.pop()!;
		if (node.isNamed && node.type === "command") commandNodes.push(node);
		for (const child of node.children) stack.push(child);
	}
	commandNodes.sort((a, b) => a.startIndex - b.startIndex);
	return commandNodes.map((node) => parseLooseCommandArgvPrefix(node)).filter((argv) => argv.length > 0);
}

/** Per-command argv extraction. Mirrors `parse_plain_command_from_node`. */
function parseLooseCommandArgvPrefix(cmd: Node): string[] {
	if (cmd.type !== "command") return [];
	const argv: string[] = [];
	let sawCommandName = false;
	for (const child of cmd.namedChildren) {
		if (!sawCommandName) {
			if (child.type !== "command_name") continue;
			const wordNode = child.namedChild(0);
			if (!wordNode || wordNode.type !== "word") return [];
			argv.push(wordNode.text);
			sawCommandName = true;
			continue;
		}
		// Capture only statically visible argv words after the command name. Stop
		// at the first dynamic/unsupported node; callers only need a prefix.
		switch (child.type) {
			case "word":
			case "number":
				argv.push(child.text);
				break;
			case "string":
			case "raw_string":
				argv.push(stripShellQuotes(child.text));
				break;
			default:
				return argv;
		}
	}
	return argv;
}

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

function stripShellQuotes(raw: string): string {
	if (raw.length >= 2 && ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"')))) {
		return raw.slice(1, -1);
	}
	return raw;
}
