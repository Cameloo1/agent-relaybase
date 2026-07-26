# TUI Testing Strategy

This strategy covers the release work for the Node/TypeScript daemon, Go Bubble Tea TUI, CLI bridge, packaging, and failure handling.

## Node Daemon Unit And Integration Tests

Daemon tests should cover API routing, auth, lifecycle operation creation, operation state transitions, state snapshots, event emission, log access, preferences, diagnostics, and redaction.

Integration tests should use disposable state directories and fake managed apps. They should verify start, stop, restart, route health, stop verification, child MCP drain, and structured failure responses.

## Go TUI Unit Tests

TUI unit tests should cover API client request building, response parsing, model initialization, stale-state flags, preferences loading, diagnostics display models, operation rendering, and redaction-safe formatting.

## Headless Bubble Tea Update Tests

Headless update tests should drive Bubble Tea messages without a real terminal. They must cover:

- arrow-key pane navigation
- PageUp/PageDown pane paging
- Enter focus behavior
- Esc return-to-dashboard behavior
- `f` follow mode
- `/` slash input
- Ctrl+Z contextual menu when supported
- Ctrl+O contextual menu fallback
- `?` help
- `q` quit flow

## Golden And Snapshot Rendering Tests

Golden rendering tests should snapshot stable terminal output for:

- empty dashboard
- app list with stopped, starting, running, unhealthy, errored, and conflict states
- app detail
- operation progress
- logs in follow and paged modes
- contextual menu
- help
- diagnostics
- daemon offline and stale-state views

Golden output should avoid host-specific paths unless the value is intentionally normalized.

## Daemon And TUI Smoke Tests

Smoke tests should start the daemon in a disposable state directory, launch the TUI against it, load app state, invoke a no-op or fake lifecycle operation through the daemon, display logs, and exit cleanly.

Smoke tests must prove the TUI uses daemon APIs rather than direct app process control.

## Log Durability Tests

Log tests should cover stdout, stderr, system events, bounded retention, paging cursors, event sequence numbers, daemon restart behavior when durability exists, and failure messages when durability is not available.

## Export And Redaction Tests

Export tests should include secret-like input values and prove exported logs, diagnostics, preferences, operation evidence, and errors do not reveal tokens, env secrets, or raw credential-like strings.

Exports should be operation-backed and token-gated.

## Packaging Smoke Tests

Packaging smoke tests should cover:

- TUI toolchain preflight with `npm run doctor:tui`
- package dry run
- installed CLI bridge
- daemon startup
- TUI binary discovery
- daemon/TUI version reporting
- route access
- log access
- lifecycle stop verification
- uninstall or cleanup of disposable install paths

## Chaos And Failure Tests

Chaos tests should cover:

- daemon unavailable before TUI start
- daemon dies while TUI is running
- event stream disconnects
- stale operation ids
- unauthorized mutation token
- app command failure
- health timeout
- backend port conflict
- stop hook failure
- stop verification failure
- child MCP drain timeout
- log export failure
- preferences write failure

Every chaos case should produce a clear owner, recoverability flag, safe details, and a visible TUI state.
