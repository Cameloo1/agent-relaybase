![Relaybase title](docs/relaybase-title.png)

# Relaybase

[![CI](https://github.com/Cameloo1/relaybase/actions/workflows/ci.yml/badge.svg)](https://github.com/Cameloo1/relaybase/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40cameloo%2Frelaybase)](https://www.npmjs.com/package/@cameloo/relaybase)
![Node](https://img.shields.io/badge/node-%3E%3D24-339933)
![License](https://img.shields.io/badge/license-MIT-green)

Relaybase is a local-first control plane for the apps you build with coding agents. It gives every app a stable localhost address and one place to start, stop, inspect, route, and recover local processes.

> MCP connects agents to tools and data. Relaybase manages the local processes those agents build.

## Install

Prerequisites: Node.js 24 or newer and npm. Relaybase supports Windows, macOS, and Linux on x64 and arm64. npm selects the matching prebuilt terminal UI package, so normal installation does not require Go.

```bash
npm install --global @cameloo/relaybase
relaybase --version
relaybase start
```

`relaybase start` safely starts the local daemon when needed and opens the operator console. Relaybase binds to `127.0.0.1` by default and does not expose apps to the public internet.

## Add your first app

Open a terminal in the project you want Relaybase to manage:

```bash
cd path/to/your-project
relaybase configure
relaybase open
```

`configure` detects the project and previews a setup plan before writing guarded Relaybase files. `open` registers the app through the daemon, starts it, checks readiness, and opens its stable route when healthy.

The normal loop is intentionally small:

```bash
relaybase start      # open the operator console
relaybase list       # inspect registered apps
relaybase check      # safe, read-only diagnosis
relaybase open       # configure/start the current project
```

If anything looks wrong, run `relaybase check` first. It does not start unknown apps, repair command shims, publish packages, or call a remote model.

## What Relaybase gives you

- Stable human routes such as `http://notes.localhost:7777`
- Agent routes through `X-Relaybase-App: notes`
- Start, stop, restart, readiness, route, and log visibility
- An operator console with app inventory, command palette, multiline composer, packages, usage, and recovery surfaces
- Approval-gated setup and lifecycle mutations
- Durable, redacted operation and log state
- MCP access for coding agents
- A safe read-only dashboard at `http://localhost:7777/__hub`

The Node daemon owns processes, ports, routing, persistence, approvals, and recovery. The Go terminal UI is a client; it never takes over lifecycle ownership.

## Optional Operator Agent

Core Relaybase operation is local and does not need OpenRouter or any model key. The optional Operator Agent can add model-assisted project inspection and setup suggestions while keeping filesystem and lifecycle mutations behind explicit approvals.

Copy `.env.example` to `.env` and configure `OPENROUTER_API_KEY` plus `RELAYBASE_AGENT_MODEL` only if you want that optional path. Relaybase never writes the API key into its persisted agent configuration.

## Agent and MCP setup

Relaybase can run as a stdio MCP server:

```json
{
  "mcpServers": {
    "relaybase": {
      "command": "npx",
      "args": ["-y", "@cameloo/relaybase", "mcp"]
    }
  }
}
```

Read-only MCP calls do not require mutation credentials. HTTP mutation tools require the local Relaybase token through `Authorization: Bearer <token>` or `x-relaybase-token: <token>`.

## Routes

- Human app route: `http://<app-id>.localhost:7777`
- Agent app route: `http://127.0.0.1:7777` with `X-Relaybase-App: <app-id>`
- Dashboard: `http://localhost:7777/__hub`
- Streamable HTTP MCP: `http://localhost:7777/mcp`
- Legacy SSE MCP: `http://localhost:7777/sse`

Route health reports `full`, `degraded`, or `failed` so a client can distinguish human-route and agent-route problems.

## Troubleshooting

Start with:

```bash
relaybase check
```

Common recovery paths:

- Missing TUI binary: reinstall `@cameloo/relaybase`; source contributors can run `npm run tui:build`.
- Daemon unavailable: run `relaybase serve`, then retry `relaybase start`.
- App will not become healthy: run `relaybase health` and inspect the reported logs and `nextActions`.
- Port conflict: let Relaybase choose a dynamic port or update the manifest’s explicit port strategy.
- Token mismatch: use the state directory reported by `relaybase check`; never paste the token into logs or issues.

See [Troubleshooting](docs/troubleshooting.md) for symptom-led recovery and [Getting started](docs/getting-started.md) for a complete first-run walkthrough.

## Install from source

Source installation is for contributors. It requires Node.js 24+, npm, and Go 1.25.x for TUI work.

```bash
git clone https://github.com/Cameloo1/relaybase.git
cd relaybase
npm ci
npm start
```

The source-checkout start path does not silently run `npm link` or replace global command shims. Use `relaybase repair-prefix --diagnose` before explicitly repairing a global development command.

## Documentation

| Goal                             | Guide                                                         |
| -------------------------------- | ------------------------------------------------------------- |
| Install and launch the first app | [Getting started](docs/getting-started.md)                    |
| Recover from common failures     | [Troubleshooting](docs/troubleshooting.md)                    |
| Learn CLI commands and options   | [CLI reference](docs/cli.md)                                  |
| Understand ownership and state   | [Architecture](docs/architecture.md)                          |
| Configure an app manifest        | [App manifest](docs/app-manifest.md)                          |
| Connect MCP clients              | [MCP](docs/mcp.md)                                            |
| Understand security boundaries   | [Security and limits](docs/security-and-limits.md)            |
| Develop or package the TUI       | [TUI toolchain](docs/tui-toolchain.md)                        |
| Use the optional Operator Agent  | [Operator Agent architecture](docs/tui-agent-architecture.md) |

## Current limits

Relaybase is local-first preview software. It does not currently provide public remote exposure, OAuth, TLS termination, a container-management UI, Docker SDK control, wildcard child-MCP exposure, automatic migrations, or automatic Docker-volume removal. See [Security and limits](docs/security-and-limits.md) before using it with sensitive or production workloads.

## License

MIT
