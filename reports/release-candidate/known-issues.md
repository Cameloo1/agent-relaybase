# Relaybase Release Candidate Known Issues

Date: 2026-06-01

## Summary

No known product P0/P1 issue remains after the R015 source hardening fix. Remaining issues are release-environment or manual-smoke blockers for this local Windows host.

## Issues

| ID          | Severity              | Area                  | Status | Details                                                                                                                                                           | Release decision                                                                                                                                                                          |
| ----------- | --------------------- | --------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R015-KI-001 | Environment blocker   | Go toolchain          | Open   | `go` is not installed/on PATH, blocking local `go test`, `go vet`, `go test -race`, and `npm run tui:build`.                                                      | Not a product P0/P1. Must be resolved in CI or a Go-capable release workstation before binary publication.                                                                                |
| R015-KI-002 | Environment blocker   | GoReleaser            | Open   | `goreleaser` is not installed/on PATH, blocking local release config validation and checksum generation.                                                          | Not a product P0/P1. Must be resolved before publishing release artifacts.                                                                                                                |
| R015-KI-003 | Manual smoke blocker  | TUI binary            | Open   | No local `relaybase-tui` binary exists because the Go build is blocked. `relaybase tui` bridge diagnostics are tested, but full manual TUI smoke cannot run here. | Not acceptable for final release signoff until a built binary is tested. Acceptable as a local-environment blocker.                                                                       |
| R015-KI-004 | Environment warning   | Git config ignore     | Open   | `git status --short` reports denied access to `C:\Users\wamin\.config\git\ignore`.                                                                                | Non-product warning. Does not block source validation, but should be cleaned up before commit hygiene work.                                                                               |
| R015-KI-005 | Release packaging gap | Platform package lane | Open   | The bridge supports optional `@cameloo/relaybase-tui-<platform>-<arch>` packages, but those packages are not implemented.                                         | Acceptable for this source RC only because the bridge has package-asset and `RELAYBASE_TUI_BIN` paths. Final release needs either package-asset binaries or documented platform packages. |

## Closed During R015

| ID           | Severity     | Area         | Resolution                                                                                                                                        |
| ------------ | ------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| R015-FIX-001 | P1 candidate | Durable logs | Blocked `<state-dir>/logs` now degrades with `LOG_STORE_UNAVAILABLE` diagnostics instead of making `LogStore.open()` throw during daemon startup. |

## P0/P1 Review

| Category                                | Result                                                                                                           |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Crash                                   | No known product crash remains in locally executable tests.                                                      |
| Data loss                               | Durable logs now degrade explicitly when unavailable; no hidden success claim.                                   |
| Secret leak                             | Redaction and export tests pass; preferences reject secret-like values.                                          |
| Broken install                          | Local binary generation blocked by missing Go, not source failure.                                               |
| Broken launch                           | Bridge diagnostics work; full TUI launch requires a built binary.                                                |
| Lifecycle unsafe                        | Lifecycle operations remain daemon-owned and confirmation-gated in TUI command paths.                            |
| Export corrupt                          | `.log`, `.jsonl`, and `.zip` exports are generated and inspected in tests.                                       |
| Daemon/TUI communication                | API client, bridge, and event stream surfaces have automated coverage; full manual binary smoke blocked locally. |
| Ambiguous command executes wrong action | Resolver tests require clarification; no known unsafe ambiguity remains.                                         |

## Release Decision

This checkout is not ready for final binary publication from this machine. It is ready for a source RC handoff to a Go-capable CI/release environment to run the remaining Go, build, GoReleaser, checksum, and manual TUI smoke gates.
