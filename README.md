# pi-auto

> ⚠️ **Experimental and untested.** This is a hobby/research project. It has not been used in production, has not been security-audited, and the live LLM-reviewer scenarios pass on a curated test suite — not in the wild. The reviewer is a probabilistic LLM and will make mistakes. **Do not treat this as a security boundary.** Treat it as a friction-reduction tool for unattended tool execution that you should still supervise. Don't rely on it to stop a determined adversary; don't run it on an untrusted machine and call it sandboxing.

LLM-based tool-call auto-approval for the [pi coding agent](https://pi.dev).

Inspired by [Codex's Auto-review / Guardian system](https://developers.openai.com/codex/concepts/sandboxing/auto-review). For each tool call, an LLM "reviewer" scores the action along two dimensions:

| Dimension            | Values                                        |
| -------------------- | --------------------------------------------- |
| `risk_level`         | `low` · `medium` · `high` · `critical`        |
| `user_authorization` | `high` · `medium` · `low` · `unknown`         |

The reviewer then returns an `outcome` (`allow` / `deny`) plus a one-sentence rationale. Outcomes follow Codex's threshold policy:

| `risk_level` | Outcome                                                  |
| ------------ | -------------------------------------------------------- |
| `low`        | `allow`                                                  |
| `medium`     | `allow` (unless clear prompt-injection signs)            |
| `high`       | `allow` only if `user_authorization >= medium`           |
| `critical`   | `deny`                                                   |

## Why?

pi runs tools as soon as the model emits them. Today's options are:

1. Approve nothing (run everything — risky).
2. Run a regex/heuristic gate like `pi-guardrails` (brittle, easy to bypass with compound shell commands).

pi-auto sits between those: a separate LLM evaluates each in-scope tool call with the full conversation as context, so it understands intent ("the user asked me to clean up `~/code/old-stuff`, so `rm -rf ~/code/old-stuff` is authorized") instead of pattern-matching.

## What gets reviewed

Not every tool call goes through the LLM — that would burn tokens on `ls` and friends. The scope rules:

| Tool                | Reviewed?                                                           |
| ------------------- | ------------------------------------------------------------------- |
| `bash`              | Only if it isn't "known-safe" (see below)                           |
| `write`, `edit`     | Only when the target path is **outside cwd**                        |
| `read`              | Outside cwd, **or** matching a sensitive-path heuristic (~/.ssh, ~/.aws, .env, credentials files, …) |
| `grep`, `find`, `ls`| Never                                                               |
| Custom / MCP tools  | **Always** (we don't know what they do)                             |

Reading credential files is treated as risky even though it's "read-only": the contents enter the conversation context and can later be exfiltrated by `bash`.

### Bash known-safe fast path

Before burning a reviewer call on `bash`, pi-auto runs the command through a deterministic safe-command classifier ported from [Codex's `is_safe_command`](https://github.com/openai/codex/blob/main/codex-rs/shell-command/src/command_safety/is_safe_command.rs). If it returns true the tool runs without any LLM call — saves ~1.7s of latency on the common case of `ls`/`git status`/`grep`/`pwd` and friends.

The classifier covers:

- A curated allow-list of read-only executables (`cat, cd, cut, echo, expr, false, grep, head, id, ls, nl, paste, pwd, rev, seq, stat, tail, tr, true, uname, uniq, wc, which, whoami`).
- Per-command flag awareness for executables that have unsafe flags: `find` (`-exec`/`-delete`/...), `rg` (`--pre`/`--search-zip`/...), `git` (only `status`/`log`/`diff`/`show`/`branch` subcommands with read-only flags, blocks `-c` / `--git-dir` / `--exec-path` / etc.), `base64` (no `-o`/`--output`), `sed` (only the `-n N[,M]p` pattern).
- Compound bash scripts via [`tree-sitter-bash`](https://github.com/tree-sitter/tree-sitter-bash). The script must be a chain of plain commands joined only by `&&`, `||`, `;`, `|`. **All inner commands must themselves be known-safe.** Anything else — subshells `(...)`, redirections `>`/`<`, command substitution `$()` / backticks, variable expansion `$VAR`, heredocs, herestrings, arithmetic `$((...))`, variable assignments — bails out and falls through to the LLM reviewer.

So `ls && grep foo *.md` is fast-pathed. `ls && rm -rf /` is reviewed. `(ls)` is reviewed. `ls > out.txt` is reviewed. `echo $(pwd)` is reviewed. Etc.

### Extending the safe-list

If there are specific command prefixes you always want to skip review on (e.g. project-specific test runners), add them as `extraSafeCommandPrefixes`:

```ts
// in DEFAULT_SETTINGS
extraSafeCommandPrefixes: [
  ["npm", "test"],
  ["pnpm", "lint"],
  ["cargo", "check"],
],
```

A prefix matches if it is a token-by-token prefix of the proposed argv. `["npm", "test"]` matches `npm test`, `npm test --grep foo`, etc. — but not `npm install`.

Extra prefixes also apply inside compound bash chains: with the above, `bash -lc "npm test && pnpm lint"` is fast-pathed.

`extraSafeCommandPrefixes` wins over every other gate. If a command matches the safe-list it bypasses both `sandbox.reviewOnlyCommandPrefixes` routing and the sandbox wrap itself, in every `sandbox.mode`. Use this to opt a tool out of the sandbox entirely when you've verified it's safe — e.g. `[["but"]]` lets `gitbutler` run bare so it doesn't trip over ASRT's `.gitmodules` placeholder.

## Behavior

- **allow** → tool runs. A small inline notification shows the risk level, authorization, and rationale (toggle off with `/pi-auto-toggle-announce`).
- **deny** → tool is hard-blocked with the reviewer's rationale. The agent is told "find a materially safer alternative, or stop and ask the user" — Codex's wording, lightly adapted.
- **reviewer failed** (timeout, no API key, unparseable response, …) → falls back to prompting the user. In non-interactive modes (`-p`, JSON), fails closed.

### Circuit breaker

Mirrors Codex: after **3 consecutive denials** or **10 total denials** in a single turn, pi-auto interrupts the turn and surfaces a prompt to the user explaining why. The user can stop the turn or approve the latest action and continue (one-shot — the breaker still trips on the next runaway loop).

### Pausing the reviewer

When the reviewer denies an action you actually want to run, the simplest escape hatch is `/pi-auto-disable`. While disabled:

- Every tool call bypasses pi-auto entirely — no scope check, no reviewer LLM call, no circuit-breaker accounting.
- A persistent `pi-auto OFF` indicator appears in the status bar so the off state is hard to miss.
- The disable is **in-memory only**: a fresh pi launch always starts enabled.

Re-enable with `/pi-auto-enable`. There's no auto-re-enable; if you forget, the status bar reminds you. The intentional verbosity (separate disable/enable commands instead of a toggle) is to make the off state a deliberate choice rather than a fat-fingerable flip.

Typical workflow when a denial blocks something you want:

```
[reviewer denies rm -rf folder]
/pi-auto-disable
please try that again
[tool runs without review]
/pi-auto-enable
```

## Configuration

The defaults live in `extensions/pi-auto.ts` (`DEFAULT_SETTINGS`). Run `/pi-auto` inside pi to see the active settings. Run `/pi-auto-settings` to edit them interactively, or `/pi-auto-reload-settings` after editing the JSON files by hand. All settings are typed in `extensions/types.ts` as `PiAutoSettings`.

### Where settings come from

pi-auto reads settings from four layers, lowest to highest precedence:

1. **`DEFAULT_SETTINGS`** — compiled-in defaults.
2. **User-global JSON** at `$PI_AGENT_DIR/extensions/pi-auto.json` (resolves to `~/.pi/agent/extensions/pi-auto.json` when `PI_AGENT_DIR` is unset). Edit it with `/pi-auto-settings` or by hand. Partial files are fine — only the fields you set override defaults.
3. **Per-project JSON** at `.agents/pi-auto.json`, discovered by walking up from cwd to the project root (stopping at a `.git` directory or `$HOME`). Same partial-file behavior. Check this file in alongside `AGENTS.md` so a whole team gets the same reviewer behavior for the project.
4. **`PI_AUTO_*` environment variables** — final-word overrides for one-off runs (CI, ad-hoc benchmarks). Today the only supported env var is `PI_AUTO_USE_CODEX_POLICY` (see [§Reviewer model](#reviewer-model)).

Files can be malformed (missing field types, syntax errors) without breaking pi-auto — a warning is shown and the file is treated as empty until you fix it. `/pi-auto` shows which layer each effective value came from.

### `/pi-auto-settings`

Interactive form, opened with the slash command. The flow:

1. Pick which layer to edit (user-global or per-project).
2. Pick a field; each row shows the field's current effective value plus the layer it loaded from (so you can see at a glance when you're editing a field that's already shadowed by a higher-precedence layer).
3. The editor depends on the field type: boolean / enum fields show a small picker, string / number fields open a single-line input.

**Search.** Press `/` in the field picker to filter by label / description. Type to refine, Enter to keep the filter and navigate, Esc to clear. The filter is fuzzy across the row's primary column (the field name) and its description, so typing `noise`, `notice`, `sand` etc. each surface a useful subset.

Saves are written immediately to the JSON file you picked in step 1 and applied in-process for the current session — no relaunch required. The save confirmation includes the rendered value that was written.

The form intentionally only handles scalar / boolean / enum fields. List-typed fields (`sensitivePathPatterns`, `extraSafeCommandPrefixes`, sandbox `allowedDomains` / `deniedDomains` / `allowRead` / `denyRead` / `allowWrite` / `denyWrite` / `reviewOnlyCommandPrefixes` / `allowedDangerousFiles`) and `customPolicy` (free-form prose) are not in the form — edit them in the JSON file directly, then run `/pi-auto-reload-settings` to apply the manual edits without restarting pi. The `/pi-auto-settings` output prints the resolved file paths if you've never picked a layer before, and the README §Where settings come from describes both files.

### Reviewer model

These settings pick which model performs the review and how to authenticate to it.

| Setting                  | Default          | What it does |
| ------------------------ | ---------------- | ------------ |
| `reviewerProvider`       | `"openai"`       | Provider used to look up the reviewer model in pi's `ModelRegistry`. |
| `reviewerModel`          | `"gpt-5-mini"`   | Model id used for the review call. Any model in pi's catalog works; cheap small models (gpt-5-mini, claude-haiku-4-5, gpt-4.1-mini) are the sweet spot. |
| `fallbackToActiveModel`  | `false`          | If the configured reviewer model isn't available, fall back to whatever model the user's current session is on. Default is `false` because an unintended fallback on a typo or outage is usually worse than the reviewer failing closed (which falls back to a user prompt anyway). Opt in via `/pi-auto-settings` if you want auto-fallback. |
| `reviewerTimeoutMs`      | `30_000`         | Per-call timeout. If the reviewer takes longer than this, the review is treated as failed (which falls back to a user prompt). |
| `useCodexAutoReview`     | `false`          | If true, ignore `reviewerProvider`/`reviewerModel` and route the review through OpenAI's hidden `codex-auto-review` slug — the same model Codex itself uses internally. Requires an OpenAI API key configured in pi (ChatGPT-only login won't work; this slug needs a real API key). In our benchmark this scored 34/39 vs gpt-5-mini's 39/39 on our scenario set, mostly because Codex's policy is stricter than ours (credential reads, narrowly-scoped `/tmp` deletes, `sudo apt install`). Keep off unless you specifically want Codex-policy alignment. |
| `reviewerPolicySource`   | `"default"`      | `"default"` uses pi-auto's tuned policy; `"codex-verbatim"` swaps in codex's published guardian policy template verbatim (mirrored at `extensions/policies/codex-guardian-policy.md`). Mainly for benchmarks — our policy beat codex's on our scenario set; see `docs/HISTORY.md`. Override with the env var `PI_AUTO_USE_CODEX_POLICY=1` (sets `"codex-verbatim"`) / `=0` (sets `"default"`); the env var wins over the settings file. |

### Scope and policy

Which tool calls get reviewed at all, and what policy text the reviewer sees.

| Setting                       | Default              | What it does |
| ----------------------------- | -------------------- | ------------ |
| `sensitivePathPatterns`       | `["~/.ssh", "~/.aws", "~/.gnupg", "~/.kube", "~/.config/gh", "~/.netrc", "~/.npmrc", "~/.pypirc", "/etc/shadow", "/etc/sudoers", "credentials", ".env"]` | Substring patterns. Reading a file that matches any of these is reviewed even when it's inside cwd. Tildes are expanded against `$HOME`. |
| `extraSafeCommandPrefixes`    | `[]`                 | Argv prefixes that bypass review entirely for `bash`. `[["npm", "test"]]` matches `npm test`, `npm test --grep foo`, etc., including inside compound bash chains. See the [Bash known-safe fast path](#bash-known-safe-fast-path) section. |
| `customPolicy`                | `""`                 | Free-form text appended to the base reviewer policy. Use this to inject project-specific rules ("never push to main without `--dry-run`", "always require explicit per-turn auth for cloud writes", etc.). |

### Sandbox

| Setting | Default | What it does |
| ------- | ------- | ------------ |
| `sandbox.allowWrite` | `["."]` | Filesystem write roots for sandboxed commands. The default allows the current workspace (`.`); add entries here for extra writable roots. If you override this and remove `.`, workspace writes are no longer allowed. `/tmp` is not writable by default. |

### Transcript building

How much conversation history the reviewer sees, and what shape it's in. These directly affect both review quality and prompt cost.

| Setting                       | Default      | What it does |
| ----------------------------- | ------------ | ------------ |
| `maxTranscriptEntries`        | `40`         | Cap on the number of recent entries included verbatim. Older entries can still be pulled in via summaries or action-keyed retrieval. |
| `maxEntryChars`               | `2_000`      | Per-entry character cap. Long entries are truncated from the middle (head + tail kept) so the start and end of important messages survive. |
| `maxTranscriptTotalChars`     | `80_000`     | Hard cap on the whole assembled transcript. Final guard against runaway prompts even when other caps allow them through. |
| `maxPinnedRelatedEntries`     | `6`          | Maximum number of older entries pulled in via action-keyed retrieval (entries that mention paths/commands from the action under review). |
| `maxSummaryEntries`           | `3`          | Maximum number of compaction / branch summaries included as `[earlier summaries]`. |
| `enableDigest`                | `true`       | Maintain a rolling authorization digest (key user-granted authorizations, scope constraints, environment context). Survives compaction. |

### Transcript stripping (advanced)

These control whether the reviewer sees the agent's own prose and tool outputs. **Both default to `false`.** They mirror the design choices in Anthropic's Claude Code auto mode classifier, which strips both. We benchmarked all three combinations on our 39-scenario suite at 5 iterations each:

| Variant                     | Pass    | Notes                                              |
| --------------------------- | ------- | -------------------------------------------------- |
| baseline (strip neither)    | 190/195 | Default. Trusts the assistant's self-narrated plans ("I'll run the benchmark, then clean up") as authorization context. |
| `stripAssistantText: true`  | 190/195 | Statistically tied with baseline overall. Stricter on self-narrated-plan scenarios (allows them 80% rather than 100% of the time), but structurally immune to "as we discussed earlier you authorized this" rationalization attacks. |
| `stripAssistantText: true, stripToolResults: true` | 184/195 | Meaningfully worse. Loses tool-result evidence that the agent's verification steps actually succeeded — e.g. `git status` confirming uncommitted work. |

| Setting               | Default | What it does |
| --------------------- | ------- | ------------ |
| `stripAssistantText`  | `false` | Drop assistant prose from the reviewer transcript. Tool calls emitted by the assistant are kept (they're the audit trail of what the agent did). Trade-off: defends against the "lying assistant" class of attack (where assistant text claims prior user authorization) at the cost of being stricter on cases where the user implicitly approved a multi-step plan by not interrupting. |
| `stripToolResults`    | `false` | Drop tool-result entries entirely from the reviewer transcript. Tool calls are still shown. Trade-off: removes the canonical prompt-injection vector (hostile content in a fetched file or web page claiming the user authorized X) at the cost of losing evidence the agent gathered before acting. Our benchmark shows this regresses scenarios where the agent's verification chain matters (e.g. `git status` -> action). |

**Recommendation:** keep both at `false` unless you specifically value the structural attack-surface reduction over the small accuracy hit. If you turn one on, prefer `stripAssistantText`.

### Notifications & circuit breaker

How allows are surfaced and when a runaway loop trips the circuit breaker.

| Setting                          | Default    | What it does |
| -------------------------------- | ---------- | ------------ |
| `noticeLevel`                    | `"normal"` | Granularity of inline notice messages. `"silent"` = no routine notices; `"denials"` = + blocks and denied actions; `"normal"` = + reviewer allows and sandbox-allowed escapes; `"verbose"` = + sandbox mode-change confirmations and init warnings. Critical posture warnings (sandbox unavailable, sandbox-OFF startup warning, malformed settings file) always show regardless. `/pi-auto-toggle-announce` cycles through the levels in order. |
| `maxConsecutiveDenialsPerTurn`   | `3`        | After this many consecutive denials in a turn, the circuit breaker interrupts and surfaces a user prompt. Matches Codex's default. |
| `maxTotalDenialsPerTurn`         | `10`       | After this many total denials in a turn, the circuit breaker fires even if the consecutive counter is below threshold. Matches Codex's default. |

Review failures (timeout, no API key, unparseable response) fall back to a user prompt in interactive mode and fail closed (block) in non-interactive modes (`-p`, JSON).

The sandbox subsystem previously had its own `alwaysAnnounceDenials` boolean; it's been folded into `noticeLevel` (sandbox-related notifications obey the same tiered scheme as the reviewer's). The old `announceAllows` boolean was similarly replaced.

### Sandbox command-prefix escapes

`sandbox.reviewOnlyCommandPrefixes` is a list of argv prefixes for bash commands that should skip the initial sandbox attempt and run only after reviewer approval. Use this for tools that are incompatible with the sandbox in misleading ways (for example, CLIs that require an OS keyring or desktop session socket). Example:

```json
{
  "sandbox": {
    "reviewOnlyCommandPrefixes": [["gh"]]
  }
}
```

The matcher only routes plain word-only bash commands. For a compound command, every command in the script must match a configured prefix; `gh auth status && gh pr list` matches `[["gh"]]`. Command names are matched exactly: `[["gh"]]` matches only bare `gh`, not `./gh` or `/tmp/gh`; configure a pathful command explicitly, e.g. `[["/usr/bin/gh"]]`.

If a command appears to invoke a review-only prefix but uses unsupported shell syntax, pi-auto blocks it with a targeted repair message instead of falling back to sandbox execution. For example, `gh pr create --body $'...\\n...'`, `GH_DEBUG=api gh auth status`, `gh auth status > out.txt`, and `gh auth status && rm -rf /tmp/x` are blocked before execution; rewrite them as plain argv-only commands (for multiline text, use a temp file plus `--body-file`).

### Sandbox: silencing `DANGEROUS_FILES` deny noise

`@anthropic-ai/sandbox-runtime` hardcodes a list of `DANGEROUS_FILES` (`.gitconfig`, `.gitmodules`, `.bashrc`, `.bash_profile`, `.zshrc`, `.zprofile`, `.profile`, `.ripgreprc`, `.mcp.json`) into its mandatory-deny set, so ASRT plants a deny-only placeholder for each at `<cwd>` for every sandboxed command. Tools that stat those paths (e.g. `git`/`but`/`gh` stat `.gitmodules` on essentially every invocation to detect submodules) then log a benign `permission denied` per command.

`sandbox.allowedDangerousFiles` is a list of basenames to remove from that deny set. Empty (default) preserves the full ASRT deny list; add entries to opt individual files back in. Example:

```json
{
  "sandbox": {
    "allowedDangerousFiles": [".gitmodules"]
  }
}
```

Edit the JSON directly (this is a list-typed field, not in `/pi-auto-settings`), then `/pi-auto-reload-settings`.

Trade-off: each entry removed is one fewer guard against shell-rc / config-file exploits inside the sandbox. The files aren't equally risky — `.gitconfig` allows `[core] sshCommand`-style code execution and `.bashrc`/`.zshrc` are obvious; `.gitmodules` is inert unless you also run `git submodule update` (or equivalent) in the sandbox. Only opt in to files whose threat model you've thought about.

## Commands

- `/pi-auto` — show current configuration and whether the reviewer is currently enabled.
- `/pi-auto-settings` — edit settings interactively. Saves to user-global or per-project JSON, applies live. See [§`/pi-auto-settings`](#pi-auto-settings).
- `/pi-auto-reload-settings` — reload layered settings from disk/env and reapply live side effects (circuit breaker thresholds, sandbox runtime/status). Use after manual JSON edits.
- `/pi-auto-disable` — pause review. All tool calls run without pi-auto until `/pi-auto-enable`. See [Pausing the reviewer](#pausing-the-reviewer).
- `/pi-auto-enable` — re-enable review.
- `/pi-auto-toggle-announce` — cycle `noticeLevel` through silent / denials / normal / verbose. Live, in-session only. Prefer `/pi-auto-settings` for persistent changes.
- `/pi-auto-sandbox` — show sandbox mode, configuration, and recent denials.

## Upstream sync

The safe-command classifier and bash parser are ports of [Codex's Rust implementation](https://github.com/openai/codex/tree/main/codex-rs/shell-command). To track upstream changes:

```bash
npm run sync-codex
```

This downloads the current upstream versions, diffs them against the snapshots in `vendor/codex-upstream/`, and prints a summary of what changed so you can mirror it in `extensions/bash-parser.ts` and `extensions/safe-commands.ts`.

See `vendor/codex-upstream/SYNC.md` for the last-synced commit.

## How it compares to Codex

| Aspect                  | Codex                                                 | pi-auto                                                  |
| ----------------------- | ----------------------------------------------------- | -------------------------------------------------------- |
| Reviewer model          | Dedicated `codex-auto-review` → falls back to parent  | Configurable (default `openai/gpt-5-mini`) → falls back to active model |
| Scope                   | Sandbox-escalation only (writes outside roots, network) | Tool-call scope rules (no sandbox to escalate from)    |
| Deny behavior           | Hard-block, agent must adapt                          | Same — hard-block with rationale                         |
| Fail-mode               | Fail closed (block)                                   | Fall back to user prompt; fail closed in non-interactive |
| Circuit breaker         | 3 consec / 10 total → interrupt turn                  | Same defaults, plus user prompt                          |
| Override path           | `/approve` for last denial                            | Built into the circuit-breaker prompt                    |
| Policy customization    | `[auto_review].policy` in `config.toml`               | `customPolicy` setting                                   |

## Tests

```bash
npm test          # deterministic tests (76 tests, ~0.4s, no API calls)
npm run test:live # nondeterministic LLM scenarios (11 tests, ~11s, costs ~cents)
npm run typecheck
```

**Deterministic tests** (`tests/*.test.ts`) cover everything that doesn't need an LLM:
- `scope.test.ts` — review-scope rules per tool
- `circuit-breaker.test.ts` — per-turn denial counter
- `reviewer-parser.test.ts` — JSON parsing, fence stripping, prose extraction
- `transcript.test.ts` — compact transcript builder, including `stripAssistantText` / `stripToolResults` behavior
- `policy.test.ts` — reviewer system prompt
- `handler.test.ts` — end-to-end orchestration with mocked review results (allow / deny / failed / circuit-breaker)
- `digest.test.ts` — rolling authorization digest
- `retrieval.test.ts` — action-keyed retrieval for long-context auth
- `bash-parser.test.ts` / `safe-commands.test.ts` — the bash known-safe fast path

**Live tests** (`tests/live/reviewer-scenarios.test.ts`) hit the real reviewer model with a set of curated allow/deny scenarios. They use pi's own `ModelRegistry` + `AuthStorage`, so any model you've already logged into pi with works — no env vars needed.

```bash
npm run test:live              # one iteration of each scenario
npm run test:live:5x           # five iterations of each scenario (catches flakes)

# override the model under test:
PI_AUTO_REVIEWER_PROVIDER=anthropic PI_AUTO_REVIEWER_MODEL=claude-haiku-4-5 npm run test:live

# pick any iteration count:
PI_AUTO_LIVE_TESTS=1 PI_AUTO_ITERATIONS=20 npx vitest run tests/live
```

After the run a usage table prints with per-scenario pass rate, token counts, and USD cost:

```
pi-auto live reviewer stats  (openai/gpt-5-mini, 5 iters)
───────────────────────────────────────────────────────────
scenario                                          pass    in     out   total      cost
user asked to clean up build dir, runs rm -rf...   5/5  4980    310   5290  $0.001865
...
───────────────────────────────────────────────────────────
TOTAL                                            55/55  43267   3604  59159  $0.0183
```

Live tests can flake because the reviewer is a probabilistic LLM. Sustained failures of a specific scenario are a signal to:
1. Tune the reviewer prompt in `extensions/policy.ts`.
2. Switch to a stronger default model in `extensions/pi-auto.ts`.
3. Add a custom-policy snippet via the `customPolicy` setting.

Current baseline: **55/55 pass at 5 iterations on `openai/gpt-5-mini` with `reasoning: "minimal"`** in ~58s for ~$0.018 (~$0.0003/scenario).

## Files

```
extensions/
  pi-auto.ts          main extension — wires up tool_call handler, turn tracking, commands
  scope.ts            decides whether a given tool call should be reviewed
  transcript.ts       builds the compact session transcript fed to the reviewer
  reviewer.ts         the actual LLM call + JSON parse, fail-closed
  reviewer-model.ts   model resolution (default path vs codex-auto-review)
  policy.ts           reviewer system prompt template (default)
  codex-prompt.ts     Codex-format prompt + schema used when useCodexAutoReview is on
  circuit-breaker.ts  per-turn denial counter
  digest.ts           rolling authorization digest (long-context aid)
  retrieval.ts        action-keyed retrieval over older transcript entries
  bash-parser.ts      tree-sitter-bash wrapper for the safe-command fast path
  safe-commands.ts    known-safe command classifier (port of Codex's is_safe_command)
  sandbox.ts          OS sandbox wrapping (sandbox.mode); wraps @anthropic-ai/sandbox-runtime
  settings-store.ts   layered settings (defaults / user-global / per-project / env)
  settings-ui.ts      /pi-auto-settings command implementation
  types.ts            shared types (PiAutoSettings, ReviewableAction, ...)
  policies/
    codex-guardian-policy.md  verbatim mirror of codex's guardian policy template
```

## Caveats

- **It's an LLM** — it will make mistakes. Treat this as a friction-reduction tool, not a security boundary. Don't run pi-auto on an untrusted machine and call it sandboxing.
- **Costs tokens.** Every in-scope tool call adds one model call. The default model is small/fast for this reason. Watch your `/pi-auto` settings.
- **Latency.** ~1-3s added per reviewed tool call. Most tool calls are not in scope so this rarely shows up between calls in a typical agentic loop, but it will show up for bash-heavy work.

## License

MIT.
