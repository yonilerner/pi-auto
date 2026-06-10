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
