/** Sandbox denial detection and ASRT violation-store noise filtering. */

import { SandboxManager } from "@foxfirecodes/sandbox-runtime";
import { getAsrtMandatoryDenyPathPatterns } from "./sandbox-git-excludes.ts";

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

/**
 * Text-pattern denial detection. Pure function, no SandboxManager required.
 *
 * This is the fallback detector. The authoritative signal is the violation
 * store — see `detectSandboxDenialForCommand` for the combined version.
 */
export function detectSandboxDenial(
	isError: boolean,
	combinedOutput: string,
	platform: NodeJS.Platform = process.platform,
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
	// most informative reason. The two generic markers are checked last so they
	// only fire when nothing more specific did.
	const markers: Array<[string, string]> = [
		["sandbox-exec:", "sandbox-exec rejected command"],
		["bwrap:", "bubblewrap rejected command"],
		["seccomp", "seccomp filter denied syscall"],
		["unix sockets are not permitted", "unix socket denied by sandbox"],
		["network-bind", "local socket/listen denied by sandbox"],
		["network-inbound", "local socket/listen denied by sandbox"],
		["listen eperm", "local socket/listen denied by sandbox"],
		["syscall: 'listen'", "local socket/listen denied by sandbox"],
		["syscall: \"listen\"", "local socket/listen denied by sandbox"],
		["blocked by sandbox", "blocked by sandbox proxy"],
		["gaierror", "network denied by sandbox (DNS)"],
		["enotfound", "network denied by sandbox (DNS)"],
		["could not resolve host", "network denied by sandbox (DNS)"],
		["no such host", "network denied by sandbox (DNS)"],
		["nodename nor servname provided", "network denied by sandbox (DNS)"],
		["name or service not known", "network denied by sandbox (DNS)"],
		["connect tunnel failed", "network denied by sandbox (proxy)"],
		["fetch failed", "network denied by sandbox"],
		["linux file-read denied", "filesystem operation denied by sandbox"],
		["linux file-write denied", "filesystem operation denied by sandbox"],
		["operation not permitted", "filesystem operation denied by sandbox"],
	];
	for (const [needle, label] of markers) {
		if (lower.includes(needle)) {
			return { denied: true, reason: label };
		}
	}
	if (platform === "linux" && extractAsrtMandatoryDenyPathFromPermissionDenied(combinedOutput)) {
		return { denied: true, reason: "filesystem operation denied by sandbox" };
	}
	return { denied: false, reason: "" };
}

/** Known-noise violation operations emitted by every macOS sandboxed process. */
const NOISE_OPERATIONS = [
	"sysctl-read kern.iossupportversion",
	"mach-lookup com.apple.SystemConfiguration.configd",
	"mach-lookup com.apple.SystemConfiguration.DNSConfiguration",
	"mach-lookup com.apple.SystemConfiguration.SCNetworkReachability",
];

/** Test-only: expose the noise table without permitting mutation. */
export function _noiseOperationsForTest(): readonly string[] {
	return NOISE_OPERATIONS;
}

/**
 * Strip a violation annotation block of known baseline noise. If nothing
 * meaningful remains, return the verbatim pre-annotation output.
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
		if (isLinuxFailedSyscallNoise(trimmed)) continue;
		kept.push(line);
	}
	if (kept.length === 0) return original;
	const newBody = `\n${kept.join("\n")}\n`;
	return `${before}${openTag}${newBody}${closeTag}${after}`;
}

/** Shared with filesystem denial-path extraction in sandbox.ts. */
export function isLinuxFailedSyscallNoise(line: string): boolean {
	if (!/^linux file-(?:read|write) denied:/i.test(line)) return false;
	return /->\s*(?:ENOENT|ENXIO)\b/i.test(line);
}

/**
 * Combine ASRT's annotation store with textual fallback detection. Returns the
 * annotated output so callers can present the strongest available evidence.
 */
export function detectSandboxDenialForCommand(
	originalCommand: string,
	isError: boolean,
	combinedOutput: string,
	platform: NodeJS.Platform = process.platform,
): { denied: boolean; reason: string; annotatedOutput: string } {
	const rawAnnotated = SandboxManager.annotateStderrWithSandboxFailures(
		originalCommand,
		combinedOutput,
	);
	const annotated = filterNoiseFromAnnotation(rawAnnotated, combinedOutput);
	const hasStoreViolations = annotated !== combinedOutput;
	if (hasStoreViolations) {
		const textDetect = detectSandboxDenial(isError, annotated, platform);
		return {
			denied: true,
			reason: textDetect.reason || "sandbox denial recorded by ASRT violation store",
			annotatedOutput: annotated,
		};
	}
	const textOnly = detectSandboxDenial(isError, combinedOutput, platform);
	return {
		denied: textOnly.denied,
		reason: textOnly.reason,
		annotatedOutput: combinedOutput,
	};
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
