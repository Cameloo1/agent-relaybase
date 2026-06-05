# TUI Architecture

This document defines the architecture for the Relaybase Bubble Tea TUI release. As of R014, the repository contains an initial Go Bubble Tea client shell, pane dashboard, persistent preferences, context menus, deterministic slash commands, a deterministic natural-language assistant, an optional LLM assistant configuration shell under `tui/`, and a Node CLI bridge plus release packaging scaffolding. It is not the final release UI yet.

## Invariant

The Node/TypeScript daemon owns lifecycle. The Go Bubble Tea TUI is a client.

The TUI must never become a second lifecycle engine. It renders daemon state, sends daemon API requests, follows daemon events, and presents recovery choices that the daemon executes.

## Node/TypeScript Daemon Responsibilities

The daemon owns:

- app registry and manifest loading
- state directory selection and token storage
- app start, stop, restart, retry, abort, skip, and recovery execution
- process spawning, process-tree cleanup, port assignment, and stop verification
- health checks, route checks, readiness snapshots, and conflict detection
- HTTP API, MCP API, dashboard routes, proxy routes, WebSocket/SSE/event endpoints, and TCP tunnel entry points
- child MCP startup, drain, restart, allowlists, and shutdown
- log capture, log retention, durable export, redaction, and export audit metadata
- preferences persistence, diagnostics, and operation state
- mutation authorization and secret-safe error reporting

## Go Bubble Tea TUI Responsibilities

The TUI owns:

- terminal rendering, panes, focus, key handling, help, and quit flow
- API client calls to the daemon
- event subscription, reconnect, and snapshot refresh behavior
- local view model state derived from daemon payloads
- operation progress display using daemon operation ids
- log viewing, paging, follow mode, slash-command input, and export request initiation
- preference and diagnostics screens backed by daemon API responses
- clear offline, degraded, unauthorized, and stale-state presentation

The TUI may cache response data for rendering, but cached data is not lifecycle truth.

## R008 Go Module Layout

Decision: the TUI uses a contained Go module under `tui/` instead of a root-level Go module. This keeps the existing Node/TypeScript daemon package layout stable, avoids changing the root package manager contract, and gives the future TUI binary a clear build boundary.

Current layout:

- `tui/go.mod`: Go module for the TUI client.
- `tui/cmd/relaybase-tui/main.go`: binary entrypoint.
- `tui/internal/config`: daemon URL, state directory, theme, and token loading.
- `tui/internal/relaybaseclient`: typed HTTP and SSE client for daemon APIs.
- `tui/internal/events`: Bubble Tea commands/messages for the global daemon event stream.
- `tui/internal/tui/model`: root Bubble Tea model and diagnostics handling.
- `tui/internal/tui/views`: header, status strip, shell body, help, and assistant bar composition.
- `tui/internal/tui/components`: reusable render components.
- `tui/internal/tui/keymap`: key bindings aligned with `docs/tui-keymap.md`.
- `tui/internal/tui/styles`: Relaybase light theme, dark fallback, and terminal color fallback diagnostics.
- `tui/internal/tui/commands`: non-blocking Bubble Tea commands for daemon state fetches.
- `tui/internal/tui/assistant`: deterministic local assistant parser, response types, prompt text, optional LLM provider configuration shell, prompt preview/audit metadata helpers, tool proposal review, and secret-safe history sanitization.
- `tui/internal/tui/setupwizard`: TUI-only setup/onboarding view state for no-apps prompts, setup choices, file diffs, repair previews, and manifest patch previews.
- `tui/internal/tui/testfixtures`: test-only fake daemon helpers.

Run commands:

```powershell
cd tui
go run ./cmd/relaybase-tui --base-url http://127.0.0.1:7777
go test ./...
```

R008 shell behavior:

- fetches `/__hub/api/state`
- connects to `/__hub/api/events`
- renders connection and diagnostic state
- supports `q` quit and `?` help
- exposes client methods for lifecycle operations, log queries, and log exports only through daemon APIs

R009 dashboard behavior:

- maps daemon `AppGroup` and `AppComponent` read models into dashboard panes
- supports up to eight panes per page, multi-page navigation, selection, focus, pinned panes, hidden panes, follow mode, and independent scrollback state
- auto-opens starting/running components, auto-closes stopped components unless pinned, and keeps failed panes visible until explicitly closed in pane state
- fetches initial pane scrollback through `/__hub/api/apps/:id/logs`
- reacts to the global `/__hub/api/events` stream by refreshing state or querying affected pane logs
- keeps one global daemon event stream rather than opening one stream per pane

R010 preference behavior:

- stores TUI-only preferences under `<state-dir>/tui/preferences.json`
- keeps the daemon as lifecycle and API truth while `/__hub/api/preferences` remains planned
- uses atomic file writes and corrupt-file quarantine
- persists theme, context-menu bindings, pane pins, hidden panes, pane order, pane colors, assistant bar color, and last page
- rejects secret-like strings before writing preference JSON

R011 command and menu behavior:

- opens pane context menus with Ctrl+Z when delivered by the terminal and Ctrl+O as a guaranteed fallback
- opens assistant context menus from slash input
- parses slash commands deterministically in the TUI without LLM interpretation
- resolves exact app ids, display names, group names, the current pane, and frontend/backend roles inside the current group
- fails closed on ambiguous or unknown targets instead of guessing
- gates start, stop, restart, and log export behind a confirmation preview unless `--confirm` is explicitly supplied
- calls daemon lifecycle and export APIs for mutations; it does not spawn processes, inspect ports, or manage lifecycle locally
- persists only UI preference changes such as pane pin/color/order/hidden state, theme, assistant bar color, and page selection
- reports chat export and LLM mode as unavailable diagnostics until those features exist

R012 natural assistant behavior:

- uses a local deterministic parser only; there are no LLM calls, remote provider calls, or assistant-side network calls while parsing
- treats ordinary typed text in the dashboard as assistant input; `/` still opens slash-command input
- maps simple operator phrases such as `launch notes`, `start notes frontend`, `stop the backend`, `restart api`, `show frontend logs`, `export logs for notes`, `pin this pane`, `unpin this pane`, `change this pane to blue`, `go to next page`, `go to previous page`, `what is broken?`, and `show diagnostics`
- sends parsed commands through the same slash-command target resolution, confirmation, and daemon API execution path
- gates lifecycle mutations and log exports behind the same confirmation previews as slash commands
- asks for clarification on ambiguous role targets, including `stop backend` when no selected group makes the backend role unambiguous
- answers `what is broken?` from current TUI/daemon state and diagnostics only
- stores natural assistant interaction history separately from slash/menu message history, in memory only, with retention applied from preferences
- redacts secret-like input before placing it in assistant history; raw logs are not stored in assistant history

R013/RA010 Operator Agent behavior:

- deterministic assistant mode remains the default local fallback
- provider configuration supports `deterministic`, `local_model`, and `remote_model` modes, provider/model names, optional base URL, API key reference, token budgets, enabled tool allowlist, `sendLogs`, and `sendDiagnostics`
- API key preferences store references only, such as `env:PROVIDER_API_KEY`; raw key-looking values are rejected
- remote mode requires explicit `remoteEnabled: true` and complete provider, model, base URL, and key reference before it is considered remotely callable
- model execution is daemon-owned through the Agent Gateway and OpenRouter provider path when explicitly enabled, configured, and within budget; the Go TUI does not call remote endpoints directly
- prompt preview helpers redact before constructing preview lines and show data categories that would be sent
- logs and diagnostics are excluded from prompt preview by default and require explicit opt-in
- LLM-proposed tool calls are reviewed against an allowlist; unknown or unlisted tools are blocked
- lifecycle, setup, manifest, browser/clipboard-adjacent, and log export tool proposals require daemon approval previews before execution
- model request audit metadata exists for timestamp, provider, model, data categories, estimated tokens, proposed tool calls, approvals, and confirmed actions; raw secrets are sanitized before metadata is retained
- the Go TUI can create Agent Gateway sessions, send messages with selected pane/app/group/cwd context, stream session events, render setup/file-write/manifest/prove/repair previews, and approve or reject pending daemon approvals

The TUI does not spawn apps, inspect ports, read manifests for lifecycle decisions, or implement any lifecycle state machine.

RA003 setup/onboarding behavior:

- exposes Go client methods for the daemon setup APIs under `/__hub/api/setup/*`
- renders no-apps onboarding actions when the daemon reports no apps, groups, or components
- parses `/add`, `/configure`, `/register`, `/open`, `/prove`, `/health`, `/repair`, `/manifest`, `/port`, and `/component` setup commands
- renders daemon setup choices, repair choices, and redacted file diffs in the setup panel
- requires confirmation before daemon setup apply, register, open, prove, or manifest patch calls
- routes all setup writes, registration, proof, and lifecycle effects through the daemon
- does not write project files, run package managers, spawn app commands, probe ports, or infer lifecycle state from local files
- resolves app-targeted manifest edits only when the daemon state includes a manifest path; otherwise it asks for an explicit path

## Node CLI Bridge Responsibilities

The Node CLI bridge is the launch and compatibility surface between existing Relaybase commands and the TUI binary. It owns:

- discovering or starting the Relaybase daemon through existing daemon paths
- locating the TUI binary for the installed package
- passing hub URL, state directory, and token discovery metadata to the TUI without printing secrets
- preserving existing `relaybase configure`, `relaybase open`, `relaybase health`, `relaybase list`, and advanced command behavior
- reporting daemon/TUI launch failures with owner, command, timestamp, and recovery hints

The bridge does not start, stop, or restart apps directly except through daemon APIs that already own those lifecycle actions.

## R014 Packaging And Release Path

Current command paths:

- `relaybase serve`: starts the Node/TypeScript daemon.
- `relaybase tui`: launches the Go TUI binary as a daemon client.
- `relaybase-tui`: direct Go binary entrypoint with `--base-url`, `--state-dir`, and `--theme`.

The Node CLI bridge resolves the TUI binary in this order:

1. `RELAYBASE_TUI_BIN`
2. repo-local `.relaybase/tui-dev-bin/<platform binary>` produced by `npm run tui:build`
3. `bin/relaybase-tui/<platform binary>` inside the installed `@cameloo/relaybase` package
4. optional `@cameloo/relaybase-tui-<platform>-<arch>` platform package
5. globally installed `relaybase-tui` on `PATH`

The bridge passes daemon connection details through CLI flags and environment variables:

- `--base-url http://<host>:<port>`
- `--state-dir <state-dir>`
- `RELAYBASE_URL`
- `RELAYBASE_HOST`
- `RELAYBASE_PORT`
- `RELAYBASE_STATE_DIR`

The bridge does not print or pass raw auth tokens. The TUI loads `RELAYBASE_TOKEN` when explicitly set or reads the existing `session-token` file from the selected Relaybase state directory.

Local Go builds and checks are driven by `scripts/tui-go.mjs`; `scripts/build-tui.mjs` remains a compatibility entrypoint for build-only callers:

- `npm run tui:build` builds the current platform binary into ignored `.relaybase/tui-dev-bin/` for source-checkout launches and into `bin/relaybase-tui/` for package/release checks.
- `npm run tui:build:all` cross-builds the six supported release names when the local Go toolchain supports them.
- `npm run tui:test`, `npm run tui:vet`, and `npm run tui:race` run Go checks from `tui/` through the same missing-tool diagnostics.
- `npm run doctor:tui` reports local Node, Go, Go environment, package binary, `RELAYBASE_TUI_BIN`, and GoReleaser readiness without installing tools or starting apps.

Release configuration lives in `.goreleaser.yml`. It defines Linux, macOS, and Windows `amd64`/`arm64` TUI artifacts, archives that include the license/readme/TUI docs, and checksum generation. GoReleaser binary names match the bridge/package convention: `relaybase-tui-<os>-<arch>` with `.exe` on Windows. Platform-specific npm packages are not implemented yet; the bridge has a real resolution path for them and fails with an actionable diagnostic when no binary exists.

CI now separates:

- Node verification: format, lint, typecheck, Node tests, Jest tests, and health smoke.
- Go TUI tests: `go test ./...`, `go vet ./...`, and Linux race tests.
- TUI build smoke: `npm run tui:build` on Windows, Linux, and macOS.
- npm package smoke: `npm run package:check`, with `RELAYBASE_REQUIRE_TUI_BINARY=1` in release lanes after a TUI binary has been built.

Troubleshooting boundaries:

- Missing binary: build with `npm run tui:build`, install a package containing `bin/relaybase-tui/<platform binary>`, or set `RELAYBASE_TUI_BIN`.
- Daemon unavailable: start `relaybase serve`; the bridge does not silently start unknown user apps.
- Auth failure: use the correct state directory or set `RELAYBASE_TOKEN`; tokens are not printed in diagnostics.
- Unsupported terminal/color: launch with `relaybase tui -- --theme light` or `relaybase tui -- --theme dark`.

## API And Client Boundary

The daemon API is the only product boundary between lifecycle truth and the TUI. The TUI consumes:

- state snapshots for current app and daemon state
- app inventory and app detail endpoints
- token-gated operation endpoints for lifecycle mutations
- operation status endpoints for long-running work
- event streams for updates
- logs and export endpoints
- preferences and diagnostics endpoints

The TUI must treat daemon API errors as authoritative. It can retry client requests, reconnect event streams, or ask the user to choose a daemon-provided recovery action, but it must not infer lifecycle state by probing ports, reading manifests, or spawning commands on its own.

## Failure-Mode Philosophy

Relaybase should fail closed and explain the boundary. A failure response should name the owner when possible: daemon, token, manifest, app command, port, health route, route proxy, child MCP, log export, preferences, packaging, or TUI client.

The TUI should:

- keep rendering the last known state with a visible stale marker when the daemon is unreachable
- prefer explicit retry, reconnect, skip, abort, and recovery actions over hidden loops
- show operation ids and timestamps for mutations
- preserve logs and diagnostics without revealing token contents or secrets
- avoid destructive cleanup unless the daemon exposes a gated recovery operation

## Why Lifecycle Logic Must Not Move Into The TUI

Lifecycle logic belongs in the daemon because the daemon already owns the process table, registry, token, state directory, ports, routes, logs, child MCP servers, and cleanup verification. Moving that logic into the TUI would create split-brain state, duplicate recovery rules, inconsistent logs, token exposure risks, and broken agent/API parity.

Keeping the TUI as a client preserves one source of truth for human dashboard users, coding agents, MCP clients, CLI commands, and package smoke tests.
