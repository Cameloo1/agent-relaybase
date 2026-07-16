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

## Registration verification failed

Relaybase reports the failed boundary, whether the process is still running, whether a backend port remains open, a recommended repair, and a bounded redacted log excerpt or `View logs` action.

The normal repair order is:

1. Correct the health route when a bounded localhost candidate returned `2xx`.
2. Use an explicit structured host/port binding when the app ignored the managed port.
3. Use a pinned upstream port only when the runtime cannot accept dynamic binding.

Every repair is preview-only until separately confirmed. A confirmed repair creates a new verification attempt; Relaybase does not silently cycle through commands or rewrite the manifest.

Use `relaybase register <folder> --no-verify` only when you accept a registered-but-unverified result.

## Registration cleanup failed

Do not retry verification while Relaybase reports `registered_cleanup_failed`. Use `View logs`, retry the stop action, or identify the remaining backend-port owner. `Keep registered without verification` and further launch retries remain blocked until cleanup is resolved.

## The stable hostname does not work

Relaybase separately checks the human hostname route and the agent-header route. A `degraded` result means one works and one does not. Use the agent route while repairing local hostname resolution:

```text
http://127.0.0.1:7777
X-Relaybase-App: <app-id>
```

## Authentication or token mismatch

Run `relaybase diagnose-token`, then use the reported client and daemon state directories to correct `RELAYBASE_STATE_DIR`. Do not paste token contents into terminals, logs, screenshots, issues, or support messages.

## Setup was blocked

Relaybase fails closed when a path is outside the folders explicitly granted by the user, a setup preview is stale, or files changed after approval. Re-select the folder, regenerate the preview, inspect the new diff, and approve again.

## Report a problem

Include the Relaybase version, operating system, failing command, structured diagnostic code, and redacted output. Exclude tokens, `.env` contents, raw logs, database files, and private project source.
