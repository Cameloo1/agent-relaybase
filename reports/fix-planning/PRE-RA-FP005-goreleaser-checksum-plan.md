# PRE-RA-FP005 GoReleaser And Checksum Plan

Date: 2026-06-02

Mode: planning only. This report does not install GoReleaser, does not modify
release configuration, and does not mark checksum release readiness as passing.

## 1. Current Release Config

Relaybase currently has a GoReleaser config at `.goreleaser.yml`.

Current `.goreleaser.yml` behavior:

- config version: `2`
- project name: `relaybase-tui`
- build directory: `tui`
- main package: `./cmd/relaybase-tui`
- binary name inside the GoReleaser build: `relaybase-tui`
- build flags: `-trimpath`
- build env: `CGO_ENABLED=0`
- target OSes: `windows`, `darwin`, `linux`
- target architectures: `amd64`, `arm64`
- archive name template: `relaybase-tui-{{ .Os }}-{{ .Arch }}`
- included archive files:
  - `LICENSE`
  - `README.md`
  - `docs/tui-architecture.md`
  - `docs/tui-keymap.md`
- checksum file: `relaybase-tui-checksums.txt`
- snapshot version template: `{{ incpatch .Version }}-next`

Current npm release scripts in `package.json`:

- `npm run release:check` -> `node scripts/tui-go.mjs release-check`
- `npm run release:dry-run` -> `node scripts/tui-go.mjs release-dry-run`
- `npm run tui:build:all` -> `node scripts/tui-go.mjs build --all`
- `npm run package:check` -> source/package dry-run, current-platform TUI
  binary optional
- `npm run package:check:strict` -> package dry-run with current-platform TUI
  binary required

Current wrapper behavior in `scripts/tui-go.mjs`:

- `release-check` calls `goreleaser check`.
- `release-dry-run` calls `goreleaser release --snapshot --clean`.
- missing GoReleaser is detected with `goreleaser --version`.
- the missing-tool diagnostic says GoReleaser is required for release archive
  and checksum verification and points back to the retry command.

Current CI behavior in `.github/workflows/ci.yml`:

- Node verification runs on Windows, Ubuntu, and macOS.
- Go TUI tests run on Windows, Ubuntu, and macOS with `actions/setup-go@v5`.
- TUI build smoke runs on Windows, Ubuntu, and macOS.
- package check runs after Node, Go TUI, and TUI build jobs.
- no CI job currently installs GoReleaser or runs `npm run release:check` /
  `npm run release:dry-run`.

Current package/checksum behavior:

- `scripts/package-check.mjs` uses `npm pack --dry-run --json`.
- normal `npm run package:check` is source-friendly when the TUI binary is not
  built.
- strict package check fails closed when the current-platform binary is missing.
- package check does not generate release archive checksums; it only validates
  npm package contents.

Current binary naming convention outside GoReleaser:

- `bin/relaybase-tui/relaybase-tui-windows-amd64.exe`
- `bin/relaybase-tui/relaybase-tui-windows-arm64.exe`
- `bin/relaybase-tui/relaybase-tui-darwin-amd64`
- `bin/relaybase-tui/relaybase-tui-darwin-arm64`
- `bin/relaybase-tui/relaybase-tui-linux-amd64`
- `bin/relaybase-tui/relaybase-tui-linux-arm64`

## 2. Current Failure Mode

This Windows host does not have GoReleaser on `PATH`.

Observed commands:

| Command                            | Result                                                                                             | Classification                       |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `where.exe goreleaser`             | Failed; no matching executable found.                                                              | Environment/release-tooling blocker  |
| `npm.cmd run release:check`        | Failed with clear missing-GoReleaser diagnostic.                                                   | Expected fail-closed local behavior  |
| `npm.cmd run release:dry-run`      | Failed with clear missing-GoReleaser diagnostic.                                                   | Expected fail-closed local behavior  |
| `npm.cmd run doctor:tui`           | Warned that GoReleaser is not installed and required only for release archive/checksum dry-runs.   | Expected local doctor behavior       |
| `npm.cmd run package:check`        | Passed after approved normal npm-cache access; package is source-only until a TUI binary is built. | Package behavior, not checksum proof |
| `npm.cmd run package:check:strict` | Failed because no current-platform TUI binary exists.                                              | Expected release package gate        |

An initial sandboxed `npm.cmd run package:check` failed with npm cache `EPERM`.
That was an environment/sandbox boundary, not a package logic failure. The
approved rerun succeeded.

Go is also missing on this host, so a GoReleaser dry run would remain blocked
for real artifact generation until the Go toolchain is installed or CI provides
it.

## 3. Whether GoReleaser Is Mandatory

GoReleaser is mandatory for final Relaybase TUI release archive and checksum
approval.

GoReleaser is not mandatory for:

- Node daemon/API tests.
- ordinary local TypeScript development.
- source-only `npm run package:check`.
- local TUI doctor diagnostics.

GoReleaser should be mandatory in:

- release CI lanes that claim archive/checksum readiness;
- final release verification;
- any local workstation run that claims generated release artifacts are ready
  to publish.

Do not replace GoReleaser dry-run evidence with npm package dry-run evidence.
`npm pack --dry-run` validates npm package contents, while GoReleaser validates
cross-platform TUI release archives and `relaybase-tui-checksums.txt`.

## 4. Recommended Local Developer Behavior

Keep GoReleaser optional for day-to-day local development, but fail closed when
a user explicitly asks for release archive/checksum verification.

Recommended local behavior:

1. `npm run doctor:tui` continues to warn when GoReleaser is absent.
2. `npm run release:check` and `npm run release:dry-run` continue to exit
   nonzero with an actionable diagnostic when `goreleaser` is missing.
3. Local docs should say GoReleaser is required only for release archive and
   checksum dry-runs, not for Node verification.
4. Do not use Dockerized GoReleaser as the default local path. It adds a Docker
   dependency and can hide host-path, executable-bit, and Windows path problems.
5. A simple local checksum helper may be useful only if clearly named as a
   non-release fallback, for example `npm run release:checksum-local`.
   It must not be treated as equivalent to GoReleaser. It can hash already-built
   files under `bin/relaybase-tui/` for local evidence, but final release still
   needs GoReleaser archive/checksum output.

## 5. Recommended CI Behavior

Add a release-artifact CI lane separate from ordinary Node verification.

Recommended CI structure:

1. Keep existing Node, Go TUI, TUI build, and package jobs.
2. Add a GoReleaser config check job that:
   - checks out the repo;
   - sets up Node 24;
   - sets up Go from `tui/go.mod`;
   - installs npm dependencies;
   - installs GoReleaser through a pinned CI action or versioned install step;
   - captures `goreleaser --version`;
   - runs `npm run release:check`.
3. Add a release dry-run job for release-candidate/manual lanes that:
   - depends on Go TUI checks;
   - installs GoReleaser;
   - runs `npm run release:dry-run`;
   - prints and uploads `dist/`;
   - captures `dist/relaybase-tui-checksums.txt`;
   - inspects archive contents for the expected docs and TUI binary.

Recommended trigger split:

- Pull requests: run `npm run release:check` if runtime cost is acceptable.
- `workflow_dispatch`, release-candidate branches, or tags: run
  `npm run release:dry-run` and upload artifacts.
- Final release tags: use the same config but require explicit publish
  permissions and a separate approval gate before uploading release assets.

The release dry-run job must not silently pass when GoReleaser is missing. It
should fail with the same diagnostic as local scripts or with a CI setup failure
that names the missing tool.

## 6. Recommended Artifact And Checksum Outputs

Required release targets:

| Target        | Direct binary name expected by Node bridge/package strategy |
| ------------- | ----------------------------------------------------------- |
| Windows amd64 | `relaybase-tui-windows-amd64.exe`                           |
| Windows arm64 | `relaybase-tui-windows-arm64.exe`                           |
| macOS amd64   | `relaybase-tui-darwin-amd64`                                |
| macOS arm64   | `relaybase-tui-darwin-arm64`                                |
| Linux amd64   | `relaybase-tui-linux-amd64`                                 |
| Linux arm64   | `relaybase-tui-linux-arm64`                                 |

Recommended release dry-run outputs:

- archives under `dist/` for all six OS/architecture targets;
- `dist/relaybase-tui-checksums.txt`;
- a machine-readable artifact listing from GoReleaser if produced;
- CI-uploaded `dist/**` snapshot artifacts for inspection;
- release verification notes that list each archive and checksum entry.

Potential alignment issue to verify in the future implementation:

- `npm run tui:build` and `npm run tui:build:all` produce platform-specific
  binary filenames under `bin/relaybase-tui/`.
- Current `.goreleaser.yml` sets the GoReleaser binary name to
  `relaybase-tui`, while archive names are platform-specific.
- This may be acceptable for standalone archives, but package integration needs
  the platform-specific names. A GoReleaser-capable dry run should inspect the
  archive contents and decide whether `.goreleaser.yml` should use a templated
  binary name or whether a separate copy/package step should populate
  `bin/relaybase-tui/<platform binary>`.

Do not change the naming convention without validating it through
`goreleaser check`, `goreleaser release --snapshot --clean`, and package dry-run
inspection.

## 7. Proposed Implementation Tasks

### PRE-RA-FIX005A - Release Wrapper Diagnostics

Likely files:

- `scripts/tui-go.mjs`
- `tests/unit.test.ts`

Tasks:

- Add or tighten tests for `release-check` and `release-dry-run` missing
  GoReleaser behavior.
- Verify both commands return nonzero and print the retry command.
- Keep `doctor:tui` as a warning for GoReleaser, not a hard failure, unless a
  release-specific doctor mode is added.

Acceptance:

- `npm run release:check` fails clearly when GoReleaser is missing.
- `npm run release:dry-run` fails clearly when GoReleaser is missing.
- Unit tests cover the missing-tool branch without installing GoReleaser.

### PRE-RA-FIX005B - CI GoReleaser Check

Likely files:

- `.github/workflows/ci.yml`
- `docs/tui-toolchain.md`
- `reports/fix-planning/PRE-RA-command-matrix.md`
- `reports/fix-planning/PRE-RA-blocker-status.json`

Tasks:

- Add a CI job that installs GoReleaser with an explicit version.
- Capture `goreleaser --version`.
- Run `npm run release:check`.
- Ensure Node-only jobs do not require GoReleaser.

Acceptance:

- GoReleaser config check runs in CI.
- Missing GoReleaser in local development remains a clear environment blocker,
  not an ambiguous failure.

### PRE-RA-FIX005C - Release Dry Run And Checksum Artifacts

Likely files:

- `.github/workflows/ci.yml`
- possibly `.goreleaser.yml` if dry-run reveals naming/content mismatch
- `docs/tui-toolchain.md`
- `reports/release-candidate/test-matrix.md`
- `reports/release-candidate/release-readiness.md`

Tasks:

- Add a release-candidate/manual CI path for
  `npm run release:dry-run`.
- Upload `dist/**` as CI artifacts.
- Print the checksum file path and contents summary.
- Inspect archives for expected TUI binary, `LICENSE`, `README.md`, and TUI
  docs.

Acceptance:

- `dist/relaybase-tui-checksums.txt` exists.
- Archive/checksum artifacts are generated in CI or an equivalent
  release-capable environment.
- Final verification captures the checksum output.

### PRE-RA-FIX005D - Package Strategy Alignment

Likely files:

- `.goreleaser.yml`
- `scripts/package-check.mjs`
- `scripts/tui-go.mjs`
- `package.json`
- `docs/tui-architecture.md`
- `docs/tui-toolchain.md`

Tasks:

- Decide whether GoReleaser should produce platform-specific binary filenames
  matching `bin/relaybase-tui/`, or whether `npm run tui:build:all` remains the
  npm-package binary generation path.
- Keep the Node bridge resolution order unchanged unless package inspection
  proves a mismatch.
- Ensure `npm run package:check:strict` aligns with the chosen release path.

Acceptance:

- The npm package strategy and GoReleaser artifact strategy are documented as
  either separate or intentionally connected.
- No package claim says all platform binaries are included unless package
  dry-run proves it.

## 8. Acceptance Criteria

The GoReleaser/checksum blocker is fixed only when:

- `goreleaser --version` is captured in CI or a release-capable local
  environment.
- `npm run release:check` passes in that environment.
- `npm run release:dry-run` produces real `dist/` artifacts.
- `dist/relaybase-tui-checksums.txt` exists and is inspected.
- The six target OS/architecture outputs are present or a specific missing
  target is documented as a release blocker.
- archive contents are inspected for TUI binary, license/readme, and TUI docs.
- `npm run package:check` and `npm run package:check:strict` behavior is
  consistent with the chosen npm binary strategy.
- final release verification records exact artifact paths and checksum summary.

## Go/No-Go For AI-Agent Prompts

This P2 issue should be treated as release-track-only once P0/P1 TUI build,
launch, UX evidence, and workspace hygiene blockers are closed.

It blocks final binary publication and release-readiness PASS. It should not,
by itself, block future AI-agent prompt planning or implementation work if the
remaining higher-severity pre-AI-agent gates are satisfied.

Current state remains no-go for AI-agent prompts because broader PRE-RA
blockers are still open: Go is unavailable, no real TUI binary exists, TUI UX
evidence is incomplete, and the workspace remains dirty.
