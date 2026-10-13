import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import type { ActionResources, ReviewableAction, ScopeDecision, Settings } from "./types.ts";

interface ToolEvent {
	toolName: string;
	toolCallId: string;
	input: Record<string, unknown>;
}

export interface BashDirective {
	command: string;
	execution: "sandbox" | "host";
	reason?: string;
	error?: string;
}

/** Host access is a first-line comment, so existing bash schemas stay intact. */
export function parseBashDirective(command: string): BashDirective {
	const firstLine = command.split(/\r?\n/, 1)[0] ?? "";
	if (!/^# pi-auto: host(?:[ \t]|$)/.test(firstLine)) return { command, execution: "sandbox", ...(!command.trim() ? { error: "Bash command must not be empty." } : {}) };
	const reason = firstLine.slice("# pi-auto: host".length).trim();
	const body = command.slice(firstLine.length).replace(/^\r?\n/, "");
	if (!reason) return { command: body, execution: "host", error: "Full host requests need a reason on the first line: # pi-auto: host <reason>." };
	if (!body.trim()) return { command: body, execution: "host", reason, error: "A full host request must include a command after its first-line directive." };
	return { command: body, execution: "host", reason };
}

/** Canonicalize existing ancestors too, so a new file under a symlink is scoped correctly. */
export function resolvePath(target: string, cwd: string): string {
	const expanded = target === "~" ? homedir() : target.startsWith("~/") ? path.join(homedir(), target.slice(2)) : target;
	let ancestor = path.resolve(cwd, expanded);
	const suffix: string[] = [];
	while (!existsSync(ancestor)) {
		const parent = path.dirname(ancestor);
		if (parent === ancestor) break;
		suffix.unshift(path.basename(ancestor));
		ancestor = parent;
	}
	try { ancestor = realpathSync(ancestor); } catch { /* Broken links still require conservative review. */ }
	return path.join(ancestor, ...suffix);
}

export function isInsidePath(target: string, root: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function protectedWritePaths(cwd: string, settings: Settings): string[] {
	const agentDirs = [process.env.PI_AGENT_DIR, process.env.PI_CODING_AGENT_DIR, path.join(homedir(), ".pi", "agent")].filter((value): value is string => Boolean(value));
	return [...new Set([
		...settings.protectedPaths,
		...settings.sandbox.denyWrite,
		path.join(cwd, ".agents", "pi-auto-v2.json"),
		path.join(cwd, ".agents", "pi-auto-v2"),
		path.join(cwd, ".agents", "pi-auto.json"),
		...agentDirs.flatMap((agentDir) => [path.join(agentDir, "pi-auto-v2.json"), path.join(agentDir, "pi-auto-v2"), path.join(agentDir, "extensions", "pi-auto.json")]),
	].map((target) => resolvePath(target, cwd)))];
}

export function isSensitivePath(target: string, cwd: string, settings: Settings): boolean {
	return settings.sensitivePaths.some((pattern) => matchesPattern(target, pattern, cwd));
}

export function decideScope(event: ToolEvent, cwd: string, settings: Settings, description = ""): ScopeDecision {
	const { toolName, input } = event;
	const bash = toolName === "bash" ? parseBashDirective(typeof input.command === "string" ? input.command : "") : undefined;
	if (bash?.error) return { kind: "block", reason: bash.error };
	const resources: ActionResources = { reads: [], writes: [], sensitive: [], protected: [] };
	const readInputs: string[] = [];
	const action: ReviewableAction = {
		toolName,
		toolCallId: event.toolCallId,
		description,
		input: bash ? { ...input, command: bash.command } : input,
		cwd: resolvePath(cwd, cwd),
		label: `${toolName}: ${String(bash?.command ?? input.path ?? input.pattern ?? "").slice(0, 180)}`,
		execution: bash?.execution ?? "tool",
		resources,
		...(bash?.reason ? { reason: bash.reason } : {}),
	};
	const review = (reason: string): ScopeDecision => ({ kind: "review", action: { ...action, reason: [action.reason, reason].filter(Boolean).join("; ") } });
	const protectedPaths = protectedWritePaths(cwd, settings);
	const inspectRead = (target: string): void => {
		readInputs.push(target);
		const resolved = resolvePath(target, cwd);
		resources.reads.push(resolved);
		if (isSensitivePath(target, cwd, settings)) resources.sensitive.push(resolved);
		if (protectedPaths.some((root) => isInsidePath(resolved, root))) resources.protected.push(resolved);
	};
	const inspectWrite = (target: string): void => {
		const resolved = resolvePath(target, cwd);
		resources.writes.push(resolved);
		if (isSensitivePath(target, cwd, settings)) resources.sensitive.push(resolved);
		if (protectedPaths.some((root) => isInsidePath(resolved, root))) resources.protected.push(resolved);
	};
	const readDenied = (): boolean => readInputs.some((target) => settings.sandbox.denyRead.some((denied) => {
		const deniedRoot = resolvePath(denied, cwd);
		if (!matchesPattern(target, deniedRoot, cwd)) return false;
		// ASRT restores allowRead exceptions inside a denied region. An allowance
		// for a parent cannot remove a more specific child/file deny.
		return !settings.sandbox.allowRead.some((allowed) => {
			const allowedRoot = resolvePath(allowed, cwd);
			return matchesPattern(target, allowedRoot, cwd) && matchesPattern(allowed, deniedRoot, cwd);
		});
	}));
	const ordinaryReads = (): boolean => resources.reads.length > 0 && resources.reads.every((target) => isInsidePath(target, action.cwd)) && !resources.sensitive.length && !resources.protected.length;

	if (toolName === "bash") {
		const command = bash!.command;
		const argv = plainArgv(command);
		const executable = argv?.[0];
		const name = executable && trustedExecutable(executable, cwd) ? path.basename(executable) : "";
		const args = argv?.slice(1) ?? [];
		const readTargets = readCommandTargets(name, args);
		if (readTargets) readTargets.forEach(inspectRead);
		const lexicalTargets = (command.match(/[^\s'";|&<>(){},]+/g) ?? []).filter((token) => !token.startsWith("-") && token !== ">" && token !== "=");
		if (!readTargets) {
			for (const target of lexicalTargets) {
				if (isSensitivePath(target, cwd, settings) || settings.sandbox.denyRead.some((root) => matchesPattern(target, resolvePath(root, cwd), cwd))) inspectRead(target);
			}
		}
		// Obvious protected-path mutations are blocked even for full-host requests.
		// Arbitrary program effects remain opaque and require the reviewer/sandbox.
		if (!readTargets && potentialMutation(command)) {
			for (const root of protectedPaths) {
				const relative = path.relative(action.cwd, root);
				const mentioned = command.includes(root) || (relative && !relative.startsWith("..") && command.includes(relative)) || lexicalTargets.some((target) => {
					const resolved = resolvePath(target, cwd);
					return isInsidePath(resolved, root) || isInsidePath(root, resolved);
				});
				if (mentioned) { resources.protected.push(root); resources.writes.push(root); }
			}
		}
		if (resources.writes.length && resources.protected.length) return { kind: "block", reason: "This command refers to modifying an owner-protected path." };
		if (readDenied()) return { kind: "block", reason: "This command reads a configured denied path." };
		if (action.execution === "host") return review("Full host execution requires authorization review.");
		if (!argv || !name) return review("Command syntax or executable is outside the routine fast path.");
		if (resources.sensitive.length || resources.protected.length) return review("Command accesses sensitive or protected files.");
		if ((name === "pwd" && args.length === 0) || (["true", "false"].includes(name) && args.length === 0) || name === "echo") return { kind: "skip", reason: "Routine command with no file or network effects." };
		if (name === "ls") {
			const targets = args.filter((arg) => !arg.startsWith("-"));
			if (targets.every((target) => isInsidePath(resolvePath(target, cwd), action.cwd))) return { kind: "skip", reason: "Workspace file listing." };
		}
		// rg can launch configured preprocessors through RIPGREP_CONFIG_PATH.
		// Keep resource inspection, but never infer read-only behavior from argv alone.
		if (name !== "rg" && readTargets && ordinaryReads() && (name !== "grep" || resources.reads.every(isFile))) return { kind: "skip", reason: "Explicit reads of ordinary workspace files." };
		return review("Command effects need authorization assessment.");
	}

	const target = typeof input.path === "string" ? input.path : undefined;
	if (toolName === "write" || toolName === "edit") {
		if (target) inspectWrite(target);
		if (resources.protected.length) return { kind: "block", reason: "Owner-protected paths cannot be changed by an agent tool." };
		if (target && isInsidePath(resolvePath(target, cwd), action.cwd) && !resources.sensitive.length) return { kind: "skip", reason: "Ordinary workspace edit." };
		return review("Write is outside the workspace, sensitive, or has no concrete target.");
	}
	if (toolName === "read") {
		if (target) inspectRead(target);
		if (readDenied()) return { kind: "block", reason: "The target is in a configured denied-read path." };
		if (ordinaryReads()) return { kind: "skip", reason: "Ordinary workspace read." };
		return review("Read is outside the workspace, sensitive, or protected.");
	}
	if (toolName === "grep") {
		if (target) inspectRead(target);
		if (readDenied()) return { kind: "block", reason: "The search target is in a configured denied-read path." };
		if (target && isFile(resolvePath(target, cwd)) && ordinaryReads()) return { kind: "skip", reason: "Search in an explicit ordinary workspace file." };
		return review("A content search may include sensitive files.");
	}
	if (toolName === "ls" || toolName === "find") {
		if (target && isInsidePath(resolvePath(target, cwd), action.cwd)) return { kind: "skip", reason: "Workspace filename listing." };
		return review("File listing is outside the workspace or has no concrete target.");
	}
	return review("Custom and MCP tools always receive automatic review.");
}

function matchesPattern(target: string, pattern: string, cwd: string): boolean {
	const resolved = resolvePath(target, cwd);
	const expanded = target.startsWith("~/") ? path.join(homedir(), target.slice(2)) : target;
	const logical = path.resolve(cwd, expanded);
	if (!pattern.includes("/") && !pattern.startsWith("~")) {
		const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
		const regex = new RegExp(`^${escaped}$`, "i");
		return [resolved, logical].some((candidate) => candidate.split(path.sep).some((segment) => regex.test(segment)));
	}
	if (/[?*]/.test(pattern)) {
		const absolutePattern = resolvePath(pattern, cwd).split(path.sep).join("/");
		let source = "";
		for (let index = 0; index < absolutePattern.length; index++) {
			const char = absolutePattern[index]!;
			if (char === "*" && absolutePattern[index + 1] === "*") {
				index++;
				if (absolutePattern[index + 1] === "/") { index++; source += "(?:[^/]+/)*"; }
				else source += ".*";
			} else if (char === "*") source += "[^/]*";
			else if (char === "?") source += "[^/]";
			else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		}
		const regex = new RegExp(`^${source}(?:/.*)?$`, "i");
		return [resolved, logical].some((candidate) => regex.test(candidate.split(path.sep).join("/")));
	}
	return isInsidePath(resolved, resolvePath(pattern, cwd));
}

function isFile(target: string): boolean {
	try { return statSync(target).isFile(); } catch { return false; }
}

/** A deliberately small parser: any shell control, expansion, or glob goes to review. */
function plainArgv(command: string): string[] | undefined {
	if (/[\n\r$`;&|<>(){}*?\[\]\\#]/.test(command)) return undefined;
	const tokens: string[] = [];
	let token = "";
	let quote = "";
	let inToken = false;
	for (const char of command.trim()) {
		if (quote) { if (char === quote) quote = ""; else token += char; inToken = true; }
		else if (char === "'" || char === '"') { quote = char; inToken = true; }
		else if (/\s/.test(char)) { if (inToken) { tokens.push(token); token = ""; inToken = false; } }
		else { token += char; inToken = true; }
	}
	if (quote) return undefined;
	if (inToken) tokens.push(token);
	return tokens.length ? tokens : undefined;
}

function trustedExecutable(executable: string, cwd: string): boolean {
	if (!executable.includes("/") && ["echo", "pwd", "true", "false"].includes(executable)) return true;
	let resolved: string | undefined;
	if (path.isAbsolute(executable)) resolved = executable;
	else if (!executable.includes("/")) {
		for (const directory of (process.env.PATH ?? "/usr/bin:/bin").split(path.delimiter)) {
			const candidate = path.resolve(cwd, directory || ".", executable);
			try { accessSync(candidate, constants.X_OK); if (statSync(candidate).isFile()) { resolved = candidate; break; } } catch { /* Shell skips unavailable PATH entries. */ }
		}
	}
	if (!resolved) return false;
	try { return [realpathSync("/bin"), realpathSync("/usr/bin")].includes(path.dirname(realpathSync(resolved))); }
	catch { return false; }
}

function potentialMutation(command: string): boolean {
	return /(^|[\s;&|])(?:rm|rmdir|mv|cp|install|touch|tee|truncate|chmod|chown|sed|perl|patch|dd)(?:\s|$)|>|\b(?:write|writeFile|unlink|remove|rename|rmtree|open)\b/.test(command);
}

function readCommandTargets(name: string, args: string[]): string[] | undefined {
	if (name === "cat") {
		const targets = args.filter((arg) => arg !== "--");
		return targets.length && targets.every((arg) => !arg.startsWith("-")) ? targets : undefined;
	}
	if (name === "head" || name === "tail") {
		const targets: string[] = [];
		for (let index = 0; index < args.length; index++) {
			const arg = args[index];
			if (arg === "-n" || arg === "-c") { if (!/^\d+$/.test(args[++index] ?? "")) return undefined; }
			else if (/^-\d+$/.test(arg) || arg === "--") continue;
			else if (arg.startsWith("-")) return undefined;
			else targets.push(arg);
		}
		return targets.length ? targets : undefined;
	}
	if (name === "rg" || name === "grep") {
		const positional = args.filter((arg) => !["-n", "-i", "-l", "-c", "-F", "-E", "--"].includes(arg));
		if (positional.length < 2 || positional.some((arg) => arg.startsWith("-"))) return undefined;
		const targets = positional.slice(1);
		return targets.every((target) => !target.startsWith("~") && !target.endsWith("/")) ? targets : undefined;
	}
	return undefined;
}
