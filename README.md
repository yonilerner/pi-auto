# pi-auto

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
| `bash`              | **Always**                                                          |
| `write`, `edit`     | Only when the target path is **outside cwd**                        |
| `read`              | Outside cwd, **or** matching a sensitive-path heuristic (~/.ssh, ~/.aws, .env, credentials files, …) |
| `grep`, `find`, `ls`| Never                                                               |
| Custom / MCP tools  | **Always** (we don't know what they do)                             |

Reading credential files is treated as risky even though it's "read-only": the contents enter the conversation context and can later be exfiltrated by `bash`.

## Behavior

- **allow** → tool runs. A small inline notification shows the risk level, authorization, and rationale (toggle off with `/pi-auto-toggle-announce`).
- **deny** → tool is hard-blocked with the reviewer's rationale. The agent is told "find a materially safer alternative, or stop and ask the user" — Codex's wording, lightly adapted.
- **reviewer failed** (timeout, no API key, unparseable response, …) → falls back to prompting the user. In non-interactive modes (`-p`, JSON), fails closed.

### Circuit breaker

Mirrors Codex: after **3 consecutive denials** or **10 total denials** in a single turn, pi-auto interrupts the turn and surfaces a prompt to the user explaining why. The user can stop the turn or approve the latest action and continue (one-shot — the breaker still trips on the next runaway loop).

## Configuration

The defaults live in `extensions/pi-auto.ts` (`DEFAULT_SETTINGS`):

```ts
{
  reviewerProvider: "openai",
  reviewerModel: "gpt-5-mini",
  fallbackToActiveModel: true,            // if reviewer model isn't configured, use the current agent model
  reviewerTimeoutMs: 30_000,
  maxConsecutiveDenialsPerTurn: 3,
  maxTotalDenialsPerTurn: 10,
  maxTranscriptEntries: 40,
  maxEntryChars: 2_000,
  sensitivePathPatterns: [
    "~/.ssh", "~/.aws", "~/.gnupg", "~/.kube", "~/.config/gh",
    "~/.netrc", "~/.npmrc", "~/.pypirc",
    "/etc/shadow", "/etc/sudoers",
    "credentials", ".env",
  ],
  announceAllows: true,
  customPolicy: "",                       // appended to the base policy if set
}
```

Run `/pi-auto` inside pi to see the active settings.

## Commands

- `/pi-auto` — show current configuration.
- `/pi-auto-toggle-announce` — toggle inline rationale messages for allowed actions.

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
- `transcript.test.ts` — compact transcript builder
- `policy.test.ts` — reviewer system prompt
- `handler.test.ts` — end-to-end orchestration with mocked review results (allow / deny / failed / circuit-breaker)

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
  policy.ts           reviewer system prompt template
  circuit-breaker.ts  per-turn denial counter
  types.ts            shared types
```

## Caveats

- **It's an LLM** — it will make mistakes. Treat this as a friction-reduction tool, not a security boundary. Don't run pi-auto on an untrusted machine and call it sandboxing.
- **Costs tokens.** Every in-scope tool call adds one model call. The default model is small/fast for this reason. Watch your `/pi-auto` settings.
- **Latency.** ~1-3s added per reviewed tool call. Most tool calls are not in scope so this rarely shows up between calls in a typical agentic loop, but it will show up for bash-heavy work.

## License

MIT.
