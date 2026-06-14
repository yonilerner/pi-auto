/**
 * Deterministic tests for sandbox helpers in extensions/sandbox.ts.
 *
 * We do NOT exercise SandboxManager.initialize / wrapWithSandbox in this file
 * — those hit OS-level sandboxing primitives (`sandbox-exec`, bubblewrap) and
 * spawn proxy processes. The behavior we own and need to verify is:
 *
 *   - SandboxRuntimeConfig assembly from PiAutoSettings.sandbox
 *     (defaults, path resolution, allow/deny lists)
 *   - sandbox-denial pattern detection across the markers ASRT emits on
 *     macOS, bubblewrap on Linux, and ASRT's proxy
 *   - the `extractDeniedPathFromStderr` regex that pulls the denied path
 *     out of macOS Seatbelt stderr lines (codex's orchestrator throws this
 *     stderr away; we use it)
 *   - the `buildRetryReason` helper that produces the single terse string
 *     we hand to the reviewer in the escape-review action payload
 *
 * Integration with the actual sandbox is covered manually + via live tests.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
	buildRetryReason,
	buildSandboxRuntimeConfig,
	detectSandboxDenial,
	extractDeniedPathFromStderr,
	getNetworkAttemptsSince,
	_resetNetworkAttemptsForTest,
} from "../extensions/sandbox.ts";
import type { SandboxSettings } from "../extensions/types.ts";

function makeSettings(overrides: Partial<SandboxSettings> = {}): SandboxSettings {
	return {
		mode: "escape-only",
		allowedDomains: [],
		deniedDomains: [],
		allowRead: [],
		denyRead: [],
		allowWrite: [],
		denyWrite: [],
		showStatusIndicator: true,
		annotateBashDisplay: true,
		alwaysAnnounceDenials: true,
		...overrides,
	};
}

describe("buildSandboxRuntimeConfig", () => {
	it("defaults allowWrite to cwd + /tmp when user-provided allowWrite is empty", () => {
		const cfg = buildSandboxRuntimeConfig(makeSettings(), "/home/me/project");
		expect(cfg.filesystem?.allowWrite).toEqual(["/home/me/project", "/tmp"]);
	});

	it("uses explicit allowWrite when the user provided one", () => {
		const cfg = buildSandboxRuntimeConfig(
			makeSettings({ allowWrite: ["/work", "/scratch"] }),
			"/home/me/project",
		);
		expect(cfg.filesystem?.allowWrite).toEqual(["/work", "/scratch"]);
	});

	it("passes allowRead / denyRead / denyWrite through verbatim", () => {
		const cfg = buildSandboxRuntimeConfig(
			makeSettings({
				allowRead: ["/work"],
				denyRead: ["/private"],
				denyWrite: [".env", "*.pem"],
			}),
			"/home/me/project",
		);
		expect(cfg.filesystem?.allowRead).toEqual(["/work"]);
		expect(cfg.filesystem?.denyRead).toEqual(["/private"]);
		expect(cfg.filesystem?.denyWrite).toEqual([".env", "*.pem"]);
	});

	it("network defaults to closed-by-default (no allowed domains)", () => {
		const cfg = buildSandboxRuntimeConfig(makeSettings(), "/home/me/project");
		expect(cfg.network?.allowedDomains).toEqual([]);
		expect(cfg.network?.deniedDomains).toEqual([]);
	});

	it("passes allowed/denied domains through", () => {
		const cfg = buildSandboxRuntimeConfig(
			makeSettings({
				allowedDomains: ["github.com", "*.npmjs.org"],
				deniedDomains: ["evil.example.com"],
			}),
			"/home/me/project",
		);
		expect(cfg.network?.allowedDomains).toEqual(["github.com", "*.npmjs.org"]);
		expect(cfg.network?.deniedDomains).toEqual(["evil.example.com"]);
	});
});

describe("detectSandboxDenial", () => {
	it("returns denied=false when isError is false, regardless of output", () => {
		const out = detectSandboxDenial(false, "blocked by network allowlist");
		expect(out.denied).toBe(false);
	});

	it("returns denied=false on a clean error (e.g. non-sandbox failure)", () => {
		const out = detectSandboxDenial(true, "TypeError: x is not a function\n  at foo\n");
		expect(out.denied).toBe(false);
	});

	it("flags ASRT network-allowlist denials", () => {
		const out = detectSandboxDenial(true, "curl: Connection blocked by network allowlist");
		expect(out.denied).toBe(true);
		expect(out.reason).toMatch(/network denied/i);
	});

	it("flags sandbox-exec POSIX errors", () => {
		const out = detectSandboxDenial(
			true,
			"cat: /Users/me/.ssh/id_rsa: Operation not permitted",
		);
		expect(out.denied).toBe(true);
		expect(out.reason).toMatch(/filesystem operation denied/i);
	});

	it("flags sandbox-exec explicit refusal banner", () => {
		const out = detectSandboxDenial(true, "sandbox-exec: deny file-write* /etc/hosts");
		expect(out.denied).toBe(true);
		expect(out.reason).toMatch(/sandbox-exec/i);
	});

	it("flags bubblewrap rejection", () => {
		const out = detectSandboxDenial(true, "bwrap: setup failed: /usr/bin is not a directory");
		expect(out.denied).toBe(true);
		expect(out.reason).toMatch(/bubblewrap/i);
	});

	it("flags seccomp syscall blocks", () => {
		const out = detectSandboxDenial(
			true,
			"socket: Operation not permitted (filtered by seccomp)",
		);
		expect(out.denied).toBe(true);
		expect(out.reason).toMatch(/seccomp/i);
	});

	it("flags ASRT proxy 'blocked by sandbox' style messages", () => {
		const out = detectSandboxDenial(true, "Request to evil.com blocked by sandbox.");
		expect(out.denied).toBe(true);
	});

	it("is case-insensitive", () => {
		const out = detectSandboxDenial(true, "OPERATION NOT PERMITTED");
		expect(out.denied).toBe(true);
	});
});

describe("extractDeniedPathFromStderr", () => {
	it("extracts /Users/... from a bash redirection refusal", () => {
		const path = extractDeniedPathFromStderr(
			"/bin/bash: /Users/yonilerner/.ssh/test-do-not-keep: Operation not permitted",
		);
		expect(path).toBe("/Users/yonilerner/.ssh/test-do-not-keep");
	});

	it("extracts /etc/passwd from a cat refusal", () => {
		const path = extractDeniedPathFromStderr("cat: /etc/passwd: Operation not permitted");
		expect(path).toBe("/etc/passwd");
	});

	it("extracts the path from tee output even with prefix lines", () => {
		const output = [
			"some other prefix output",
			"tee: /opt/deploy/release.sh: Operation not permitted",
		].join("\n");
		const path = extractDeniedPathFromStderr(output);
		expect(path).toBe("/opt/deploy/release.sh");
	});

	it("returns undefined when the stderr has no 'Operation not permitted' line", () => {
		const path = extractDeniedPathFromStderr("connection refused\nexit 1");
		expect(path).toBeUndefined();
	});

	it("returns undefined for an empty string", () => {
		expect(extractDeniedPathFromStderr("")).toBeUndefined();
	});

	it("matches case-insensitively on the 'Operation not permitted' suffix", () => {
		const path = extractDeniedPathFromStderr("rm: /tmp/scratch: operation not permitted");
		expect(path).toBe("/tmp/scratch");
	});

	it("returns the FIRST matching path when multiple are denied", () => {
		const output = [
			"cat: /etc/shadow: Operation not permitted",
			"cat: /etc/passwd: Operation not permitted",
		].join("\n");
		expect(extractDeniedPathFromStderr(output)).toBe("/etc/shadow");
	});
});

describe("buildRetryReason", () => {
	it("uses the network-attempt host list when the denial is network-shaped", () => {
		const reason = buildRetryReason(
			"network denied by sandbox",
			"", // stderr empty on network denials (real ASRT behavior)
			[{ host: "collector.example.com", port: 443, at: 0 }],
		);
		expect(reason).toContain("network access");
		expect(reason).toContain("collector.example.com:443");
	});

	it("does NOT phrase the message as a question ('Retry without sandbox?' regressed the reviewer)", () => {
		const forms = [
			buildRetryReason("network denied by sandbox", "", [{ host: "x.com", port: 80, at: 0 }]),
			buildRetryReason("network denied by sandbox", "", []),
			buildRetryReason("filesystem operation denied by sandbox", "cat: /a: Operation not permitted", []),
			buildRetryReason("x", "y", []),
		];
		for (const r of forms) expect(r).not.toContain("?");
	});

	it("joins multiple captured hosts when the command attempted several", () => {
		const reason = buildRetryReason(
			"network denied by sandbox",
			"",
			[
				{ host: "a.example.com", port: 443, at: 0 },
				{ host: "b.example.com", port: 80, at: 0 },
			],
		);
		expect(reason).toContain("a.example.com:443");
		expect(reason).toContain("b.example.com:80");
	});

	it("falls back to a host-less network message when no hosts were captured", () => {
		// e.g. DNS-only failure or raw `nc` by hostname — never reaches the proxy.
		const reason = buildRetryReason("network denied by sandbox", "", []);
		expect(reason).toMatch(/sandbox denied network access\./i);
	});

	it("omits ports when the captured attempt has no port", () => {
		const reason = buildRetryReason(
			"network denied by sandbox",
			"",
			[{ host: "example.com", port: undefined, at: 0 }],
		);
		expect(reason).toContain("example.com");
		expect(reason).not.toContain("example.com:");
	});

	it("uses the extracted filesystem path for FS denials", () => {
		const reason = buildRetryReason(
			"filesystem operation denied by sandbox",
			"cat: /etc/passwd: Operation not permitted",
			[],
		);
		expect(reason).toContain("/etc/passwd");
		expect(reason).toMatch(/filesystem/i);
	});

	it("falls back to the generic phrase when neither path nor host is known", () => {
		const reason = buildRetryReason(
			"sandbox denial recorded by ASRT violation store",
			"some opaque error",
			[],
		);
		expect(reason).toMatch(/sandbox denied this command/i);
	});

	it("never returns an empty string", () => {
		const reason = buildRetryReason("anything", "", []);
		expect(reason.length).toBeGreaterThan(0);
	});
});

describe("getNetworkAttemptsSince ring buffer", () => {
	afterEach(() => {
		_resetNetworkAttemptsForTest();
	});

	it("returns an empty array when no attempts have been recorded", () => {
		expect(getNetworkAttemptsSince(0)).toEqual([]);
	});

	// We cannot directly inject into the ring buffer from outside (the
	// `recordingAskCallback` is module-private). The buffer is exercised by
	// the live integration smoke test in /tmp/pi-agent/sandbox-smoke-dir
	// (manual) and by the live-test 5x run via real sandbox-wrapped commands.
	// For unit-test purposes we only need to confirm the helper exists and
	// returns the right shape; the recording path is covered structurally.
});
