# TUI Operator Agent Architecture

This document is the planning source of truth for Relaybase's own in-TUI Operator Agent. It is separate from the AI-app-builder docs, which teach users how to build their own AI apps or external agents that connect to Relaybase.

As of RA010, the repository implements the daemon-side Agent Gateway API contract for Relaybase's own Operator Agent, an isolated OpenRouter compatibility adapter for OpenAI Agents SDK TypeScript, a daemon-side runtime foundation, a daemon-owned Relaybase tool registry, durable redacted session/audit storage, and Go TUI client integration with the gateway. The gateway exposes safe provider config metadata, creates/lists/reads/clears/exports sessions, accepts TUI-context messages, streams typed session events, returns missing/disabled/runtime diagnostics, validates approval IDs, and invokes the Operator Agent runtime when remote mode, model slug, and key source are configured. Tools can read app/group/component state, diagnostics, bounded redacted logs, and setup previews; mutating lifecycle, export, setup apply, manifest patch, registration, open/prove, and env override tools are approval-gated and delegate to existing daemon services. The Go TUI remains a daemon client and approval/display surface; it never calls OpenRouter directly, writes setup files directly, or manages app processes.

## Goal

The Operator Agent should let a user manage Relaybase apps from the Bubble Tea TUI through natural language while preserving Relaybase's daemon-owned lifecycle boundary.

The intended path is:

1. The user types a request in the Go TUI.
2. The TUI sends the request, selected pane/app context, and safe UI state to the daemon Agent Gateway.
3. The daemon runs policy checks, redaction, model/tool orchestration, and approval planning.
4. The TUI renders streamed assistant text, setup previews, diffs, and approval prompts.
5. After explicit approval, the daemon performs lifecycle actions, setup file writes, manifest changes, registrations, exports, or browser/clipboard actions through existing safe primitives.

## Component Boundaries

### Go TUI UX Layer

The Go TUI owns:

- chat and command bar rendering
- streamed text rendering
- keyboard interactions and contextual menus
- approval prompts and confirmation UI
- selected pane, app, group, role, and current-directory context
- setup wizard screens, choices, previews, and diffs
- local display state and TUI-only preferences

The TUI does not directly run lifecycle operations. It does not spawn, stop, kill, supervise, or probe app processes. It calls daemon APIs and renders daemon operation state.

The TUI does not directly write manifests, wrappers, env files, setup profiles, or registration files. It may display daemon-produced setup plans and diffs, then send the user's approval decision back to the daemon.

### TypeScript Daemon Agent Gateway

The daemon owns the Agent Gateway. As of RA010, the implemented contract surface is:

- `GET /__hub/api/agent/config`
- `PUT /__hub/api/agent/config`
- `POST /__hub/api/agent/sessions`
- `GET /__hub/api/agent/sessions`
- `GET /__hub/api/agent/sessions/:sessionId`
- `DELETE /__hub/api/agent/sessions/:sessionId`
- `GET /__hub/api/agent/sessions/:sessionId/export`
- `POST /__hub/api/agent/sessions/:sessionId/messages`
- `GET /__hub/api/agent/sessions/:sessionId/events`
- `POST /__hub/api/agent/approvals/:approvalId/approve`
- `POST /__hub/api/agent/approvals/:approvalId/reject`
- `GET /__hub/api/agent/diagnostics`

The gateway currently:

- accepts TUI agent sessions and current UI context
- emits typed session events over SSE
- reports disabled, missing OpenRouter key, missing model, runtime timeout, and provider diagnostics
- invokes the OpenAI Agents SDK TypeScript runtime through the OpenRouter adapter when configured
- streams safe model request, delta, completion, answer, diagnostic, blocked, and run-completion events
- stores sessions, messages, runs, events, approvals, and audit summaries under the Relaybase state directory when one is configured
- redacts secret-like values before returning diagnostics, events, and audit data
- refuses raw API keys in config updates
- exposes the Relaybase tool registry described in `docs/tui-agent-tools.md`

The RA005 provider adapter currently:

- reads `OPENROUTER_API_KEY` from the daemon/CLI environment
- requires an explicit `RELAYBASE_AGENT_MODEL` for live smoke verification
- constructs an OpenAI client with `baseURL=https://openrouter.ai/api/v1`
- creates an SDK Chat Completions model/provider without forking the SDK
- supports optional `OPENROUTER_HTTP_REFERER` and `OPENROUTER_TITLE` attribution values

The gateway currently enforces policy, tool allowlists, approvals, budgets, and redaction before model and tool execution. Approved tool continuations run through Relaybase daemon services, not direct shell execution. Session and audit files are state-dir backed; approval records remain in process while their safe summaries are persisted in sessions/audit.

The gateway must not return fake model output. When remote mode is disabled or provider configuration is missing, it returns diagnostics and `run.failed` events. When configured, model output must come from the daemon runtime and OpenRouter provider path.

The gateway is a daemon/control-plane surface because it touches lifecycle APIs, setup APIs, token-gated mutations, audit storage, and provider configuration.

### OpenRouter Model Provider

OpenRouter is the remote model provider for the Operator Agent path. It must remain disabled until configured. The daemon owns provider configuration, model slug selection, capability checks, spend controls, and key references.

Raw OpenRouter keys must never be stored in TUI preferences, logs, exports, setup plans, chat history, audit logs, traces, or reports.

The current verified adapter path is upstream `@openai/agents` plus the OpenAI client pointed at OpenRouter's Chat Completions-compatible API. No fork is needed for RA005.

### OpenAI Agents SDK TS Runtime

The OpenAI Agents SDK TypeScript runtime is the daemon orchestration layer for model sessions and tool proposals. Relaybase wraps the upstream SDK and the RA005 OpenRouter Chat Completions-compatible provider path; no fork is currently required. A fork is allowed only when a specific technical blocker is proven, documented, isolated, and test-backed.

The SDK runtime must not execute shell commands directly. It may propose Relaybase tool calls, but every tool call still passes through Relaybase's allowlist and approval engine.

### Tool Registry

The daemon tool registry exposes read-only, lifecycle, export, setup/onboarding, and TUI-proposed UI actions described in `docs/tui-agent-tools.md`.

Tools are daemon contracts, not arbitrary process execution. The registry must define input schemas, output schemas, approval requirements, secret-redaction behavior, audit metadata, and recovery hints.

### Setup And Onboarding Tool Surface

The setup/onboarding surface wraps the existing setup engine in `src/setup.ts`, including project detection, setup plans, write previews, generated wrappers, manifest registration, health proof, and repair flows.

The TUI may request setup plans and render diffs. The daemon applies file writes only after approval.

### Approval And Policy Engine

The daemon policy engine gates:

- lifecycle mutations
- log exports
- file writes
- manifest edits
- env edits
- provider/model changes
- remote model calls
- browser-open and clipboard actions when implemented

Approval records include action, target, risk, expected result, approved input, timestamp, session id, and safe operation/export/setup identifiers. They must not include raw secrets.

### Session, Audit, And Redaction Storage

The daemon persists Operator Agent session metadata and audit records under the Relaybase state directory when a state directory is configured:

- `agent/agent.sqlite`
- `agent/exports/<exportId>.json`

`agent/agent.sqlite` is the source of truth for threads, messages, runs, events, approvals schema, audit events, and export records. Legacy `agent/sessions.json` and `agent/audit.jsonl` files are imported once on first SQLite open when present, then left untouched as backups. Corrupt legacy files produce diagnostics and continue with an empty import. If the SQLite file is corrupt or unusable, Relaybase quarantines it as `agent.sqlite.broken.<timestamp>`, starts a fresh database, and exposes a storage diagnostic rather than crashing daemon startup solely because the agent DB is corrupt.

Storage keeps inspectable state, supports recovery after daemon restart, and redacts before persistence.

Stored data may include safe user intent, normalized tool calls, approval decisions, operation IDs, export IDs, setup plan IDs, redaction reports, and final summaries. Stored data must not include raw tokens, raw env secret values, raw API keys, unredacted logs, or unredacted provider prompts.

The active Operator Agent thread is daemon state. Thread creation, list, activation, title/privacy update, soft clear, JSON/Markdown export, context preview, and event replay are all Agent Gateway routes backed by `agent/agent.sqlite`. The Go TUI may render thread lists, send messages to the active thread, request exports, and show context previews, but it does not store chat transcripts, active-thread IDs, approval payloads, or model responses in `tui/preferences.json`.

Thread recall is active-thread-only. The prompt context builder may include bounded, redacted messages and summaries from the active daemon thread, but it must not blend messages from inactive threads or raw app logs into the model prompt. Log-related context is represented as bounded summaries, references, counts, or explicit approved exports rather than raw durable log bodies.

### Event Streaming Back To TUI

The daemon streams agent events back to the TUI through the dedicated session SSE stream at `/__hub/api/agent/sessions/:sessionId/events`. Event payloads are typed and include IDs, sequence numbers, session IDs, and redacted JSON payloads.

The session SSE route accepts `afterSequence` and `Last-Event-ID` replay hints for stored events, but reconnect metadata still says `snapshot_only` because the authoritative recovery path is to fetch the daemon session snapshot. The TUI must not invent completed tool state after a disconnect.

Recovered approvals are shown as recovered approvals and require explicit user confirmation or rejection. The daemon may recover pending approval records from SQLite after restart, but the TUI must never auto-resume those approvals.

## Current Implementation Status

Implemented today:

- Go Bubble Tea TUI client shell, pane dashboard, menus, slash commands, deterministic local assistant, optional LLM configuration shell, preferences, logs, and evidence smoke.
- Go TUI Agent Gateway client methods, config/diagnostic fetch, session/message/event commands, approval approve/reject commands, and event rendering for answers, diagnostics, setup previews, file-write previews, repair choices, prove results, and TUI proposed actions.
- Node/TypeScript daemon lifecycle APIs, operations, events, grouped state, logs, exports, setup CLI functions, and registration APIs.
- Node/TypeScript daemon Agent Gateway API contract for config, sessions, messages, session SSE events, diagnostics, approvals, session clearing, and redacted session export.
- Node/TypeScript daemon Operator Agent runtime using OpenAI Agents SDK TS through OpenRouter, with bounded/redacted TUI context, state-dir backed safe session/audit storage, budget diagnostics, streamed model/tool/setup events, timeout diagnostics, and the daemon-owned tool registry.

Still deferred:

- live OpenRouter proof unless `OPENROUTER_API_KEY` and `RELAYBASE_AGENT_MODEL` are configured and `npm run agent:smoke:openrouter` passes
- platform-specific release packages and GoReleaser/checksum dry-runs when those tools are not installed locally
- native manifest `components[]`; current grouping remains component-as-app metadata

## Non-Negotiable Boundary

The daemon remains the source of truth for process lifecycle, app state, logs, exports, events, auth, setup file writes, and manifest registration. The Operator Agent manages apps only through daemon APIs and daemon-owned tools.
