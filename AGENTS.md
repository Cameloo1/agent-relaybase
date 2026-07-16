# Relaybase Agent Rules

Use operator-grade engineering: boring primitives, sharp boundaries, explicit state, disposable workspaces, audit logs, recovery paths, approval gates, and workflows that preserve the user's normal path.

Bias toward shipped fixes over report volume: minimal local audit notes, more coding, targeted testing, and user-visible verification.

## Hard Rules

- No placeholders in shipped source, docs, tests, or reports. Fillable templates may have empty fields only when the task explicitly asks for a template.
- No fake tests, fake logs, fake benchmark results, or invented acceptance evidence.
- No lifecycle logic in the TUI.
- No secret leakage in logs, preferences, diagnostics, exports, reports, or final responses.
- Always produce acceptance evidence.
- Stop after task completion.

## Design Checks

Evaluate designs for:

- correct existing primitive
- explicit boundary or gate
- inspectable state
- pause, retry, skip, abort, and recovery paths
- real logs, artifacts, and timings
- protection for worktree, secrets, production, money, and external actions
- production-grade behavior, not demos

Prefer small durable components with clear contracts: services for long-running work, SQLite/Postgres for state, disposable worktrees for risky execution, strict approval gates, MCP/API surfaces for agent use, and raw evidence logs.

## Documentation Rules

- Document only current verified behavior and stable public reports.
- Label intended behavior as planning until it is implemented and verified.
- Exclude generated artifacts, local paths, raw logs, benchmark payloads, diagnostic-only data, and unclaimable results unless explicitly labeled and intentionally promoted.
- Do not claim intended-performance pass.
- Treat docs/text evidence as documentation support, not graph proof.

## Git And Artifact Hygiene

Before committing or pushing to remote/GitHub:

- Classify changes and publish only the appropriate staged subset or clean-worktree patch to each remote branch.
- Separate durable source/docs/scripts/tests from generated development artifacts.
- Never stage generated DBs, benchmark payloads, raw logs, temporary report artifacts, WAL/SHM files, target outputs, internal dev md files, or CGC payloads unless explicitly requested.
- Keep audit reports local unless promoted into stable public reports.
- Report excluded artifact categories before staging.

## Acceptance Evidence

Every completed task must report:

- exact files changed
- exact commands run
- tests/checks run or why they were unavailable
- product behavior changed or unchanged
- known gaps, risks, and follow-up gates
