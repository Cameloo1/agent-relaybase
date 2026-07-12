# Getting started

This guide takes a clean machine from installation to a healthy app behind a stable Relaybase route.

## 1. Install Relaybase

Install Node.js 24 or newer, then run:

```bash
npm install --global @cameloo/relaybase
relaybase --version
```

The installation selects a prebuilt terminal UI package for Windows, macOS, or Linux on x64 or arm64. Go is required only for source development.

## 2. Open the operator console

```bash
relaybase start
```

Relaybase starts its localhost daemon when safe and opens the terminal UI. If port `7777` is already occupied by a non-Relaybase process, startup fails with a recovery action instead of taking over the port.

## 3. Configure a project

In another terminal, change to an application directory:

```bash
cd path/to/your-project
relaybase configure
```

Relaybase detects supported runtimes, proposes a setup plan, previews guarded writes, and asks before applying them. The resulting `relaybase.app.json` keeps command and route ownership explicit.

Use a dry run when you only want the plan:

```bash
relaybase configure --dry-run
```

## 4. Open the app

```bash
relaybase open
```

The command ensures the daemon, registers the manifest, starts the app, checks readiness, and opens the stable route when ready. It reports structured recovery choices when any phase fails.

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
