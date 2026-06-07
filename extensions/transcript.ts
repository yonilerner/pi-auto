/**
 * Build a compact, structured transcript for the reviewer.
 *
 * Designed to behave gracefully in very long (1M-token) conversations.
 *
 * Sections (each only included if the data is present):
 *   [digest]               rolling pi-auto digest of authorization-relevant facts
 *   [first user message]   anchors overall task goal
 *   [earlier summaries]    pi-generated compaction + branch summaries
 *   [earlier related]      action-keyword-matched older entries (pinned)
 *   [recent transcript]    most recent N entries (current default behavior)
 *
 * The whole thing is bounded by a hard total byte cap and per-entry head+tail
 * truncation so the reviewer never sees an unbounded transcript.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { actionKeywords, scoreText } from "./retrieval.ts";
import type { PiAutoSettings, ReviewableAction } from "./types.ts";

type ReadonlySessionManager = ExtensionContext["sessionManager"];

interface TranscriptEntry {
	role: "user" | "assistant" | "tool_call" | "tool_result";
	text: string;
	/** Stable id from the underlying session entry; used to dedupe across sections. */
	sourceId: string;
}

interface BuildOptions {
	sessionManager: ReadonlySessionManager;
	settings: PiAutoSettings;
	/** Proposed action being reviewed; used for keyword retrieval. */
	action: ReviewableAction;
	/** Current rolling digest text, if any. */
	digest?: string;
}

export function buildTranscript(opts: BuildOptions): string {
	const { sessionManager, settings, action, digest } = opts;
	const branch = sessionManager.getBranch();
	const allTranscriptEntries = collectTranscriptEntries(branch, settings.maxEntryChars);
	const summaries = collectSummaries(branch);

	// Section 1: rolling digest.
	const digestSection = digest?.trim()
		? `[digest]\n${digest.trim()}`
		: "";

	// Section 2: first user message — anchor.
	const firstUserMessage = allTranscriptEntries.find((e) => e.role === "user");

	// Section 5: recent N entries.
	const recent = allTranscriptEntries.slice(-settings.maxTranscriptEntries);
	const recentIds = new Set(recent.map((e) => e.sourceId));

	// Section 4: action-keyed retrieval over the entries NOT already in `recent`.
	const olderEntries = allTranscriptEntries.filter((e) => !recentIds.has(e.sourceId));
	const pinnedRelated = pickActionRelated(olderEntries, action, settings.maxPinnedRelatedEntries);
	const pinnedIds = new Set(pinnedRelated.map((e) => e.sourceId));

	// Section 3: summaries (compaction / branch_summary). Capped per setting.
	const renderedSummaries = summaries
		.slice(-settings.maxSummaryEntries)
		.map((s, i) => `[summary ${i + 1}/${summaries.length}] ${truncateMiddle(s, settings.maxEntryChars)}`);

	// Build skipped-count headers so the reviewer knows the gap is real.
	const omittedOlder = allTranscriptEntries.length - recent.length - pinnedRelated.length;

	const sections: string[] = [];
	if (digestSection) sections.push(digestSection);

	if (firstUserMessage && !recentIds.has(firstUserMessage.sourceId)) {
		sections.push(`[first user message]\n${renderEntry(firstUserMessage)}`);
	}

	if (renderedSummaries.length > 0) {
		sections.push(`[earlier summaries]\n${renderedSummaries.join("\n")}`);
	}

	if (omittedOlder > 0 && !pinnedRelated.length) {
		sections.push(`[earlier context]\n…${omittedOlder} older entries omitted…`);
	}

	if (pinnedRelated.length > 0) {
		const pinnedLines = pinnedRelated.map((e) => renderEntry(e));
		const note = `(pulled in because they reference parts of the proposed action)`;
		sections.push(
			`[earlier context related to this action] ${note}\n${pinnedLines.join("\n")}`,
		);
		const remainingOmitted = allTranscriptEntries.length - recent.length - pinnedRelated.length;
		if (remainingOmitted > 0) {
			sections.push(`[…${remainingOmitted} other older entries omitted…]`);
		}
	}

	if (recent.length > 0) {
		sections.push(`[recent transcript]\n${recent.map(renderEntry).join("\n")}`);
	} else if (sections.length === 0) {
		return "(no prior transcript)";
	}

	const joined = sections.join("\n\n");
	return enforceTotalCap(joined, settings.maxTranscriptTotalChars);
}

function renderEntry(e: TranscriptEntry): string {
	return `[${e.role}] ${e.text}`;
}

function collectTranscriptEntries(branch: unknown[], maxEntryChars: number): TranscriptEntry[] {
	const entries: TranscriptEntry[] = [];
	for (const entry of branch) {
		if (!entry || typeof entry !== "object") continue;
		const e = entry as { type?: string; id?: string; message?: unknown };
		if (e.type !== "message" || !e.message) continue;
		const id = e.id ?? `anon-${entries.length}`;
		const msg = e.message as {
			role?: string;
			content?: unknown;
			toolName?: string;
			isError?: boolean;
		};

		if (msg.role === "user") {
			const text = extractText(msg.content);
			if (text) entries.push({ role: "user", text: truncateMiddle(text, maxEntryChars), sourceId: id });
			continue;
		}

		if (msg.role === "assistant") {
			const text = extractText(msg.content);
			if (text) entries.push({ role: "assistant", text: truncateMiddle(text, maxEntryChars), sourceId: id });

			if (Array.isArray(msg.content)) {
				let toolCallIdx = 0;
				for (const part of msg.content) {
					if (part && typeof part === "object" && (part as { type?: string }).type === "toolCall") {
						const tc = part as { name?: string; arguments?: Record<string, unknown> };
						entries.push({
							role: "tool_call",
							text: truncateMiddle(`${tc.name ?? "?"}(${safeJson(tc.arguments ?? {})})`, maxEntryChars),
							sourceId: `${id}#tc${toolCallIdx++}`,
						});
					}
				}
			}
			continue;
		}

		if (msg.role === "toolResult") {
			const text = extractText(msg.content);
			const toolName = msg.toolName ?? "?";
			const isError = msg.isError ? " [error]" : "";
			if (text) {
				entries.push({
					role: "tool_result",
					text: truncateMiddle(`${toolName}${isError}: ${text}`, maxEntryChars),
					sourceId: id,
				});
			}
		}
	}
	return entries;
}

function collectSummaries(branch: unknown[]): string[] {
	const out: string[] = [];
	for (const entry of branch) {
		if (!entry || typeof entry !== "object") continue;
		const e = entry as { type?: string; summary?: string };
		if (e.type === "compaction" || e.type === "branch_summary") {
			if (typeof e.summary === "string" && e.summary.trim()) {
				out.push(e.summary.trim());
			}
		}
	}
	return out;
}

function pickActionRelated(
	olderEntries: TranscriptEntry[],
	action: ReviewableAction,
	maxPinned: number,
): TranscriptEntry[] {
	if (maxPinned <= 0 || olderEntries.length === 0) return [];
	const keywords = actionKeywords(action);
	if (keywords.length === 0) return [];

	const scored = olderEntries.map((e) => ({ entry: e, score: scoreText(e.text, keywords) }));
	scored.sort((a, b) => b.score - a.score);

	// Only include entries with non-trivial score (more than just the tool name).
	const minScore = 1.5;
	const picked = scored.filter((s) => s.score >= minScore).slice(0, maxPinned).map((s) => s.entry);

	// Preserve original (chronological) order in the rendered output.
	const pickedIds = new Set(picked.map((p) => p.sourceId));
	return olderEntries.filter((e) => pickedIds.has(e.sourceId));
}

/**
 * Truncate from the middle, keeping head + tail. Preferred over tail-only
 * truncation because important content (like "yes, I authorize that") often
 * lives at the END of a long user message.
 */
function truncateMiddle(s: string, n: number): string {
	if (s.length <= n) return s;
	// Reserve some space for the marker.
	const marker = `…[truncated ${s.length - n} chars]…`;
	const remaining = n - marker.length;
	if (remaining <= 20) {
		// Degenerate case — just tail-truncate.
		return `${s.slice(0, n)}…`;
	}
	const head = Math.ceil(remaining * 0.6);
	const tail = remaining - head;
	return `${s.slice(0, head)}${marker}${s.slice(s.length - tail)}`;
}

function enforceTotalCap(s: string, maxChars: number): string {
	if (s.length <= maxChars) return s;
	const marker = `\n\n[transcript truncated at ${maxChars} chars]`;
	return `${s.slice(0, maxChars - marker.length)}${marker}`;
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const p = part as { type?: string; text?: string };
		if (p.type === "text" && typeof p.text === "string") parts.push(p.text);
	}
	return parts.join("\n").trim();
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}
