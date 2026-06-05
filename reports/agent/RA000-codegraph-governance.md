# RA000 CodeGraph Governance

Generated: 2026-06-02

## Summary

CodeGraph is not claimable for RA000 on this workspace. RA000 is allowed to continue only as governance/docs/report work because the RA global addendum explicitly permits RA000 to document a non-claimable status and repair governance planning without product-code changes.

Product-code RA tasks remain blocked when CodeGraph is unavailable or non-claimable unless a future governance update explicitly defines a safe fallback procedure.

## Commands Run

| Command | Result |
| --- | --- |
| `codegraph-mcp agent-use status --repo . --json` | Failed: `codegraph-mcp` is not on PATH. |
| `C:\Users\wamin\Desktop\development\codegraph-mcp\target\release\codegraph-mcp.exe agent-use status --repo . --json` | Exit 0, non-claimable diagnostic status. |

## Direct Status Details

Observed direct status:

- `claimable: false`
- `graph_proof_available: false`
- `status: repo_head_mismatch`
- expected repo head: `1bd510f9bb518302aad6dad3a2b1af23adadd293`
- observed repo head: `a0e25e904e51eadf844b4bf246dd8973fb2b3d79`
- safety labels included `blocked`, `diagnostic_only`, `repo_head_mismatch`, `sidecar_only_change`, and `stale`
- candidate spool query index reported corrupt
- vector runtime was blocked by graph DB passport validation

## Claimable Definition

For Relaybase RA tasks, CodeGraph is claimable only when:

- `agent-use status --repo . --json` exits successfully
- `claimable` is true
- `graph_proof_available` is true
- repo head matches the current workspace head
- graph DB passport, schema, scope, and freshness checks pass
- no safety labels indicate stale, unsafe, blocked, candidate-only, or diagnostic-only graph use

Claimable CodeGraph permits product-code tasks to proceed after `context-pack` is collected for the specific task.

## Non-Claimable Definition

Non-claimable includes:

- repo head mismatch
- stale graph DB
- unsafe state
- candidate-only graph data
- missing graph proof
- corrupt candidate layers
- blocked vector runtime caused by invalid graph passport

Non-claimable CodeGraph blocks product-code edits. RA000 may document and update governance/docs because it is explicitly scoped to no product-code changes.

## Unavailable Definition

Unavailable means no callable CodeGraph `agent-use status` path exists after checking the task-provided command and any explicitly known local binary path. Unavailable CodeGraph fails closed for all edits, including governance edits, unless the user provides a new explicit instruction.

## AGENTS.md Resolution

`AGENTS.md` was updated to clarify that non-claimable CodeGraph blocks product-code tasks, while explicitly scoped governance/planning/documentation tasks may continue only by recording the diagnostic state. This preserves fail-closed behavior for unavailable CodeGraph.

## Required Gate For Future Product-Code RA Tasks

Before any product-code RA task:

1. Run CodeGraph status.
2. If claimable, run CodeGraph context-pack for the specific task.
3. If non-claimable, stop product-code work and report the blocker.
4. If unavailable, stop all edits and report the exact failure.

## Recovery

Recommended recovery path:

```powershell
codegraph-mcp agent-use index --repo . --json
codegraph-mcp agent-use status --repo . --json
codegraph-mcp agent-use context-pack --repo . --task "<task name>" --agent-json
```

If PATH remains unavailable but a local binary is intentionally provided, use that binary and record the PATH failure separately.
