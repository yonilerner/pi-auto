# pi-auto TODOs

Backlog of follow-ups. Not commitments, not prioritized. Add new items
at the bottom of the relevant section.

## Configuration

- [ ] **Settings file + in-pi settings UI.** Today the only way to change
      anything beyond `announceAllows` / `disabled` is to edit
      `DEFAULT_SETTINGS` in `extensions/pi-auto.ts` and relaunch pi
      ([README §Configuration](README.md#configuration)). Two pieces:

      1. **Persisted config at `$PI_AGENT_DIR/extensions/pi-auto.json`**
         (resolves to `~/.pi/agent/extensions/pi-auto.json` by default).
         Read it at extension init, merge over `DEFAULT_SETTINGS`,
         write it back when the user changes a setting from the UI.
         Anything not in the file falls through to the default — so
         partial files (just `reviewerModel`, just `customPolicy`) work.

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
         `customPolicy`, the circuit-breaker thresholds, and the
         transcript caps.

      Notes:
      - Changes from the UI should take effect immediately for the
        current session (mutate the live `settings` object), not
        require a relaunch.
      - `/pi-auto-disable` / `/pi-auto-enable` stay in-memory only
        (current behavior is correct — a fresh launch should always
        start enabled).
      - The settings file path should respect `$PI_AGENT_DIR` if
        pi exposes it; otherwise fall back to `~/.pi/agent`.

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

- [ ] **Per-project policy overlays modeled on Claude Code's
      [`autoMode.environment`](https://code.claude.com/docs/en/auto-mode-config).**
      Users describe their trusted infrastructure in prose (e.g. "we
      deploy via github.example.com/acme-corp, our buckets are
      s3://acme-build-artifacts"); the reviewer treats those as
      evidence about what's internal vs. external when scoring
      `risk_level`. Lower friction than tightly-coded allow/deny
      patterns. Should compose with `customPolicy` rather than replace
      it.

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
