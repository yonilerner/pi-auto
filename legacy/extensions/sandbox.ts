/**
 * Sandbox integration for pi-auto.
 *
 * Wraps `@foxfirecodes/sandbox-runtime` (ASRT) so the rest of pi-auto can:
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

import { mkdirSync } from "node:fs";
import { SandboxManager, type SandboxRuntimeConfig } from "@foxfirecodes/sandbox-runtime";
import { DANGEROUS_FILES } from "@foxfirecodes/sandbox-runtime/dist/sandbox/sandbox-utils.js";
import { isLinuxFailedSyscallNoise } from "./sandbox-denial.ts";
import { getAsrtMandatoryDenyPathPatterns, withSandboxGitExcludes } from "./sandbox-git-excludes.ts";
import type { PiAutoSettings, SandboxSettings } from "./types.ts";

export {
	_noiseOperationsForTest,
	detectSandboxDenial,
	detectSandboxDenialForCommand,
	filterNoiseFromAnnotation,
} from "./sandbox-denial.ts";
export {
	getAsrtMandatoryDenyGitExcludePatterns,
	withSandboxGitExcludes,
} from "./sandbox-git-excludes.ts";
export {
	bareExecResultToToolContent,
	runBareCommand,
	type BareExecResult,
} from "./sandbox-bare-exec.ts";

/**
 * Mutable view of ASRT's `DANGEROUS_FILES` export. The runtime declares it
 * `readonly` in its `.d.ts`, but the underlying value is a plain array shared
 * across the linux and macOS sandbox utils — both re-read it on every
 * `wrapWithSandbox` / sandbox profile generation. Splicing in place is enough
 * to toggle a single entry on/off; no re-init is needed.
 */
const MUTABLE_DANGEROUS_FILES = DANGEROUS_FILES as unknown as string[];
/** Snapshot of `DANGEROUS_FILES` at module load, so flipping the setting back
 * off can restore an entry to its original index. */
const ORIGINAL_DANGEROUS_FILES: readonly string[] = [...DANGEROUS_FILES];


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
 * Test-only escape hatch — hands the e2e probe the real production callback
 * so it can exercise the exact production wiring (not a spy) and see whether
 * recentNetworkAttempts gets populated end-to-end.
 */
export function _recordingAskCallbackForTest(params: {
	host: string;
	port: number | undefined;
}): Promise<boolean> {
	return recordingAskCallback(params);
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
					`Windows is currently unsupported by @foxfirecodes/sandbox-runtime; ` +
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
 * Build the SandboxRuntimeConfig that we hand to ASRT. Filesystem write roots
 * are configured explicitly in settings; the default settings include `.`.
 *
 * Read access is left at the runtime's defaults (allowed everywhere, modulo
 * the runtime's built-in sensitive-path denies) and we only add explicit
 * denyRead / allowRead entries from the user.
 */
/**
 * Apply pi-auto's overrides to ASRT's hardcoded `DANGEROUS_FILES` array.
 *
 * Reconciles the live array against ORIGINAL_DANGEROUS_FILES minus
 * `settings.allowedDangerousFiles`. Unknown entries in `allowedDangerousFiles`
 * (typos, names ASRT doesn't actually ship) are silently ignored. Safe to
 * call repeatedly; idempotent.
 *
 * Called from `ensureSandboxReady` (covers settings-change re-init) and from
 * `wrapBashCommand` (defense in depth in case the sandbox is initialized
 * through another entry point).
 */
export function applyDangerousFilesPolicy(settings: SandboxSettings): void {
	const allowSet = new Set(settings.allowedDangerousFiles ?? []);
	const desired = ORIGINAL_DANGEROUS_FILES.filter((name) => !allowSet.has(name));
	MUTABLE_DANGEROUS_FILES.splice(0, MUTABLE_DANGEROUS_FILES.length, ...desired);
}

export function buildSandboxRuntimeConfig(
	settings: SandboxSettings,
	_cwd: string,
): SandboxRuntimeConfig {
	return {
		network: {
			allowedDomains: settings.allowedDomains,
			deniedDomains: settings.deniedDomains,
			disableDefaultNoProxy: settings.disableDefaultNoProxy,
		},
		filesystem: {
			allowRead: settings.allowRead,
			denyRead: settings.denyRead,
			allowWrite: settings.allowWrite,
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
	// Re-apply the DANGEROUS_FILES policy on every call so a live settings
	// change picks up before the next sandbox initialize. Idempotent.
	applyDangerousFilesPolicy(settings.sandbox);
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
export interface WrappedSandboxCommand {
	/** The exact command string handed to ASRT's wrapWithSandbox(). */
	sandboxCommand: string;
	/** The shell command returned by ASRT and executed by pi's bash tool. */
	wrappedCommand: string;
}

/**
 * Return the exact command string that should be handed to ASRT.
 *
 * This is usually the user's original bash command. On Linux, pi-auto prepends
 * git-excludes environment variables before wrapping so ASRT's mandatory-deny
 * mount placeholders do not appear to nested git/but/gh commands. ASRT's
 * violation annotation lookup is keyed by the command passed to
 * wrapWithSandbox(), so callers that later call
 * annotateStderrWithSandboxFailures() must retain this exact string.
 */
export function buildSandboxCommand(
	command: string,
	cwd: string = process.cwd(),
	sandbox?: SandboxSettings,
): string {
	if (sandbox) applyDangerousFilesPolicy(sandbox);
	return process.platform === "linux" ? withSandboxGitExcludes(command, cwd) : command;
}

/**
 * Wrap a single bash command and return both ASRT strings: the command that was
 * passed into wrapWithSandbox() and the executable wrapper it returned.
 */
export async function wrapBashCommandForExecution(
	command: string,
	cwd: string = process.cwd(),
	sandbox?: SandboxSettings,
): Promise<WrappedSandboxCommand> {
	const sandboxCommand = buildSandboxCommand(command, cwd, sandbox);
	const wrappedCommand = await SandboxManager.wrapWithSandbox(sandboxCommand);
	return { sandboxCommand, wrappedCommand };
}

export async function wrapBashCommand(
	command: string,
	cwd: string = process.cwd(),
	sandbox?: SandboxSettings,
): Promise<string> {
	return (await wrapBashCommandForExecution(command, cwd, sandbox)).wrappedCommand;
}

/**
 * Notify ASRT that a wrapped command has finished.
 *
 * On Linux, bubblewrap creates host-side mount-point placeholders when ASRT
 * protects mandatory deny paths that do not exist yet (for example `.bashrc`
 * or `.claude/agents` under the writable cwd). ASRT can only remove those
 * placeholders after the wrapped subprocess exits, so callers must run this
 * from the bash tool_result hook for every sandboxed command.
 */
export function cleanupAfterSandboxCommand(): void {
	SandboxManager.cleanupAfterCommand();
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
export interface DeniedFilesystemViolation {
	operation: string;
	access: "read" | "write";
	path: string;
}

export function extractDeniedPathFromStderr(
	combinedOutput: string,
	platform: NodeJS.Platform = process.platform,
): string | undefined {
	// Shape 1: bash redirection / cat / tee on macOS.
	//   `/bin/bash: /Users/me/.ssh/test: Operation not permitted`
	//   `cat: /etc/passwd: Operation not permitted`
	const bashShape = /(?:^|\n)\s*[^\n:]+:\s+([^\n:]+):\s+(?:Operation not permitted|Permission denied)/i;
	let m = bashShape.exec(combinedOutput);
	if (m?.[1]) {
		const stripped = normalizeDeniedPathCandidate(m[1]);
		if (stripped) return stripped;
	}
	// Shape 2: Python's PermissionError / OSError formatting puts the path
	// AFTER the denial phrase:
	//   `PermissionError: [Errno 1] Operation not permitted: '/tmp/foo'`
	//   `OSError: [Errno 13] Permission denied: '/tmp/foo'`
	const pythonShape = /(?:Operation not permitted|Permission denied):\s+['"]?([^'"\n]+?)['"]?(?:\s|$)/i;
	m = pythonShape.exec(combinedOutput);
	if (m?.[1]) {
		const stripped = normalizeDeniedPathCandidate(m[1]);
		if (stripped) return stripped;
	}
	if (platform === "linux") {
		const mandatoryDenyPath = extractAsrtMandatoryDenyPathFromPermissionDenied(combinedOutput);
		if (mandatoryDenyPath) return mandatoryDenyPath;
	}
	// Shape 3: parse the ASRT violation store directly. The annotated block
	// includes lines like:
	//   `python3.11(12345) deny(1) file-write-create /private/tmp/foo`
	// This is the cleanest signal when stderr formatting doesn't fit either
	// shape above (or the operation was caught before any stderr was written).
	return extractDeniedFilesystemViolation(combinedOutput)?.path;
}

export function extractDeniedFilesystemViolation(
	combinedOutput: string,
): DeniedFilesystemViolation | undefined {
	for (const line of combinedOutput.split("\n")) {
		const trimmed = line.trim();
		let m = /\bdeny\(\d+\)\s+(file-(write|read)-[a-z-]+)\s+(.+)$/i.exec(trimmed);
		if (m?.[1] && m[2] && m[3]) {
			const path = normalizeDeniedPathCandidate(m[3]);
			if (!path) continue;
			return { operation: m[1], access: m[2].toLowerCase() as "read" | "write", path };
		}

		m = /\blinux file-(read|write) denied:\s+([a-z0-9_]+)\("([^"]+)"\)\s*->\s*([A-Z0-9_]+)/i.exec(trimmed);
		if (m?.[1] && m[2] && m[3] && m[4]) {
			if (isLinuxFailedSyscallNoise(trimmed)) continue;
			const path = normalizeDeniedPathCandidate(m[3]);
			if (!path) continue;
			const access = m[1].toLowerCase() as "read" | "write";
			return { operation: `linux file-${access} ${m[2]} ${m[4]}`, access, path };
		}
	}
	return undefined;
}

function normalizeDeniedPathCandidate(s: string): string | undefined {
	const stripped = stripPathQuotes(s.trim());
	if (!stripped) return undefined;
	if (!looksLikeFilesystemPath(stripped)) return undefined;
	return stripped;
}

function extractAsrtMandatoryDenyPathFromPermissionDenied(
	combinedOutput: string,
): string | undefined {
	const lines = combinedOutput.split("\n");
	const permissionLineIndexes = lines
		.map((line, index) => ({ line: line.toLowerCase(), index }))
		.filter(({ line }) =>
			line.includes("permission denied") ||
			line.includes("os error 13") ||
			line.includes("eacces"),
		)
		.map(({ index }) => index);
	if (permissionLineIndexes.length === 0) return undefined;

	const candidates = getAsrtMandatoryDenyPathPatterns().sort((a, b) => b.length - a.length);
	for (const candidate of candidates) {
		const needle = candidate.toLowerCase();
		for (const permissionIndex of permissionLineIndexes) {
			const start = Math.max(0, permissionIndex - 4);
			const end = Math.min(lines.length, permissionIndex + 5);
			const window = lines.slice(start, end).join("\n").toLowerCase();
			if (window.includes(needle)) return candidate;
		}
	}
	return undefined;
}

function stripPathQuotes(s: string): string {
	let out = s;
	if ((out.startsWith("'") && out.endsWith("'")) || (out.startsWith('"') && out.endsWith('"'))) {
		out = out.slice(1, -1);
	}
	return out.trim();
}

function looksLikeFilesystemPath(s: string): boolean {
	return s.startsWith("/") || s.startsWith("~/") || s.startsWith("./") || s.startsWith("../");
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
 *  - "Sandbox denied local socket/listen access."
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
	platform: NodeJS.Platform = process.platform,
): string {
	// If recordingAskCallback captured one or more host attempts during this
	// command's window, it WAS network by definition — don't gate on text
	// classification. The earlier shape (gating on a text isNetwork test)
	// dropped the host info whenever the denial label came from the violation
	// store as the generic "sandbox denial recorded by ASRT violation store".
	if (networkAttempts.length > 0) {
		const formatted = networkAttempts
			.map((a) => (a.port !== undefined ? `${a.host}:${a.port}` : a.host))
			.join(", ");
		return `Sandbox denied network access to ${formatted}.`;
	}
	const denialHaystack = `${denialReason}\n${combinedOutput}`;
	const isLocalBind =
		/local (?:network bind|socket)\/listen|network-bind|network-inbound|listen eperm|syscall:\s*['"]listen['"]/i.test(
			denialHaystack,
		);
	if (isLocalBind) {
		return `Sandbox denied local socket/listen access.`;
	}
	const isNetwork = /network|proxy|allowlist/i.test(denialReason);
	if (isNetwork) {
		return `Sandbox denied network access.`;
	}
	const fsViolation = extractDeniedFilesystemViolation(combinedOutput);
	if (fsViolation) {
		return `Sandbox denied filesystem ${fsViolation.access} access to ${fsViolation.path} (${fsViolation.operation}).`;
	}
	const path = extractDeniedPathFromStderr(combinedOutput, platform);
	if (path) {
		return `Sandbox denied filesystem access to ${path}.`;
	}
	return `Sandbox denied this command.`;
}
