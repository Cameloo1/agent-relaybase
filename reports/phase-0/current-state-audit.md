# Relaybase Current-State Audit

Date: 2026-06-01

Scope: Task R001. This is a source audit of current Relaybase behavior. It does
not implement product features.

## Audit Metadata

- Prerequisites verified: `docs/relaybase-release-roadmap.md`, `AGENTS.md`, and
  `reports/phase-0/current-state-audit-template.md` exist.
- CodeGraph gate: passed before editing. Command:
  `C:\Users\wamin\Desktop\development\codegraph-mcp\target\release\codegraph-mcp.exe index C:\Users\wamin\Desktop\development\relaybase --db C:\Users\wamin\AppData\Local\Temp\relaybase-r001-codegraph.sqlite --fresh --json`.
- CodeGraph result: indexed 57 files, parsed 33 files, no repo-local
  `.codegraph` mutation. One nonblocking extraction budget warning applied to
  `src/dockerProfile.ts`; the audit used direct source reads for claims.
- Report-only change: no product source behavior changed.
- R000 docs update decision: no R000 docs were updated. The roadmap/API/TUI
  docs label TUI and missing API surfaces as intended planning, not implemented
  current behavior.

## Executive Summary

Relaybase currently ships as a Node/TypeScript daemon plus CLI, dashboard,
HTTP API, MCP server, router/proxy, process manager, setup engine, and tests.
There is no Go or Bubble Tea code in the repository today. The daemon already
owns process lifecycle, route/proxy behavior, app state composition, in-memory
logs, MCP tools, token-gated mutations, and a small HTML dashboard.

The R000 invariant is correct for the current codebase: lifecycle logic is in
the daemon/process manager, not in a client. The lowest-risk TUI path is to
first close daemon API gaps and operation-state gaps, then build the TUI as an
API client.

## Current Endpoints

### Existing Hub And API Routes

The daemon is created by `createRelaybaseServer` in `src/server.ts:41`. It
loads the registry, creates or reads the token, constructs `ProcessManager`,
and attaches `RelaybaseMcpService` in `src/server.ts:41-63`.

Existing hub routes are handled by `handleHub`:

- `GET /__hub` and `GET /__hub/` render the current dashboard HTML
  (`src/server.ts:161-163`).
- `/mcp` serves Streamable HTTP MCP (`src/server.ts:166-168`).
- `/sse` serves legacy SSE MCP (`src/server.ts:171-173`).
- `GET /.well-known/mcp.json` returns the MCP discovery document
  (`src/server.ts:176-178`).
- Paths under `/__hub/api/` are delegated to `handleApiRequest`
  (`src/server.ts:181-183`).

Existing HTTP API routes are implemented in `src/api.ts:28-131`:

- `GET /__hub/api/state` returns `{ apps: await getAllAppStates(runtime) }`
  (`src/api.ts:37-39`).
- `GET /__hub/api/apps` returns `{ apps: await runtime.processes.listStatuses() }`
  (`src/api.ts:42-44`).
- `POST /__hub/api/apps/register` registers a manifest and is token-gated
  (`src/api.ts:47-56`).
- `POST /__hub/api/apps/:id/start` starts an app and returns runtime plus app
  state (`src/api.ts:59-67`).
- `POST /__hub/api/apps/:id/stop` stops an app and returns runtime plus app
  state (`src/api.ts:70-74`).
- `POST /__hub/api/apps/:id/restart` restarts an app and returns runtime plus
  app state (`src/api.ts:77-81`).
- `GET /__hub/api/apps/:id/state` returns one app state
  (`src/api.ts:85-94`).
- `GET /__hub/api/apps/:id/logs/stream` opens an SSE app log stream
  (`src/api.ts:97-107`).
- `GET /__hub/api/apps/:id/logs` returns recent log lines, structured log
  events, and a stream URL (`src/api.ts:110-124`).

### Missing R000 Intended API Routes

Compared with `docs/tui-api-contract.md`, these intended TUI surfaces are not
implemented today:

- `GET /__hub/api/apps/:id` without `/state`; current detail route is
  `GET /__hub/api/apps/:id/state`.
- `GET /__hub/api/operations/:id`.
- `GET /__hub/api/events`.
- `POST /__hub/api/logs/export`.
- `GET /__hub/api/preferences`.
- `PUT /__hub/api/preferences`.
- `GET /__hub/api/diagnostics`.
- Paged log query parameters such as `limit`, `before`, `after`, and `stream`
  are not parsed in `GET /__hub/api/apps/:id/logs`.

Current lifecycle mutation responses are synchronous runtime/state payloads.
They do not return operation ids or durable operation state
(`src/api.ts:63-80`).

## Auth Today

HTTP API mutations call `requireToken` before writes or lifecycle actions
(`src/api.ts:47-49`, `src/api.ts:63-64`, `src/api.ts:70-71`,
`src/api.ts:77-78`).

`requireToken` accepts either `x-relaybase-token` or
`Authorization: Bearer <token>` and compares the supplied value with
`runtime.token` (`src/api.ts:185-193`). Failed auth returns `401`,
`UNAUTHORIZED_MUTATION`, recoverability, state directory, token path, token
presence, accepted headers, and mismatch hint without token contents
(`src/api.ts:196-227`).

The dashboard embeds the token into `window.__RELAYBASE__` at render time
(`src/dashboard.ts:3-4`, `src/dashboard.ts:157-159`) and sends it as
`X-Relaybase-Token` for dashboard start/stop actions
(`src/dashboard.ts:216-219`). This is acceptable only under the local-only
daemon assumption and is a security risk if the hub is exposed beyond the local
machine.

The CLI obtains or creates the state-dir token before lifecycle mutations and
sends `x-relaybase-token` (`src/cli.ts:201-208`, `src/cli.ts:492-512`).

MCP auth is transport-aware. HTTP MCP mutation tools require the same local
token from headers (`src/relaybaseMcp.ts:868-888`). Stdio MCP has no HTTP
headers and permits mutations when the runtime token exists
(`src/relaybaseMcp.ts:868-883`). MCP diagnostics intentionally do not print
token contents (`src/relaybaseMcp.ts:891-923`).

## State Directory And Token Behavior

Defaults are defined in `src/state.ts`:

- Host: `127.0.0.1` (`src/state.ts:6`).
- Port: `7777` (`src/state.ts:7`).
- Managed app port range: `17000-17999` (`src/state.ts:8-9`).
- `RELAYBASE_STATE_DIR` overrides the state dir (`src/state.ts:11-14`).
- On Windows, default state dir is `%LOCALAPPDATA%\Relaybase`
  (`src/state.ts:16-18`).
- Elsewhere, default state dir is `~/.relaybase` (`src/state.ts:20`).
- Token file is `session-token` in the state dir (`src/state.ts:27-43`).
- Existing tokens with length at least 32 are reused; otherwise a 32-byte
  random hex token is written with mode `0o600` (`src/state.ts:31-43`).

The registry is stored at `registry.json` in the state dir. `Registry.load`
creates the state dir and initializes an empty registry file when missing
(`src/registry.ts:13-39`). `Registry.save` writes through a temp file and
renames it into place (`src/registry.ts:79-88`).

## App Manifest Schema

The current schema is TypeScript-normalized rather than a checked-in JSON
Schema. `AppManifestInput` and `AppRecord` list current fields in
`src/types.ts:80-121`.

`normalizeManifest` requires `id`, `name`, and `command`, defaults protocol to
`http`, resolves `cwd` relative to the manifest path, normalizes env,
`upstreamPort`, `healthUrl`, lifecycle hooks, timeouts, schema version, and MCP
config (`src/validation.ts:28-99`).

Validation details:

- App ids are validated before use (`src/validation.ts:34-40`).
- Protocol must be `http`, `http+ws`, or `tcp`
  (`src/validation.ts:49-50`).
- Env must be an object with shell-style env keys and string values
  (`src/validation.ts:129-151`).
- `upstreamPort` must be an integer from `1` to `65535`
  (`src/validation.ts:154-164`).
- `healthUrl` must be absolute HTTP(S) or a path beginning with `/`
  (`src/validation.ts:166-177`).
- Lifecycle timeouts must be integers from `100` to `3600000` ms
  (`src/validation.ts:188-198`).
- `schemaVersion` must be `1` when provided; it is inferred as `1` when MCP or
  lifecycle fields are present (`src/validation.ts:200-210`).
- Child MCP transport must be `stdio`, `streamable-http`, or `sse`; required
  fields depend on transport (`src/validation.ts:247-291`).
- Child MCP exposure is exact allowlists only; wildcard `*` is rejected
  (`src/validation.ts:295-323`).

## App State Model

`getAllAppStates` reads runtime statuses from the process manager and builds
state snapshots for all apps (`src/appState.ts:17-20`). `getAppState` builds
state for one app id (`src/appState.ts:22-26`).

`composeAppState` defines the dashboard/API state contract: id, name,
registration flag, runtime, backend port, route reachability, route health,
human URL, agent URL and headers, log snapshot/stream URLs, recent logs,
lastError, readiness, actions, stop verification, and child MCP status
(`src/appState.ts:28-80`).

The runtime shape includes status, health, lifecycle phase, pid, assigned port,
timestamps, errors, action gates, attempts, MCP children, drain results, and
stop verification (`src/types.ts:128-151`). The app state interface is in
`src/types.ts:250-274`.

Readiness is derived from registration, runtime status, health, backend port
openness, and route reachability (`src/appState.ts:158-188`). The ready state
requires running, healthy, backend port open, and route reachable
(`src/appState.ts:222-229`). Route health checks both human host route and
agent header route (`src/appState.ts:294-320`).

## Lifecycle And Process Manager

`ProcessManager` is the lifecycle owner (`src/processManager.ts:65-86`). It
holds in-memory runtime entries, a per-app mutation map, log subscribers, and a
child MCP supervisor (`src/processManager.ts:73-85`).

Start behavior:

- Concurrent starts are serialized; if a start is already in progress, callers
  reuse the existing promise (`src/processManager.ts:88-105`).
- Unknown app ids throw (`src/processManager.ts:107-111`).
- Existing live child process with assigned port is returned as running
  (`src/processManager.ts:113-119`).
- Port assignment uses fixed `upstreamPort` when bindable or scans the
  configured range (`src/processManager.ts:121-132`,
  `src/processManager.ts:713-720`).
- `preStartCommand` runs before spawn with default timeout `120000` ms
  (`src/processManager.ts:141-160`).
- The app command is spawned with app cwd/env, hidden window on Windows, and
  stdout/stderr log capture (`src/processManager.ts:163-179`).
- Child MCP servers start after app process spawn (`src/processManager.ts:176`).
- Health wait uses `app.healthTimeoutMs ?? app.startTimeoutMs ?? 8000`
  (`src/processManager.ts:207-213`).
- Failed health or early exit records errored state and runs failed-start
  cleanup (`src/processManager.ts:214-234`).

Stop behavior:

- Concurrent stops are serialized; conflicting active mutations report a
  blocking reason (`src/processManager.ts:239-255`).
- Stop marks runtime stopping, drains child MCP, terminates the child process,
  and finalizes stop verification (`src/processManager.ts:258-291`).
- `stopCommand` runs with default timeout `60000` ms
  (`src/processManager.ts:413-421`).
- `verifyStoppedCommand` also uses `app.stopTimeoutMs ?? 60000`
  (`src/processManager.ts:426-440`).
- Owned backend ports are checked for closure with a fixed 3000 ms wait; on
  Windows and without an app stop hook, Relaybase may try to kill the port
  owner (`src/processManager.ts:443-452`, `src/processManager.ts:814-845`).
- Stop verification is recorded with checked port, port-open status, cleanup
  status, hook attempts, MCP drain, and failure reason
  (`src/processManager.ts:455-467`).
- Failed stop leaves runtime errored with phase `cleanup_failed` or
  `stop_verification_failed` (`src/processManager.ts:469-477`).

Restart behavior is synchronous stop-then-start under a single mutation entry
(`src/processManager.ts:294-308`). There is no durable operation id, operation
history table, or retry/abort operation state today.

Command spawning uses a simple token splitter unless the command contains shell
operators, runs `.ps1` through PowerShell with process-local execution-policy
bypass, and uses shell execution for Windows `.cmd`/`.bat`
(`src/processManager.ts:722-746`).

## Current Lifecycle Timeout Risks

- Default startup health budget is only 8000 ms when neither `healthTimeoutMs`
  nor `startTimeoutMs` is set (`src/processManager.ts:207-213`). Slow apps can
  be marked errored unless manifests override it.
- `startTimeoutMs` is used as a fallback health timeout; there is no separate
  total operation timeout or progress endpoint for start (`src/processManager.ts:207-213`).
- `preStartCommand` default timeout is 120000 ms, while `stopCommand` and
  `verifyStoppedCommand` default to 60000 ms (`src/processManager.ts:141-149`,
  `src/processManager.ts:413-432`).
- Process termination waits 5000 ms after SIGTERM/taskkill attempt before
  destroying streams (`src/processManager.ts:758-799`).
- Port-closure verification uses a fixed 3000 ms wait and is not manifest
  configurable (`src/processManager.ts:443-452`, `src/processManager.ts:802-812`).
- CLI daemon requests have a 2000 ms timeout, so slow daemon responses can be
  reported as unreachable (`src/cli.ts:501-531`).
- Health treats HTTP status `200-499` as success, which proves reachability but
  may not prove semantic readiness (`src/health.ts:37-43`).
- Shell command parsing is intentionally simple and can be risky for complex
  quoted commands; commands containing `&|<>` are handed to shell
  (`src/processManager.ts:722-755`).

## Routing And Proxy Behavior

Route resolution is in `src/router.ts`. Hub-reserved routes are `/__hub`,
`/mcp`, `/sse`, and `/.well-known/mcp.json` (`src/router.ts:4-11`).

Agent routing uses `x-relaybase-app`; header routing is checked before host
routing (`src/router.ts:14-22`). Human routing uses `<app-id>.localhost`
(`src/router.ts:24-43`).

HTTP proxying filters hop-by-hop headers, sets `x-forwarded-host`,
`x-forwarded-proto`, and `x-relaybase-routed-app`, then proxies to the selected
target port (`src/proxy.ts:16-62`). WebSocket-style upgrades proxy with a raw
TCP upstream and rebuilt upgrade request (`src/proxy.ts:64-88`).

TCP tunnel support uses a `RELAYBASE-TCP <app-id>` preface and then pipes the
socket to the app backend (`src/tcpTunnel.ts:6-68`).

## Health And Readiness Checks

`checkAppHealth` uses TCP port openness when no `healthUrl` exists
(`src/health.ts:6-14`). With `healthUrl`, it builds an HTTP(S) URL and accepts
status codes from `200` through `499` as healthy/reachable
(`src/health.ts:16-43`).

`waitForHealthy` polls until a deadline using 750 ms per health attempt and
150 ms sleeps (`src/health.ts:24-35`).

Port probes use TCP connect with a 250 ms default timeout
(`src/ports.ts:3-22`). Available managed ports are found by scanning the
configured range sequentially (`src/ports.ts:36-44`).

## Log Snapshot And SSE Behavior

Logs are in memory today. `ProcessManager.logs` and `logEvents` return copies
from the runtime entry (`src/processManager.ts:310-316`). There is no durable
log file, SQLite log table, or export endpoint in current source.

`#appendLog` adds log lines and structured events with app id, line, stream,
source, sequence, and timestamp (`src/processManager.ts:848-873`). It notifies
subscribers and caps both `logs` and `logEvents` at 500 entries
(`src/processManager.ts:874-889`).

Hook output is redacted by replacing env values whose keys match
`token|secret|password|key` and whose values are at least 4 characters
(`src/processManager.ts:565-573`, `src/processManager.ts:698-706`). App process
stdout/stderr are appended directly; hook streams use the redaction path.

`GET /__hub/api/apps/:id/logs` returns current in-memory `logs`, `events`, and
the stream URL (`src/api.ts:118-123`). The SSE stream sends:

- `status` on connect (`src/api.ts:155`).
- `snapshot` with the last 300 log lines/events (`src/api.ts:156-161`).
- `log` events for subscribed runtime log events (`src/api.ts:163-165`).
- `ping` every 15000 ms (`src/api.ts:166-168`).

## MCP Tool Behavior

Relaybase MCP exists as stdio, Streamable HTTP, and legacy SSE:

- Stdio connects with `StdioServerTransport` (`src/relaybaseMcp.ts:77-80`).
- Streamable HTTP sessions are initialized and stored by session id
  (`src/relaybaseMcp.ts:82-142`).
- Legacy SSE sessions are stored by SSE session id (`src/relaybaseMcp.ts:144-165`).
- Discovery reports package, endpoints, auth headers, state dir, token path,
  token presence, and capability flags (`src/relaybaseMcp.ts:185-211`).

Current lifecycle tools are declared in `#listTools`:

- `configure_project`
- `list_apps`
- `diagnose_token`
- `app_status`
- `health_check`
- `verify_app`
- `prove_app`
- `register_app`
- `start_app`
- `stop_app`
- `restart_app`
- `tail_logs`
- `log_stream_info`
- `app_url`

Evidence: `src/relaybaseMcp.ts:262-425`.

Mutation gates:

- `configure_project` requires mutation auth when `apply: true`
  (`src/relaybaseMcp.ts:448-452`).
- `prove_app` requires mutation auth when `lifecycle: true`
  (`src/relaybaseMcp.ts:459-463`).
- `register_app`, `start_app`, `stop_app`, and `restart_app` require mutation
  auth (`src/relaybaseMcp.ts:464-475`).
- `tail_logs`, `log_stream_info`, and read-only status/health tools are not
  mutation-gated (`src/relaybaseMcp.ts:443-481`).

Child MCP behavior:

- Child MCP runtime is supervised by `ChildMcpSupervisor`
  (`src/childMcp.ts:72-140`).
- Child tools/resources/prompts are surfaced only from exact allowlists and
  namespaced through Relaybase (`src/childMcp.ts:359-435`).
- Calls track in-flight count and complete in-flight accounting
  (`src/childMcp.ts:175-233`).
- Stopping apps drains child MCP before shutdown (`src/childMcp.ts:114-130`).

## Existing Dashboard

The dashboard is one server-rendered HTML string from `dashboardHtml`
(`src/dashboard.ts:3-6`). It contains CSS, a header, refresh button, notice
area, and app table (`src/dashboard.ts:12-156`).

It renders app rows with status, route, backend port, and Start/Stop buttons
(`src/dashboard.ts:166-188`). Refresh calls `GET /__hub/api/apps`
(`src/dashboard.ts:195-203`). Start/stop buttons call
`POST /__hub/api/apps/:id/:action` with `X-Relaybase-Token`
(`src/dashboard.ts:209-224`).

There is no app detail page, persistent preferences UI, diagnostics UI, log
viewer pane, operation progress UI, slash command input, contextual menu, or
TUI pane model in current dashboard source.

## CLI Commands

The package binary is `relaybase -> ./bin/relaybase.cjs`
(`package.json:6-8`). The bin shim runs Node with `--experimental-strip-types`
against `src/cli.ts` and preserves exit status (`bin/relaybase.cjs`).

`src/cli.ts` dispatches these commands (`src/cli.ts:60-109`):

- `configure`
- `open`
- `health`
- `list`
- `serve`
- `mcp`
- `register`
- `start`
- `stop`
- `restart`
- `status` as alias for `list`
- `logs`

`serve` starts the daemon and prints hub/MCP/state paths
(`src/cli.ts:112-127`). `mcp` starts stdio MCP (`src/cli.ts:129-139`).
`register` writes directly to the registry (`src/cli.ts:141-150`). `list`
prefers the daemon state API and falls back to offline registry data only when
runtime-dependent filters are not requested (`src/cli.ts:153-199`).
`start`/`stop`/`restart` call the running daemon API with a state-dir token
(`src/cli.ts:201-222`). `logs` prints current in-memory log snapshots
(`src/cli.ts:224-232`).

CLI options include host, port, state-dir, cwd, JSON, verbose, list filters,
configure flags, and Docker setup flags (`src/cli.ts:296-355`,
`src/cli.ts:603-625`).

## Go/Bubble Tea Code

No Go/Bubble Tea implementation exists today.

Evidence:

- `rg --files -g '*.go' -g 'go.mod' -g 'go.sum'` returned no files.
- `rg -n "bubbletea|Bubble Tea|charmbracelet|tea\." .` found only the R000
  planning docs, not source code.

## Component Or Group Model

There is no current TUI component/group model in source. Searches for
`component`, `group`, `pane`, and `layout` found R000 planning docs, CSS panel
tokens in `src/dashboard.ts`, Docker Compose parser section state in
`src/dockerProfile.ts`, and app/log URL text in existing source, but no product
domain model for components, groups, panes, or TUI layout.

Current grouping-like concepts are:

- App registry list in `Registry` (`src/registry.ts:7-95`).
- App list compacting in `src/appListing.ts`.
- Child MCP children under an app (`src/types.ts:176-199`,
  `src/childMcp.ts:46-70`).

## Existing Tests

Current test files:

- `tests/integration.test.ts`: routing, reserved routes, WebSocket upgrades,
  lifecycle, hooks, redaction, failed stop, port conflicts, TCP tunnel, and log
  SSE behavior.
- `tests/mcp.test.ts`: discovery, HTTP MCP auth, lifecycle proof, configure
  gating, stdio MCP, and child MCP allowlists.
- `tests/setup.test.ts`: project detection, configure/open/health/list,
  Docker profile/hook generation, Windows helper behavior, CLI edge cases, and
  lifecycle proof bundles.
- `tests/unit.test.ts`: validation, app state, registry, dashboard HTML, and
  router behavior.
- `tests/jest/validation.jest.ts`: Jest smoke coverage for validation, child
  MCP namespace helpers, and app state composition.
- `tests/fixtures/*`: fake managed app, fake child MCP, fake MCP server, and
  fake Compose hook fixtures.

Package scripts define the current local gates (`package.json:18-29`):

- `npm.cmd run format:check`
- `npm.cmd run lint`
- `npm.cmd run typecheck`
- `npm.cmd test`
- `npm.cmd run test:jest`
- `npm.cmd run smoke`
- `npm.cmd run package:check`
- `npm.cmd run verify`

CI runs `npm run verify` on Windows, Ubuntu, and macOS, then runs
`npm run package:check` on Ubuntu (`.github/workflows/ci.yml:16-42`,
`.github/workflows/ci.yml:43-62`). Separate workflows run ESLint/Prettier,
typecheck, and Jest (`.github/workflows/eslint.yml:16-37`,
`.github/workflows/typecheck.yml:16-34`,
`.github/workflows/jest.yml:16-34`).

## Current Test And Check Results

All required checks passed except the first sandboxed package dry-run attempt,
which was retried with approved normal npm-cache access and passed.

| Command                     | Result                                                               | Notes                                                                                                                                                  |
| --------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm.cmd run format:check`  | Passed                                                               | Prettier check green.                                                                                                                                  |
| `npm.cmd run lint`          | Passed                                                               | ESLint green.                                                                                                                                          |
| `npm.cmd run typecheck`     | Passed                                                               | `tsc --noEmit -p tsconfig.typecheck.json` green.                                                                                                       |
| `npm.cmd test`              | Passed                                                               | Node test runner: 63 tests passed.                                                                                                                     |
| `npm.cmd run test:jest`     | Passed                                                               | 1 suite, 4 tests passed.                                                                                                                               |
| `npm.cmd run smoke`         | Passed command exit                                                  | Health smoke reports current repo is not configured and daemon is unreachable; no long-running apps were started.                                      |
| `npm.cmd run package:check` | Failed in sandbox, then passed with approved normal npm cache access | First run hit `EPERM` writing npm cache under AppData; approved rerun of `npm pack --dry-run` produced package summary, 55 files, 2.7 MB package size. |

## Packaging And Scripts

The package is `@cameloo/relaybase@0.1.0`, type `module`, Node engine
`>=24.0.0` (`package.json:1-5`, `package.json:31-33`). The binary maps
`relaybase` to `./bin/relaybase.cjs` (`package.json:6-8`).

The package `files` allowlist includes `.codex-plugin/`, `.mcp.json`, `bin/`,
`src/`, `docs/`, `examples/`, and `skills/` (`package.json:9-17`). It does not
include `reports/` or `tests/`, so this audit report is local and not packaged
by default.

`.mcp.json` registers a `relaybase` MCP server using `node ./bin/relaybase.cjs
mcp` (`.mcp.json:1-11`). `.codex-plugin/plugin.json` points to skills and MCP
server metadata and describes Relaybase as a local lifecycle hub
(`.codex-plugin/plugin.json:20-41`).

`npm pack --dry-run` currently includes the R000 docs because `docs/` is
packaged. It does not include `reports/phase-0/current-state-audit.md`.

## Blocked Or Missing Areas

- No durable operation model exists for start/stop/restart/export/diagnostics.
- No `/__hub/api/operations/:id`, `/__hub/api/events`,
  `/__hub/api/logs/export`, `/__hub/api/preferences`, or
  `/__hub/api/diagnostics` endpoint exists.
- Logs are in-memory only and capped at 500 lines/events per runtime entry.
- There is no log export/redaction endpoint.
- There is no daemon-backed preferences storage.
- There is no Go/Bubble Tea code, no TUI model, no headless Bubble Tea tests,
  and no golden TUI render tests.
- Dashboard token embedding is local-only sensitive and should be revisited
  before any non-local exposure.
- Current HTTP API lifecycle mutations are synchronous and cannot be monitored
  by operation id.
- Current health smoke for this repo reports no `relaybase.app.json` or saved
  launch profile and an unreachable daemon. That is expected for this source
  audit and was not treated as a product failure.

## Lowest-Risk Implementation Path

1. Keep lifecycle in `ProcessManager` and expose more daemon API surface rather
   than adding client-side lifecycle behavior.
2. Implement a daemon operation model first, with operation ids and state for
   start, stop, restart, export, and diagnostics.
3. Add read-only daemon endpoints for app detail, operations, events,
   diagnostics, and preferences before writing TUI features.
4. Add durable/redacted log export in the daemon before building log-export UI.
5. Add contract tests for every new endpoint using disposable state dirs and
   existing fake app fixtures.
6. Add the Node CLI bridge only after daemon APIs are stable.
7. Add the Go Bubble Tea TUI as a pure API/event client, with headless update
   tests and golden render tests before packaging.

## R001 Acceptance Evidence

- Source audit completed with CodeGraph pre-edit gate and direct source reads.
- `reports/phase-0/current-state-audit.md` created.
- No product behavior changed.
- Required Node/TypeScript checks ran and passed.
- Safe smoke command ran and did not start long-running user apps.
- Packaging dry-run was checked after approved npm-cache access.
