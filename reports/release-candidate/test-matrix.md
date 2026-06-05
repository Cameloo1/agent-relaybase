# Relaybase Release Candidate Test Matrix

Date: 2026-06-01

## Automated Test Matrix

| Test area                | Command or source                                                                | Status           | Notes                                                                                                                             |
| ------------------------ | -------------------------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| CodeGraph pre-edit gate  | `codegraph-mcp.exe index ...relaybase-r015-codegraph-pre.sqlite --fresh --json`  | Pass             | 104 files indexed, 0 syntax errors; known graph output budget warnings.                                                           |
| CodeGraph post-edit gate | `codegraph-mcp.exe index ...relaybase-r015-codegraph-post.sqlite --fresh --json` | Pass             | 108 files indexed, 0 syntax errors; known graph output budget warnings.                                                           |
| Formatting               | `npm.cmd run format`                                                             | Pass             | Prettier completed.                                                                                                               |
| TypeScript typecheck     | `npm.cmd run typecheck`                                                          | Pass             | `tsc --noEmit`.                                                                                                                   |
| ESLint                   | `npm.cmd run lint`                                                               | Pass             | No lint findings.                                                                                                                 |
| Full Node tests          | `npm.cmd test`                                                                   | Pass             | 93 tests passed.                                                                                                                  |
| Jest tests               | `npm.cmd run test:jest`                                                          | Pass             | 4 tests passed.                                                                                                                   |
| CLI health smoke         | `npm.cmd run smoke`                                                              | Pass             | Expected local diagnostics for unconfigured repo/offline daemon.                                                                  |
| CLI TUI bridge smoke     | `node --experimental-strip-types src/cli.ts tui`                                 | Pass/fail-closed | Exited 1 with daemon-unavailable diagnostic and `relaybase serve` recovery.                                                       |
| CLI TUI help             | `node --experimental-strip-types src/cli.ts tui --help`                          | Pass             | Printed usage and binary resolution order.                                                                                        |
| Go TUI tests             | `npm.cmd run tui:test`                                                           | Blocked          | `go` not installed/on PATH locally.                                                                                               |
| Go vet                   | `npm.cmd run tui:vet`                                                            | Blocked          | `go` not installed/on PATH locally.                                                                                               |
| Go race tests            | `npm.cmd run tui:race`                                                           | Blocked          | `go` not installed/on PATH locally.                                                                                               |
| Go TUI build             | `npm.cmd run tui:build`                                                          | Blocked          | `go` not installed/on PATH locally.                                                                                               |
| GoReleaser config check  | `goreleaser check`                                                               | Blocked          | `goreleaser` not installed/on PATH locally.                                                                                       |
| Packaging smoke          | `npm.cmd run package:check`                                                      | Pass             | Required normal npm cache access outside workspace; tarball had 102 files and included bridge, build script, docs, and Go source. |

## Chaos Matrix

| Scenario                          | Automated coverage                                                       | Current status                                      |
| --------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------- |
| Daemon unavailable                | TUI bridge unit test; CLI `relaybase tui` smoke                          | Covered                                             |
| Daemon restarts while TUI is open | Event disconnect/reconnect tests; full manual TUI blocked without binary | Partial                                             |
| Event stream disconnects          | Go model stream-disconnected test                                        | Covered by source tests; local Go execution blocked |
| Event stream reconnects           | Node daemon event stream reconnect integration test                      | Covered                                             |
| Auth token missing                | Node unauthorized mutation/event/export tests                            | Covered                                             |
| Auth token invalid                | TUI model auth-invalid diagnostic; setup token mismatch test             | Covered by source tests; local Go execution blocked |
| App emits huge logs               | R015 `durable log store handles huge log payloads`                       | Covered                                             |
| Log store locked/unavailable      | R015 `durable log store unavailable path degrades with diagnostics`      | Covered                                             |
| Log segment corrupt               | Existing durable log corrupt segment/index test                          | Covered                                             |
| Preferences corrupt               | Go preference corrupt quarantine test                                    | Covered by source tests; local Go execution blocked |
| Terminal resize storm             | Pane resize and window-size handling tests                               | Partial                                             |
| Terminal no truecolor             | Go theme fallback test                                                   | Covered by source tests; local Go execution blocked |
| Ambiguous app names               | Slash/assistant target resolution tests                                  | Covered by source tests; local Go execution blocked |
| Component metadata malformed      | Node manifest metadata diagnostics tests                                 | Covered                                             |
| Export path invalid               | R015 invalid destination test                                            | Covered                                             |
| Ctrl+Z unavailable/conflicting    | Go context menu preference diagnostic and Ctrl+O fallback tests          | Covered by source tests; local Go execution blocked |
| LLM provider missing              | Go model missing provider diagnostic                                     | Covered by source tests; local Go execution blocked |
| Remote LLM disabled by default    | Assistant provider tests                                                 | Covered by source tests; local Go execution blocked |
| Backend normalized error          | Node and TUI client normalized error tests                               | Covered                                             |
| Lifecycle operation timeout       | Node lifecycle timeout tests                                             | Covered                                             |
| Concurrent start/stop conflict    | Node operation conflict tests                                            | Covered                                             |
| Disk full simulation              | Not implemented                                                          | Not feasible safely in this workspace               |
| Permission denied state dir       | Setup/open permission diagnostics                                        | Partial                                             |

## Manual Or Semi-Automated Smoke Matrix

| Smoke item                         | Status              | Evidence or blocker                                                                                       |
| ---------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------- |
| Fresh install                      | Partial             | `npm pack --dry-run` passed in R014; full install into a disposable external project was not run in R015. |
| Start daemon                       | Not run manually    | Node daemon tests start ephemeral daemons; user daemon not started.                                       |
| Launch TUI                         | Blocked locally     | No built `relaybase-tui` binary because Go is not installed. Bridge diagnostics are tested.               |
| Register sample frontend app       | Covered by tests    | Integration tests register fake apps and grouped frontend/backend manifests.                              |
| Register sample backend app        | Covered by tests    | Integration tests register backend component metadata.                                                    |
| See two panes under one group      | Covered by Go tests | Go pane manager/model tests cover frontend/backend grouped panes; local Go execution blocked.             |
| Start app/group                    | Covered by tests    | Node lifecycle tests cover app start. Group-level slash resolution covered in TUI tests.                  |
| Stop app/group                     | Covered by tests    | Node lifecycle tests cover stop and stop verification.                                                    |
| Restart app/group                  | Covered by tests    | Node restart operation test covers stop/start phases.                                                     |
| Stream logs                        | Covered by tests    | Node SSE and log snapshot tests.                                                                          |
| Scroll logs                        | Covered by tests    | Durable log pagination tests.                                                                             |
| Pin pane                           | Covered by Go tests | Local Go execution blocked.                                                                               |
| Change pane color                  | Covered by Go tests | Local Go execution blocked.                                                                               |
| Persist preferences across restart | Covered by Go tests | Local Go execution blocked.                                                                               |
| Export pane logs                   | Covered by tests    | Backend pane scope supports `componentRole`; TUI menu path covered in Go tests.                           |
| Export group logs                  | Covered by tests    | Node group export test.                                                                                   |
| Inspect redaction report           | Covered by tests    | Zip export inspection verifies `redaction_report.json`.                                                   |
| Use slash command                  | Covered by Go tests | Parser/resolver tests; local Go execution blocked.                                                        |
| Use deterministic assistant phrase | Covered by Go tests | Assistant parser/model tests; local Go execution blocked.                                                 |
| Quit cleanly                       | Covered by Go tests | TUI `q` quit command test; local Go execution blocked.                                                    |

## Required Release Evidence Still Needed Outside This Host

- `go test ./...` from `tui/`.
- `go vet ./...` from `tui/`.
- `go test -race ./...` on a stable Go-capable runner.
- `npm run tui:build`.
- GoReleaser check or dry run that generates archives and checksums.
- Manual TUI smoke with a built binary.
