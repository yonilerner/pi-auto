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

- Ordinary project reads, edits, file listings, and a small set of simple shell commands proceed immediately.
- Destructive commands, sensitive file access, operations outside the project, opaque scripts, and custom/MCP tools receive automatic review.
- Bash runs inside the sandbox by default. Workspace writes, a private temporary directory, and the runtime's compatibility paths are permitted. Network access requires configured destination allowances. Sensitive reads and protected settings are restricted.
- The reviewer classifies risk and authorization using original user messages from the active conversation branch. Recent tool results provide evidence about execution; summaries do not grant permission. Application code determines the approval outcome.
- When automatic review denies an action or cannot run, interactive and RPC modes offer approval of that exact action once. Headless execution returns a denial for the agent to explain. Direct attempts to change protected paths remain blocked.

pi-auto wraps the command passed to the existing `bash` tool through pi's supported `tool_call` hook. It registers no bash replacement. The effective builtin, extension, or SDK bash tool keeps its schema, extra arguments, executor, rendering, streaming, timeouts, cancellation, and result details. Earlier command changes are included in review and sandbox wrapping. The original command is restored after execution so sandbox shell text does not remain in shared conversation arguments.

Custom/MCP tools are assessed from their descriptions and arguments; their execution is not wrapped by the bash sandbox. Custom implementations of builtin names, including bash, also receive review even with sandbox pre-review paused. An existing bash override is permitted and remains responsible for executing the wrapped command.

The installed SDK has no public final executor middleware. Extension JavaScript runs with host privileges, and an executor that ignores the supplied command or a later handler that replaces it can bypass command containment. Use trusted local shell-compatible extensions and keep pi-auto after command-modifying handlers. Command modifiers should retain any host request directive as the first line.

## Additional access

A sandbox failure is returned to the agent with its denial evidence. A command may already have changed files before failing. The extension never reruns it automatically.

The agent can propose a fresh, narrower command that requests full host access:

```bash
# pi-auto: host The sandbox blocked the registry; inspect installation state before continuing.
npm install
```

The first-line `# pi-auto: host <reason>` directive requests host review. Its reason and command body must be nonempty. After approval the comment is removed and the existing bash executor receives the command body and all its original extra arguments. No new bash schema fields are required.

Every host request receives automatic review, including while ordinary pre-review is paused. An approved host command runs with your full user privileges, outside the pi-auto filesystem and network sandbox. Approval covers the exact command, arguments, and working directory. Static checks still block obvious protected-path changes, but arbitrary scripts' internal effects cannot be established from their command text alone.

Submit one sandboxed bash call at a time. Pi can preflight an entire parallel batch before starting any tool; waiting for an active reservation here would deadlock that batch. A second simultaneous sandbox request is therefore rejected for retry after the first result. A result, error, cancellation, later extension block, or session shutdown releases the reservation. Commands are never automatically replayed.

## Commands

| Command | Effect |
| --- | --- |
| `/auto status` | Show review state, sandbox availability, reviewer model, and settings paths |
| `/auto off` | Pause sandbox command pre-review for this session; retain sandbox, hard restrictions, and review of host/custom/sensitive filesystem actions |
| `/auto on` | Resume automatic review |
| `/auto reload` | Wait for current work to finish, reload v2 settings, and reset sandbox state |
| `/auto log` | Show recent decision metadata |

`enabled: false` has the same bounded effect as `/auto off`. Routine workspace reads and edits remain fast; consequential actions without sandbox containment still receive review. Session toggles do not modify configuration files. Disabling or unloading the extension itself removes its protections.

## Fresh configuration

Settings merge in this order: built-in defaults, user file, project file. Nested fields merge; arrays replace the earlier array. Invalid or unknown settings block tool execution until corrected and reloaded.

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
    "provider": "",
    "model": "",
    "reasoning": "default",
    "timeoutMs": 30000
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

Empty reviewer provider/model selects the active session model with its existing credentials. Set both fields to select a separate reviewer. An unavailable configured model does not fall back to another model. Default reasoning omits a thinking-level override and uses provider/model defaults. Explicit reasoning levels are forwarded only when the installed model metadata supports them; `off` also omits an override rather than guaranteeing that a reasoning model stops thinking. Reviewer calls have a timeout and no automatic retries. `notices: "all"` also displays automatic approvals.

Paths are absolute or relative to the current project; `~/` expands to your home directory. Basename patterns such as `.env.*` identify sensitive files; explicit paths are preferable for sandbox allowances. The project, private temporary directory, and listed `allowWrite` paths are writable. The existing runtime also adds `/tmp/claude`, `/private/tmp/claude`, `~/.npm/_logs`, `~/.claude/debug`, and standard device endpoints (`/dev/stdout`, `/dev/stderr`, `/dev/null`, `/dev/tty`, `/dev/dtracehelper`, `/dev/autofs_nowait`) as compatibility write paths. Commands receive the private directory as `TMPDIR`, but the extra runtime paths remain available unless explicitly denied.

Reads are generally permitted except sensitive paths and `denyRead`. Owner-configured `allowRead` exceptions within denied regions apply to both scope checks and the sandbox. `allowRead` supports literal file or directory paths; glob exceptions are rejected. An allowance for a parent does not remove a more specific denied child path. Sensitive filesystem reads still receive review even when an exception permits them. Write denies and network denies take precedence over their allowances. Avoid read exceptions that reopen sensitive paths to opaque sandboxed programs.

The Linux backend also restores read access to a writable workspace beneath a broadly denied parent, even without an explicit `allowRead` exception. A parent-directory deny therefore does not make that writable workspace unreadable to bash. Explicit file denies remain enforced; use concrete denied resources for stronger read boundaries. Direct filesystem tools retain scope checks for denied paths.

The v2 settings files, old settings files, and v2 decision state are protected from direct agent writes. Add project-specific protected resources to `protectedPaths`. Changes to protected settings are owner operations: edit them yourself, then use `/auto reload`.

The internal `context` budgets can also be configured: `maxEntries` (24), `maxEntryChars` (4000), `maxTotalChars` (24000), and `maxPinnedMessages` (12). Review context retains the original current request and relevant earlier user messages from the active branch. Truncation is explicit; high-impact approval cannot rely on an incomplete current request.

## Decisions and limits

Decision metadata persists in `~/.pi/agent/pi-auto-v2/decisions.jsonl` (or the configured agent directory), capped at 200 records. Records contain timestamps, tool names, execution mode, action fingerprints, outcomes, user evidence IDs, risk, authorization, and latency. They contain no commands, arguments, transcript, or rationale. `/auto log` retains the latest 50 records in memory; a persistence failure produces one warning.

This extension provides automatic intent review and a bash sandbox. It does not make edits transactional or provide filesystem rollback. Host commands, custom tools, pi extensions, and external services can have effects that the sandbox cannot constrain. Install only trusted extensions, and use checkpoints for valuable existing work. The decision log is a bounded diagnostic record, not a tamper-resistant audit system.

On Linux without `strace`, filesystem enforcement remains active, but denial evidence comes from command errors and captured proxy events. A program that conceals a failed filesystem operation may not produce a diagnostic denial. Network attempts captured by the proxy are reported even if the program exits successfully.

Sensitive basename patterns cover existing matching files throughout the workspace. On Linux the runtime expands filesystem globs when each command starts; a matching file created or moved during that command may not receive the same restriction. Subsequent explicit reads receive scope checks. Use explicit protected directory paths when stronger containment is necessary.

## Development

```bash
npm run ci
npm run test:sandbox
```

The first command typechecks the new source and tests and runs deterministic tests; it excludes `legacy/`. Composition tests load another bash extension through the installed pi SDK and verify its command edits, schema, extra arguments, streaming, and outputs survive pi-auto. Native sandbox probes are opt-in, use temporary fixtures, and make no paid reviewer calls. They delegate through pi's existing bash tool and verify workspace/outside writes, protected writes and sensitive reads, blocked network destinations, denial isolation, and the existing executor's cancellation.

The native Linux probes have been run locally, including a complete extension → reviewer → policy → sandbox → filesystem flow with only the model completion mocked. macOS uses the same runtime integration and is included in CI, but local macOS execution was not available during this build. No live LLM tests ran during implementation. Historical live tests remain in `legacy/tests/live/`; follow [`AGENTS.md`](AGENTS.md) before running them.

Architecture consists of settings, scope, context, reviewer, deterministic policy, output annotations, sandbox preparation/lifecycle, and the extension entrypoint. [`docs/HISTORY.md`](docs/HISTORY.md) records the decisions behind the fresh implementation.
