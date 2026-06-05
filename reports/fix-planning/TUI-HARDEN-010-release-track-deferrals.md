# TUI-HARDEN-010 Release-Track Deferrals

Generated: 2026-06-02

## Executive Summary

Current TUI hardening can continue. The remaining verified blockers in this pass
are release-track, host-environment, or evidence-tooling issues rather than
TUI product-function blockers.

The TUI binary has already built and launched through the Node bridge in the
current hardening chain. `npm.cmd run package:check` passes when npm uses a
disposable cache, and the dry-run tarball includes the current Windows TUI
binary. Go race testing, GoReleaser checks, release checksum dry-run, optional
platform-specific npm package publication, and video recording remain separate
release-readiness concerns.

No unavailable release tool is counted as passing in this report.

## Scope Guard

- No OpenRouter, OpenAI Agents SDK, or Operator Agent work was inspected as a
  readiness target.
- No lifecycle logic moved into the TUI or the Node bridge.
- No global tools were installed.
- CodeGraph remains unavailable on this host; this task explicitly allows direct
  source inspection and command evidence when CodeGraph cannot run.

## Evidence Inspected

| Surface | Evidence |
| --- | --- |
| Agent rules | `AGENTS.md` |
| TUI/release scripts | `package.json`, `scripts/tui-go.mjs`, `scripts/package-check.mjs`, `scripts/tui-smoke.mjs` |
| Release config | `.goreleaser.yml` |
| CI release/race lanes | `.github/workflows/ci.yml` |
| Bridge/package docs | `docs/tui-architecture.md`, `docs/tui-toolchain.md`, `docs/cli.md` |
| Release known issues | `reports/release-candidate/known-issues.md`, `reports/release-candidate/tui-evidence-report.md` |
| Platform package references | `src/tuiBridge.ts`, `src/cli.ts`, `reports/fix-planning/TUI-HARDEN-002-unavailable-surface-audit.md` |

## Command Evidence

| Check | Exact command | Exact result | Classification |
| --- | --- | --- | --- |
| CodeGraph status | `codegraph-mcp agent-use status --repo . --json` | Failed: `codegraph-mcp` is not recognized as a command. | Environment/tooling; nonblocking for this task only. |
| Default Go race script | `npm.cmd run tui:race` | Failed with clear missing-Go diagnostic because `go` is not on this shell `PATH`. No raw `spawnSync go ENOENT`. | Environment-only for this shell; not a product-code failure. |
| Race with process-local Go PATH | `$env:Path='C:\Program Files\Go\bin;'+$env:Path; npm.cmd run tui:race` | Failed honestly: `go: -race requires cgo; enable cgo by setting CGO_ENABLED=1`, followed by Relaybase unsupported-race diagnostic. | Host/toolchain race blocker; no fake pass. |
| Direct race wrapper exit code | `$env:Path='C:\Program Files\Go\bin;'+$env:Path; node scripts/tui-go.mjs race; Write-Output "EXITCODE=$LASTEXITCODE"` | Printed `EXITCODE=2` after unsupported-race diagnostic. | Honest unsupported status; release/CI race lane still required. |
| Go env for race context | `$env:Path='C:\Program Files\Go\bin;'+$env:Path; go env GOVERSION GOOS GOARCH CGO_ENABLED` | `go1.26.3`, `windows`, `amd64`, `0`. | Explains local race limitation; release CI should run on supported lane. |
| GoReleaser check | `npm.cmd run release:check` | Failed with clear missing-GoReleaser diagnostic. | Release-tooling/environment blocker. |
| Checksum dry-run | `npm.cmd run release:dry-run` | Failed with the same missing-GoReleaser diagnostic. No `dist/relaybase-tui-checksums.txt` generated. | Release-tooling/environment blocker; blocks full release archive/checksum signoff. |
| GoReleaser executable | `where.exe goreleaser` | Failed: `INFO: Could not find files for the given pattern(s).` | Environment-only; no local GoReleaser installed. |
| Default package check | `npm.cmd run package:check` | Failed because npm could not write logs/cache under `C:\Users\wamin\AppData\Local\npm-cache`. | Host npm-cache permission issue, not package layout. |
| Package check with disposable cache | `$env:npm_config_cache=(Join-Path $env:TEMP 'relaybase-npm-cache'); npm.cmd run package:check` | Passed. Dry-run tarball includes `bin/relaybase-tui/relaybase-tui-windows-amd64.exe`. | Package path works when host cache is usable. |
| VHS availability | `where.exe vhs` | Failed: command not found. | Evidence-tooling unavailable. |
| asciinema availability | `where.exe asciinema` | Failed: command not found. | Evidence-tooling unavailable. |
| Worktree status | `git status --short` | Dirty from ongoing hardening work and reports; also warns that user global git ignore is permission-denied. | Workspace hygiene; must be resolved before final release signoff. |

## Classification Matrix

| Item | Classification | Blocks next TUI work? | Blocks AI-agent surface readiness? | Blocks full release readiness? | Recommended next prompt if blocking |
| --- | --- | --- | --- | --- | --- |
| Go not on default shell `PATH` | Environment-only | No, if commands use process-local PATH or shell PATH is fixed. | No, because TUI build/launch evidence exists once Go is reachable. | Yes for local release verification from this shell. | `TUI-HARDEN-011-FIX-WINDOWS-GO-PATH` if local verification must run without PATH prefix. |
| Race unsupported on this Windows shell | Environment/toolchain | No. | No, if documented as unsupported and not counted as pass. | Yes until Linux/CI or a cgo-capable host runs race successfully. | `RELEASE-TRACK-001-RUN-GO-RACE-CI-LANE`. |
| GoReleaser missing | Release-tooling/environment | No. | No. | Yes. Release archives/checksums cannot be signed off locally. | `RELEASE-TRACK-002-GORELEASER-CHECKSUM-VERIFY`. |
| Checksum dry-run unavailable | Release-tooling | No. | No. | Yes. No checksum artifact was generated locally. | `RELEASE-TRACK-002-GORELEASER-CHECKSUM-VERIFY`. |
| Optional platform npm packages not implemented | Packaging/tooling | No. Main package asset and `RELAYBASE_TUI_BIN` paths work. | No. | Conditional: blocks only if final release strategy requires separate platform npm packages. | `RELEASE-TRACK-003-PLATFORM-NPM-PACKAGES-OR-DOC-DEFERRAL`. |
| Current-platform package asset | Packaging | No. | No. | No for current Windows package dry-run; it passes with disposable npm cache. | None unless package strategy changes. |
| npm AppData cache `EPERM` | Environment-only | No. Use disposable cache. | No. | No if CI/release uses a writable cache; local verifier should avoid the bad cache. | `TUI-HARDEN-011-FIX-WINDOWS-NPM-CACHE-DOCS` if local default command must pass. |
| VHS/asciinema unavailable | Evidence tooling | No. PTY transcript evidence exists. | No. | No if transcripts satisfy release evidence; yes only for a release requirement that explicitly demands video recording. | `RELEASE-TRACK-004-OPTIONAL-TERMINAL-RECORDING`. |
| Dirty worktree | Workspace hygiene | No for continued implementation if changes are intentional. | No until final gate. | Yes for final release publication/signoff. | `TUI-HARDEN-FINAL-CLEAN-WORKTREE-GATE`. |
| CodeGraph unavailable | Tooling/environment | No for this task chain by explicit instruction. | No for this task chain. | Depends on release governance; current task does not claim graph proof. | `TOOLING-001-RESTORE-CODEGRAPH-CLI` if graph proof is required. |

## Release-Track Details

### Go Race

`scripts/tui-go.mjs` runs `go test -race ./...` and treats known unsupported
race output as an honest unsupported state with documented code `2`. On this
Windows host, `go env` reports `CGO_ENABLED=0`, and Go reports `-race requires
cgo`. This is not a TUI functional failure, but it does leave full release race
coverage unresolved until a supported CI or release workstation runs it.

### GoReleaser And Checksums

`.goreleaser.yml` defines the six expected TUI targets and a checksum file named
`relaybase-tui-checksums.txt`. `.github/workflows/ci.yml` contains a release
artifact lane that sets up Go, installs GoReleaser, runs `npm run
release:check`, runs `npm run release:dry-run`, verifies
`dist/relaybase-tui-checksums.txt`, and uploads `dist/**`.

Locally, `goreleaser` is not on `PATH`, so both `release:check` and
`release:dry-run` correctly fail. No checksum dry-run can be claimed from this
host.

### Platform-Specific npm Packages

The bridge includes a `platform-package` resolution slot and user-facing text
mentions optional `@cameloo/relaybase-tui-<platform>-<arch>` packages. No such
package is implemented in `package.json` or this workspace. This does not block
current TUI hardening because the verified resolution paths are:

- `RELAYBASE_TUI_BIN`;
- repo-local `bin/relaybase-tui/<platform binary>`;
- package asset `bin/relaybase-tui/<platform binary>`.

Before final release, Relaybase should either implement platform-specific npm
packages or keep them explicitly documented as optional/future and rely on main
package assets plus release artifacts.

### Screenshot / Recording Tooling

`vhs` and `asciinema` are not installed on this host. The smoke evidence report
honestly records video capture as unavailable and uses transcript artifacts.
Recording absence does not block TUI hardening because real TUI launch,
daemon-unavailable, bridge launch, preference, and confirmation evidence already
exist as PTY/text artifacts.

## What Does Not Block Current TUI Hardening

- GoReleaser absence.
- Release checksum dry-run absence.
- Optional platform-specific npm packages.
- VHS/asciinema absence when PTY transcripts exist.
- Local npm AppData cache `EPERM` when a disposable cache works.
- Local Windows race unsupported state, as long as it is not claimed as pass.

## What Still Blocks Full Release Readiness

- GoReleaser check and snapshot dry-run with inspected checksums.
- Race tests on a supported host or CI lane.
- Clean final worktree.
- Final decision on platform package strategy or an explicit release note that
  main package assets plus GitHub release artifacts are the supported path.
- Local verifier environment cleanup if final signoff must be reproducible from
  this Windows shell without PATH/cache overrides.

## Recommended Next Prompt

Continue current TUI hardening work with:

`Task TUI-HARDEN-011 - Finalize TUI hardening gate and workspace hygiene`

Release-track follow-up can wait until after TUI hardening:

`Task RELEASE-TRACK-002 - Run GoReleaser/checksum verification in a release-capable environment`

## Acceptance Decision

TUI hardening may continue. Full release readiness remains blocked by
release-track evidence that is intentionally not claimed here.
