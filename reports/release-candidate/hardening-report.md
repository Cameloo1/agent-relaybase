# Relaybase Release Candidate Hardening Report

Date: 2026-06-01

## Scope

R015 hardening covered the daemon, Node CLI bridge, API error handling, durable logs, export validation, TUI test coverage already present in the Go module, packaging smoke, and release automation surfaces created in R014.

This pass did not broaden product scope and did not add LLM execution. The TUI remains a client; lifecycle work remains daemon-owned.

## Summary

Status: conditionally hardened, with local release publication blocked by missing Go and GoReleaser tooling on this Windows host.

No product P0/P1 issue remains in the surfaces that could be executed locally. One release-candidate hardening issue was found and fixed:

- `LOG_STORE_UNAVAILABLE` diagnostic path added for blocked durable log storage.
- `LogStore.open()` now degrades instead of throwing when `<state-dir>/logs` cannot be opened.
- Queries return empty results with diagnostics while live in-memory logs remain available through the process manager.
- Appends fail locally with a clear unavailable diagnostic instead of hiding the failure.

## Fixes Made In R015

| Area              | File                        | Change                                                                         | Risk addressed                                                                 |
| ----------------- | --------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Durable logs      | `src/logStore.ts`           | Added unavailable-store degraded mode and `LOG_STORE_UNAVAILABLE` diagnostics. | Daemon startup should not crash solely because durable log storage is blocked. |
| Chaos tests       | `tests/unit.test.ts`        | Added huge log payload and unavailable log-store tests.                        | High-volume log and blocked-store behavior now has automated evidence.         |
| Export validation | `tests/integration.test.ts` | Added invalid export destination normalized-error coverage.                    | Export paths fail closed and cannot write outside daemon export root.          |

## Automated Chaos Coverage

| Scenario                          | Status               | Evidence                                                                                                                                 |
| --------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Daemon unavailable                | Covered              | `tests/unit.test.ts` TUI bridge daemon-unavailable test; `node --experimental-strip-types src/cli.ts tui` smoke prints recovery.         |
| Daemon restarts while TUI is open | Partially covered    | TUI event disconnect/reconnect handling exists in Go tests and daemon SSE reconnect tests; full manual TUI binary smoke blocked locally. |
| Event stream disconnects          | Covered              | `tui/internal/tui/model/model_test.go` stream disconnected diagnostics; Node event stream cleanup tests.                                 |
| Event stream reconnects           | Covered              | `tests/integration.test.ts` daemon event stream reconnect test documents state-refresh recovery.                                         |
| Auth token missing                | Covered              | Node unauthorized event/export/mutation tests and TUI missing-token client diagnostics.                                                  |
| Auth token invalid                | Covered              | `tui/internal/tui/model/model_test.go` auth invalid event-stream diagnostic and Node token mismatch tests.                               |
| App emits huge logs               | Covered in R015      | `durable log store handles huge log payloads`.                                                                                           |
| Log store locked/unavailable      | Covered in R015      | `durable log store unavailable path degrades with diagnostics`.                                                                          |
| Log segment corrupt               | Covered              | `durable log store reports corrupt index and segment diagnostics`.                                                                       |
| Preferences corrupt               | Covered              | `tui/internal/preferences/preferences_test.go` corrupt preference quarantine test.                                                       |
| Terminal resize storm             | Partially covered    | Pane resize logic and window-size handling are tested; storm-specific manual TUI smoke blocked locally.                                  |
| Terminal no truecolor             | Covered              | `tui/internal/tui/styles/styles_test.go` terminal color fallback diagnostic.                                                             |
| Ambiguous app names               | Covered              | slash and assistant resolver tests ask clarification instead of guessing.                                                                |
| Component metadata malformed      | Covered              | manifest normalization and `/state` grouped metadata diagnostics tests.                                                                  |
| Export path invalid               | Covered in R015      | Invalid destination returns `LOG_EXPORT_DESTINATION_OUTSIDE_EXPORTS`.                                                                    |
| Ctrl+Z unavailable/conflicting    | Covered              | Go model preference test emits `context_menu_ctrl_z_unavailable`; Ctrl+O fallback test exists.                                           |
| LLM provider missing              | Covered              | Go model missing provider diagnostic test.                                                                                               |
| Remote LLM disabled by default    | Covered              | assistant/provider tests; no remote endpoint call path.                                                                                  |
| Backend returns normalized error  | Covered              | Node normalized error tests and TUI API error decoding test.                                                                             |
| Lifecycle operation timeout       | Covered              | Node lifecycle timeout tests.                                                                                                            |
| Concurrent start/stop conflict    | Covered              | Node operation conflict tests.                                                                                                           |
| Disk full simulation              | Not feasible locally | No safe deterministic disk-full harness on this host. Covered as a planned environment chaos lane.                                       |
| Permission denied on state dir    | Partially covered    | Setup/open permission diagnostics are tested; full OS permission mutation is environment-sensitive on Windows.                           |

## Validation Evidence

Commands run during R015:

- `codegraph-mcp.exe index ... --db ...relaybase-r015-codegraph-pre.sqlite --fresh --json`: passed; 104 files indexed; 0 syntax errors; known budget warnings only.
- `npm.cmd run format`: passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed.
- `npm.cmd test`: passed; 93 tests.
- `npm.cmd run test:jest`: passed; 4 tests.
- `npm.cmd run smoke`: passed with expected local diagnostics because this repo has no `relaybase.app.json` and no daemon running.
- `npm.cmd run package:check`: passed after approved normal npm cache access; tarball had 102 files and included the CLI bridge, build script, docs, and TUI source.
- `node --experimental-strip-types src/cli.ts tui`: expected fail-closed diagnostic because the daemon was offline.
- `node --experimental-strip-types src/cli.ts tui --help`: passed.
- `codegraph-mcp.exe index ... --db ...relaybase-r015-codegraph-post.sqlite --fresh --json`: passed; 108 files indexed; 0 syntax errors; known budget warnings only.

Blocked locally:

- Go commands require `go`, which is not installed/on PATH on this host.
- GoReleaser commands require `goreleaser`, which is not installed/on PATH on this host.

## Verdict

The source hardening pass is complete for locally executable checks. The release candidate is not fully publishable from this host until Go tests/builds and GoReleaser checksum generation run in an environment with the required tooling.
