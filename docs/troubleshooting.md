# Troubleshooting

Run `relaybase check` before changing state. It reports the installation, TUI, daemon, current project, and app inventory without calling a remote model or starting unknown apps.

## `relaybase` is not recognized

Confirm npm's global binary directory is on `PATH`, then reinstall:

```bash
npm install --global @cameloo/relaybase
relaybase --version
```

Source contributors should use `npm start` from the repository instead of silently replacing the global command. Use `relaybase repair-prefix --diagnose` before any explicit prefix repair.

## The TUI binary is missing

For a normal npm installation, reinstall the package. The published tarball is required to contain all supported TUI binaries.

For a source checkout:

```bash
npm run doctor:tui
npm run tui:build
```

You can point `RELAYBASE_TUI_BIN` at a verified binary as an explicit override.

## The daemon is unavailable

```bash
relaybase serve
```

Then retry `relaybase start`. If another service owns port `7777`, stop that service or intentionally configure Relaybase on another port. Relaybase does not kill an unknown listener.

## The app starts but is not healthy

```bash
relaybase health
relaybase logs <app-id>
```

Check the app command, assigned port, health path, and recent redacted logs. A failed health check does not count as a successful start.

## The stable hostname does not work

Relaybase separately checks the human hostname route and the agent-header route. A `degraded` result means one works and one does not. Use the agent route while repairing local hostname resolution:

```text
http://127.0.0.1:7777
X-Relaybase-App: <app-id>
```

## Authentication or token mismatch

Use the state directory reported by `relaybase check`. Ensure the daemon and client use the same `RELAYBASE_STATE_DIR`. Do not paste token contents into terminals, logs, screenshots, issues, or support messages.

## Setup was blocked

Relaybase fails closed when a path is outside the folders explicitly granted by the user, a setup preview is stale, or files changed after approval. Re-select the folder, regenerate the preview, inspect the new diff, and approve again.

## Report a problem

Include the Relaybase version, operating system, failing command, structured diagnostic code, and redacted output. Exclude tokens, `.env` contents, raw logs, database files, and private project source.
