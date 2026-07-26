---
name: relaybase
description: Use when Codex is developing, running, previewing, debugging, routing, inspecting, or stopping local apps and should use Relaybase as the primary MCP lifecycle, routing, logging, health, and child-tool aggregation surface. Trigger for Relaybase app workflows, MCP tool usability, stable localhost routes, token diagnostics, route health, stop verification, and direct-port fallback decisions.
---

# Relaybase

Use Relaybase as the shared local runtime source of truth before opening direct app ports. A working Relaybase path is proven by discovery, registration, routed health, logs, stop behavior, and backend-port closure when Relaybase owns the port.

## First Checks

Check discovery before starting or debugging a runtime:

```powershell
Invoke-RestMethod http://localhost:7777/.well-known/mcp.json
```

Prefer MCP tools when available:

```text
configure_project
list_apps
diagnose_token
app_status
health_check
verify_app
prove_app
register_app
start_app
stop_app
restart_app
tail_logs
log_stream_info
app_url
```

Mutation tools require the local Relaybase token. If discovery works but mutations fail, run `diagnose_token` and report state dir, token path, token presence, and mismatch suspicion without printing token contents.

## CLI Path

Keep the user-facing CLI path small:

```powershell
relaybase configure
relaybase open
relaybase health
relaybase list
```

When using the repo-local helper from the Relaybase repo root or from an app repo that contains the packaged skill files, prefer:

```powershell
.\skills\relaybase-dev\scripts\relaybase-dev.cmd -Action preflight
.\skills\relaybase-dev\scripts\relaybase-dev.cmd -Action verify -AppId <id> -ManifestPath .\relaybase.app.json
.\skills\relaybase-dev\scripts\relaybase-dev.cmd -Action check-stop -AppId <id>
```

Do not assume `.\scripts\relaybase-dev.cmd` exists from a repo root; the checked-in helper lives under `.\skills\relaybase-dev\scripts\`.

## Proof Contract

Before claiming success:

1. Discovery works.
2. Token is present before mutations.
3. Register succeeds or an existing registration is verified.
4. Start returns running, or a structured failure names the boundary.
5. Human route or agent header route reaches the app.
6. Logs are available; use `log_stream_info` for live stream details.
7. Stop returns stopped.
8. Backend port closes after stop when Relaybase owns it.

Use direct ports only when Relaybase is unreachable, unsuitable for the app, explicitly bypassed by the user, or Relaybase itself is being debugged. Say why fallback was used and how to return to Relaybase.

For detailed Windows, manifest, Docker, and fallback rules, read the compatibility skill at `../relaybase-dev/SKILL.md` and its `references/` files.
