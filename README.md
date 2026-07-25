![Relaybase title](docs/relaybase-title.png)

# Relaybase

[![CI](https://github.com/Cameloo1/relaybase/actions/workflows/ci.yml/badge.svg)](https://github.com/Cameloo1/relaybase/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-%3E%3D24-339933)
![License](https://img.shields.io/badge/license-MIT-green)

Relaybase is a local-first terminal control plane for development apps. It gives each registered app a stable localhost route and one place to launch it, inspect health and logs, manage related apps, and recover failed setup or lifecycle work.

The optional built-in Operator Agent can inspect explicitly granted projects, explain failures, and propose setup or lifecycle actions. The Relaybase daemon—not the Agent or terminal UI—owns processes, file writes, approvals, state, and recovery.

## What Relaybase does

- Launch local development apps without remembering a different command and port for every project.
- Register a project from its folder and prove that it starts, becomes healthy, stops, and releases its managed port.
- Route apps through stable addresses such as `http://notes.localhost:7777`.
- Show process state, readiness, routes, redacted logs, and recovery actions in one terminal interface.
- Manage apps individually or as ordered packages of related apps.
- Provide searchable help, categorized settings, a command palette, and deterministic natural-language shortcuts.
- Offer an optional Agent for project inspection, failure explanation, and approval-gated actions.
- Expose lifecycle and state through MCP for coding agents.

Relaybase binds to `127.0.0.1` by default. It does not publish development apps to the public internet.

## Install

Relaybase is currently installed from source while its first signed npm release is prepared. The public `@cameloo/relaybase` package is not available yet.

Prerequisites:

- Git
- Node.js 24 or newer
- npm
- Go 1.25.x

```bash
git clone https://github.com/Cameloo1/relaybase.git
cd relaybase
npm ci
npm run tui:build
npm run relaybase -- repair-prefix
relaybase --version
relaybase start
```

On Windows PowerShell, use `npm.cmd` in place of `npm` if script execution policy blocks `npm.ps1`.

`repair-prefix` explicitly links the current checkout into npm's global command directory. It does not start Relaybase. Keep the checkout while using this installation.

To avoid a global command link, skip `repair-prefix` and run `npm start` from the Relaybase checkout instead.

## Launch your first development app

After `relaybase start` opens the operator console, use:

```text
/add C:\path\to\your-project
```

`/add` detects the project and shows a reviewable setup proposal. Relaybase does not write project files or start the app before approval.

Use `/register` when you want project detection, registration, and one bounded launch proof:

```text
/register C:\path\to\your-project
```

The normal proof:

1. validates the exact manifest and launch plan;
2. starts the app once on its selected backend port;
3. checks declared health;
4. stops the app;
5. verifies that a Relaybase-owned port closed.

A successful proof leaves the app stopped and ready for normal use. Launch it with:

```text
/start
```

or:

```text
/start <app-id>
```

The equivalent CLI workflow is:

```bash
cd path/to/your-project
relaybase register . --plan
relaybase register .
relaybase start <app-id>
```

Use `--no-verify` only when you intentionally accept registration without a launch-readiness claim:

```bash
relaybase register . --no-verify
```

## Operator console

These are the main controls:

| Input             | Purpose                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------- |
| `?` or `/help`    | Open searchable command help.                                                           |
| `/settings`       | Open General, Appearance, Interaction, and Agent settings.                              |
| `/settings agent` | Open the dedicated Operator Agent configuration page.                                   |
| `/start`          | Open the fast registered-app launcher.                                                  |
| `/manage`         | Manage app lifecycle, routes, logs, repair, rename, unregister, and package membership. |
| `/packages`       | Create and run saved bundles of related apps.                                           |
| `Ctrl+P`          | Open the command palette.                                                               |
| `Ctrl+G`          | Open or close the Agent transcript pane.                                                |
| `F6`              | Open the full-width Agent Chat page.                                                    |
| `q`               | Start the quit flow without stopping the daemon or apps.                                |

`/help` is backed by the same command catalog used for completion. Search by command, description, alias, or keyword, then press Enter to insert the selected command.

`/settings` separates:

- daemon state and safe restart;
- theme, layout density, and Agent-pane display;
- local input/history preferences;
- daemon-owned Agent provider, tool, approval, execution, and budget settings.

Local interface preferences are stored under the Relaybase state directory. Agent settings use the authenticated daemon API. Raw provider keys are never accepted in the settings UI.

See the complete [operator console manual](docs/operator-console.md).

## Important CLI commands

| Command                       | Purpose                                                           |
| ----------------------------- | ----------------------------------------------------------------- |
| `relaybase start`             | Start the daemon when safe and open the operator console.         |
| `relaybase check`             | Run a read-only installation, daemon, project, and app diagnosis. |
| `relaybase repair`            | Diagnose registered repair domains; Agent security is the first.  |
| `relaybase register <folder>` | Preview, register, and run one bounded launch proof.              |
| `relaybase start <app-id>`    | Start one registered app.                                         |
| `relaybase stop <app-id>`     | Stop one registered app through the daemon.                       |
| `relaybase restart <app-id>`  | Restart one registered app through the daemon.                    |
| `relaybase list`              | Show registered apps and live runtime state when available.       |
| `relaybase health`            | Inspect the current project, daemon, route, logs, and readiness.  |
| `relaybase configure`         | Run the broader setup or repair flow.                             |
| `relaybase open`              | Configure/start the current project and open its stable route.    |
| `relaybase diagnose-token`    | Compare client and daemon state identity without printing tokens. |
| `relaybase daemon restart`    | Safely replace the daemon and restore Relaybase-owned apps.       |
| `relaybase verify`            | Run source-checkout verification gates.                           |

Use `relaybase --help` for CLI flags and [the CLI reference](docs/cli.md) for the full contract.

## App management and packages

`/manage` is the complete registered-app manager. Its available actions can open, start, stop, restart, rename, copy a route, export redacted logs, repair, unregister, or add the selected app to a package.

Bare `/start` remains the faster launcher.

`/packages` manages durable ordered bundles of registered apps. A package launch uses each member's normal lifecycle and records member-level results. Retrying a run addresses only failed or interrupted members. Deleting a package definition does not stop its apps.

## Built-in Operator Agent

Relaybase works without a model provider. Deterministic commands and recognized phrases for help, settings, lifecycle, logs, paging, and daemon recovery remain local.

The optional Operator Agent adds model-assisted project inspection and setup help. OpenRouter access is daemon-owned; on Windows the normal path uses OAuth PKCE and current-user DPAPI-protected storage.

Open `/settings`, then **Agent → Provider → Connect OpenRouter**. Use a dedicated Relaybase key with a conservative spending limit and expiration. Then configure the model and enablement under **Agent → Configuration**.

Legacy deployments may still use an external Agent configuration source:

```env
OPENROUTER_API_KEY=
RELAYBASE_AGENT_MODEL=
RELAYBASE_AGENT_ENABLED=1
RELAYBASE_AGENT_REMOTE_MODEL_ENABLED=1
```

Use the exact tool-capable model slug you intend to run. A key and model alone do not enable remote calls. Selected external configuration is validated and reloaded at each new run boundary; `/settings` → **Agent → Recovery** can trigger an explicit reload without restarting the daemon. Shell-owned startup values still require a daemon restart.

The Agent can:

- inspect an explicitly granted project folder;
- explain current app, daemon, and operation problems;
- detect setup candidates without assuming a runtime command;
- propose setup, registration, lifecycle, manifest, route, and log-export actions;
- maintain daemon-backed threads and redacted exports;
- show public tool activity and usage.

It cannot run arbitrary shell commands. Mutating work remains bound to a visible daemon approval. Stale targets or changed previews require a new approval.

See the [Operator Agent manual](docs/operator-agent.md).

## Routes

- Human app route: `http://<app-id>.localhost:7777`
- Agent app route: `http://127.0.0.1:7777` with `X-Relaybase-App: <app-id>`
- Read-only dashboard: `http://localhost:7777/__hub`
- Streamable HTTP MCP: `http://localhost:7777/mcp`
- Legacy SSE MCP: `http://localhost:7777/sse`

Route health reports `full`, `degraded`, or `failed` so clients can distinguish human-route and agent-route problems.

## MCP

Relaybase can run as a stdio MCP server:

```json
{
  "mcpServers": {
    "relaybase": {
      "command": "relaybase",
      "args": ["mcp"]
    }
  }
}
```

This uses the source-linked command installed above. Read-only MCP calls do not require mutation credentials. HTTP mutation tools require the local Relaybase token through `Authorization: Bearer <token>` or `x-relaybase-token: <token>`.

See [MCP](docs/mcp.md) and [connecting external agents](docs/ai-app-builder/connecting-agents-to-relaybase.md).

## Troubleshooting

Start with:

```bash
relaybase check
```

Common recovery paths:

- Command missing: from the source checkout, run `npm run relaybase -- repair-prefix`, or use `npm start`.
- TUI binary missing: run `npm run doctor:tui`, then `npm run tui:build`.
- Daemon unavailable: run `relaybase serve`, then retry `relaybase start`.
- App unhealthy: run `relaybase health` and `relaybase logs <app-id>`.
- Registration failure: review the recommended health-route, host/port, or pinned-port repair; no repair is applied without approval.
- Cleanup failure: resolve the remaining process or backend-port owner before another proof.
- Token mismatch: run `relaybase diagnose-token` and align the selected and daemon state directories.
- Agent credential/security issue: open `/settings agent security` or run `relaybase repair --agent-security`; add `--online` only for an intentional provider check.
- Windows `spawn UNKNOWN`: inspect `Microsoft-Windows-CodeIntegrity/Operational`; do not weaken Windows security policy to run an unsigned build.

See [Troubleshooting](docs/troubleshooting.md) for the complete symptom-led guide.

## Documentation

### Operator manual

| Goal                                             | Guide                                                        |
| ------------------------------------------------ | ------------------------------------------------------------ |
| Install and launch a first app                   | [Getting started](docs/getting-started.md)                   |
| Use help, settings, commands, apps, and packages | [Operator console](docs/operator-console.md)                 |
| Configure and use the built-in Agent             | [Operator Agent](docs/operator-agent.md)                     |
| Use CLI commands and automation                  | [CLI reference](docs/cli.md)                                 |
| Define app launch behavior                       | [App manifest](docs/app-manifest.md)                         |
| Understand status, readiness, and routes         | [App state](docs/app-state.md)                               |
| Configure Docker Compose projects                | [Docker Compose lifecycle](docs/docker-compose-lifecycle.md) |
| Read and export logs                             | [Logs](docs/logs.md)                                         |
| Connect MCP clients                              | [MCP](docs/mcp.md)                                           |
| Recover from failures                            | [Troubleshooting](docs/troubleshooting.md)                   |
| Review security boundaries                       | [Security and limits](docs/security-and-limits.md)           |

### Contributor and architecture references

| Area                               | Guide                                                                                        |
| ---------------------------------- | -------------------------------------------------------------------------------------------- |
| Complete documentation index       | [Documentation index](docs/README.md)                                                        |
| Daemon ownership and lifecycle     | [Architecture](docs/architecture.md)                                                         |
| Terminal-client architecture       | [TUI architecture](docs/tui-architecture.md)                                                 |
| Daemon/TUI API and events          | [TUI API contract](docs/tui-api-contract.md)                                                 |
| Full keyboard and command contract | [TUI keymap](docs/tui-keymap.md)                                                             |
| Operator Agent internals           | [Operator Agent architecture](docs/tui-agent-architecture.md)                                |
| Agent tools and approvals          | [Agent tools](docs/tui-agent-tools.md) and [Agent safety](docs/tui-agent-safety.md)          |
| Agent transcript rendering         | [Agent transcript and tool traces](docs/tui-agent-activity.md)                               |
| Independent Agent-work proof       | [Agent work correctness](docs/agent-work-correctness.md)                                     |
| Testing and toolchain              | [TUI testing](docs/tui-testing-strategy.md) and [TUI toolchain](docs/tui-toolchain.md)       |
| Packaging boundaries               | [Artifact hygiene](docs/artifact-hygiene.md) and [Code signing](docs/code-signing-policy.md) |

The [documentation index](docs/README.md) links the remaining stable user and contributor references and separately identifies implementation-planning documents.

## Current limits

Relaybase is local-first preview software. It does not currently provide public remote exposure, OAuth, TLS termination, a container-management UI, Docker SDK control, wildcard child-MCP exposure, automatic migrations, or automatic Docker-volume removal.

The npm package and platform packages are not public. A trusted signed Windows candidate and public-install verification remain separate release gates.

See [Security and limits](docs/security-and-limits.md).

## License

MIT

## Code signing policy

Relaybase requires the Windows release candidate to pass Authenticode trust validation and packaged execution on Windows before publication. See the [code signing policy](docs/code-signing-policy.md).

Free code signing provided by [SignPath.io](https://signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).
