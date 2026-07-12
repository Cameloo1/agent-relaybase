# Architecture

Relaybase is a local daemon plus app-owned configuration. The daemon owns lifecycle, routing, health proof, logs, state, and MCP access. Each app repo owns its code, start command, health route, environment, Docker files, and any app-specific cleanup.

MCP gives agents tools and data. Relaybase adds the missing process layer: stable app ids, stable localhost routes, a daemon registry, app lifecycle control, route verification, logs, and stop correctness.

## Ownership

Relaybase owns:

- app registration and daemon state
- assigned backend ports
- app start, stop, restart, and health checks
- human and agent routing
- process logs
- app-state snapshots
- MCP lifecycle tools
- child MCP aggregation declared by app manifests
- stop cleanup and verification

The app repo owns:

- application code
- package scripts and runtime dependencies
- health endpoints
- environment values and secrets
- Docker Compose files, Dockerfiles, migrations, and seeds
- child MCP server implementation
- app-specific lifecycle hook behavior

Dashboards and other clients should consume Relaybase state and APIs instead of spawning app processes directly, unless they are explicitly running in a documented fallback mode.

## Runtime Pieces

- Daemon: serves the dashboard, HTTP API, proxy routes, MCP endpoints, WebSocket upgrades, and TCP tunnel handshakes.
- Registry: stores registered manifests in Relaybase's state directory.
- Process manager: starts and stops app processes, captures logs, runs hooks, checks health, supervises child MCP servers, and verifies stop cleanup.
- Router: maps human routes like `<app-id>.localhost` and agent header routes using `X-Relaybase-App`.
- App state: combines manifest data, runtime state, backend-port checks, route health, readiness, logs, and action flags.
- Setup engine: powers `relaybase configure`, `relaybase open`, `relaybase health`, and MCP setup tools.
- Registration verification service: composes registry, launch compilation, process manager, health, stop verification, repairs, and bounded operation evidence. It never spawns, kills, probes, or writes setup files directly.
- MCP layer: exposes Relaybase lifecycle tools, resources, prompts, and allowlisted child MCP capabilities.

## Request Paths

Human route:

```text
browser -> http://<app-id>.localhost:7777 -> Relaybase -> app backend
```

Agent route:

```text
agent -> http://127.0.0.1:7777 + X-Relaybase-App -> Relaybase -> app backend
```

MCP:

```text
MCP client -> relaybase mcp or /mcp -> Relaybase lifecycle tools -> daemon state
```

TCP:

```text
socket -> RELAYBASE-TCP <app-id> + session token preface -> Relaybase TCP proxy -> app backend
```

## Lifecycle

Apps start from `relaybase.app.json`. Relaybase uses `upstreamPort` when present; otherwise it assigns a backend port and injects `PORT`, `HOST`, `RELAYBASE_APP_ID`, and `RELAYBASE_BASE_URL`.

Start order:

1. Select or verify the backend port.
2. Run `preStartCommand` when present.
3. Spawn `command`.
4. Start declared child MCP servers.
5. Wait for `healthUrl` or a TCP port check.
6. Mark the app running only after health succeeds.

Stop order:

1. Stop accepting new child MCP calls.
2. Drain in-flight child MCP calls.
3. Stop child MCP servers.
4. Terminate the app process tree.
5. Run `stopCommand` when present.
6. Run `verifyStoppedCommand` when present.
7. Verify the owned backend port is closed.
8. Report stopped only when cleanup and verification pass.

If cleanup fails, verification fails, or an owned backend port remains open, Relaybase reports an errored runtime instead of pretending the app stopped cleanly.

## Registration verification

Registration apply first completes its approval-bound file and registry work. When the bound preview selected `quick`, the daemon-owned registration verification service then:

1. Re-reads the registered manifest and compiles the exact structured launch plan.
2. Checks cwd, executable availability, fixed-port conflicts, and proof identity.
3. Requests one bounded start through `ProcessManager`.
4. Uses the existing health primitive and at most three bounded localhost candidate probes.
5. Requests stop through `ProcessManager` after health success or terminal failure.
6. Requires stop and owned-port closure before reporting `registered_verified`.
7. Persists a bounded redacted `registration_verification` operation record.

The service retains five in-memory attempt summaries per app and rejects repetition of an already-failed launch-plan digest. Repairs remain preview-only until another explicit approval. Cleanup failure blocks repair and launch retries.

## Setup

`relaybase configure` detects project metadata, scripts, framework hints, env files, port-like env values, Compose files, MCP hints, monorepo hints, and likely health routes.

Current setup plans:

- `managed-web`
- `framework-port-flag`
- `pinned-upstream`
- `docker-compose`
- `static-preview`
- `mcp-only`

Setup writes are guarded and inspectable. A normal applied setup can write `relaybase.app.json` and files under `.relaybase/`, including launch profiles, setup answers, rollback data, setup reports, proof runs, MCP config, and generated Docker lifecycle files.
