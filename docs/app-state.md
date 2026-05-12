# App State

Relaybase app state is the shared contract for dashboards, agents, and diagnostics. Consumers should read this state instead of rebuilding lifecycle rules for each app.

## HTTP Endpoints

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

Readiness is bounded. The app-state builder uses a default timeout budget of 8000 ms for its own readiness snapshot. A ready app must be running, have healthy runtime state, have an open backend port, and be reachable through the Relaybase route.

Readiness checks include:

- manifest registration
- runtime status
- runtime health
- backend port openness
- route reachability

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

Route reachability is checked through Relaybase routing. A route response with status `200` through `499` counts as reachable because it proves the router reached the app.

## Logs

`GET /__hub/api/apps/<id>/logs` returns the in-memory log snapshot.

`GET /__hub/api/apps/<id>/logs/stream` returns an SSE stream. Events include:

```text
status
snapshot
log
ping
```

Log events include app id, line, stream, source, sequence number, and timestamp. Stream values are `stdout`, `stderr`, and `system`.

Relaybase exposes process channels. Dashboard-specific labels such as frontend/backend grouping belong in the dashboard layer.

The process manager keeps the most recent 500 log lines and 500 structured log events per running entry.

## Stop Verification

Stop is successful only when Relaybase can finish the app's stop path. That can include child MCP drain, process termination, `stopCommand`, `verifyStoppedCommand`, and backend port closure when Relaybase owns the port.

`stopVerification` records:

- whether verification was attempted
- check timestamp
- backend port checked
- whether that port remained open
- whether port closure was verified
- overall success
- failure reason when present
- cleanup status
- stop hook attempt
- verify-stopped hook attempt
- child MCP drain results

An open owned backend port after stop is a failed stop, not a successful stopped state.
