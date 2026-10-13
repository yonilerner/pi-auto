#!/usr/bin/env tsx

import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { writeLiveEvalSummaryFiles } from "../tests/live/eval-report.ts";

interface Args {
	iterations: number;
	pattern?: string;
	soft: boolean;
	name?: string;
	outDir?: string;
	reviewerProvider?: string;
	reviewerModel?: string;
	useCodexAutoReview: boolean;
	stripAssistantText: boolean;
	stripToolResults: boolean;
	passthrough: string[];
}

function parseArgs(argv: string[]): Args {
	const args: Args = {
		iterations: 5,
		soft: false,
		useCodexAutoReview: false,
		stripAssistantText: false,
		stripToolResults: false,
		passthrough: [],
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--") {
			args.passthrough.push(...argv.slice(i + 1));
			break;
		}
		if (a === "--iterations" || a === "-i") {
			args.iterations = parsePositiveInt(argv[++i], a);
		} else if (a === "--pattern" || a === "-t") {
			args.pattern = requiredValue(argv[++i], a);
		} else if (a === "--soft") {
			args.soft = true;
		} else if (a === "--name") {
			args.name = slug(requiredValue(argv[++i], a));
		} else if (a === "--out-dir") {
			args.outDir = resolve(requiredValue(argv[++i], a));
		} else if (a === "--reviewer-provider") {
			args.reviewerProvider = requiredValue(argv[++i], a);
		} else if (a === "--reviewer-model") {
			args.reviewerModel = requiredValue(argv[++i], a);
		} else if (a === "--codex-auto-review") {
			args.useCodexAutoReview = true;
		} else if (a === "--strip-assistant-text") {
			args.stripAssistantText = true;
		} else if (a === "--strip-tool-results") {
			args.stripToolResults = true;
		} else if (a === "--help" || a === "-h") {
			printHelp();
			process.exit(0);
		} else {
			console.error(`Unknown argument: ${a}`);
			printHelp();
			process.exit(2);
		}
	}
	return args;
}

function requiredValue(value: string | undefined, flag: string): string {
	if (!value) {
		console.error(`${flag} requires a value`);
		process.exit(2);
	}
	return value;
}

function parsePositiveInt(value: string | undefined, flag: string): number {
	const n = Number.parseInt(requiredValue(value, flag), 10);
	if (!Number.isFinite(n) || n < 1) {
		console.error(`${flag} must be a positive integer`);
		process.exit(2);
	}
	return n;
}

function printHelp(): void {
	console.log(`Usage: npm run eval:live -- [options]

Runs tests/live with artifact capture enabled.

Options:
  -i, --iterations <n>          PI_AUTO_ITERATIONS value (default: 5)
  -t, --pattern <pattern>       Vitest -t filter
      --soft                    Record assertion failures without failing tests
      --name <slug>             Include a label in the run directory name
      --out-dir <path>          Output directory (default: /tmp/pi-agent/pi-auto-live-runs/<timestamp>)
      --reviewer-provider <id>  Override PI_AUTO_REVIEWER_PROVIDER
      --reviewer-model <id>     Override PI_AUTO_REVIEWER_MODEL
      --codex-auto-review       Set PI_AUTO_USE_CODEX_AUTO_REVIEW=1
      --strip-assistant-text    Set PI_AUTO_STRIP_ASSISTANT_TEXT=1
      --strip-tool-results      Set PI_AUTO_STRIP_TOOL_RESULTS=1
      -- <args>                 Extra args passed to vitest
`);
}

function slug(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "run";
}

function defaultRunDir(args: Args): string {
	const stamp = new Date().toISOString().replaceAll(":", "").replace(/\.\d{3}Z$/, "Z");
	const parts = [stamp, args.name].filter(Boolean).join("-");
	return join("/tmp/pi-agent/pi-auto-live-runs", parts);
}

const args = parseArgs(process.argv.slice(2));
const outDir = args.outDir ?? defaultRunDir(args);
mkdirSync(outDir, { recursive: true });
const attemptsFile = join(outDir, "attempts.jsonl");
const logFile = join(outDir, "vitest.log");
if (!existsSync(attemptsFile)) writeFileSync(attemptsFile, "");

const env: NodeJS.ProcessEnv = {
	...process.env,
	PI_AUTO_LIVE_TESTS: "1",
	PI_AUTO_ITERATIONS: String(args.iterations),
	PI_AUTO_LIVE_RESULTS_FILE: attemptsFile,
};
if (args.soft) env.PI_AUTO_LIVE_SOFT_ASSERT = "1";
else delete env.PI_AUTO_LIVE_SOFT_ASSERT;
if (args.reviewerProvider) env.PI_AUTO_REVIEWER_PROVIDER = args.reviewerProvider;
if (args.reviewerModel) env.PI_AUTO_REVIEWER_MODEL = args.reviewerModel;
if (args.useCodexAutoReview) env.PI_AUTO_USE_CODEX_AUTO_REVIEW = "1";
if (args.stripAssistantText) env.PI_AUTO_STRIP_ASSISTANT_TEXT = "1";
if (args.stripToolResults) env.PI_AUTO_STRIP_TOOL_RESULTS = "1";

const vitestArgs = ["vitest", "run", "tests/live"];
if (args.pattern) vitestArgs.push("-t", args.pattern);
vitestArgs.push(...args.passthrough);

console.log(`pi-auto live eval run directory: ${outDir}`);
console.log(`attempts: ${attemptsFile}`);
console.log(`log: ${logFile}`);
console.log(`command: npx ${vitestArgs.join(" ")}`);

const log = createWriteStream(logFile, { flags: "a" });
const child = spawn("npx", vitestArgs, { env, stdio: ["ignore", "pipe", "pipe"] });
child.stdout.on("data", (chunk) => {
	process.stdout.write(chunk);
	log.write(chunk);
});
child.stderr.on("data", (chunk) => {
	process.stderr.write(chunk);
	log.write(chunk);
});

child.on("error", (err) => {
	console.error(`failed to start vitest: ${err.message}`);
	process.exitCode = 1;
});

child.on("close", (code) => {
	log.end();
	try {
		const summary = writeLiveEvalSummaryFiles(attemptsFile, outDir);
		console.log(`\nsummary: ${join(outDir, "summary.json")}`);
		console.log(`markdown: ${join(outDir, "summary.md")}`);
		console.log(
			`pass ${summary.totals.passes}/${summary.totals.attempts}; failures=${summary.totals.failures}; false_allow=${summary.totals.falseAllows}; false_deny=${summary.totals.falseDenies}; high_critical_false_allow=${summary.totals.highCriticalFalseAllows}; cost=$${summary.totals.costUsd.toFixed(4)}`,
		);
	} catch (err) {
		console.error(`failed to write summary: ${err instanceof Error ? err.message : String(err)}`);
		process.exitCode = 1;
		return;
	}
	process.exitCode = code ?? 1;
	console.log(`run directory basename: ${basename(outDir)}`);
});
