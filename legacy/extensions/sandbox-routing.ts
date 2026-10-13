import {
	parseLooseCommandArgvPrefixes,
	parseShellLcPlainCommands,
	parseTopLevelAndOrCommandSequence,
	type AndOrCommandSegment,
} from "./bash-parser.ts";
import {
	cleanupAfterSandboxCommand,
	wrapBashCommandForExecution,
	type WrappedSandboxCommand,
} from "./sandbox.ts";
import type { SandboxSettings } from "./types.ts";

export interface MixedReviewOnlySegment extends AndOrCommandSegment {
	route: "review-only" | "sandbox";
}

export type SandboxReviewOnlyPrefixDecision =
	| { kind: "match" }
	| { kind: "mixed-sequence"; segments: MixedReviewOnlySegment[] }
	| { kind: "unsupported"; reason: string }
	| { kind: "no-match" };

export function matchesSandboxReviewOnlyPrefix(command: string, prefixes: readonly (readonly string[])[]): boolean {
	return decideSandboxReviewOnlyPrefix(command, prefixes).kind === "match";
}

export function decideSandboxReviewOnlyPrefix(
	command: string,
	prefixes: readonly (readonly string[])[],
): SandboxReviewOnlyPrefixDecision {
	if (prefixes.length === 0) return { kind: "no-match" };
	const andOrSequence = parseTopLevelAndOrCommandSequence(command);
	if (andOrSequence && andOrSequence.length > 1) {
		const segments: MixedReviewOnlySegment[] = [];
		let reviewOnlyCount = 0;
		for (const segment of andOrSequence) {
			if (segment.argv && matchesAnyCommandPrefix(segment.argv, prefixes)) {
				segments.push({ ...segment, route: "review-only" });
				reviewOnlyCount++;
				continue;
			}
			const loosePrefixes = parseLooseCommandArgvPrefixes(segment.source);
			if (loosePrefixes.some((argv) => couldMatchAnyCommandPrefix(argv, prefixes))) {
				return { kind: "unsupported", reason: buildReviewOnlyUnsupportedReason(prefixes, command, "a review-only command appears inside a segment whose shell syntax cannot be routed safely") };
			}
			segments.push({ ...segment, route: "sandbox" });
		}
		if (reviewOnlyCount === segments.length) return { kind: "match" };
		if (reviewOnlyCount > 0) return { kind: "mixed-sequence", segments };
		return { kind: "no-match" };
	}
	const plainCommands = parseShellLcPlainCommands(["bash", "-lc", command]);
	if (plainCommands && plainCommands.length > 0) {
		const matched = plainCommands.filter((argv) => matchesAnyCommandPrefix(argv, prefixes));
		if (matched.length === plainCommands.length) return { kind: "match" };
		if (matched.length > 0) return { kind: "unsupported", reason: buildReviewOnlyUnsupportedReason(prefixes, command, "not every command in the script matches a review-only prefix") };
		return { kind: "no-match" };
	}
	const loosePrefixes = parseLooseCommandArgvPrefixes(command);
	if (loosePrefixes.some((argv) => couldMatchAnyCommandPrefix(argv, prefixes))) {
		return { kind: "unsupported", reason: buildReviewOnlyUnsupportedReason(prefixes, command, "the command uses shell syntax that review-only routing does not support") };
	}
	return { kind: "no-match" };
}

export async function buildMixedReviewOnlySequenceCommand(
	segments: readonly MixedReviewOnlySegment[], cwd: string, sandbox: SandboxSettings,
	deps: { wrapBashCommand?: (command: string, cwd?: string, sandbox?: SandboxSettings) => Promise<string | WrappedSandboxCommand>; cleanupAfterSandboxCommands?: (count: number) => void } = {},
): Promise<{ command: string; sandboxedCommands: string[]; sandboxAnnotationCommands: string[]; sandboxWrapCount: number }> {
	const wrap = deps.wrapBashCommand ?? wrapBashCommandForExecution;
	const cleanup = deps.cleanupAfterSandboxCommands ?? cleanupAfterSandboxCommands;
	const out: string[] = [];
	const sandboxedCommands: string[] = [];
	const sandboxAnnotationCommands: string[] = [];
	let sandboxWrapCount = 0;
	try {
		for (const segment of segments) {
			if (segment.operatorBefore) out.push(segment.operatorBefore);
			if (segment.route === "review-only") out.push(segment.source);
			else {
				sandboxedCommands.push(segment.source);
				const wrapped = await wrap(segment.source, cwd, sandbox);
				if (typeof wrapped === "string") { out.push(wrapped); sandboxAnnotationCommands.push(segment.source); }
				else { out.push(wrapped.wrappedCommand); sandboxAnnotationCommands.push(wrapped.sandboxCommand); }
				sandboxWrapCount++;
			}
		}
	} catch (err) { cleanup(sandboxWrapCount); throw err; }
	return { command: out.join(" "), sandboxedCommands, sandboxAnnotationCommands, sandboxWrapCount };
}

export function cleanupAfterSandboxCommands(count: number, cleanup: () => void = cleanupAfterSandboxCommand): void {
	for (let i = 0; i < count; i++) cleanup();
}

export function formatMixedReviewOnlyRoutingNotice(segments: readonly MixedReviewOnlySegment[]): string {
	const lines = ["pi-auto routed mixed bash:"];
	for (const segment of segments) {
		const operator = segment.operatorBefore ?? "";
		const route = segment.route === "review-only" ? "review-only" : "sandboxed";
		lines.push(`   ${operator.padStart(2)} ${route.padEnd(11)} : ${truncate(segment.source, 160)}`);
	}
	return lines.join("\n");
}

function buildReviewOnlyUnsupportedReason(prefixes: readonly (readonly string[])[], command: string, detail: string): string {
	return [
		"pi-auto blocked this bash command before sandboxing because it appears to use a configured sandbox.reviewOnlyCommandPrefixes entry, but cannot be routed safely.",
		`Reason: ${detail}.`, `Configured prefixes: ${prefixes.map((p) => p.join(" ")).join(", ")}.`, `Command: ${truncate(command, 500)}`,
		"Rewrite it as plain argv-only command(s) where every command starts with a review-only prefix. For multiline text, prefer a temporary file plus --body-file over shell quoting, substitution, or redirection.",
	].join("\n");
}
function matchesAnyCommandPrefix(argv: readonly string[], prefixes: readonly (readonly string[])[]): boolean { return prefixes.some((prefix) => matchesCommandPrefix(argv, prefix)); }
function matchesCommandPrefix(argv: readonly string[], prefix: readonly string[]): boolean {
	if (prefix.length === 0 || argv.length < prefix.length) return false;
	return prefix.every((part, index) => (argv[index] ?? "") === part);
}
function couldMatchAnyCommandPrefix(argv: readonly string[], prefixes: readonly (readonly string[])[]): boolean { return prefixes.some((prefix) => couldMatchCommandPrefix(argv, prefix)); }
function couldMatchCommandPrefix(argv: readonly string[], prefix: readonly string[]): boolean {
	if (prefix.length === 0 || argv.length === 0) return false;
	return prefix.slice(0, Math.min(argv.length, prefix.length)).every((part, index) => (argv[index] ?? "") === part);
}
function truncate(s: string, n: number): string { return s.length <= n ? s : `${s.slice(0, n)}…`; }
