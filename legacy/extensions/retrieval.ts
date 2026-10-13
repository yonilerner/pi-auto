/**
 * Action-keyed retrieval: given a proposed action, find prior transcript
 * entries that are likely to provide authorization context for it.
 *
 * Pure keyword-overlap scoring. Cheap, deterministic, no LLM. Won't catch
 * semantic authorization like "go ahead with the cleanup" → `rm -rf`, but it
 * reliably surfaces exact-string proof like "delete /tmp/test-data" when the
 * action is `rm -rf /tmp/test-data`.
 *
 * Used together with the rolling digest (which DOES handle semantics) — the
 * two complement each other.
 */

import type { ReviewableAction } from "./types.ts";

/** Words too common to be useful signal. */
const STOPWORDS: ReadonlySet<string> = new Set([
	"the", "and", "for", "with", "from", "into", "but", "not", "you", "your", "this", "that",
	"will", "can", "may", "are", "was", "were", "has", "have", "had", "all", "any", "some",
	"out", "use", "new", "now", "one", "two", "get", "got", "let", "set", "see", "yes", "no",
	"please", "thanks", "thank", "ok", "okay", "sure", "going", "also", "just", "really",
	"i", "a", "an", "is", "be", "to", "in", "of", "on", "at", "it", "my", "me", "we", "or",
	"if", "so", "do", "go", "up", "by",
	// extremely common shell-ish words that don't help us localize context
	"bash", "shell", "command", "run", "running", "exec",
]);

const MIN_KEYWORD_LEN = 2;
const MAX_KEYWORDS = 24;

/**
 * Extract keyword tokens from a proposed action.
 *
 * Tries to capture: tool name, executable name(s), path components (each split
 * piece), CLI subcommands, filenames. Lowercased and deduped.
 */
export function actionKeywords(action: ReviewableAction): string[] {
	const tokens: string[] = [];

	tokens.push(action.toolName.toLowerCase());

	// Walk the payload looking for strings.
	const visit = (v: unknown, depth: number): void => {
		if (depth > 4) return;
		if (typeof v === "string") {
			tokens.push(...tokenizeString(v));
		} else if (Array.isArray(v)) {
			for (const item of v) visit(item, depth + 1);
		} else if (v && typeof v === "object") {
			for (const inner of Object.values(v)) visit(inner, depth + 1);
		}
	};
	visit(action.payload, 0);

	// Dedupe + filter, preserving order so most-important tokens (tool/cmd/path
	// from action root) sort earlier.
	const seen = new Set<string>();
	const out: string[] = [];
	for (const t of tokens) {
		if (t.length < MIN_KEYWORD_LEN) continue;
		if (STOPWORDS.has(t)) continue;
		if (seen.has(t)) continue;
		seen.add(t);
		out.push(t);
		if (out.length >= MAX_KEYWORDS) break;
	}
	return out;
}

function tokenizeString(s: string): string[] {
	// Split on whitespace, path separators, shell metachars, and most punctuation.
	// Keep dots/dashes inside file names by leaving them in until a second pass.
	const parts = s.split(/[\s/\\|&;<>(){}\[\]"'`$=,:!?*]+/);
	const out: string[] = [];
	for (const part of parts) {
		if (!part) continue;
		const lower = part.toLowerCase();
		out.push(lower);
		// Also push the dot-split pieces ("parser.test.ts" → "parser", "test", "ts").
		// Helps when a later mention spells the same name differently.
		if (lower.includes(".")) {
			for (const piece of lower.split(".")) {
				if (piece) out.push(piece);
			}
		}
		// Strip leading - / -- (common CLI flags).
		const stripped = lower.replace(/^-+/, "");
		if (stripped && stripped !== lower) out.push(stripped);
	}
	return out;
}

/**
 * Score: number of distinct keywords from the action that appear in the text.
 *
 * Bonus for hits on rarer (later-in-list) keywords so a match on a specific
 * path beats a match on "git" or "rm".
 */
export function scoreText(text: string, keywords: readonly string[]): number {
	if (!text || keywords.length === 0) return 0;
	const lower = text.toLowerCase();
	let score = 0;
	keywords.forEach((kw, idx) => {
		if (lower.includes(kw)) {
			// Rarer keywords (later in the list) get higher weight.
			const weight = 1 + idx / keywords.length;
			score += weight;
		}
	});
	return score;
}
