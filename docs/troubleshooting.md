# Troubleshooting

Run `relaybase check` before changing state. It reports the installation, TUI, daemon, current project, and app inventory without calling a remote model or starting unknown apps.

## `relaybase` is not recognized

From the Relaybase source checkout, explicitly create or repair the command link:

```bash
npm run relaybase -- repair-prefix
relaybase --version
```

On Windows PowerShell, use `npm.cmd` in place of `npm` if script execution policy blocks `npm.ps1`. If npm's global command directory is not on `PATH`, open a new terminal after linking or continue with `npm start` from the checkout. The public npm package is not available yet.

## The TUI binary is missing

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

Inside the operator console, `/daemon status` shows the current connection state. `/daemon repair` can request a safe reconnect or daemon start through the Node launch bridge. A TUI launched directly as the Go binary has no launch bridge and reports the exact `relaybase serve` recovery command instead of pretending it repaired the daemon.

## The daemon needs to be replaced

Use:

```bash
relaybase daemon restart
```

or review `/daemon restart` in the operator console.

The restart is blocked while an Agent run, lifecycle operation, or package run is active. After confirmation, Relaybase quiesces new mutations, stops Relaybase-owned apps, preserves externally managed processes, replaces and verifies the daemon instance, and restores previously running owned apps through normal lifecycle operations.

Review the per-app restore results and redacted restart report. A partially restored daemon is not a clean restart.

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

## Help or settings do not open

`?` and `/help` open searchable command help. `/settings` opens categorized settings, `/settings agent` opens the Agent page, and `/settings agent security` opens credential health and repair directly.

If another modal owns input, press `Esc` to return to the workspace and retry. If the daemon is offline, local Appearance and Interaction settings remain distinguishable from daemon-owned Agent configuration; Agent settings report the connection failure instead of saving a local substitute.

## Agent is disabled or unavailable

Core Relaybase and deterministic console commands do not require the Agent.

Open `/settings`, then **Agent**. Status keeps readiness, source health, credential connection, and runtime activity separate.

For the normal Windows path, open **Agent > Provider** and connect OpenRouter. The browser authorization returns to a one-use loopback callback owned by the daemon. If validation is unavailable, the credential remains `connected_unverified` and new remote runs stay blocked.

After connection, use **Agent > Security and credentials** for validation, protection status, migration, exact legacy-source cleanup, disconnect, provider revocation guidance, findings, and repair receipts. The same daemon doctor is available through `relaybase repair --agent-security`. Start with a local check; add `--online` only when you intend to contact OpenRouter. Use `--action <id> --plan` to inspect a bound repair, `--action <id> --yes` to apply it, and `--operation <id>` to resolve an uncertain result. Exit code `4` means the preview is stale and must be recreated.

If the daemon is unavailable, repair does not edit files directly. Start Relaybase through the existing launcher and retry. Shell-owned credentials cannot be removed from the parent shell by Relaybase: migrate first, remove the assignment from its owning shell/profile, then use the safe daemon restart flow. A local disconnect does not prove the OpenRouter key was revoked.

For the legacy environment-backed path, verify:

```env
OPENROUTER_API_KEY=
RELAYBASE_AGENT_MODEL=
RELAYBASE_AGENT_ENABLED=1
RELAYBASE_AGENT_REMOTE_MODEL_ENABLED=1
```

A key and model alone do not enable remote calls. Shell-provided changes require restart. An explicitly selected external file hot-reloads at the next new run or through **Agent > Configuration > Reload now**. Invalid external changes preserve the active revision, block new runs, and show a safe recovery diagnostic.

If a run is blocked:

- `AGENT_DISABLED`: enable the Agent explicitly.
- `AGENT_REMOTE_MODEL_DISABLED`: enable remote model use explicitly.
- `AGENT_CREDENTIAL_MISSING`: connect, migrate, or replace the credential.
- `AGENT_PROVIDER_KEY_UNVERIFIED`: retry validation or reconnect; Relaybase does not use it remotely yet.
- missing-model diagnostic: configure an exact tool-capable model slug.
- budget diagnostic: review `/usage` and the Agent budget settings.
- stale approval: regenerate and review the new preview.
- tool unavailable: inspect tool mode and the effective allowlist.

Relaybase does not create fake assistant output for a disabled, misconfigured, timed-out, out-of-budget, or failed provider run.

## A package run did not complete

Open `/packages` and inspect the member-level run state.

- Retry only failed or interrupted members.
- Abort only prevents members not yet enqueued from starting.
- Apps already started retain their normal app lifecycle.
- Deleting a package definition does not stop its apps.

Use `/manage` or normal lifecycle commands to stop apps intentionally.

## Agent transcript looks active after work stopped

Only authoritative model-processing state should shimmer. Tool execution, queued work, OAuth waiting, provider validation, settings saves, config reload, approval waiting, replay, reconnect, completed, failed, cancelled, offline, and closed-stream states are static.

Open the full Agent page with `F6`, inspect the latest run and operation result, and use `/daemon status` if the event stream is disconnected. Do not infer that work is still running from a stale text row alone.

## Report a problem

Include the Relaybase version, operating system, failing command, structured diagnostic code, and redacted output. Exclude tokens, `.env` contents, raw logs, database files, and private project source.
