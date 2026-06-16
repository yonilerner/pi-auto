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

import { readFileSync } from "node:fs";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	_noiseOperationsForTest,
	_resetNetworkAttemptsForTest,
	buildRetryReason,
	buildSandboxRuntimeConfig,
	detectSandboxDenial,
	detectSandboxDenialForCommand,
	extractDeniedFilesystemViolation,
	extractDeniedPathFromStderr,
	filterNoiseFromAnnotation,
	getAsrtMandatoryDenyGitExcludePatterns,
	getNetworkAttemptsSince,
	withSandboxGitExcludes,
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
		...overrides,
	};
}

describe("buildSandboxRuntimeConfig", () => {
	it("passes an empty allowWrite through verbatim", () => {
		const cfg = buildSandboxRuntimeConfig(makeSettings(), "/home/me/project");
		expect(cfg.filesystem?.allowWrite).toEqual([]);
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
	it("returns denied=false when isError is false AND the output has no hard proxy markers", () => {
		const out = detectSandboxDenial(false, "some random log line");
		expect(out.denied).toBe(false);
	});

	it("flags ASRT proxy hard markers even when isError is false (curl 403 case)", () => {
		// User-reported: curl http://blocked returned 200/403 with X-Proxy-Error
		// header but exited 0. We must still flag this as a sandbox denial.
		const stdout = "HTTP/1.1 403 Forbidden\nX-Proxy-Error: blocked-by-allowlist\n";
		const out = detectSandboxDenial(false, stdout);
		expect(out.denied).toBe(true);
		expect(out.reason).toMatch(/network/i);
	});

	it("flags hyphenated 'blocked-by-allowlist' (ASRT's actual header text)", () => {
		// Earlier draft only looked for the space-separated 'blocked by network
		// allowlist' which doesn't match ASRT's actual output. Make sure both
		// spellings hit.
		const out = detectSandboxDenial(true, "X-Proxy-Error: blocked-by-allowlist");
		expect(out.denied).toBe(true);
		expect(out.reason).toMatch(/network/i);
	});

	it("flags Python gaierror as a DNS-blocked-by-sandbox denial", () => {
		const stderr = "socket.gaierror: [Errno 8] nodename nor servname provided, or not known";
		const out = detectSandboxDenial(true, stderr);
		expect(out.denied).toBe(true);
		expect(out.reason).toMatch(/dns|network/i);
	});

	it("flags Node's ENOTFOUND as a DNS denial", () => {
		const stderr = "Error: getaddrinfo ENOTFOUND example.com";
		const out = detectSandboxDenial(true, stderr);
		expect(out.denied).toBe(true);
	});

	it("flags curl's 'Could not resolve host' as a DNS denial", () => {
		const stderr = "curl: (6) Could not resolve host: example.com";
		const out = detectSandboxDenial(true, stderr);
		expect(out.denied).toBe(true);
	});

	it("flags Node default fetch's generic 'fetch failed' (proxy unreachable) as network", () => {
		const stderr = "TypeError: fetch failed";
		const out = detectSandboxDenial(true, stderr);
		expect(out.denied).toBe(true);
		expect(out.reason).toMatch(/network/i);
	});

	it("flags Node listen EPERM as a local bind denial, not filesystem", () => {
		const stderr = [
			"Error: listen EPERM: operation not permitted 0.0.0.0",
			"    at Server.setupListenHandle [as _listen2] (node:net:1915:21)",
			"  syscall: 'listen',",
			"  address: '0.0.0.0'",
		].join("\n");
		const out = detectSandboxDenial(true, stderr);
		expect(out.denied).toBe(true);
		expect(out.reason).toMatch(/bind|listen/i);
		expect(out.reason).not.toMatch(/filesystem/i);
	});

	it("flags ASRT network-bind annotations as local bind denials", () => {
		const annotated = [
			"<sandbox_violations>",
			"node(70848) deny(1) network-bind local:*:0",
			"</sandbox_violations>",
		].join("\n");
		const out = detectSandboxDenial(true, annotated);
		expect(out.denied).toBe(true);
		expect(out.reason).toMatch(/bind|listen/i);
	});

	it("flags curl's 'CONNECT tunnel failed' (proxy denied HTTPS CONNECT)", () => {
		const stderr = "curl: (56) CONNECT tunnel failed, response 403";
		const out = detectSandboxDenial(true, stderr);
		expect(out.denied).toBe(true);
		expect(out.reason).toMatch(/network|proxy/i);
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

	it("does not mistake Node listen EPERM for a filesystem path", () => {
		const stderr = [
			"Error: listen EPERM: operation not permitted 0.0.0.0",
			"    at Server.setupListenHandle [as _listen2] (node:net:1915:21)",
			"  code: 'EPERM',",
			"  syscall: 'listen',",
			"  address: '0.0.0.0'",
		].join("\n");
		expect(extractDeniedPathFromStderr(stderr)).toBeUndefined();
	});

	it("returns undefined for an empty string", () => {
		expect(extractDeniedPathFromStderr("")).toBeUndefined();
	});

	it("matches case-insensitively on the 'Operation not permitted' suffix", () => {
		const path = extractDeniedPathFromStderr("rm: /tmp/scratch: operation not permitted");
		expect(path).toBe("/tmp/scratch");
	});

	it("extracts the path from a Python PermissionError (path AFTER 'Operation not permitted')", () => {
		// Bug reported: Python's pathlib / OSError format puts the path on
		// the right side of the colon, not the left. The bash regex misses
		// this. Make sure the extended regex catches it.
		const stderr = `Traceback (most recent call last):
  File "<stdin>", line 2, in <module>
PermissionError: [Errno 1] Operation not permitted: '/tmp/pi-agent/sandbox-should-block'`;
		expect(extractDeniedPathFromStderr(stderr)).toBe("/tmp/pi-agent/sandbox-should-block");
	});

	it("extracts the path from a Python PermissionError with double-quoted path", () => {
		const stderr = `PermissionError: [Errno 1] Operation not permitted: "/etc/shadow"`;
		expect(extractDeniedPathFromStderr(stderr)).toBe("/etc/shadow");
	});

	it("falls back to the ASRT violation store file-write-create line when no shell-shape match", () => {
		// Some commands don't write to stderr in either bash or Python format,
		// but the annotated violation store has a `file-write-create` line
		// with the absolute path. That's the cleanest signal when stderr is
		// uninformative; we parse it out as a last resort.
		const annotated = [
			"<sandbox_violations>",
			"node(123) deny(1) file-write-create /private/tmp/foo/bar",
			"</sandbox_violations>",
		].join("\n");
		expect(extractDeniedPathFromStderr(annotated)).toBe("/private/tmp/foo/bar");
		expect(extractDeniedFilesystemViolation(annotated)).toEqual({
			operation: "file-write-create",
			access: "write",
			path: "/private/tmp/foo/bar",
		});
	});

	it("also matches file-read-data entries", () => {
		const annotated = [
			"<sandbox_violations>",
			"cat(123) deny(1) file-read-data /etc/secret",
			"</sandbox_violations>",
		].join("\n");
		expect(extractDeniedPathFromStderr(annotated)).toBe("/etc/secret");
	});

	it("returns the FIRST matching path when multiple are denied", () => {
		const output = [
			"cat: /etc/shadow: Operation not permitted",
			"cat: /etc/passwd: Operation not permitted",
		].join("\n");
		expect(extractDeniedPathFromStderr(output)).toBe("/etc/shadow");
	});
});

describe("detectSandboxDenialForCommand", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("classifies mandatory-deny Permission denied output as a sandbox denial", () => {
		const output = [
			"Error: Could not read '.gitmodules' file",
			"",
			"Caused by:",
			"    Permission denied (os error 13)",
		].join("\n");
		const out = detectSandboxDenialForCommand("but status -fv", true, output);
		expect(out.denied).toBe(true);
		expect(out.reason).toBe("filesystem operation denied by sandbox");
		expect(buildRetryReason(out.reason, out.annotatedOutput, [])).toContain(".gitmodules");
	});

	it("classifies ASRT file-read/file-write annotations as sandbox denials", () => {
		vi.spyOn(SandboxManager, "annotateStderrWithSandboxFailures").mockReturnValue(
			[
				"Could not read '.gitmodules' file",
				"Caused by:",
				"    Permission denied (os error 13)",
				"<sandbox_violations>",
				"but(123) deny(1) file-read-data /home/me/repo/.gitmodules",
				"</sandbox_violations>",
			].join("\n"),
		);

		const out = detectSandboxDenialForCommand(
			"but status -fv",
			true,
			"Could not read '.gitmodules' file\nCaused by:\n    Permission denied (os error 13)",
		);

		expect(out.denied).toBe(true);
		expect(out.reason).toBe("filesystem operation denied by sandbox");
		expect(out.annotatedOutput).toContain("file-read-data /home/me/repo/.gitmodules");
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

	it("uses captured hosts even when the denial label is the generic store string", () => {
		// Bug reported: curl HTTPS to example.com fires the askCallback (so
		// we DO have the host) but the violation-store detection labels the
		// denial as the generic 'sandbox denial recorded by ASRT violation
		// store' string. The earlier shape gated network-attempt usage on a
		// regex that didn't match that label, dropping the host info. Make
		// sure the host wins regardless of the label.
		const reason = buildRetryReason(
			"sandbox denial recorded by ASRT violation store",
			"HTTP/1.1 403 Forbidden\nX-Proxy-Error: blocked-by-allowlist",
			[{ host: "example.com", port: 443, at: 0 }],
		);
		expect(reason).toContain("network access");
		expect(reason).toContain("example.com:443");
	});

	it("uses captured hosts even when the denial label is filesystem-flavored", () => {
		// Defensive: if the textual detection mislabels a network denial as fs
		// (e.g. due to incidental "Operation not permitted" in unrelated
		// output), captured hosts are still the strongest signal we have.
		const reason = buildRetryReason(
			"filesystem operation denied by sandbox",
			"random output",
			[{ host: "api.example.com", port: 80, at: 0 }],
		);
		expect(reason).toContain("api.example.com:80");
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

	it("uses a local socket/listen message for Node listen EPERM", () => {
		const reason = buildRetryReason(
			"local socket/listen denied by sandbox",
			"Error: listen EPERM: operation not permitted /tmp/claude/tsx-501/88742.pipe",
			[],
		);
		expect(reason).toMatch(/local socket\/listen access/i);
		expect(reason).not.toMatch(/filesystem/i);
		expect(reason).not.toContain("listen EPERM");
	});

	it("uses a local socket/listen message for ASRT network-bind annotations", () => {
		const reason = buildRetryReason(
			"sandbox denial recorded by ASRT violation store",
			"<sandbox_violations>\nnode(1) deny(1) network-bind local:*:0\n</sandbox_violations>",
			[],
		);
		expect(reason).toMatch(/local socket\/listen access/i);
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

	it("uses the ASRT violation path before a higher-level stderr path", () => {
		const output = [
			"sqlite: /Users/me/repo/.git/gitbutler/but.sqlite: Operation not permitted",
			"<sandbox_violations>",
			"gitbutler-tauri(123) deny(1) file-write-create /Users/me/repo/.git/gitbutler/but.sqlite-wal",
			"</sandbox_violations>",
		].join("\n");
		const reason = buildRetryReason("filesystem operation denied by sandbox", output, []);
		expect(reason).toContain("/Users/me/repo/.git/gitbutler/but.sqlite-wal");
		expect(reason).toContain("file-write-create");
		expect(reason).not.toMatch(/but\.sqlite[:.]/);
	});

	it("includes filesystem access type and operation when ASRT reports them", () => {
		const reason = buildRetryReason(
			"sandbox denial recorded by ASRT violation store",
			"<sandbox_violations>\ncat(1) deny(1) file-read-data /etc/secret\n</sandbox_violations>",
			[],
		);
		expect(reason).toBe("Sandbox denied filesystem read access to /etc/secret (file-read-data).");
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

describe("filterNoiseFromAnnotation", () => {
	const NOISE = _noiseOperationsForTest();

	it("is a no-op when there is no <sandbox_violations> block", () => {
		const input = "some stderr\nno block here";
		expect(filterNoiseFromAnnotation(input, input)).toBe(input);
	});

	it("returns the verbatim original when every entry is known noise", () => {
		// Reproduces the baseline-echo / baseline-ls / baseline-pwd shape from
		// the e2e: every command on macOS picks up sysctl-read noise. We don't
		// want this to fire detectSandboxDenialForCommand. The function MUST
		// return the exact `original` text so the equality check downstream
		// sees no diff.
		const original = "hi\n";
		const annotated = [
			"hi\n",
			"<sandbox_violations>",
			"sh(1) deny(1) sysctl-read kern.iossupportversion",
			"bash(1) deny(1) sysctl-read kern.iossupportversion",
			"curl(1) deny(1) mach-lookup com.apple.SystemConfiguration.configd",
			"</sandbox_violations>",
		].join("\n");
		expect(filterNoiseFromAnnotation(annotated, original)).toBe(original);
	});

	it("keeps real entries even when mixed with noise (python-urllib shape)", () => {
		const original = "stderr text\n";
		const annotated = `${original}<sandbox_violations>\nsh(1) deny(1) sysctl-read kern.iossupportversion\nbash(1) deny(1) sysctl-read kern.iossupportversion\nPython(2) deny(1) sysctl-read kern.iossupportversion\nPython(2) deny(1) network-outbound\nPython(2) deny(1) network-outbound\n</sandbox_violations>`;
		const filtered = filterNoiseFromAnnotation(annotated, original);
		expect(filtered).not.toBe(original);
		expect(filtered).toContain("<sandbox_violations>");
		expect(filtered).toContain("network-outbound");
		expect(filtered).not.toContain("sysctl-read");
	});

	it("keeps file-write-create even when surrounded by noise (sandbox-should-block shape)", () => {
		// The exact shape the user pasted from a real escape-review:
		// noise + a real file-write-create line. Noise gets dropped; the real
		// signal survives.
		const original = "Traceback ...\n";
		const annotated = `${original}<sandbox_violations>\nsh(96916) deny(1) sysctl-read kern.iossupportversion\nbash(96916) deny(1) sysctl-read kern.iossupportversion\npython3.11(96982) deny(1) sysctl-read kern.iossupportversion\npython3.11(96982) deny(1) file-write-create /private/tmp/pi-agent/sandbox-should-block\n</sandbox_violations>`;
		const filtered = filterNoiseFromAnnotation(annotated, original);
		expect(filtered).not.toBe(original);
		expect(filtered).toContain("file-write-create");
		expect(filtered).toContain("/private/tmp/pi-agent/sandbox-should-block");
		expect(filtered).not.toContain("sysctl-read");
	});

	it("covers every known-noise marker without filtering anything informative", () => {
		// Sanity check on the noise table itself: every entry should look like
		// a benign per-process sandbox query, not anything related to what the
		// command was trying to achieve.
		expect(NOISE.length).toBeGreaterThan(0);
		for (const op of NOISE) {
			expect(op).toMatch(/^(?:sysctl-read|mach-lookup)/);
		}
	});
});

describe("sandbox git excludes", () => {
	it("derives git-ignore patterns from ASRT's mandatory deny list", () => {
		const patterns = getAsrtMandatoryDenyGitExcludePatterns();
		expect(patterns).toContain(".bashrc");
		expect(patterns).toContain(".gitconfig");
		expect(patterns).toContain(".mcp.json");
		expect(patterns).toContain(".vscode");
		expect(patterns).toContain(".idea");
		expect(patterns).toContain(".claude/agents");
		expect(patterns).toContain(".claude/commands");
		expect(patterns).not.toContain(".git");
	});

	it("injects a generated core.excludesFile into the inherited command environment", () => {
		const oldCount = process.env.GIT_CONFIG_COUNT;
		process.env.GIT_CONFIG_COUNT = "2";
		try {
			const wrapped = withSandboxGitExcludes("git status", process.cwd());
			expect(wrapped).toContain("export GIT_CONFIG_COUNT='3'");
			expect(wrapped).toContain("export GIT_CONFIG_KEY_2='core.excludesFile'");
			expect(wrapped).toContain("\ngit status");
			const excludePath = /export GIT_CONFIG_VALUE_2='([^']+)'/.exec(wrapped)?.[1];
			expect(excludePath).toBeTruthy();
			const content = readFileSync(excludePath as string, "utf8");
			expect(content).toContain(".bashrc");
			expect(content).toContain(".claude/agents");
		} finally {
			if (oldCount === undefined) {
				delete process.env.GIT_CONFIG_COUNT;
			} else {
				process.env.GIT_CONFIG_COUNT = oldCount;
			}
		}
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
