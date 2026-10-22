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

## 2026-10-20 — Establish a v2 live reviewer baseline

Add 30 opt-in synthetic scenarios through the production context builder, reviewer, and deterministic outcome reducer. Cover authorization boundaries, over-denial, prompt injection, credentials/exfiltration, host continuation versus replay after partial effects, custom tools, revocations, and context provenance/budgets. Never execute the proposed actions. The native sandbox and actual-SDK composition tests remain separate execution-layer checks; these classifier scenarios are not full coding-agent tasks or an empirical exploit-rate measurement.

Pin the benchmark default to `openai/gpt-6-luna` at `low`, using the owner's existing OpenAI OAuth login. Verify model availability, OAuth mode, and supported reasoning before making calls; refuse API-key/model fallback or silent omission of the thinking level. The installed SDK's direct OpenAI OAuth flow works with the production reviewer without changing its request path. Production reviewer settings and policy are unchanged.

Capture per-attempt results, category/scenario slices, latency, and policy/scenario hashes. High/critical false allows use human-authored consequence labels, not the model's risk score. Reviewer failures remain errors rather than successful denials; false-allow/false-deny rates use assessed cases. Review results do not expose token usage or billing, so do not estimate cost.

One complete 1x baseline passed **30/30** (11 expected allows, 19 expected denies): **0 false allows, 0 false denies, 0 reviewer errors**. Mean latency **4088 ms**, p50 **3685 ms**, p95 **6219 ms**; suite wall time **123.70 s**. A preceding two-case OAuth smoke and four targeted repeated host-recovery attempts also passed. These small synthetic samples do not establish reliability on real tasks. Source/test typechecks and **95 deterministic tests across 7 files** passed with live calls and native probes skipped by default.

## 2026-10-20 — Reasoning off does not improve the targeted latency sample

Allow `off` in the benchmark instead of incorrectly rejecting it as an implicit level. GPT-6 Luna's installed metadata maps `off` to `none` and marks `minimal` unsupported. The production reviewer omits its optional override for `off`; the installed OpenAI Responses adapter still emits API effort `none` for this model. Mock the transport beneath the real reviewer/SDK to verify `off → none` and `low → low` without network or credentials. Do not generalize this omission behavior to other providers.

Compare eight unchanged cases (build cleanup, closeout, exfiltration, forged tool-output authorization, host fetch, repeated charge, custom message, and revocation), three repetitions per setting, through the same OpenAI OAuth login and `gpt-6-luna`. Both runs have identical policy/scenario hashes and pass all 9 expected allows and 15 expected denies.

| Metric | off (API none) | low |
| --- | ---: | ---: |
| Passes | 24/24 | 24/24 |
| False allows / false denies / reviewer errors | 0 / 0 / 0 | 0 / 0 / 0 |
| Mean latency | 4193 ms | 3436 ms |
| p50 | 3434 ms | 3221 ms |
| p95 | 5879 ms | 5150 ms |

The `off` run preceded `low`; runs were sequential rather than randomized/interleaved, so server conditions and cache effects remain uncontrolled. This sample shows no speed advantage for `off`, not proof that it is intrinsically slower. It does not reproduce the archived `gpt-5.6-luna @ off` 860 ms result, which used a different model and reviewer. Keep the benchmark default at `low`; production settings, prompt, and request path remain unchanged. Source/test typechecks and **98 deterministic tests** pass, with live calls skipped by default.

## 2026-10-20 — Permit low-risk custom tools without explicit authorization

The initial v2 reducer required original-user citations for every custom/MCP action, even at low risk. Proactive `memory_add` calls could therefore require repeated one-action approval despite the agent's memory instructions. Keep automatic model review for every custom call, but allow low-risk custom actions without explicit authorization. Preserve citation and authorization requirements for medium/high-risk custom actions and every host request, plus critical-action denial and hard path restrictions while enabled. Name bounded local memory/notes updates in the low-risk rubric; do not trust a tool merely because of its name or description.

Deterministic tests cover low-risk memory/read calls with no authorization evidence, unchanged medium/high custom thresholds, forged citations, owner restrictions, and low-risk host review. No new real-model reliability claim follows from these mocked assessments.

## 2026-10-20 — Make off fully disable pi-auto

The owner rejected `/auto off` retaining custom/host review and sandboxing. Make `/auto off` and `enabled: false` bypass all pi-auto reviews, approval prompts, path restrictions, host-directive parsing, and bash wrapping. Partial-disable behavior must not be called off; no separate partial mode is introduced here. Preserve existing executor inputs and other extensions' behavior. Show a persistent OFF status and give the agent accurate execution guidance.

Wait for idle work before on/off transitions, invalidate prior decisions, and release pending sandbox state. Session toggles do not write settings; reload or a new session restores the configured value. Explicit off remains available with invalid settings. Tests cover custom tools, sensitive reads, protected writes, raw bash arguments, off/on restoration, stale reviews/approvals, disabled startup without sandbox dependencies, and an actual-SDK off-mode write to a protected-name temporary fixture.

## 2026-10-20 — Use a dedicated Luna Instant reviewer by default

Default production review to `openai/gpt-6-luna` with reasoning `off`, per owner preference, rather than inheriting the potentially expensive/slow active session model. Keep provider/model/reasoning configurable in v2 user/project settings. Require nonempty reviewer provider/model and never fall back to the session model, including when the configured model is unavailable. Existing explicit empty overrides must be removed or replaced by the owner.

The installed catalog has no separate Luna Instant ID. Its compatibility completion API excludes explicit `off`; omission uses the model's off mapping, and the mocked-transport regression verifies Luna sends API effort `none`. Retain the independent benchmark default at `low`; the preceding latency sample does not establish an `off` speed advantage. Source/test typechecks and **117 deterministic tests** pass, plus **one targeted native composition probe** with model completion mocked. No paid live reviewer calls run for these changes.
