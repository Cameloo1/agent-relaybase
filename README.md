# Relaybase

[![CI](https://github.com/Cameloo1/agent-relaybase/actions/workflows/ci.yml/badge.svg)](https://github.com/Cameloo1/agent-relaybase/actions/workflows/ci.yml)
[![Package](https://img.shields.io/badge/package-%40cameloo%2Frelaybase-blue)](https://www.npmjs.com/package/@cameloo/relaybase)
![Node](https://img.shields.io/badge/node-%3E%3D24-339933)
![License](https://img.shields.io/badge/license-MIT-green)

> MCP is for tools and data. Relaybase is for local processes, and Relaybase speaks MCP.

Relaybase is a local-first lifecycle hub for AI-built apps. It runs a localhost daemon that can register apps, start and stop them, route traffic through stable URLs, stream logs, report health, expose a small dashboard, and provide the same control plane over MCP.

## Normal Flow

```powershell
relaybase configure
relaybase open
relaybase health
```

`relaybase configure` detects the project, chooses a setup plan, writes guarded Relaybase files, registers the app, and can verify the launch.

`relaybase open` is the daily launch command. It ensures the daemon, registers through the daemon when reachable, starts the app, checks readiness, and opens the stable route when ready.

`relaybase health` is read-only diagnosis. It reports daemon reachability, project configuration, app readiness, routes, logs, Docker profile findings, and concrete `nextActions` when something is wrong.

Use `relaybase list` to see registered apps and runtime state. It uses daemon state when available and registry-only state when the daemon is offline.

## Routes

- Human route: `http://<app-id>.localhost:7777`
- Agent route: `http://127.0.0.1:7777` with `X-Relaybase-App: <app-id>`
- Dashboard: `http://localhost:7777/__hub`
- Streamable HTTP MCP: `http://localhost:7777/mcp`
- Legacy SSE MCP: `http://localhost:7777/sse`

Route health distinguishes `full`, `degraded`, and `failed` so agents and dashboards can tell whether the human route, header route, or both are working.

## Manifest

`relaybase configure` creates or updates `relaybase.app.json`.

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

Manifests can also declare fixed upstream ports, lifecycle hooks, timeouts, environment values, and child MCP servers. Docker Compose setup uses the same manifest hook fields while keeping Compose-specific files under `.relaybase/`.

## MCP

Relaybase can run as a stdio MCP server:

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

Read-only MCP calls do not require mutation auth. HTTP mutation tools require the local Relaybase token through `Authorization: Bearer <token>` or `x-relaybase-token: <token>`.

## Docs

| Topic                                             | File                                                                 |
| ------------------------------------------------- | -------------------------------------------------------------------- |
| Architecture and ownership boundaries             | [docs/architecture.md](docs/architecture.md)                         |
| CLI commands and options                          | [docs/cli.md](docs/cli.md)                                           |
| Manifest fields and validation                    | [docs/app-manifest.md](docs/app-manifest.md)                         |
| MCP endpoints, tools, resources, prompts, auth    | [docs/mcp.md](docs/mcp.md)                                           |
| App state, readiness, routes, logs, stop checks   | [docs/app-state.md](docs/app-state.md)                               |
| Codex workflow and repo-local Relaybase skill     | [docs/relaybase-dev-skill.md](docs/relaybase-dev-skill.md)           |
| Docker Compose setup and limits                   | [docs/docker-compose-lifecycle.md](docs/docker-compose-lifecycle.md) |
| Local security defaults and current product scope | [docs/security-and-limits.md](docs/security-and-limits.md)           |

## Current Scope

Relaybase binds to `127.0.0.1` by default. It does not currently provide public remote exposure, OAuth, TLS termination, a container management UI, Docker SDK control, wildcard child MCP exposure, automatic migrations, or automatic Docker volume removal.
