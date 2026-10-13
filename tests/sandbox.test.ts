import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxSettings } from "../extensions/types.ts";

const manager = vi.hoisted(() => ({
	isSupportedPlatform: vi.fn(() => true),
	checkDependencies: vi.fn(() => ({ errors: [] as string[], warnings: [] as string[] })),
	initialize: vi.fn(async (_config: unknown, _callback: (params: { host: string; port: number }) => Promise<boolean>, _monitor: boolean) => {}),
	reset: vi.fn(async () => {}),
	wrapWithSandbox: vi.fn(async (command: string, _shell?: string, _config?: unknown, _signal?: AbortSignal) => `wrapped(${command})`),
	annotateStderrWithSandboxFailures: vi.fn((_command: string, output: string) => output),
	cleanupAfterCommand: vi.fn(() => {}),
}));
vi.mock("@foxfirecodes/sandbox-runtime", () => ({ SandboxManager: manager, getDefaultWritePaths: () => ["/dev/null", "/tmp/claude"] }));
import { buildSandboxConfig, prepareSandboxCommand, sandboxDenialEvidence, shutdownSandbox } from "../extensions/sandbox.ts";

const settings: SandboxSettings = { allowedDomains: [], deniedDomains: [], allowRead: [], denyRead: [], allowWrite: [], denyWrite: [] };
const directories: string[] = [];
async function directory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "pi-auto-sandbox-test-"));
	directories.push(path);
	return path;
}
beforeEach(() => { vi.clearAllMocks(); });
afterEach(async () => { await shutdownSandbox(); await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("sandbox preparation around the existing executor", () => {
	it("uses absolute scopes, private temporary storage, and owner restrictions", () => {
		const config = buildSandboxConfig({ command: "pwd", cwd: "/project", sandbox: { ...settings, allowWrite: ["build"], denyWrite: ["locked"], denyRead: ["secrets"] }, protectedPaths: ["AGENTS.md"], sensitivePaths: [".env"] }, "/private-temp");
		expect(config.filesystem).toEqual({ allowRead: [], denyRead: ["/project/secrets", "/project/.env", "/project/**/.env"], allowWrite: ["/project", "/private-temp", "/project/build"], denyWrite: ["/project/locked", "/project/AGENTS.md"] });
		expect(config.network.allowedDomains).toEqual([]);
	});
	it("normalizes only exact canonical configured read exceptions", async () => {
		const cwd = await directory();
		await writeFile(join(cwd, "specific"), "fixture");
		await symlink("specific", join(cwd, "alias"));
		const config = buildSandboxConfig({ command: "pwd", cwd, sandbox: { ...settings, denyRead: ["broad", "alias", "specific/child", "glob-*"], allowRead: ["specific"] }, sensitivePaths: ["specific"] }, "/private-temp");
		expect(config.filesystem.allowRead).toEqual([join(cwd, "specific")]);
		expect(config.filesystem.denyRead).toEqual([join(cwd, "broad"), join(cwd, "specific/child"), join(cwd, "glob-*"), join(cwd, "specific"), join(cwd, "**/specific")]);
	});
	it("prepares once and returns a denial without starting or replaying execution", async () => {
		const prepared = await prepareSandboxCommand({ cwd: await directory(), command: "printf once >> effects", sandbox: settings });
		expect(prepared.command).toContain("printf once >> effects");
		expect(await prepared.finish("Operation not permitted", true)).toMatchObject({ blocked: true });
		expect(manager.wrapWithSandbox).toHaveBeenCalledOnce();
		expect(manager.cleanupAfterCommand).toHaveBeenCalledOnce();
		expect(manager.reset).toHaveBeenCalledOnce();
	});
	it("correlates unique commands and isolates proxy callbacks after cleanup", async () => {
		const cwd = await directory();
		const first = await prepareSandboxCommand({ cwd, command: "printf hello", sandbox: settings });
		const firstCallback = manager.initialize.mock.calls[0]![1];
		expect(await firstCallback({ host: "first.invalid", port: 443 })).toBe(false);
		expect((await first.finish("output", false)).denials).toEqual(["Network access denied: first.invalid:443"]);
		const second = await prepareSandboxCommand({ cwd, command: "printf hello", sandbox: settings });
		await firstCallback({ host: "stale.invalid", port: 443 });
		expect(await second.finish("output", false)).toEqual({ blocked: false, denials: [] });
		expect(first.sandboxCommand).not.toBe(second.sandboxCommand);
		expect(manager.annotateStderrWithSandboxFailures.mock.calls.map(([command]) => command)).toEqual([first.sandboxCommand, second.sandboxCommand]);
	});
	it("rejects a second preparation promptly and allows retry after the first result", async () => {
		const options = { cwd: await directory(), command: "printf hello", sandbox: settings };
		const first = await prepareSandboxCommand(options);
		const concurrent = await Promise.race([
			prepareSandboxCommand(options).then(() => "unexpected success", (error: Error) => error.message),
			new Promise<string>((resolve) => setTimeout(() => resolve("deadlocked"), 200)),
		]);
		expect(concurrent).toContain("Run one bash command at a time");
		await first.finish("done", false);
		const retry = await prepareSandboxCommand(options);
		await retry.cancel();
		expect(manager.wrapWithSandbox).toHaveBeenCalledTimes(2);
	});
	it("cleans up after wrapping fails and permits a fresh preparation", async () => {
		const options = { cwd: await directory(), command: "printf hello", sandbox: settings };
		manager.wrapWithSandbox.mockRejectedValueOnce(new Error("wrapper failed"));
		await expect(prepareSandboxCommand(options)).rejects.toThrow("wrapper failed");
		expect(manager.cleanupAfterCommand).toHaveBeenCalledOnce();
		await (await prepareSandboxCommand(options)).cancel();
	});
	it("fails closed when dependencies are missing", async () => {
		manager.checkDependencies.mockReturnValueOnce({ errors: ["bubblewrap missing"], warnings: [] });
		await expect(prepareSandboxCommand({ cwd: await directory(), command: "printf hello", sandbox: settings })).rejects.toThrow("bubblewrap missing");
		expect(manager.wrapWithSandbox).not.toHaveBeenCalled();
	});
	it("cancellation and shutdown release each preparation at most once", async () => {
		const prepared = await prepareSandboxCommand({ cwd: await directory(), command: "printf hello", sandbox: settings });
		await prepared.cancel();
		await prepared.cancel();
		expect(manager.cleanupAfterCommand).toHaveBeenCalledOnce();
		expect(manager.reset).toHaveBeenCalledOnce();
		expect(await prepared.finish("stale output", true)).toEqual({ blocked: false, denials: [] });
	});
	it("ignores benign OS probes while retaining native denial evidence", () => {
		const original = "problem";
		const annotation = `${original}\n<sandbox_violations>\nlinux file-read denied: stat(\"/missing\") -> ENOENT\nsysctl-read kern.iossupportversion\npython(123) deny(1) file-write-create /outside/file\nlinux file-write denied: open(\"/locked\") -> EACCES\n</sandbox_violations>`;
		expect(sandboxDenialEvidence(original, annotation, true)).toEqual(["python(123) deny(1) file-write-create /outside/file", "linux file-write denied: open(\"/locked\") -> EACCES"]);
	});
});
