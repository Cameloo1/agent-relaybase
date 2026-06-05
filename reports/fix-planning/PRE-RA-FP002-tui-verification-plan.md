# PRE-RA-FP002 TUI Verification Plan

Date: 2026-06-01

Mode: planning only. This report does not mark any Go/TUI check as passing, because
`go` is not available on this verification host.

## 1. Existing TUI Module Inventory

Relaybase has a separate Go TUI module at `tui/`.

| Area                    | Current evidence                                                                                                                                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Go module               | `tui/go.mod` declares module `github.com/cameloo/relaybase/tui` and `go 1.24`.                                                                                                                                                      |
| Go sum                  | `tui/go.sum` is currently missing. This is not an observed test failure, but it is release verification debt because CI is configured to cache using `tui/go.sum` and dependency checks cannot be reproduced until Go is available. |
| Charm stack             | `tui/go.mod` requires `charm.land/bubbletea/v2`, `charm.land/bubbles/v2`, and `charm.land/lipgloss/v2`.                                                                                                                             |
| Entrypoint              | `tui/cmd/relaybase-tui/main.go` starts a Bubble Tea program with `tea.NewProgram`.                                                                                                                                                  |
| Build wrapper           | `scripts/tui-go.mjs` builds from `tui/` with `go build -trimpath -o <repo>/bin/relaybase-tui/<platform-binary> ./cmd/relaybase-tui`.                                                                                                |
| Current-platform output | On this Windows amd64 host the intended binary path is `bin/relaybase-tui/relaybase-tui-windows-amd64.exe`.                                                                                                                         |
| Cross-build outputs     | The build wrapper defines `relaybase-tui-windows-amd64.exe`, `relaybase-tui-windows-arm64.exe`, `relaybase-tui-darwin-amd64`, `relaybase-tui-darwin-arm64`, `relaybase-tui-linux-amd64`, and `relaybase-tui-linux-arm64`.           |
| Release config          | `.goreleaser.yml` targets `windows`, `darwin`, and `linux` for `amd64` and `arm64`, with checksum output `relaybase-tui-checksums.txt`. GoReleaser is still unavailable on this host.                                               |

TUI package layout:

| Package or path                 | Purpose observed from source/tests                                                                                                                                               |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tui/internal/config`           | Loads daemon URL, token, state directory, and theme using Relaybase conventions.                                                                                                 |
| `tui/internal/relaybaseclient`  | Typed HTTP/SSE client for daemon state, logs, lifecycle operation requests, exports, and typed error envelopes.                                                                  |
| `tui/internal/events`           | Bubble Tea command/message adapter for the daemon event stream.                                                                                                                  |
| `tui/internal/preferences`      | TUI preference schema, atomic persistence, corrupt-file quarantine, migration, and secret rejection/redaction behavior.                                                          |
| `tui/internal/tui/model`        | Root Bubble Tea model, diagnostics, state/event handling, pane/menu/assistant interactions, and daemon API command execution.                                                    |
| `tui/internal/tui/panes`        | Pane manager for groups/components, visibility, paging, selection, focus, follow mode, scrollback, layout, persisted order/color/hidden state.                                   |
| `tui/internal/tui/views`        | Lip Gloss shell rendering, header/body/pane grid/help/confirmation/assistant-bar views.                                                                                          |
| `tui/internal/tui/keymap`       | Keymap definitions including arrows, page navigation, enter/escape, follow, slash input, context menu keys, help, and quit.                                                      |
| `tui/internal/tui/contextmenu`  | Pane and assistant context menu models/actions.                                                                                                                                  |
| `tui/internal/tui/slash`        | Deterministic slash command parser, confirmation classification, and target resolution.                                                                                          |
| `tui/internal/tui/assistant`    | Pre-AI-agent deterministic natural-language command parser and optional LLM shell safety interfaces. No OpenRouter/OpenAI Agents SDK implementation is present or required here. |
| `tui/internal/tui/testfixtures` | Small `httptest` state server fixture for TUI/client tests.                                                                                                                      |

## 2. Existing TUI Tests Inventory

These tests exist but were not executed in this environment because `go` is
missing. They should be treated as blocked evidence, not passing evidence.

| Test file                                      | Coverage already present                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Fixture/state safety                                                                                                                  |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `tui/internal/config/config_test.go`           | Relaybase env/state-dir/token convention loading.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Uses controlled env/test state paths.                                                                                                 |
| `tui/internal/relaybaseclient/client_test.go`  | `GET /__hub/api/state`, log query, normalized API error envelope decoding, SSE daemon event parsing.                                                                                                                                                                                                                                                                                                                                                                                                                                         | Uses `httptest.Server`; no real daemon or user state.                                                                                 |
| `tui/internal/preferences/preferences_test.go` | Defaults, atomic save, corrupt preference quarantine, v0 migration, no secret persisted, assistant provider private defaults, raw API key rejection.                                                                                                                                                                                                                                                                                                                                                                                         | Uses `t.TempDir()`.                                                                                                                   |
| `tui/internal/tui/panes/panes_test.go`         | Single app pane, frontend/backend group panes, 8-pane page, page nav, persisted page, selection, focus/escape, auto-open/auto-close, pin behavior, persisted order/color/hidden panes, follow/non-follow scroll, resize layout, malformed component diagnostic.                                                                                                                                                                                                                                                                              | Pure in-memory `RelaybaseState` fixtures.                                                                                             |
| `tui/internal/tui/views/views_test.go`         | Render assertions for 1, 2, 4, and 8 panes, including assistant bar.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Deterministic render inputs, fixed 120x40 shell size, ANSI-stripped compact assertions.                                               |
| `tui/internal/tui/contextmenu/menu_test.go`    | Pane menu navigation, assistant menu navigation, disabled route-copy behavior.                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Pure in-memory menu model.                                                                                                            |
| `tui/internal/tui/slash/slash_test.go`         | Parser coverage for all current slash commands, `--confirm`, confirmation requirements, exact/display/group/role resolution, ambiguity, unknown target, export scopes.                                                                                                                                                                                                                                                                                                                                                                       | Pure in-memory `RelaybaseState` fixtures.                                                                                             |
| `tui/internal/tui/assistant/assistant_test.go` | Natural phrase parser, slash preservation, no-network parser behavior, history redaction, provider defaults, remote enablement gates, prompt preview redaction, tool allowlist, lifecycle proposal confirmation, audit redaction.                                                                                                                                                                                                                                                                                                            | Pure parser/config tests; no remote provider calls.                                                                                   |
| `tui/internal/tui/styles/styles_test.go`       | Theme/terminal color fallback behavior.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Pure function test.                                                                                                                   |
| `tui/internal/tui/model/model_test.go`         | Root initial state, daemon unavailable/auth diagnostics, fake-server state fetch, API version mismatch, event handling, dashboard key flow, log event fetch command, quit/help, Ctrl+Z/Ctrl+O menus, menu preference updates, slash confirmation gate, natural assistant confirmation/clarification/history, lifecycle menu action via fake daemon client, preference load failure, missing LLM provider diagnostic, LLM shell no remote call, no raw assistant input in preferences, theme/context/pane/hidden preferences survive restart. | Uses `t.TempDir()`, `httptest.Server`, fake states, and headless `RootModel.Update`; no process manager or real user Relaybase state. |

Headless Bubble Tea update coverage exists in `model_test.go` through direct
`RootModel.Update` calls with `tea.KeyPressMsg`, `tea.WindowSizeMsg`-style
state changes where applicable, fake client messages, and synchronous command
execution. No PTY-backed test was found.

Snapshot coverage exists as assertion-style render tests in `views_test.go`.
There are no file-backed golden artifacts and no snapshot update command.

## 3. Missing Test Coverage

The verifier issue is primarily missing executable proof, not observed TUI
product failure. The following gaps remain:

| Gap                                                                     | Classification                    | Why it matters                                                                                                                                                 |
| ----------------------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `go` is missing on this host.                                           | Environment                       | Blocks `npm run tui:build`, `tui:test`, `tui:vet`, `tui:race`, direct binary launch, and bridge launch.                                                        |
| `tui/go.sum` is missing.                                                | Repo tooling / reproducibility    | Dependency resolution cannot be locked or cached until a Go-capable run produces and verifies it.                                                              |
| No `npm run tui:snapshot` script exists.                                | Test/evidence coverage            | Render snapshot tests exist, but there is no canonical npm lane for final verifier evidence.                                                                   |
| No `npm run tui:smoke` script or `scripts/tui-smoke.mjs` exists.        | Test/evidence coverage            | Direct binary launch, bridge launch, disposable daemon smoke, frontend/backend grouping visibility, and terminal capture need a canonical non-user-state lane. |
| No PTY or terminal recording harness was found.                         | Evidence coverage                 | Screenshots/recordings could not be captured because the binary was unavailable, and there is no discovered script to capture them once it exists.             |
| Race behavior on Windows is unproven.                                   | Environment / verification policy | The wrapper currently runs `go test -race ./...`; final policy must be based on evidence from a Go-capable Windows or CI host, not assumption.                 |
| End-to-end Node bridge to built package binary is unverified.           | Packaging / smoke coverage        | `src/tuiBridge.ts` has resolution logic and tests, but release readiness needs launch evidence with a real packaged binary.                                    |
| Daemon + TUI smoke with sample frontend/backend grouping is unverified. | Smoke coverage                    | Unit tests cover grouped state mapping; final readiness still needs an isolated daemon/TUI smoke that never uses real user state.                              |

Existing tests appear to cover preference persistence, slash command
confirmation, and command/assistant bar confirmation behavior. These are
currently blocked from independent verification by the missing Go toolchain,
not by missing test files.

## 4. Canonical Commands

Current commands discovered from `package.json` and `scripts/tui-go.mjs`:

| Purpose                    | Canonical command                                                                                                     | Current status on this host                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Toolchain diagnostic       | `npm.cmd run tui:doctor`                                                                                              | Runs and fails clearly because `go` is missing.                                                        |
| Repo-level doctor alias    | `npm.cmd run doctor`                                                                                                  | Runs the TUI doctor and fails clearly because `go` is missing.                                         |
| Build current-platform TUI | `npm.cmd run tui:build`                                                                                               | Blocked by missing Go; wrapper no longer surfaces raw `spawnSync go ENOENT` as the primary diagnostic. |
| Build all target binaries  | `npm.cmd run tui:build:all`                                                                                           | Blocked by missing Go.                                                                                 |
| Go tests                   | `npm.cmd run tui:test`                                                                                                | Blocked by missing Go; intended to run `go test ./...` from `tui/`.                                    |
| Go vet                     | `npm.cmd run tui:vet`                                                                                                 | Blocked by missing Go; intended to run `go vet ./...` from `tui/`.                                     |
| Go race tests              | `npm.cmd run tui:race`                                                                                                | Blocked by missing Go; intended to run `go test -race ./...` from `tui/`.                              |
| Snapshot/render proof      | `cd tui; go test ./internal/tui/views -run TestGolden -count=1`                                                       | Planned exact Go lane. No npm alias exists yet.                                                        |
| Full TUI unit proof        | `cd tui; go test ./... -count=1`                                                                                      | Planned direct Go lane once Go is available.                                                           |
| Direct binary smoke        | `.\bin\relaybase-tui\relaybase-tui-windows-amd64.exe --base-url http://127.0.0.1:<port> --state-dir <temp-state-dir>` | Blocked by missing binary and no smoke harness.                                                        |
| Node bridge launch smoke   | `node --experimental-strip-types src\cli.ts tui -- --base-url http://127.0.0.1:<port> --state-dir <temp-state-dir>`   | Planned; exact CLI passthrough should be verified before adding to final evidence.                     |
| Release config check       | `npm.cmd run release:check`                                                                                           | Blocked by missing GoReleaser.                                                                         |
| Release dry run/checksums  | `npm.cmd run release:dry-run`                                                                                         | Blocked by missing GoReleaser.                                                                         |

Recommended future npm additions:

| Proposed command           | Purpose                                                                                                                          |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `npm.cmd run tui:snapshot` | Stable wrapper for `go test ./internal/tui/views -run TestGolden -count=1` from `tui/`.                                          |
| `npm.cmd run tui:smoke`    | Stable wrapper for disposable daemon/TUI launch evidence, direct binary launch, bridge launch, and terminal capture if feasible. |

## 5. Windows-Specific Concerns

| Concern                  | Plan                                                                                                                                                                                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missing Go on PATH       | Keep the PRE-RA-FIX001 doctor/wrapper diagnostics. Final verification must capture `go version` and `go env GOVERSION GOOS GOARCH GOMOD GOMODCACHE` from `tui/`.                                                                          |
| `.exe` binary naming     | Use `bin/relaybase-tui/relaybase-tui-windows-amd64.exe` or `relaybase-tui-windows-arm64.exe` according to `process.arch`.                                                                                                                 |
| npm spawn behavior       | Continue using `shell: false` for binary spawning and the Node wrapper for Go commands; do not introduce shell string execution for TUI launch.                                                                                           |
| PowerShell vs cmd        | Canonical local commands should use `npm.cmd` on Windows. CI can use normal npm shell behavior.                                                                                                                                           |
| Real user state risk     | All smoke commands must pass an isolated `--state-dir <temp-state-dir>` and must not read or write the user's normal Relaybase state.                                                                                                     |
| Ctrl+Z terminal behavior | Unit tests cover Ctrl+Z and Ctrl+O messages. Manual/PTY smoke should verify Ctrl+O fallback at minimum because Ctrl+Z may be intercepted by terminal behavior.                                                                            |
| ANSI/render determinism  | Snapshot tests already strip ANSI and compact whitespace. Any file-backed golden lane should keep fixed width/height and normalize ANSI/line endings.                                                                                     |
| Race tests               | Do not assume Windows race support or instability. Run `npm.cmd run tui:race` on a Go-capable Windows host first; only document unsupported behavior if the failure proves environment/toolchain unsupported rather than product failure. |

## 6. CI-Specific Concerns

Current `.github/workflows/ci.yml` already separates Node-only checks from Go/TUI
checks and installs Go before TUI jobs. The plan should preserve that boundary.

| Concern              | Plan                                                                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node-only jobs       | Keep `npm run verify` independent from Go so backend/control-plane checks do not regress when Go is unavailable locally.                                       |
| Go setup             | Keep `actions/setup-go` before `npm run tui:test`, `tui:vet`, `tui:race`, and `tui:build`. Continue logging `go version` and `go env`.                         |
| Missing `tui/go.sum` | Generate and commit `tui/go.sum` from a Go-capable run, then verify CI cache behavior. Until then, setup-go caching is not fully reproducible.                 |
| Race matrix          | Linux-only race is already configured in CI. If Windows race is required for local release verification, add evidence or a clear unsupported diagnostic.       |
| Snapshot lane        | Add `npm run tui:snapshot` to CI or document the exact `go test` subset that represents snapshot evidence.                                                     |
| Smoke lane           | Add a CI or local-only `tui:smoke` lane that uses disposable state and does not start arbitrary user apps.                                                     |
| Artifacts            | Upload or archive built TUI binary paths and smoke evidence in release candidate verification, but do not stage generated binaries unless explicitly approved. |

## 7. Required Fixtures

Future implementation should use these fixture boundaries:

| Fixture                          | Required behavior                                                                                                                                                                  |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TUI unit fixtures                | Continue using `t.TempDir()`, in-memory `RelaybaseState`, and `httptest.Server`.                                                                                                   |
| Preferences fixture              | Persist only under the test temp state dir, then assert `tui/preferences.json` contains no tokens, env secrets, raw logs, or raw assistant inputs.                                 |
| Fake daemon fixture              | Serve `/__hub/api/state`, `/__hub/api/events`, `/__hub/api/apps/:id/logs`, lifecycle operation endpoints, and export endpoints as needed for TUI smoke without starting user apps. |
| Disposable real-daemon smoke     | If a real daemon is used, pass an isolated `--state-dir` and register only dedicated test fixtures. Do not use the user's normal Relaybase state or launch unknown user apps.      |
| Sample frontend/backend grouping | Provide a deterministic `RelaybaseState` or fixture manifest with one group and frontend/backend components so pane grouping can be verified without ambiguity.                    |
| Terminal sizes                   | Verify at least 80x24, 120x40, and a narrow degraded size using fixed render dimensions for snapshots.                                                                             |
| Event/log fixture                | Emit deterministic `daemon.ready`, `app.state_changed`, and `log.line_available` events with bounded log content.                                                                  |
| Evidence capture                 | Capture a terminal screenshot or recording only after the binary exists; store generated capture artifacts outside source paths unless explicitly promoted.                        |

## 8. Proposed Implementation Tasks

1. **PRE-RA-FIX002A: Go-capable TUI verification run**
   - Files likely to change: `tui/go.sum`, possibly no source files.
   - Commands: `go version`; `cd tui; go env GOVERSION GOOS GOARCH GOMOD GOMODCACHE`; `cd tui; go mod tidy`; `npm.cmd run tui:doctor`; `npm.cmd run tui:build`; `npm.cmd run tui:test`; `npm.cmd run tui:vet`; `npm.cmd run tui:race`.
   - Acceptance: current-platform TUI binary exists, Go tests/vet pass, race either passes or has an evidence-backed unsupported-environment diagnostic, and no test touches real user Relaybase state.

2. **PRE-RA-FIX002B: Snapshot command lane**
   - Files likely to change: `package.json`, `scripts/tui-go.mjs`, possibly `tui/internal/tui/views/views_test.go` if determinism issues are found.
   - Commands: `npm.cmd run tui:snapshot`; `cd tui; go test ./internal/tui/views -run TestGolden -count=1`.
   - Acceptance: snapshot/render proof has a canonical npm command and deterministic output on Windows and CI.

3. **PRE-RA-FIX002C: TUI smoke harness**
   - Files likely to change: `scripts/tui-smoke.mjs`, `package.json`, possibly `tests` or `tui/internal/tui/testfixtures` if a reusable fake daemon fixture is needed.
   - Commands: `npm.cmd run tui:build`; `npm.cmd run tui:smoke`.
   - Acceptance: direct binary launch and `relaybase tui` bridge launch are verified against disposable state; failure diagnostics remain clear; no user apps are launched.

4. **PRE-RA-FIX002D: Bridge/package binary proof**
   - Files likely to change: `src/tuiBridge.ts`, `tests/unit.test.ts`, `package.json` only if the real binary path integration is wrong.
   - Commands: `npm.cmd run tui:build`; `node --experimental-strip-types src\cli.ts tui -- --help` or a smoke-specific bridge command; `npm.cmd run package:check`.
   - Acceptance: bridge resolves `RELAYBASE_TUI_BIN`, package asset binary, and missing-binary diagnostics with real launch evidence.

5. **PRE-RA-FIX002E: Release evidence capture**
   - Files likely to change: `reports/release-candidate/*` only; scripts only if capture tooling is required.
   - Commands: `npm.cmd run tui:smoke`; capture command selected by implementation; `git status --short`.
   - Acceptance: terminal screenshot or recording exists when feasible, is clearly labeled as generated evidence, and is not committed unless explicitly promoted.

## 9. Acceptance Criteria

This blocker is fixed only when all of the following are supported by real
evidence:

- `npm.cmd run tui:build` builds `relaybase-tui` for the current platform.
- `npm.cmd run tui:test` runs Go unit/headless tests from the TUI module.
- `npm.cmd run tui:vet` runs `go vet ./...` from the TUI module.
- `npm.cmd run tui:race` either runs where supported or clearly reports an evidence-backed unsupported environment without faking a pass.
- Preference persistence tests pass.
- Slash command confirmation tests pass.
- Command/assistant bar confirmation tests pass for the existing pre-AI-agent command layer.
- Snapshot/render tests pass deterministically.
- No TUI test or smoke command touches real user Relaybase state.
- `tui/go.sum` exists and dependency resolution is reproducible.
- Direct binary launch and Node bridge launch are verified with a built binary.
- Any screenshots or terminal recordings are captured only after the TUI binary can actually launch.

## Classification

TUI verification is not blocked by an observed TUI product defect at this point.
It is blocked by:

- **Missing Go environment:** P0, primary blocker for build/test/vet/race/direct
  launch.
- **Missing executable proof lanes:** P1/P2 verification coverage gaps for
  snapshot npm alias, smoke harness, bridge launch evidence, and terminal
  capture.
- **Reproducibility debt:** missing `tui/go.sum` until a Go-capable dependency
  resolution run is performed.

Existing package scripts for `tui:build`, `tui:test`, `tui:vet`, and `tui:race`
appear to run from the correct `tui/` working directory through
`scripts/tui-go.mjs`. They are blocked on missing Go, not currently proven
broken. Existing tests appear to cover preferences, slash commands, and
pre-AI-agent command/assistant confirmation gates, but those checks remain
unverified until Go is available.

AI-agent prompts remain blocked.
