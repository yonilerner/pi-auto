# pi-auto repo notes for agents

## Live tests

The live test suite (`tests/live/`, gated by `PI_AUTO_LIVE_TESTS=1`) hits the
real reviewer/summarizer LLM. It is slow and costs money.

**Default: always run targeted live tests, not the whole suite.** Use vitest's
`-t <pattern>` to scope to the scenarios you actually need to validate, and
only widen to the full suite when you have a specific reason (e.g. a final
pre-commit sanity check, or measuring aggregate pass rates).

Examples:

```bash
# Just the regression scenarios in reviewer-scenarios.test.ts
PI_AUTO_LIVE_TESTS=1 npx vitest run tests/live/reviewer-scenarios.test.ts -t REGRESSION

# A single named test
PI_AUTO_LIVE_TESTS=1 npx vitest run tests/live -t "interview tool"

# Whole digest-summarizer file (small, OK to run as a unit)
PI_AUTO_LIVE_TESTS=1 npx vitest run tests/live/digest-summarizer.test.ts
```

Run the whole live suite (`npm run test:live` / `npm run test:live:5x`) only
when explicitly asked or as a final check.

## Git

Use gitbutler for all git operations in this repo. The skill is at
[`.agents/skills/gitbutler/SKILL.md`](./.agents/skills/gitbutler/SKILL.md);
load it before invoking any git command.

## History doc

[`docs/HISTORY.md`](./docs/HISTORY.md) is the canonical record of the
review system and sandbox: what we built, why, and what we measured. It
is not a generic changelog.

**Update it when** you make a substantial change to:
- the reviewer prompt / policy template,
- the reviewer payload shape (the action JSON, the transcript shape,
  the retryReason field, etc.),
- the reviewer model selection or reasoning settings,
- the sandbox modes, lifecycle, denial handling, or askCallback wiring,
- the safe-command fast path,

or when you make a new finding about how any of the above behaves
(e.g. a measured regression, a discovered model failure mode, a
benchmark result that informs future decisions).

**Do not update it for** unrelated features, refactors that don't
change behavior, doc/typo fixes, dependency bumps, or routine
maintenance.

Match the existing style: terse, decision-shaped (one section per
decision, ideally tied to a commit hash), with concrete numbers where
available. Forward-looking items go in [`TODO.md`](./TODO.md), not
here. Settings reference goes in [`README.md`](./README.md), not here.
