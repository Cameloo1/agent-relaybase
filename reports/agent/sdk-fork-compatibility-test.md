# RA014 SDK Fork Compatibility Test

Status: PASS WITHOUT FORK

## Scope

This report records the compatibility evidence used for RA014. It does not claim a fork exists. It confirms that a fork is not currently justified.

## Live Compatibility Evidence

`reports/agent/RA012D-openrouter-live-smoke.md` shows:

- real Relaybase Agent Gateway
- real daemon Operator Agent runtime
- OpenAI Agents SDK TypeScript path
- OpenRouter provider
- model `google/gemini-3.1-flash-lite`
- reasoning enabled
- tool lifecycle events
- session SSE
- approval rejection
- setup planning
- audit/session artifacts
- secret scan
- fork required: no

`reports/agent/live-agent-test-report.md` shows:

- real Relaybase daemon
- real Agent Gateway
- real OpenAI Agents SDK TypeScript runtime
- real OpenRouter provider
- exact `google/gemini-3.1-flash-lite`
- real setup APIs
- real daemon lifecycle APIs
- real Go TUI smoke-render path
- file-write, lifecycle, restart, stop, export, and manifest metadata approvals
- log export
- ambiguous destructive target safety
- secret scan
- fork required: no

## Non-Live Compatibility Tests

The current test suite includes:

- OpenRouter config/key redaction tests
- OpenRouter model slug validation tests
- Chat Completions model/provider construction without network
- missing-key blocked diagnostic test
- runtime initialization with valid OpenRouter config
- disabled and missing-key diagnostics
- runtime event streaming
- read-only tool lifecycle mapping
- approval interruption and resume
- lifecycle target ambiguity guard
- session and prompt redaction
- budget block before spend
- audit/session persistence

## Observed Tool Diagnostics

The live event/audit artifacts include some `tool.failed` and `run.failed` events. These are not SDK failures:

- invalid model-supplied daemon tool arguments rejected by schema validation
- an unavailable terminal clipboard action reported honestly
- a manifest path diagnostic from a Relaybase tool

The final RA013 live acceptance checks still passed. These diagnostics prove safety boundaries remained active, not that SDK parsing failed.

## Commands To Reproduce

Use a shell with `OPENROUTER_API_KEY` configured:

```powershell
$env:RELAYBASE_AGENT_MODEL='google/gemini-3.1-flash-lite'
npm.cmd run agent:smoke:openrouter -- --json
npm.cmd run agent:live:acceptance -- --json
```

Local non-live checks:

```powershell
npm.cmd run format:check
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
```

## Result

No OpenAI Agents SDK TypeScript fork, vendored package, or patch-package patch is required for the current OpenRouter Gemini 3.1 Flash Lite path.
