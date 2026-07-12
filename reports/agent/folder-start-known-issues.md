# Folder Start Known Issues

Generated: 2026-06-25

## Current Status

No current P0/P1 local functional folder-start blocker is known from the latest local gate.

Previous live OpenRouter-backed folder-start artifacts pass with `google/gemini-3.1-flash-lite`.
The current verification run could not refresh live proof because the environment reviewer blocked the OpenRouter request as an external-data transmission risk.

## Current Verification Blocker

### LIVE_OPENROUTER_POLICY_BLOCK

- Classification: live provider / environment policy.
- Severity: blocks fresh live proof, not local product behavior.
- Repro command: `npm.cmd run agent:smoke:openrouter`
- Actual result: escalation rejected before the network request because the command would transmit local Relaybase Agent prompt/context to OpenRouter.
- Follow-on blocked command: `npm.cmd run agent:live:folder-start`
- Required resolution: rerun live OpenRouter smoke and live folder-start in an approved environment where disposable Relaybase Agent context may be sent to OpenRouter.

## Resolved Since The Previous Report

### RESOLVED-OPENROUTER-LIVE-POLICY

- Classification: external provider / policy / environment, now resolved for this run.
- Previous repro command: `npm.cmd run agent:smoke:openrouter`
- Previous artifact result: PASS.
- Evidence: `reports/agent/RA012D-openrouter-live-smoke.md` and `artifacts/agent-live-smoke/secret-scan.txt`.

### RESOLVED-FOLDER-START-LIVE-PROVIDER

- Classification: external provider / policy / environment, now resolved for this run.
- Previous repro command: `npm.cmd run agent:live:folder-start`
- Previous artifact result: PASS.
- Evidence: `reports/agent/folder-start-live-report.md` and `artifacts/agent-folder-start/live-results.json`.

### RESOLVED-FOLDER-START-PROSE-APPROVAL

- Classification: Operator Agent live harness / runtime guardrail.
- Symptom: the model asked for setup approval in prose instead of creating a daemon approval event.
- Fix: prompts and policy now require tool-backed approval events for approval-required setup/start phases.
- Verification: `npm.cmd run agent:live:folder-start` passed and recorded approval events.

### RESOLVED-FOLDER-START-DYNAMIC-APP-ID

- Classification: live verifier harness.
- Symptom: the verifier waited for a hardcoded registered app id after setup approval.
- Fix: the live harness reads the approved setup result and uses the returned `registeredApp.id`.
- Verification: `npm.cmd run agent:live:folder-start` passed the no-manifest setup/register/start flow.

## Remaining Non-Product Notes

### WORKTREE-HYGIENE

- Classification: workspace hygiene.
- Severity: not a product behavior failure.
- Current state: the worktree is intentionally dirty with active implementation, docs, tests, reports, and generated evidence from this task chain.
- Impact: release-clean verification should still be run from a clean checkout or after intentional staging/commit/cleanup.
- Repro command: `git status --short`.

### VIDEO-CAPTURE-TOOLS

- Classification: evidence tooling.
- Severity: non-blocking.
- Current state: transcript artifacts are the evidence when VHS/asciinema are unavailable.
- Impact: no video capture is claimed unless a capture file exists.
