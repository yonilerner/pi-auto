/**
 * Sandbox runtime end-to-end probe.
 *
 * Opt-in: only runs when `PI_AUTO_SANDBOX_E2E=1`. The point of this suite is
 * to take the entire stack we wrote on top of @anthropic-ai/sandbox-runtime
 * (the recordingAskCallback, the violation-store reader, the textual
 * fallback, buildRetryReason) and exercise it against the actual sandbox
 * with real subprocess execution. The output is the ground truth for what
 * ASRT does in practice, which we've otherwise been guessing at.
 *
 * Each scenario captures a structured record:
 *
 *   {
 *     command:    "...",
 *     exitCode:   0 | 1 | ...,
 *     stdoutHead: first ~400 chars of stdout,
 *     stderrHead: first ~400 chars of stderr,
 *     callbackFires: [{ host, port }, ...],   // hosts our askCallback saw
 *     storeAddedAnnotation: bool,             // did annotateStderrWith...
 *                                             // append a <sandbox_violations>
 *                                             // block?
 *     storeAnnotationSnippet: string,         // first ~400 chars of the
 *                                             // appended block, if any
 *     detect: {
 *       denied: bool,
 *       reason: string,
 *     },
 *     retryReason: string,
 *   }
 *
 * The records are written to /tmp/pi-agent/sandbox-e2e/<timestamp>/results.json
 * and printed to stdout. The point is human review, not assertions; we keep a
 * couple of obvious assertions per scenario to catch outright breakage but
 * intentionally avoid over-asserting until we know what the real behavior is.
 *
 * Run with:
 *
 *   PI_AUTO_SANDBOX_E2E=1 npx vitest run tests/sandbox-e2e.test.ts
 *
 * Or to keep just one scenario when iterating on detection:
 *
 *   PI_AUTO_SANDBOX_E2E=1 npx vitest run tests/sandbox-e2e.test.ts -t "curl http"
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import {
	_recordingAskCallbackForTest,
	_resetNetworkAttemptsForTest,
	buildRetryReason,
	cleanupAfterSandboxCommand,
	detectSandboxDenialForCommand,
	getNetworkAttemptsSince,
	runBareCommand,
	wrapBashCommand,
} from "../extensions/sandbox.ts";

const SHOULD_RUN = process.env.PI_AUTO_SANDBOX_E2E === "1";
const RUN_DIR = path.join(
	"/tmp/pi-agent/sandbox-e2e",
	`${new Date().toISOString().replace(/[:.]/g, "-")}`,
);

interface ScenarioRecord {
	scenario: string;
	command: string;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	durationMs: number;
	stdoutHead: string;
	stderrHead: string;
	callbackFires: Array<{ host: string; port: number | undefined }>;
	storeAddedAnnotation: boolean;
	storeAnnotationSnippet: string;
	detect: { denied: boolean; reason: string };
	retryReason: string;
}

const records: ScenarioRecord[] = [];

interface SandboxConfig {
	allowedDomains?: string[];
	deniedDomains?: string[];
	allowRead?: string[];
	denyRead?: string[];
	allowWrite?: string[];
	denyWrite?: string[];
}

async function initSandbox(config: SandboxConfig): Promise<void> {
	await SandboxManager.reset().catch(() => {});
	_resetNetworkAttemptsForTest();
	const fullConfig = {
		network: {
			allowedDomains: config.allowedDomains ?? [],
			deniedDomains: config.deniedDomains ?? [],
		},
		filesystem: {
			allowRead: config.allowRead ?? [],
			denyRead: config.denyRead ?? [],
			allowWrite: config.allowWrite ?? ["."],
			denyWrite: config.denyWrite ?? [],
		},
	};
	// Use our real recordingAskCallback via the same path pi-auto uses in
	// production. The third argument enables the violation log monitor on
	// macOS so annotateStderrWithSandboxFailures has data to read.
	// Register the REAL production recordingAskCallback (not a spy) so we're
	// exercising the exact wiring pi-auto.ts uses. Layer a small forwarding
	// spy on top so the test can also see exactly what the callback received.
	await SandboxManager.initialize(
		fullConfig as unknown as Parameters<typeof SandboxManager.initialize>[0],
		async ({ host, port }) => {
			scenarioCallbackBuffer.push({ host, port });
			return await _recordingAskCallbackForTest({ host, port });
		},
		true,
	);
}

let scenarioCallbackBuffer: Array<{ host: string; port: number | undefined }> = [];

async function runScenario(args: {
	name: string;
	command: string;
	config: SandboxConfig;
	timeoutMs?: number;
}): Promise<ScenarioRecord> {
	const { name, command, config } = args;
	scenarioCallbackBuffer = [];
	await initSandbox(config);
	const start = Date.now();
	const wrapped = await wrapBashCommand(command);
	const exec = await runBareCommand(
		wrapped,
		process.cwd(),
		args.timeoutMs ? AbortSignal.timeout(args.timeoutMs) : undefined,
	);
	cleanupAfterSandboxCommand();
	const combinedOutput = `${exec.stdout}${exec.stderr}`;
	const detect = detectSandboxDenialForCommand(
		command,
		exec.exitCode !== 0 && exec.exitCode !== null,
		combinedOutput,
	);
	// Capture the production-side attempts buffer too, scoped to this command,
	// in addition to our local spy. The two should agree when our spy is what
	// was registered with ASRT.
	const productionAttempts = getNetworkAttemptsSince(start);
	// Use production attempts (the buffer pi-auto reads in tool_result) as the
	// retry-reason source so we test the exact production path.
	const retryReason = buildRetryReason(detect.reason, detect.annotatedOutput, productionAttempts);

	const record: ScenarioRecord = {
		scenario: name,
		command,
		exitCode: exec.exitCode,
		signal: exec.signal,
		durationMs: exec.durationMs,
		stdoutHead: snippet(exec.stdout, 400),
		stderrHead: snippet(exec.stderr, 400),
		callbackFires: scenarioCallbackBuffer.map((a) => ({ host: a.host, port: a.port })),
		storeAddedAnnotation: detect.annotatedOutput !== combinedOutput,
		storeAnnotationSnippet: snippet(
			detect.annotatedOutput.slice(combinedOutput.length),
			400,
		),
		detect: { denied: detect.denied, reason: detect.reason },
		retryReason,
	};

	if (productionAttempts.length !== scenarioCallbackBuffer.length) {
		record.detect = {
			...record.detect,
			reason: `${record.detect.reason} [note: prod buffer=${productionAttempts.length}, spy=${scenarioCallbackBuffer.length}]`,
		};
	}

	records.push(record);
	return record;
}

function snippet(s: string, n: number): string {
	if (s.length <= n) return s;
	return `${s.slice(0, n)}\n… [+${s.length - n} chars]`;
}

const skipIfNoE2E = SHOULD_RUN ? describe : describe.skip;

skipIfNoE2E("sandbox e2e — actual ASRT behavior", () => {
	beforeEach(() => {
		scenarioCallbackBuffer = [];
	});

	afterAll(async () => {
		await SandboxManager.reset().catch(() => {});
		mkdirSync(RUN_DIR, { recursive: true });
		const out = path.join(RUN_DIR, "results.json");
		writeFileSync(out, JSON.stringify(records, null, 2));
		const summary = path.join(RUN_DIR, "summary.md");
		writeFileSync(summary, renderSummary(records));
		// Print summary to stdout so a one-shot run shows it immediately.
		console.log(`\n${"=".repeat(70)}`);
		console.log(`sandbox e2e results written to ${out}`);
		console.log(`summary at ${summary}`);
		console.log("=".repeat(70));
		console.log(renderSummary(records));
	});

	/* -------- curl: explicit HTTP proxy path -------- */

	it("curl HTTP to disallowed host (empty allowlist)", async () => {
		await runScenario({
			name: "curl-http-disallowed",
			command: "curl -sS -I --max-time 5 http://example.com",
			config: { allowedDomains: [] },
			timeoutMs: 10_000,
		});
	}, 30_000);

	it("curl HTTPS to disallowed host (empty allowlist)", async () => {
		await runScenario({
			name: "curl-https-disallowed",
			command: "curl -sS -I --max-time 5 https://example.com",
			config: { allowedDomains: [] },
			timeoutMs: 10_000,
		});
	}, 30_000);

	it("curl HTTP to allowed host (allowlist=[example.com])", async () => {
		await runScenario({
			name: "curl-http-allowed",
			command: "curl -sS -I --max-time 5 http://example.com",
			config: { allowedDomains: ["example.com"] },
			timeoutMs: 10_000,
		});
	}, 30_000);

	/* -------- python: stdlib http.client (raw socket under the hood) -------- */

	it("python http.client to disallowed host", async () => {
		await runScenario({
			name: "python-http-client",
			command: `python3 - <<'PY'
import http.client
c = http.client.HTTPConnection("example.com", 80, timeout=3)
c.request("GET", "/")
print(c.getresponse().status)
PY`,
			config: { allowedDomains: [] },
			timeoutMs: 10_000,
		});
	}, 30_000);

	it("python raw socket.create_connection to disallowed host", async () => {
		await runScenario({
			name: "python-socket",
			command: `python3 - <<'PY'
import socket
with socket.create_connection(("example.com", 80), timeout=3) as s:
    print("connected")
PY`,
			config: { allowedDomains: [] },
			timeoutMs: 10_000,
		});
	}, 30_000);

	it("python urllib.request to disallowed host", async () => {
		await runScenario({
			name: "python-urllib",
			command: `python3 - <<'PY'
import urllib.request
urllib.request.urlopen("http://example.com", timeout=3).read()
PY`,
			config: { allowedDomains: [] },
			timeoutMs: 10_000,
		});
	}, 30_000);

	/* -------- node fetch -------- */

	it("node fetch to disallowed host", async () => {
		await runScenario({
			name: "node-fetch",
			command: `node -e "fetch('http://example.com').then(r => console.log(r.status)).catch(e => { console.error(String(e)); process.exit(1); })"`,
			config: { allowedDomains: [] },
			timeoutMs: 10_000,
		});
	}, 30_000);

	/* -------- baseline: known-good commands -------- */
	//
	// These should be "not denied" — they execute fully in the sandbox without
	// hitting any deny rule. If detect.denied comes back true for these, it
	// means the violation store is being polluted by background syscall noise
	// (sysctl-read kern.iossupportversion, mach-lookup com.apple...) and our
	// `hasStoreViolations` test produces a false positive on every command.

	it("baseline: echo hi (no sandbox interaction)", async () => {
		await runScenario({
			name: "baseline-echo",
			command: "echo hi",
			config: { allowedDomains: [] },
			timeoutMs: 10_000,
		});
	}, 30_000);

	it("baseline: ls in cwd (innocuous read)", async () => {
		await runScenario({
			name: "baseline-ls",
			command: "ls -la . | head -5",
			config: { allowedDomains: [] },
			timeoutMs: 10_000,
		});
	}, 30_000);

	it("baseline: pwd (no fs activity)", async () => {
		await runScenario({
			name: "baseline-pwd",
			command: "pwd",
			config: { allowedDomains: [] },
			timeoutMs: 10_000,
		});
	}, 30_000);

	it("baseline commands must NOT be classified as denied (noise filter)", async () => {
		// Hard regression check on the noise filter. If detect.denied is true
		// for `echo`, `ls`, or `pwd`, we're back to triggering escape review on
		// every benign bash command (the bug we shipped briefly when the
		// sandbox-on-by-default flip landed).
		const baselines = records.filter((r) => r.scenario.startsWith("baseline-"));
		expect(baselines.length).toBeGreaterThan(0);
		for (const r of baselines) {
			expect(r.detect.denied, `${r.scenario} was misclassified as a denial`).toBe(false);
			expect(r.retryReason).toBe("Sandbox denied this command.");
			// The retryReason is conceptually irrelevant when detect.denied is
			// false (production code returns before calling buildRetryReason).
			// We assert the default string just to surface accidental changes.
		}
	});

	it("network denials with captured host land in retryReason", () => {
		// Hostname must propagate end-to-end for shapes where the askCallback
		// fires (curl HTTP/HTTPS, python urllib).
		const withHost = records.filter((r) => r.callbackFires.length > 0);
		expect(withHost.length).toBeGreaterThan(0);
		for (const r of withHost) {
			const host = r.callbackFires[0]?.host;
			if (!host) continue;
			expect(r.retryReason, `${r.scenario}: host not in retryReason`).toContain(host);
			expect(r.retryReason).toContain("network access");
		}
	});

	/* -------- filesystem -------- */

	it("write outside allowed roots", async () => {
		await runScenario({
			name: "fs-write-denied",
			command: "echo hi > /etc/test-pi-auto-sandbox-e2e",
			config: { allowedDomains: [], allowWrite: ["."] },
			timeoutMs: 10_000,
		});
	}, 30_000);

	it("read of explicitly denied path", async () => {
		await runScenario({
			name: "fs-read-denied",
			command: "cat /etc/passwd",
			config: { allowedDomains: [], denyRead: ["/etc/passwd"] },
			timeoutMs: 10_000,
		});
	}, 30_000);

	it("mandatory deny .gitmodules read is annotated as file-read", async () => {
		const gitmodulesPath = path.join(process.cwd(), ".gitmodules");
		if (existsSync(gitmodulesPath)) {
			throw new Error(
				`Cannot run this e2e scenario because ${gitmodulesPath} already exists; ` +
					"it needs ASRT to create the non-existent mandatory-deny mount point.",
			);
		}
		const rec = await runScenario({
			name: "mandatory-deny-gitmodules-read",
			command: `python3 - <<'PY'
from pathlib import Path
Path('.gitmodules').read_bytes()
PY`,
			config: { allowedDomains: [], allowWrite: [process.cwd(), "/tmp"] },
			timeoutMs: 10_000,
		});
		expect(rec.detect.denied).toBe(true);
		// On Linux, ASRT may not populate the violation store for this mandatory
		// deny bind-mount shape. The viable heuristic is the narrow text fallback:
		// Permission denied/os error 13 near an ASRT mandatory-deny path.
		expect(rec.retryReason).toContain(".gitmodules");
	});

	it("python filesystem write denied (path-extraction regression)", async () => {
		// User-reported shape: Path.write_text with Python's PermissionError format.
		// The point of this scenario is the stderr SHAPE — the path appears after
		// "Operation not permitted", which the bash regex misses.
		// extractDeniedPathFromStderr should now catch it.
		const rec = await runScenario({
			name: "python-fs-write-denied",
			command: `python3 - <<'PY'
from pathlib import Path
Path('/etc/test-pi-auto-sandbox-pyfs').write_text('blocked\\n')
PY`,
			config: { allowedDomains: [], allowWrite: ["."] },
			timeoutMs: 10_000,
		});
		expect(rec.detect.denied).toBe(true);
		expect(rec.retryReason, "path should be in retryReason").toContain("/etc/test-pi-auto-sandbox-pyfs");
		expect(rec.retryReason).toContain("filesystem");
	});

	it("fs-write-denied carries the path in retryReason", () => {
		const rec = records.find((r) => r.scenario === "fs-write-denied");
		expect(rec).toBeDefined();
		if (!rec) return;
		expect(rec.detect.denied).toBe(true);
		expect(rec.retryReason).toContain("/etc/test-pi-auto-sandbox-e2e");
		expect(rec.retryReason).toContain("filesystem");
	});
});

function renderSummary(records: ScenarioRecord[]): string {
	const lines: string[] = [
		"# sandbox e2e summary",
		"",
		"| scenario | exit | callback fires | store annotation | detect.denied | detect.reason | retryReason |",
		"|---|---|---|---|---|---|---|",
	];
	for (const r of records) {
		const fires = r.callbackFires.length === 0 ? "—" : r.callbackFires.map((f) => `${f.host}:${f.port ?? "?"}`).join(", ");
		const ann = r.storeAddedAnnotation ? "yes" : "—";
		lines.push(
			`| ${r.scenario} | ${r.exitCode ?? r.signal ?? "?"} | ${fires} | ${ann} | ${r.detect.denied ? "yes" : "no"} | ${escapeMd(r.detect.reason)} | ${escapeMd(r.retryReason)} |`,
		);
	}
	lines.push("", "## raw records", "", "```json", JSON.stringify(records, null, 2), "```");
	return lines.join("\n");
}

function escapeMd(s: string): string {
	return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
