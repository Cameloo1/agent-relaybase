---
name: relaybase-dev
description: Use when Codex is developing, running, previewing, debugging, or managing local apps and should use Relaybase as the primary lifecycle, routing, logging, and MCP surface, with direct localhost ports only as a documented fallback when Relaybase is unavailable, unsuitable, explicitly bypassed, or being debugged.
---

# Relaybase Dev

## Purpose

Use Relaybase as the shared local runtime source of truth for Codex-driven development. Relaybase owns process lifecycle, stable routes, logs, health, and child MCP aggregation so agents do not scatter half-built app processes across random ports.

Relaybase success is not proven when a raw localhost port responds. Success is proven only after routed access, routed health, logs, stop behavior, and backend-port closure are checked through Relaybase or a documented fallback is declared.

## Core Rule

Use Relaybase first for local app runtime work. Treat direct ports as fallback, not the default.

For ordinary app setup and launch, keep the public CLI path to three commands:

```powershell
relaybase configure
relaybase open
relaybase health
```

`configure` is the setup and repair wizard, `open` is the daily launch path, and `health` is read-only diagnosis. Lower-level lifecycle controls are still available through MCP, HTTP, and the helper when proof needs to be more granular.

Before starting, previewing, or debugging a local app runtime, check discovery:

```powershell
Invoke-RestMethod http://localhost:7777/.well-known/mcp.json
```

Prefer MCP tools when available. If MCP tools are unavailable, use Relaybase HTTP/CLI through `scripts/relaybase-dev.ps1`. If the helper is not in the current repo, use the global skill helper at `C:\Users\wamin\.codex\skills\relaybase-dev\scripts\relaybase-dev.ps1` or the repo-local helper at `skills\relaybase-dev\scripts\relaybase-dev.ps1`.

## Choose The Owner

Decide which surface owns the work before changing code:

- App repo owns the manifest, app startup command, app health route, app runtime bugs, and app logs emitted by the process.
- Relaybase repo owns runtime/process/proxy/MCP/token/logging/lifecycle bugs, route matching, child MCP supervision, and whether stop really closes the backend port.
- Dashboard repo owns visible panels, buttons, app lists, Access App flow, logs UI, status rendering, and whether UI state matches Relaybase state.
- Operations dashboard pattern: a dashboard may start Relaybase and control apps through Relaybase, but it must not direct-spawn apps unless it is explicitly in fallback mode.
- Docker or multi-service apps: the app repo owns Compose/service scripts, while Relaybase owns hook execution, state, logs, health proof, and stop correctness.

If ownership is unclear, inspect status/logs first, then choose the smallest owner that can explain the failure.

## Verification Gates

Run these gates before claiming the app is working:

1. Discovery works at `http://localhost:7777/.well-known/mcp.json`.
2. A token is present before mutation tools or HTTP mutation endpoints are used.
3. Register succeeds, using an existing `relaybase.app.json` when present.
4. Start returns `running` or a useful structured failure with `status`, `health`, and `lastError` when available.
5. Routed health works through `http://<app-id>.localhost:7777` or `http://127.0.0.1:7777` with `X-Relaybase-App: <app-id>`.
6. Logs are available; prefer live stream when supported and use snapshots as fallback.
7. Stop returns `stopped`.
8. The backend port is actually closed after stop when Relaybase exposes an assigned or upstream port.
9. If a dashboard is involved, the dashboard UI and `/api/status` must reflect the same state.

Use the helper proof chain when possible:

```powershell
.\scripts\relaybase-dev.ps1 -Action verify -AppId notes -ManifestPath .\relaybase.app.json
.\scripts\relaybase-dev.ps1 -Action check-stop -AppId notes
.\scripts\relaybase-dev.ps1 -Action route-check -AppId notes
```

## Workflow

1. Run `scripts/relaybase-dev.ps1 -Action preflight`.
2. Choose the owner: app repo, Relaybase repo, dashboard repo, or explicit fallback.
3. Look for an existing `relaybase.app.json` in the app root. Preserve it as the source of truth.
4. If no manifest exists and the task requires running the app, create the minimum manifest with `ensure-manifest`.
5. Register, start, check route, check logs, then stop and verify port closure when the task includes lifecycle proof.
6. Debug from Relaybase status/logs before changing app code.
7. Use direct ports only when the fallback policy allows it. State the reason and how to move back to Relaybase.

## Preferred Controls

Use MCP tools when they are available:

```text
configure_project
list_apps
app_status
health_check
register_app
start_app
stop_app
restart_app
tail_logs
app_url
```

When MCP tools are unavailable, use the bundled helper:

```powershell
.\scripts\relaybase-dev.ps1 -Action preflight
.\scripts\relaybase-dev.ps1 -Action diagnose-token
.\scripts\relaybase-dev.ps1 -Action status
.\scripts\relaybase-dev.ps1 -Action register -ManifestPath .\relaybase.app.json
.\scripts\relaybase-dev.ps1 -Action start -AppId notes
.\scripts\relaybase-dev.ps1 -Action stream-logs -AppId notes
.\scripts\relaybase-dev.ps1 -Action url -AppId notes
.\scripts\relaybase-dev.ps1 -Action verify -AppId notes
.\scripts\relaybase-dev.ps1 -Action stop -AppId notes
.\scripts\relaybase-dev.ps1 -Action check-stop -AppId notes
```

Docker-aware helper actions are available for Compose-backed apps, but they are supporting diagnostics rather than new public app commands:

```powershell
.\scripts\relaybase-dev.ps1 -Action docker-preflight -ManifestPath .\relaybase.app.json
.\scripts\relaybase-dev.ps1 -Action compose-detect -ManifestPath .\relaybase.app.json
.\scripts\relaybase-dev.ps1 -Action compose-status -ManifestPath .\relaybase.app.json
.\scripts\relaybase-dev.ps1 -Action compose-health -ManifestPath .\relaybase.app.json
.\scripts\relaybase-dev.ps1 -Action compose-logs -ManifestPath .\relaybase.app.json
.\scripts\relaybase-dev.ps1 -Action compose-cleanup -ManifestPath .\relaybase.app.json
.\scripts\relaybase-dev.ps1 -Action compose-verify-stop -ManifestPath .\relaybase.app.json
.\scripts\relaybase-dev.ps1 -Action docker-diagnose -ManifestPath .\relaybase.app.json
```

## Stale Runtime Branch

Treat stale processes as a first-class diagnosis branch:

- If browser/UI behavior disagrees with edited dashboard files, restart the dashboard runtime before debugging code.
- If Relaybase behavior disagrees with edited Relaybase files, restart Relaybase before debugging code.
- After restart, re-check `/api/status` for dashboards, `/__hub/api/apps` for Relaybase state, and `/.well-known/mcp.json` for discovery.
- Check port ownership and stale Node processes before declaring a product bug.

## Token Branch

Discovery can be healthy while mutations fail with `401 Unauthorized`.

- Run `diagnose-token` before mutations fail repeatedly.
- Check token path, token presence, state dir, and whether the helper uses the same `RELAYBASE_STATE_DIR` as the running Relaybase process.
- Do not print token contents unless the user explicitly asks.
- Report mismatch suspicion plainly, especially when discovery is healthy but register/start/stop/restart returns 401.

## Windows Runtime Branch

- Prefer `npm.cmd` over `npm` or `npm.ps1`.
- Assume Windows PowerShell unless `pwsh` is verified.
- Treat sandbox `spawn EPERM` as likely execution context first, not proof of code failure.
- `taskkill /t /f` may be needed for process trees.
- Check port ownership and stale Node processes before blaming Relaybase or the app.
- Generate manifests as UTF-8 without BOM.

## Manifest Guidance

Prefer a minimal manifest over ad hoc port selection:

```json
{
  "schemaVersion": 1,
  "id": "notes",
  "name": "Notes",
  "command": "npm.cmd run dev",
  "cwd": ".",
  "protocol": "http",
  "healthUrl": "/"
}
```

For agent-facing tools and data, prefer a child MCP `stdio` block instead of opening another app port. Read `references/manifest-patterns.md` when creating or modifying manifests.

For Docker Compose apps, prefer the generated `.relaybase/docker-profile.json` plus app-owned PowerShell hook scripts. Relaybase should not parse Compose inside the daemon or remove volumes by default. The detailed current contract is in `docs/docker-compose-lifecycle.md`.

## Fallback Policy

Direct ports are allowed only when:

- Relaybase is unreachable and the task must continue.
- The app cannot reasonably run behind Relaybase.
- The user explicitly asks for a direct port.
- Relaybase itself is the thing being debugged.

When using fallback, say why Relaybase was skipped and what would restore Relaybase routing. Read `references/fallback-policy.md` for exact wording and checks.

## Resources

- `scripts/relaybase-dev.ps1`: deterministic helper for preflight, token diagnosis, manifest creation, registration, lifecycle, route checks, logs, verification, and stop checks.
- `references/relaybase-contract.md`: endpoints, commands, MCP tools, auth, routing, and verification contract.
- `references/manifest-patterns.md`: manifest examples and child MCP patterns.
- `references/fallback-policy.md`: direct-port fallback rules and required reporting.
- `references/windows-runtime.md`: Windows process, token, stale-runtime, and port troubleshooting.
- `../../docs/docker-compose-lifecycle.md`: Docker Compose profile, generated hooks, diagnostics, and limits.
