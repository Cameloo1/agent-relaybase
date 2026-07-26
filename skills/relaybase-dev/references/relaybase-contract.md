# Relaybase Contract

Relaybase is the primary local runtime surface for app development. It owns lifecycle, routing, logs, health, and child MCP aggregation.

Relaybase success is not proven by a raw direct port. Treat success as proven only after routed access, routed health, logs, stop, and backend-port closure checks pass or a documented fallback is declared.

## Defaults

- Host: `127.0.0.1`
- Port: `7777`
- Dashboard: `http://localhost:7777/__hub`
- Discovery: `http://localhost:7777/.well-known/mcp.json`
- Streamable HTTP MCP: `http://localhost:7777/mcp`
- Legacy SSE MCP: `http://localhost:7777/sse`
- Repo fallback: `C:\Users\wamin\Desktop\development\agent-routing-hub`
- Package fallback: `npx @cameloo/relaybase`

## Routes

- Human route: `http://<app-id>.localhost:7777`
- Agent route: `http://127.0.0.1:7777` with header `X-Relaybase-App: <app-id>`
- TCP tunnel preface: `RELAYBASE-TCP <app-id>\n\n`

For HTTP apps, route checks should use the manifest `healthUrl` when present and `/` otherwise. A route response below 500 usually proves the route reached the app; a 5xx or connection failure is not a passing routed-health check.

## MCP Tools

Prefer these tools when available:

```text
configure_project
list_apps
app_status
health_check
diagnose_token
register_app
start_app
stop_app
restart_app
tail_logs
log_stream_info
app_url
```

Mutation tools require a Relaybase token:

```text
configure_project with apply: true
register_app
start_app
stop_app
restart_app
```

HTTP MCP and HTTP API accept either:

```text
Authorization: Bearer <token>
x-relaybase-token: <token>
```

Discovery can be healthy while mutation calls fail with `401 Unauthorized`. In that case, run:

```powershell
.\skills\relaybase-dev\scripts\relaybase-dev.cmd -Action diagnose-token
```

Report token path, token presence, state dir, and state-dir mismatch suspicion. Do not print token contents unless explicitly asked.

## HTTP API

Core dashboard/control endpoints:

```text
GET  /__hub/api/apps
POST /__hub/api/apps/register
POST /__hub/api/apps/<id>/start
POST /__hub/api/apps/<id>/stop
POST /__hub/api/apps/<id>/restart
GET  /__hub/api/apps/<id>/logs
GET  /__hub/api/apps/<id>/logs/stream
```

Use `/logs/stream` when live logs matter. Fall back to `/logs` snapshots if the stream is unavailable.

## CLI

The public CLI is intentionally small:

```powershell
relaybase configure
relaybase open
relaybase health
```

From the repo, use the same flow through the local script:

```powershell
npm.cmd run relaybase -- configure
npm.cmd run relaybase -- open
npm.cmd run relaybase -- health
```

Use advanced commands only for daemon development or low-level lifecycle debugging:

```powershell
npm.cmd run relaybase -- serve
npm.cmd run relaybase -- status
npm.cmd run relaybase -- register .\relaybase.app.json
npm.cmd run relaybase -- start <app-id>
npm.cmd run relaybase -- logs <app-id>
npm.cmd run relaybase -- stop <app-id>
```

From outside the repo, prefer `npx @cameloo/relaybase` only if the package is available.

Prefer `npm.cmd` on Windows. Do not use `npm.ps1` unless execution policy is known to allow it.

## State Token

Default token path on Windows:

```text
%LOCALAPPDATA%\Relaybase\session-token
```

If `RELAYBASE_STATE_DIR` is set, use:

```text
%RELAYBASE_STATE_DIR%\session-token
```

Do not print the token unless the user explicitly needs it. Report whether it exists.

## Verification Contract

Use these gates before claiming a Relaybase-managed app is working:

1. Discovery works.
2. Token is present for mutations.
3. Register succeeds or an existing registration is verified.
4. Start returns `running` or a useful structured failure.
5. Routed health works through host or header routing.
6. Logs are available, preferably live.
7. Stop returns `stopped`.
8. Backend port is closed after stop when a port is known.
9. Dashboard UI and `/api/status` match Relaybase when a dashboard is involved.

Helper actions:

```powershell
.\skills\relaybase-dev\scripts\relaybase-dev.cmd -Action preflight
.\skills\relaybase-dev\scripts\relaybase-dev.cmd -Action diagnose-token
.\skills\relaybase-dev\scripts\relaybase-dev.cmd -Action route-check -AppId <id>
.\skills\relaybase-dev\scripts\relaybase-dev.cmd -Action stream-logs -AppId <id>
.\skills\relaybase-dev\scripts\relaybase-dev.cmd -Action verify -AppId <id> -ManifestPath .\relaybase.app.json
.\skills\relaybase-dev\scripts\relaybase-dev.cmd -Action check-stop -AppId <id> -BackendPort <port>
```

`verify` is intentionally strict: it registers, starts, checks routed health, checks logs, stops, and verifies backend-port closure when the assigned port is known.

On Windows/Codex App, use the `.cmd` helper wrapper instead of calling the `.ps1` script directly.

## Docker Compose Contract

Compose support is profile/script based. Relaybase core executes generic hooks; generated Docker scripts own Compose-specific commands.

Docker profile path:

```text
.relaybase/docker-profile.json
```

Generated scripts:

```text
.relaybase/scripts/relaybase-prestart.ps1
.relaybase/scripts/relaybase-start.ps1
.relaybase/scripts/relaybase-stop.ps1
.relaybase/scripts/relaybase-verify-stopped.ps1
```

Expected proof:

- Docker daemon access and context output are checked before start.
- Compose config is validated before start.
- Blocked Compose settings fail prestart unless approved in the generated profile.
- Relaybase-assigned `PORT` is mapped through `.relaybase/docker-compose.relaybase.yml`.
- Dependency host ports are reset by default when the profile uses `internal-only`.
- Docker hook evidence is written under `.relaybase/runs/`.
- Stop keeps volumes by default and fails if project containers or owned ports survive.

The current generated Docker hooks are PowerShell scripts. See `../../../docs/docker-compose-lifecycle.md` for the exact generated files, timing defaults, diagnostics, and current limits.
