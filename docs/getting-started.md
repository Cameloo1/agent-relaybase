# Getting started

This guide takes a clean machine from the current source installation to a healthy app behind a stable Relaybase route.

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

On Windows PowerShell, use `npm.cmd` in place of `npm` if script execution policy blocks `npm.ps1`. `repair-prefix` explicitly links the checkout into npm's global command directory. If you prefer not to create that link, skip it and use `npm start` from the repository root whenever this guide says `relaybase start`.

The public `@cameloo/relaybase` npm package is not available yet. These source instructions remain canonical until the first signed release is published and independently verified.

## 2. Open the operator console

```bash
relaybase start
```

Relaybase starts its localhost daemon when safe and opens the terminal UI. If port `7777` is already occupied by a non-Relaybase process, startup fails with a recovery action instead of taking over the port.

## 3. Register a project

In another terminal, change to an application directory:

```bash
cd path/to/your-project
relaybase register . --plan
relaybase register .
```

Relaybase locates `relaybase.app.json`, validates and compiles its launch behavior, then previews the exact registry/file changes and lifecycle proof. When the manifest is missing, folder registration detects supported runtimes and previews the proposed manifest. It never writes or starts the app before approval.

After confirmation, quick verification performs one bounded start, health, stop, and backend-port closure check. Success means the app was healthy and is now stopped with its managed port closed. Starting the app for normal use remains a separate action.

Use a dry run when you only want the plan:

```bash
relaybase register . --plan
```

To register without a launch-readiness claim:

```bash
relaybase register . --no-verify
```

Use `relaybase configure` when you explicitly want the broader setup/repair wizard. In the TUI, `/add <folder>` is the simplest discovery flow and `/register <folder>` is the one-command registration coordinator.

## 4. Start or open the app

```bash
relaybase start <app-id>
```

Registration proof and normal running remain separate boundaries. Verification briefly runs and then stops the app; `start` is the explicit normal-running action. `relaybase open` remains the daily configure/start/readiness/browser convenience flow after you understand that it leaves the app running.

## 5. Inspect and recover

```bash
relaybase list
relaybase health
relaybase check
```

`list` shows registry and runtime state. `health` diagnoses the current project. `check` is the safe global first response when the daemon, TUI, route, or installation is unclear.

## Optional Operator Agent

No model provider is required for the flow above. To enable the optional Operator Agent, copy `.env.example` to `.env`, add an OpenRouter key and model, and explicitly enable the agent settings described in [Operator Agent OpenRouter setup](tui-agent-openrouter.md).

Model suggestions never bypass project-root grants, setup previews, or lifecycle approvals.
