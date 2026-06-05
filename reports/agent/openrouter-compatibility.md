# RA005 OpenRouter Compatibility Report

## Summary

RA005 proves that Relaybase can use OpenRouter through the upstream OpenAI Agents SDK TypeScript Chat Completions path without forking the SDK.

The implemented path is:

1. Create an `openai` client with `baseURL=https://openrouter.ai/api/v1`.
2. Pass the client to `OpenAIChatCompletionsModel` and `OpenAIProvider`.
3. Force Chat Completions mode with `useResponses=false`.
4. Run a live smoke only when `OPENROUTER_API_KEY` and `RELAYBASE_AGENT_MODEL` are present.

## Fork Decision

No fork is required for RA005.

The installed `@openai/agents` package exports:

- `OpenAIProvider`
- `OpenAIChatCompletionsModel`
- `Runner`
- `Agent`
- `tool`

Those primitives are sufficient for an OpenRouter-compatible adapter. A fork should be considered only if a future RA006/RA007 runtime integration proves a concrete SDK blocker with reproducible error output.

Implementation note: Relaybase loads the SDK with a small structural `createRequire` boundary in `src/agent/openrouterProvider.ts`. This keeps Relaybase typecheck focused on Relaybase code because the installed SDK declaration files have Node event-emitter type incompatibilities under the repo's current TypeScript/Node type setup. Runtime still uses the upstream `@openai/agents` package; this is not a fork.

## Implemented Files

- `src/agent/openrouterProvider.ts`
- `src/agent/openrouterSmoke.ts`
- `tests/openrouter-provider.test.ts`
- `src/cli.ts`
- `package.json`

## Dependency Decision

Added:

- `@openai/agents`
- `openai`

Updated:

- `zod` from v3 to v4 because `@openai/agents@0.11.6` has a `zod@^4.0.0` peer dependency.

Relaybase source did not import `zod` directly before this change. Existing MCP SDK peer constraints allow `zod` v3 or v4.

## Live Smoke Command

```sh
OPENROUTER_API_KEY=<redacted> RELAYBASE_AGENT_MODEL=<model-slug> npm run agent:smoke:openrouter
```

Equivalent CLI command:

```sh
relaybase agent smoke-openrouter
```

The smoke performs real OpenRouter calls and verifies:

- basic completion
- harmless function-tool call support
- streaming support

The smoke does not use a fake OpenRouter server.

## Blocked States

| State | Result |
| --- | --- |
| Missing `OPENROUTER_API_KEY` | Nonzero exit with `BLOCKED_OPENROUTER_KEY_MISSING`. |
| Missing `RELAYBASE_AGENT_MODEL` | Nonzero exit with `BLOCKED_OPENROUTER_MODEL_MISSING`. |
| Invalid model slug whitespace/control characters | Nonzero exit with `BLOCKED_OPENROUTER_MODEL_INVALID`. |
| Selected model does not complete harmless tool call | Nonzero exit with `BLOCKED_OPENROUTER_TOOL_CALL_UNSUPPORTED`. |
| Selected model does not complete streaming smoke | Nonzero exit with `BLOCKED_OPENROUTER_STREAMING_UNSUPPORTED`. |

## Security Notes

- Raw OpenRouter keys are not serialized in safe config.
- Missing-key diagnostics report env var names only.
- Optional OpenRouter attribution headers are read from `OPENROUTER_HTTP_REFERER` and `OPENROUTER_TITLE`.
- The smoke prompt uses only fixed harmless tokens.
- No app lifecycle, setup, file-write, manifest, browser, clipboard, export, or daemon mutation tools are implemented in RA005.

## Capability Check

Relaybase does not rely on a static model catalog in RA005. The selected model's tool-calling capability is verified by the live harmless function-tool smoke. If the model cannot call the function tool through OpenRouter and the SDK path, the smoke fails clearly rather than falling back to text-only behavior.

## Current Limitation

The daemon Agent Gateway still returns diagnostics for session messages. RA006 must wire the runtime into the gateway before Operator Agent messages can produce model output.
