# Agent TUI Interface Known Issues

Status: BLOCK_AGENT_TUI_INTERFACE

## P0/P1 Blockers

| ID | Severity | Classification | Repro command | Failed assertion | Likely file/module | Recommended next prompt |
| --- | --- | --- | --- | --- | --- | --- |
| AGENT-TUI-MATRIX-008-BLOCKER-LIVE-PROVIDER-POLICY | P1 | model/provider | `npm.cmd run agent:smoke:openrouter` | Live OpenRouter smoke must pass or have an exact external blocker; sandbox run produced provider `Connection error` and escalation was denied by policy. | `src/agent/runtime.ts`, `src/agent/openrouterProvider.ts`, host network/policy | `AGENT-TUI-MATRIX-009 - rerun live OpenRouter smoke in an approved environment or explicitly accept provider policy as an external block.` |
| AGENT-TUI-MATRIX-008-BLOCKER-LIVE-ACCEPTANCE-PROVIDER | P1 | model/provider | `npm.cmd run agent:live:acceptance` | Full live acceptance must complete; current run reaches the live model step and returns `AGENT_PROVIDER_ERROR: Connection error`. | `src/agent/liveAcceptance.ts`, `src/agent/runtime.ts`, host network/policy | `AGENT-TUI-MATRIX-009 - rerun live acceptance in an approved OpenRouter network environment and close any model/tool failures that remain.` |
| AGENT-TUI-MATRIX-008-BLOCKER-LIVE-COMMAND-MATRIX | P1 | model/provider | `npm.cmd run agent:live:command-matrix` | Live command matrix must pass; current run reaches RA013 live acceptance and returns provider `Connection error`. | `src/agent/liveCommandMatrix.ts`, `src/agent/liveAcceptance.ts`, host network/policy | `AGENT-TUI-MATRIX-009 - rerun the live matrix in an approved OpenRouter network environment and close any model/tool failures that remain.` |

## P2/P3 Issues

| ID | Severity | Classification | Evidence | Recommendation |
| --- | --- | --- | --- | --- |
| AGENT-TUI-MATRIX-008-NPM-PS1 | P3 | environment | `npm --version` fails under PowerShell execution policy; `npm.cmd --version` works. | Keep Windows docs/commands using `npm.cmd`, or document PowerShell execution policy setup. |
| AGENT-TUI-MATRIX-008-NPM-CACHE-EPERM | P3 | environment/tooling | Fixed in this pass: `package:check` now uses a repo-local cache by default; final `npm.cmd run package:check` passed. | Keep the repo-local cache behavior and avoid relying on AppData npm cache for package dry-runs. |
| AGENT-TUI-MATRIX-008-GORELEASER | P2 | release tooling | Fixed in this pass: `.codex-tools/bin/goreleaser.exe` is detected by `tui:doctor`, and `npm.cmd run release:check` passes. | Keep repo-local GoReleaser documented and avoid requiring a global PATH edit. |
| AGENT-TUI-MATRIX-008-RACE-CGO | P2 | environment/toolchain | `npm.cmd run tui:race` returns documented unsupported-race exit code because `CGO_ENABLED=0`; with `CGO_ENABLED=1`, Go reports `C compiler "gcc" not found`. | Install a Windows C toolchain such as MSYS2/MinGW or run race in CI/WSL; do not claim race passed on this host. |
| AGENT-TUI-MATRIX-008-INVENTORY-GAPS | P2 | coverage | Inventory has 166 rows: 135 covered, 11 partial, 20 unavailable, and 13 rows with missing/unlinked tests. | Add direct tests or link existing tests for every flagged unavailable/partial diagnostic row. |
| AGENT-TUI-MATRIX-008-OPTIONAL-SCRIPTS | P2 | coverage/tooling | Dedicated scripts for input stress, menu matrix, navigation matrix, command/setup/approval/security matrices are not present. | Add wrapper scripts if these are required as independent gates instead of relying on `tui:test`, `agent:test`, and inventory rows. |
| AGENT-TUI-MATRIX-008-WORKTREE-DIRTY | P2 | workspace hygiene | `git status --short` was dirty before the gate and remains dirty after generated reports/artifacts. | Classify/stage/ignore/promote changes before claiming release-grade workspace hygiene. |

## Resolved In This Repair Pass

| ID | Prior severity | Evidence |
| --- | --- | --- |
| AGENT-TUI-MATRIX-008-BLOCKER-GO-TEST-APPCONTROL | P1 | `scripts/tui-go.mjs` now falls back from direct compiled test-binary `EACCES` to real package-level `go test` for normal tests. `npm.cmd run tui:test` passed. |

## Release-Track-Only

Full archive/checksum dry-run remains release-track-only for this interface gate unless the release gate explicitly requires `npm.cmd run release:dry-run`; the config validation path now passes locally through `npm.cmd run release:check`.

## External/Policy Blocks

The live OpenRouter escalation was rejected because it would transmit local Relaybase app inventory/current-folder/setup context to an external service. This gate did not attempt a workaround.
