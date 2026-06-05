# RA015 Release Readiness

Generated: 2026-06-03

## Status

PASS for the active Operator Agent readiness target using `google/gemini-3.1-flash-lite` with reasoning enabled.

The pasted RA015 prompt asked whether the live model is exactly `google/gemini-3.5-flash`; that requirement was superseded by the user's explicit instruction to use 3.1, not 3.5. This report does not claim 3.5 coverage.

## Readiness Answers

| Question | Answer | Evidence |
| --- | --- | --- |
| Can the user add a folder using a command? | yes | Live JS/Go configure-from-folder flows and setup tests. |
| Can the user configure current folder? | yes | TUI sends current cwd; setup/agent tests and docs cover current-folder setup. |
| Can the user dry-run setup? | yes | Setup preview/dry-run tests and live setup preview artifacts. |
| Can the user preview file writes/diffs? | yes | Live file-write preview artifacts and TUI rendering tests. |
| Can the user choose port strategy? | yes | Runtime setup plans include env port, framework wrapper, pinned upstream, Docker, and runtime-specific strategies; TUI renders choices. |
| Can the user confirm setup writes? | yes | Live JS/Go setup apply required approval before writes. |
| Can the user register an existing manifest? | yes | Live Python FastAPI manifest registration required approval and passed. |
| Can the user launch an onboarded app? | yes | Live JS/Python/Go starts went through daemon lifecycle approvals. |
| Can the user prove route/log/stop behavior? | yes | Live prove health, log export, and Go stop verification passed. |
| Can the user repair an app that ignores PORT? | yes for preview/choices | Live ignored-PORT repair choices produced; applying repairs still requires approval. |
| Can the user edit group/component metadata? | yes | Live metadata edit required manifest patch approval for frontend/group assignment. |
| Can the Operator Agent perform these flows with OpenRouter? | yes | Live acceptance PASS with real OpenRouter request and tool calls. |
| Is the live model exactly `google/gemini-3.5-flash`? | no by instruction | User explicitly corrected the active model to 3.1; verified exact `google/gemini-3.1-flash-lite`. |
| Is reasoning enabled or is blocker documented? | yes | Live model capability artifact shows reasoning requested; live report says medium effort. |
| Are destructive/file-write actions confirmation-gated? | yes | Live and automated tests cover file writes, manifest edits, lifecycle, prove, restart, stop, and export approvals. |
| Are secrets redacted? | yes | Artifact secret scan passed; redaction tests pass. |
| Are docs accurate? | yes for current behavior | RA011 docs and RA015 reports distinguish current behavior, diagnostics, and deferrals. |
| Are runtime adapters documented? | yes | `docs/tui-setup-runtime-matrix.md` and RA015 runtime matrix report. |
| Are remaining release-track gaps clearly deferred? | yes | `reports/agent/RA015-known-issues.md`. |

## Required Artifacts

- `reports/agent/RA015-gap-closure-report.md`
- `reports/agent/RA015-runtime-matrix-report.md`
- `reports/agent/RA015-hardening-report.md`
- `reports/agent/RA015-known-issues.md`
- `reports/agent/RA015-release-readiness.md`
- `reports/agent/live-agent-test-report.md`
- `artifacts/agent-live/openrouter-request-redacted.json`
- `artifacts/agent-live/openrouter-response-redacted.json`
- `artifacts/agent-live/model-capability-check.json`
- `artifacts/agent-live/agent-events.jsonl`
- `artifacts/agent-live/agent-audit.jsonl`
- `artifacts/agent-live/pty-transcript.txt`
- `artifacts/agent-live/secret-scan.txt`

## Final Gate

- Operator Agent/TUI setup readiness: PASS for Gemini 3.1 Lite.
- SDK fork required: no.
- P0/P1 blockers: none known.
- Release-track-only gaps: documented.

Next RA prompt may proceed if it targets final live verification or release hardening and keeps the active model explicit.
