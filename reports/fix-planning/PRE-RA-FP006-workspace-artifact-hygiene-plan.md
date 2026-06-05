# PRE-RA-FP006 Workspace Artifact Hygiene Plan

Date: 2026-06-02

Mode: planning only. No cleanup, deletion, staging, or product-code change was performed by this task.

## 1. Dirty File Inventory

`git status --short` shows a dirty workspace. It also reports:

```text
warning: unable to access 'C:\Users\wamin/.config/git/ignore': Permission denied
```

Tracked modified files:

| Path                        | Classification                      | Recommendation                                                     |
| --------------------------- | ----------------------------------- | ------------------------------------------------------------------ |
| `.github/workflows/ci.yml`  | Intended source: CI/release tooling | Keep and commit only with release-tooling lane after review.       |
| `.gitignore`                | Intended source: hygiene rules      | Keep, but update deliberately rather than using it as a catch-all. |
| `README.md`                 | Intended docs                       | Keep if current verified behavior only; review before publication. |
| `docs/app-manifest.md`      | Intended docs                       | Keep if matching implemented manifest behavior.                    |
| `docs/app-state.md`         | Intended docs                       | Keep if matching implemented state behavior.                       |
| `docs/cli.md`               | Intended docs                       | Keep if matching implemented CLI behavior.                         |
| `package.json`              | Intended source: package/scripts    | Keep with package and script fixes.                                |
| `src/api.ts`                | Intended product source             | Keep; do not alter during hygiene-only tasks.                      |
| `src/appState.ts`           | Intended product source             | Keep; do not alter during hygiene-only tasks.                      |
| `src/cli.ts`                | Intended product source             | Keep; do not alter during hygiene-only tasks.                      |
| `src/processManager.ts`     | Intended product source             | Keep; do not alter during hygiene-only tasks.                      |
| `src/server.ts`             | Intended product source             | Keep; do not alter during hygiene-only tasks.                      |
| `src/types.ts`              | Intended product source             | Keep; do not alter during hygiene-only tasks.                      |
| `src/validation.ts`         | Intended product source             | Keep; do not alter during hygiene-only tasks.                      |
| `tests/integration.test.ts` | Intended tests                      | Keep with corresponding product changes.                           |
| `tests/unit.test.ts`        | Intended tests                      | Keep with corresponding product and tooling changes.               |

Untracked files and directories:

| Path or pattern                                                                                                                                                                                            | Classification                    | Recommendation                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `.codex/config.toml`                                                                                                                                                                                       | Local agent config                | Do not commit. Add `.codex/` to `.gitignore` unless a future task intentionally publishes a valid repo-local config. |
| `.go-version`                                                                                                                                                                                              | Intended toolchain source         | Commit with Go toolchain readiness work.                                                                             |
| `.goreleaser.yml`                                                                                                                                                                                          | Intended release-tooling source   | Commit with release artifact/checksum tooling.                                                                       |
| `AGENTS.md`                                                                                                                                                                                                | Intended governance source        | Commit with release roadmap/governance work.                                                                         |
| `bin/relaybase-tui/README.md`                                                                                                                                                                              | Intended package path placeholder | Keep. Generated binaries in this directory should be ignored unless an explicit packaging task promotes them.        |
| `docs/agent-driven-development.md`                                                                                                                                                                         | Intended docs                     | Keep if governance docs are in publication scope.                                                                    |
| `docs/app-components.md`                                                                                                                                                                                   | Intended docs                     | Keep if matching implemented component model.                                                                        |
| `docs/logs.md`                                                                                                                                                                                             | Intended docs                     | Keep if matching implemented log/export behavior.                                                                    |
| `docs/relaybase-release-roadmap.md`                                                                                                                                                                        | Intended docs                     | Keep as source-of-truth roadmap.                                                                                     |
| `docs/tui-api-contract.md`                                                                                                                                                                                 | Intended docs                     | Keep if current/planned boundaries are labeled accurately.                                                           |
| `docs/tui-architecture.md`                                                                                                                                                                                 | Intended docs                     | Keep if matching implemented TUI boundary.                                                                           |
| `docs/tui-keymap.md`                                                                                                                                                                                       | Intended docs                     | Keep if matching implemented keymap.                                                                                 |
| `docs/tui-preferences.md`                                                                                                                                                                                  | Intended docs                     | Keep if matching implemented preference behavior.                                                                    |
| `docs/tui-testing-strategy.md`                                                                                                                                                                             | Intended docs                     | Keep as testing strategy.                                                                                            |
| `docs/tui-toolchain.md`                                                                                                                                                                                    | Intended docs                     | Keep with Go/Goreleaser tooling work.                                                                                |
| `reports/fix-planning/*.md` and `PRE-RA-*.json`                                                                                                                                                            | Planning reports                  | Commit only if the release-readiness planning lane intentionally promotes these reports.                             |
| `reports/phase-0/*.md`                                                                                                                                                                                     | Audit reports/templates           | Commit if release roadmap requires them as durable reports.                                                          |
| `reports/release-candidate/*.md`                                                                                                                                                                           | Release-candidate reports         | Commit only as stable release reports after claim review; generated evidence reports should be explicit.             |
| `scripts/*.mjs`                                                                                                                                                                                            | Intended source: tooling scripts  | Keep with corresponding package/tooling changes.                                                                     |
| `src/apiErrors.ts`, `src/apiTypes.ts`, `src/appComponents.ts`, `src/daemonEvents.ts`, `src/logExport.ts`, `src/logStore.ts`, `src/operationStore.ts`, `src/redaction.ts`, `src/tuiBridge.ts`, `src/zip.ts` | Intended product source           | Keep with corresponding API/log/export/bridge changes.                                                               |
| `tui/**`                                                                                                                                                                                                   | Intended Go TUI source/tests      | Keep with TUI release work; generated Go build outputs should not live under `tui/`.                                 |

Ignored local/generated paths currently present:

| Path                           | Classification                   | Recommendation                                                                         |
| ------------------------------ | -------------------------------- | -------------------------------------------------------------------------------------- |
| `.codex-tools/rg.exe`          | Local helper binary              | Keep ignored; do not commit.                                                           |
| `artifacts/tui-verification/*` | Generated TUI evidence artifacts | Keep ignored. Commit only if copied/promoted into a stable report by explicit request. |
| `node_modules/`                | Dependency install               | Keep ignored.                                                                          |

Not currently present:

| Path                                                | Expected use                                             | Recommendation                                                                                               |
| --------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `dist/`                                             | GoReleaser snapshot release artifacts and checksums      | Keep ignored. CI should upload as artifact, not commit.                                                      |
| `.relaybase/`                                       | Local Relaybase state                                    | Keep ignored. Prefer OS temp dirs for verification state.                                                    |
| `coverage/`                                         | Test coverage output                                     | Keep ignored.                                                                                                |
| root `*.tgz` package files                          | npm package artifacts if `npm pack` runs without dry-run | Add ignore recommendation below.                                                                             |
| `bin/relaybase-tui/relaybase-tui-windows-amd64.exe` | Generated current-platform TUI binary                    | Not present on this host. Ignore source-control staging, but allow package dry-run to include it when built. |

## 2. Classification Summary

| Bucket                             | Paths                                                                                                                                                                                    |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Intended source changes            | `.github/workflows/ci.yml`, `package.json`, `scripts/*.mjs`, `src/**/*.ts`, `tests/**/*.ts`, `tui/**/*.go`, `.go-version`, `.goreleaser.yml`, `AGENTS.md`, `bin/relaybase-tui/README.md` |
| Intended docs/reports              | `README.md`, `docs/**/*.md`, `reports/phase-0/*.md`, stable `reports/release-candidate/*.md`, selected `reports/fix-planning/*.md`                                                       |
| Generated binaries                 | Future `bin/relaybase-tui/relaybase-tui-*`; currently absent                                                                                                                             |
| Generated npm packages             | Future root `*.tgz`; currently absent                                                                                                                                                    |
| Generated Go artifacts             | Future `dist/**` from GoReleaser; currently absent                                                                                                                                       |
| Logs                               | Export/log artifacts should be under disposable state dirs or ignored `artifacts/`; none found as untracked source files                                                                 |
| Screenshots/recordings/transcripts | `artifacts/tui-verification/*`; ignored                                                                                                                                                  |
| Temp state dirs                    | Test code and smoke harness use `os.tmpdir()`; `.relaybase/` absent and ignored                                                                                                          |
| Local config                       | `.codex/config.toml`; untracked and should stay local                                                                                                                                    |
| Unknown                            | None after current inventory, but every report and generated evidence file still needs owner classification before staging                                                               |

## 3. Keep, Delete, Ignore, Commit Recommendations

Do not delete anything in this planning task. Future cleanup should use this policy:

| Item                                         | Keep                        | Delete                               | Ignore        | Commit                                                     |
| -------------------------------------------- | --------------------------- | ------------------------------------ | ------------- | ---------------------------------------------------------- |
| Durable source/docs/scripts/tests            | Yes                         | No                                   | No            | Yes, after review and matching prompt scope                |
| `reports/fix-planning/`                      | Yes                         | No                                   | No by default | Only if the planning lane is intentionally promoted        |
| `reports/release-candidate/` stable reports  | Yes                         | No                                   | No by default | Yes when release-readiness claims are current and reviewed |
| Generated TUI evidence under `artifacts/`    | Yes for local evidence      | Optional only with explicit approval | Yes           | No, unless explicitly promoted                             |
| `dist/` release outputs                      | Yes for CI artifact upload  | Optional after inspection            | Yes           | No                                                         |
| root `*.tgz` package outputs                 | Optional                    | Optional after inspection            | Yes           | No                                                         |
| `bin/relaybase-tui/README.md`                | Yes                         | No                                   | No            | Yes if package path placeholder is intended                |
| `bin/relaybase-tui/relaybase-tui-*` binaries | Yes for local/package smoke | Optional after release smoke         | Yes           | No in source git; package artifact may include them        |
| `.codex/config.toml`                         | Local only                  | Optional with explicit approval      | Yes           | No                                                         |
| `.codex-tools/`                              | Local helper only           | Optional with explicit approval      | Yes           | No                                                         |
| OS temp state dirs                           | Local only                  | Yes after process cleanup            | Outside repo  | No                                                         |

## 4. `.gitignore` Update Recommendations

Current `.gitignore` contains:

```text
.codex-tools/
.relaybase/
MVP.md
coverage/
dist/
node_modules/
npm-debug.log*
artifacts/
```

Recommended future additions:

```text
.codex/
*.tgz
bin/relaybase-tui/relaybase-tui-*
!bin/relaybase-tui/README.md
```

Rationale:

- `.codex/` is local agent config and is currently untracked.
- `*.tgz` prevents accidental staging of `npm pack` outputs.
- `bin/relaybase-tui/relaybase-tui-*` prevents generated platform binaries from becoming source commits.
- The negated README rule preserves the package path placeholder.

Important package boundary: `.npmignore` exists and does not ignore `bin/`, while `package.json` `files` includes `bin/`. Future implementation must verify that git-ignored built TUI binaries can still be included in npm package dry-runs when explicitly built. `npm run package:check:strict` is the guard for that.

## 5. Script Output Path Recommendations

| Producer                  | Current output behavior                                                                                    | Recommendation                                                                                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run package:check`   | Runs `npm pack --dry-run --json`; no root tarball should be created                                        | Keep dry-run. If a non-dry-run pack command is added, write to an ignored/temp directory or rely on `*.tgz` ignore.                                                     |
| `npm run tui:build`       | Writes current-platform binary under `bin/relaybase-tui/`                                                  | Keep output path for package smoke, but ignore `relaybase-tui-*` binaries in git.                                                                                       |
| `npm run tui:build:all`   | Cross-builds six release binary names under `bin/relaybase-tui/`                                           | Treat as generated local/package artifacts, not source.                                                                                                                 |
| `npm run release:dry-run` | GoReleaser writes snapshot artifacts under root `dist/`                                                    | Keep `dist/` ignored. CI should upload `dist/**` as workflow artifact and inspect `dist/relaybase-tui-checksums.txt`.                                                   |
| `npm run tui:smoke`       | Writes evidence under `artifacts/tui-verification/` and `reports/release-candidate/tui-evidence-report.md` | Keep `artifacts/` ignored. Treat the report as intentionally generated only when the smoke task requires it; otherwise prefer a temp report path or explicit promotion. |
| Log export API/tests      | Writes under `<state-dir>/exports/<exportId>/`; tests use `os.tmpdir()` state dirs                         | Keep exports under daemon state dirs. Do not write test exports into repo root.                                                                                         |
| Durable log store         | Writes under `<state-dir>/logs/`                                                                           | Keep under disposable or selected Relaybase state dir; never under repo root unless explicitly testing local state.                                                     |
| Preferences               | TUI stores under `<state-dir>/tui/preferences.json`                                                        | Use disposable state dirs in tests/smoke. Never use real user state for verification.                                                                                   |

## 6. CI Dirty-Worktree Check Recommendation

Add a CI hygiene check after verification jobs that are expected not to mutate tracked files:

```bash
git diff --exit-code
git diff --cached --exit-code
test -z "$(git status --short --untracked-files=all)"
```

For PowerShell runners, use an equivalent script that prints `git status --short --untracked-files=all` before failing.

Recommended implementation details:

- Put the check in a reusable script such as `scripts/check-worktree-clean.mjs` so Windows, macOS, and Linux use one policy.
- Allow ignored outputs (`artifacts/`, `dist/`, `node_modules/`) to exist without failing.
- Fail on untracked source-looking files, reports, package tarballs, binaries outside ignored paths, and modified tracked files.
- Run the check in CI after `npm run verify`, TUI checks, package dry-run, and release dry-run where appropriate.
- Do not run the clean-worktree check immediately after tasks that intentionally generate committed reports unless the task first writes reports in a controlled, committed lane.

## 7. Proposed Implementation Tasks

### PRE-RA-FIX006A - Add Source-Control Ignore Rules

Likely files to change:

- `.gitignore`

Commands to run:

- `git check-ignore -v .codex/config.toml`
- `git check-ignore -v bin/relaybase-tui/relaybase-tui-windows-amd64.exe`
- `git check-ignore -v cameloo-relaybase-0.1.0.tgz`
- `git status --short --ignored .codex bin/relaybase-tui artifacts dist`

Acceptance criteria:

- Local `.codex/` config is ignored.
- Generated TUI binaries are ignored while `bin/relaybase-tui/README.md` remains trackable.
- Root npm tarballs are ignored.
- Existing ignored artifact paths remain ignored.

### PRE-RA-FIX006B - Add Dirty-Worktree Verification Script

Likely files to change:

- `scripts/check-worktree-clean.mjs`
- `package.json`
- `.github/workflows/ci.yml`

Commands to run:

- `npm run workspace:check` or equivalent.
- `git status --short --untracked-files=all`.
- `npm run format:check`.
- `npm run lint`.
- `npm run typecheck`.
- `npm test`.

Acceptance criteria:

- The script fails when source-looking untracked or modified files exist.
- The script ignores only configured generated paths.
- CI runs the script after non-mutating verification lanes.
- The script prints exact dirty paths before failing.

### PRE-RA-FIX006C - Classify Publication Set

Likely files to change:

- None by default.
- Optional report update under `reports/fix-planning/` if the user wants a publication manifest.

Commands to run:

- `git status --short`.
- `git diff --stat`.
- `git diff --name-only`.
- `git ls-files --others --exclude-standard`.
- Targeted `git diff -- <path>` for files proposed for staging.

Acceptance criteria:

- Source/docs/scripts/tests intended for release are listed separately from generated artifacts and local config.
- No generated binaries, package tarballs, raw logs, temp state, or ignored evidence artifacts are staged.
- Reports are staged only if explicitly promoted.
- The final staging plan names included and excluded categories.

### PRE-RA-FIX006D - Adjust Evidence Output Policy If Needed

Likely files to change:

- `scripts/tui-smoke.mjs`
- `docs/tui-toolchain.md`
- `reports/release-candidate/test-matrix.md` only after real evidence exists

Commands to run:

- `npm run tui:smoke` on a Go-capable host with a built TUI binary.
- `git status --short --ignored artifacts reports/release-candidate`.

Acceptance criteria:

- Generated transcripts, state snapshots, preferences snapshots, and recordings stay under ignored `artifacts/`.
- Any report written under `reports/` is intentional and reviewed before commit.
- Smoke uses disposable state under OS temp and never real user Relaybase state.

## 8. Future Implementation Acceptance Criteria

- Release verification starts from a clean worktree or a disposable verification checkout.
- Release verification ends clean except intentional report artifacts.
- Generated binaries, packages, logs, screenshots, recordings, and state dirs are ignored or written outside the repo.
- Committed reports are explicit and reviewed.
- CI fails if unexpected dirty files appear after verification.
- `git status --short` output is captured in final verification.
- Source/docs/scripts/tests are staged separately from generated artifacts.

## 9. Current Decision

Dirty workspace status is a PRE-RA blocker for AI-agent prompts in the current release-readiness gate. It is not evidence of a daemon/product-code failure, but it prevents a trustworthy clean baseline for future AI-agent roadmap work.

Decision: `BLOCK_AI_AGENT_PROMPTS` until the workspace is either cleaned or the intended release-readiness source/report set is explicitly classified and staged/published separately from generated artifacts.

## 10. Commands Run

- `Get-Content -Raw C:\Users\wamin\.codex\skills\relaybase\SKILL.md`
- `rg -n "workspace hygiene|dirty workspace|git status|artifact|Relaybase|PRE-RA" C:\Users\wamin\.codex\memories\MEMORY.md`
- `Get-Content -Raw AGENTS.md`
- `Get-Content -Raw docs\relaybase-release-roadmap.md`
- `Get-Content -Raw docs\tui-architecture.md`
- `Get-Content -Raw docs\tui-testing-strategy.md`
- `Get-Content -Raw reports\release-candidate\release-readiness.md`
- `Get-Content -Raw reports\release-candidate\hardening-report.md`
- `Get-Content -Raw reports\fix-planning\PRE-RA-FP000-release-readiness-triage.md`
- `rg -n "FINAL-VERIFY|Independent release readiness|release verifier|FAIL release readiness|do not ship|workspace.*dirty|dirty workspace" reports docs . -g "*.md" -g "!node_modules/**"`
- `codegraph-mcp agent-use status --repo . --json` failed because `codegraph-mcp` is not on PATH.
- `C:\Users\wamin\Desktop\development\codegraph-mcp\target\release\codegraph-mcp.exe agent-use status --repo . --json` passed; graph was claimable/current but sidecars were stale.
- `C:\Users\wamin\Desktop\development\codegraph-mcp\target\release\codegraph-mcp.exe agent-use index --repo . --json` failed in sandbox with LocalAppData publish-state access denied.
- Escalated `C:\Users\wamin\Desktop\development\codegraph-mcp\target\release\codegraph-mcp.exe agent-use index --repo . --json` passed; graph current, claimable.
- `C:\Users\wamin\Desktop\development\codegraph-mcp\target\release\codegraph-mcp.exe agent-use context-pack --repo . --task "PRE-RA-FP006 workspace artifact hygiene plan" --agent-json` failed in sandbox with database open error.
- Escalated `C:\Users\wamin\Desktop\development\codegraph-mcp\target\release\codegraph-mcp.exe agent-use context-pack --repo . --task "PRE-RA-FP006 workspace artifact hygiene plan" --agent-json` passed with text evidence only and no graph proof path.
- `git status --short`
- `git diff --stat`
- `git diff --name-only`
- `git ls-files --others --exclude-standard`
- `Get-Content -Raw .gitignore`
- `Get-ChildItem -Force -Filter .npmignore`
- `Get-Content -Raw package.json`
- `Get-Content -Raw scripts\package-check.mjs`
- `Get-Content -Raw scripts\tui-go.mjs`
- `Get-Content -Raw scripts\tui-smoke.mjs`
- `Get-Content -Raw .npmignore`
- `rg -n "artifacts|dist|bin/relaybase-tui|bin\\relaybase-tui|exports|exportRoot|package:check|npm pack|mkdtemp|tui-verification|relaybase-tui-checksums|stateDir|state-dir|screenshots|recording|pty" scripts src tests docs package.json .goreleaser.yml .github -g "!node_modules/**"`
- `Get-Content -Raw src\logExport.ts`
- `Get-Content -Raw .goreleaser.yml`
- `Get-ChildItem -Force artifacts`
- `Get-ChildItem -Recurse -Force artifacts | Select-Object Mode,Length,LastWriteTime,FullName`
- `Get-ChildItem -Recurse -Force bin\relaybase-tui | Select-Object Mode,Length,LastWriteTime,FullName`
- `Get-ChildItem -Recurse -Force dist | Select-Object Mode,Length,LastWriteTime,FullName`
- `Get-ChildItem -Recurse -Force reports\release-candidate | Select-Object Mode,Length,LastWriteTime,FullName`
- `git check-ignore -v artifacts\tui-verification\pty-transcript.txt dist\relaybase-tui-checksums.txt node_modules\.package-lock.json bin\relaybase-tui\relaybase-tui-windows-amd64.exe`
- `Test-Path -LiteralPath .\dist`
- `Test-Path -LiteralPath .\artifacts`
- `Test-Path -LiteralPath .\bin\relaybase-tui\relaybase-tui-windows-amd64.exe`
- `Get-ChildItem -Force -LiteralPath .\dist`
- `Get-ChildItem -Force -LiteralPath .\artifacts\tui-verification | Select-Object Name,Length,LastWriteTime`
- `git diff -- .gitignore`
- `git ls-files bin scripts reports docs tui src tests .github package.json .gitignore AGENTS.md .goreleaser.yml .go-version`
- `Get-ChildItem -Force -Recurse .codex | Select-Object FullName,Length,LastWriteTime`
- `Get-ChildItem -Force -Recurse bin | Select-Object FullName,Length,LastWriteTime`
- `Get-ChildItem -Force -Recurse reports\fix-planning | Select-Object FullName,Length,LastWriteTime`
- `Get-ChildItem -Force -Filter *.tgz`
- `Get-ChildItem -Force -Recurse -Include *.log,*.zip,*.jsonl,*.png,*.gif,*.cast,*.mp4,*.tgz,*.exe | Where-Object { $_.FullName -notlike '*\node_modules\*' } | Select-Object FullName,Length,LastWriteTime`
- `git status --short --ignored artifacts dist bin\relaybase-tui node_modules .codex`
- `git check-ignore -v .codex\config.toml reports\fix-planning\PRE-RA-FP006-workspace-artifact-hygiene-plan.md`
- `git status --short --ignored .codex-tools .relaybase coverage dist artifacts node_modules`
- `Test-Path -LiteralPath .\.relaybase`
- `Test-Path -LiteralPath .\coverage`
- `Get-ChildItem -Force -LiteralPath .\.relaybase`
- `Get-ChildItem -Force -LiteralPath .\.codex-tools`
