# App State

Relaybase app state is the shared contract for dashboards, agents, and diagnostics. Consumers should read this state instead of rebuilding lifecycle and readiness rules.

## HTTP Endpoints

Read-only endpoints:

```text
GET /__hub/api/state
GET /__hub/api/apps
GET /__hub/api/apps/<id>/state
GET /__hub/api/apps/<id>/logs
GET /__hub/api/apps/<id>/logs/stream
```

Mutation endpoints:

```text
POST /__hub/api/apps/register
POST /__hub/api/apps/<id>/start
POST /__hub/api/apps/<id>/stop
POST /__hub/api/apps/<id>/restart
```

Mutations require the local token through `Authorization: Bearer <token>` or `x-relaybase-token: <token>`.

## State Shape

The app-state contract includes:

```text
id
name
registered
runtime
backendPort
backendPortOpen
routeReachable
routeHealth
humanUrl
agentUrl
agentHeaders
logSnapshotUrl
logStreamUrl
recentLogs
lastError
readiness
canStart
canStop
canOpen
primaryAction
blockingReason
stopVerification
mcpChildren
```

Important runtime fields:

```text
runtime.status
runtime.health
runtime.phase
runtime.pid
runtime.assignedPort
runtime.startedAt
runtime.stoppedAt
runtime.lastError
runtime.logLines
runtime.canStart
runtime.canStop
runtime.canOpen
runtime.primaryAction
runtime.blockingReason
runtime.cleanupStatus
runtime.lastStartAttempt
runtime.lastStopAttempt
runtime.attemptHistory
runtime.mcpChildren
runtime.mcpDrain
runtime.stopVerification
```

Runtime status values:

```text
stopped
starting
running
stopping
errored
conflict
```

Runtime health values:

```text
unknown
healthy
unhealthy
```

Lifecycle phases include:

```text
stopped
prestarting
building
launching
waiting_for_health
running
stopping
cleanup_failed
stop_verification_failed
errored
conflict
```

## Readiness

Readiness states:

```text
unregistered
stopped
starting
ready
unhealthy
failed
```

A ready app must be running, have healthy runtime state, have an open backend port, and be reachable through Relaybase routing. The app-state builder uses a bounded readiness snapshot so clients do not hang indefinitely.

If Relaybase cannot prove readiness, the state includes a failure reason.

## Routes

Human URL:

```text
http://<app-id>.localhost:<hub-port>
```

Agent URL:

```text
http://<hub-host>:<hub-port>
```

Agent header:

```text
X-Relaybase-App: <app-id>
```

`routeReachable` is true when Relaybase proves at least one route path reaches the app. `routeHealth` gives the stronger route diagnosis:

```text
routeHealth.status       full | degraded | failed | unknown
routeHealth.ok           true when at least one route path works
routeHealth.policy       human-or-agent
routeHealth.humanRoute   status for the .localhost route
routeHealth.agentRoute   status for the X-Relaybase-App route
```

`full` means both human and agent routes worked. `degraded` means exactly one route worked. `failed` means neither route worked.

A route response with status `200` through `499` counts as reachable because it proves Relaybase reached the app.

## Logs

`GET /__hub/api/apps/<id>/logs` returns the in-memory log snapshot.

`GET /__hub/api/apps/<id>/logs/stream` returns an SSE stream with these event types:

```text
status
snapshot
log
ping
```

Log events include app id, line, stream, source, sequence number, and timestamp. Stream values are `stdout`, `stderr`, and `system`.

Relaybase keeps the most recent 500 log lines and 500 structured log events per running entry.

## Stop Verification

Stop succeeds only when Relaybase finishes the app's stop path. That can include child MCP drain, process termination, `stopCommand`, `verifyStoppedCommand`, and backend port closure when Relaybase owns the port.

`stopVerification` records whether verification ran, the checked backend port, whether that port remained open, overall success, failure reason, cleanup status, hook attempts, and child MCP drain results.

An open owned backend port after stop is a failed stop, not a successful stopped state.
