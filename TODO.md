# pi-auto TODOs

Backlog of follow-ups. Not commitments, not prioritized. Add new items
at the bottom of the relevant section.

**When you complete a TODO, remove it from this file.** Add a section to
[`docs/HISTORY.md`](docs/HISTORY.md) capturing what was built and any
measurements that informed the decision — see HISTORY.md's own rubric
for when an entry is warranted. This file is the open-work backlog only;
the completed-work log lives in HISTORY.md.

## Configuration

- [ ] **Per-project `environment` prose field.** Modeled on Claude
      Code's
      [`autoMode.environment`](https://code.claude.com/docs/en/auto-mode-config).
      A free-form prose field where the user describes their trusted
      infrastructure (e.g. "we deploy via github.example.com/acme-corp,
      our buckets are s3://acme-build-artifacts"); the reviewer treats
      it as evidence about what's internal vs. external when scoring
      `risk_level`. Lower friction than tightly-coded allow/deny
      patterns. Composes with `customPolicy` rather than replacing it.
      Naturally lives in per-project JSON. The settings plumbing
      (loader + UI) shipped without this field because wiring it into
      the reviewer prompt is a measurement-driven decision — we want
      to ablate the prompt placement (system prompt vs. action payload
      vs. spliced into `customPolicy`) against the live scenario set
      before settling. Pick this up alongside eval-set scaling (below).

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
