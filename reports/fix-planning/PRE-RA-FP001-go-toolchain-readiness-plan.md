# PRE-RA-FP001 Go Toolchain Readiness Plan

Date: 2026-06-01

Mode: planning only. No product code was changed by this task.

Source dependencies:

- `reports/fix-planning/PRE-RA-FP000-release-readiness-triage.md`
- `reports/fix-planning/PRE-RA-fix-index.md`
- `reports/fix-planning/PRE-RA-blocker-status.json`
- `reports/fix-planning/PRE-RA-command-matrix.md`

## Executive Summary

This blocker is both an environment blocker and a repo-tooling blocker.

The original release verifier failure was environmental: the Windows verification host did not have `go` on `PATH`, so the Go Bubble Tea client could not be built, tested, vetted, race-tested, launched directly, or launched through `relaybase tui`.

The current repo has already gained important readiness scaffolding:

- `tui/go.mod` declares the Go TUI module and `go 1.24`.
- `.go-version` mirrors `1.24`.
- `scripts/tui-go.mjs` wraps TUI build/test/vet/race/doctor/release checks.
- `package.json` exposes `tui:build`, `tui:test`, `tui:vet`, `tui:race`, `doctor:tui`, `release:check`, and `release:dry-run`.
- `.github/workflows/ci.yml` installs Go for TUI jobs through `actions/setup-go@v5`.
- `docs/tui-toolchain.md`, `docs/cli.md`, and `docs/tui-architecture.md` document the TUI toolchain and bridge path.

The blocker is not fully closed because this host still has no Go or GoReleaser, `tui/go.sum` is missing, no TUI binary exists under `bin/relaybase-tui/`, and no Go/TUI tests or launch checks can be independently verified here.

Decision: AI-agent roadmap prompts remain blocked. Proceed only with release-readiness fix prompts, starting with a Go-capable TUI module lock and verification run.

## Evidence Inspected

Required preamble surfaces:

- Read `AGENTS.md`.
- Read `docs/relaybase-release-roadmap.md`.
- Read `docs/tui-architecture.md`.
- Read `docs/tui-testing-strategy.md`.
- Read `reports/release-candidate/release-readiness.md`.
- Read `reports/release-candidate/hardening-report.md`.
- Searched for a separate final verifier report with `FINAL-VERIFY`, `Independent release readiness`, and release-readiness failure terms. No separate final verifier artifact was found beyond the user-supplied verifier result and existing release/fix-planning reports.

CodeGraph gate:

- `codegraph-mcp agent-use status --repo . --json` failed because `codegraph-mcp` is not on `PATH`.
- `C:\Users\wamin\Desktop\development\codegraph-mcp\target\release\codegraph-mcp.exe agent-use status --repo . --json` passed with `claimable: true`, `graph_db_status: ready`, and `graph_freshness: current`.
- `C:\Users\wamin\Desktop\development\codegraph-mcp\target\release\codegraph-mcp.exe agent-use context-pack --repo . --task "PRE-RA-FP001 Go toolchain readiness planning" --agent-json` passed with `claimable: true`, ready graph DB, and no reported lifecycle blocker for this planning task.

Current source and tooling:

- `package.json` scripts include:
  - `tui:build`: `node scripts/tui-go.mjs build`
  - `tui:build:all`: `node scripts/tui-go.mjs build --all`
  - `tui:test`: `node scripts/tui-go.mjs test`
  - `tui:vet`: `node scripts/tui-go.mjs vet`
  - `tui:race`: `node scripts/tui-go.mjs race`
  - `doctor:tui`: `node scripts/tui-go.mjs doctor`
  - `release:check`: `node scripts/tui-go.mjs release-check`
  - `release:dry-run`: `node scripts/tui-go.mjs release-dry-run`
  - `verify`: Node-only daemon/control-plane check path.
- `scripts/tui-go.mjs` reads the required Go version from `tui/go.mod`, checks `go version` before TUI Go commands, uses `spawnSync` with `shell: false`, writes platform binaries under `bin/relaybase-tui/`, and emits Relaybase-owned missing-tool diagnostics.
- `scripts/build-tui.mjs` is a compatibility wrapper around `scripts/tui-go.mjs build`.
- `tui/go.mod` exists and declares `go 1.24`.
- `tui/go.sum` is missing.
- `.go-version` exists and contains `1.24`.
- No `mise.toml`, `.mise.toml`, `.tool-versions`, `devbox.json`, `flake.nix`, `shell.nix`, or `go.env` file exists.
- `.github/workflows/ci.yml` uses `actions/setup-go@v5` with `go-version-file: tui/go.mod`, prints `go version` and `go env GOVERSION GOOS GOARCH GOMOD GOMODCACHE`, runs `npm run tui:test`, `npm run tui:vet`, Linux-only `npm run tui:race`, and builds the TUI binary.
- `.goreleaser.yml` defines Windows, macOS, and Linux `amd64`/`arm64` TUI artifacts and `relaybase-tui-checksums.txt`.
- `src/tuiBridge.ts` resolves `RELAYBASE_TUI_BIN`, package asset binaries, and optional platform package binaries with Windows `.exe` names and `path.join`; it launches with `shell: false`.
- TUI source and tests exist under `tui/`, including preferences, relaybase client, pane manager, slash command, assistant, context menu, model, styles, and render/golden-like tests.

Direct command results on this host:

| Command                       | Result                                                                                                                                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `where.exe go`                | Failed. No `go` executable found.                                                                                                                                                                   |
| `where.exe goreleaser`        | Failed. No `goreleaser` executable found.                                                                                                                                                           |
| `npm.cmd run doctor:tui`      | Failed with `Relaybase TUI doctor: not ready`; Node/npm passed; Go and Go env failed; `tui/go.mod` passed; `tui/go.sum`, package binary, `RELAYBASE_TUI_BIN`, and GoReleaser reported missing/warn. |
| `npm.cmd run tui:build`       | Failed with clear diagnostic: Go 1.24 is required but `go` was not found on `PATH`; includes install, `go version`, `go env`, and retry command guidance.                                           |
| `npm.cmd run tui:test`        | Failed with the same clear missing-Go diagnostic and retry command.                                                                                                                                 |
| `npm.cmd run tui:vet`         | Failed with the same clear missing-Go diagnostic and retry command.                                                                                                                                 |
| `npm.cmd run tui:race`        | Failed with the same clear missing-Go diagnostic and retry command.                                                                                                                                 |
| `npm.cmd run release:check`   | Failed with clear missing-GoReleaser diagnostic.                                                                                                                                                    |
| `npm.cmd run release:dry-run` | Failed with clear missing-GoReleaser diagnostic.                                                                                                                                                    |
| `git status --short`          | Dirty workspace remains; source/docs/tests/scripts/TUI/report files are modified or untracked, and Git reports a permission warning for `C:\Users\wamin\.config\git\ignore`.                        |

## Root Cause Classification

Primary classification: environment plus repo tooling.

- Environment: the verifier host does not have Go or GoReleaser on `PATH`.
- Repo tooling: most missing-tool ambiguity is now addressed by `scripts/tui-go.mjs`, but the repo still needs a Go-capable run to generate `tui/go.sum` and produce real TUI evidence.
- Test coverage: Go tests exist but are not independently verified on this host.
- Packaging: the package binary path is real, but no binary exists because `npm run tui:build` cannot run without Go.
- Release tooling: GoReleaser config and npm scripts exist, but the dry run is unavailable here until GoReleaser is installed or CI provides it.
- Workspace hygiene: unrelated to the Go toolchain root cause, but still a release blocker before publication.

## Current Go Readiness State

What is already in place:

- Go module layout under `tui/`.
- Go version declaration in `tui/go.mod`.
- Root `.go-version` hint.
- Cross-platform binary names in the wrapper:
  - `relaybase-tui-windows-amd64.exe`
  - `relaybase-tui-windows-arm64.exe`
  - `relaybase-tui-darwin-amd64`
  - `relaybase-tui-darwin-arm64`
  - `relaybase-tui-linux-amd64`
  - `relaybase-tui-linux-arm64`
- Windows-safe bridge and wrapper behavior using `path.join`, `.exe` suffixes, `npm.cmd` documentation, and `shell: false` spawning.
- CI Go setup for TUI test/vet/race/build jobs.
- Local docs for Go/GoReleaser setup and evidence capture.

What is still missing:

- Go installed or otherwise available on this verification host.
- `tui/go.sum`.
- A real current-platform binary in `bin/relaybase-tui/`.
- Independent `go test`, `go vet`, `go test -race`, and TUI launch evidence.
- GoReleaser installed or provided by a release CI lane.
- Release archive/checksum output.

## Recommended Go Version Source Of Truth

Use `tui/go.mod` as the authoritative Go version source of truth. It currently declares:

```text
go 1.24
```

Keep `.go-version` as a developer convenience mirror. It currently contains:

```text
1.24
```

Do not add a `toolchain go1.24.x` directive yet. A `toolchain` directive can trigger toolchain download behavior and would require choosing a patch version before the Go-capable verification lane has proven whether that is desirable.

Final release verification should capture both:

- `go version`
- `go env GOVERSION GOOS GOARCH GOMOD GOMODCACHE`

## Toolchain Setup File Recommendation

Recommended current stance:

- Keep `tui/go.mod` as authoritative.
- Keep `.go-version` as the local toolchain-manager hint.
- Generate and commit `tui/go.sum` from a Go-capable host or CI run.
- Do not add `mise.toml`, `devbox.json`, Nix files, `go.env`, or `.tool-versions` in this release-readiness slice.

Rationale:

- `.go-version` is small, conventional, and already present.
- Adding multiple toolchain manager files would broaden environment policy without solving the immediate blocker.
- The missing proof is not "which manager should install Go"; it is "a Go-capable verification lane ran the actual TUI module and produced evidence."

## Recommended CI Setup

Keep the existing CI shape:

- Node daemon/control-plane verification remains Go-free.
- TUI jobs install Go explicitly through `actions/setup-go@v5`.
- TUI jobs use npm scripts rather than raw shell `go` commands.
- CI prints `go version` and selected `go env` values before TUI checks.
- Race tests remain Linux-only unless a Go-capable Windows run proves they are stable.

Recommended future tightening:

- Generate and commit `tui/go.sum` so `cache-dependency-path: tui/go.sum` is valid.
- Add or verify a release workflow step that installs GoReleaser and runs `npm run release:check`.
- Run `npm run release:dry-run` in release CI or a release-capable verification environment and record checksum artifact paths.
- Keep `npm run verify` Node-only so daemon/API checks can still pass on hosts without Go.

## Recommended Local Windows Setup Docs

The current `docs/tui-toolchain.md`, `docs/cli.md`, and `README.md` already document most of the needed flow. Future edits should be narrow and evidence-driven.

Recommended Windows instructions:

- Install Go `1.24.x` from the official Go distribution or an approved local package manager.
- Open a new PowerShell or Command Prompt after installation so `PATH` is refreshed.
- Verify:

```powershell
where.exe go
go version
go env GOVERSION GOOS GOARCH GOMOD GOMODCACHE
npm.cmd run doctor:tui
```

- Run:

```powershell
npm.cmd run tui:test
npm.cmd run tui:vet
npm.cmd run tui:race
npm.cmd run tui:build
```

- Confirm the binary path:

```powershell
Get-ChildItem bin\relaybase-tui -Force
```

- Launch through the bridge and directly only against a disposable daemon state directory during verification.

## Recommended NPM Script Behavior When Go Is Missing

Current behavior is acceptable and should be preserved:

- `npm run tui:build` fails closed with a Relaybase-owned diagnostic.
- `npm run tui:test` fails closed with a Relaybase-owned diagnostic.
- `npm run tui:vet` fails closed with a Relaybase-owned diagnostic.
- `npm run tui:race` fails closed with a Relaybase-owned diagnostic.
- The diagnostic includes the required Go version source, install/PATH guidance, evidence commands, and retry command.

Future implementation should not reintroduce raw missing-command output such as:

- `spawnSync go ENOENT`
- `'go' is not recognized as an internal or external command`

Recommended test coverage:

- Add or keep script-level tests for the missing-Go formatter and command routing if the repo already has practical Node test coverage for `scripts/tui-go.mjs`.
- Do not skip TUI checks to force green. Missing Go must be reported as an environment blocker.

## Recommended Doctor Command Behavior

Current `npm run doctor:tui` behavior is directionally correct and should remain read-only.

It should report:

- Node version.
- npm version.
- Go availability and `go version`.
- `go env GOVERSION GOOS GOARCH GOMOD GOMODCACHE`.
- `tui/go.mod` presence and required Go version.
- `tui/go.sum` presence.
- current platform package binary presence.
- `RELAYBASE_TUI_BIN` presence and validity.
- GoReleaser availability as optional for local development but required for release archive/checksum dry-runs.

Recommended future command policy:

- Keep `doctor:tui` as the near-term repo-local readiness check.
- Consider `npm run doctor` only if it aggregates existing doctors without making Node-only contributors install Go.
- Consider `relaybase doctor` only after release-readiness is stable and the command can remain diagnostic-only. It must not install tools, mutate state, start the daemon, or start user apps.

## Exact Future Implementation Tasks

### PRE-RA-FIX001C: Go-Capable TUI Module Lock And Verification Run

Purpose:

- Close the remaining Go toolchain blocker with real Go evidence.

Likely files:

- `tui/go.sum`
- `reports/release-candidate/release-readiness.md` only if the user asks to update release evidence
- `reports/release-candidate/test-matrix.md` only if the user asks to update release evidence

Commands:

```powershell
where.exe go
go version
go env GOVERSION GOOS GOARCH GOMOD GOMODCACHE
Set-Location tui
go mod tidy
go test ./...
go vet ./...
go test -race ./...
Set-Location ..
npm.cmd run doctor:tui
npm.cmd run tui:test
npm.cmd run tui:vet
npm.cmd run tui:race
npm.cmd run tui:build
git status --short
```

Acceptance criteria:

- `tui/go.sum` exists.
- `npm.cmd run doctor:tui` reports Go and Go env as pass.
- `npm.cmd run tui:test`, `tui:vet`, and `tui:race` either pass or have exact, reproducible failures documented.
- `npm.cmd run tui:build` creates the current-platform binary or reports a concrete build failure that is not missing Go.
- No daemon/control-plane behavior is changed.

### PRE-RA-FIX001D: CI And Go Cache Verification

Purpose:

- Prove the existing CI shape works after `tui/go.sum` exists.

Likely files:

- `.github/workflows/ci.yml` only if setup-go cache or platform behavior fails
- no product code expected

Commands:

```powershell
npm.cmd run format:check
npm.cmd run lint
npm.cmd run typecheck
npm.cmd run tui:test
npm.cmd run tui:vet
npm.cmd run tui:race
npm.cmd run tui:build
git status --short
```

CI evidence to collect:

- `go version`
- `go env GOVERSION GOOS GOARCH GOMOD GOMODCACHE`
- TUI test/vet/race/build job results on supported OS matrix.

Acceptance criteria:

- CI installs Go before TUI checks.
- CI no longer depends on a missing `tui/go.sum`.
- Node-only verification remains Go-free.

### PRE-RA-FIX004: GoReleaser Environment And Checksum Dry Run

Purpose:

- Close the release/checksum readiness blocker once GoReleaser is available.

Likely files:

- `.goreleaser.yml` only if `goreleaser check` identifies a real config issue
- `package.json` or `scripts/tui-go.mjs` only if wrapper command behavior is wrong
- release reports only after real evidence exists

Commands:

```powershell
where.exe goreleaser
goreleaser --version
npm.cmd run release:check
npm.cmd run release:dry-run
Get-ChildItem dist -Recurse -Force
git status --short
```

Acceptance criteria:

- `npm run release:check` passes in a GoReleaser-capable environment.
- `npm run release:dry-run` produces real archives and `relaybase-tui-checksums.txt`.
- Generated `dist/` artifacts are not staged unless the user explicitly approves.

### PRE-RA-FIX002: Package And Launch Real TUI Binary

Purpose:

- Close the package binary and bridge launch blocker after the Go build succeeds.

Likely files:

- `package.json` only if package inclusion is wrong
- `src/tuiBridge.ts` only if real-binary launch exposes a bridge bug
- `tests/unit.test.ts` only if bridge tests need a narrow coverage fix
- no lifecycle code

Commands:

```powershell
npm.cmd run tui:build
Get-ChildItem bin\relaybase-tui -Force
npm.cmd run package:check
node --experimental-strip-types src\cli.ts tui --help
node --experimental-strip-types src\cli.ts tui
```

Additional verification should use a disposable Relaybase state directory before launching a daemon or TUI.

Acceptance criteria:

- A real current-platform `relaybase-tui` binary exists or the release package lane supplies one.
- `relaybase tui` resolves and launches the binary when the daemon is reachable.
- Missing-binary diagnostics remain clear when the binary is absent.
- The TUI remains a daemon client and does not own lifecycle logic.

## Future Implementation Acceptance Criteria For This Blocker

- `npm run tui:build` either builds successfully when Go is present or fails with a clear actionable diagnostic when Go is absent.
- `npm run tui:test`, `npm run tui:vet`, and `npm run tui:race` do not fail with raw `spawnSync go ENOENT`.
- CI installs Go before running TUI checks.
- Windows docs explain how to install and verify Go.
- `go version` and `go env GOVERSION GOOS GOARCH GOMOD GOMODCACHE` are captured in final release verification.
- Missing Go is no longer ambiguous.
- `tui/go.sum` is generated by a Go-capable run.
- No blocked Go/TUI check is marked passing until real evidence exists.

## Risks

- This host still cannot prove the Go code compiles. The normalized diagnostics reduce ambiguity but do not replace a Go-capable run.
- `tui/go.sum` cannot be produced here without installing Go, which this planning task explicitly must not do.
- `go test -race` may be slower or unstable on Windows. Keep Linux race coverage unless Windows evidence proves it stable.
- Adding more toolchain-manager files could create policy churn without improving release proof.
- GoReleaser remains a separate environment blocker until installed locally or provided by release CI.
- Dirty workspace state can obscure which changes belong to release-readiness fixes. Do not stage or publish until source, docs, reports, generated artifacts, and binaries are classified.

## Go/No-Go Recommendation

AI-agent roadmap prompts remain blocked.

Proceed only with release-readiness fix prompts. The next recommended prompt is:

`PRE-RA-FIX001C - Go-capable TUI module lock and verification run`

If a Go-capable host is not available and the user does not approve installing Go, keep this blocker open as an environment/tooling blocker rather than reclassifying it as a product-code failure.
