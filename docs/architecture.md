# Architecture

Relaybase is a local daemon plus app-owned configuration. The daemon owns lifecycle, routing, health proof, logs, state, and MCP access. Each app repo owns its code, start command, health route, environment, Docker files, and any app-specific cleanup.

MCP gives agents tools and data. Relaybase adds the missing process layer: stable app ids, stable localhost routes, a daemon registry, app lifecycle control, route verification, logs, and stop correctness.

## Ownership

Relaybase owns:

- app registration and daemon state
- durable app-package definitions and package-run state
- assigned backend ports
- app start, stop, restart, and health checks
- human and agent routing
- process logs
- app-state snapshots
- MCP lifecycle tools
- child MCP aggregation declared by app manifests
- stop cleanup and verification
- Agent configuration, threads, runs, approvals, tools, usage, and redacted audit state

The app repo owns:

- application code
- package scripts and runtime dependencies
- health endpoints
- environment values and secrets
- Docker Compose files, Dockerfiles, migrations, and seeds
- child MCP server implementation
- app-specific lifecycle hook behavior

Dashboards and other clients should consume Relaybase state and APIs instead of spawning app processes directly, unless they are explicitly running in a documented fallback mode.

## Runtime Pieces

- Daemon: serves the dashboard, HTTP API, proxy routes, MCP endpoints, WebSocket upgrades, and TCP tunnel handshakes.
- Operator console: the Go Bubble Tea client for help, settings, app/package management, logs, setup previews, approvals, and Agent conversations. It contains no lifecycle engine.
- Registry: stores registered manifests in Relaybase's state directory.
- Process manager: starts and stops app processes, captures logs, runs hooks, checks health, supervises child MCP servers, and verifies stop cleanup.
- Router: maps human routes like `<app-id>.localhost` and agent header routes using `X-Relaybase-App`.
- App state: combines manifest data, runtime state, backend-port checks, route health, readiness, logs, and action flags.
- Setup engine: powers `relaybase configure`, `relaybase open`, `relaybase health`, and MCP setup tools.
- Registration verification service: composes registry, launch compilation, process manager, health, stop verification, repairs, and bounded operation evidence. It never spawns, kills, probes, or writes setup files directly.
- Package service: stores ordered app bundles and orchestrates member starts through normal app lifecycle operations.
- Agent Gateway: owns OpenRouter/Agents SDK execution, registered Relaybase tools, canonical project grants, bounded execution and spend policy, approvals, SQLite threads/audits, usage, and redacted event/activity streams.
- Restart bridge: coordinates daemon preview, quiesce, owned-app stop, daemon replacement, new-instance verification, and app restoration outside the daemon being replaced.
- MCP layer: exposes Relaybase lifecycle tools, resources, prompts, and allowlisted child MCP capabilities.

## Request Paths

Human route:

```text
browser -> http://<app-id>.localhost:7777 -> Relaybase -> app backend
```

Agent route:

```text
agent -> http://127.0.0.1:7777 + X-Relaybase-App -> Relaybase -> app backend
```

MCP:

```text
MCP client -> relaybase mcp or /mcp -> Relaybase lifecycle tools -> daemon state
```

TCP:

```text
socket -> RELAYBASE-TCP <app-id> + session token preface -> Relaybase TCP proxy -> app backend
```

## Lifecycle

Apps start from `relaybase.app.json`. Relaybase uses `upstreamPort` when present; otherwise it assigns a backend port and injects `PORT`, `HOST`, `RELAYBASE_APP_ID`, and `RELAYBASE_BASE_URL`.

Start order:

1. Select or verify the backend port.
2. Run `preStartCommand` when present.
3. Spawn `command`.
4. Start declared child MCP servers.
5. Wait for `healthUrl` or a TCP port check.
6. Mark the app running only after health succeeds.

Stop order:

1. Stop accepting new child MCP calls.
2. Drain in-flight child MCP calls.
3. Stop child MCP servers.
4. Terminate the app process tree.
5. Run `stopCommand` when present.
6. Run `verifyStoppedCommand` when present.
7. Verify the owned backend port is closed.
8. Report stopped only when cleanup and verification pass.

If cleanup fails, verification fails, or an owned backend port remains open, Relaybase reports an errored runtime instead of pretending the app stopped cleanly.

## Registration verification

Registration apply first completes its approval-bound file and registry work. When the bound preview selected `quick`, the daemon-owned registration verification service then:

1. Re-reads the registered manifest and compiles the exact structured launch plan.
2. Checks cwd, executable availability, fixed-port conflicts, and proof identity.
3. Requests one bounded start through `ProcessManager`.
4. Uses the existing health primitive and at most three bounded localhost candidate probes.
5. Requests stop through `ProcessManager` after health success or terminal failure.
6. Requires stop and owned-port closure before reporting `registered_verified`.
7. Persists a bounded redacted `registration_verification` operation record.

The service retains five in-memory attempt summaries per app and rejects repetition of an already-failed launch-plan digest. Repairs remain preview-only until another explicit approval. Cleanup failure blocks repair and launch retries.

## Setup

`relaybase configure` detects project metadata, scripts, framework hints, env files, port-like env values, Compose files, MCP hints, monorepo hints, and likely health routes.

Current setup plans:

- `managed-web`
- `framework-port-flag`
- `pinned-upstream`
- `docker-compose`
- `static-preview`
- `mcp-only`

Setup writes are guarded and inspectable. A normal applied setup can write `relaybase.app.json` and files under `.relaybase/`, including launch profiles, setup answers, rollback data, setup reports, proof runs, MCP config, and generated Docker lifecycle files.

## App packages

An app package is a durable ordered list of registered app IDs. Package launch creates a package run and asks the normal process manager to start each eligible member; it does not introduce a second app process model.

Package edits and deletion are revision-bound. Deleting a package removes only its definition. It does not stop apps or remove their manifests, logs, operations, or historical run evidence.

Retry creates a new run for failed, skipped, or interrupted members. Abort prevents members that have not yet been enqueued from starting; it does not silently stop apps already started.

## Daemon restart

Daemon replacement is coordinated through the Node launch bridge because a daemon cannot prove its own successful replacement.

The current workflow:

1. Fetches a state- and instance-bound restart preview.
2. Blocks while Agent, lifecycle, or package work is active.
3. Quiesces new mutations.
4. Stops only Relaybase-owned app processes and records the restore list.
5. Preserves externally managed processes.
6. Shuts down the prepared daemon.
7. Starts and verifies a distinct daemon instance.
8. Restores previously running owned apps through normal lifecycle operations.
9. Writes a redacted restart report with per-app outcomes.

## Operator Agent

The Go TUI sends Agent messages and context to the daemon Agent Gateway. The daemon owns provider calls, prompt redaction, tool policy, project grants, approvals, execution/spend limits, run state, thread persistence, and audit records.

Read-only tools can inspect Relaybase state, operations, bounded redacted logs, and explicitly granted projects. Mutating tools become daemon approvals and execute only through existing lifecycle, setup, manifest, registry, export, browser, or clipboard primitives.

Agent threads, messages, runs, events, approvals, audits, and usage records are stored in `<state-dir>/agent/agent.sqlite`. TUI preferences do not serve as a transcript or approval store.
