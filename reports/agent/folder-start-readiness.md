# Folder Start Readiness

Generated: 2026-06-05

Final status: BLOCK_FOLDER_START_LOOP

## Summary

The local Relaybase folder-start foundation is passing: static checks, Node tests, Jest tests, Agent tests, Go TUI build/test/vet/snapshot, TUI smoke, 8-pane TUI smoke, package check, GoReleaser config check, and artifact secret scan all pass.

The final live natural-language folder-start loop remains blocked by external OpenRouter execution policy/network access. The sandboxed live provider path reaches the OpenRouter-backed Agent Gateway request and fails with `AGENT_PROVIDER_ERROR: Connection error` for `google/gemini-3.1-flash-lite`. Escalated live-provider reruns were rejected by policy because they would transmit Relaybase agent prompt context and temp-project workspace-derived state to OpenRouter.

Workspace hygiene also remains blocked because the repository is intentionally dirty with the accumulated TUI/Agent implementation work. This is not a product behavior failure, but it blocks a release-clean readiness claim until changes are staged/committed or verified from a clean checkout.

## CodeGraph

- Command: `codegraph-mcp agent-use status --repo . --json`
- Result: claimable, graph ready/current, candidate/vector sidecars stale but not blocking.
- Command: `codegraph-mcp agent-use context-pack --repo . --task "AGENT-FOLDER-START-007" --agent-json`
- Result: claimable; no exact graph proof path for this task, source/test evidence used.

## Repairs Made In This Gate

- `scripts/tui-smoke.mjs`
  - Fixed Windows smoke metadata to avoid bare `npm`.
  - Captured synchronous `spawn UNKNOWN` from Windows app-control instead of crashing the harness.
  - Retried TUI smoke launches through `go run ./cmd/relaybase-tui` when the repo-local built dev binary is blocked by Windows app-control.
  - Fixed transcript parsing to aggregate all `STDOUT`/`STDERR` sections so fallback output is evaluated.
- `src/agent/liveFolderStart.ts`
  - Stopped forcing `RELAYBASE_TUI_BIN` for bridge launches so the Node bridge can use its existing safe fallback path.
  - Added direct TUI render fallback to `go run ./cmd/relaybase-tui` when Windows app-control blocks the built dev binary.

## Command Results

| Command | Result | Notes |
| --- | --- | --- |
| `npm.cmd run format:check` | PASS | Prettier check passed. |
| `npm.cmd run lint` | PASS | ESLint passed. |
| `npm.cmd run typecheck` | PASS | TypeScript typecheck passed. |
| `npm.cmd test` | PASS | 234 tests passed. |
| `npm.cmd run test:jest` | PASS | 1 suite, 4 tests passed. |
| `npm.cmd run agent:test` | PASS | 71 tests passed. |
| `npm.cmd run tui:build` | PASS | Built current Windows TUI binary. |
| `npm.cmd run tui:test` | PASS | Go TUI tests passed. |
| `npm.cmd run tui:vet` | PASS | Go vet passed. |
| `npm.cmd run tui:snapshot` | PASS | TUI snapshot package passed. |
| `npm.cmd run tui:smoke` | PASS | Default TUI evidence passed after harness fallback/parser fix. |
| `npm.cmd run tui:smoke:8pane` | PASS | 8-pane TUI evidence passed after harness fallback/parser fix. |
| `npm.cmd run package:check` | PASS | npm package dry-run includes expected Windows TUI binary. |
| `npm.cmd run release:check` | PASS | `.goreleaser.yml` validated by GoReleaser. |
| `npm.cmd run agent:smoke:openrouter` | BLOCKED | Provider path reached; `AGENT_PROVIDER_ERROR: Connection error`. Escalated rerun rejected by policy. |
| `npm.cmd run agent:live:folder-start` | BLOCKED | TUI/daemon setup begins, then OpenRouter provider call blocks with `BLOCKED_OPENROUTER_PROVIDER_CONNECTION`. Escalated rerun rejected by policy. |
| `node scripts\scan-agent-artifacts.mjs artifacts\agent-folder-start reports\agent\folder-start-live-report.md` | PASS | 9 files scanned; no raw OpenRouter key, Relaybase token, bearer token, or secret assignment detected. |
| `npm.cmd run verify:clean-worktree` | BLOCKED | Worktree dirty with accumulated implementation/report files. |
| `git status --short` | DIRTY | Dirty paths listed in final terminal output and known-issues report. |

## Acceptance Checklist

| Requirement | Status | Evidence |
| --- | --- | --- |
| Natural-language path routes correctly | PASS locally / LIVE BLOCKED | Non-live tests pass; live model call blocked before tool execution. |
| Path normalization works | PASS locally | `AGENT-FOLDER-START-005` edge matrix covered Windows paths, relative paths, trailing prompt artifacts, spaces, traversal, missing paths. |
| Setup preview works | PASS locally / LIVE BLOCKED | Local setup/tool tests pass; live preview not reached because provider blocked. |
| Command hint and selected command persist into apply | PASS | `AGENT-FOLDER-START-002` tests passed inside `agent:test` and full `npm.cmd test`. |
| Approval gates work | PASS locally / LIVE BLOCKED | Agent/TUI tests and smoke confirmation evidence pass; live provider blocked before approvals. |
| Setup writes/registers only after approval | PASS locally | Agent/setup tests passed; no direct TUI writes added. |
| Daemon starts app | PASS locally | `AGENT-FOLDER-START-003`, integration, smoke, and TUI smoke passed. |
| Route/logs appear | PASS locally | TUI smoke and integration log/export tests passed. |
| Repair works or gives honest diagnostic | PASS locally | Repair matrix tests passed; live repair blocked before provider tool execution. |
| Repeated future start is fast | PASS locally | Already-registered start path covered by non-live folder-start tests. |
| TUI remains client only | PASS | No lifecycle/setup ownership moved into TUI. |
| No arbitrary shell tool | PASS | Tool registry tests passed; setup commands remain validated setup hints. |
| No secrets leak | PASS | Artifact scan passed and redaction tests passed. |
| Full live OpenRouter folder-start loop | BLOCKED | External provider policy/network blocked. |
| Clean release worktree | BLOCKED | Existing dirty worktree. |

## Root Cause Classification

- External provider/policy blocker: `agent:smoke:openrouter` and `agent:live:folder-start`.
- Workspace hygiene blocker: `verify:clean-worktree`.
- Product/test blocker fixed during this gate: TUI smoke harness Windows app-control fallback and transcript parsing.

## Blocking Failures

### BLOCK-OPENROUTER-LIVE-POLICY

- Repro command: `npm.cmd run agent:smoke:openrouter`
- Failed assertion: a real OpenRouter-backed Operator Agent request must complete against `google/gemini-3.1-flash-lite` before live folder-start behavior can be claimed.
- Actual result: provider execution reached the OpenRouter runtime path and failed with `AGENT_PROVIDER_ERROR: Connection error`; escalated rerun was rejected by policy because it would transmit Relaybase Agent Gateway context externally.
- Likely file/module: external provider or execution policy boundary; product callers are `src/agent/openrouterLiveSmoke.ts`, `src/agent/runtime.ts`, and `src/agent/openrouterProvider.ts`.
- Classification: external model/provider policy/network blocker.
- Recommended next prompt: rerun live OpenRouter smoke in an explicitly approved environment that permits disposable Relaybase Agent Gateway context to be sent to OpenRouter.

### BLOCK-FOLDER-START-LIVE-PROVIDER

- Repro command: `npm.cmd run agent:live:folder-start`
- Failed assertion: the live natural-language folder-start loop must reach setup preview, approval, daemon-owned setup/register/start, route, logs, and repair proof through the real model path.
- Actual result: daemon and TUI launch paths work, then the first live provider call blocks with `BLOCKED_OPENROUTER_PROVIDER_CONNECTION` for `google/gemini-3.1-flash-lite`.
- Likely file/module: external provider or execution policy boundary; product callers are `src/agent/liveFolderStart.ts`, `src/agent/runtime.ts`, and `src/agent/openrouterProvider.ts`.
- Classification: external model/provider policy/network blocker.
- Recommended next prompt: run `npm.cmd run agent:live:folder-start` in the same approved environment after `npm.cmd run agent:smoke:openrouter` passes; do not switch models, mock the model, or bypass approval gates.

### BLOCK-WORKTREE-HYGIENE

- Repro command: `npm.cmd run verify:clean-worktree`
- Failed assertion: final readiness verification must start and end with an expected clean or explicitly allowed worktree.
- Actual result: command fails with `Relaybase worktree hygiene: dirty`; `git status --short` lists accumulated intentional implementation/report paths and generated artifacts from prior work.
- Likely file/module: repository state and artifact hygiene, not runtime product behavior.
- Classification: workspace hygiene.
- Recommended next prompt: run a dedicated hygiene task to classify current dirty paths, stage/commit intentional source/docs/tests/reports, and ignore or clean generated artifacts only with explicit approval.

## Required Next Prompt

Use a clean or intentionally staged checkout, then run the live folder-start gate in an environment explicitly permitted to send disposable Relaybase Agent Gateway context to OpenRouter:

```powershell
npm.cmd run agent:smoke:openrouter
npm.cmd run agent:live:folder-start
node scripts\scan-agent-artifacts.mjs artifacts\agent-folder-start reports\agent\folder-start-live-report.md
npm.cmd run verify:clean-worktree
```

Do not claim `PASS_FOLDER_START_LOOP` until those live provider commands pass or are run in an approved environment and the worktree hygiene gate is resolved.
