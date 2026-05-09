# Fallback Policy

Direct localhost ports are fallback only.

## Allowed Fallback Reasons

Use a direct port only when one of these is true:

- Relaybase discovery at `http://localhost:7777/.well-known/mcp.json` is unreachable.
- Relaybase is available but cannot route this app shape.
- The user explicitly requests a direct port.
- Relaybase itself is being debugged or changed.

## Required Report

When falling back, say:

```text
Relaybase fallback reason: <specific reason>.
Using direct port <port> for this run.
To return to Relaybase: <specific next step>.
```

Do not claim Relaybase success if only a raw direct port works.

## Verification

Relaybase success requires all applicable proof gates, not only one green signal:

- Discovery works.
- Token is present for mutations.
- Register succeeds or the existing registration is verified.
- Start returns `running` or a useful structured failure.
- Human route responds: `http://<app-id>.localhost:7777`, or agent header route responds: `http://127.0.0.1:7777` with `X-Relaybase-App: <app-id>`.
- Logs are available, preferably live.
- Stop returns `stopped`.
- The backend port is closed after stop when the port is known.
- Dashboard UI and `/api/status` match Relaybase state when a dashboard is involved.

Direct-port success is separate and must be labeled as fallback.

## Dashboard-Owned Pattern

A dashboard can own the visible control experience while Relaybase owns app processes. In that pattern:

- The dashboard may start Relaybase.
- The dashboard should register/start/stop/restart apps through Relaybase.
- The dashboard owns panels, buttons, logs UI, app list, Access App flow, and state rendering.
- The dashboard must not direct-spawn apps unless it has entered explicit fallback mode and reports why.

## Port Hygiene

- Avoid choosing random host ports while Relaybase is available.
- Prefer child MCP stdio for agent tools.
- Prefer Relaybase lifecycle over background shell servers.
- Stop fallback servers when done.

## Stale Runtime Checks

Before declaring fallback or a product bug:

- If browser/UI and edited dashboard files disagree, restart the dashboard runtime and re-check `/api/status`.
- If Relaybase behavior and edited Relaybase files disagree, restart Relaybase and re-check `/.well-known/mcp.json` plus `/__hub/api/apps`.
- Check port ownership and stale Node processes.
- On Windows, remember that sandbox `spawn EPERM` usually means execution context needs attention before code does.
