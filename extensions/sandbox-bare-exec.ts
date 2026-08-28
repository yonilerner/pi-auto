/** Execute a reviewer-approved sandbox escape and format its tool result. */

import { spawn } from "node:child_process";

export interface BareExecResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	durationMs: number;
}

/**
 * Re-execute a command outside the sandbox after a reviewer-approved escape.
 * Runs `bash -lc <command>` in the supplied cwd and honors AbortSignal.
 */
export async function runBareCommand(
	command: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<BareExecResult> {
	const start = Date.now();
	return await new Promise<BareExecResult>((resolve, reject) => {
		// detached: true makes the bash a new process group leader on Unix, so we
		// can SIGKILL the whole group on abort (mirrors pi's killProcessTree).
		const child = spawn("/bin/bash", ["-lc", command], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});
		if (signal) {
			const onAbort = () => {
				if (child.pid === undefined) return;
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					try {
						process.kill(child.pid, "SIGKILL");
					} catch {
						/* already dead */
					}
				}
			};
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
			child.on("close", () => signal.removeEventListener("abort", onAbort));
		}
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", (err) => reject(err));
		child.on("close", (code, sig) => {
			resolve({
				stdout,
				stderr,
				exitCode: code,
				signal: sig,
				durationMs: Date.now() - start,
			});
		});
	});
}

/**
 * Map a BareExecResult to the text + isError pair for a tool-result block.
 * Empty content must never be sent to the API.
 */
export function bareExecResultToToolContent(result: BareExecResult): {
	text: string;
	isError: boolean;
} {
	const text = result.stdout + (result.stderr ? `\n[stderr]\n${result.stderr}` : "");
	if (text !== "") {
		return { text, isError: result.exitCode !== 0 };
	}
	const placeholder =
		result.signal != null
			? `(command produced no output; killed by signal ${result.signal})`
			: `(command produced no output; exit code ${result.exitCode ?? "null"})`;
	return { text: placeholder, isError: result.exitCode !== 0 };
}
