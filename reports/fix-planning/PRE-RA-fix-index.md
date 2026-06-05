# PRE-RA Release Readiness Fix Index

Date: 2026-06-01

Source report: `reports/fix-planning/PRE-RA-FP000-release-readiness-triage.md`

Status: planning and fix scaffold. Release-tooling and workspace-hygiene
scaffolding exists, but no blocked verifier issue is marked release-ready
without real evidence.

AI-agent prompts: `BLOCK_AI_AGENT_PROMPTS`

## Protected Passing Surfaces

Do not disturb these surfaces while closing the release-readiness blockers:

- Node/TypeScript daemon and API behavior.
- Daemon-owned lifecycle operations.
- Durable logs, exports, redaction, auth failure handling, grouping, and package dry-run behavior already reported as passing.
- Node CLI bridge diagnostics, except for narrow binary packaging and launch verification fixes.
- The architecture invariant that the daemon owns lifecycle and the Go TUI is a client.

## Blocker Index

| Blocker ID                             | FP000 ID | Severity | Classification                 | Owner prompt     | Dependencies                                                          | Required evidence                                                                                                                                                                                                                                                                 | Current status                                                                                                                            | Blocks AI-agent prompts |
| -------------------------------------- | -------- | -------- | ------------------------------ | ---------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `PRE-RA-BLOCKER-GO-TOOLCHAIN`          | `RB-001` | P0       | Environment, repo tooling      | `PRE-RA-FIX001C` | None                                                                  | `go version`; `go env GOVERSION GOOS GOARCH GOMOD GOMODCACHE`; `go mod tidy` from `tui/`; `tui/go.sum` present; `npm.cmd run doctor`; `npm.cmd run tui:doctor`; `npm.cmd run doctor:tui`; `npm.cmd run tui:test`; `npm.cmd run tui:vet`; `npm.cmd run tui:race` where stable      | Tooling/docs implemented by `PRE-RA-FIX001`; still environment-blocked because Go is unavailable on this host and `tui/go.sum` is missing | Yes                     |
| `PRE-RA-BLOCKER-TUI-PACKAGE-BINARY`    | `RB-002` | P0       | Packaging, environment         | `PRE-RA-FIX002`  | `PRE-RA-BLOCKER-GO-TOOLCHAIN`                                         | `npm.cmd run tui:build`; expected current-platform binary under `bin/relaybase-tui/`; `relaybase tui` package-asset resolution; `RELAYBASE_TUI_BIN` resolution; missing-binary diagnostic still fail-closed; `npm.cmd run package:check`                                          | Planned; `bin/relaybase-tui/` contains only `README.md`                                                                                   | Yes                     |
| `PRE-RA-BLOCKER-TUI-CHECKS-UNVERIFIED` | `RB-003` | P1       | Test coverage, environment     | `PRE-RA-FIX003`  | `PRE-RA-BLOCKER-GO-TOOLCHAIN`                                         | `npm.cmd run tui:test`; `npm.cmd run tui:vet`; `npm.cmd run tui:race` where stable; discoverable snapshot/render evidence command or exact Go test evidence; preference, slash, assistant, command-bar confirmation, context menu, pane, and render checks independently executed | Planned; Go tests exist but are not independently verified on this host                                                                   | Yes                     |
| `PRE-RA-BLOCKER-GORELEASER-CHECKSUM`   | `RB-004` | P2       | Release tooling, environment   | `PRE-RA-FIX005`  | `PRE-RA-BLOCKER-GO-TOOLCHAIN`                                         | `goreleaser --version`; `npm.cmd run release:check`; `npm.cmd run release:dry-run`; generated archives inspected; `relaybase-tui-checksums.txt` present in release output                                                                                                         | CI and wrapper path implemented; local evidence remains blocked because `goreleaser` is unavailable on this host                           | No                      |
| `PRE-RA-BLOCKER-WORKSPACE-HYGIENE`     | `RB-005` | P2       | Workspace hygiene              | `PRE-RA-FIX006`  | Close or explicitly classify all prior fix outputs before publication | `git status --short`; `git diff --stat`; `git diff --name-only`; `git ls-files --others --exclude-standard`; classification of source/docs/scripts/tests versus generated/local artifacts; explicit staging plan if publishing                                                    | Hygiene tooling/docs implemented; workspace remains dirty and global git ignore access warning persists                                   | Yes                     |
| `PRE-RA-BLOCKER-TUI-EVIDENCE-CAPTURE`  | `RB-006` | P2       | Evidence coverage, environment | `PRE-RA-FIX004`  | `PRE-RA-BLOCKER-GO-TOOLCHAIN`; `PRE-RA-BLOCKER-TUI-PACKAGE-BINARY`    | Direct `relaybase-tui` launch; `relaybase tui` bridge launch; disposable daemon state directory; sample frontend/backend app grouping; screenshots or terminal recording; confirmation-gated slash and deterministic assistant smoke; clean quit                                  | Smoke/evidence harness implemented; current host remains blocked because no TUI binary exists                                             | Yes                     |

## Recommended Execution Order

1. `PRE-RA-FIX001C`: make a Go-capable verification lane real and generate `tui/go.sum`.
2. `PRE-RA-FIX002`: build/package a real current-platform TUI binary and prove bridge resolution.
3. `PRE-RA-FIX003`: run or add discoverable TUI verification, snapshot, and smoke command evidence.
4. Run GoReleaser release/checksum dry-run in CI or another GoReleaser-capable environment and inspect `dist/relaybase-tui-checksums.txt`.
5. `PRE-RA-FIX004`: run the TUI smoke/evidence harness again on a Go-capable host with a built binary and capture terminal evidence.
6. `PRE-RA-FIX006`: classify and clean the workspace for publication lanes.
7. Re-run FINAL-VERIFY from a clean or disposable workspace with Go and GoReleaser available.

## Current Decision

AI-agent roadmap prompts may not proceed. Release-readiness fix prompts may proceed in the order above. The next prompt to run is `PRE-RA-FIX001C` if a Go-capable host is available or the user explicitly approves installing Go.
