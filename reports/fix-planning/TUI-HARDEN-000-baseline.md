# TUI-HARDEN-000 Baseline

Generated: 2026-06-02T09:53:23-05:00

## Summary

This baseline refreshed the Relaybase TUI hardening gate using direct source inspection and test evidence. CodeGraph was available but non-claimable, and the required one-time index attempt failed with an AppData publish-state permission error. Per the TUI-HARDEN-000 task override, this CodeGraph failure is recorded as a tooling/environment blocker and did not stop direct inspection or baseline checks.

No product behavior was intentionally changed. The required TUI smoke command refreshed the timestamp in `reports/release-candidate/tui-evidence-report.md`.

## Evidence Inspected

- `AGENTS.md`
- `docs/tui-architecture.md`
- `docs/tui-keymap.md`
- `reports/release-candidate/tui-evidence-report.md`

## CodeGraph Status

- Binary: present at `C:\Users\wamin\Desktop\development\codegraph-mcp\target\release\codegraph-mcp.exe`
- Status command: `C:\Users\wamin\Desktop\development\codegraph-mcp\target\release\codegraph-mcp.exe agent-use status --repo . --json`
- Claimable: false
- Status: `repo_head_mismatch`
- Graph proof available: false
- Reported mismatch: expected `1bd510f9bb518302aad6dad3a2b1af23adadd293`, observed `a0e25e904e51eadf844b4bf246dd8973fb2b3d79`
- Additional status notes: candidate spool/query index reported corrupt; repo `.codex/config.toml` reported invalid but not required.

## CodeGraph Index Attempt

Command:

```powershell
C:\Users\wamin\Desktop\development\codegraph-mcp\target\release\codegraph-mcp.exe agent-use index --repo . --json
```

Result: failed.

Exact failure:

```text
agent-use publish state could not be written at C:\Users\wamin\AppData\Local\CodeGraphMCP\agent-indexes\relaybase-c8e9292029cb6a6db0da7df526d5f697\production-agent-use.publish-state.json: Access is denied. (os error 5)
```

Classification: environment/tooling blocker. It blocks graph-proof claims, but this task chain allows direct inspection and tests to proceed.

## Working Tree Status

Initial command:

```powershell
git status --short
```

Initial result: no dirty paths were printed. Git emitted this warning twice:

```text
warning: unable to access 'C:\Users\wamin/.config/git/ignore': Permission denied
```

Post-check status after the required smoke run:

```text
 M reports/release-candidate/tui-evidence-report.md
```

Reason: `npm.cmd run tui:smoke` refreshed the evidence report generated timestamp. `git diff --stat` showed one file changed with one insertion and one deletion.

## Command Results

### TUI Go Tests

Command:

```powershell
npm.cmd run tui:test
```

Result: failed with an actionable missing-Go diagnostic.

Important output:

```text
relaybase tui test: Go 1.25.0 is required but go was not found on PATH.
Failed toolchain probe: go version
Install Go 1.25.0. Use https://go.dev/dl/ or an approved package manager, then open a new terminal so PATH is refreshed.
Verify with: go version
Release verification must also capture: go env GOVERSION GOOS GOARCH GOMOD GOMODCACHE
Blocked TUI scripts until Go is available: npm run tui:build, npm run tui:test, npm run tui:vet, npm run tui:race, npm run tui:snapshot
Then run: npm run tui:test
```

Classification: environment blocker. The script produced a clear diagnostic instead of raw `spawnSync go ENOENT`.

### TUI Smoke

Command:

```powershell
npm.cmd run tui:smoke
```

Result: passed.

Important output:

```text
Relaybase TUI smoke verdict: PASS
Evidence report: C:\Users\wamin\Desktop\development\relaybase\reports\release-candidate\tui-evidence-report.md
```

Current evidence report status:

- Verdict: PASS
- Binary exists: true
- Direct launch: passed
- Bridge launch: passed
- Daemon connection: passed
- Grouped panes: passed
- Preferences: passed
- Slash confirmation: passed
- Export confirmation: passed
- Assistant confirmation: passed
- No destructive action before confirmation: passed
- Recording: `not_available`

### Node Test Suite

Command:

```powershell
npm.cmd test
```

Result: passed.

Important output:

```text
tests 113
pass 113
fail 0
duration_ms 43985.3831
```

Notes: The suite intentionally printed missing-GoReleaser, missing-Go snapshot, and unsupported race diagnostics from wrapper tests. Those diagnostics were covered by passing tests and should not be reported as release-tool success.

## Whether Edits May Proceed

Edits may proceed for the TUI-HARDEN task chain using direct source inspection, current tests, generated evidence, and git status because the user explicitly removed CodeGraph as a blocker for this chain. CodeGraph remains unavailable for graph-proof claims until its AppData publish-state permission issue is fixed.

## Current Blockers

- Go is not on PATH in this terminal, so `npm.cmd run tui:test` cannot run Go tests.
- CodeGraph is non-claimable and cannot index due an AppData publish-state permission error.
- Git emits a user-level ignore permission warning for `C:\Users\wamin/.config/git/ignore`.
- Video/screenshot recording remains `not_available`; transcript evidence exists.

## Product Behavior

No product behavior changed in this task. Only baseline evidence/reporting was produced, and the required smoke command refreshed the TUI evidence report timestamp.
