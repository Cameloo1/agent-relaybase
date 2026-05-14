# Relaybase

[![CI](https://github.com/Cameloo1/agent-relaybase/actions/workflows/ci.yml/badge.svg)](https://github.com/Cameloo1/agent-relaybase/actions/workflows/ci.yml)
[![Package](https://img.shields.io/badge/package-%40cameloo%2Frelaybase-blue)](https://www.npmjs.com/package/@cameloo/relaybase)
![Node](https://img.shields.io/badge/node-%3E%3D24-339933)
![License](https://img.shields.io/badge/license-MIT-green)

> MCP is for tools and data. Relaybase is for processes, and Relaybase speaks MCP.

Relaybase is a local-first lifecycle hub for AI-built apps. It runs one localhost daemon that can register apps, start and stop them, route traffic through stable URLs, stream logs, report health, expose a dashboard, and offer the same control plane over MCP.

## Three Command Flow

```powershell
relaybase configure
relaybase open
relaybase health
```

`relaybase configure` detects the project, proposes a setup architecture, asks setup questions when running interactively, writes guarded Relaybase files, registers the app, and can start and verify it.

`relaybase open` is the daily launch path. It loads the saved profile or manifest, makes sure the Relaybase daemon is reachable, starts the app, checks readiness, and opens the stable route when ready.

`relaybase health` is read-only diagnosis. It checks daemon reachability, project configuration, saved launch metadata, app readiness, route state, and Docker profile findings when present.

`relaybase health --prove` writes a proof bundle. Add `--yes` when you want it to run lifecycle proof: register, start, routed health, logs, stop, and cleanup verification.

`relaybase list` is the read-only operator view for all registered apps. It shows runtime state from the daemon when available, falls back to registry-only state when the daemon is offline, and supports filters such as `--running`, `--ready`, and `--attention`.

## What Relaybase Provides

- Stable human routes: `http://<app-id>.localhost:7777`
- Stable agent routes: `http://127.0.0.1:7777` with `X-Relaybase-App: <app-id>`
- A local dashboard at `http://localhost:7777/__hub`
- A Streamable HTTP MCP endpoint at `http://localhost:7777/mcp`
- Legacy MCP SSE compatibility at `http://localhost:7777/sse`
- App manifests with lifecycle hooks, health routes, protocol selection, and optional child MCP servers
- Standard app state for dashboards and agents: runtime, readiness, routes, logs, attempts, cleanup, and stop verification
- Docker Compose setup through generated app-owned profiles and PowerShell lifecycle hooks
- Conservative Docker service selection with explicit service/port setup for ambiguous Compose projects
- A TCP tunnel preface for non-HTTP agents: `RELAYBASE-TCP <app-id>\n\n`

## Minimal Manifest

`relaybase configure` creates or updates `relaybase.app.json`. Existing simple manifests remain valid:

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

Apps that need cleanup or external infrastructure can add generic lifecycle hooks such as `preStartCommand`, `stopCommand`, and `verifyStoppedCommand`. Docker-specific behavior is generated into app-owned `.relaybase/` files, not hard-coded into the daemon.

## MCP Client Config

Local development:

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

Package use:

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

HTTP MCP mutation tools require the local Relaybase token through `Authorization: Bearer <token>` or `x-relaybase-token: <token>`.

## Docs

| Topic                                                                                                        | File                                                                 |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| How the daemon, router, registry, lifecycle manager, setup engine, and dashboard/API boundaries fit together | [docs/architecture.md](docs/architecture.md)                         |
| Exact CLI commands, options, setup artifacts, and advanced command surface                                   | [docs/cli.md](docs/cli.md)                                           |
| Manifest fields, validation rules, lifecycle hooks, and child MCP declaration shape                          | [docs/app-manifest.md](docs/app-manifest.md)                         |
| MCP endpoints, tools, resources, prompts, auth, and child aggregation behavior                               | [docs/mcp.md](docs/mcp.md)                                           |
| Standard app state, readiness checks, runtime phases, logs, and stop verification                            | [docs/app-state.md](docs/app-state.md)                               |
| Docker Compose generated files, timings, evidence, risk checks, and current limits                           | [docs/docker-compose-lifecycle.md](docs/docker-compose-lifecycle.md) |
| Local security defaults, token behavior, and current product limits                                          | [docs/security-and-limits.md](docs/security-and-limits.md)           |
| Development scripts, CI, tests, package checks, and repo-local Codex skill                                   | [docs/development.md](docs/development.md)                           |

## Development

```powershell
npm.cmd run verify
npm.cmd run package:check
```

`npm.cmd run verify` runs formatting checks, linting, TypeScript checking, Node tests, Jest tests, and the read-only CLI smoke check.

## Current Boundaries

Relaybase binds to `127.0.0.1` by default. Public remote exposure, OAuth, TLS termination, a container management UI, Docker SDK control, wildcard child MCP exposure, and automatic Docker volume removal are outside the current implementation.
