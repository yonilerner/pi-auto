/**
 * Sandbox integration for pi-auto.
 *
 * Wraps `@anthropic-ai/sandbox-runtime` (ASRT) so the rest of pi-auto can:
 *
 *  - validate that the host supports the sandbox at session start
 *    (fail-loud if sandbox is configured but unavailable);
 *  - lazily initialize the underlying SandboxManager on first use;
 *  - wrap a bash command string into a sandbox-executable form, ready to be
 *    handed back to pi via the `tool_call` rewrite path;
 *  - detect whether a finished bash tool_result was killed by the sandbox
 *    (so we can ask the reviewer about an "escape" to run it unwrapped);
 *  - re-execute a command outside the sandbox after a reviewer-approved escape.
 *
 * Everything here is bash-only. read/write/edit run in-process and cannot be
 * wrapped by ASRT (ASRT uses sandbox-exec / bubblewrap subprocesses); they
 * continue to flow through pi-auto's path-scoping reviewer in scope.ts.
 */

import { spawn } from "node:child_process";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { PiAutoSettings, SandboxSettings } from "./types.ts";

export interface SandboxAvailability {
	supportedPlatform: boolean;
	errors: string[];
	warnings: string[];
}

export type SandboxState =
	| { kind: "disabled" }
	| { kind: "initializing"; init: Promise<SandboxState> }
	| { kind: "ready"; cwd: string; settings: SandboxSettings }
	| { kind: "broken"; reason: string };

/**
 * Recent network attempts captured by the ASRT `sandboxAskCallback`.
 *
 * ASRT calls our callback every time a sandboxed process tries to open an
 * outbound HTTP/HTTPS or SOCKS connection AND the host doesn't match any
 * `allowedDomains` or `deniedDomains` rule. The callback receives the host
 * and port, decides allow/deny, and ASRT enforces. We use the callback purely
 * to record what was attempted — returning `false` preserves the default
 * deny behavior — then surface the captured host into the escape-review
 * retry_reason so the reviewer learns _which_ host an opaque script tried to
 * reach. This matches what `srt -d` prints as `[SandboxDebug] No matching
 * config rule, denying: <host>:<port>`, just delivered through a structured
 * API instead of stderr.
 *
 * Not covered by this hook: DNS-only failures and raw socket binds; those
 * fail before any proxy connection is attempted. In practice almost all
 * exfiltration attempts via `curl`/`wget`/HTTP libraries DO route through
 * the proxy, so the coverage gap is narrow.
 */
export interface NetworkAttempt {
	host: string;
	port: number | undefined;
	at: number; // Date.now() at the moment the callback fired
}

const RECENT_NETWORK_ATTEMPTS_CAP = 50;
const recentNetworkAttempts: NetworkAttempt[] = [];

/**
 * The callback we hand to `SandboxManager.initialize(_, askCallback, _)`.
 *
 * Strategy: record the host/port, return `false`. Returning `false` means
 * "deny" — same as having no callback at all — so we don't change the
 * deny semantics, we only gain visibility into what was attempted.
 */
async function recordingAskCallback(params: {
	host: string;
	port: number | undefined;
}): Promise<boolean> {
	recentNetworkAttempts.push({ host: params.host, port: params.port, at: Date.now() });
	if (recentNetworkAttempts.length > RECENT_NETWORK_ATTEMPTS_CAP) {
		recentNetworkAttempts.splice(0, recentNetworkAttempts.length - RECENT_NETWORK_ATTEMPTS_CAP);
	}
	return false;
}

/**
 * Return the recorded network attempts whose timestamp is >= `since`.
 *
 * Callers (specifically the bash escape-review path in pi-auto.ts) record a
 * `commandStartTime` in the tool_call hook, then query this in the
 * tool_result hook to pick out the attempts that belong to the just-finished
 * command. Sequential bash execution is the common case in pi; for
 * concurrent calls the buffer is over-broad and we'd get a superset (still
 * informative, just less precise).
 */
export function getNetworkAttemptsSince(since: number): NetworkAttempt[] {
	return recentNetworkAttempts.filter((a) => a.at >= since);
}

/**
 * Test-only escape hatch — lets unit tests reset the global buffer between
 * cases without re-initializing the whole SandboxManager.
 */
export function _resetNetworkAttemptsForTest(): void {
	recentNetworkAttempts.length = 0;
}

/**
 * Probe the host for sandbox availability. Returns the combined platform +
 * dependency-check result. Cheap; safe to call before initializing.
 */
export function checkSandboxAvailability(settings: SandboxSettings): SandboxAvailability {
	const supportedPlatform = SandboxManager.isSupportedPlatform();
	if (!supportedPlatform) {
		return {
			supportedPlatform: false,
			errors: [
				`OS sandbox is not supported on this platform. ` +
					`Windows is currently unsupported by @anthropic-ai/sandbox-runtime; ` +
					`macOS and Linux are supported. ` +
					`Set sandbox.mode = "off" in pi-auto settings to silence this.`,
			],
			warnings: [],
		};
	}
	const deps = SandboxManager.checkDependencies();
	// Fold the SandboxSettings shape into something the runtime accepts so we
	// can validate paths now rather than discovering them on first command.
	const _config = buildSandboxRuntimeConfig(settings, process.cwd());
	return {
		supportedPlatform: true,
		errors: deps.errors,
		warnings: deps.warnings,
	};
}

/**
 * Build the SandboxRuntimeConfig that we hand to ASRT. We default to a
 * workspace-only filesystem write policy (cwd + /tmp) and a closed-by-default
 * network policy, then layer the user-provided allow/deny entries on top.
 *
 * Read access is left at the runtime's defaults (allowed everywhere, modulo
 * the runtime's built-in sensitive-path denies) and we only add explicit
 * denyRead / allowRead entries from the user.
 */
export function buildSandboxRuntimeConfig(
	settings: SandboxSettings,
	cwd: string,
): SandboxRuntimeConfig {
	const allowWrite =
		settings.allowWrite.length > 0 ? settings.allowWrite : [cwd, "/tmp"];
	return {
		network: {
			allowedDomains: settings.allowedDomains,
			deniedDomains: settings.deniedDomains,
		},
		filesystem: {
			allowRead: settings.allowRead,
			denyRead: settings.denyRead,
			allowWrite,
			denyWrite: settings.denyWrite,
		},
	} as SandboxRuntimeConfig;
}

/**
 * Initialize the runtime if not already up. Lazy and idempotent.
 *
 * Throws if the host doesn't support sandboxing OR dependencies are missing —
 * callers (notably session_start) should catch and translate into a hard
 * error per the design decision (no silent degradation).
 */
export async function ensureSandboxReady(
	settings: PiAutoSettings,
	cwd: string,
	state: { current: SandboxState },
): Promise<SandboxState> {
	if (settings.sandbox.mode === "off") {
		state.current = { kind: "disabled" };
		return state.current;
	}
	if (state.current.kind === "ready") return state.current;
	if (state.current.kind === "initializing") return state.current.init;
	if (state.current.kind === "broken") return state.current;

	const init = (async (): Promise<SandboxState> => {
		const avail = checkSandboxAvailability(settings.sandbox);
		if (!avail.supportedPlatform || avail.errors.length > 0) {
			const reason = [
				`pi-auto sandbox is enabled (mode=${settings.sandbox.mode}) but unavailable:`,
				...avail.errors,
			].join("\n  - ");
			state.current = { kind: "broken", reason };
			return state.current;
		}
		try {
			// enableLogMonitor=true ensures the violation store is populated
			// from the macOS sandbox log stream. We rely on that for the
			// authoritative "did the sandbox deny this" signal in tool_result.
			//
			// The `recordingAskCallback` captures host/port for every HTTP/SOCKS
			// proxy decision (returns `false` so deny semantics are unchanged);
			// see the NetworkAttempt docstring.
			await SandboxManager.initialize(
				buildSandboxRuntimeConfig(settings.sandbox, cwd),
				recordingAskCallback,
				true,
			);
			state.current = { kind: "ready", cwd, settings: settings.sandbox };
			return state.current;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			state.current = {
				kind: "broken",
				reason: `Sandbox initialization failed: ${msg}`,
			};
			return state.current;
		}
	})();

	state.current = { kind: "initializing", init };
	return init;
}

/**
 * Tear down the sandbox runtime (proxies + bridges). Safe to call multiple
 * times; safe to call when not initialized.
 */
export async function shutdownSandbox(state: { current: SandboxState }): Promise<void> {
	if (state.current.kind !== "ready") return;
	try {
		await SandboxManager.reset();
	} catch {
		// best-effort
	}
	state.current = { kind: "disabled" };
}

/**
 * Wrap a single bash command into the sandbox-executable form. Returns the
 * wrapped command as a single string suitable to substitute for the original
 * via `event.input.command`. ASRT's `wrapWithSandbox` returns a fully
 * sandbox-exec-prefixed (macOS) or bwrap-prefixed (Linux) command line.
 *
 * Note: ASRT expects the command to be run with `/bin/bash -lc <command>`, so
 * we don't need to add any quoting ourselves; we hand the raw command string
 * through.
 */
export async function wrapBashCommand(command: string): Promise<string> {
	return SandboxManager.wrapWithSandbox(command);
}

/**
 * Text-pattern denial detection. Pure function, no SandboxManager required.
 *
 * ASRT reports denials through process-side errors and stderr:
 *  - macOS sandbox-exec: "Operation not permitted" + the sandbox identifier
 *    in stderr; sometimes "sandbox-exec:" or the policy name appears.
 *  - bubblewrap (Linux): processes blocked by network namespace get
 *    "Connection refused" / "Temporary failure in name resolution"; processes
 *    blocked by bind-mount get "Operation not permitted" / "Permission denied".
 *  - ASRT's network proxies: "blocked by network allowlist".
 *
 * This is the FALLBACK detector. The authoritative signal is the violation
 * store — see `detectSandboxDenialForCommand` for the combined version. We
 * keep this exported so unit tests (and Linux paths without an active
 * violation log monitor) can still detect denials.
 */
export function detectSandboxDenial(
	isError: boolean,
	combinedOutput: string,
): { denied: boolean; reason: string } {
	if (!isError) return { denied: false, reason: "" };
	const lower = combinedOutput.toLowerCase();
	// Order matters: most-specific markers first so we attribute denials to the
	// most informative reason. The two generic markers ("operation not
	// permitted" for macOS sandbox-exec, generic strings that ASRT's proxy emits)
	// are checked last so they only fire when nothing more specific did.
	const markers: Array<[string, string]> = [
		["blocked by network allowlist", "network denied by sandbox"],
		["sandbox-exec:", "sandbox-exec rejected command"],
		["bwrap:", "bubblewrap rejected command"],
		["seccomp", "seccomp filter denied syscall"],
		["unix sockets are not permitted", "unix socket denied by sandbox"],
		// ASRT's HTTP proxy block message:
		["blocked by sandbox", "blocked by sandbox proxy"],
		// Generic catch-alls (kept last so the more specific markers above win):
		["operation not permitted", "filesystem operation denied by sandbox"],
	];
	for (const [needle, label] of markers) {
		if (lower.includes(needle)) {
			return { denied: true, reason: label };
		}
	}
	return { denied: false, reason: "" };
}

/**
 * Authoritative sandbox-denial check, used in production. Combines:
 *
 *  1. The ASRT violation store (via `annotateStderrWithSandboxFailures`).
 *     This is the source of truth on macOS — a non-empty annotation means
 *     the syslog-tailing log monitor recorded a sandbox kernel denial for
 *     this exact command.
 *  2. The text-pattern fallback in `detectSandboxDenial`. Needed because:
 *     - network denials often produce empty stderr + non-zero exit (the proxy
 *       returns a transport-layer error before any text is emitted),
 *     - on Linux the violation store may be empty (no system log monitor),
 *     - some violations show up in stderr before they're flushed to the store.
 *
 * Returns the (possibly-annotated) combined output so the caller can hand it
 * straight to the reviewer prompt.
 */
export function detectSandboxDenialForCommand(
	originalCommand: string,
	isError: boolean,
	combinedOutput: string,
): { denied: boolean; reason: string; annotatedOutput: string } {
	const annotated = SandboxManager.annotateStderrWithSandboxFailures(
		originalCommand,
		combinedOutput,
	);
	const hasStoreViolations = annotated !== combinedOutput;
	if (hasStoreViolations) {
		// Try to surface a more specific reason from the annotation when possible;
		// fall back to text-pattern detection for the human-readable label.
		const textDetect = detectSandboxDenial(isError, annotated);
		return {
			denied: true,
			reason: textDetect.reason || "sandbox denial recorded by ASRT violation store",
			annotatedOutput: annotated,
		};
	}
	const textOnly = detectSandboxDenial(isError, combinedOutput);
	return {
		denied: textOnly.denied,
		reason: textOnly.reason,
		annotatedOutput: combinedOutput,
	};
}

/**
 * Re-execute a command OUTSIDE the sandbox after a reviewer-approved escape.
 *
 * Runs `bash -lc <command>` in the supplied cwd, captures stdout + stderr,
 * returns the combined result. Honors an AbortSignal so an interrupted turn
 * doesn't leave a zombie subprocess.
 */
export interface BareExecResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	durationMs: number;
}

export async function runBareCommand(
	command: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<BareExecResult> {
	const start = Date.now();
	return await new Promise<BareExecResult>((resolve, reject) => {
		const child = spawn("/bin/bash", ["-lc", command], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (signal) {
			const onAbort = () => {
				try {
					child.kill("SIGTERM");
				} catch {
					/* ignore */
				}
			};
			signal.addEventListener("abort", onAbort, { once: true });
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
 * Pull the denied filesystem path out of an ASRT sandbox stderr.
 *
 * ASRT's macOS Seatbelt path produces stderr lines like:
 *   `/bin/bash: /Users/me/.ssh/test: Operation not permitted`
 *   `cat: /etc/passwd: Operation not permitted`
 *   `tee: /opt/deploy/release.sh: Operation not permitted`
 *
 * We grab the first such path. Returns `undefined` when nothing matches —
 * the caller falls back to a generic message in that case.
 *
 * This is the filesystem-side equivalent of the network-side `host:port`
 * capture we get from `recordingAskCallback`. Codex deliberately discards
 * this stderr (see `build_denial_reason_from_output` in their orchestrator);
 * we don't have to.
 */
export function extractDeniedPathFromStderr(combinedOutput: string): string | undefined {
	// Match `<tool>: <path>: Operation not permitted` (case-insensitive on the
	// suffix to be robust). Capture the path between the two colons.
	const re = /(?:^|\n)\s*[^\n:]+:\s+([^\n:]+):\s+Operation not permitted/i;
	const m = re.exec(combinedOutput);
	if (!m) return undefined;
	const path = m[1]?.trim();
	if (!path) return undefined;
	return path;
}

/**
 * Build a single, terse retry_reason string for the escape-review action
 * payload — mirrors the shape of codex's prompt-level `retry_reason`
 * (`Network access to "<host>" is blocked by policy.` for network denials,
 * `command failed; retry without sandbox?` as a generic fallback). On top
 * of codex's behavior we ALSO include the denied filesystem path when we
 * can extract one from stderr, which codex throws away.
 *
 * Inputs:
 *  - `denialReason`: the human-readable label produced by
 *    `detectSandboxDenialForCommand` (e.g. "network denied by sandbox",
 *    "filesystem operation denied by sandbox").
 *  - `combinedOutput`: the sandbox stderr/stdout, used to extract a denied
 *    path when the denial was filesystem-shaped.
 *  - `networkAttempts`: hosts captured by `recordingAskCallback` during this
 *    command's lifetime, used to extract host info when the denial was
 *    network-shaped.
 *
 * Returns a string of the form:
 *  - "Sandbox denied network access to api.evil.com:443."
 *  - "Sandbox denied filesystem access to /etc/passwd."
 *  - "Sandbox denied this command."  (fallback)
 *
 * Intentionally *not* phrased as a question ("Retry without sandbox?") —
 * a 5x run showed the question form makes the reviewer treat the retry as
 * a separate authorization decision, denying obvious user-requested fetches
 * because "the user did not explicitly authorize retrying outside the
 * sandbox." We want the model to evaluate the underlying action on its own
 * merits per codex's policy line: "Sandbox retry or escalation after an
 * initial sandbox denial is not suspicious by itself."
 */
export function buildRetryReason(
	denialReason: string,
	combinedOutput: string,
	networkAttempts: NetworkAttempt[],
): string {
	const isNetwork = /network|proxy|allowlist/i.test(denialReason);
	if (isNetwork && networkAttempts.length > 0) {
		const formatted = networkAttempts
			.map((a) => (a.port !== undefined ? `${a.host}:${a.port}` : a.host))
			.join(", ");
		return `Sandbox denied network access to ${formatted}.`;
	}
	if (isNetwork) {
		return `Sandbox denied network access.`;
	}
	const path = extractDeniedPathFromStderr(combinedOutput);
	if (path) {
		return `Sandbox denied filesystem access to ${path}.`;
	}
	return `Sandbox denied this command.`;
}
