# MVP Task Log

Completed task timestamps use local time.

- 2026-05-11 11:30:10 -05:00 - Implemented the shared Relaybase setup engine for project detection, setup architecture planning, guarded writes, registration, verification, recovery classification, setup reports, and launch profiles.
- 2026-05-11 11:30:10 -05:00 - Reworked the CLI public surface around the three main commands: `relaybase configure`, `relaybase open`, and `relaybase health`.
- 2026-05-11 11:30:10 -05:00 - Added MCP `configure_project` over the same setup engine with token-gated apply behavior.
- 2026-05-11 11:30:10 -05:00 - Added high-criteria tests for setup detection, multi-architecture planning, guarded env writes, read-only health diagnostics, live Relaybase open/start/route verification, launch failure classification, and MCP setup authorization.
- 2026-05-11 11:30:10 -05:00 - Updated README and package smoke workflow to document and exercise the three-command operator model.
- 2026-05-11 11:33:06 -05:00 - Added saved-answer replay and approved recovery-attempt plumbing so `configure` can reuse wizard decisions and try alternate setup architectures during repair/approved launch verification.
- 2026-05-11 11:34:14 -05:00 - Tightened env port detection so setup planning can offer pinned-upstream profiles from actual values such as `VITE_PORT=5173`.
- 2026-05-11 11:59:15 -05:00 - Implemented generic lifecycle hooks with `preStartCommand`, `stopCommand`, `verifyStoppedCommand`, per-hook timeouts, lifecycle phases, attempt metadata, cleanup status, source-labeled hook logs, secret redaction, and action fields for dashboards.
- 2026-05-11 11:59:15 -05:00 - Added lifecycle locking and stop correctness semantics so repeated starts are serialized, cleanup failures/timeouts/verify-stopped failures never report `stopped`, failed starts run cleanup hooks, and external upstream apps remain route-only unless they own cleanup.
- 2026-05-11 11:59:15 -05:00 - Added deterministic fake Compose-style lifecycle tests covering hook success, stop failure, stop timeout, verify-stopped failure, failed-start cleanup, repeated starts, external upstream stop semantics, and MCP/state metadata exposure.
- 2026-05-11 12:05:30 -05:00 - Polished release CI around a single `npm.cmd run verify` gate across Windows, macOS, and Linux, plus package artifact checks and focused lint/Jest/typecheck workflows.
- 2026-05-11 12:05:30 -05:00 - Polished package metadata so the npm artifact explicitly includes runtime, docs, examples, and the Relaybase Dev skill while excluding test and tracker-only files.
- 2026-05-11 12:05:30 -05:00 - Updated README, manifest convention docs, pre-production tracker, and Relaybase Dev skill references to match the three-command setup flow and lifecycle-hook boundary.
- 2026-05-11 12:09:11 -05:00 - Completed final local release verification with `npm.cmd run verify`, `npm.cmd run package:check -- --json`, and `git diff --check` before staging.
