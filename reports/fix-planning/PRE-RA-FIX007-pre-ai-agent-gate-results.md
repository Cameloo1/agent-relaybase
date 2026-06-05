# PRE-RA-FIX007 Pre-AI-Agent Gate Results

Date: 2026-06-02

Final status: `BLOCK_AI_AGENT_PROMPTS`

Mode: release-readiness gate execution. No OpenRouter, OpenAI Agents SDK
TypeScript, Relaybase Operator Agent, or future AI-agent implementation was
started.

## Summary

The mandatory Go/TUI gate was rerun after Go became available in this shell via
`C:\Program Files\Go\bin`. The TUI now builds, tests, vets, snapshots, launches
directly, launches through `relaybase tui`, connects to a real disposable
daemon, renders grouped frontend/backend panes, persists preferences, and
renders slash/export/assistant confirmation gates without executing destructive
actions before confirmation.

The gate still returns `BLOCK_AI_AGENT_PROMPTS` because the workspace hygiene
check fails on the broad current release work. GoReleaser is also missing, but
FP007 classifies that as release-track-only once mandatory TUI gates pass.

## Environment

| Item | Result |
| --- | --- |
| Node | `v24.15.0` |
| npm | `11.12.1` |
| Go | `go version go1.26.3 windows/amd64` |
| TUI module Go source of truth | `tui/go.mod` requires `go 1.25.0`; `.go-version` mirrors `1.25.0`. |
| GoReleaser | Missing; `where.exe goreleaser` returned no match. |
| OS context | Windows / PowerShell in `C:\Users\wamin\Desktop\development\relaybase` |

## Gate Results

| Command | Result |
| --- | --- |
| `node --version` | Pass |
| `npm.cmd --version` | Pass |
| `go version` | Pass |
| `go env GOVERSION GOOS GOARCH GOMOD GOMODCACHE` from `tui/` | Pass |
| `npm.cmd run format:check` | Pass |
| `npm.cmd run lint` | Pass |
| `npm.cmd run typecheck` | Pass |
| `npm.cmd test` | Pass, 113/113 |
| `npm.cmd run test:jest` | Pass, 1 suite / 4 tests |
| `npm.cmd run smoke` | Pass with expected read-only project/daemon diagnostics |
| `npm.cmd run package:check` | Pass |
| `npm.cmd run package:check:strict` | Pass |
| `npm.cmd run tui:doctor` | Pass |
| `npm.cmd run tui:build` | Pass |
| `npm.cmd run tui:test` | Pass |
| `npm.cmd run tui:vet` | Pass |
| `npm.cmd run tui:snapshot` | Pass |
| `npm.cmd run tui:race` | Unsupported host; direct wrapper returned `LASTEXIT:2` because race requires cgo |
| `npm.cmd run tui:smoke` | Pass |
| `npm.cmd run release:check` | Fail closed; GoReleaser missing |
| `npm.cmd run verify:clean-worktree` | Fail; dirty workspace |
| `git status --short` | Dirty |

## Evidence Artifacts

- `reports/release-candidate/tui-evidence-report.md` has verdict `PASS`.
- `artifacts/tui-verification/pty-transcript.txt` contains real rendered TUI
  frames.
- `artifacts/tui-verification/tui-output.txt` contains direct and bridge TUI
  output.
- `artifacts/tui-verification/state-before.json` and `state-after.json` show
  fixture app state before and after confirmation checks.
- `artifacts/tui-verification/preferences-before.json` and
  `preferences-after.json` verify preference persistence.

## Remaining Blockers

| Blocker | Classification | Repro |
| --- | --- | --- |
| Dirty workspace | Workspace hygiene | `npm.cmd run verify:clean-worktree`; `git status --short` |
| Missing GoReleaser | Release tooling/environment, release-track-only | `npm.cmd run release:check` |
| Race detector unavailable on this host | Environment/toolchain | `npm.cmd run tui:race`; requires cgo/C compiler support |

## Recommendation

`BLOCK_AI_AGENT_PROMPTS`

The TUI foundation is ready enough technically, but the pre-AI-agent gate still
requires a clean or intentionally staged/committed baseline. Next prompt:

```text
PRE-RA-WORKSPACE-HYGIENE-COMMIT-OR-CLEAN-BASELINE
```
