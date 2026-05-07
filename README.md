# Relaybase

> Still WIP and testing. Relaybase is for processes, and Relaybase speaks MCP.

Relaybase is a local-first  router with lifecycle management + MCP support. It runs as one localhost daemon that starts and stops app processes, keeps routes and logs visible, exposes its lifecycle control plane over MCP, and can aggregate child MCP servers declared by apps.

Relaybase remains compatible with the original local app router: the CLI, dashboard, HTTP proxy, host/header routing, and TCP tunnel behavior still sit underneath the MCP layer.

## Why MCP Alone Is Not Enough

MCP gives agents a clean way to call tools and read data. It does not decide which local dev server owns a port, restart a broken app process, preserve a stable human URL, route agent traffic by header, or coordinate child MCP servers with app lifecycle.

Relaybase fills that process layer and exposes it back to agents as MCP.

## Quick Start

```powershell
npm.cmd run relaybase -- serve
```

Open the dashboard:

```text
http://localhost:7777/__hub
```

MCP endpoints:

```text
http://localhost:7777/mcp
http://localhost:7777/sse
http://localhost:7777/.well-known/mcp.json
```

## Claude Desktop / Claude Code Stdio

Local development config:

```json
{
  "mcpServers": {
    "relaybase": {
      "command": "npm.cmd",
      "args": ["run", "relaybase", "--", "mcp"]
    }
  }
}
```

Package config:

```json
{
  "mcpServers": {
    "relaybase": {
      "command": "npx",
      "args": ["@cameloo/relaybase", "mcp"]
    }
  }
}
```

## HTTP MCP Endpoint

Streamable HTTP is served at:

```text
/mcp
```

Legacy SSE compatibility is served at:

```text
/sse
```

Mutation tools require the local Relaybase session token through either:

```text
Authorization: Bearer <token>
x-relaybase-token: <token>
```

## App Manifest

Existing `relaybase.app.json` files remain valid:

```json
{
  "id": "notes",
  "name": "Notes",
  "command": "npm.cmd run dev",
  "cwd": ".",
  "protocol": "http",
  "healthUrl": "/"
}
```

Apps can also declare child MCP servers:

```json
{
  "schemaVersion": 1,
  "id": "example",
  "name": "Example App",
  "command": "npm.cmd run dev",
  "cwd": ".",
  "protocol": "http",
  "healthUrl": "/",
  "mcp": {
    "enabled": true,
    "children": [
      {
        "id": "tools",
        "transport": "stdio",
        "command": "node",
        "args": ["./mcp-server.js"],
        "cwd": ".",
        "expose": {
          "tools": ["search", "summarize"],
          "resources": ["docs://index"],
          "prompts": ["debug"]
        }
      }
    ]
  }
}
```

Child exposure is exact allowlist only. Wildcards and expose-all defaults are intentionally not supported.

## Lifecycle Tools

Relaybase exposes these MCP tools:

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

Mutation tools are token-gated: `register_app`, `start_app`, `stop_app`, and `restart_app`.

## Child MCP Aggregation

Child tools are surfaced as:

```text
<app-id>.<tool-name>
```

Child resources are surfaced as:

```text
relaybase://app/<id>/mcp/<resource-uri>
```

Child prompts are surfaced as:

```text
<app-id>.<prompt-name>
```

Child MCP servers start with `start_app`, stop with `stop_app`, and are included in `app_status` and `health_check`. Relaybase drains in-flight child calls before stopping, then reports structured drain results.

## Routing Foundation

- Dashboard: `http://localhost:7777/__hub`
- Human app route: `http://<app-id>.localhost:7777`
- Agent app route: `X-Relaybase-App: <app-id>`
- TCP tunnel preface: `RELAYBASE-TCP <app-id>\n\n`

## Security Defaults

Relaybase binds to `127.0.0.1` by default. Remote/public MCP exposure, OAuth, TLS termination, and dashboard approval flows are outside this milestone.

## Current Limitations

- Legacy SSE exists for compatibility; Streamable HTTP is preferred.
- Child exposure is exact allowlists only.
- Remote/public MCP exposure is not supported.
- `tail_logs(..., follow: true)` currently returns a snapshot and marks follow as not accepted.
- TCP support uses an explicit Relaybase handshake for agents.

## Development And Tests

```powershell
npm.cmd test
```

Local serve workflow:

```powershell
npm.cmd run relaybase -- serve
```

Package target:

```powershell
npx @cameloo/relaybase
```

## Codex Development Skill

Relaybase includes a repo-local Codex skill at `skills/relaybase-dev` for contributors and agents. It explains how to use Relaybase as the primary local app runtime surface, with direct ports only as fallback.

See `docs/relaybase-dev-skill.md` for the purpose, decision model, and helper commands.
