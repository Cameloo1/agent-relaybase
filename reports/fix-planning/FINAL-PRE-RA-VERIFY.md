# FINAL-PRE-RA-VERIFY

Date: 2026-06-02

Final status: `BLOCK_AI_AGENT_PROMPTS`

Mode: final pre-AI-agent readiness verification. No OpenRouter code, OpenAI
Agents SDK TypeScript code, Relaybase Operator Agent code, or future AI-agent
architecture work was implemented.

## Summary

The Go-capable Relaybase TUI foundation is now verified on this Windows host:
the TUI builds, Go tests pass, vet passes, deterministic snapshots pass, the
Node bridge launches the real built binary, and the TUI smoke/evidence harness
captures real rendered output for daemon connection, grouped frontend/backend
panes, preferences, slash/export/assistant confirmation gates, and no
destructive action before confirmation.

AI-agent prompts still remain blocked because the workspace hygiene gate fails.
The worktree contains the broad release-roadmap/source/TUI/report changes from
the release work and must be intentionally committed/staged or verified from a
clean disposable checkout before RA000 begins.

GoReleaser/checksum verification is still a release-track-only environment
blocker because GoReleaser is not installed locally.

## Evidence Inspected

- `AGENTS.md`
- `docs/relaybase-release-roadmap.md`
- `docs/tui-architecture.md`
- `reports/fix-planning/PRE-RA-FP007-pre-ai-agent-readiness-plan.md`
- `reports/fix-planning/PRE-RA-FIX007-pre-ai-agent-gate-results.md`
- `reports/fix-planning/PRE-RA-blocker-status.json`
- `reports/release-candidate/tui-evidence-report.md`
- `artifacts/tui-verification/pty-transcript.txt`
- `artifacts/tui-verification/tui-output.txt`
- `artifacts/tui-verification/state-before.json`
- `artifacts/tui-verification/state-after.json`
- `artifacts/tui-verification/preferences-before.json`
- `artifacts/tui-verification/preferences-after.json`
- `src/tuiBridge.ts`
- `scripts/tui-go.mjs`
- `scripts/tui-smoke.mjs`
- `tui/cmd/relaybase-tui/main.go`
- `tui/internal/tui/model/model.go`
- `tui/internal/tui/commands/commands.go`

## CodeGraph

| Command | Result |
| --- | --- |
| `codegraph-mcp agent-use status --repo . --json` | Failed because `codegraph-mcp` is not on `PATH`. |
| `C:\Users\wamin\Desktop\development\codegraph-mcp\target\release\codegraph-mcp.exe agent-use status --repo . --json` | Passed with claimable/current graph DB. Vector sidecar was stale after edits. |
| `...\codegraph-mcp.exe agent-use index --repo . --json` | Failed in sandbox with `Access is denied` writing the user-level CodeGraph publish-state file; escalation was rejected by policy. |
| `...\codegraph-mcp.exe agent-use context-pack --repo . --task "Run full Go-capable PRE-RA TUI verification and fix errors" --agent-json` | Passed from the claimable DB with fallback text evidence. |

## Command Results

`npm ci` was not run because this was not a clean-copy verification and the
workspace already had dependencies installed.

| Command | Result | Evidence |
| --- | --- | --- |
| `node --version` | Pass | `v24.15.0` |
| `npm.cmd --version` | Pass | `11.12.1` |
| `go version` | Pass | `go version go1.26.3 windows/amd64` after adding `C:\Program Files\Go\bin` to this shell `PATH`. |
| `go env GOVERSION GOOS GOARCH GOMOD GOMODCACHE` from `tui/` | Pass | `go1.26.3`, `windows`, `amd64`, `tui/go.mod`, `artifacts/go-mod-cache`. |
| `where.exe goreleaser` | Fail | No matching executable. |
| `npm.cmd run format:check` | Pass | Prettier reported all matched files use Prettier style. |
| `npm.cmd run lint` | Pass | ESLint completed with exit code 0. |
| `npm.cmd run typecheck` | Pass | TypeScript no-emit check completed with exit code 0. |
| `npm.cmd test` | Pass | Node test runner passed 113/113 tests. |
| `npm.cmd run test:jest` | Pass | 1 suite passed, 4 tests passed. |
| `npm.cmd run smoke` | Pass | Read-only health smoke returned expected `PROJECT_NOT_CONFIGURED` and `DAEMON_UNREACHABLE` diagnostics. |
| `npm.cmd run package:check` | Pass | Used workspace-local npm cache; current-platform TUI binary present in workspace and npm dry-run. |
| `npm.cmd run package:check:strict` | Pass | Current-platform TUI binary present in workspace and npm dry-run. |
| `npm.cmd run tui:doctor` | Pass | Doctor reported ready; Go, go-env, `tui/go.mod`, `tui/go.sum`, and package binary passed. |
| `npm.cmd run tui:build` | Pass | Built `bin/relaybase-tui/relaybase-tui-windows-amd64.exe`. |
| `npm.cmd run tui:test` | Pass | Go `test ./...` passed from `tui/`. |
| `npm.cmd run tui:vet` | Pass | Go vet passed from `tui/`. |
| `npm.cmd run tui:snapshot` | Pass | Deterministic view snapshots passed. |
| `npm.cmd run tui:race` | Unsupported environment | Wrapper reported `go: -race requires cgo`; direct wrapper capture showed `LASTEXIT:2`. This is not a pass. |
| `npm.cmd run tui:smoke` | Pass | TUI evidence report verdict `PASS`. |
| `npm.cmd run release:check` | Fail closed | GoReleaser missing; release-track-only after mandatory TUI gates pass. |
| `npm.cmd run verify:clean-worktree` | Fail | Dirty workspace; command printed exact paths and did not clean anything. |
| `git status --short` | Dirty | Modified tracked release work and many untracked source/docs/scripts/reports/TUI files. |

## Real Behavior Verification

| Required behavior | Result | Evidence |
| --- | --- | --- |
| `relaybase-tui` binary exists | Pass | `bin/relaybase-tui/relaybase-tui-windows-amd64.exe` built. |
| `relaybase tui` launches real binary through Node bridge | Pass | `npm.cmd run tui:smoke` bridge launch case passed. |
| `RELAYBASE_TUI_BIN` override works | Pass | Covered by Node bridge tests in `npm.cmd test`; smoke also sets `RELAYBASE_TUI_BIN` for bridge launch. |
| Missing binary diagnostic works | Pass | Covered by Node tests and package/smoke diagnostics. |
| TUI connects to a real daemon | Pass | `npm.cmd run tui:smoke` daemon connection case passed. |
| TUI daemon-unavailable diagnostic works | Pass | Direct TUI and bridge daemon-unavailable smoke cases passed. |
| Preference persistence is verified | Pass | Smoke wrote and compared `preferences-before.json` and `preferences-after.json`. |
| Slash destructive-action confirmation is verified | Pass | Smoke rendered `Confirm Action` for `/stop current`. |
| Export confirmation is verified | Pass | Smoke rendered `Confirm Action` for `/logs export pane`. |
| Deterministic assistant/command-bar confirmation is verified | Pass | Smoke rendered `Confirm Action` for `stop backend`. |
| No destructive command executes before confirmation | Pass | Smoke state-after kept both fixture apps running. |
| PTY transcript/screenshot/recording exists | Pass | `artifacts/tui-verification/pty-transcript.txt` contains rendered frame transcripts. VHS/asciinema were unavailable, so screenshot/recording is `not_available`. |
| Workspace ends clean except intentional reports/artifacts | Fail | `npm.cmd run verify:clean-worktree` failed. |
| GoReleaser/checksum verified or deferred | Deferred | `npm.cmd run release:check` failed closed because GoReleaser is not installed; FP007 allows release-track deferral once TUI gates pass. |

## Root Cause Classification

| Blocker | Severity | Classification | Current status |
| --- | --- | --- | --- |
| Go toolchain | P0 | Environment plus repo tooling | Fixed/verified for this session. |
| Packaged TUI binary | P0 | Packaging plus environment | Fixed/verified. |
| TUI checks unverified | P1 | Coverage plus environment | Fixed/verified, except race is honestly unsupported on this host. |
| TUI UX evidence missing | P1 | Evidence coverage | Fixed/verified by `npm.cmd run tui:smoke`. |
| GoReleaser missing | P2 | Release tooling plus environment | Deferred to release-track; still blocks final binary release. |
| Dirty workspace | P1 for AI-agent gate | Workspace hygiene | Still blocks AI-agent prompts. |

## Recommendation

`BLOCK_AI_AGENT_PROMPTS`

Do not start RA000, OpenRouter, OpenAI Agents SDK TypeScript, or Relaybase
Operator Agent prompts until the current release work is either intentionally
committed/staged or final verification is rerun from a clean disposable checkout.

Recommended next prompt:

```text
PRE-RA-WORKSPACE-HYGIENE-COMMIT-OR-CLEAN-BASELINE
```
