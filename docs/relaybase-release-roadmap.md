# Relaybase Release Roadmap

This document is the planning source of truth for the official Relaybase release with a Bubble Tea TUI. It describes intended release work and acceptance gates. Current implemented behavior must be verified in code, tests, and audit evidence before any release claim is made.

## Product Goal

Ship the official Relaybase release as a local-first daemon with a Go Bubble Tea TUI that gives operators and coding agents a dependable control surface for app lifecycle, state, logs, diagnostics, preferences, and recovery.

## Architecture Invariant

The Node/TypeScript daemon owns lifecycle. The Go Bubble Tea TUI is a client.

Lifecycle rules, process spawning, stop verification, routing, token handling, child MCP supervision, log capture, persistence, and recovery logic stay in the daemon. The TUI may request actions through the API, subscribe to daemon state, render operation progress, and present approval or recovery choices.

## Phase Sequence

| Phase | Name                              | Scope                                                                                                                                                                 | Acceptance gate                                                                                                                           |
| ----- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| R000  | Lock roadmap and agent rules      | Create release roadmap, TUI architecture, API contract, keymap, testing strategy, agent rules, and phase-0 audit template.                                            | Required documents exist, no product behavior changed, discoverable checks ran or were documented unavailable.                            |
| R001  | Current-state audit               | Fill the phase-0 audit with current endpoints, CLI commands, state directory behavior, manifest schema, lifecycle, logs, MCP, dashboard, tests, packaging, and risks. | Audit evidence cites exact files, commands, outputs, and gaps without changing behavior.                                                  |
| R002  | Typed API schema and errors       | Add exportable daemon API types, normalized error envelopes, correlation IDs, and compatibility tests.                                                                | API schema compiles; normalized errors and correlation IDs are tested without breaking existing endpoints.                                |
| R003  | Async lifecycle operations        | Expose operation IDs and operation polling for start, stop, and restart while preserving synchronous compatibility.                                                   | TUI can request lifecycle mutations without blocking; operation success, failure, timeout, and conflicts are tested.                      |
| R004  | Global daemon event stream        | Add a single SSE event stream for daemon, app, lifecycle, route, log, export, and preference synchronization hooks.                                                   | TUI can subscribe to one stream, recover by refreshing state, and lifecycle/state/log events are tested.                                  |
| R005  | App groups and component metadata | Add component-as-app manifest metadata and grouped read models without rewriting daemon lifecycle ownership.                                                          | `/state` exposes groups/components; single-app compatibility, malformed metadata diagnostics, and aggregate status rules are tested.      |
| R006  | Durable log store                 | Add durable log append/query/rotation/retention/redaction foundation behind a `LogStore` abstraction.                                                                 | Logs survive store reopen, page older entries, redact secret-like values, and keep live stream compatibility.                             |
| R007  | Log export backend                | Implement redacted backend log exports for pane/app/group/page/all scopes with status, bundles, and event hooks.                                                      | Real `.log`, `.jsonl`, and `.zip` artifacts are generated and inspected in tests with redaction enabled by default.                       |
| R008  | Go Bubble Tea TUI skeleton        | Add contained Go TUI module, daemon client, event plumbing, diagnostics, theme system, and assistant bar shell.                                                       | TUI compiles where Go is available, fetches fake daemon state, shows unavailable-daemon diagnostics, and contains no lifecycle logic.     |
| R009  | Pane dashboard                    | Render grouped app/component panes with selection, focus, pages, pins, hidden panes, follow mode, scrollback, and log refresh.                                        | One-, two-, four-, and eight-pane layouts and pane state behaviors are covered by tests/goldens.                                          |
| R010  | Persistent TUI preferences        | Persist TUI-only theme, keymap, pane, layout, and assistant bar preferences under the Relaybase state directory.                                                      | Preferences survive restart, corrupt files are quarantined, atomic writes are used, and secret-like values are not stored.                |
| R011  | Context menus and slash commands  | Add contextual menus and deterministic slash commands with target resolution and confirmation gates.                                                                  | Menu actions and slash commands are tested; lifecycle/export actions call daemon APIs only after confirmation.                            |
| R012  | Deterministic natural assistant   | Map simple local natural-language phrases to the same slash-command pipeline with no network or LLM dependency.                                                       | Natural phrases parse deterministically; ambiguity is safe; lifecycle/export actions remain confirmation-gated.                           |
| R013  | Optional LLM assistant shell      | Add disabled-by-default provider config, privacy gates, prompt preview, tool proposal review, and audit metadata without real provider execution.                     | Deterministic remains default; remote mode requires explicit config; secrets are redacted; proposed mutations still require confirmation. |
| R014  | Packaging and release automation  | Package the Node daemon and Go TUI launch path with `relaybase tui`, binary build scripts, release artifact config, CI coverage, docs, and package smoke.             | Users have a real TUI launch command, release artifacts are defined, missing binary diagnostics are actionable, and checks are evidenced. |
| R015  | Final release gate                | Run final acceptance, docs truth check, artifact hygiene audit, and release readiness review.                                                                         | Release is approved only with current evidence, green checks, documented risks, and no unclaimable behavior or benchmark claims.          |

## Definition Of Done

A phase is done only when:

- The requested source, docs, scripts, tests, or packaging changes are complete and scoped to the phase.
- Product behavior claims are backed by current code, tests, logs, or artifacts from that phase.
- Existing tests/checks relevant to the touched surface have run, or an explicit blocker is recorded.
- Acceptance evidence includes exact commands, outputs or artifact paths, and any skipped checks with reasons.
- Generated DBs, raw logs, benchmark payloads, temporary reports, WAL/SHM files, and local diagnostic artifacts are excluded unless explicitly promoted.
- Worktree, secrets, production systems, paid provider routes, external actions, and remote pushes remain behind explicit approval gates.
- The TUI remains a client and no lifecycle logic has moved out of the daemon.

## Risk Register

| Risk                                          | Boundary                               | Mitigation                                                                                                            | Gate                 |
| --------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Lifecycle logic migrates into the TUI         | TUI implementation                     | Keep process, route, health, stop, child MCP, and token logic in the daemon; add tests that inspect TUI action paths. | R003, R008-R013      |
| Intended API docs drift from implemented API  | Documentation and daemon API           | R001/R002 audit must map every endpoint to verified current behavior before implementation claims.                    | R001-R002            |
| Logs, prompts, or exports leak secrets        | Logs, preferences, diagnostics, export | Redact by default, test secret-like strings, never print session tokens.                                              | R006-R007, R010-R013 |
| Long-running actions become uninspectable     | Daemon operations                      | Add operation ids, state transitions, recovery choices, retry/abort semantics, and audit trails.                      | R003, R007, R013     |
| Event stream drops leave stale UI state       | TUI client and daemon events           | Snapshot on reconnect, bounded staleness indicators, and headless reconnect tests.                                    | R004, R009           |
| Packaging changes break normal local workflow | CLI bridge and release package         | Use disposable install smoke tests and preserve existing CLI paths.                                                   | R014                 |
| Generated artifacts enter commits             | Git hygiene                            | Classify source/docs/tests separately from generated reports, DBs, logs, caches, and package payloads before staging. | Every phase          |
| Documentation overclaims readiness            | Public docs                            | Document only verified current behavior and label planning as intended until proven.                                  | Every phase          |
| CodeGraph is unavailable during agent work    | Agent governance                       | Fail closed before edits and record the blocker instead of guessing from text search alone.                           | Every phase          |
