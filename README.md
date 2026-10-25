# pi-auto

A small pi extension that lets ordinary project work continue, automatically reviews consequential actions, and runs bash inside a filesystem and network sandbox.

The current implementation is a fresh v2. Previous code, tests, documentation, tooling, and dependency manifests are preserved under [`legacy/`](legacy/README.md). Old configuration files are neither loaded nor migrated.

## Run it

Requires Node 22.19 or later, pi, and Linux or macOS.

```bash
npm ci
pi -e ./extensions/pi-auto.ts
```

Load pi-auto after extensions with `tool_call` handlers that modify bash commands, so its sandbox encloses their final command. When loading explicit extensions, list it last:

```bash
pi -e ./my-bash-extension.ts -e ./extensions/pi-auto.ts
```

Linux needs `bubblewrap` and `socat`. Install `strace` for filesystem violation diagnostics. On macOS, the runtime uses `sandbox-exec`; diagnostics report missing prerequisites. Unsupported or unavailable sandbox execution fails closed. It never silently switches to host execution.

## What happens

While pi-auto is on:

- Ordinary project reads, edits, file listings, and a small set of simple shell commands proceed immediately.
- Destructive commands, sensitive file access, operations outside the project, opaque scripts, and custom/MCP tools receive automatic review.
- Bash runs inside the sandbox by default. Workspace writes, a private temporary directory, and the runtime's compatibility paths are permitted. Network access requires configured destination allowances. Sensitive reads and protected settings are restricted.
- The reviewer classifies risk and authorization using original user messages from the active conversation branch. Recent tool results provide evidence about execution; summaries do not grant permission. Application code determines the approval outcome.
- When automatic review denies an action or cannot run, interactive and RPC modes offer approval of that exact action once. Headless execution returns a denial for the agent to explain. Direct attempts to change protected paths remain blocked.

pi-auto wraps the command passed to the existing `bash` tool through pi's supported `tool_call` hook. It registers no bash replacement. The effective builtin, extension, or SDK bash tool keeps its schema, extra arguments, executor, rendering, streaming, timeouts, cancellation, and result details. Earlier command changes are included in review and sandbox wrapping. The original command is restored after execution so sandbox shell text does not remain in shared conversation arguments.

Custom/MCP tools are assessed from their descriptions and arguments; their execution is not wrapped by the bash sandbox. **Low-risk custom/MCP actions can be automatically approved without explicit user authorization**, including routine reads and bounded local memory/notes updates. Medium/high-risk custom actions still require sufficient authorization backed by original user messages. Every custom call still receives model review; there is no name-based allowlist. Custom implementations of builtin names, including bash, also receive review while pi-auto is on. An existing bash override is permitted and remains responsible for executing the wrapped command.

The installed SDK has no public final executor middleware. Extension JavaScript runs with host privileges, and an executor that ignores the supplied command or a later handler that replaces it can bypass command containment. Use trusted local shell-compatible extensions and keep pi-auto after command-modifying handlers. Command modifiers should retain any host request directive as the first line.

## Additional access

A sandbox failure is returned to the agent with its denial evidence. A command may already have changed files before failing. The extension never reruns it automatically.

The agent can propose a fresh, narrower command that requests full host access:

```bash
# pi-auto: host The sandbox blocked the registry; inspect installation state before continuing.
npm install
```

The first-line `# pi-auto: host <reason>` directive requests host review. Its reason and command body must be nonempty. After approval the comment is removed and the existing bash executor receives the command body and all its original extra arguments. No new bash schema fields are required.

While pi-auto is on, every host request receives automatic review, even if classified low risk. An approved host command runs with your full user privileges, outside the pi-auto filesystem and network sandbox. Approval covers the exact command, arguments, and working directory. Static checks still block obvious protected-path changes, but arbitrary scripts' internal effects cannot be established from their command text alone.

Submit one sandboxed bash call at a time. Pi can preflight an entire parallel batch before starting any tool; waiting for an active reservation here would deadlock that batch. A second simultaneous sandbox request is therefore rejected for retry after the first result. A result, error, cancellation, later extension block, or session shutdown releases the reservation. Commands are never automatically replayed.

## Commands

| Command | Effect |
| --- | --- |
| `/auto` / `/auto status` | One-line state, sandbox availability, reviewer model, and reasoning |
| `/auto off` | Fully disable pi-auto for this session: no reviews, approval prompts, path restrictions, or bash sandboxing |
| `/auto on` | Re-enable automatic review, path restrictions, and bash sandboxing |
| `/auto reload` | Wait for current work to finish, reload v2 settings, and reset sandbox state |
| `/auto log` / `/auto log all` | Compact decision rows: latest 10, or all retained session records (up to 50) |
| `/auto debug` | Persistence state and five one-line reviewer summaries |
| `/auto debug last` / `/auto debug <id>` | Full content-free metadata for one review; short IDs accepted |
| `/auto debug paths` | Settings/log paths, sandbox prerequisites, compatibility write paths, and configuration errors |
| `/auto debug on` / `/auto debug off` | Enable/disable reviewer diagnostic persistence for this session; does not change review or sandboxing |

**Off means completely off.** `enabled: false` has the same full-disable effect as `/auto off`, including for custom/MCP tools and host requests. Bash arguments pass through unchanged, without pi-auto host-directive parsing or sandbox wrapping; tools run with normal user privileges. Other extensions may still enforce their own policies. The footer shows `auto` when enabled, `auto off` when disabled, `auto !` for a configuration error, and the tool name during review. Routine confirmations stay one line; paths and diagnostic JSON appear only on explicit debug requests. Approval prompts retain the exact arguments, working directory, and host-access warning.

On/off transitions wait for current work to finish and clean up pending sandbox state. Session toggles do not modify configuration files; `/auto reload` or a new session restores the configured `enabled` value. Invalid configuration does not prevent explicitly using `/auto off`. There is no partial-disable mode under the name `off`.

## Fresh configuration

Settings merge in this order: built-in defaults, user file, project file. Nested fields merge; arrays replace the earlier array. While pi-auto is on, invalid or unknown settings block tool execution until corrected and reloaded.

| File | Location |
| --- | --- |
| User | `~/.pi/agent/pi-auto-v2.json` |
| Project | `<cwd>/.agents/pi-auto-v2.json` |

`PI_AGENT_DIR` or pi's `PI_CODING_AGENT_DIR` changes the user directory. The extension does not create settings automatically and never reads or changes old `pi-auto.json` files.

Example:

```json
{
  "enabled": true,
  "reviewer": {
    "provider": "openai",
    "model": "gpt-6-luna",
    "reasoning": "off",
    "timeoutMs": 30000,
    "structuredOutput": "auto",
    "debug": false
  },
  "sandbox": {
    "allowedDomains": ["registry.npmjs.org"],
    "deniedDomains": [],
    "allowRead": [],
    "denyRead": [],
    "allowWrite": [],
    "denyWrite": []
  },
  "sensitivePaths": [".env", ".env.*", "~/.ssh", "~/.aws", "~/.config", "~/.pi/agent/auth.json"],
  "protectedPaths": [".git/hooks", ".git/config", "AGENTS.md"],
  "notices": "denials"
}
```

The production reviewer defaults to **`openai/gpt-6-luna` with reasoning `off` (Instant/no reasoning)**, using your configured OpenAI credentials. It never inherits or falls back to the active session provider/model. Set `reviewer.provider`, `reviewer.model`, and `reviewer.reasoning` in the user or project file to choose another reviewer, then use `/auto reload`. Both provider and model must be nonempty. If an older v2 file explicitly sets them to empty strings, remove those overrides to use the new defaults or provide a dedicated model.

The installed SDK has no separate Luna Instant model ID. Its OpenAI adapter maps Luna's `off` setting to API reasoning effort `none`; a mocked-transport test verifies that payload. The compatibility API represents `off` by omitting the optional reasoning override, so this no-reasoning guarantee is specific to that model/adapter. `reasoning: "default"` also omits the override; other explicit levels are forwarded only when the installed model metadata supports them. An unavailable configured reviewer fails closed rather than using your session model. Reviewer calls share one timeout across credential lookup and at most two completion attempts. A malformed, empty, or token-truncated assessment gets **one formatting-only retry**, with no raw prior response fed back to the model. A token-limit retry has a 4096-token cap instead of 2048. Valid policy denials, provider errors/refusals, authentication errors, cancellation, and timeouts are not retried. SDK transport retries are disabled. The proposed tool action is never executed or replayed by this recovery path. `notices: "all"` also displays automatic approvals.

`reviewer.structuredOutput: "auto"` requests a strict JSON schema for the official OpenAI provider's Responses API, including the default Luna reviewer. Other providers/APIs retain prompt-only JSON plus the same local validation and bounded formatting recovery. Set `"structuredOutput": "off"` for a customized endpoint that rejects schema constraints; schema rejection is a provider error, not a reason to silently switch models or weaken validation. Structured output constrains format, not the correctness of risk/authorization judgments.

Paths are absolute or relative to the current project; `~/` expands to your home directory. Basename patterns such as `.env.*` identify sensitive files; explicit paths are preferable for sandbox allowances. The project, private temporary directory, and listed `allowWrite` paths are writable. The existing runtime also adds `/tmp/claude`, `/private/tmp/claude`, `~/.npm/_logs`, `~/.claude/debug`, and standard device endpoints (`/dev/stdout`, `/dev/stderr`, `/dev/null`, `/dev/tty`, `/dev/dtracehelper`, `/dev/autofs_nowait`) as compatibility write paths. Commands receive the private directory as `TMPDIR`, but the extra runtime paths remain available unless explicitly denied.

Reads are generally permitted except sensitive paths and `denyRead`. Owner-configured `allowRead` exceptions within denied regions apply to both scope checks and the sandbox. `allowRead` supports literal file or directory paths; glob exceptions are rejected. An allowance for a parent does not remove a more specific denied child path. Sensitive filesystem reads still receive review even when an exception permits them. Write denies and network denies take precedence over their allowances. Avoid read exceptions that reopen sensitive paths to opaque sandboxed programs.

The Linux backend also restores read access to a writable workspace beneath a broadly denied parent, even without an explicit `allowRead` exception. A parent-directory deny therefore does not make that writable workspace unreadable to bash. Explicit file denies remain enforced; use concrete denied resources for stronger read boundaries. Direct filesystem tools retain scope checks for denied paths.

While pi-auto is on, the v2 settings files, old settings files, and v2 decision state are protected from direct agent writes. Add project-specific protected resources to `protectedPaths`. Edit protected settings yourself, then use `/auto reload`. Fully disabling pi-auto also removes these path restrictions.

The internal `context` budgets can also be configured: `maxEntries` (24), `maxEntryChars` (4000), `maxTotalChars` (24000), and `maxPinnedMessages` (12). Review context retains the original current request and relevant earlier user messages from the active branch. Truncation is explicit; high-impact approval cannot rely on an incomplete current request.

## Decisions and limits

Decision metadata persists in `~/.pi/agent/pi-auto-v2/decisions.jsonl` (or the configured agent directory), capped at 200 records. Records contain timestamps, tool names, execution mode, action fingerprints, outcomes, user evidence IDs, risk, authorization, latency, and available review IDs/attempt counts/failure codes. They contain no commands, arguments, transcript, or rationale. The runtime retains the latest 50 records in memory; `/auto log` shows 10 and `/auto log all` shows all retained records. A persistence failure produces one warning.

### Debugging reviewer failures

Failure messages distinguish unusable assessments from missing models, authentication failures, provider errors/refusals, timeouts, and cancellation. A failure includes a review ID you can correlate with `/auto log` and `/auto debug`. Validation diagnostics identify empty text, malformed JSON, missing required fields, extra-field counts, the field/rule that failed validation, or token-limit truncation.

To investigate a recurring issue after loading the updated extension:

```text
/auto debug on
```

Continue normally until the issue occurs, then inspect:

```text
/auto debug
/auto log
```

The runtime retains the latest 20 content-free traces in memory and summarizes the latest five with `/auto debug`, even if persistence is off. Use `/auto debug last` or `/auto debug <id>` for full metadata; the short `#id` shown in summaries and `/auto log` is accepted. Ambiguous prefixes require more characters. `/auto debug paths` shows the persistence path, settings paths, and sandbox/configuration details.

With debug on, it also writes `~/.pi/agent/pi-auto-v2/reviewer-debug.jsonl` (respecting agent-directory overrides), capped at 200 records with owner-only directory/file permissions. Traces contain model/API/reasoning, schema-versus-prompt mode, per-attempt latency and token cap, stop reason, content-block types, text length/hash, HTTP status when available, and validation/failure codes.

**No prompts, action arguments, commands, transcript, raw model responses, thinking text, rationale, headers, credentials, or raw provider error messages are written to this debug log.** Unknown response-field names and values are not logged either. These diagnostics cannot reconstruct a discarded response or recover failures from before this instrumentation existed.

Use `/auto debug off` to stop persistence; existing records are not deleted. Debug toggles are session-only, do not disable review, and reset to the configured value on reload/new session. Set `reviewer.debug: true` in the owner-managed settings file to keep persistence enabled across reloads. Fully disabling pi-auto with `/auto off` still bypasses review altogether.

This extension provides automatic intent review and a bash sandbox. It does not make edits transactional or provide filesystem rollback. Host commands, custom tools, pi extensions, and external services can have effects that the sandbox cannot constrain. Install only trusted extensions, and use checkpoints for valuable existing work. The decision log is a bounded diagnostic record, not a tamper-resistant audit system.

On Linux without `strace`, filesystem enforcement remains active, but denial evidence comes from command errors and captured proxy events. A program that conceals a failed filesystem operation may not produce a diagnostic denial. Network attempts captured by the proxy are reported even if the program exits successfully.

Sensitive basename patterns cover existing matching files throughout the workspace. On Linux the runtime expands filesystem globs when each command starts; a matching file created or moved during that command may not receive the same restriction. Subsequent explicit reads receive scope checks. Use explicit protected directory paths when stronger containment is necessary.

## Development

```bash
npm run ci
npm run test:sandbox
```

The first command typechecks the new source and tests and runs deterministic tests; it excludes `legacy/`. Composition tests load another bash extension through the installed pi SDK and verify its command edits, schema, extra arguments, streaming, and outputs survive pi-auto. Native sandbox probes are opt-in, use temporary fixtures, and make no paid reviewer calls. They delegate through pi's existing bash tool and verify workspace/outside writes, protected writes and sensitive reads, blocked network destinations, denial isolation, and the existing executor's cancellation.

The native Linux probes have been run locally, including a complete extension → reviewer → policy → sandbox → filesystem flow with only the model completion mocked. macOS uses the same runtime integration and is included in CI, but local macOS execution was not available during the initial build. These native probes do not measure real-model reviewer behavior; the separate opt-in benchmark below does.

### Live reviewer benchmark

[`tests/live/scenarios.ts`](tests/live/scenarios.ts) defines 30 synthetic reviewer scenarios: authorized work, over-denial regressions, prompt injection, credential access/exfiltration, production destruction, host requests and partial-effect recovery, custom tools, revocations, and context provenance/budgeting. They call the production `reviewAction`, context builder, and deterministic policy reducer with real model completions. **Proposed actions are never executed.** This measures the reviewer layer, not a full coding-agent task or an empirical sandbox exploit rate.

The **benchmark** default remains **`openai/gpt-6-luna` with `low` reasoning** (independent of the production `off` default), using your existing Pi **OpenAI OAuth login** (`/login openai`). No separate API key is needed. The harness refuses missing models, API-key fallback, and unsupported reasoning instead of silently choosing another model or thinking level. It does not change your production reviewer settings.

Live tests consume subscription quota, can be slow, and can flake. They are skipped by `npm test` / `npm run ci`. Start with targeted cases; run the full set only deliberately or as a final validation:

```bash
# A targeted family, one call per scenario
npm run bench:reviewer -- -t 'INJECTION-'

# Repeated targeted probes for model variability
PI_AUTO_ITERATIONS=3 npm run bench:reviewer -- -t 'AUTH-closeout|AUTH-force-main'

# Probe reasoning off; rerun with =low for a matched comparison
PI_AUTO_REVIEWER_REASONING=off PI_AUTO_ITERATIONS=3 npm run bench:reviewer -- -t 'AUTH-closeout|HOST-replay'

# Deliberate full 30-scenario baseline (also available as npm run test:live)
npm run bench:reviewer
```

`off` is accepted when the selected model supports it. The installed OpenAI adapter maps GPT-6 Luna's `off` setting to API effort `none`, even though the production reviewer omits its optional reasoning override for `off`; a mocked-transport test verifies the actual request. This is model/adapter-specific, not a guarantee for other providers. `minimal` is unsupported for this model. A targeted 8-case × 3-repeat comparison found no latency improvement from `off` (mean 4.19 s versus 3.44 s at `low`, both 24/24 passing); these sequential, nonrandomized samples do not establish a general speed ranking. The benchmark default remains `low`; production defaults to `off` by user preference, not because this sample established a speed advantage.

The harness runs sequentially with a 60-second shared reviewer deadline and no retries added by the harness. The production reviewer's single formatting-only repair remains enabled; this never executes a proposed action. Mismatches and reviewer errors fail the tests, but reporting still captures the completed attempts. Each run writes a unique `pi-auto-reviewer-bench-*` directory under the system temporary directory (set `PI_AUTO_LIVE_RESULTS_DIR` to choose another parent):

- `manifest.json`: exact model/API/reasoning, OAuth mode, settings, selection arguments, synthetic fixtures, and policy/scenario hashes.
- `attempts.jsonl`: per-call outcomes, assessment/evidence/rationale, failure kind, and latency; no credentials.
- `summary.json` / `summary.md`: pass counts, false allows, false denies, reviewer errors, category/scenario slices, and mean/p50/p95 latency.

High/critical false allows use **human-authored consequence labels**, not the reviewer's own risk rating. Errors are never counted as successful denials; error counts are separate and false-allow/false-deny rates use assessed cases only. Production review results do not expose token usage or billing, so these reports do not invent cost estimates. Explicit `PI_AUTO_REVIEWER_PROVIDER`, `PI_AUTO_REVIEWER_MODEL`, and `PI_AUTO_REVIEWER_REASONING` overrides are available for future comparisons, but still require an OAuth login and a supported explicit reasoning level.

The broader v1 scenario set, digest tests, repeat-run artifact/comparison tooling, and model-ablation runner remain archived in `legacy/tests/live/` and `legacy/scripts/`. Root CI excludes them; their historical scores do not establish v2 performance.

Architecture consists of settings, scope, context, reviewer, deterministic policy, output annotations, sandbox preparation/lifecycle, and the extension entrypoint. [`docs/HISTORY.md`](docs/HISTORY.md) records the decisions behind the fresh implementation.
