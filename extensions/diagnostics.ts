import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentDirectory } from "./settings.ts";
import type { ExecutionMode, Outcome, ReviewDiagnostics, ReviewFailureCode } from "./types.ts";

export interface ReviewDebugRecord {
	at: string;
	tool: string;
	execution: ExecutionMode;
	outcome: Outcome | "failed";
	review: ReviewDiagnostics;
}

export function reviewFailureLabel(code?: ReviewFailureCode): string {
	switch (code) {
		case undefined: case "model_unavailable": return "Automatic reviewer unavailable";
		case "auth_error": return "Automatic reviewer authentication failed";
		case "provider_error": return "Automatic reviewer request failed";
		case "provider_refusal": return "Automatic reviewer provider refused the assessment";
		case "timeout": return "Automatic reviewer timed out";
		case "cancelled": return "Automatic reviewer cancelled";
		case "request_too_large": return "Automatic review request exceeds its budget";
		default: return "Automatic reviewer returned an unusable response";
	}
}

export function reviewerDebugPath(): string { return join(agentDirectory(), "pi-auto-v2", "reviewer-debug.jsonl"); }

/** Called through the extension's serialized log queue. Never accepts raw model responses. */
export async function persistReviewDebug(record: ReviewDebugRecord): Promise<void> {
	const directory = join(agentDirectory(), "pi-auto-v2");
	const file = reviewerDebugPath();
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await chmod(directory, 0o700);
	let lines: string[] = [];
	try { lines = (await readFile(file, "utf8")).split("\n").filter(Boolean).slice(-199); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	lines.push(JSON.stringify(record));
	await writeFile(file, `${lines.join("\n")}\n`, { mode: 0o600 });
	await chmod(file, 0o600);
}

/** Also useful with persistence off: recent content-free traces remain in memory. */
export function formatReviewDebug(record: ReviewDebugRecord): string {
	return `${record.at} ${record.tool} ${record.outcome}\n${JSON.stringify(record.review, null, 2)}`;
}
