![Relaybase title](docs/relaybase-title.png)

# Relaybase

[![CI](https://github.com/Cameloo1/relaybase/actions/workflows/ci.yml/badge.svg)](https://github.com/Cameloo1/relaybase/actions/workflows/ci.yml)
[![Package](https://img.shields.io/badge/package-%40cameloo%2Frelaybase-blue)](https://www.npmjs.com/package/@cameloo/relaybase)
![Node](https://img.shields.io/badge/node-%3E%3D24-339933)
![License](https://img.shields.io/badge/license-MIT-green)

> MCP is for tools and data. Relaybase is for local processes, and Relaybase speaks MCP.

Relaybase is a local-first lifecycle hub for AI-built apps. It runs a localhost daemon that can register apps, start and stop them, route traffic through stable URLs, stream logs, report health, expose a small dashboard, and provide the same control plane over MCP.

## Normal Flow

```powershell
relaybase start
relaybase check
relaybase verify
```

`relaybase start` launches the normal operator surface. With no app id, it starts the Relaybase daemon when safe, locates or builds the Go TUI in a source checkout, and opens the TUI. With an app id, `relaybase start <app-id>` still starts that registered app through the daemon.

In a fresh source checkout, `npm.cmd start` launches the same bundled start flow without changing the global npm prefix. Ordinary start and check commands never run `npm link` or remove command shims. If you intentionally want this checkout to own the global `relaybase` command, inspect with `relaybase repair-prefix --diagnose` and run `relaybase repair-prefix` explicitly.

`relaybase check` is the read-only daily diagnosis command. It runs the TUI/toolchain doctor, project and daemon health, and app inventory without making OpenRouter calls, running a package dry-run, starting unknown user apps, or repairing the command prefix.

`relaybase verify` is the source-checkout verification gate. By default it runs formatting, lint, typecheck, Node tests, Jest tests, and Relaybase health. Add `--full`, `--release`, `--live`, `--race`, or `--all` when you intentionally want deeper gates.

The npm wrappers call the same CLI bundles:

```powershell
npm.cmd start
npm.cmd run check
npm.cmd run verify
```

`relaybase configure` detects the project, chooses a setup plan, writes guarded Relaybase files, registers the app, and can verify the launch.

`relaybase open` is the daily launch command. It ensures the daemon, registers through the daemon when reachable, starts the app, checks readiness, and opens the stable route when ready.

`relaybase health` is read-only diagnosis. It reports daemon reachability, project configuration, app readiness, routes, logs, Docker profile findings, and concrete `nextActions` when something is wrong.

Use `relaybase list` to see registered apps and runtime state. It uses daemon state when available and registry-only state when the daemon is offline.

Daemon lifecycle operations are recorded in a bounded redacted SQLite ledger under the Relaybase state directory. If the daemon restarts during queued or running work, the operation fails closed as interrupted and remains inspectable/retryable; Relaybase does not infer completion.

## TUI

Launch the terminal UI through the bundled start command:

```powershell
relaybase start
```

The lower-level daemon and TUI commands remain available:

```powershell
relaybase serve
relaybase tui
```

The dashboard at `http://localhost:7777/__hub` provides a safe read-only, searchable and status-filtered app inventory, registered/running/stopped/attention counts, refresh, and an allowlisted app detail drawer. It does not embed the daemon token or full app records. Lifecycle changes, rich state, and logs remain available through authenticated Relaybase clients; the page does not own app processes.

The Node CLI bridge resolves the TUI binary in this order: `RELAYBASE_TUI_BIN`, the repo-local `.relaybase/tui-dev-bin/<platform binary>` from `npm run tui:build`, `bin/relaybase-tui/<platform binary>` inside the installed package, an optional `@cameloo/relaybase-tui-<platform>-<arch>` platform package, then a globally installed `relaybase-tui` on `PATH`. Local source builds write both the ignored development launch binary and the package asset binary with:

```powershell
npm run doctor:tui
npm run tui:build
npm run package:check
```

The direct binary entrypoint is `relaybase-tui`; it accepts `--base-url`, `--state-dir`, and `--theme`. For example:

```powershell
.\bin\relaybase-tui\relaybase-tui-windows-amd64.exe --base-url http://127.0.0.1:7777
```

If `relaybase tui` reports a missing binary, build it from source or set `RELAYBASE_TUI_BIN` to an existing `relaybase-tui` binary. Source builds and TUI checks require Go `1.25.x`; `npm run doctor:tui` reports the local Go, binary, and release-tool readiness. If the bridge reports that the daemon is unavailable, start `relaybase serve` first. Auth failures are handled by the TUI using the existing Relaybase state directory token conventions.

Relaybase CLI commands load a local `.env` from the command working directory before reading environment-backed options. Copy `.env.example` to `.env`, fill in `OPENROUTER_API_KEY` and `RELAYBASE_AGENT_MODEL` for live Operator Agent/OpenRouter runs, then start the daemon or run `npm run agent:smoke:openrouter`. Existing shell environment values take precedence over `.env`; set `RELAYBASE_ENV_FILE` to use a different file. Non-secret Agent defaults can also be updated through the token-gated Agent config API and are persisted at `<state-dir>/agent/config.json`; shell and `.env` values override those persisted defaults, and API key material is never written there. The current local live acceptance used `openai/gpt-5.4`; provider model availability is external and should be rechecked when repeating live verification.

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
| TUI architecture, bridge, and packaging           | [docs/tui-architecture.md](docs/tui-architecture.md)                 |
| TUI Go toolchain and verification                 | [docs/tui-toolchain.md](docs/tui-toolchain.md)                       |
| TUI Operator Agent architecture and OpenRouter    | [docs/tui-agent-architecture.md](docs/tui-agent-architecture.md)     |
| TUI setup/onboarding commands and safety          | [docs/tui-setup-onboarding.md](docs/tui-setup-onboarding.md)         |
| External AI app/agent builder guidance            | [docs/ai-app-builder/README.md](docs/ai-app-builder/README.md)       |

## Current Scope

Relaybase binds to `127.0.0.1` by default. It does not currently provide public remote exposure, OAuth, TLS termination, a container management UI, Docker SDK control, wildcard child MCP exposure, automatic migrations, or automatic Docker volume removal.
