# Relaybase MCP Manifest Convention

Relaybase app manifests remain backward compatible. MCP support is additive through optional `schemaVersion` and `mcp` fields.

## Shape

```json
{
  "schemaVersion": 1,
  "id": "example",
  "name": "Example App",
  "command": "npm.cmd run dev",
  "cwd": ".",
  "protocol": "http",
  "healthUrl": "/",
  "mcp": {
    "enabled": true,
    "children": []
  }
}
```

`schemaVersion` may be omitted for legacy manifests. If provided, it must be `1`.

## Child Transports

Stdio child:

```json
{
  "id": "tools",
  "transport": "stdio",
  "command": "node",
  "args": ["./mcp-server.js"],
  "cwd": ".",
  "expose": {
    "tools": ["search"],
    "resources": ["docs://index"],
    "prompts": ["debug"]
  }
}
```

Streamable HTTP child:

```json
{
  "id": "remote-tools",
  "transport": "streamable-http",
  "url": "http://127.0.0.1:4100/mcp",
  "legacySseUrl": "http://127.0.0.1:4100/sse",
  "expose": {
    "tools": ["query"],
    "resources": [],
    "prompts": []
  }
}
```

Legacy SSE child:

```json
{
  "id": "legacy-tools",
  "transport": "sse",
  "legacySseUrl": "http://127.0.0.1:4100/sse",
  "expose": {
    "tools": ["query"],
    "resources": [],
    "prompts": []
  }
}
```

Child `cwd` is resolved relative to the parent app `cwd`.

## Exposure Rules

Exposure uses exact allowlists only.

```json
{
  "expose": {
    "tools": ["search", "summarize"],
    "resources": ["docs://index"],
    "prompts": ["debug"]
  }
}
```

Relaybase does not support wildcard exposure in this milestone. If a child tool, resource, or prompt is not listed, Relaybase does not surface it.

## Namespacing

Child tools:

```text
<app-id>.<tool-name>
```

Child resources:

```text
relaybase://app/<id>/mcp/<resource-uri>
```

Child prompts:

```text
<app-id>.<prompt-name>
```

Relaybase generates these names in its MCP schema. Apps declare original child names only.

## Lifecycle Semantics

`start_app(id)` starts the app process and declared child MCP servers.

`stop_app(id)` stops accepting new child MCP tool calls, waits up to a fixed drain timeout for in-flight calls, then stops child MCP servers and the app process. The result includes per-child drain data.

Child crashes are logged and scheduled for exponential backoff restart. Child list-change notifications propagate upward to connected Relaybase MCP clients.

## Lifecycle Hooks

Apps can declare app-owned lifecycle hooks:

```json
{
  "preStartCommand": ".\\scripts\\relaybase-prestart.ps1",
  "command": ".\\scripts\\relaybase-start.ps1",
  "stopCommand": ".\\scripts\\relaybase-stop.ps1",
  "verifyStoppedCommand": ".\\scripts\\relaybase-verify-stopped.ps1",
  "preStartTimeoutMs": 120000,
  "startTimeoutMs": 600000,
  "stopTimeoutMs": 60000,
  "healthTimeoutMs": 30000
}
```

Relaybase runs these as generic local commands. Docker, Compose, database, and service-specific details remain in the app repo scripts. Relaybase records hook output, exit codes, timeouts, and cleanup status, then refuses to report `stopped` when cleanup or stop verification fails.

## App State Contract

Relaybase exposes standard app state for dashboards and agents. Consumers should use this contract instead of rebuilding lifecycle, readiness, log, and access logic for each app.

HTTP:

```text
GET /__hub/api/state
GET /__hub/api/apps/<id>/state
GET /__hub/api/apps/<id>/logs
GET /__hub/api/apps/<id>/logs/stream
```

MCP:

```text
configure_project(apply)
app_status(id)
health_check(id)
verify_app(id)
tail_logs(id, lines)
```

State fields include:

```text
id
name
registered
runtime.status
runtime.health
runtime.phase
runtime.canStart
runtime.canStop
runtime.canOpen
runtime.primaryAction
runtime.blockingReason
runtime.cleanupStatus
runtime.lastStartAttempt
runtime.lastStopAttempt
runtime.attemptHistory
runtime.pid
runtime.assignedPort
backendPortOpen
routeReachable
humanUrl
agentUrl
agentHeaders
logSnapshotUrl
logStreamUrl
recentLogs
lastError
readiness
stopVerification
mcpChildren
```

`readiness` includes a state, checked timestamp, bounded timeout, named checks, and a failure reason when Relaybase cannot prove the app is ready. Route reachability is checked through Relaybase routing, not by trusting the upstream port alone.

`stopVerification` records whether stop was attempted, the backend port that was checked, whether it remained open, and whether port closure was verified. A backend port that remains open after stop is a failed stop even if a wrapper process exited.

`cleanupStatus` records whether stop cleanup was not needed, pending, succeeded, failed, timed out, or failed verification. Dashboards should use `canStart`, `canStop`, `canOpen`, `primaryAction`, and `blockingReason` instead of inferring button state from raw process details.

`configure_project` uses the same setup engine as `relaybase configure`. Dry-run planning is allowed without mutation credentials; `apply: true` is a token-gated mutation because it may write project files, register apps, and launch verification.

## Dashboard-Owned Pattern

A dashboard may own the visible control surface: panels, buttons, app lists, logs UI, Access App flow, and state rendering.

Relaybase should own app lifecycle: register, start, stop, restart, readiness, route reachability, backend port checks, and process logs.

Dashboards should consume `/__hub/api/state`, `/__hub/api/apps/<id>/state`, and log stream URLs. They should not direct-spawn apps unless explicitly operating in documented fallback mode.

Frontend/backend log classification is dashboard responsibility. Relaybase emits process channels as `stdout`, `stderr`, and `system`.

## Local Security

Relaybase is local-only by default. Discovery advertises auth requirements, accepted token headers, active state directory, and the session-token path without exposing the token. If discovery is healthy but mutations return `UNAUTHORIZED_MUTATION`, verify that the client and the running Relaybase process use the same state directory.
