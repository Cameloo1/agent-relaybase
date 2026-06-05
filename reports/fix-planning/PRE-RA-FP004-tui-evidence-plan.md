# PRE-RA-FP004 TUI Evidence Capture Plan

Date: 2026-06-02

Mode: planning only. This report does not implement product-code fixes, does not
mark blocked checks as passing, and does not broaden Relaybase into the future
AI-agent roadmap.

## 1. Executive Summary

The TUI evidence blocker is still open. Current source inspection shows real
Go tests for preferences, slash command confirmation, command/assistant bar
confirmation, pane dashboard state, daemon diagnostics, and render snapshots.
Those checks are not independently verified on this Windows host because `go`
is not installed and no `relaybase-tui` binary exists.

The missing evidence is not currently an observed TUI product defect. It is a
combination of:

- environment blocker: Go is missing, so the TUI cannot be built or tested;
- packaging blocker: `bin/relaybase-tui/` contains no platform binary;
- evidence coverage blocker: no canonical `tui:smoke` or terminal
  recording/screenshot harness exists;
- release tooling blocker: GoReleaser is also missing, but that is outside the
  TUI UX evidence lane.

AI-agent prompts must remain blocked until a Go-capable environment builds and
launches the real TUI binary and captures the required UX evidence.

## 2. Existing TUI Evidence Surface

| Area                  | Current evidence                                                                                                                                                                                                                                                                         | Current gap                                                                                           |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| TUI module            | `tui/go.mod` declares `github.com/cameloo/relaybase/tui` with Go `1.24` and Bubble Tea/Lip Gloss v2 dependencies.                                                                                                                                                                        | `tui/go.sum` is missing until a Go-capable run resolves modules.                                      |
| Entrypoint            | `tui/cmd/relaybase-tui/main.go` loads config, creates `relaybaseclient.Client`, creates `model.RootModel`, and runs Bubble Tea.                                                                                                                                                          | Cannot launch here because no binary can be built without Go.                                         |
| Preferences           | `tui/internal/preferences/preferences.go` stores `<state-dir>/tui/preferences.json`, uses atomic temp-file replace, corrupt-file quarantine, defaults, migration, and secret filtering.                                                                                                  | Tests exist but are not executable on this host.                                                      |
| Preference tests      | `preferences_test.go` covers defaults, atomic save, corrupt recovery, v0 migration, secret rejection, assistant provider privacy, and raw API key rejection.                                                                                                                             | No real TUI restart transcript compares preference file before/after.                                 |
| Slash parser          | `tui/internal/tui/slash/slash.go` parses lifecycle, export, page, pane color, pin, theme, help, confirm, cancel; `RequiresConfirmation` gates lifecycle/export.                                                                                                                          | Parser tests exist but no PTY transcript proves the live key/input path.                              |
| Slash tests           | `slash_test.go` covers all commands, `--confirm`, destructive confirmation classification, exact/display/group/role resolution, ambiguity, unknown targets, and export targets.                                                                                                          | Not independently run without Go.                                                                     |
| Command/assistant bar | `tui/internal/tui/model/model.go` routes slash and natural input through the same confirmation pipeline and daemon-client command abstractions.                                                                                                                                          | No real terminal transcript proving the visible command bar flow.                                     |
| Assistant tests       | `assistant_test.go` covers local deterministic phrase parsing, no-network parser behavior, redaction, optional provider safety shell, tool allowlist, and lifecycle proposal confirmation.                                                                                               | This is pre-AI-agent only; no OpenRouter/OpenAI Agents SDK work should be added here.                 |
| Headless model tests  | `model_test.go` covers daemon unavailable/auth diagnostics, state fetch with fake server, grouped panes, menu navigation, Ctrl+Z/Ctrl+O, slash/natural confirmation gates, fake daemon lifecycle/export calls, preferences surviving restart, and no raw assistant input in preferences. | No PTY-backed integration test or real binary smoke.                                                  |
| Pane tests            | `panes_test.go` covers single app panes, frontend/backend groups, 8 panes, pages, selection, focus, auto-open/close, pin, follow, resize, malformed data diagnostics, persisted order/color/hidden panes.                                                                                | Needs a live TUI capture of grouped frontend/backend panes.                                           |
| Snapshot tests        | `views_test.go` has assertion-style golden tests for 1, 2, 4, and 8 panes plus stable terminal sizes with ANSI-stripped compact snapshots.                                                                                                                                               | There are no file-backed golden artifacts, and `npm run tui:snapshot` is still blocked by missing Go. |
| Fake daemon fixtures  | `tui/internal/tui/testfixtures/server.go` provides grouped frontend/backend state, sample logs, `httptest` fake daemon, and isolated temp state helpers.                                                                                                                                 | Useful for tests, but not a real binary/PTY evidence harness.                                         |
| Bridge/package launch | `src/tuiBridge.ts` resolves env override, dev/package binary, optional platform package, and global PATH fallback; it spawns with `shell: false`.                                                                                                                                        | Real binary launch through the bridge is still unverified.                                            |

## 3. Test Type Classification

| Behavior                                              | Existing coverage type                                                       | Files                                                                               |
| ----------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Preference load/save/corruption/secrets               | Go unit tests                                                                | `tui/internal/preferences/preferences_test.go`                                      |
| Pane grouping, paging, follow, pin/color/order/hidden | Go unit tests                                                                | `tui/internal/tui/panes/panes_test.go`                                              |
| Slash parser and target resolution                    | Go unit tests                                                                | `tui/internal/tui/slash/slash_test.go`                                              |
| Deterministic assistant parser and safety shell       | Go unit tests                                                                | `tui/internal/tui/assistant/assistant_test.go`                                      |
| Confirmation gates and daemon-client execution path   | Headless Bubble Tea model tests                                              | `tui/internal/tui/model/model_test.go`                                              |
| Context menu key handling                             | Headless Bubble Tea model tests plus menu unit tests                         | `tui/internal/tui/model/model_test.go`, `tui/internal/tui/contextmenu/menu_test.go` |
| Daemon unavailable/auth diagnostics                   | Headless model tests and fake HTTP server tests                              | `tui/internal/tui/model/model_test.go`                                              |
| Render snapshots/goldens                              | Assertion-style render tests, not file-backed golden files                   | `tui/internal/tui/views/views_test.go`                                              |
| PTY integration                                       | Not found                                                                    | None                                                                                |
| Real daemon + real TUI smoke                          | Not found                                                                    | None                                                                                |
| Terminal recording/screenshot                         | Not found; `where.exe vhs` and `where.exe asciinema` found no installed tool | None                                                                                |

## 4. Minimal Evidence Required Before AI-Agent Prompts

| Evidence ID | Required proof                                   | Command or artifact                                                           | Pass condition                                                                                                               |
| ----------- | ------------------------------------------------ | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| TUI-EV-001  | TUI binary launches directly.                    | `artifacts/tui-verification/<run-id>/direct-launch-transcript.txt` or `.cast` | Built binary starts, renders a TUI frame, and exits cleanly through `q` or harness-controlled quit.                          |
| TUI-EV-002  | TUI connects to daemon.                          | `connected-transcript.txt`, `state-before.json`, `daemon.log`                 | Header/status shows daemon connected, event stream connected or diagnosed, and `/__hub/api/state` snapshot is recorded.      |
| TUI-EV-003  | TUI renders daemon-unavailable diagnostic.       | `daemon-unavailable-transcript.txt`                                           | Direct binary against an unused port renders `daemon_unavailable` or equivalent offline diagnostic.                          |
| TUI-EV-004  | Bridge renders daemon-unavailable diagnostic.    | `bridge-daemon-unavailable.txt`                                               | `relaybase tui` reports unreachable daemon and recovery command without launching a binary.                                  |
| TUI-EV-005  | Grouped frontend/backend panes render.           | `grouped-panes-transcript.txt` or screenshot                                  | One sample group shows separate frontend and backend panes with status metadata.                                             |
| TUI-EV-006  | Preferences survive restart.                     | `preferences-before.json`, `preferences-after.json`, `preferences-diff.txt`   | Theme, pane pin, pane color, hidden/order or last page persist across TUI restart in isolated state.                         |
| TUI-EV-007  | Slash destructive commands require confirmation. | `slash-stop-confirmation-transcript.txt`; Go test log                         | `/stop current` or `/restart <target>` shows confirmation preview and does not call daemon before confirmation.              |
| TUI-EV-008  | Export command requires confirmation.            | `export-confirmation-transcript.txt`; Go test log                             | `/logs export pane` or `/logs export group notes` shows confirmation preview and does not create export before confirmation. |
| TUI-EV-009  | Command/assistant bar confirmation works.        | `assistant-confirmation-transcript.txt`; Go test log                          | `stop backend` or `export logs for notes` becomes an action preview and waits for confirmation.                              |
| TUI-EV-010  | Snapshot tests pass deterministically.           | `tui-snapshot.log`                                                            | `npm.cmd run tui:snapshot` passes with fixed terminal-size assertions.                                                       |
| TUI-EV-011  | PTY transcript or screenshot exists.             | `.cast`, `.txt`, `.gif`, or `.png` under the evidence directory               | Artifact contains a real launched TUI frame, not a mocked or generated facsimile.                                            |

## 5. Canonical Test Commands

Run these commands on a Go-capable verification host. Windows commands use
`npm.cmd`; CI or POSIX shells may use `npm`.

```powershell
node --version
npm.cmd --version
where.exe go
go version
Push-Location tui
go env GOVERSION GOOS GOARCH GOMOD GOMODCACHE
Pop-Location
npm.cmd run tui:doctor
npm.cmd run tui:build
npm.cmd run tui:test
npm.cmd run tui:vet
npm.cmd run tui:race
npm.cmd run tui:snapshot
npm.cmd run format:check
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run test:jest
npm.cmd run package:check
```

The missing smoke command should be added by a future implementation task:

```powershell
npm.cmd run tui:smoke
```

Suggested direct binary diagnostics after `npm.cmd run tui:build`:

```powershell
$runId = Get-Date -Format "yyyyMMdd-HHmmss"
$evidence = Join-Path (Resolve-Path .) "artifacts\tui-verification\$runId"
New-Item -ItemType Directory -Force $evidence | Out-Null

.\bin\relaybase-tui\relaybase-tui-windows-amd64.exe `
  --base-url http://127.0.0.1:1 `
  --state-dir (Join-Path $evidence "offline-state") `
  --theme light
```

Suggested bridge smoke once an isolated daemon is running:

```powershell
$env:RELAYBASE_TUI_BIN = (Resolve-Path .\bin\relaybase-tui\relaybase-tui-windows-amd64.exe).Path
node --experimental-strip-types src\cli.ts tui `
  --host 127.0.0.1 `
  --port <isolated-daemon-port> `
  --state-dir <isolated-state-dir>
Remove-Item Env:\RELAYBASE_TUI_BIN
```

Package strict check after a platform binary exists:

```powershell
$env:RELAYBASE_REQUIRE_TUI_BINARY = "1"
npm.cmd run package:check
Remove-Item Env:\RELAYBASE_REQUIRE_TUI_BINARY
```

## 6. Evidence Artifacts To Collect

Use a single evidence root per run:

```text
artifacts/tui-verification/<run-id>/
```

Recommended artifacts:

| Artifact                                                                                             | Purpose                                                                                  |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `metadata.json`                                                                                      | Timestamp, OS, architecture, Node/npm/Go versions, commit hash, workspace dirty summary. |
| `commands.md`                                                                                        | Exact commands, exit codes, and start/end timestamps.                                    |
| `node-version.txt`, `npm-version.txt`, `go-version.txt`, `go-env.txt`                                | Toolchain proof.                                                                         |
| `tui-doctor.log`, `tui-build.log`, `tui-test.log`, `tui-vet.log`, `tui-race.log`, `tui-snapshot.log` | Independent TUI check logs.                                                              |
| `direct-launch-transcript.txt` or `.cast`                                                            | Direct `relaybase-tui` launch evidence.                                                  |
| `bridge-launch-transcript.txt`                                                                       | `relaybase tui` launch evidence using the Node bridge.                                   |
| `daemon-unavailable-transcript.txt`                                                                  | Direct binary offline diagnostic evidence.                                               |
| `bridge-daemon-unavailable.txt`                                                                      | Node bridge daemon-unavailable diagnostic evidence.                                      |
| `grouped-panes-transcript.txt` or `.png`                                                             | Frontend/backend grouped pane render proof.                                              |
| `slash-stop-confirmation-transcript.txt`                                                             | Slash lifecycle confirmation proof.                                                      |
| `export-confirmation-transcript.txt`                                                                 | Export confirmation proof.                                                               |
| `assistant-confirmation-transcript.txt`                                                              | Pre-AI-agent command/assistant bar confirmation proof.                                   |
| `state-before.json`, `state-after.json`                                                              | Daemon state snapshots before and after smoke actions.                                   |
| `preferences-before.json`, `preferences-after.json`, `preferences-diff.txt`                          | Preference persistence proof.                                                            |
| `daemon.log`, `tui.stderr.log`, `tui.stdout.log`                                                     | Runtime diagnostics.                                                                     |
| `package-check.log`                                                                                  | Package dry-run proof after binary build.                                                |

If generated artifacts are committed at all, commit only intentional
release-candidate evidence. Otherwise keep them as local artifacts and list
them in the release report.

## 7. Terminal Capture Tool Decision

| Tool option         | Fit                                                                                                                                         | Recommendation                                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| VHS                 | Good for human-readable terminal recordings and GIFs. External tool, not currently installed on this host, and less Windows-native.         | Optional release evidence lane where installed. Do not make local Windows verification depend on it unless the tool is explicitly installed. |
| asciinema           | Good transcript format on POSIX terminals. Not currently installed here and not native to Windows PowerShell.                               | Optional POSIX/CI artifact only.                                                                                                             |
| expect              | Useful for scripted terminal control on Unix. Not a good Windows default.                                                                   | Do not choose as primary Relaybase evidence tooling.                                                                                         |
| Go PTY harness      | Fits the Go TUI and can drive a real binary from a Go-capable environment. Adds a PTY dependency and may require Windows ConPTY validation. | Best candidate for automated smoke once Go is available, if kept as a release-smoke test and proven stable.                                  |
| Node PTY harness    | Cross-platform conceptually, can launch Node bridge and direct binary. Usually requires native `node-pty` dependency.                       | Avoid as first choice unless dependency/build cost is acceptable.                                                                            |
| Plain process pipes | Lightweight, but Bubble Tea expects a TTY for faithful rendering.                                                                           | Not sufficient for final UX capture.                                                                                                         |
| Manual screenshot   | Works as a fallback when automated PTY tools are unavailable.                                                                               | Accept only as supplemental evidence with exact command log and isolated state proof.                                                        |

Recommended path:

1. Keep `npm.cmd run tui:snapshot` as deterministic render proof.
2. Add `npm.cmd run tui:smoke` as the canonical release smoke command.
3. Implement the smoke harness around a real built binary and isolated daemon
   state.
4. Prefer a Go PTY harness for automated transcript capture if it proves stable
   on Windows and CI.
5. Allow VHS/asciinema/manual screenshots as supplemental human-visible
   evidence, but never let optional tooling convert a missing TUI binary into a
   passing result.

## 8. Safe Real Daemon Plus Real TUI Plan

The smoke lane must avoid the user's normal Relaybase state and unknown user
apps.

Recommended fixture model:

- create `<evidence-root>/state` and pass it as `--state-dir`;
- start a Relaybase daemon on `127.0.0.1` with an ephemeral or recorded
  high-numbered test port;
- seed only dedicated sample manifests under a disposable fixture directory;
- use two sample apps:
  - `notes-web` with `relaybase.groupId = "notes"` and
    `componentRole = "frontend"`;
  - `notes-api` with `relaybase.groupId = "notes"` and
    `componentRole = "backend"`;
- sample apps should be tiny fixture commands that emit bounded logs and serve
  deterministic health endpoints;
- read the daemon-created token only from `<evidence-root>/state/session-token`;
- capture `/__hub/api/state` before and after the smoke;
- quit the TUI cleanly;
- stop the daemon and fixture processes through existing daemon lifecycle or
  harness cleanup.

If a full real-daemon fixture is too large for the first evidence task, use a
two-lane approach:

1. **Real TUI plus fake daemon:** proves TUI rendering, grouping, command
   confirmation, preferences, and diagnostics with deterministic state/logs.
2. **Real daemon plus API smoke:** proves daemon state/events/logs/export with
   disposable state. This cannot replace the real TUI launch capture, but it can
   isolate failures.

## 9. Cross-Platform Concerns

| Concern                  | Handling                                                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Windows binary names     | Use `relaybase-tui-windows-amd64.exe` or `relaybase-tui-windows-arm64.exe`.                                                  |
| macOS/Linux binary names | Use extensionless `relaybase-tui-darwin-*` and `relaybase-tui-linux-*` names and preserve executable bits.                   |
| Ctrl+Z                   | Terminals may intercept Ctrl+Z. Evidence must at least prove Ctrl+O fallback opens the same context menu.                    |
| ANSI and line endings    | Normalize ANSI escapes and CRLF/LF in transcripts used for assertions. Preserve raw transcript separately.                   |
| Terminal size            | Use deterministic sizes: 80x24, 120x40, and one narrow degraded layout.                                                      |
| Race tests               | Do not call skipped race tests passing. If unsupported, exit with the documented unsupported code and record evidence.       |
| State paths              | Always pass explicit `--state-dir`; never rely on `%LOCALAPPDATA%\Relaybase` or `~/.relaybase` in smoke tests.               |
| Ports                    | Prefer ephemeral ports in a harness; if manual, record the selected high-numbered port and verify no conflict before launch. |
| Secrets                  | Do not include Relaybase auth token contents, env secrets, raw logs with secrets, or `.env` payloads in captures.            |

## 10. Proposed Implementation Tasks

### PRE-RA-FIX006A - Go-Capable Evidence Run

Likely files to change:

- `tui/go.sum` if generated by `go mod tidy`;
- `reports/release-candidate/test-matrix.md`;
- `reports/release-candidate/release-readiness.md`;
- local artifacts under `artifacts/tui-verification/<run-id>/`.

Commands:

- `go version`
- `cd tui; go env GOVERSION GOOS GOARCH GOMOD GOMODCACHE`
- `npm.cmd run tui:doctor`
- `npm.cmd run tui:build`
- `npm.cmd run tui:test`
- `npm.cmd run tui:vet`
- `npm.cmd run tui:race`
- `npm.cmd run tui:snapshot`

Acceptance:

- Go environment is proven.
- TUI binary exists.
- Go tests, vet, and snapshot pass.
- Race passes or reports evidence-backed unsupported status without being
  treated as a pass.

### PRE-RA-FIX006B - TUI Smoke Harness

Likely files to change:

- `package.json`;
- `scripts/tui-smoke.mjs` or equivalent;
- possibly `tests/fixtures/tui-smoke/*`;
- possibly `tui/internal/tui/testfixtures/*` only if reusable fixture helpers
  are needed.

Commands:

- `npm.cmd run tui:build`
- `npm.cmd run tui:smoke`

Acceptance:

- Direct binary launch is recorded.
- Node bridge launch is recorded.
- All runs use isolated state.
- Smoke never starts unknown user apps.
- Smoke exits nonzero if the TUI binary is missing, daemon is unavailable, or
  confirmation gates fail.

### PRE-RA-FIX006C - Preference Persistence Evidence

Likely files to change:

- `scripts/tui-smoke.mjs` or smoke harness;
- release-candidate report files only.

Commands:

- `npm.cmd run tui:smoke -- --case preferences`

Acceptance:

- The run captures `preferences-before.json` and `preferences-after.json`.
- Pane pin, pane color, theme, and last page survive a TUI restart.
- Preference JSON contains no auth tokens, secret-like values, raw logs, or raw
  assistant input.

### PRE-RA-FIX006D - Confirmation Gate Evidence

Likely files to change:

- `scripts/tui-smoke.mjs` or PTY harness;
- release-candidate report files only.

Commands:

- `npm.cmd run tui:smoke -- --case confirmation`

Acceptance:

- `/stop current` renders a confirmation preview.
- `/logs export pane` renders a confirmation preview.
- `stop backend` through the pre-AI-agent command/assistant bar renders an
  action preview.
- Daemon lifecycle/export endpoints are not called before confirmation.
- Confirmed actions call daemon APIs through the client abstraction only.

### PRE-RA-FIX006E - Terminal Recording Or Screenshot Capture

Likely files to change:

- `scripts/tui-smoke.mjs`;
- optional capture script if VHS/asciinema is selected for a specific platform;
- release-candidate report files only.

Commands:

- `npm.cmd run tui:smoke -- --record`
- optional: `vhs artifacts/tui-verification/<run-id>/relaybase-tui-smoke.tape`
- optional: `asciinema rec artifacts/tui-verification/<run-id>/relaybase-tui.cast --command "<smoke command>"`

Acceptance:

- At least one real TUI launch recording or screenshot exists.
- The artifact is stored under `artifacts/tui-verification/<run-id>/` or
  intentionally promoted under `reports/release-candidate/`.
- If no automated capture tool is available, the report says "not verified"
  rather than inventing evidence.

## 11. Acceptance Criteria

This blocker is closed only when all of the following have real evidence:

- `npm.cmd run tui:build` builds the current-platform `relaybase-tui` binary.
- `npm.cmd run tui:test` passes Go unit/headless tests.
- `npm.cmd run tui:vet` passes.
- `npm.cmd run tui:race` passes where supported or records an honest
  unsupported-environment result.
- `npm.cmd run tui:snapshot` passes deterministically.
- A direct `relaybase-tui` launch is recorded.
- `relaybase tui` launches a built binary through the Node bridge.
- The TUI renders a daemon-unavailable diagnostic when pointed at an unavailable
  daemon.
- The bridge emits its daemon-unavailable diagnostic when the daemon is
  unreachable.
- Grouped frontend/backend panes render in a real TUI capture.
- Preferences survive a TUI restart with file/state comparison.
- Slash lifecycle and export commands require confirmation before daemon calls.
- The pre-AI-agent command/assistant bar requires confirmation before lifecycle
  or export daemon calls.
- No smoke test touches the user's real Relaybase state.
- Evidence artifacts and reports distinguish "not verified" from "broken."

## 12. Go/No-Go For AI-Agent Prompts

No-go. The TUI is not evidence-ready for AI-agent integration.

Required next prompt:

```text
PRE-RA-FIX006 - Implement TUI smoke/evidence capture harness and run it on a Go-capable host
```

That prompt should depend on the Go-capable completion of PRE-RA-FIX002 and the
real binary/bridge launch proof from PRE-RA-FIX003. If Go remains unavailable,
the prompt must stop with an environment blocker and must not fake screenshots,
transcripts, or pass status.
