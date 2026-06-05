# Agent TUI Interface Readiness

Final status: BLOCK_AGENT_TUI_INTERFACE

## Executive Summary

The Relaybase Agent TUI interface foundation is partially verified but not ready to claim a full pass.

What works in this gate:

- CodeGraph was claimable.
- Node formatting, linting, typecheck, Node tests, Jest tests, agent tests, TUI build, TUI tests, TUI vet, TUI snapshots, TUI smoke, 8-pane smoke, package dry-run with repo-local cache, release config check, inventory generation, and artifact secret scan passed.
- The package dry-run verified the Windows packaged TUI binary path.
- The TUI Go wrapper now falls back from direct Windows test-binary execution-policy `EACCES` to real package-level `go test`, and `npm.cmd run tui:test` passes on this host.
- GoReleaser is installed repo-locally under `.codex-tools/bin`, `npm.cmd run release:check` validates `.goreleaser.yml`, and `npm.cmd run tui:doctor` reports the repo-local GoReleaser path.
- TUI smoke evidence exists for daemon-unavailable, connected grouped panes, 8-pane panes, slash/export/assistant confirmations, preferences, state, and output.
- RA013 TUI smoke-render no longer hangs on connected daemons; smoke-render now avoids draining long-lived event-stream reads.
- No raw OpenRouter key, Relaybase auth value, authorization header, or high-confidence secret assignment was found in generated live/TUI artifacts.

What blocks the final interface pass:

- `npm.cmd run agent:smoke:openrouter` is not verified: the real OpenRouter request escalation was rejected by policy because it would transmit local Relaybase agent context externally.
- `npm.cmd run agent:live:acceptance` now reaches the real model step and is blocked by provider `Connection error` under the restricted network/policy environment.
- `npm.cmd run agent:live:command-matrix` now reaches RA013 live acceptance and is blocked by the same provider `Connection error`.
- `npm.cmd run tui:race` is honestly blocked on this Windows host because Go race tests require cgo and no C compiler is available; `CGO_ENABLED=1` repros as `C compiler "gcc" not found`.
- The inventory still has partial/unavailable rows and missing/unlinked tests.
- A dedicated input-stress script is not present, so input stress is not independently proven by a standalone transcript.
- The workspace was already dirty before this gate.

## Evidence Inspected

- `AGENTS.md` project rules through the active prompt context.
- CodeGraph context pack for `AGENT-TUI-MATRIX-008 final interface verification gate`.
- `package.json` scripts.
- `reports/agent-tui-command-matrix.md`.
- `artifacts/agent-tui-command-matrix.json`.
- `reports/release-candidate/tui-evidence-report.md`.
- `reports/release-candidate/tui-8pane-evidence-report.md`.
- `artifacts/tui-verification/*`.
- `artifacts/agent-live/*`.
- `artifacts/agent-live-smoke/*`.

## Commands Run

| Command | Result |
| --- | --- |
| `codegraph-mcp agent-use context-pack --repo . --task "AGENT-TUI-MATRIX-008 final interface verification gate" --agent-json` | PASS |
| `node --version` | PASS: `v24.15.0` |
| `npm --version` | FAIL: PowerShell blocked `npm.ps1` |
| `npm.cmd --version` | PASS: `11.12.1` |
| `go version` | PASS: `go version go1.26.3 windows/amd64` |
| `go env` | PASS |
| `git status --short` | DIRTY |
| `npm.cmd run format:check` | PASS |
| `npm.cmd run lint` | PASS |
| `npm.cmd run typecheck` | PASS |
| `npm.cmd test` | PASS: 221 tests |
| `npm.cmd run test:jest` | PASS: 4 tests |
| `npm.cmd run smoke` | PASS with honest project/daemon diagnostics |
| `npm.cmd run package:check` | PASS: repo-local package check cache verified and Windows TUI binary included |
| `npm.cmd run release:check` | PASS: `.goreleaser.yml` validated using repo-local GoReleaser v2.16.0 |
| `npm.cmd run tui:doctor` | PASS: Go, packaged TUI binary, and repo-local GoReleaser detected |
| `npm.cmd run tui:build` | PASS |
| `npm.cmd run tui:test` | PASS |
| `npm.cmd run tui:vet` | PASS |
| `npm.cmd run tui:snapshot` | PASS |
| `npm.cmd run tui:smoke` | PASS |
| `npm.cmd run tui:smoke:8pane` | PASS |
| `npm.cmd run tui:race` | BLOCKED: `-race requires cgo`; with cgo enabled the host reports missing `gcc` |
| `npm.cmd run agent:test` | PASS: 61 tests |
| `npm.cmd run agent:smoke:openrouter` | BLOCKED: real external OpenRouter request escalation rejected by policy |
| `npm.cmd run agent:live:acceptance` | BLOCKED: `AGENT_PROVIDER_ERROR` / `Connection error` at real model step |
| `npm.cmd run agent-tui:inventory` | PASS with inventory gaps |
| `npm.cmd run agent:live:command-matrix` | BLOCKED: RA013 live acceptance reached model step and returned provider `Connection error` |
| `node scripts\scan-agent-artifacts.mjs artifacts\agent-live artifacts\agent-live-smoke artifacts\tui-verification reports\agent` | PASS: 90 files scanned |

## Verification Matrix

| Requirement | Result | Evidence |
| --- | --- | --- |
| TUI binary exists | PASS | `bin/relaybase-tui/relaybase-tui-windows-amd64.exe` exists and package check passed. |
| `relaybase tui` bridge/package behavior | PARTIAL PASS | Package check and bridge tests pass in Node suite; live interactive bridge not independently rerun outside smoke. |
| Missing binary diagnostic | PASS | Covered by Node tests. |
| Command inventory | PARTIAL PASS | 166 rows generated; gaps remain. |
| Slash matrix | PASS | Covered by `npm.cmd run tui:test`. |
| Deterministic assistant matrix | PASS | Covered by `npm.cmd run tui:test` and smoke transcripts. |
| Chatbar input stress | PARTIAL | Go model/input tests pass, but no standalone transcript script exists. |
| Menu honesty | PASS | `npm.cmd run tui:test`, snapshots, and smoke evidence pass. |
| 8-pane navigation | PASS SMOKE | `npm.cmd run tui:smoke:8pane` passed and transcript exists. |
| 9+ pane navigation | PASS | Covered by `npm.cmd run tui:test`. |
| Approval safety | PASS | Node approval tests, TUI tests, and TUI confirmation transcripts pass. |
| Setup matrix Tier 1 | PARTIAL PASS | Node setup/runtime tests pass; live acceptance fixture blocked. |
| Logs/export/redaction | PARTIAL PASS | Node tests and secret scan pass; full live acceptance blocked. |
| Live OpenRouter path | BLOCKED | Provider connection error under sandbox; escalation rejected by policy. |
| Live command matrix | BLOCKED | Provider/network policy blocks the model step after local diagnostics pass. |
| Workspace hygiene | BLOCKED | Dirty worktree existed before this gate and reports/artifacts were generated. |

## Architecture Boundary

This repair pass changed daemon socket handoff, TUI smoke-render draining, package-check cache selection, Go test wrapper diagnostics, live fixture dependencies, and provider timeout handling. No lifecycle logic was moved into the TUI. No OpenRouter or SDK behavior was changed to bypass policy. No approval gate was weakened.

## Go/No-Go

No-go for `PASS_AGENT_TUI_INTERFACE`.

The recommended next prompt is:

`AGENT-TUI-MATRIX-009 - Resolve final interface gate blockers on a Go-test-capable and live-network-approved environment. Re-run npm.cmd run tui:test, npm.cmd run agent:smoke:openrouter, npm.cmd run agent:live:acceptance, and npm.cmd run agent:live:command-matrix. If the provider connection succeeds there, close any remaining live model/tool-call failures from current artifacts.`

## Final Status

BLOCK_AGENT_TUI_INTERFACE
