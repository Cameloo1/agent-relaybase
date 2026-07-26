# Agent-Driven Development

Relaybase is built for coding agents and human operators working in the same local environment. Agent work must preserve the normal user path, keep state inspectable, and leave recovery options clear.

## Operating Rules

- Use CodeGraph before editing and fail closed when CodeGraph is unavailable.
- Start from current repo truth: code, docs, tests, package scripts, and daemon behavior.
- Prefer small durable changes over broad rewrites.
- Keep lifecycle behavior in the daemon.
- Keep generated artifacts out of commits unless explicitly promoted.
- Never print or commit session tokens, env secrets, raw credentials, or unredacted exports.
- Produce acceptance evidence for every task.
- Stop after the requested task is complete.

## Boundaries

The daemon owns lifecycle, state, logs, routes, tokens, child MCP, preferences, diagnostics, and operations. Clients, dashboards, CLIs, and the TUI consume daemon surfaces.

Agents may inspect files, run tests, and edit requested source/docs. Agents must keep external actions behind approval gates:

- remote pushes and pull requests
- paid provider calls
- production systems
- destructive cleanup
- secret access or printing
- generated artifact promotion

## Evidence

Task closeout should name:

- files changed
- commands run
- checks passed, failed, or skipped
- acceptance evidence locations
- known risks or gaps

For planning or documentation tasks, evidence can be the created docs plus formatting/lint/typecheck/test results. For behavior tasks, evidence must include current runtime or test output that proves the behavior.

## Artifact Hygiene

Do not stage generated DBs, WAL/SHM files, benchmark payloads, raw logs, temporary reports, package tarballs, local caches, or diagnostic-only artifacts unless the user explicitly promotes them.

Reports under `reports/` are local by default unless a task names them as a stable public report or asks to promote them.
