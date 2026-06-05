# RA013F Live Failure Repair

Status: PASS

## Scope

This repair pass inspected the RA013 live report and artifacts, classified the observed live failures from the RA013 repair loop, fixed the remaining report/model consistency issue, and reran the live slices against the real Relaybase daemon, real Agent Gateway, real OpenAI Agents SDK TypeScript runtime, real OpenRouter provider, real setup APIs, real daemon lifecycle APIs, and the real Go TUI smoke-render path.

The model used for this pass is `google/gemini-3.1-flash-lite`. The original RA013F prompt text mentioned `google/gemini-3.5-flash`, but the user explicitly corrected the active run to continue with 3.1.

## Failure Table

The machine-readable failure table is:

- `artifacts/agent-live-repair/failure-table.json`

Summary:

| ID | Flow | Classification | Severity | Final status |
| --- | --- | --- | --- | --- |
| RA013F-F001 | A | environment/toolchain failure | P1 | fixed |
| RA013F-F002 | B | fixture/test harness failure | P1 | fixed |
| RA013F-F003 | C | approval interruption/resume failure | P0 | fixed |
| RA013F-F004 | C | runtime adapter failure | P1 | fixed |
| RA013F-F005 | D | TUI stream/rendering failure | P1 | fixed |
| RA013F-F006 | E | setup engine failure | P0 | fixed |
| RA013F-F007 | A | OpenRouter model/auth/parameter failure | P0 | fixed |
| RA013F-F008 | H | redaction/security failure | P0 | fixed |
| RA013F-F009 | G | approval interruption/resume failure | P0 | fixed |
| RA013F-F010 | A | fixture/test harness failure | P1 | fixed |

## Repairs Completed

- Kept the live acceptance harness pinned to `google/gemini-3.1-flash-lite`.
- Fixed the live acceptance Markdown report writer so the scope sentence interpolates the exact required model instead of using stale hardcoded text.
- Preserved the existing safety fixes for inferred lifecycle targets, redaction, setup runtime-state synchronization, bounded model output, approval resumption, and TUI smoke-render evidence.

## Final Live Result

`npm.cmd run agent:smoke:openrouter -- --json` passed with:

- real OpenRouter model response from `google/gemini-3.1-flash-lite`
- reasoning enabled with medium effort
- harmless tool-call path observed
- SSE stream captured
- approval rejection prevented lifecycle start
- session/audit artifacts written under disposable state
- artifact secret scan passed

`npm.cmd run agent:live:acceptance -- --json` passed with:

- real OpenRouter completion using exact `google/gemini-3.1-flash-lite`
- real in-process Relaybase daemon
- real Go TUI smoke-render frames
- JavaScript, Python FastAPI, and Go setup/lifecycle flows
- file-write, lifecycle, restart, stop, export, and manifest metadata approvals
- log query/export
- ambiguous destructive target safety
- artifact secret scan

## Evidence Artifacts

- `reports/agent/live-agent-test-report.md`
- `artifacts/agent-live/openrouter-request-redacted.json`
- `artifacts/agent-live/openrouter-response-redacted.json`
- `artifacts/agent-live/agent-events.jsonl`
- `artifacts/agent-live/agent-audit.jsonl`
- `artifacts/agent-live/daemon.log`
- `artifacts/agent-live/pty-transcript.txt`
- `artifacts/agent-live/secret-scan.txt`
- `artifacts/agent-live-repair/failure-table.json`
- `artifacts/agent-live-repair/rerun-log.txt`

## Commands Run

- `codegraph-mcp agent-use status --repo . --json`
- `codegraph-mcp agent-use context-pack --repo . --task "RA013F live Operator Agent failure repair" --agent-json`
- `npm.cmd run format:check`
- `npm.cmd run lint`
- `npm.cmd run typecheck`
- `npm.cmd test`
- `npm.cmd run test:jest`
- `npm.cmd run smoke`
- `$env:RELAYBASE_AGENT_MODEL='google/gemini-3.1-flash-lite'; npm.cmd run agent:smoke:openrouter -- --json`
- `$env:RELAYBASE_AGENT_MODEL='google/gemini-3.1-flash-lite'; npm.cmd run agent:live:acceptance -- --json`
- `npm.cmd run tui:test`
- `$env:RELAYBASE_AGENT_MODEL='google/gemini-3.1-flash-lite'; npm.cmd run agent:live:acceptance -- --json`

## Unavailable Named Scripts

These requested script names do not exist in `package.json`; coverage is currently included in `npm.cmd test` and `npm.cmd run tui:test`.

- `npm run agent:test`
- `npm run setup:test`

## Final Classification

Every RA013 failure identified in this repair pass is fixed. No external OpenRouter blocker remains for the 3.1 Lite live path. No SDK fork or patch was required. No safety gate was weakened. The TUI still does not own lifecycle logic or setup file writes.

## Known Risks

- Live OpenRouter availability and account budget remain external dependencies for future live runs.
- GoReleaser/checksum release verification is separate release-track work and was not part of this RA013F repair.
- The workspace remains broadly dirty from the accumulated RA/TUI implementation work; this repair did not attempt cleanup or staging.
