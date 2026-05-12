# Architecture

Relaybase is a local daemon plus a small set of app-owned files. The daemon owns process lifecycle, routing, logs, health checks, MCP, and state. The app repository owns its actual start command, health route, environment expectations, Docker Compose files, and any cleanup scripts.

MCP gives agents tools, prompts, and resources. It does not by itself decide which local app owns a port, preserve stable routes, restart broken app processes, route browser and agent traffic, or coordinate child MCP servers with app lifecycle. Relaybase fills that process layer and exposes it back through MCP.

The MCP layer sits on top of the original local app router foundation: CLI commands, the dashboard, the HTTP proxy, host routing, header routing, and TCP tunneling are still part of the runtime.

## Main Pieces

`src/server.ts` starts the localhost hub. It serves the dashboard, HTTP API, MCP endpoints, app proxy routes, WebSocket upgrades for app routes, and the TCP tunnel handshake.

`src/registry.ts` stores registered apps in `registry.json` under the Relaybase state directory. The default state directory is `%LOCALAPPDATA%\Relaybase` on Windows when `LOCALAPPDATA` is set, or `~/.relaybase` on other platforms. `RELAYBASE_STATE_DIR` overrides it.

`src/processManager.ts` starts, stops, restarts, health-checks, and logs app processes. It also runs lifecycle hooks, assigns backend ports, tracks lifecycle attempts, drains child MCP servers, verifies stop cleanup, and refuses fake stop success when owned ports remain open.

`src/router.ts` resolves each request. Hub paths are reserved first. Agent header routing uses `X-Relaybase-App`. Human routing uses `<app-id>.localhost`.

`src/appState.ts` builds the standard state contract for dashboards and agents. It combines registry data, process runtime, backend port checks, route reachability, readiness, logs, action flags, and stop verification.

`src/relaybaseMcp.ts` exposes Relaybase as MCP over stdio, Streamable HTTP, and legacy SSE. It also surfaces child MCP tools, resources, and prompts declared by app manifests.

`src/setup.ts` powers `relaybase configure`, `relaybase open`, `relaybase health`, and the MCP `configure_project` tool. It detects projects, proposes setup plans, writes guarded artifacts, registers manifests, starts verification, records reports, and classifies launch failures.

`src/dockerProfile.ts` contains Docker Compose detection and generated profile/script content. Docker logic stays in generated app-owned files; the daemon executes generic lifecycle hooks.

## Request Flow

Human access:

```text
browser -> http://<app-id>.localhost:7777 -> Relaybase router -> app backend port
```

Agent access:

```text
agent -> http://127.0.0.1:7777 + X-Relaybase-App -> Relaybase router -> app backend port
```

MCP access:

```text
MCP client -> /mcp, /sse, or relaybase mcp -> Relaybase lifecycle tools -> registry and process manager
```

TCP access:

```text
socket -> RELAYBASE-TCP <app-id> preface -> Relaybase TCP proxy -> app backend port
```

## Lifecycle Model

Apps start from a manifest. Relaybase assigns a backend port unless the manifest pins `upstreamPort`. It injects `PORT`, `HOST`, `RELAYBASE_APP_ID`, and `RELAYBASE_BASE_URL` into the app environment.

Start order:

1. Select or verify a backend port.
2. Run `preStartCommand` when present.
3. Spawn `command`.
4. Start child MCP servers declared by the manifest.
5. Wait for health using `healthUrl` or a TCP port check.
6. Mark the runtime as running only after health succeeds.

Stop order:

1. Stop accepting new child MCP calls.
2. Drain in-flight child MCP calls for the configured supervisor timeout.
3. Stop child MCP servers.
4. Terminate the app process tree.
5. Run `stopCommand` when present.
6. Run `verifyStoppedCommand` when present.
7. Verify the owned backend port is closed.
8. Mark the runtime stopped only when cleanup and verification pass.

If cleanup fails, verification fails, or the owned backend port remains open, Relaybase returns an errored runtime with a phase such as `cleanup_failed` or `stop_verification_failed`.

## Setup Model

`relaybase configure` detects package metadata, scripts, framework hints, env files, port-like env values, root-level Compose files, MCP hints, monorepo hints, and health route candidates.

The current setup engine can emit these plan ids:

- `managed-web`
- `framework-port-flag`
- `pinned-upstream`
- `docker-compose`
- `static-preview`
- `mcp-only`

Setup writes are guarded and inspectable. A normal applied setup can write:

- `relaybase.app.json`
- `.relaybase/launch-profile.json`
- `.relaybase/setup.answers.json`
- `.relaybase/rollback.json`
- `.relaybase/setup-report.json`
- `.relaybase/runs/<timestamp>.jsonl`

Depending on the selected plan, it may also write `.relaybase/launch.cjs`, `.relaybase/static-preview.cjs`, `.env.relaybase`, a guarded Relaybase block in `.env`, `.relaybase/mcp.json`, or Docker Compose lifecycle files.

## Ownership Boundaries

Relaybase owns:

- lifecycle state
- routing
- assigned ports
- health proof
- process logs
- MCP control tools
- child MCP aggregation
- cleanup hook execution
- stop verification
- dashboard/API state

The app repo owns:

- application code
- package scripts
- Docker Compose files
- Dockerfiles
- app health routes
- app-specific environment values
- migrations and seed behavior
- cleanup scripts
- child MCP server implementation

The dashboard owns:

- visible controls
- app lists
- buttons
- log UI
- Access App flow
- rendering Relaybase state

Dashboards should call Relaybase APIs instead of spawning app processes directly, unless they are explicitly running in a documented fallback mode.
