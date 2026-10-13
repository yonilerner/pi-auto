/** Preserve the effective tool's output; add only pi-auto execution evidence. */
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { SandboxOutcome } from "./sandbox.ts";

export function appendExecutionNotice(
	content: ToolResultEvent["content"],
	outcome: SandboxOutcome,
	isError: boolean,
): ToolResultEvent["content"] {
	if (!outcome.blocked && !isError) return content;
	const lines: string[] = [];
	if (outcome.blocked) {
		lines.push("[pi-auto sandbox blocked]", ...outcome.denials,
			"Inspect the effects and propose a narrower command. If full host access is needed, propose a new command starting with '# pi-auto: host <reason>' for review.");
	}
	lines.push("The command may have partially completed. It was not replayed.");
	return [...content, { type: "text", text: lines.join("\n") }];
}
