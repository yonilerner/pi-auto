/** Sandbox command preparation around pi's existing effective bash executor. */
import { randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { getDefaultWritePaths, SandboxManager, type SandboxRuntimeConfig } from "@foxfirecodes/sandbox-runtime";
import { resolvePath } from "./scope.ts";
import type { SandboxSettings } from "./types.ts";

export interface SandboxCommandOptions {
	command: string;
	cwd: string;
	signal?: AbortSignal;
	sandbox: SandboxSettings;
	protectedPaths?: string[];
	sensitivePaths?: string[];
}

export interface SandboxOutcome {
	blocked: boolean;
	denials: string[];
}

export interface PreparedSandboxCommand {
	id: string;
	/** The replacement command passed to the unchanged effective bash tool. */
	command: string;
	/** The exact command ASRT indexes for violation annotations. */
	sandboxCommand: string;
	finish(output: string, isError: boolean): Promise<SandboxOutcome>;
	cancel(): Promise<void>;
}

let queue: Promise<void> = Promise.resolve();
let initializedConfig: string | undefined;
let tempDirectory: string | undefined;
let activeCommand: { id: string; denials: string[] } | undefined;

function serialized<T>(operation: () => Promise<T>): Promise<T> {
	const result = queue.then(operation, operation);
	queue = result.then(() => {}, () => {});
	return result;
}

function pathFromCwd(path: string, cwd: string): string {
	if (path === "~") return homedir();
	return resolve(cwd, path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

function linuxTracingAvailable(): boolean {
	return (process.env.PATH ?? "").split(delimiter).some((path) => {
		try { accessSync(join(path, "strace"), constants.X_OK); return true; }
		catch { return false; }
	});
}

export function buildSandboxConfig(options: SandboxCommandOptions, temporaryPath: string): SandboxRuntimeConfig {
	if (!options.sandbox) throw new Error("Sandbox settings are required");
	const paths = (values: string[]): string[] => [...new Set(values.map((value) => pathFromCwd(value, options.cwd)))];
	// Match scope's basename rules inside the workspace. ASRT expands Linux
	// read globs at launch; macOS enforces them as profile expressions.
	const sensitiveReads = (options.sensitivePaths ?? []).flatMap((pattern) =>
		!pattern.includes("/") && !pattern.startsWith("~")
			? [pattern, join("**", pattern)]
			: [pattern]);
	const allowRead = paths(options.sandbox.allowRead);
	const exactReadExceptions = new Set(allowRead.map((path) => resolvePath(path, options.cwd)));
	// macOS re-emits nested literal denies after broad allowances. Remove only
	// exact configured exceptions so their meaning matches Linux and scope.
	const configuredReadDenies = paths(options.sandbox.denyRead).filter((path) =>
		/[*?[\]]/.test(path) || !exactReadExceptions.has(resolvePath(path, options.cwd)));
	return {
		network: { allowedDomains: options.sandbox.allowedDomains, deniedDomains: options.sandbox.deniedDomains },
		filesystem: {
			allowRead,
			denyRead: paths([...configuredReadDenies, ...sensitiveReads]),
			allowWrite: paths([options.cwd, temporaryPath, ...options.sandbox.allowWrite]),
			denyWrite: paths([...options.sandbox.denyWrite, ...(options.protectedPaths ?? [])]),
		},
	};
}

export function checkSandboxAvailability(): { available: boolean; errors: string[]; warnings: string[]; defaultWritePaths?: string[] } {
	if (!["linux", "darwin"].includes(process.platform) || !SandboxManager.isSupportedPlatform()) {
		return { available: false, errors: ["pi-auto supports sandbox execution on Linux and macOS."], warnings: [] };
	}
	const dependencies = SandboxManager.checkDependencies();
	const errors = [...dependencies.errors];
	const warnings = [...dependencies.warnings];
	if (process.platform === "linux" && !linuxTracingAvailable()) warnings.push("Linux filesystem violation tracing unavailable (install strace); denial evidence uses command errors and proxy events.");
	return { available: errors.length === 0, errors, warnings, defaultWritePaths: getDefaultWritePaths() };
}

async function ensureSandbox(config: SandboxRuntimeConfig): Promise<void> {
	const key = JSON.stringify(config);
	if (initializedConfig === key) return;
	const availability = checkSandboxAvailability();
	if (!availability.available) throw new Error(`Sandbox unavailable: ${availability.errors.join("; ")}`);
	if (initializedConfig) {
		await SandboxManager.reset();
		initializedConfig = undefined;
	}
	try {
		const owner = activeCommand;
		await SandboxManager.initialize(config, async ({ host, port }) => {
			if (owner && activeCommand === owner && owner.denials.length < 20) owner.denials.push(`Network access denied: ${host}${port ? `:${port}` : ""}`);
			return false;
		}, process.platform === "darwin" || linuxTracingAvailable());
		initializedConfig = key;
	} catch (error) {
		await SandboxManager.reset().catch(() => {});
		throw error;
	}
}

/** Only consider annotations added by the runtime; command output is evidence. */
export function sandboxDenialEvidence(stderr: string, annotated: string, failed: boolean): string[] {
	const evidence: string[] = [];
	if (annotated.startsWith(stderr)) {
		const addition = annotated.slice(stderr.length);
		for (const line of addition.split("\n")) {
			const clean = line.trim();
			if (!clean || clean.startsWith("<sandbox_violations") || clean.startsWith("</sandbox_violations")) continue;
			// These baseline OS probes do not mean a requested operation was blocked.
			if (/sysctl-read kern\.iossupportversion|mach-lookup com\.apple\.SystemConfiguration\.(?:configd|DNSConfiguration|SCNetworkReachability)/.test(clean)) continue;
			if (/^linux file-(?:read|write) denied:.*->\s*(?:ENOENT|ENXIO)\b/.test(clean)) continue;
			evidence.push(clean.slice(0, 1500));
		}
	}
	if (/x-proxy-error|blocked-by-allowlist|blocked by network allowlist/i.test(stderr)) evidence.push("Network request rejected by the sandbox proxy.");
	if (failed && /(?:^|\n)(?:bwrap|sandbox-exec):/i.test(stderr)) evidence.push("Sandbox runtime rejected execution.");
	if (failed && /permission denied|operation not permitted|read-only file system/i.test(stderr)) {
		evidence.push(`Command reported an access denial; partial effects are possible: ${stderr.slice(-1500)}`);
	}
	return [...new Set(evidence)].slice(0, 20);
}

/**
 * Reserve without waiting for another tool's result. Pi prepares every call in
 * a parallel batch before executing any; waiting across that boundary deadlocks.
 */
export async function prepareSandboxCommand(options: SandboxCommandOptions): Promise<PreparedSandboxCommand> {
	if (activeCommand) throw new Error("Another sandbox bash command is pending. Run one bash command at a time and retry after its result.");
	if (options.signal?.aborted) throw new Error("Sandbox preparation cancelled.");
	if (!options.command.trim()) throw new Error("Command must not be empty.");
	const reservation = { id: randomUUID(), denials: [] as string[] };
	activeCommand = reservation;
	return await serialized(async () => {
		try {
			tempDirectory ??= await mkdtemp(join(tmpdir(), "pi-auto-"));
			await ensureSandbox(buildSandboxConfig(options, tempDirectory));
			if (options.signal?.aborted) throw new Error("Sandbox preparation cancelled.");
			const temporary = shellQuote(tempDirectory);
			const sandboxCommand = `: pi-auto-${reservation.id}\nexport TMPDIR=${temporary} TMP=${temporary} TEMP=${temporary}\n${options.command}`;
			const command = await SandboxManager.wrapWithSandbox(sandboxCommand, "/bin/bash", undefined, options.signal);
			return {
				id: reservation.id, command, sandboxCommand,
				finish: (output, isError) => serialized(async () => {
					if (activeCommand !== reservation) return { blocked: false, denials: [] };
					const denials = [...reservation.denials];
					try {
						const annotation = SandboxManager.annotateStderrWithSandboxFailures(sandboxCommand, output);
						denials.push(...sandboxDenialEvidence(output, annotation, isError));
					} catch (error) {
						denials.push(`Sandbox diagnostics failed: ${error instanceof Error ? error.message : String(error)}`);
					} finally { await release(reservation, denials); }
					return { blocked: denials.length > 0, denials: [...new Set(denials)].slice(0, 20) };
				}),
				cancel: () => serialized(async () => { await release(reservation); }),
			};
		} catch (error) {
			await release(reservation);
			throw error;
		}
	});
}

async function release(reservation: { id: string; denials: string[] }, evidence?: string[]): Promise<void> {
	if (activeCommand !== reservation) return;
	try { SandboxManager.cleanupAfterCommand(); }
	catch (error) { evidence?.push(`Sandbox cleanup failed: ${error instanceof Error ? error.message : String(error)}`); }
	try { await SandboxManager.reset(); }
	catch (error) { evidence?.push(`Sandbox shutdown failed: ${error instanceof Error ? error.message : String(error)}`); }
	finally { initializedConfig = undefined; activeCommand = undefined; }
}

export async function shutdownSandbox(): Promise<void> {
	await serialized(async () => {
		try {
			if (activeCommand) await release(activeCommand);
			else if (initializedConfig) await SandboxManager.reset();
		}
		finally {
			initializedConfig = undefined;
			activeCommand = undefined;
			if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
			tempDirectory = undefined;
		}
	});
}
