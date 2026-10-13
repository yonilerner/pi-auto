import type { ContextEntry, ReviewableAction, ReviewerContext, Settings } from "./types.ts";

/** SessionManager.getBranch() preserves original messages through compaction. */
export function buildReviewerContext(
	branch: readonly unknown[],
	action: ReviewableAction,
	limits: Settings["context"],
): ReviewerContext {
	const entries = collectEntries(branch);
	const users = entries.filter((entry) => entry.role === "user");
	const latest = users.at(-1);
	const currentRequest = latest ? capEntry(latest, limits.maxEntryChars) : null;
	const olderUsers = users.filter((entry) => entry !== latest);
	const keywords = `${action.toolName} ${JSON.stringify(action.input)}`.toLowerCase().match(/[a-z0-9_./-]{4,}/g) ?? [];
	const pinned = olderUsers
		.map((entry, index) => {
			const text = entry.text.toLowerCase();
			const restriction = /\b(never|must|only|always|permission|approve|deny|revoke)\b|do not|don't/.test(text);
			const related = keywords.reduce((sum, keyword) => sum + Number(text.includes(keyword)), 0);
			return { entry, index, score: (restriction ? 1000 : 0) + related * 10 + index / Math.max(1, users.length) };
		})
		.sort((a, b) => b.score - a.score)
		.slice(0, limits.maxPinnedMessages);
	// Include recent user messages first, then constraints and the original goal.
	const selected = new Map<string, ContextEntry>();
	for (const { entry } of pinned) selected.set(entry.id, entry);
	for (const entry of olderUsers.slice(-limits.maxEntries).reverse()) selected.set(entry.id, entry);
	if (olderUsers[0]) selected.set(olderUsers[0].id, olderUsers[0]);
	const userMessages = [...selected.values()].map((entry) => capEntry(entry, limits.maxEntryChars));
	const recentEvidence = entries
		.filter((entry) => entry.role !== "user")
		.slice(-limits.maxEntries)
		.map((entry) => capEntry(entry, limits.maxEntryChars));
	const context: ReviewerContext = {
		currentRequest,
		userMessages,
		recentEvidence,
		omittedEntries: entries.length - userMessages.length - recentEvidence.length - Number(Boolean(currentRequest)),
	};
	// Drop execution evidence first, then older permissions. Never drop the latest
	// user message in favor of tool output or an older grant.
	while (JSON.stringify(context).length > limits.maxTotalChars && context.recentEvidence.length) {
		context.recentEvidence.shift();
		context.omittedEntries++;
	}
	while (JSON.stringify(context).length > limits.maxTotalChars && context.userMessages.length) {
		context.userMessages.pop();
		context.omittedEntries++;
	}
	if (context.currentRequest && JSON.stringify(context).length > limits.maxTotalChars) {
		const overhead = JSON.stringify({ ...context, currentRequest: { ...context.currentRequest, text: "", truncated: true } }).length;
		context.currentRequest = capEntry(context.currentRequest, Math.max(0, limits.maxTotalChars - overhead));
		// Escaping can expand source characters. Reduce until the serialized
		// representation also satisfies the budget.
		while (JSON.stringify(context).length > limits.maxTotalChars && context.currentRequest.text.length) {
			context.currentRequest = capEntry(context.currentRequest, Math.floor(context.currentRequest.text.length * 0.8));
		}
	}
	context.userMessages.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
	return context;
}

function collectEntries(branch: readonly unknown[]): ContextEntry[] {
	const result: ContextEntry[] = [];
	for (const raw of branch) {
		if (!raw || typeof raw !== "object") continue;
		const entry = raw as { type?: string; id?: string; message?: unknown };
		if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
		const message = entry.message as { role?: string; content?: unknown; toolName?: string };
		const id = entry.id ?? `entry-${result.length}`;
		const text = extractText(message.content);
		if (message.role === "user" && text) result.push({ id, role: "user", text });
		if (message.role === "assistant") {
			if (text) result.push({ id, role: "assistant", text });
			if (Array.isArray(message.content)) {
				message.content.forEach((part, index) => {
					if (!part || typeof part !== "object" || part.type !== "toolCall") return;
					result.push({ id: `${id}/tool-${index}`, role: "tool_call", toolName: String(part.name ?? ""), text: JSON.stringify(part.arguments ?? {}) });
				});
			}
		}
		if (message.role === "toolResult" && text) result.push({ id, role: "tool_result", toolName: message.toolName, text });
	}
	return result.map((entry, sequence) => ({ ...entry, sequence }));
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((part) => part && part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
}

function capEntry(entry: ContextEntry, maxChars: number): ContextEntry {
	if (entry.text.length <= maxChars) return { ...entry };
	const head = Math.floor(maxChars / 2);
	const tail = maxChars - head;
	return { ...entry, text: entry.text.slice(0, head) + (tail ? entry.text.slice(-tail) : ""), truncated: true };
}
