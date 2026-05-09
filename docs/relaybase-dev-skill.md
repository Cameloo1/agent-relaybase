# Relaybase Dev Skill

The repo-local Relaybase Dev skill lives at:

```text
skills/relaybase-dev/SKILL.md
```

It mirrors the global Codex skill used on this machine, but is checked into the Relaybase repo so future contributors and Codex sessions can inspect the operating model without depending on local memory.

## Purpose

Relaybase exists to make local app lifecycle a shared infrastructure layer instead of a pile of ad hoc terminal processes and random host ports. The skill turns that product intent into a repeatable Codex workflow:

- Check Relaybase before starting local app runtimes.
- Prefer manifests, lifecycle commands, stable routes, logs, routed health checks, and stop checks.
- Use child MCP stdio for agent-facing tools instead of opening another port.
- Treat direct ports as fallback, and require a clear reason when they are used.

This helps because AI-driven development can create many short-lived apps, helper servers, and debugging processes. If every agent picks its own port and background command, the machine becomes hard to reason about. Relaybase gives Codex one default path for running, inspecting, routing, and stopping apps.

The upgraded skill is meant to be an execution harness, not just an operator manual. It asks Codex to choose the owning surface before editing:

- App repo: manifest, startup command, health route, and app bugs.
- Relaybase repo: runtime/process/proxy/MCP/token/logging/lifecycle bugs.
- Dashboard repo: panels, buttons, app list, Access App flow, logs UI, and state rendering.

In the operations-dashboard pattern, a dashboard may start Relaybase and control apps through Relaybase. It should not direct-spawn apps unless it has explicitly entered fallback mode.

## How Devs Should Use It

When working in this repo or building an app that should run through Relaybase, point Codex at the repo-local skill:

```text
Use $relaybase-dev at skills/relaybase-dev to run this app through Relaybase with direct ports only as fallback.
```

For local manual checks, use the bundled helper:

```powershell
.\skills\relaybase-dev\scripts\relaybase-dev.ps1 -Action preflight
.\skills\relaybase-dev\scripts\relaybase-dev.ps1 -Action status
.\skills\relaybase-dev\scripts\relaybase-dev.ps1 -Action ensure-manifest -AppId notes -Name "Notes" -Command "npm.cmd run dev" -Cwd .
.\skills\relaybase-dev\scripts\relaybase-dev.ps1 -Action register -ManifestPath .\relaybase.app.json
.\skills\relaybase-dev\scripts\relaybase-dev.ps1 -Action start -AppId notes
.\skills\relaybase-dev\scripts\relaybase-dev.ps1 -Action url -AppId notes
.\skills\relaybase-dev\scripts\relaybase-dev.ps1 -Action route-check -AppId notes
.\skills\relaybase-dev\scripts\relaybase-dev.ps1 -Action stream-logs -AppId notes
.\skills\relaybase-dev\scripts\relaybase-dev.ps1 -Action verify -AppId notes -ManifestPath .\relaybase.app.json
```

## Decision Model

Use Relaybase when the task involves local app runtime, preview, routing, logs, health, or child MCP tools.

Use direct ports only when Relaybase is unreachable, unsuitable for the app shape, explicitly bypassed by the user, or being debugged itself. When fallback happens, say why and how to return to Relaybase.

Success means the Relaybase route works, routed health works, logs are available, stop returns stopped, and the backend port is closed after stop when a port is known. A raw direct port listening is not Relaybase success.

## Troubleshooting Model

The skill now treats these as first-class branches:

- Token mismatch: discovery can be healthy while mutations return `401 Unauthorized`; use `diagnose-token` and compare state dirs.
- Stale runtime: restart the dashboard when UI and edited dashboard files disagree; restart Relaybase when Relaybase behavior and edited Relaybase files disagree.
- Windows lifecycle: prefer `npm.cmd`, assume Windows PowerShell unless `pwsh` is verified, treat sandbox `spawn EPERM` as execution context first, and check stale Node processes before blaming product code.
- Stop correctness: use `check-stop` with a known backend port, and treat an open backend port after stop as failure.
