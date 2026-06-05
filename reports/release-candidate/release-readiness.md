# Relaybase Release Readiness

Date: 2026-06-01

## Verdict

Release readiness status: source hardening complete; binary release readiness blocked on Go/Goreleaser tooling and manual TUI smoke.

No known product P0/P1 remains in locally executable daemon, API, log, export, and Node bridge checks. Final release approval still requires the Go-capable checks listed below.

## Required Answers

| Question                                        | Answer                                                           | Evidence                                                                                                                                                              |
| ----------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Does fresh install work?                        | Partial.                                                         | `npm pack --dry-run` passed in R015 and package contents included the CLI bridge, build script, docs, and TUI source. A disposable install smoke was not run in R015. |
| Does daemon + TUI launch work?                  | Partial.                                                         | `relaybase tui` bridge diagnostics work. Full TUI launch is blocked locally because no Go-built binary exists.                                                        |
| Does sample frontend/backend app group work?    | Yes in automated tests.                                          | Node grouped state tests and Go pane manager tests cover frontend/backend groups; local Go execution is blocked.                                                      |
| Do start/stop/restart work?                     | Yes in Node daemon tests.                                        | Lifecycle start, stop, restart, timeout, and conflict tests pass.                                                                                                     |
| Do logs stream and persist?                     | Yes in Node daemon tests.                                        | SSE log behavior, durable log reopen, pagination, corrupt-segment diagnostics, huge-log handling, and unavailable-store diagnostics are covered.                      |
| Are exports redacted and valid?                 | Yes in Node daemon tests.                                        | `.log`, `.jsonl`, and `.zip` artifacts are generated and inspected; `redaction_report.json` is verified; invalid destinations fail closed.                            |
| Do preferences survive restart?                 | Yes in Go source tests.                                          | TUI preference tests cover persistence, corrupt quarantine, secret rejection, pane pin/color/hidden state, and theme. Local Go execution is blocked.                  |
| Is keyboard-only operation usable?              | Yes in Go source tests.                                          | Keymap, pane navigation, focus/escape, Ctrl+O fallback, help, quit, slash commands, and context menus are tested. Local Go execution is blocked.                      |
| Are destructive actions confirmation-gated?     | Yes in Go source tests.                                          | Slash, menu, and deterministic assistant lifecycle/export paths require confirmation.                                                                                 |
| Does CI pass?                                   | Locally partial.                                                 | `npm.cmd run verify` passed in R014. R015 Node checks pass. Go CI-equivalent commands are blocked locally by missing Go.                                              |
| Are release artifacts generated with checksums? | Not locally.                                                     | `.goreleaser.yml` defines archives and `relaybase-tui-checksums.txt`, but `goreleaser check/dry-run` is blocked because GoReleaser is not installed.                  |
| Are known issues acceptable for release?        | Acceptable only for source RC handoff, not final binary release. | Known issues are environment/tooling/manual-smoke blockers and must be closed before publication.                                                                     |

## Local Commands And State

Passed:

- `npm.cmd run format`
- `npm.cmd run typecheck`
- `npm.cmd run lint`
- `npm.cmd test`
- `npm.cmd run test:jest`
- `npm.cmd run smoke`
- `npm.cmd run package:check`
- `node --experimental-strip-types src/cli.ts tui` with expected daemon-unavailable diagnostic
- `node --experimental-strip-types src/cli.ts tui --help`
- post-edit CodeGraph index

Blocked:

- `npm.cmd run tui:test`
- `npm.cmd run tui:vet`
- `npm.cmd run tui:race`
- `npm.cmd run tui:build`
- `goreleaser check`

## Release Gate

Final release is not approved from this local host. The next gate is a Go-capable CI or release workstation run that proves:

1. `go test ./...` from `tui/`.
2. `go vet ./...` from `tui/`.
3. `go test -race ./...` where stable.
4. `npm run tui:build`.
5. GoReleaser check or dry run with checksums.
6. Manual TUI smoke with a built binary and grouped frontend/backend sample.
