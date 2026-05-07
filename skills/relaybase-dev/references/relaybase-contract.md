# Relaybase Contract

Relaybase is the primary local runtime surface for app development. It owns lifecycle, routing, logs, health, and child MCP aggregation.

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

## MCP Tools

Prefer these tools when available:

```text
list_apps
app_status
health_check
register_app
start_app
stop_app
restart_app
tail_logs
app_url
```

Mutation tools require a Relaybase token:

```text
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

## CLI

Use the Relaybase repo-local CLI when working from the repo:

```powershell
npm.cmd run relaybase -- serve
npm.cmd run relaybase -- status
npm.cmd run relaybase -- register .\relaybase.app.json
npm.cmd run relaybase -- start <app-id>
npm.cmd run relaybase -- logs <app-id>
npm.cmd run relaybase -- stop <app-id>
```

From outside the repo, prefer `npx @cameloo/relaybase` only if the package is available.

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
