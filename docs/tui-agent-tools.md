# TUI Operator Agent Tools

This document defines the daemon-owned tool surface for Relaybase's own in-TUI Operator Agent. Tools are not arbitrary shell commands. They are typed Relaybase daemon contracts with policy gates, redaction, recovery hints, and operation/export/setup identifiers where applicable.

As of RA010, the Agent Gateway API contract exists, the OpenRouter/OpenAI Agents SDK TypeScript Chat Completions adapter path is proven by an isolated provider module and live smoke command, the daemon Operator Agent runtime has a real Relaybase tool registry, and the Go TUI can create sessions, submit queued runs, stream events, inspect/cancel/retry runs, render approval/setup previews, and approve or reject pending daemon approvals. Read-only tools can inspect daemon state, grouped app/component state, diagnostics, bounded redacted logs, and setup previews. Mutating tools require explicit approval and route through existing daemon lifecycle, export, setup, manifest, and registry primitives. The Go TUI remains a client and approval/display surface; it does not spawn processes, write manifests, or manage lifecycle directly.

Provider availability and model behavior are external and volatile. Automated tests cover the provider/session/event contract without making network calls; any live-provider evidence must be refreshed locally before making a release claim.

## Tool Rules

- The daemon owns tool execution.
- The TUI displays previews, confirmations, streamed progress, and results.
- The model may propose tools but may not execute them directly.
- Every tool input is schema-validated.
- Destructive, file-writing, manifest-editing, env-editing, browser, clipboard, and export actions require approval when they can affect user state or reveal sensitive data.
- Tool results must not include raw tokens, raw env secrets, or unredacted log payloads.

## Agent Gateway Event Contract

Message submission persists a user message and queued run, then returns `202` without waiting for the provider. A session permits one queued, running, or approval-waiting run at a time. Failed and cancelled runs can be retried from the original persisted user message. Submission and retry accept a bounded idempotency key so safe repeats return the same persisted message/run instead of creating duplicate work. Cancellation is supported before completion, except while an already approved daemon tool is executing; Relaybase refuses to pretend that daemon work was cancelled.

Queued and running runs found after an Agent Gateway restart fail closed with `AGENT_RUN_INTERRUPTED` and explicit retry guidance. Pending approvals are recovered separately and require user reconfirmation before execution. Setup workflows can continue through separate approval-gated apply, start, and health-proof steps without requiring another user-authored prompt.

The session event stream at `GET /__hub/api/agent/sessions/:sessionId/events` emits typed model, tool, setup, and TUI action events. Tool and setup event names include:

- `tool.call_requested`
- `tool.approval_required`
- `tool.approved`
- `tool.rejected`
- `tool.started`
- `tool.completed`
- `tool.failed`
- `setup.plan_preview`
- `setup.file_write_approval_required`
- `setup.manifest_patch_approval_required`
- `setup.repair_choices`
- `setup.prove_result`
- `tui.proposed_action`

Agent session events use numeric sequence IDs. Clients reconnect with `afterSequence` or `Last-Event-ID`, replay only stored events newer than that sequence, and discard duplicates. The Go client uses bounded reconnect backoff and exposes reconnecting state instead of silently spinning.

The current tests cover the contract, queued/idempotent/cancel/retry behavior, restart recovery, blocked diagnostics, configured runtime event streaming, timeout diagnostics, prompt/session redaction, SDK tool schema construction, target clarification, approval gating, approval continuation, lifecycle operation ID propagation, log export routing, setup previews, manifest patch safety, env override redaction, and TUI-proposed actions.

## Read-Only App Tools

| Tool              | Purpose                                                     | Approval                                                     |
| ----------------- | ----------------------------------------------------------- | ------------------------------------------------------------ |
| `list_apps`       | Return app, group, component, readiness, and route summary. | No                                                           |
| `get_app_state`   | Return one app's daemon state.                              | No                                                           |
| `get_app_group`   | Return one group and its components.                        | No                                                           |
| `get_diagnostics` | Return safe daemon/TUI diagnostics.                         | No, unless including opt-in diagnostics for a model prompt   |
| `tail_logs`       | Return bounded redacted recent logs.                        | No tool approval; prompt inclusion policy may gate model use |
| `search_logs`     | Search bounded redacted logs.                               | No tool approval; prompt inclusion policy may gate model use |

The implemented tools return redacted log payloads. They do not request unbounded history and do not expose raw token/password/secret/key-like values.

## Project Inspection Tools

These read-only tools give the Operator Agent bounded `rg`/`cat`-style project inspection without exposing arbitrary shell execution. They are used when commands such as `/add <path>`, `/configure <path>`, `/register <project-path>`, or natural phrases like `find how this server starts` are missing setup details.

| Tool                              | Purpose                                                               | Approval      |
| --------------------------------- | --------------------------------------------------------------------- | ------------- |
| `project_list_files`              | List bounded project files while skipping vendor/build/cache folders. | No, read-only |
| `project_search_files`            | Search bounded text files with redacted match snippets.               | No, read-only |
| `project_read_file`               | Read one bounded redacted text file inside the selected project root. | No, read-only |
| `project_detect_start_commands`   | Return Relaybase setup detection command candidates for the project.  | No, read-only |
| `project_inspect_package_scripts` | Read package scripts and candidate package-manager commands safely.   | No, read-only |

Project inspection tools require a canonical project-root grant. The daemon derives grants only from trusted TUI current-directory context or a bounded list of user-selected roots attached to a parsed `/add`, `/configure`, or folder `/register` request; model-generated arguments cannot grant a new root. Grants are canonicalized, unavailable/stale grants fail closed, and the TUI clears its transient selected-root list after the request.

Within a granted root, tools deny traversal, skip symlinks and common generated directories, deny environment files, private keys, package/cloud credential stores, skip binary files, enforce bounded time/files/bytes/results, reject unsafe regular expressions, redact token/key/credential-URL values including common camelCase JSON/YAML/TOML fields, and never execute package scripts or shell commands. Discovered commands are candidates only; the daemon setup engine must validate and preview the selected command before any write, registration, or lifecycle action can occur.

## Lifecycle And Export Tools

| Tool          | Purpose                                 | Approval |
| ------------- | --------------------------------------- | -------- |
| `start_app`   | Request daemon-owned start operation.   | Yes      |
| `stop_app`    | Request daemon-owned stop operation.    | Yes      |
| `restart_app` | Request daemon-owned restart operation. | Yes      |
| `export_logs` | Request daemon-owned redacted export.   | Yes      |

Lifecycle tools must call the existing daemon operation APIs and return operation IDs. They must not spawn, kill, probe, or supervise processes outside Relaybase lifecycle APIs.

## Setup And Onboarding Tools

These tools wrap existing setup primitives in `src/setupApi.ts`, `src/setupEngine.ts`, `src/setup.ts`, and the manifest registry.

Current runtime coverage includes daemon-side runtime adapter metadata for JavaScript/TypeScript, Python, Go, Java, Kotlin/JVM, C#/.NET, Ruby, PHP, Docker Compose, Rust, Elixir, Scala, Clojure, Dart, native/C/C++, and Procfile projects. The adapter matrix is documented in `docs/tui-setup-runtime-matrix.md` and tested with disposable non-live fixtures. Operator Agent tools must still return diagnostics or setup questions when entrypoints, services, modules, processes, or port behavior are ambiguous.

As of RA012C, the Operator Agent prompt and tool descriptions consume that matrix directly. For folder/current-directory setup the model must call `detect_project` first, then `plan_app_setup`, then `preview_setup_writes`; it must not assume `npm run dev`. Runtime preferences, command hints, and port strategy hints are accepted as hints, while daemon detection remains the source of truth.

| Tool                     | Purpose                                                                                                                                                                                                                        | Approval                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| `detect_project`         | Inspect a project root and return package manager, scripts, framework, runtime matrix, primary runtime, command candidates, port strategies, setup questions, Docker hints, existing manifest, and health candidates.          | No, read-only                   |
| `plan_app_setup`         | Generate setup plan candidates such as managed dynamic port, framework wrapper, pinned port, Docker Compose, static preview, MCP-only, and runtime-aware command candidates. Accepts runtime/command/port hints as hints only. | No, read-only                   |
| `preview_setup_writes`   | Return manifest, wrapper, setup-profile, Docker profile, env, selected runtime command, port strategy, and redacted write previews/diffs.                                                                                      | No, read-only                   |
| `apply_setup_plan`       | Apply approved setup file writes and optional registration. Approval previews include runtime/language, selected command, selected port strategy, file writes, and env keys with values hidden.                                | Yes                             |
| `register_manifest`      | Register or update a manifest through daemon/registry APIs.                                                                                                                                                                    | Yes                             |
| `inspect_manifest`       | Read and normalize a manifest without changing it.                                                                                                                                                                             | No                              |
| `validate_manifest`      | Return manifest validation result and diagnostics.                                                                                                                                                                             | No                              |
| `patch_manifest_fields`  | Prepare or apply approved edits to safe manifest fields.                                                                                                                                                                       | Yes for apply                   |
| `set_health_route`       | Prepare or apply approved `healthUrl` changes.                                                                                                                                                                                 | Yes for apply                   |
| `set_pinned_port`        | Prepare or apply approved `upstreamPort` changes across runtime types.                                                                                                                                                         | Yes for apply                   |
| `set_component_metadata` | Prepare or apply approved `relaybase` grouping metadata changes.                                                                                                                                                               | Yes for apply                   |
| `add_env_override_safe`  | Prepare or apply approved runtime-agnostic env overrides without revealing secret values.                                                                                                                                      | Yes                             |
| `open_project_or_app`    | Start through daemon and open a route or return the URL. Browser open requires a real implementation and approval/diagnostic.                                                                                                  | Yes for start/browser open      |
| `prove_app_health`       | Run safe health proof using setup/manifest runtime metadata; lifecycle proof requires explicit approval.                                                                                                                       | Yes when lifecycle is attempted |
| `repair_app_setup`       | Propose or apply approved repair flow for ignored PORT, bad health route, stale manifest, or pinned port.                                                                                                                      | Yes for writes or lifecycle     |

Current `repair_app_setup` returns repair choices, runtime repair candidates, and previews only. Applying repair writes still goes through `apply_setup_plan` and requires approval.

Both `apply_setup_plan` and the `setup_and_start_project` tool's `apply_setup` phase are bound to the exact daemon preview. Their approvals store a SHA-256 binding over the preview plus a revision derived from the project root, selected plan, write actions, existence/changed state, and diff hunks. Approved execution regenerates the preview and verifies the binding before mutation. Missing bindings return `SETUP_PREVIEW_BINDING_REQUIRED`; changed plan/project/write state returns `SETUP_PREVIEW_STALE`. Both fail before file writes and require a fresh preview and approval.

Every path-bearing setup/manifest Agent tool passes the centralized canonical project-scope authorization before read-only, approval creation, and approved execution paths. Manifest registration and safe manifest/env mutation tools also bind the canonical target and current content digest into the approval. Missing or changed revisions return `AGENT_APPROVAL_STATE_BINDING_REQUIRED` or `AGENT_APPROVAL_STATE_STALE` with `mutationPerformed: false`.

`detect_project`, `plan_app_setup`, `preview_setup_writes`, and `repair_app_setup` now expose runtime-aware detections, command candidates, port strategies, health candidates, setup questions, and repair candidates. Tool execution must continue to route through daemon setup APIs and approval gates. The model must not convert a runtime command candidate into a file write or lifecycle action without the existing approval path. If runtime/command/module/service/process selection is ambiguous, the model must ask the user to choose from daemon-returned questions rather than guessing.

## TUI-Proposed UI Actions

The implemented tool for these is `propose_tui_action`. It returns a typed proposal for the Go TUI to apply locally. It does not mutate daemon state.

| Tool                | Purpose                                                   | Approval                      |
| ------------------- | --------------------------------------------------------- | ----------------------------- |
| `focus_pane`        | Focus a pane in the TUI.                                  | No                            |
| `pin_pane`          | Pin a pane in TUI preferences.                            | No                            |
| `unpin_pane`        | Unpin a pane in TUI preferences.                          | No                            |
| `change_pane_color` | Change a pane accent color.                               | No                            |
| `show_route`        | Show route text for the selected app/pane.                | No                            |
| `copy_route`        | Copy a route only if real clipboard support exists.       | Approval or clear user action |
| `open_browser`      | Open a route only if real browser-opening support exists. | Approval or clear user action |

If clipboard or browser support is missing, the TUI must show an honest unavailable diagnostic and offer the route as text.

## SDK Schema Boundary

Relaybase keeps Zod schemas as the internal validation contract and passes JSON Schema to the OpenAI Agents SDK tool helper. This avoids SDK rejection of optional Zod fields while preserving runtime validation before tool execution.

The exported OpenAI tool schemas intentionally use the supported subset. `validate_manifest` accepts a path only, and `patch_manifest_fields` exposes explicit safe fields. Regression coverage rejects unsupported keywords including `propertyNames`, `patternProperties`, `unevaluatedProperties`, and `prefixItems` before a schema can reach the provider.

The SDK/default execution path invokes tools with `approved:false`. Mutating tools return `approval_required` until the daemon approval flow invokes the approved execution path. Model-supplied JSON cannot set `approved:true`.

Non-secret Agent defaults persist at `<state-dir>/agent/config.json`. Explicit shell or `.env` values override persisted defaults, and no API key material is stored in that file. Diagnostics emit ready state only when no configuration blocker is present.

## Tool Audit Fields

Durable audit storage records safe summaries for:

- session id
- tool name
- safe input summary
- target app/group/component/path
- approval id when required
- operation/export/setup id when applicable
- result status
- redaction report when applicable
- started and finished timestamps
- correlation id
- safe recovery hint

Audit records must not store raw secrets or unredacted log payloads.
