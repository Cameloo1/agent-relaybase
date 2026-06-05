# Agent TUI Command Results

Status: BLOCK_AGENT_TUI_INTERFACE

## Summary

This AGENT-TUI-MATRIX-008 repair pass reran the required local interface checks, TUI build/smoke checks, package check, release config check, inventory generation, agent tests, live OpenRouter smoke attempt, and live command matrix evidence where available.

The gate is still blocked, but two previous local blockers are resolved. Core Node checks, package dry-run with a repo-local npm cache, TUI build, TUI test, TUI vet, TUI snapshot, TUI smoke, 8-pane smoke, agent unit tests, command inventory generation, release config validation, and artifact secret scan passed. The Windows Application Control `tui:test` failure is fixed by falling back from direct generated test-binary execution to real package-level `go test` when the direct executable spawn is denied. GoReleaser is now detected from `.codex-tools/bin` and `npm.cmd run release:check` passes. The live OpenRouter path remains unverified because escalation for a real external request was rejected by policy. Full live acceptance and live command matrix still require an approved live-network environment.

## Command Results

| Command | Result | Evidence |
| --- | --- | --- |
| `codegraph-mcp agent-use context-pack --repo . --task "AGENT-TUI-MATRIX-008 final interface verification gate" --agent-json` | PASS | CodeGraph claimable. |
| `node --version` | PASS | `v24.15.0`. |
| `npm --version` | FAIL | PowerShell blocked `npm.ps1`; `npm.cmd --version` returned `11.12.1`. |
| `go version` | PASS | `go version go1.26.3 windows/amd64`. |
| `go env` | PASS | Captured Go env; host `windows/amd64`, `CGO_ENABLED=0`. |
| `git status --short` | DIRTY | Existing dirty source/report files were present before this final gate. |
| `npm.cmd run format:check` | PASS | Prettier check passed. |
| `npm.cmd run lint` | PASS | ESLint passed. |
| `npm.cmd run typecheck` | PASS | TypeScript check passed. |
| `npm.cmd test` | PASS | 221/221 Node tests passed. |
| `npm.cmd run test:jest` | PASS | 1 suite and 4 tests passed. |
| `npm.cmd run smoke` | PASS WITH DIAGNOSTICS | Health command exited 0 and reported this repo checkout is not configured as an app and daemon is unreachable. |
| `npm.cmd run package:check` | PASS | Uses a repo-local package-check cache by default and verified the Windows TUI package binary. |
| `npm.cmd run release:check` | PASS | `.goreleaser.yml` validated with repo-local GoReleaser v2.16.0. |
| `npm.cmd run tui:doctor` | PASS | TUI doctor ready; Go, packaged TUI binary, and repo-local GoReleaser detected. |
| `npm.cmd run tui:build` | PASS | TUI binary built. |
| `npm.cmd run tui:test` | PASS | TUI Go tests passed; setupwizard package ran through real package-level `go test` after the execution-policy fallback. |
| `npm.cmd run tui:vet` | PASS | Go vet passed. |
| `npm.cmd run tui:snapshot` | PASS | Snapshot package passed. |
| `npm.cmd run tui:smoke` | PASS | TUI smoke verdict PASS. |
| `npm.cmd run tui:smoke:8pane` | PASS | 8-pane TUI smoke verdict PASS. |
| `npm.cmd run tui:race` | BLOCKED | `-race requires cgo`; with `CGO_ENABLED=1`, the host reports `C compiler "gcc" not found`. |
| `npm.cmd run agent:test` | PASS | 61/61 agent tests passed. |
| `npm.cmd run agent:smoke:openrouter` | BLOCKED | Escalation was rejected by policy for external OpenRouter context transmission. |
| `npm.cmd run agent:live:acceptance` | BLOCKED | TUI render and Python stdlib fixture passed; live model step returned `AGENT_PROVIDER_ERROR: Connection error`. |
| `npm.cmd run agent-tui:inventory` | PASS WITH GAPS | 166 rows generated: 135 covered, 11 partial, 20 unavailable; 13 rows still have missing/unlinked tests. |
| `npm.cmd run agent:live:command-matrix` | BLOCKED | Local diagnostic cases pass; RA013 live acceptance now reaches the model step and returns provider `Connection error`. |
| `node scripts\scan-agent-artifacts.mjs artifacts\agent-live artifacts\agent-live-smoke artifacts\tui-verification reports\agent` | PASS | 90 scanned files; no raw OpenRouter key, Relaybase auth value, authorization header, or high-confidence secret assignment found. |

## Optional Matrix Scripts

These package scripts are not present and therefore were not runnable as separate gates: `tui:input-stress`, `tui:menu-matrix`, `tui:navigation-matrix`, `agent:command-matrix`, `agent:setup-matrix`, `agent:approval-matrix`, and `agent:security-matrix`.

`agent:live:command-matrix` is present and failed as documented above.

## Required Artifact Status

| Artifact | Status |
| --- | --- |
| `reports/agent/interface-readiness.md` | Created by this gate. |
| `reports/agent/interface-known-issues.md` | Created by this gate. |
| `reports/agent-tui-command-results.md` | Created by this gate. |
| `artifacts/agent-tui-command-results.json` | Created by this gate. |
| `artifacts/tui-verification/pty-transcript.txt` | Present from TUI smoke. |
| `artifacts/tui-verification/grouped-8pane-transcript.txt` | Present from 8-pane smoke. |
| `artifacts/tui-verification/input-stress-transcript.txt` | Present as honest `not_available` artifact; no standalone input-stress script exists and TUI Go tests are host-blocked. |
| `artifacts/tui-verification/approval-transcript.txt` | Present as aggregate derived from real slash/export/assistant confirmation transcripts. |
| `artifacts/agent-live/audit-redaction-scan.txt` | Present and PASS. |

## Final Verification Assertions

| Assertion | Result | Notes |
| --- | --- | --- |
| Command inventory has zero undocumented supported actions | PARTIAL | Inventory generated, but 13 rows have missing/unlinked tests and 11 partial rows remain. |
| Slash matrix passes | PASS | Covered by `npm.cmd run tui:test`. |
| Deterministic assistant matrix passes | PASS | Covered by `npm.cmd run tui:test` and smoke evidence. |
| Live agent matrix passes or exact external blocker documented | BLOCKED | Provider/network policy blocker is exact after TUI render and Python dependency fixes. |
| Input stress passes | PARTIAL | Go input tests pass; no standalone input-stress transcript script exists. |
| Approval safety passes | PASS | Node agent approval tests pass; TUI tests and confirmation transcripts exist. |
| Setup matrix passes for Tier 1 runtimes | PARTIAL PASS | Node setup/runtime tests pass; live Python stdlib fixture is dependency-free; full live acceptance is provider-blocked. |
| Logs/export/redaction pass | PARTIAL PASS | Node export/redaction tests and artifact scan pass; full live acceptance is provider-blocked. |
| Menus are honest | PASS | TUI tests, smoke, and snapshots pass. |
| 8-pane navigation passes | PASS SMOKE | 8-pane smoke transcript exists and command passed. |
| 9+ pane navigation passes | PASS | Covered by `npm.cmd run tui:test`. |
| Daemon failure recovery understandable | PARTIAL PASS | Smoke and diagnostics exist; live provider-backed recovery flows still need an approved network environment. |
| No secret appears in artifacts | PASS | Artifact secret scan passed. |
| Workspace hygiene acceptable | BLOCKED | Worktree was already dirty and this gate generated reports/artifacts. |

## Final Status

BLOCK_AGENT_TUI_INTERFACE
