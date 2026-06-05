# RA014 SDK Fork Decision

Status: NO FORK

## Decision

Do not fork or patch OpenAI Agents SDK TypeScript for Relaybase at this time.

The OpenRouter adapter works with the upstream SDK for the current live Operator Agent path. RA014 therefore stops at a decision report and does not introduce product-code changes, `patch-package`, a vendored package, or a full fork.

## Evidence Inspected

- `reports/agent/RA012D-openrouter-live-smoke.md`
- `reports/agent/live-agent-test-report.md`
- `reports/agent/RA013F-live-failure-repair.md`
- `reports/agent/openrouter-compatibility.md`
- `artifacts/agent-live/openrouter-request-redacted.json`
- `artifacts/agent-live/openrouter-response-redacted.json`
- `artifacts/agent-live-smoke/openrouter-response-redacted.json`
- `artifacts/agent-live/model-capability-check.json`
- `src/agent/openrouterProvider.ts`
- `tests/openrouter-provider.test.ts`
- `tests/agent-runtime.test.ts`

## Upstream Package

- `@openai/agents`: `^0.11.6`
- `openai`: `^6.41.0`
- `zod`: `^4.4.3`

## Current Adapter

Relaybase uses a local OpenRouter adapter in `src/agent/openrouterProvider.ts`:

- creates an `openai` client with `baseURL=https://openrouter.ai/api/v1`
- uses `OpenAIChatCompletionsModel`
- uses `OpenAIProvider`
- sets `useResponses=false`
- keeps `strictFeatureValidation=true`
- reports `forkRequired=false` in safe config

This is a wrapper/adapter, not a fork.

## Blocker Review

| Potential blocker | Evidence | Decision |
| --- | --- | --- |
| OpenRouter Chat Completions adapter issue | Live smoke and RA013 passed through Chat Completions. | no blocker |
| Gemini response normalization issue | Live model response completed and tool events were normalized into Agent Gateway events. | no blocker |
| Reasoning parameter serialization issue | Live smoke and RA013 passed with reasoning enabled, medium effort. | no blocker |
| Reasoning details preservation issue | Current Relaybase acceptance requires reasoning request support, not raw reasoning details replay. No failing stack trace exists. | no blocker |
| Streaming delta parsing issue | Live smoke captured SSE/session events; RA013 event artifacts were produced. | no blocker |
| Tool-call parsing issue | Harmless tool call and Relaybase tools emitted expected tool lifecycle events. | no blocker |
| Function-tool schema issue | Tool schema failures observed in artifacts are daemon/tool validation diagnostics from model arguments, not SDK parser failures. | no SDK blocker |
| Approval interruption/resume issue | Tests and live acceptance passed approval-required flow. | no blocker |
| RunState/session serialization issue | Session/audit artifacts survived and were redacted. | no blocker |
| Nested approval issue | No live failure proving nested approval SDK limitation. | no blocker |
| OpenRouter usage/token metadata issue | No acceptance failure depends on missing usage metadata. | no blocker |
| OpenRouter model/provider endpoint issue | Live model calls passed for `google/gemini-3.1-flash-lite`. | no blocker |

## Why No Patch Was Added

The RA014 dependency requires a proven SDK limitation. The current evidence proves the opposite: the upstream SDK path works with Relaybase's adapter for OpenRouter, Gemini 3.1 Flash Lite, reasoning, streaming, tool calls, approval gating, sessions, and setup-event mapping.

Adding a fork or patch now would add maintenance risk without solving a live failure.

## Maintenance Plan

Continue using the upstream SDK and the Relaybase adapter. If a future live run produces a blocker, follow `docs/agent-sdk-fork.md`:

1. reproduce with redacted artifacts
2. try a local adapter/provider normalization fix
3. patch or fork only if wrapper changes are insufficient
4. add compatibility tests before accepting the patch
5. preserve approval, redaction, and daemon/TUI boundaries

## Rollback Plan

No fork or patch was added, so no rollback is needed. If this decision needs to be reversed later, create a new RA014 repair report with exact live failure evidence first.
