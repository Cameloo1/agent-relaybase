# Folder Start Known Issues

Generated: 2026-06-05

## P0/P1 Blockers

### BLOCK-OPENROUTER-LIVE-POLICY

- Classification: external provider / policy / environment.
- Severity: P0 for live readiness, not a local product-code failure.
- Repro command: `npm.cmd run agent:smoke:openrouter`
- Failed assertion: real OpenRouter smoke must complete against `google/gemini-3.1-flash-lite` before the live Operator Agent path can be claimed.
- Result: `OPENROUTER_AGENT_LIVE_SMOKE_FAILED: RA012D_READ_ONLY_APP_INVENTORY_FAILED: run status failed`
- Evidence: `artifacts/agent-live-smoke/agent-events.jsonl` records `AGENT_PROVIDER_ERROR: Connection error` for provider `openrouter`, model `google/gemini-3.1-flash-lite`.
- Escalated rerun: rejected by policy because the command would transmit Relaybase agent prompt context and workspace-derived state to OpenRouter.
- Likely responsible module: external network/policy boundary. Product modules involved only as callers: `src/agent/openrouterLiveSmoke.ts`, `src/agent/runtime.ts`, `src/agent/openrouterProvider.ts`.
- Recommended next prompt: run live OpenRouter gates from an approved environment that permits external provider calls with disposable Relaybase context.

### BLOCK-FOLDER-START-LIVE-PROVIDER

- Classification: external provider / policy / environment.
- Severity: P0 for final live folder-start proof, not a local product-code failure.
- Repro command: `npm.cmd run agent:live:folder-start`
- Failed assertion: live natural-language folder startup must use the real model path to drive setup preview, approvals, daemon setup/register/start, route/log proof, and repair behavior.
- Result: `BLOCKED_OPENROUTER_PROVIDER_CONNECTION: Connection error. detail={"provider":"openrouter","modelSlug":"google/gemini-3.1-flash-lite"}`
- Evidence: `reports/agent/folder-start-live-report.md`, `artifacts/agent-folder-start/live-results.json`, and `artifacts/agent-folder-start/approval-events.json`.
- Escalated rerun: rejected by policy because the verifier would transmit Relaybase agent prompt context and temp-project workspace-derived state to OpenRouter.
- Likely responsible module: external network/policy boundary. Product modules involved only as callers: `src/agent/liveFolderStart.ts`, `src/agent/runtime.ts`, `src/agent/openrouterProvider.ts`.
- Recommended next prompt: rerun the exact command in an approved external-provider environment; do not switch models, mock the model, or bypass approval gates.

### BLOCK-WORKTREE-HYGIENE

- Classification: workspace hygiene.
- Severity: P1 for release/readiness gate, not a product behavior failure.
- Repro command: `npm.cmd run verify:clean-worktree`
- Failed assertion: final readiness verification must have an expected clean or explicitly allowed worktree.
- Result: fails with `Relaybase worktree hygiene: dirty`.
- Evidence: dirty paths include accumulated docs, reports, scripts, TypeScript source, Go TUI source, tests, and new report artifacts.
- Likely responsible module: repository state, not runtime behavior.
- Recommended next prompt: classify the current dirty paths, stage/commit intentional implementation files, ignore or clean generated artifacts only with explicit approval, then rerun `npm.cmd run verify:clean-worktree`.

## Fixed During AGENT-FOLDER-START-007

### FIXED-TUI-SMOKE-SPAWN-UNKNOWN

- Classification: test harness / Windows environment handling.
- Symptom: `npm.cmd run tui:smoke` and `npm.cmd run tui:smoke:8pane` failed with `FAIL - smoke harness error` and note `spawn UNKNOWN`.
- Root cause: Windows app-control could block the repo-local compiled TUI binary before Node returned a normal child process; the smoke harness did not capture synchronous spawn errors or retry through the safe source-checkout `go run` path.
- Files changed: `scripts/tui-smoke.mjs`.
- Verification: both `npm.cmd run tui:smoke` and `npm.cmd run tui:smoke:8pane` now pass.

### FIXED-TUI-SMOKE-FALLBACK-TRANSCRIPT-PARSING

- Classification: test harness / evidence parser.
- Symptom: after fallback, evidence cases showed daemon connection, grouped panes, confirmations, and 8-pane details as failed even though transcripts contained those views.
- Root cause: evidence parser read only the first `STDOUT:` block, which belonged to the failed binary spawn attempt, not the go-run fallback.
- Files changed: `scripts/tui-smoke.mjs`.
- Verification: both TUI smoke reports now pass.

### FIXED-FOLDER-START-TUI-LAUNCH-FALLBACK

- Classification: live verifier harness / Windows environment handling.
- Symptom: `npm.cmd run agent:live:folder-start` failed before the provider call with `AGENT_FOLDER_START_TUI_RENDER_FAILED`.
- Root cause: the verifier forced `RELAYBASE_TUI_BIN` for bridge launches, preventing the Node bridge from using its built-in source-checkout fallback when Windows blocked the dev binary.
- Files changed: `src/agent/liveFolderStart.ts`.
- Verification: `npm.cmd run agent:live:folder-start` now reaches the OpenRouter provider call and blocks with the correct external-provider diagnostic.

## Non-Blocking Notes

- `npm.cmd run release:check` passed in this environment because GoReleaser is available/resolved.
- Video capture remains `not_available` when VHS/asciinema are absent; transcript artifacts are the evidence.
- `git status --short` also emits warnings about `C:\Users\wamin/.config/git/ignore` permission denial. The status command still returns the dirty path list.
