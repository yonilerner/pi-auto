# Review and sandbox decisions

The v1 record is preserved at [`legacy/docs/HISTORY.md`](../legacy/docs/HISTORY.md). This file records decisions for the minimal v2.

## 2026-10-09 — Replace v1 with a small extension

Archive the previous implementation, documentation, tests, scripts, vendor snapshot, and tooling under `legacy/`. Rebuild around common scope rules, an LLM classifier, a deterministic outcome reducer, and sandbox command wrapping. Keep ordinary workspace autonomy, custom/MCP review, Linux/macOS sandbox support, and automatic approval of explicit full-host requests. Drop rolling digest/retrieval machinery, multiple sandbox modes, automatic escape replay, circuit-breaker/UI settings frameworks, and vendor synchronization.

New `pi-auto-v2.json` names start fresh. Existing settings remain untouched. Protect reviewer settings and decision state from direct tool writes. Invalid settings fail closed. Pausing review skips sandbox command pre-review only: keep bash sandboxing, hard restrictions, and review of full-host/custom/consequential in-process filesystem actions.

## 2026-10-09 — Assess intent before consequential execution

Workspace deletion and opaque scripts receive review before execution. Supported filesystem and shell scope rules share sensitive/protected path semantics, including symlink resolution. Custom/MCP descriptions and arguments enter review as untrusted evidence, not authority. Use actual host source metadata to keep custom implementations of builtin names, including bash, out of routine exemptions.

Review authorization uses original active-branch user messages; execution evidence has structural provenance. No digest or compaction summary grants permission. The model emits risk, authorization, evidence IDs, and rationale; code chooses the outcome. Critical actions require exact user approval, and high-risk/host/custom actions need valid original-user citations. Default review uses the active session model without a reasoning override. Forward explicit reasoning levels only when model metadata supports them; prior v1 experiments found unsupported levels can produce unusable responses. An unavailable explicit reviewer does not fall back. Reviewer calls have a deadline and no automatic retry.

## 2026-10-09 — Host access is a fresh action

Use a first-line shell comment, `# pi-auto: host <reason>`, to request full-host execution without changing the effective bash schema. Review the command body, exact arguments, reason, and working directory, then strip the directive before delegation. Every host request receives review, even while ordinary pre-review is paused. A denied sandbox command returns its effects and diagnostic evidence; it never triggers a full-command rerun. Invalidate pending decisions when prompts, settings, sessions, or branches change. Host approval grants full user privileges; arbitrary script effects and custom/MCP implementation remain outside sandbox enforcement.

Delegate execution, timeout, output bounds, streaming, and cancellation to the existing effective bash tool. Use one nonblocking sandbox reservation to keep global runtime configuration and denial events associated with one delegated command. Reject a concurrent preparation immediately: pi's parallel scheduler preflights the full batch before execution, so waiting for another command's result in preflight would deadlock. Finalize on tool result; cancel abandoned preparations on execution end and lifecycle cleanup. Never create a separate host executor or replay path.

## 2026-10-09 — Preserve existing bash integrations

The first fresh build registered its own bash definition and rejected competing overrides. The user required composition with other bash extensions. Remove that definition, schema identity check, and independent executor. The installed SDK exposes mutable `tool_call`/`tool_result` hooks but no public getter for the effective executor or final middleware. Wrap only `input.command`, preserve every other argument and the existing definition/schema/rendering/results, and restore the pre-wrapper command after execution to avoid leaking wrapper text into shared conversation arguments.

Load pi-auto after command-modifying handlers so it reviews and wraps their final command. Trusted extension JavaScript and behavior outside the delegated command remain a host trust boundary; a later handler can replace the wrapper. Custom bash implementations still receive mandatory intent review, even with builtin sandbox pre-review paused. Actual-SDK composition tests cover earlier modifiers, custom schemas/arguments, partial updates, result details, override load order, failed preparation, and host delegation.

## 2026-10-09 — Test actual execution and keep logs small

Before the wrapping correction, source/test typechecks, 79 deterministic tests, and 8 native Linux probes passed. Those results established the first implementation's behavior, not composition with an existing bash executor. Final wrapping validation passed source/test typechecks, 78 deterministic tests across 6 files, and 9 native Linux probes. Five composition tests use actual pi loading/delegation; native probes exercise the existing core and modified bash executors, preserve extra arguments/details/streaming, and verify cancellation releases the runtime reservation. Native probes require execution outside the surrounding Codex sandbox because the runtime needs local proxy sockets. No paid LLM tests run. macOS is included in CI; it has not run locally.

Compile bare sensitive-file patterns recursively across the workspace. Linux runtime glob expansion snapshots existing matches before each command; it cannot guarantee equivalent secrecy for matching files created or moved during the same command. Keep this limitation explicit rather than treating shell pattern classification as complete enforcement.

Honor the runtime's owner-configured read exception precedence in direct tool scope too: literal file/directory `allowRead` exceptions can carve readable paths out of `denyRead`, while sensitive reads retain intent review. Reject glob read exceptions to avoid platform-specific interpretation differences. This keeps a denied parent plus allowed workspace usable through both filesystem and shell tools. Write and network denies retain precedence over allowances.

Normalize exact literal configured read-deny/read-allow matches before passing them to the runtime: macOS otherwise re-emits the nested deny when a parent allowance also exists. Preserve automatic sensitive roots and nonmatching/glob denies. Linux implicitly restores a writable workspace under a broadly denied parent even without `allowRead`; explicit file denies stay enforced. Document this backend limit rather than claiming parent-directory read denial completely contains a writable workspace.

The sandbox runtime's dependency check does not report a missing Linux `strace` although enabling its monitor requires it. Treat tracing as optional: preserve bubblewrap enforcement, warn, and use process errors/proxy events for denial evidence. CI installs `strace` to exercise the monitored route.

The runtime always adds compatibility write paths beyond configured project/private temporary paths: `/tmp/claude`, `/private/tmp/claude`, `~/.npm/_logs`, `~/.claude/debug`, and standard device endpoints. Retain and document these rather than patching dependency globals. Correct the command's `TMPDIR` inside its shell preamble to use the private session directory, since the runtime otherwise replaces it with `/tmp/claude`. Scope denies and sandbox enforcement constrain known direct paths; reviewer-approved opaque host execution retains actual full user privileges.

Persist only bounded decision metadata in a new user-state directory: 200 records, no commands, arguments, rationale, or transcript. Keep 50 recent records in memory if persistence fails. The log aids diagnosis; it is not authorization evidence or a tamper-resistant audit record.
