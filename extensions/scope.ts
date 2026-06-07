/**
 * Decide whether a given tool call needs to be reviewed at all.
 *
 * Rules (configured by user):
 *  - bash:                              always review
 *  - write / edit:                      review only if target path is outside cwd
 *  - read:                              review only if outside cwd OR matches a sensitive-path heuristic
 *  - grep / find / ls:                  never review (skip)
 *  - everything else (custom / MCP):    always review
 */

import * as path from "node:path";
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import type { PiAutoSettings, ReviewableAction } from "./types.ts";

/** Tools we never review under any circumstances. */
const NEVER_REVIEW: ReadonlySet<string> = new Set(["grep", "find", "ls"]);

export type ScopeDecision =
	| { review: false; reason: string }
	| { review: true; action: ReviewableAction };

export function decideScope(event: ToolCallEvent, cwd: string, settings: PiAutoSettings): ScopeDecision {
	const { toolName } = event;

	if (NEVER_REVIEW.has(toolName)) {
		return { review: false, reason: `${toolName} is always-skipped` };
	}

	if (toolName === "bash") {
		const command = (event.input as { command?: unknown }).command;
		return {
			review: true,
			action: {
				toolName,
				toolCallId: event.toolCallId,
				label: `bash: ${truncate(String(command ?? ""), 200)}`,
				payload: {
					tool: "bash",
					command: command ?? null,
					cwd,
				},
			},
		};
	}

	if (toolName === "write" || toolName === "edit") {
		const filePath = extractPath(event.input);
		if (filePath && isInsideCwd(filePath, cwd)) {
			return { review: false, reason: `${toolName} inside cwd` };
		}
		return {
			review: true,
			action: {
				toolName,
				toolCallId: event.toolCallId,
				label: `${toolName}: ${filePath ?? "<unknown path>"}`,
				payload: {
					tool: toolName,
					path: filePath ?? null,
					cwd,
					outsideCwd: true,
					input: redactLargeFields(event.input),
				},
			},
		};
	}

	if (toolName === "read") {
		const filePath = extractPath(event.input);
		const insideCwd = filePath ? isInsideCwd(filePath, cwd) : false;
		const sensitive = filePath ? isSensitivePath(filePath, settings.sensitivePathPatterns) : false;
		if (insideCwd && !sensitive) {
			return { review: false, reason: "read inside cwd, not sensitive" };
		}
		return {
			review: true,
			action: {
				toolName,
				toolCallId: event.toolCallId,
				label: `read: ${filePath ?? "<unknown path>"}`,
				payload: {
					tool: "read",
					path: filePath ?? null,
					cwd,
					outsideCwd: !insideCwd,
					sensitivePathMatch: sensitive,
					input: event.input,
				},
			},
		};
	}

	// Custom / MCP tools: always review. We don't know what they do.
	return {
		review: true,
		action: {
			toolName,
			toolCallId: event.toolCallId,
			label: `${toolName}: ${truncate(safeJson(event.input), 200)}`,
			payload: {
				tool: toolName,
				custom: true,
				cwd,
				input: redactLargeFields(event.input),
			},
		},
	};
}

function extractPath(input: Record<string, unknown>): string | undefined {
	const p = input.path ?? input.file ?? input.filename;
	return typeof p === "string" ? p : undefined;
}

function isInsideCwd(target: string, cwd: string): boolean {
	const resolvedTarget = path.resolve(cwd, target);
	const resolvedCwd = path.resolve(cwd);
	const rel = path.relative(resolvedCwd, resolvedTarget);
	if (rel === "") return true;
	return !rel.startsWith("..") && !path.isAbsolute(rel);
}

function isSensitivePath(target: string, patterns: readonly string[]): boolean {
	const home = process.env.HOME ?? "";
	const expanded = target.startsWith("~/") && home ? path.join(home, target.slice(2)) : target;
	const lower = expanded.toLowerCase();
	for (const pat of patterns) {
		const expandedPat = pat.startsWith("~/") && home ? path.join(home, pat.slice(2)) : pat;
		if (lower.includes(expandedPat.toLowerCase())) return true;
	}
	return false;
}

function truncate(s: string, n: number): string {
	if (s.length <= n) return s;
	return `${s.slice(0, n)}…`;
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function redactLargeFields(input: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(input)) {
		if (typeof v === "string" && v.length > 2000) {
			out[k] = `${v.slice(0, 1000)}…[truncated ${v.length - 1000} chars]`;
		} else {
			out[k] = v;
		}
	}
	return out;
}
