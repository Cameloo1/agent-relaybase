# Getting started

This guide takes a clean machine from the current source installation to a healthy development app behind a stable Relaybase route.

## 1. Install Relaybase

Install Git, Node.js 24 or newer, npm, and Go 1.25.x, then run:

```bash
git clone https://github.com/Cameloo1/relaybase.git
cd relaybase
npm ci
npm run tui:build
npm run relaybase -- repair-prefix
relaybase --version
```

On Windows PowerShell, use `npm.cmd` in place of `npm` if script execution policy blocks `npm.ps1`.

`repair-prefix` explicitly links this checkout into npm's global command directory. Keep the checkout while using the source-linked installation. If you do not want a global command, skip that step and run `npm start` from the repository root whenever this guide says `relaybase start`.

The public `@cameloo/relaybase` package is not available yet. These source instructions remain canonical until a signed release is published and independently verified.

## 2. Open the operator console

```bash
relaybase start
```

Relaybase starts its localhost daemon when safe and opens the terminal interface. If port `7777` is already occupied by a non-Relaybase process, startup fails with a recovery action instead of taking over the port.

Start with:

```text
/help
/settings
```

`/help` opens searchable command help. `?` opens the same surface. `/settings` opens General, Appearance, Interaction, and Agent settings.

The most important console commands are:

| Command              | Purpose                                                                     |
| -------------------- | --------------------------------------------------------------------------- |
| `/start`             | Launch or open a registered app.                                            |
| `/manage`            | Manage app lifecycle, routes, logs, repair, rename, and package membership. |
| `/packages`          | Manage saved multi-app launch bundles.                                      |
| `/add <folder>`      | Inspect and add a project.                                                  |
| `/register <folder>` | Register and run one bounded launch proof.                                  |
| `/settings agent`    | Configure the optional Operator Agent.                                      |

See [Operator console](operator-console.md) for the full interface and command reference.

## 3. Add or register a project

For the simplest discovery flow:

```text
/add C:\path\to\your-project
```

Relaybase inspects the selected folder and presents a setup plan. Nothing is written or started before approval.

To coordinate registration and launch-readiness proof:

```text
/register C:\path\to\your-project
```

The equivalent CLI preview and apply are:

```bash
cd path/to/your-project
relaybase register . --plan
relaybase register .
```

Relaybase locates or proposes `relaybase.app.json`, validates the launch behavior, and binds approval to the exact manifest, generated-file revisions, and verification policy.

After confirmation, the default quick proof performs one bounded start, declared health check, stop, and backend-port closure check. Success means the app was healthy and is now stopped with its Relaybase-owned port closed.

To register without a launch-readiness claim:

```bash
relaybase register . --no-verify
```

Use `relaybase configure` or `/configure` when you explicitly want the broader setup/repair flow.

## 4. Start the app

In the console:

```text
/start
```

Choose the registered app. Starting a stopped app opens a confirmation before the daemon changes lifecycle state.

From another terminal:

```bash
relaybase start <app-id>
```

Registration proof and normal running remain separate boundaries. The proof briefly runs and stops the app; `start` is the explicit normal-running action.

`relaybase open` is the configure/start/readiness/browser convenience flow after the app has an understood setup. It leaves the app running.

## 5. Inspect the running app

Use:

```bash
relaybase list
relaybase health
```

`list` shows registered apps and live daemon state when the daemon is reachable. `health` diagnoses the current project, app readiness, routes, and logs.

Human route:

```text
http://<app-id>.localhost:7777
```

Agent-header route:

```text
http://127.0.0.1:7777
X-Relaybase-App: <app-id>
```

## 6. Manage related apps

Use `/manage` for full app actions and `/packages` for ordered bundles of related apps such as a frontend, API, and worker.

Package definitions do not replace individual app lifecycle. Each member still starts, reports health, logs, and stops through the daemon.

## 7. Optional Operator Agent

No model provider is required for installation, registration, lifecycle, help, settings, or deterministic console commands.

On Windows, open `/settings`, then **Agent → Provider → Connect OpenRouter**. Relaybase uses OAuth PKCE and stores the dedicated credential with current-user DPAPI. Configure the model and enablement in **Agent → Configuration**.

For legacy or externally managed deployments:

```env
OPENROUTER_API_KEY=
RELAYBASE_AGENT_MODEL=
RELAYBASE_AGENT_ENABLED=1
RELAYBASE_AGENT_REMOTE_MODEL_ENABLED=1
```

Selected external files are validated and reloaded at each new run boundary, or explicitly from **Agent → Recovery**, without a daemon restart. Shell-owned startup values remain startup-only. Open `/settings agent` to inspect provider state, source health, revision, tool access, approvals, execution limits, and budgets. The settings and generic config API never accept a raw provider key.

See [Operator Agent](operator-agent.md).

## 8. Recover safely

Start with the read-only diagnosis:

```bash
relaybase check
```

It checks the TUI/toolchain, current project and daemon health, and registered app state. It does not start unknown apps, repair command links, or call a remote model.

Use `/daemon status` inside the console. `/daemon repair` can request a safe reconnect/start through the launch bridge. `/daemon restart` is a separate confirmation-gated replace/verify/restore workflow and is blocked while Agent, lifecycle, or package work is active.

See [Troubleshooting](troubleshooting.md) for symptom-specific recovery.

## Next references

- [Operator console](operator-console.md)
- [CLI reference](cli.md)
- [App manifest](app-manifest.md)
- [Docker Compose lifecycle](docker-compose-lifecycle.md)
- [Logs](logs.md)
- [MCP](mcp.md)
- [Security and limits](security-and-limits.md)
- [Complete documentation index](README.md)
