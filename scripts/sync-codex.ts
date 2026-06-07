/**
 * Sync the Codex upstream source files we ported and surface any changes
 * since the last sync.
 *
 * Usage:
 *   npm run sync-codex
 *   PI_AUTO_CODEX_BRANCH=v0.50 npm run sync-codex   # pin to a release
 *
 * What this script does:
 *   1. Fetches the upstream HEAD commit info for openai/codex (default branch: main).
 *   2. For each file in FILES, downloads the current upstream version.
 *   3. Diffs it against the local snapshot at vendor/codex-upstream/<file>.
 *   4. Prints a unified diff for each changed file.
 *   5. Overwrites the local snapshot with the new upstream content.
 *
 * What this script does NOT do:
 *   - It does not edit any extensions/*.ts file. You (or the AI agent) must
 *     read the printed diffs and manually mirror the relevant changes into the
 *     TypeScript ports listed under `port` in FILES.
 *   - It does not update vendor/codex-upstream/SYNC.md. You must paste the new
 *     commit sha there yourself (see next-steps output at the end of the run).
 *   - It does not run tests. Run `npm test` after porting.
 *
 * If you are an AI agent running this for the user, follow the printed
 * "Next steps" instructions exactly. They are the contract.
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface FileSpec {
	upstream: string;
	local: string;
	port: string;
}

const FILES: FileSpec[] = [
	{
		upstream: "codex-rs/shell-command/src/bash.rs",
		local: "vendor/codex-upstream/bash.rs",
		port: "extensions/bash-parser.ts",
	},
	{
		upstream: "codex-rs/shell-command/src/command_safety/is_safe_command.rs",
		local: "vendor/codex-upstream/is_safe_command.rs",
		port: "extensions/safe-commands.ts",
	},
	{
		upstream: "codex-rs/shell-command/src/command_safety/is_dangerous_command.rs",
		local: "vendor/codex-upstream/is_dangerous_command.rs",
		port: "extensions/safe-commands.ts",
	},
];

const REPO_ROOT = process.cwd();
const BRANCH = process.env.PI_AUTO_CODEX_BRANCH ?? "main";
const RAW_BASE = `https://raw.githubusercontent.com/openai/codex/${BRANCH}`;
const COMMITS_API = `https://api.github.com/repos/openai/codex/commits/${BRANCH}`;

async function fetchText(url: string): Promise<string> {
	const res = await fetch(url, {
		headers: process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {},
	});
	if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status} ${res.statusText}`);
	return await res.text();
}

async function fetchJson<T>(url: string): Promise<T> {
	const res = await fetch(url, {
		headers: process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {},
	});
	if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status} ${res.statusText}`);
	return (await res.json()) as T;
}

function diff(localPath: string, remoteContent: string): string {
	const tmpPath = join(REPO_ROOT, ".sync-codex-tmp");
	writeFileSync(tmpPath, remoteContent);
	const result = spawnSync("diff", ["-u", localPath, tmpPath], { encoding: "utf8" });
	try {
		execSync(`rm -f ${tmpPath}`);
	} catch {}
	return result.stdout || "";
}

async function main(): Promise<void> {
	console.log(`Syncing Codex upstream from openai/codex@${BRANCH}\n`);

	const head = await fetchJson<{ sha: string; commit: { author: { date: string }; message: string } }>(COMMITS_API);
	console.log(`Upstream HEAD: ${head.sha}`);
	console.log(`  date:    ${head.commit.author.date}`);
	console.log(`  message: ${head.commit.message.split("\n")[0]}\n`);

	let anyChange = false;

	for (const file of FILES) {
		const url = `${RAW_BASE}/${file.upstream}`;
		const remote = await fetchText(url);
		const localFull = join(REPO_ROOT, file.local);
		const localContent = existsSync(localFull) ? readFileSync(localFull, "utf8") : "";

		if (remote === localContent) {
			console.log(`✓ ${file.upstream}  (unchanged)`);
			continue;
		}

		anyChange = true;
		console.log(`\n--- CHANGED: ${file.upstream}`);
		console.log(`    ported to: ${file.port}`);
		console.log(`    showing diff (local → upstream):\n`);
		const d = diff(localFull, remote);
		if (d) {
			process.stdout.write(d);
		} else {
			console.log("  (diff failed to produce output; file is different though)");
		}

		mkdirSync(dirname(localFull), { recursive: true });
		writeFileSync(localFull, remote);
		console.log(`\n    updated snapshot at ${file.local}\n`);
	}

	console.log("");
	printNextSteps(head.sha, anyChange);
}

function printNextSteps(headSha: string, anyChange: boolean): void {
	const bar = "─".repeat(70);
	console.log(bar);
	console.log("NEXT STEPS");
	console.log(bar);

	if (!anyChange) {
		console.log(`
Everything is already in sync with upstream.

Do this:
  1. Open vendor/codex-upstream/SYNC.md.
  2. Update the "Last synced commit" line to:
        ${headSha}
  3. git commit -am "chore: sync codex upstream through ${headSha.slice(0, 12)}"

That's it. No code changes needed.
`);
		return;
	}

	console.log(`
Upstream changed since the last sync. The script already overwrote the
local snapshots under vendor/codex-upstream/ — git diff will show what was
updated. NOW you (or the agent) need to mirror the changes into the
TypeScript ports.

Do this in order:

  1. Read each diff that printed above. For each upstream change, decide
     whether it affects pi-auto and how. Common cases:

        Codex added a new safe executable → add it to SIMPLE_SAFE in
          extensions/safe-commands.ts.
        Codex added a new unsafe flag for find/rg/git/base64/sed → add it to
          the corresponding UNSAFE_*_OPTIONS / UNSAFE_GIT_FLAGS / etc. set in
          extensions/safe-commands.ts.
        Codex added a new allowed git subcommand → add it to
          GIT_READONLY_SUBCOMMANDS.
        Codex added a new allowed AST node kind in their bash parser → add
          it to ALLOWED_KINDS in extensions/bash-parser.ts.
        Codex added a new allowed operator token → add it to
          ALLOWED_PUNCT_TOKENS in extensions/bash-parser.ts.
        Codex added a new "git global option requires prompt" entry →
          update gitGlobalOptionRequiresPrompt in extensions/safe-commands.ts.
        Windows-only changes → SKIP. pi-auto does not handle Windows here.

  2. Update tests:
        • If Codex added or changed a test in upstream bash.rs or
          is_safe_command.rs, mirror it into tests/bash-parser.test.ts or
          tests/safe-commands.test.ts respectively.
        • If you added a new positive/negative example to the ports, add a
          corresponding unit test.

  3. Run the test suite:
        npm test
     All tests must pass before committing.

  4. Update vendor/codex-upstream/SYNC.md:
        • Change "Last synced commit" to:
            ${headSha}
        • Add a 1-line note under "Last sync" describing what changed
          (e.g. "Added 'rg --new-flag' to ripgrep unsafe options").

  5. Commit everything together so the snapshot bump and the port land in
     one reviewable commit:
        git add vendor/codex-upstream/ extensions/ tests/
        git commit -m "chore: sync codex upstream through ${headSha.slice(0, 12)}"

If any diff looks too large to confidently port, escalate to a human review
rather than blindly mirroring it. Better to leave the snapshot updated and
the port stale than to introduce a security regression.
`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
