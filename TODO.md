# pi-auto TODOs

Backlog of follow-ups. Not commitments, not prioritized. Add new items
at the bottom of the relevant section.

## Configuration

- [x] **Settings file + in-pi settings UI.** Today the only way to change
      anything beyond `announceAllows` / `disabled` is to edit
      `DEFAULT_SETTINGS` in `extensions/pi-auto.ts` and relaunch pi
      ([README §Configuration](README.md#configuration)). Two pieces:

      1. **Persisted config at two layers.** Both are JSON, both are
         partial (only the fields the user sets), both merge over
         `DEFAULT_SETTINGS`:

         - **User-global:** `$PI_AGENT_DIR/extensions/pi-auto.json`
           (resolves to `~/.pi/agent/extensions/pi-auto.json` by
           default). The persistent home for your usual reviewer
           model, transcript caps, sandbox mode, etc.
         - **Per-project:** `.agents/pi-auto.json` at the project
           root (search upward from cwd the same way pi's project-
           config discovery does). Lets you set
           `customPolicy` / `environment` / `sandbox.mode` /
           `sensitivePathPatterns` etc. per repo without polluting
           your global config. Checked in alongside `AGENTS.md` so
           the whole team gets the same reviewer behavior.

         Merge precedence (lowest to highest), applied per-field:
         `DEFAULT_SETTINGS` → user-global JSON → per-project JSON →
         env-var overrides (see env-var note below). Partial files at
         any layer are fine — unset fields fall through.

         Read all of these at extension init. The UI writes back to
         user-global by default; offer an explicit "save to project"
         toggle in the form for fields that are obviously
         per-project (`customPolicy`, `environment`,
         `sensitivePathPatterns`, `extraSafeCommandPrefixes`).

      2. **Interactive settings UI inside pi.** Other extensions
         already do this (see pi docs under `docs/tui.md` and the
         examples under `examples/extensions/` for the API surface);
         the typical shape is a slash command that opens a form via
         `ctx.ui` and writes the result back. Bind it to `/pi-auto`
         (replace the current read-only printout) or a new
         `/pi-auto-settings` command. Should at minimum cover:
         `reviewerProvider`, `reviewerModel`, `useCodexAutoReview`,
         `reviewerTimeoutMs`, `enableDigest`, `announceAllows`,
         `sensitivePathPatterns`, `extraSafeCommandPrefixes`,
         `customPolicy`, `environment` (see Per-project environment
         overlay below), `sandbox.mode` plus any other
         `SandboxSettings` fields, the circuit-breaker thresholds,
         and the transcript caps. The form should indicate which
         layer each field is currently loaded from (default /
         user-global / per-project / env) so users can tell where a
         value came from.

      Notes:
      - Changes from the UI should take effect immediately for the
        current session (mutate the live `settings` object), not
        require a relaunch.
      - `/pi-auto-disable` / `/pi-auto-enable` stay in-memory only
        (current behavior is correct — a fresh launch should always
        start enabled).
      - The settings file path should respect `$PI_AGENT_DIR` if
        pi exposes it; otherwise fall back to `~/.pi/agent`.
      - **Any env-var-driven configuration must also be a settings
        field, with the env var winning when both are set.** Today
        `PI_AUTO_USE_CODEX_POLICY` in `extensions/policy.ts` is the
        only example, but the principle applies to any future env
        var. Full precedence (lowest to highest):
        `DEFAULT_SETTINGS` → user-global JSON → per-project JSON →
        `process.env.PI_AUTO_X`. Env vars are the escape hatch for
        one-off runs (CI, ad-hoc benchmarks); the settings files are
        the persistent home. Don't add an env var without a matching
        field. Document the precedence rule explicitly in the settings
        reference (README §Configuration) when this ships.

      - **Per-project `environment` field** modeled on Claude Code's
        [`autoMode.environment`](https://code.claude.com/docs/en/auto-mode-config).
        A free-form prose field where the user describes their
        trusted infrastructure (e.g. "we deploy via
        github.example.com/acme-corp, our buckets are
        s3://acme-build-artifacts"); the reviewer treats it as
        evidence about what's internal vs. external when scoring
        `risk_level`. Lower friction than tightly-coded allow/deny
        patterns. Composes with `customPolicy` rather than replacing
        it. Naturally lives in per-project JSON. **NOTE:** the
        settings plumbing (loader + UI) shipped without this field
        because wiring it into the reviewer prompt is a measurement-
        driven decision — we want to ablate the prompt placement
        (system prompt vs. action payload vs. spliced into
        `customPolicy`) against the live scenario set before settling.
        Pick this up alongside eval-set scaling (below).

- [x] **Show saved values in settings UI confirmations.** The
      `/pi-auto-settings` save notification currently says e.g.
      `pi-auto settings: saved Fall back to active model to user-global
      (/Users/yonilerner/.pi/agent/extensions/pi-auto.json)` without
      including the value that was saved. Include the rendered value in
      the confirmation so users can verify at a glance what changed.

- [x] **Add an explicit settings reload command.** Add a slash command
      that reloads layered settings from disk and reapplies every
      side-effecty subsystem, including sandbox runtime reset/reload.
      This should be the documented way to apply manual JSON edits
      without toggling a random setting or restarting pi.

- [ ] **Copy inherited arrays when editing project-level list settings.**
      If we add UI support for project-level list fields (or extend the
      existing settings UI to cover list fields), adding an item to a
      previously unset project-level array should start from the
      effective inherited value rather than writing an array containing
      only the new item. Example: if user-global
      `extraSafeCommandPrefixes` or `sandbox.allowedDomains` already
      has entries, and the project config doesn't set that array yet,
      the first project-level "add" action should copy the inherited
      entries and append the new one. This preserves the mental model
      that project config overrides only fields the project actually set,
      while still making array edits intuitive despite arrays being
      replaced rather than concatenated during layered loading.

## Reviewer architecture

- [ ] **Two-stage classifier.** Anthropic's auto mode
      ([engineering blog](https://www.anthropic.com/engineering/claude-code-auto-mode))
      uses a fast single-token yes/no first pass and only invokes the
      full-reasoning classifier when the first pass flags. Would cut
      reviewer cost on routine calls, which are the bulk of real
      sessions. Blocker for shipping this is the eval set: the only way
      to know whether the fast pass silently drops safety-critical
      denials is to measure recall against a benchmark large enough
      that flake variance doesn't drown the signal. Our current
      60-scenario × 5-iter suite has a ±2-scenario flake floor, which
      can't reliably detect a 2–3-case recall regression. See the eval
      set entry below.

## Eval

- [ ] **Grow the live-test suite beyond ~60 scenarios.** Probably the
      single highest-leverage open item for this project. Today's
      `tests/live/reviewer-scenarios.test.ts` plus the digest tests
      run at 5 iters each, giving us ~315 attempts per 5x run. Flake
      noise is roughly ±5 scenarios. Most prompt-edit deltas we'd want
      to detect (single-clause clarifications, payload-shape tweaks)
      land in the ±3–case range, which is not statistically
      distinguishable from noise on a suite this size. Options:

      1. Generate adversarial scenarios from real over-allow / over-
         deny patterns observed during day-to-day use. (Anthropic's
         set includes 52 real overeager actions captured in the wild.)
      2. Permute existing scenarios across authorization-strength
         variants ("you may want to" vs. "please do" vs. "do X now")
         to stress the `user_authorization` axis.
      3. Add cost-of-fixing tracking: when a scenario fails, log the
         exact rationale strings so we can categorize failure modes
         without manually re-reading every run.
