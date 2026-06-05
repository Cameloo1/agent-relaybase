# OpenAI Agents SDK Fork Policy

Relaybase does not currently maintain a fork or patch of `@openai/agents`.

## Current Decision

- Upstream package: `@openai/agents`
- Installed range: `^0.11.6`
- Runtime transport: Chat Completions through `OpenAIChatCompletionsModel` and `OpenAIProvider`
- OpenRouter base URL: `https://openrouter.ai/api/v1`
- Fork or patch: no

The current OpenRouter path is implemented as a Relaybase adapter in `src/agent/openrouterProvider.ts`. It creates an OpenAI-compatible client pointed at OpenRouter and forces Chat Completions mode with `useResponses=false`.

## Evidence

The current live evidence shows no SDK blocker that requires a fork:

- `reports/agent/RA012D-openrouter-live-smoke.md`
- `reports/agent/live-agent-test-report.md`
- `reports/agent/RA013F-live-failure-repair.md`
- `artifacts/agent-live/openrouter-request-redacted.json`
- `artifacts/agent-live/openrouter-response-redacted.json`
- `artifacts/agent-live/model-capability-check.json`

The live path passed with:

- exact `google/gemini-3.1-flash-lite`
- reasoning enabled
- streaming/session event capture
- tool calls
- approval interruption and resume
- setup planning and approval-gated file writes
- daemon lifecycle APIs
- redacted artifacts and audit/session output

## Fork Gate

A Relaybase-maintained wrapper, patch, vendored package, or fork is allowed only if a future live run proves a specific SDK blocker with redacted reproduction evidence. Preference, style, or hypothetical future risk is not enough.

Accepted blocker categories:

- OpenRouter Chat Completions model adapter issue
- Gemini response normalization issue
- reasoning parameter serialization issue
- reasoning details preservation issue
- streaming delta parsing issue
- tool-call parsing issue
- function-tool schema issue
- approval interruption or resume issue
- run-state or session serialization issue
- nested approval issue
- OpenRouter usage/token metadata issue

## Intervention Order

Use the smallest intervention that fixes the proven blocker:

1. Relaybase local wrapper or adapter change.
2. Provider normalization layer.
3. `patch-package` patch.
4. Vendored workspace package.
5. Full fork as last resort.

## Required Evidence Before Forking

Before introducing any SDK patch or fork, create or update:

- `reports/agent/sdk-fork-decision.md`
- `reports/agent/sdk-fork-compatibility-test.md`
- redacted OpenRouter request/response artifacts
- redacted SDK stack trace or event stream failure artifact

The evidence must include:

- exact command
- exact upstream package version
- exact model slug
- sanitized request parameters
- sanitized response or stack trace
- why a local wrapper is insufficient
- test proving the patch fixes the blocker
- rollback plan

## Maintenance And Rollback

If a fork is ever introduced:

- keep the delta minimal
- document upstream commit or package version
- isolate Relaybase changes in one package or patch file
- include compatibility tests for OpenRouter, reasoning, streaming, tool calling, approvals, sessions, and setup/file-write approvals
- preserve all approval and redaction gates
- remove the fork as soon as upstream or a local adapter can satisfy the same behavior

Rollback is the reverse of the intervention order: first remove fork-only code paths, then remove vendored packages or patches, then return to the local adapter path.
