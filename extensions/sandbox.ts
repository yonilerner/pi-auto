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

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { DANGEROUS_FILES, getDangerousDirectories } from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js";
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
export async function wrapBashCommand(command: string, cwd: string = process.cwd()): Promise<string> {
	return SandboxManager.wrapWithSandbox(withSandboxGitExcludes(command, cwd));
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
 * Inject a generated git excludes file into the sandboxed shell environment.
 *
 * ASRT's Linux backend may create mandatory-deny mount-point placeholders in
 * the writable cwd. Those placeholders are intentionally visible inside the
 * sandbox, so git commands run by any tool (`git`, `but`, npm scripts, etc.)
 * must inherit a global exclude that hides the exact ASRT-protected names.
 */
export function withSandboxGitExcludes(command: string, cwd: string): string {
	const excludeFile = ensureSandboxGitExcludesFile(cwd);
	const existingCount = parseGitConfigCount(process.env.GIT_CONFIG_COUNT);
	const assignments = [
		["GIT_CONFIG_COUNT", String(existingCount + 1)],
		[`GIT_CONFIG_KEY_${existingCount}`, "core.excludesFile"],
		[`GIT_CONFIG_VALUE_${existingCount}`, excludeFile],
	] as const;
	const exports = assignments
		.map(([key, value]) => `export ${key}=${shellSingleQuote(value)}`)
		.join("\n");
	return `${exports}\n${command}`;
}

export function getAsrtMandatoryDenyGitExcludePatterns(): string[] {
	return getAsrtMandatoryDenyPathPatterns().filter((p) => !p.startsWith(".git/"));
}

function getAsrtMandatoryDenyPathPatterns(): string[] {
	return [...DANGEROUS_FILES, ...getDangerousDirectories(), ".git/hooks", ".git/config"].map((p) => p.replace(/^\.\//, ""));
}

function ensureSandboxGitExcludesFile(cwd: string): string {
	const hash = createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 16);
	const dir = path.join(tmpdir(), "pi-auto", "sandbox-git-excludes");
	mkdirSync(dir, { recursive: true });
	const filePath = path.join(dir, `${hash}.gitignore`);
	writeFileSync(filePath, buildSandboxGitExcludesFileContent(cwd), "utf8");
	return filePath;
}

function buildSandboxGitExcludesFileContent(cwd: string): string {
	const existing = readExistingGitExcludeContents(cwd);
	const mandatory = getAsrtMandatoryDenyGitExcludePatterns().join("\n");
	return [
		"# Generated by pi-auto for sandboxed commands.",
		"# Keeps ASRT mandatory-deny mount-point placeholders out of git status/add.",
		mandatory,
		existing ? "\n# Existing user/global core.excludesFile content follows." : "",
		existing,
		"",
	]
		.filter((part) => part.length > 0)
		.join("\n");
}

function readExistingGitExcludeContents(cwd: string): string {
	const paths = new Set<string>();
	const configured = resolveConfiguredGitExcludesFile(cwd);
	if (configured) paths.add(configured);
	const xdgConfigHome = process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
	paths.add(path.join(xdgConfigHome, "git", "ignore"));
	const chunks: string[] = [];
	for (const candidate of paths) {
		if (!candidate || !existsSync(candidate)) continue;
		try {
			chunks.push(readFileSync(candidate, "utf8"));
		} catch {
			// Best-effort only. Losing user excludes here is less bad than failing
			// every sandboxed bash command because an ignore file is unreadable.
		}
	}
	return chunks.join("\n").trim();
}

function resolveConfiguredGitExcludesFile(cwd: string): string | undefined {
	const result = spawnSync("git", ["config", "--get", "--path", "core.excludesFile"], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	if (result.status !== 0) return undefined;
	const raw = result.stdout.trim().split("\n").at(-1)?.trim();
	if (!raw) return undefined;
	if (raw.startsWith("~/")) return path.join(homedir(), raw.slice(2));
	return path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
}

function parseGitConfigCount(raw: string | undefined): number {
	if (!raw) return 0;
	const parsed = Number.parseInt(raw, 10);
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function shellSingleQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
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
/**
 * Strong proxy/network markers that survived the violation-store noise
 * filter — we want to flag the denial even when curl exits 0 (a proxy-
 * synthesized 403 response is a denial from the user's perspective).
 */
const HARD_PROXY_MARKERS: Array<[string, string]> = [
	// ASRT's actual HTTP proxy response headers (hyphenated, NOT "blocked by
	// allowlist" with spaces — spent an hour chasing this).
	["x-proxy-error", "network denied by sandbox"],
	["blocked-by-allowlist", "network denied by sandbox"],
	// Older / older-doc spelling, kept for safety.
	["blocked by network allowlist", "network denied by sandbox"],
];

export function detectSandboxDenial(
	isError: boolean,
	combinedOutput: string,
): { denied: boolean; reason: string } {
	const lower = combinedOutput.toLowerCase();
	// Hard proxy markers ALWAYS count, even on exit 0 — the response was
	// synthesized by ASRT's proxy as a denial regardless of the HTTP status
	// curl returned.
	for (const [needle, label] of HARD_PROXY_MARKERS) {
		if (lower.includes(needle)) {
			return { denied: true, reason: label };
		}
	}
	if (!isError) return { denied: false, reason: "" };
	// Order matters: most-specific markers first so we attribute denials to the
	// most informative reason. The two generic markers ("operation not
	// permitted" for macOS sandbox-exec, generic strings that ASRT's proxy emits)
	// are checked last so they only fire when nothing more specific did.
	const markers: Array<[string, string]> = [
		["sandbox-exec:", "sandbox-exec rejected command"],
		["bwrap:", "bubblewrap rejected command"],
		["seccomp", "seccomp filter denied syscall"],
		["unix sockets are not permitted", "unix socket denied by sandbox"],
		// Local listener creation. ASRT reports these under Seatbelt's
		// network-bind/network-inbound operations, including Unix-domain sockets;
		// Node surfaces them as `listen EPERM`.
		["network-bind", "local socket/listen denied by sandbox"],
		["network-inbound", "local socket/listen denied by sandbox"],
		["listen eperm", "local socket/listen denied by sandbox"],
		["syscall: 'listen'", "local socket/listen denied by sandbox"],
		["syscall: \"listen\"", "local socket/listen denied by sandbox"],
		// ASRT's HTTP proxy block message:
		["blocked by sandbox", "blocked by sandbox proxy"],
		// DNS-blocked-by-sandbox markers. When the sandbox cuts off DNS, runtimes
		// surface different messages:
		//   curl:  "Could not resolve host"
		//   Node:  "ENOTFOUND" / "getaddrinfo ENOTFOUND"
		//   Go:    "dial tcp: lookup ...: no such host"
		//   Python: "gaierror" / "nodename nor servname provided"
		//          "Errno 8" / "Name or service not known"
		//   curl HTTPS through CONNECT-proxy denial: "CONNECT tunnel failed"
		["gaierror", "network denied by sandbox (DNS)"],
		["enotfound", "network denied by sandbox (DNS)"],
		["could not resolve host", "network denied by sandbox (DNS)"],
		["no such host", "network denied by sandbox (DNS)"],
		["nodename nor servname provided", "network denied by sandbox (DNS)"],
		["name or service not known", "network denied by sandbox (DNS)"],
		["connect tunnel failed", "network denied by sandbox (proxy)"],
		// Node's default fetch / undici error when proxy blocks:
		["fetch failed", "network denied by sandbox"],
		// Generic catch-all (kept last so the more specific markers above win):
		["operation not permitted", "filesystem operation denied by sandbox"],
	];
	for (const [needle, label] of markers) {
		if (lower.includes(needle)) {
			return { denied: true, reason: label };
		}
	}
	if (extractAsrtMandatoryDenyPathFromPermissionDenied(combinedOutput)) {
		return { denied: true, reason: "filesystem operation denied by sandbox" };
	}
	return { denied: false, reason: "" };
}

/**
 * Known-noise entries that every sandboxed process on macOS emits whether or
 * not it tried to do anything denied. We use these to filter the violation
 * store before deciding the command was denied; without filtering, the
 * presence of any sandboxed bash command produces "denial" hits and triggers
 * a spurious escape-review.
 *
 * The format matches what ASRT's `annotateStderrWithSandboxFailures` emits,
 * e.g. `sh(12345) deny(1) sysctl-read kern.iossupportversion`. We check the
 * substring after the `deny(N) ` marker.
 *
 * Keep this list narrow: anything actually informative about what the command
 * tried to do (network-outbound, file-write-create, file-read-data,
 * mach-lookup that isn't the SystemConfiguration noise, etc.) must NOT be
 * filtered.
 */
const NOISE_OPERATIONS = [
	// macOS Seatbelt asks for the version sysctl on every sandboxed exec.
	"sysctl-read kern.iossupportversion",
	// Mach-lookups for the system network/DNS config service. Curl, node, and
	// the Python runtime all do these on startup. They're attempting to read
	// the system proxy configuration; ASRT denies because the proxy bridge
	// already substitutes its own. Not a denial of what the command tried to
	// achieve.
	"mach-lookup com.apple.SystemConfiguration.configd",
	"mach-lookup com.apple.SystemConfiguration.DNSConfiguration",
	"mach-lookup com.apple.SystemConfiguration.SCNetworkReachability",
];

/**
 * Test-only: expose the noise table so the e2e and unit tests can assert
 * the filter applies. Don't mutate the returned array.
 */
export function _noiseOperationsForTest(): readonly string[] {
	return NOISE_OPERATIONS;
}

/**
 * Strip the `<sandbox_violations>...</sandbox_violations>` block from an
 * annotated stderr, drop lines whose deny-operation matches NOISE_OPERATIONS,
 * and re-emit the block. If after filtering the block is empty, return the
 * `original` (pre-annotation) text VERBATIM so callers' equality check
 * (`annotated !== combinedOutput`) sees no difference and skips the denial
 * path.
 *
 * `original` is required for the noise-only case: trimming whitespace from
 * `annotated.slice(0, blockStart)` looks correct but corrupts the equality
 * check whenever ASRT injects the block on a fresh line (which is always).
 * Returning the verbatim original avoids that whole class of bug.
 *
 * Pure string transform; safe to run on annotated output that has no block
 * (returns it unchanged).
 */
export function filterNoiseFromAnnotation(annotated: string, original: string): string {
	const openTag = "<sandbox_violations>";
	const closeTag = "</sandbox_violations>";
	const start = annotated.indexOf(openTag);
	if (start < 0) return annotated;
	const end = annotated.indexOf(closeTag, start);
	if (end < 0) return annotated;
	const before = annotated.slice(0, start);
	const after = annotated.slice(end + closeTag.length);
	const body = annotated.slice(start + openTag.length, end);
	const kept: string[] = [];
	for (const line of body.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		if (NOISE_OPERATIONS.some((needle) => trimmed.includes(needle))) continue;
		kept.push(line);
	}
	if (kept.length === 0) {
		// Nothing meaningful in the block — hand back the verbatim original so
		// the equality check in detectSandboxDenialForCommand passes through.
		return original;
	}
	const newBody = `\n${kept.join("\n")}\n`;
	return `${before}${openTag}${newBody}${closeTag}${after}`;
}

/**
 * Authoritative sandbox-denial check, used in production. Combines:
 *
 *  1. The ASRT violation store (via `annotateStderrWithSandboxFailures`),
 *     filtered through `filterNoiseFromAnnotation` to drop the macOS Seatbelt
 *     sysctl/mach-lookup noise that every sandboxed bash process emits.
 *     This is the source of truth on macOS — after filtering, a non-empty
 *     annotation means the log monitor recorded a meaningful sandbox denial
 *     for this command (network-outbound, file-write-create, etc.).
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
	const rawAnnotated = SandboxManager.annotateStderrWithSandboxFailures(
		originalCommand,
		combinedOutput,
	);
	const annotated = filterNoiseFromAnnotation(rawAnnotated, combinedOutput);
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
export interface DeniedFilesystemViolation {
	operation: string;
	access: "read" | "write";
	path: string;
}

export function extractDeniedPathFromStderr(combinedOutput: string): string | undefined {
	// Shape 1: bash redirection / cat / tee on macOS.
	//   `/bin/bash: /Users/me/.ssh/test: Operation not permitted`
	//   `cat: /etc/passwd: Operation not permitted`
	const bashShape = /(?:^|\n)\s*[^\n:]+:\s+([^\n:]+):\s+Operation not permitted/i;
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
	const mandatoryDenyPath = extractAsrtMandatoryDenyPathFromPermissionDenied(combinedOutput);
	if (mandatoryDenyPath) return mandatoryDenyPath;
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
		const m = /\bdeny\(\d+\)\s+(file-(write|read)-[a-z-]+)\s+(.+)$/i.exec(line.trim());
		if (!m?.[1] || !m[2] || !m[3]) continue;
		const path = normalizeDeniedPathCandidate(m[3]);
		if (!path) continue;
		return { operation: m[1], access: m[2].toLowerCase() as "read" | "write", path };
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
	const path = extractDeniedPathFromStderr(combinedOutput);
	if (path) {
		return `Sandbox denied filesystem access to ${path}.`;
	}
	return `Sandbox denied this command.`;
}
