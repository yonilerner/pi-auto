# Codex upstream snapshot

> **For AI agents and humans:** this directory + `scripts/sync-codex.ts` are how
> pi-auto stays current with Codex's safe-command rules. The procedure is
> below. Follow it literally.

## What this is

`extensions/bash-parser.ts` and `extensions/safe-commands.ts` are hand-ports of
three Rust files in [openai/codex](https://github.com/openai/codex). We snapshot
those Rust files here so we can detect when upstream changes and mirror the
changes into the TypeScript ports.

| Upstream path                                                       | Snapshot here              | Ported to                       |
| ------------------------------------------------------------------- | -------------------------- | ------------------------------- |
| `codex-rs/shell-command/src/bash.rs`                                | `bash.rs`                  | `extensions/bash-parser.ts`     |
| `codex-rs/shell-command/src/command_safety/is_safe_command.rs`      | `is_safe_command.rs`       | `extensions/safe-commands.ts`   |
| `codex-rs/shell-command/src/command_safety/is_dangerous_command.rs` | `is_dangerous_command.rs`  | `extensions/safe-commands.ts` (only helpers used by the safe-command logic; `find_git_subcommand` etc.) |

## Last sync

- **Last synced commit:** `b89ce9a2bcedcfddf3a48f387b7912d602d6d87c`
- **Last synced at:** 2026-06-07 (initial port)
- **Notes:** initial port. Skipped Windows-specific code (`is_safe_command_windows`, `is_safe_powershell_words`). Skipped Linux-only entries (`numfmt`, `tac`) but those can be re-added trivially.

## How to sync (the recipe)

Run this verbatim. If you're an AI agent, do not deviate from it.

```bash
npm run sync-codex
```

The script will:

1. Fetch upstream `openai/codex@main` HEAD info and print the commit sha.
2. Download each tracked file and diff it against the local snapshot here.
3. Print unified diffs for any file that changed.
4. **Overwrite the local snapshots in this directory in place.**
5. Print a "NEXT STEPS" section telling you what to do.

### If the script says "Everything is already in sync"

Do this and stop:

1. Replace the "Last synced commit" sha above with the printed sha.
2. Replace the "Last synced at" date with today.
3. Commit:
   ```bash
   git commit -am "chore: sync codex upstream through <12-char-sha>"
   ```

### If the script says upstream changed

For each diff that printed, decide what (if anything) to port. The
correspondence:

| Upstream change                                              | What to do in pi-auto                                                       |
| ------------------------------------------------------------ | --------------------------------------------------------------------------- |
| New executable added to the simple safe-list                  | Add to `SIMPLE_SAFE` in `extensions/safe-commands.ts`                       |
| New unsafe flag for `find` / `rg` / `git` / `base64` / `sed`  | Add to the corresponding `UNSAFE_*_OPTIONS` / `UNSAFE_GIT_FLAGS` set        |
| New allowed `git` subcommand                                 | Add to `GIT_READONLY_SUBCOMMANDS`                                           |
| New "git global option requires prompt" entry                 | Update `gitGlobalOptionRequiresPrompt` in `extensions/safe-commands.ts`     |
| New `git branch` read-only flag                              | Add to `GIT_BRANCH_READONLY_FLAGS`                                          |
| New allowed AST node kind in their bash parser                | Add to `ALLOWED_KINDS` in `extensions/bash-parser.ts`                       |
| New allowed punctuation/operator token                        | Add to `ALLOWED_PUNCT_TOKENS` in `extensions/bash-parser.ts`                |
| Test added/changed in upstream `bash.rs` tests                | Mirror it into `tests/bash-parser.test.ts`                                  |
| Test added/changed in upstream `is_safe_command.rs` tests     | Mirror it into `tests/safe-commands.test.ts`                                |
| Windows-only change (PowerShell, `windows_*_commands.rs`)     | **Skip.** pi-auto does not handle Windows command classification.           |
| Linux-only entry (`numfmt`, `tac`)                            | Skip unless you want pi-auto to fast-path them on Linux too.                |
| Refactor that just renames symbols / moves code              | Skip (port is structural, not symbol-by-symbol).                            |

Anything you're not confident about → leave a comment in the relevant TS file
linking to the upstream commit, and surface in the commit message that further
review is needed. Do NOT blindly port complex changes — better stale than
wrong.

After porting:

1. **Run the tests:**
   ```bash
   npm test
   ```
   All tests must pass.
2. **Update this file:**
   - Change "Last synced commit" to the new sha.
   - Change "Last synced at" to today.
   - Add a one-line entry to "Notes" describing what you ported (e.g. `"Added rg --new-flag to UNSAFE_RG_OPTIONS_WITHOUT_ARGS"`).
3. **Commit everything in one shot:**
   ```bash
   git add vendor/codex-upstream/ extensions/ tests/
   git commit -m "chore: sync codex upstream through <12-char-sha>"
   ```

## Why not just shell out to `codex execpolicy check`?

The Codex CLI has `codex execpolicy check` which evaluates a command against
the same heuristics. We considered using it, but rejected it because:

- It requires the Codex binary to be installed on the user's machine.
- Spawning a subprocess adds 50-200ms per call. Pi-auto's fast path is
  supposed to be effectively instant.
- pi-auto is a TS project; a Rust CLI dependency makes installation more
  fragile and harder to debug.

So we maintain the port instead, with this sync workflow as the upkeep
mechanism.
