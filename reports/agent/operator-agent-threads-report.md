# Operator Agent Threads Report

Generated: 2026-06-03
Status: PASS with workspace hygiene caveat

## Scope

OA-THREADS-004 verified the daemon-owned Operator Agent thread surface after OA-THREADS-001 through OA-THREADS-003. This report covers documentation alignment, repeatable thread smoke evidence, redaction checks, and local verification commands.

This pass did not add new Operator Agent product scope. It did not move lifecycle logic into the Go TUI. It did not make the TUI a chat transcript store. It did not claim a new live OpenRouter acceptance result beyond the explicitly run `agent:smoke:openrouter` command.

## Implementation Summary

- Operator Agent thread state is daemon-owned and stored under the Relaybase state directory at `<state-dir>/agent/agent.sqlite`.
- Legacy `agent/sessions.json` and `agent/audit.jsonl` files are imported once when present and are left in place as backups.
- The Go TUI uses Agent Gateway routes for thread creation, list, active-thread read, activate/switch, rename/patch, soft clear, JSON/Markdown export, context preview, message send, event stream, and approval resolution.
- The Go TUI does not store chat transcripts, active-thread recall authority, model responses, approval payloads, audit records, or exports in `tui/preferences.json`.
- Thread recall is active-thread-only. Inactive threads are not merged into model prompt context.
- Recovered approvals require explicit user confirmation or rejection before execution resumes.
- Chat/session export is redacted and supports JSON and Markdown.

## Files Changed By OA Thread Work

Prior OA-THREADS implementation work touched the daemon thread store, gateway routes, TUI client/model/menu/slash integration, bridge/smoke tooling, tests, and docs. The relevant inspected surfaces were:

- `src/agent/threadStore.ts`
- `src/agent/sessionStore.ts`
- `src/agent/gateway.ts`
- `src/agent/api.ts`
- `src/agent/types.ts`
- `src/agent/approvalStore.ts`
- `src/agent/auditStore.ts`
- `src/agent/context.ts`
- `src/agent/prompts.ts`
- `tui/internal/relaybaseclient/client.go`
- `tui/internal/relaybaseclient/types.go`
- `tui/internal/tui/model/model.go`
- `tui/internal/tui/slash/slash.go`
- `tui/internal/tui/contextmenu/menu.go`
- `tui/internal/tui/views/views.go`
- `scripts/tui-smoke.mjs`
- `src/tuiBridge.ts`
- `tests/agent-api.test.ts`
- `tests/agent-runtime.test.ts`
- `tests/agent-session-audit.test.ts`
- `tui/internal/relaybaseclient/client_test.go`
- `tui/internal/tui/model/model_test.go`
- `tui/internal/tui/slash/slash_test.go`
- `tui/internal/tui/contextmenu/menu_test.go`

OA-THREADS-004 added repeatable evidence tooling and refreshed docs:

- `scripts/agent-threads-evidence.mjs`
- `package.json`
- `docs/tui-agent-architecture.md`
- `docs/tui-api-contract.md`
- `docs/tui-agent-safety.md`
- `docs/tui-preferences.md`
- `docs/tui-keymap.md`
- `reports/agent/operator-agent-threads-report.md`

OA-THREADS-004 also made one narrow type-only fix in `src/tuiBridge.ts` so `npm run typecheck` accepts the smoke-render stdio tuple.

## Thread DB Path

The repeatable smoke evidence used an isolated OS temp state directory:

- State dir: `C:\Users\wamin\AppData\Local\Temp\relaybase-agent-threads-Qva9cM`
- SQLite DB: `C:\Users\wamin\AppData\Local\Temp\relaybase-agent-threads-Qva9cM\agent\agent.sqlite`
- Artifact root: `C:\Users\wamin\Desktop\development\relaybase\artifacts\agent-threads\2026-06-03T21-59-01-350Z`

The artifact root is under ignored `artifacts/`. The SQLite DB stayed outside the repository.

## Smoke Evidence

Command:

```powershell
npm.cmd run agent:threads:evidence
```

Result: PASS.

Evidence artifacts:

- `artifacts/agent-threads/2026-06-03T21-59-01-350Z/summary.json`
- `artifacts/agent-threads/2026-06-03T21-59-01-350Z/initial-list.json`
- `artifacts/agent-threads/2026-06-03T21-59-01-350Z/active-initial.json`
- `artifacts/agent-threads/2026-06-03T21-59-01-350Z/renamed-thread.json`
- `artifacts/agent-threads/2026-06-03T21-59-01-350Z/message-append.json`
- `artifacts/agent-threads/2026-06-03T21-59-01-350Z/context-preview.json`
- `artifacts/agent-threads/2026-06-03T21-59-01-350Z/sse-replay.txt`
- `artifacts/agent-threads/2026-06-03T21-59-01-350Z/json-export-result.json`
- `artifacts/agent-threads/2026-06-03T21-59-01-350Z/thread-export.json`
- `artifacts/agent-threads/2026-06-03T21-59-01-350Z/markdown-export-result.json`
- `artifacts/agent-threads/2026-06-03T21-59-01-350Z/thread-export.md`
- `artifacts/agent-threads/2026-06-03T21-59-01-350Z/session-before-restart.json`
- `artifacts/agent-threads/2026-06-03T21-59-01-350Z/active-after-restart.json`
- `artifacts/agent-threads/2026-06-03T21-59-01-350Z/session-after-restart.json`
- `artifacts/agent-threads/2026-06-03T21-59-01-350Z/clear-result.json`
- `artifacts/agent-threads/2026-06-03T21-59-01-350Z/final-list.json`
- `artifacts/agent-threads/2026-06-03T21-59-01-350Z/legacy-migration.json`

Verified cases:

- Active thread creation: passed.
- List sessions: passed.
- Newest session becomes active: passed.
- Thread rename and privacy patch: passed.
- Activate/switch thread: passed.
- Message append redacts secret-like content: passed.
- Context preview reports `active_thread_only`: passed.
- Session SSE route reports snapshot-only reconnect metadata and replays stored events newer than `afterSequence`: passed.
- JSON thread export: passed.
- Markdown thread export: passed.
- Active thread persists across daemon restart: passed.
- Message summary persists across daemon restart: passed.
- Soft clear returns cleared marker and hides cleared thread from normal session list: passed.
- Legacy sessions import into SQLite: passed.
- Legacy import redacts secret-like values in daemon responses: passed.
- Legacy JSON/JSONL backup files remain in place: passed.

## Active Thread Behavior

The daemon exposes `GET /__hub/api/agent/sessions/active` and stores the active thread in SQLite metadata. In smoke evidence, the second created thread became active, then `POST /__hub/api/agent/sessions/:id/activate` switched active state to the first thread. After daemon restart against the same temp state, `GET /__hub/api/agent/sessions/active` returned the same first thread.

## Recall Boundaries

`GET /__hub/api/agent/sessions/:id/context-preview` returned:

- `recallPolicy.scope: active_thread_only`
- `includesRawSecrets: false`
- `includesRawLogs: false`
- `includesRawDiffs: false`
- `extraModelCalls: false`

The preview included a redacted recent user message. Secret-like input was rendered as `[redacted]`.

## Approval Recovery

Approval recovery is covered by automated tests rather than the thread smoke script:

- `tests/agent-session-audit.test.ts` verifies persisted approvals recover as `recovered_pending`.
- `tests/agent-runtime.test.ts` verifies approval interruption/resume behavior and exact argument binding.
- `tui/internal/tui/model/model_test.go` verifies recovered approvals require explicit TUI reconfirmation/rejection.

No recovered approval was auto-approved or auto-resumed in this verification pass.

## Export Behavior

The smoke script exported the active thread in both formats:

- JSON: `thread-export.json`
- Markdown: `thread-export.md`

Both exports were generated through the daemon session export route under the daemon state directory, then copied into ignored evidence artifacts after redaction. The Markdown export contained the expected `Relaybase Operator Agent Thread` heading and redacted secret-like input.

## TUI Command And Menu Behavior

Docs now describe the current TUI thread actions:

- `/thread list`
- `/thread new [title]`
- `/thread switch <id|number>`
- `/thread rename <title>`
- `/thread clear`
- `/thread export <json|markdown>`
- `/thread preview`
- assistant menu new daemon-backed thread
- assistant menu export active daemon-backed thread
- assistant menu context preview

The TUI still owns UX only. It calls daemon Agent Gateway APIs for thread operations and does not write thread data, setup files, manifests, wrappers, env files, or lifecycle state directly.

## Live OpenRouter Boundary

Because `.env` contained both `OPENROUTER_API_KEY` and `RELAYBASE_AGENT_MODEL`, the conditional live smoke was run.

First sandboxed run:

- Command: `npm.cmd run agent:smoke:openrouter`
- Result: FAIL
- Failure: `RA012D_READ_ONLY_APP_INVENTORY_FAILED: run status failed`
- Redacted event diagnostic: `AGENT_PROVIDER_ERROR`, `Connection error.`
- Classification: sandbox/network access failure.

Escalated rerun with network access:

- Command: `npm.cmd run agent:smoke:openrouter`
- Result: PASS
- Model: `google/gemini-3.1-flash-lite`
- Reasoning: enabled, medium
- Read-only tool call: passed
- Streaming: passed
- Setup planning: passed
- Approval gate: passed
- Secret scan: passed
- Report: `reports/agent/RA012D-openrouter-live-smoke.md`
- Artifacts: `artifacts/agent-live-smoke/`

## Commands Run

| Command                                                                                                                                                                                               | Result                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codegraph-mcp agent-use status --repo . --json`                                                                                                                                                      | PASS, claimable true.                                                                                                                                            |
| `codegraph-mcp agent-use context-pack --repo . --task "OA-THREADS-004 Final thread docs evidence smoke verification release hygiene" --agent-json`                                                    | PASS, claimable true.                                                                                                                                            |
| `git status --short`                                                                                                                                                                                  | PASS command, dirty worktree from existing source/report work.                                                                                                   |
| `npm.cmd run agent:threads:evidence`                                                                                                                                                                  | PASS.                                                                                                                                                            |
| `node --version`                                                                                                                                                                                      | PASS, `v24.15.0`.                                                                                                                                                |
| `npm.cmd --version`                                                                                                                                                                                   | PASS, `11.12.1`.                                                                                                                                                 |
| `npm.cmd run agent:smoke:openrouter`                                                                                                                                                                  | FAIL under sandbox with provider connection error; PASS after escalated rerun with network access.                                                               |
| `npm.cmd run format:check`                                                                                                                                                                            | Initially FAIL on three pre-existing formatted files; PASS after targeted Prettier run.                                                                          |
| `npx.cmd prettier --write scripts/tui-go.mjs scripts/tui-smoke.mjs src/tuiBridge.ts`                                                                                                                  | PASS, mechanical formatting only.                                                                                                                                |
| `npm.cmd run lint`                                                                                                                                                                                    | Initially FAIL on `scripts/agent-threads-evidence.mjs`; PASS after removing the useless initial assignment.                                                      |
| `npm.cmd run typecheck`                                                                                                                                                                               | Initially FAIL on `src/tuiBridge.ts` stdio tuple type; PASS after a narrow type-only fix.                                                                        |
| `npm.cmd test`                                                                                                                                                                                        | PASS, 204/204 tests.                                                                                                                                             |
| `npm.cmd run agent:test`                                                                                                                                                                              | PASS, 54/54 tests.                                                                                                                                               |
| `npm.cmd run tui:build`                                                                                                                                                                               | PASS.                                                                                                                                                            |
| `npm.cmd run tui:test`                                                                                                                                                                                | PASS.                                                                                                                                                            |
| `npm.cmd run tui:smoke`                                                                                                                                                                               | PASS.                                                                                                                                                            |
| `npm.cmd run smoke`                                                                                                                                                                                   | PASS exit code; reports current repo is not configured as an app with `PROJECT_NOT_CONFIGURED`, which is expected for this workspace.                            |
| `npm.cmd run test:jest`                                                                                                                                                                               | PASS, 1 suite and 4 tests.                                                                                                                                       |
| `node scripts/scan-agent-artifacts.mjs reports/agent/operator-agent-threads-report.md artifacts/agent-threads/2026-06-03T21-59-01-350Z artifacts/agent-live-smoke artifacts/tui-verification/default` | PASS, scanned 41 text files with no unredacted OpenRouter key, bearer token, auth header, or secret assignment findings.                                         |
| `npm.cmd run verify:clean-worktree`                                                                                                                                                                   | FAIL, worktree dirty from existing broad source/report work; generated evidence remained under ignored `artifacts/` and temp SQLite DBs stayed outside the repo. |

## Workspace Hygiene

Generated thread evidence was written under ignored `artifacts/agent-threads/`. The daemon SQLite DB and temp state directories were under the OS temp directory, outside the repository.

The worktree was dirty before OA-THREADS-004 and remains dirty. This report does not classify all pre-existing dirty source files as release-ready. Release readiness still requires an intentional staging/commit or clean-disposable verification lane.

The secret scan covered:

- `reports/agent/operator-agent-threads-report.md`
- `artifacts/agent-threads/2026-06-03T21-59-01-350Z`
- `artifacts/agent-live-smoke`
- `artifacts/tui-verification/default`

It passed without printing or detecting raw OpenRouter keys, Relaybase token-like assignments, bearer tokens, auth headers, or unredacted secret-like assignments.

## Gaps And Risks

- The current worktree is dirty from broad in-progress release/agent work, so `verify:clean-worktree` is expected to fail until that work is intentionally staged or moved to a clean checkout.
- Local live OpenRouter smoke requires network access outside the default sandbox. The escalated run passed.
- Full release packaging and GoReleaser/checksum readiness are outside this thread-specific task.

## Verdict

Operator Agent Threads are ready for the next release-hardening prompt, with the workspace hygiene caveat above. Full release readiness should still require a clean-worktree lane and the broader release checks.
