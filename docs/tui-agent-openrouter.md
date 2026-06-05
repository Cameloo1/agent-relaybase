# TUI Operator Agent OpenRouter Plan

This document defines the OpenRouter provider contract for Relaybase's own in-TUI Operator Agent. As of RA010, Relaybase has a daemon Agent Gateway config/session/event API, an isolated OpenRouter compatibility adapter for the OpenAI Agents SDK TypeScript Chat Completions path, a daemon runtime that uses that adapter when remote mode, model slug, and key source are configured, a real Relaybase tool registry, durable redacted session/audit storage, and Go TUI integration through the Agent Gateway. The RA005 live smoke proves provider compatibility when `OPENROUTER_API_KEY` and `RELAYBASE_AGENT_MODEL` are set. Runtime execution exposes read-only tools plus approval-gated daemon lifecycle, export, setup, manifest, registration, prove/open, env override, and TUI-proposed-action tools.

## Provider Boundary

OpenRouter configuration belongs to the TypeScript daemon Agent Gateway, not the Go TUI. The TUI may show provider status, missing-key diagnostics, model choices, budget state, and approval prompts. It must not store or send raw API keys.

## Configuration

RA004 daemon Agent Gateway configuration model:

```text
OPENROUTER_API_KEY
provider=openrouter
modelSlug=<model-slug>
remoteModelEnabled=<boolean>
toolAllowlist=<tool names>
approvalPolicy=always_for_mutations
setupFileWritePolicy=approval_required
```

`OPENROUTER_API_KEY` should be read from the daemon environment, an approved secret reference, or another daemon-owned secret source. TUI preferences and TUI local history may store only key references such as `env:OPENROUTER_API_KEY`.

Relaybase CLI commands load a local `.env` file from the command working directory before option parsing. Values already present in the shell environment remain authoritative and are not overwritten by `.env`. To use a different env file, set `RELAYBASE_ENV_FILE` to an absolute path or a path relative to the command working directory.

Tracked source includes `.env.example`; the real `.env` and `.env.*` files are ignored by git. A minimal local file for live Operator Agent work is:

```env
OPENROUTER_API_KEY=
RELAYBASE_AGENT_MODEL=google/gemini-3.1-flash-lite
RELAYBASE_AGENT_ENABLED=0
RELAYBASE_AGENT_REMOTE_MODEL_ENABLED=0
OPENROUTER_HTTP_REFERER=
OPENROUTER_TITLE=Relaybase Local
```

Set both `RELAYBASE_AGENT_ENABLED=1` and `RELAYBASE_AGENT_REMOTE_MODEL_ENABLED=1`, then restart the daemon/TUI launch path, to make ordinary TUI chatbar messages use the daemon Operator Agent. A key and model alone do not enable remote model calls. This keeps copied `.env.example` files safe until the user explicitly opts in.

`GET /__hub/api/agent/config` reports key source and presence only:

```json
{
  "agent": {
    "config": {
      "enabled": false,
      "provider": {
        "provider": "openrouter",
        "apiKeySource": {
          "type": "environment",
          "envVar": "OPENROUTER_API_KEY",
          "configured": false
        },
        "remoteModelEnabled": false
      }
    }
  }
}
```

Raw OpenRouter keys are rejected in `PUT /__hub/api/agent/config`. Set the key in the daemon environment instead.

## Key Handling

Rules:

- never store the raw key in TUI preferences
- never store the raw key in daemon audit logs
- never include the raw key in setup plans, manifests, wrappers, exports, traces, screenshots, or reports
- never send the raw key to the TUI
- report key presence, source kind, and validation status without printing the value
- redact obvious key-like values before model prompts, audit records, and TUI streams

Missing-key diagnostics state that remote model mode is unavailable until an approved key source is configured. Missing model slug also returns a diagnostic. Disabled agent config returns `AGENT_DISABLED`; enabled agent config with remote model mode still off returns `AGENT_REMOTE_MODEL_DISABLED`. Message runs fail with diagnostics rather than fake model output when provider configuration is incomplete.

## Model Slug And Capability Checks

The daemon validates that a selected model slug is non-empty and syntactically usable before constructing the OpenRouter client. The live smoke requires `RELAYBASE_AGENT_MODEL`; Relaybase does not silently pick a default model.

The selected model's real tool capability is verified by `npm run agent:smoke:openrouter`, which makes a live OpenRouter request through the OpenAI Agents SDK TypeScript Chat Completions path and requires a harmless function-tool call to succeed. If the selected model does not support tool calling, the smoke fails with `BLOCKED_OPENROUTER_TOOL_CALL_UNSUPPORTED`.

Required model capabilities:

- tool calling or a compatible structured action proposal path
- bounded output controls
- reliable JSON or structured output support for tool proposals, or an SDK-level fallback parser with strict validation
- streaming support for user-facing assistant text when available

Structured-output caveat: a model capability label is not enough to trust tool execution. Every model-proposed action must still be parsed, schema-validated, policy-checked, and approval-gated by Relaybase before execution.

## Request Attribution Headers

RA005 supports optional safe request attribution headers through environment/config values:

- `OPENROUTER_HTTP_REFERER` -> `HTTP-Referer`
- `OPENROUTER_TITLE` -> `X-OpenRouter-Title`

Missing attribution headers do not block deterministic local TUI behavior or the live smoke.

## Live Smoke

Run:

```sh
npm run agent:smoke:openrouter
```

The command may read `OPENROUTER_API_KEY` and `RELAYBASE_AGENT_MODEL` from `.env`, from `RELAYBASE_ENV_FILE`, or from the shell environment. Shell environment values win over `.env` values. The smoke output must never print the raw key.

The smoke performs real OpenRouter calls and checks:

- basic completion
- harmless function-tool call through the OpenAI Agents SDK TypeScript path
- streaming through the same SDK provider path

If `OPENROUTER_API_KEY` is missing, the command exits nonzero with `BLOCKED_OPENROUTER_KEY_MISSING`. If `RELAYBASE_AGENT_MODEL` is missing, it exits nonzero with `BLOCKED_OPENROUTER_MODEL_MISSING`. The smoke must not use a fake OpenRouter server.

## Spend And Budget Controls

Remote mode must be off by default. Implemented budget gates:

- daily budget
- monthly budget
- per-session budget
- max tool-call count per turn
- max model retries per turn
- max prompt/context size
- explicit user approval before sending logs or diagnostics

When a configured budget is exhausted, the daemon blocks before the model call, audits the budget block, and returns a clear diagnostic. It must not silently fall back to a fake model response.

## Prompt Construction

Prompt construction happens in the daemon after redaction and policy checks. The prompt may include:

- safe daemon state summary
- selected app/group/pane context
- safe setup plan summary
- safe diagnostics when opted in
- safe log excerpts only when the user explicitly opts in

The prompt must not include raw auth tokens, raw env values, raw API keys, unredacted logs, unredacted manifests, or local diagnostic payloads containing secrets.

## Current Status

Current TUI optional LLM behavior remains disconnected from direct provider calls: the Go TUI calls the daemon Agent Gateway/runtime and never calls OpenRouter directly.

Current daemon Agent Gateway behavior as of RA010:

- config/session/message/event endpoints exist
- session clear and redacted session export endpoints exist
- configured remote model execution is available through the daemon runtime and OpenRouter adapter
- runtime prompts include bounded/redacted Relaybase state and TUI context
- runtime streams `model.request_started`, `model.delta`, `model.completed`, `answer`, and `run.completed` events for successful configured runs
- runtime streams tool/setup approval, preview, repair, prove, action-result, blocked, and diagnostic events when tools or setup flows are involved
- runtime emits `diagnostic`, `blocked`, and `run.failed` for disabled, missing-key, missing-model, timeout, or provider failures
- the daemon-owned tool registry is exposed to the OpenAI Agents SDK runtime
- mutating tools require approval and route through existing Relaybase daemon services
- the Go TUI can create sessions, send messages with TUI context, receive session events, render approval/setup previews, and approve or reject pending daemon approvals
- SDK-facing tool schemas use JSON Schema while internal tool execution still validates with Zod
- `OPENROUTER_API_KEY` presence is reported as a boolean only
- raw key config updates are rejected
- missing key/model/disabled states return diagnostics
- budget-exceeded states block before remote model calls
- session and audit records are redacted before persistence under the daemon state directory

Current daemon OpenRouter compatibility behavior as of RA005:

- `src/agent/openrouterProvider.ts` constructs an OpenAI client with `baseURL=https://openrouter.ai/api/v1`
- the adapter creates `OpenAIChatCompletionsModel` and `OpenAIProvider` with `useResponses=false`
- no SDK fork is required by the implemented adapter path
- `npm run agent:smoke:openrouter` is the live proof command
- missing key/model states fail as blocked, not passed
- raw OpenRouter keys are not serialized in adapter safe config, reports, or unit-test output
