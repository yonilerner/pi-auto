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
