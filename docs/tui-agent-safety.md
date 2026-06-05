# TUI Operator Agent Safety

This document defines safety requirements for Relaybase's own in-TUI Operator Agent. As of RA010, the daemon Agent Gateway exposes config, sessions, session event streams, diagnostics, approval ID validation, a daemon-side OpenAI Agents SDK runtime through OpenRouter, a daemon-owned Relaybase tool registry, state-dir backed session/audit storage, redacted chat/session export, and Go TUI integration for session messages, streamed events, setup previews, and approval decisions. Read-only tools can inspect safe state, diagnostics, bounded redacted logs, manifests, setup plans, and repair previews. Mutating tools exist only as approval-gated daemon contracts for lifecycle, export, setup apply, manifest patch, registration, open/prove, and env override behavior.

## Default State

Remote model mode is disabled by default. The deterministic local assistant remains available without OpenRouter, OpenAI Agents SDK execution, or network calls.

For local development, remote Operator Agent execution is enabled from the daemon environment, typically `.env`, only when both flags are explicit:

```env
RELAYBASE_AGENT_ENABLED=1
RELAYBASE_AGENT_REMOTE_MODEL_ENABLED=1
```

`OPENROUTER_API_KEY` and `RELAYBASE_AGENT_MODEL` by themselves do not enable remote calls. Restart the daemon/TUI launch path after changing `.env` so the daemon process reads the new environment.

When remote mode is missing, disabled, misconfigured, out of budget, or unsupported, Relaybase must show a clear diagnostic and continue to offer deterministic local commands where possible.

Disabled agent config, disabled remote model mode, missing `OPENROUTER_API_KEY`, missing model slug, budget exhaustion, runtime timeout, and provider failures produce diagnostics and failed runs. The gateway must not synthesize assistant/model text.

## Approval Gates

Approval is required before:

- starting an app
- stopping an app
- restarting an app
- exporting logs
- applying setup file writes
- creating or updating `relaybase.app.json`
- creating or updating `.relaybase/launch.cjs`
- creating or updating `.relaybase/setup-profile.json` or current setup profile equivalents
- editing env values or env files
- registering or re-registering a manifest
- changing `upstreamPort`, `healthUrl`, command, cwd, or component metadata
- sending logs or diagnostics to a remote model
- opening a browser route if real browser support is implemented
- using clipboard support if real clipboard support is implemented

Approval previews must show action, target, risk, expected result, and safe diff or operation preview. Secret-like values must be redacted before preview.

## Destructive Action Approval

Lifecycle actions must call daemon APIs and return operation IDs. The Operator Agent may propose a lifecycle action, but it must not execute the action until the user approves.

The TUI must never start, stop, kill, supervise, or clean up app processes directly.

## File-Write Approval

The daemon must provide a write plan before applying setup writes. The plan should include:

- path
- action
- reason
- safe preview
- safe diff
- whether the file already exists
- recovery path if apply fails

The TUI shows the plan and sends approval or cancellation. The daemon applies approved writes atomically where practical.

## Manifest And Env Edit Approval

Manifest edits are allowed only through safe fields documented in `docs/tui-setup-onboarding.md` and `docs/tui-setup-file-write-safety.md`.

Env edits must never reveal or store raw secret values. For secret-like env keys, the preview should show key name, value source kind, and redacted value. The daemon should reject raw secret display in model prompts, TUI streams, audit logs, and reports.

## Ambiguous Targets

Ambiguous app, group, component, pane, path, setup plan, or role targets must ask for clarification. The agent must not guess.

Examples:

- `stop backend` is blocked unless the selected group makes `backend` unique.
- `open notes` is blocked if both a path and app/group named `notes` are plausible and no context resolves it.
- `configure current folder` is blocked if no current-directory context is available.

## Setup Ambiguity

Project setup must not guess when detection is ambiguous. The daemon should return setup choices with reasons, risks, required inputs, and recommended defaults. The TUI should ask the user to choose.

Docker Compose service selection, target port, health path, pinned port, and env write strategy require explicit input when Relaybase cannot infer them safely.

RA012C extends this rule across the runtime matrix. The Operator Agent must not assume `npm run dev`; it must call `detect_project` before planning folder/current-directory setup, show detected runtime/language/framework confidence, and ask when the runtime, command, module, Docker service, Procfile process, port strategy, or component role is ambiguous.

Approval previews for setup apply must show the runtime/language summary, selected command argv or preview string, selected port strategy, generated wrapper/profile/file diffs, and env keys with values hidden. Preview-only flows must never be described as written or applied.

## Tool Allowlist

Only registered Relaybase tools may run. Unknown tool calls are blocked. The model cannot request arbitrary shell commands.

Setup command execution must go through existing Relaybase setup/lifecycle boundaries. The Operator Agent must not execute user-supplied command strings as a general-purpose shell.

## Redaction

Redaction must run before:

- model prompts
- setup previews
- diffs
- TUI streams
- session persistence
- audit logs
- traces
- exports
- reports

Redact obvious tokens, passwords, API keys, bearer tokens, secret-looking env values, and raw Relaybase auth tokens. Redaction reports may contain counts and categories, not secret values.

## Thread Recall, Recovery, And Export

Operator Agent thread recall is active-thread-only. Model prompt context may include bounded, redacted summaries and recent safe messages from the active daemon thread. It must not include inactive thread transcripts, raw app logs, raw file diffs, raw env values, or raw audit payloads. When logs matter, the agent should use daemon log tools and store references, counts, excerpts already redacted by the log/export layer, or approved export IDs instead of copying entire log stores into thread memory.

Thread data is daemon-owned and stored in `<state-dir>/agent/agent.sqlite`. The TUI preference file is not a transcript store and must not contain chat messages, model responses, approval payloads, export contents, OpenRouter keys, Relaybase tokens, or thread IDs used as recall authority.

Recovered approvals after daemon restart are treated as pending recovered approvals. They must be rendered with explicit recovered state and require a fresh user confirmation or rejection before execution resumes. Recovery must not auto-approve, auto-run tools, or claim that a lifecycle/setup/export action completed.

JSON and Markdown chat/session exports are redacted exports. They may include thread metadata, safe messages, safe summaries, audit counts, approval/action summaries, and redaction reports. They must not include raw OpenRouter keys, Relaybase auth tokens, bearer tokens, secret-like env values, raw app log bodies, or raw file diffs containing secrets.

## Missing Implementation Diagnostics

Browser open execution, clipboard copy execution, and release tooling must report unavailable or disabled state honestly until implemented and verified. Approval continuation, redacted chat/session export, and durable agent session/audit storage exist through the daemon Agent Gateway. OpenRouter/OpenAI Agents SDK execution is available only through the daemon runtime when explicitly enabled and configured.

No fake success is allowed.
