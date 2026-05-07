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

Relaybase success requires one of:

- Human route responds: `http://<app-id>.localhost:7777`
- Agent header route responds: `http://127.0.0.1:7777` with `X-Relaybase-App: <app-id>`
- MCP `app_status` and `health_check` show the app running and healthy.

Direct-port success is separate and must be labeled as fallback.

## Port Hygiene

- Avoid choosing random host ports while Relaybase is available.
- Prefer child MCP stdio for agent tools.
- Prefer Relaybase lifecycle over background shell servers.
- Stop fallback servers when done.
