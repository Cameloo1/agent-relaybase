---
name: relaybase-dev
description: Use when Codex is developing, running, previewing, debugging, or managing local apps and should use Relaybase as the primary lifecycle, routing, logging, and MCP surface, with direct localhost ports only as a documented fallback when Relaybase is unavailable, unsuitable, explicitly bypassed, or being debugged.
---

# Relaybase Dev

## Purpose

Use this skill to make Relaybase the shared local runtime source of truth for Codex-driven development. It keeps agents from scattering app processes across random ports, gives humans and agents stable routes, preserves logs/status/health in one place, and makes child MCP tools part of the app lifecycle instead of separate background services.

This helps developers make better decisions because every app run starts with the same questions: is Relaybase available, is there a manifest, is the app registered, did the Relaybase route actually respond, and is a direct-port fallback truly justified?

## Core Rule

Use Relaybase first for local app runtime work. Treat direct ports as fallback, not the default.

Before starting or previewing a local app, check Relaybase discovery:

```powershell
Invoke-RestMethod http://localhost:7777/.well-known/mcp.json
```

If available, prefer Relaybase MCP tools. If MCP tools are unavailable, use Relaybase CLI or HTTP through `scripts/relaybase-dev.ps1`.

## Workflow

1. Run `scripts/relaybase-dev.ps1 -Action preflight`.
2. Look for an existing `relaybase.app.json` in the app root. Preserve it as the source of truth.
3. If no manifest exists and the task requires running the app, create the minimum manifest with `ensure-manifest`.
4. Register the manifest, then start the app through Relaybase.
5. Verify success through Relaybase routing, not by claiming a raw port is alive:
   - Human route: `http://<app-id>.localhost:7777`
   - Agent route: `http://127.0.0.1:7777` with `X-Relaybase-App: <app-id>`
6. Use Relaybase logs and status for debugging before changing app code.
7. Use direct ports only when the fallback policy allows it. State the reason and how to return to Relaybase.

## Preferred Controls

Use MCP tools when they are available:

```text
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
.\scripts\relaybase-dev.ps1 -Action status
.\scripts\relaybase-dev.ps1 -Action register -ManifestPath .\relaybase.app.json
.\scripts\relaybase-dev.ps1 -Action start -AppId notes
.\scripts\relaybase-dev.ps1 -Action logs -AppId notes -Lines 100
.\scripts\relaybase-dev.ps1 -Action url -AppId notes
.\scripts\relaybase-dev.ps1 -Action stop -AppId notes
```

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

For agent-facing tools and data, prefer a child MCP `stdio` block instead of opening another app port.

Read `references/manifest-patterns.md` when creating or modifying manifests.

## Fallback Policy

Direct ports are allowed only when:

- Relaybase is unreachable and the task must continue.
- The app cannot reasonably run behind Relaybase.
- The user explicitly asks for a direct port.
- Relaybase itself is the thing being debugged.

When using fallback, say why Relaybase was skipped and what would restore Relaybase routing. Read `references/fallback-policy.md` for the exact wording and checks.

## Resources

- `scripts/relaybase-dev.ps1`: deterministic helper for preflight, manifest creation, registration, lifecycle, logs, and routes.
- `references/relaybase-contract.md`: endpoints, commands, MCP tools, auth, and routing contract.
- `references/manifest-patterns.md`: manifest examples and child MCP patterns.
- `references/fallback-policy.md`: direct-port fallback rules.
