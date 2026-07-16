# TUI API Contract

This is the daemon API contract for the Relaybase TUI roadmap. As of R013, lifecycle mutations can be initiated asynchronously for TUI usage, the TUI can subscribe to one global daemon SSE stream, `/__hub/api/state` includes additive app group/component read models, app log snapshots come from a durable JSONL-backed `LogStore`, backend log export writes redacted artifacts under the daemon state directory, and TUI context menus, slash commands, deterministic natural-language assistant commands, and optional LLM shell proposals call or map to those existing daemon APIs. As of RA010, daemon-owned setup/onboarding API endpoints expose detection, plan, preview, apply, manifest, open, prove, and repair behavior backed by the shared setup engine facade; daemon Agent Gateway endpoints expose safe OpenRouter config metadata, state-dir backed sessions/audit, TUI-context messages, session SSE events, approval approve/reject, diagnostics, redacted session export, an OpenAI Agents SDK TypeScript runtime, and a real daemon-owned Relaybase tool registry. The Go TUI can call the Agent Gateway, stream events, render setup/approval surfaces, and approve or reject pending daemon approvals. Read-only tools inspect daemon state, groups/components, diagnostics, bounded redacted logs, and setup previews. Mutating tools are approval-gated and route through existing daemon lifecycle, export, setup, manifest, registry, open/prove, and env override primitives.

## Source Of Truth

- API route implementation: `src/api.ts`
- API schema types: `src/apiTypes.ts`
- Normalized error helpers and correlation IDs: `src/apiErrors.ts`
- Operation tracking: `src/operationStore.ts`
- Durable app-package definitions and package-run orchestration: `src/appPackageStore.ts`, `src/appPackageService.ts`, `src/appPackageApi.ts`
- Daemon event stream: `src/daemonEvents.ts`
- App group/component read model: `src/appComponents.ts`
- Durable log store, export, and redaction: `src/logStore.ts`, `src/logExport.ts`, `src/redaction.ts`, `src/zip.ts`
- Setup/onboarding API routes and types: `src/setupApi.ts`, `src/setupApiTypes.ts`
- Daemon setup/onboarding engine facade: `src/setupEngine.ts`
- Existing setup/onboarding source primitives: `src/setup.ts`
- Agent Gateway API routes, service, runtime, context, prompts, sessions, events, tools, and types: `src/agent/api.ts`, `src/agent/gateway.ts`, `src/agent/runtime.ts`, `src/agent/context.ts`, `src/agent/prompts.ts`, `src/agent/sessionStore.ts`, `src/agent/events.ts`, `src/agent/tools/`, `src/agent/types.ts`
- OpenRouter compatibility adapter, runtime provider wrapper, and smoke runner: `src/agent/openrouterProvider.ts`, `src/agent/provider/openrouter.ts`, `src/agent/openrouterSmoke.ts`
- Current behavior is verified by the source files above and the automated Node and Go test suites.

No new schema dependency was added for R002. The repository already has `zod`, but the current daemon API is small and route-local; explicit exported TypeScript types are the smallest compatible contract layer.

## Contract Rules

- The daemon is the source of truth for lifecycle, logs, events, preferences, diagnostics, and operations.
- The safe dashboard projection at `/__hub/api/dashboard/apps` is public on the local daemon and exposes only allowlisted display fields. Full state/app inventory, logs, event streams, Agent Gateway routes, export routes, and mutation routes require the local Relaybase token because they expose sensitive operational data or perform actions. Individual operation lookup remains readable by retained opaque operation ID; operation history listing is token-gated.
- Mutation endpoints require the local Relaybase token through `Authorization: Bearer <token>` or `x-relaybase-token: <token>`.
- API responses must not include raw session tokens or unredacted secret-like values.
- API responses include `x-relaybase-correlation-id`; requests may provide that header, otherwise the daemon generates one.
- API failures return the legacy fields `error`, `code`, `recoverable`, and `details` plus the normalized `relaybaseError` envelope.
- Planned endpoints must return a normalized API error until implemented; they must not return fake success.
- Lifecycle mutations return operation IDs. TUI clients use `?async=true`, `?wait=false`, `Prefer: respond-async`, or `x-relaybase-async: true` to avoid blocking.
- Existing HTTP clients that omit async mode still receive the synchronous compatibility body after the daemon operation finishes.
- The global event stream is token-gated because it exposes cross-app lifecycle and log-availability metadata.
- Setup detect, plan, preview, inspect, validate, and repair routes are read-only.
- Setup apply, manifest registration, manifest patch apply, open, and prove routes require local daemon token auth and explicit confirmation when they can write files or start lifecycle proof.
- Agent Gateway routes are token-gated because they can expose user messages, TUI context, provider configuration metadata, approval state, and tool/audit state.
- Agent Gateway config responses report OpenRouter key presence only; raw keys are rejected and never serialized.
- Agent Gateway message runs return diagnostics when disabled, missing key, missing model, timed out, or provider-blocked. When enabled and configured, runs may stream real model events through the daemon runtime. They must not return fake assistant/model text.
- Agent Gateway tools are daemon-owned contracts. The SDK/default execution path cannot approve mutations by model-supplied JSON; approved execution must come through daemon approval policy.
- Agent message submission is durable and asynchronous. It returns a queued run with `202`; clients inspect or stream that run rather than holding the POST open for provider completion.
- Each Agent session permits at most one queued, running, or approval-waiting run. Failed and cancelled runs may be retried from their persisted original message. Idempotency keys make safe submission/retry repeats return the existing persisted work.

There is no daemon-wide HTTP request log infrastructure today. R002 returns correlation IDs in headers and error payloads; future request logging should include the same correlation ID.

## Endpoint Status

| Endpoint                                           | Method       | Status      | Auth                            | Current response                                                                                                                                                                                                                                                                     |
| -------------------------------------------------- | ------------ | ----------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/__hub/api/state`                                 | `GET`        | Implemented | Token                           | `{ "apps": AppState[], "groups": AppGroup[], "components": AppComponent[], "diagnostics"?: Diagnostic[], "generatedAt": string }`; rich records require the session token.                                                                                                           |
| `/__hub/api/apps`                                  | `GET`        | Implemented | Token                           | `{ "apps": AppStatus[] }`; full app records require the session token.                                                                                                                                                                                                               |
| `/__hub/api/dashboard/apps`                        | `GET`        | Implemented | Read-only                       | `{ "apps": DashboardAppView[] }`; safe allowlisted projection containing display id/name, runtime status, health, route availability, safe port metadata, and attention state only.                                                                                                  |
| `/__hub/api/apps/:id`                              | `GET`        | Planned     | Read-only                       | Not implemented. Current app detail endpoint is `/__hub/api/apps/:id/state`.                                                                                                                                                                                                         |
| `/__hub/api/apps/:id/state`                        | `GET`        | Implemented | Token                           | `{ "state": AppState }`; full state requires the session token.                                                                                                                                                                                                                      |
| `/__hub/api/apps/:id/start`                        | `POST`       | Implemented | Token                           | Async mode: `{ "operationId": string, "operation": LifecycleOperation }`. Compatibility mode: `{ "operationId": string, "operation": LifecycleOperation, "runtime": RuntimeView, "state": AppState }`.                                                                               |
| `/__hub/api/apps/:id/stop`                         | `POST`       | Implemented | Token                           | Async mode: `{ "operationId": string, "operation": LifecycleOperation }`. Compatibility mode: `{ "operationId": string, "operation": LifecycleOperation, "runtime": RuntimeView, "state": AppState }`.                                                                               |
| `/__hub/api/apps/:id/restart`                      | `POST`       | Implemented | Token                           | Async mode: `{ "operationId": string, "operation": LifecycleOperation }`. Compatibility mode: `{ "operationId": string, "operation": LifecycleOperation, "runtime": RuntimeView, "state": AppState }`.                                                                               |
| `/__hub/api/apps/:id/rename/preview`               | `POST`       | Implemented | Token                           | Accepts only `{ "name": string }`; returns an expiring, revision-bound preview with blockers, a name-only manifest diff, component display-name behavior, and preserved identity/lifecycle evidence. It does not mutate state.                                                       |
| `/__hub/api/apps/:id/rename/apply`                 | `POST`       | Implemented | Token + confirmation            | Accepts only `{ "previewId": string, "confirm": true }`; rechecks app identity, runtime, lifecycle activity, collisions, manifest path/content, and registry revision under the exclusive app target gate before atomically synchronizing manifest and registry names.               |
| `/__hub/api/apps/:id/unregister`                   | `GET`        | Implemented | Token                           | `{ "preview": AppUnregisterPreview }`; reports stopped state, active lifecycle work, manifest/project identity, saved-package references, blockers, and preserved evidence without mutating registry state.                                                                          |
| `/__hub/api/apps/:id/unregister`                   | `POST`       | Implemented | Token + confirmation            | Accepts `{ "confirm": true }`, rechecks all preview gates under an exclusive app target gate, and removes only the registry entry. Projects, manifests, logs, and operation history are preserved.                                                                                   |
| `/__hub/api/packages`                              | `GET`        | Implemented | Token                           | `{ "packages": Array<AppPackageDefinition & { "lastRun": AppPackageRun \| null }> }`; lists durable named packages with the newest run summary.                                                                                                                                      |
| `/__hub/api/packages`                              | `POST`       | Implemented | Token                           | Creates one validated definition from `{ "name": string, "members": string[] }`; members resolve only to registered app IDs or unique registered display names.                                                                                                                      |
| `/__hub/api/packages/:id`                          | `GET`        | Implemented | Token                           | `{ "package": AppPackageDefinition, "runs": AppPackageRun[] }`.                                                                                                                                                                                                                      |
| `/__hub/api/packages/:id`                          | `DELETE`     | Implemented | Token                           | `{ "package": AppPackageDefinition, "deleted": true }`; rejects deletion while a package run is active.                                                                                                                                                                              |
| `/__hub/api/packages/:id/change/preview`           | `POST`       | Implemented | Token                           | Accepts `{ "expectedRevision": number, "change": { "kind": "add-member" \| "rename" \| "replace-members", ... } }`; returns an expiring preview without mutating package state.                                                                                                      |
| `/__hub/api/packages/:id/change/apply`             | `POST`       | Implemented | Token + confirmation            | Accepts only `{ "previewId": string, "confirm": true }`; rechecks revision, active runs, name collisions, exact registered member IDs, capacity, and preview integrity before one compare-and-increment update.                                                                      |
| `/__hub/api/packages/:id/delete/preview`           | `POST`       | Implemented | Token                           | Accepts `{ "expectedRevision": number }`; reports active-run blockers and the apps, files, manifests, and historical runs that deletion preserves.                                                                                                                                   |
| `/__hub/api/packages/:id/delete/apply`             | `POST`       | Implemented | Token + confirmation            | Accepts only `{ "previewId": string, "confirm": true }`; rechecks revision and active-run state, then deletes only the package definition while retaining apps and historical runs.                                                                                                  |
| `/__hub/api/packages/:id/launch`                   | `POST`       | Implemented | Token                           | Starts daemon-owned package orchestration and returns `202 { "runId": string, "run": AppPackageRun }`.                                                                                                                                                                               |
| `/__hub/api/package-runs/:id`                      | `GET`        | Implemented | Token                           | `{ "run": AppPackageRun }`; clients poll this route for package progress.                                                                                                                                                                                                            |
| `/__hub/api/package-runs/:id/retry`                | `POST`       | Implemented | Token                           | Creates a new retry run for failed/skipped/interrupted members and returns `202 { "runId": string, "run": AppPackageRun }`.                                                                                                                                                          |
| `/__hub/api/package-runs/:id/abort`                | `POST`       | Implemented | Token                           | Requests abort and returns `{ "run": AppPackageRun }`; already-enqueued or started apps are not stopped.                                                                                                                                                                             |
| `/__hub/api/operations/:id`                        | `GET`        | Implemented | Read-only for local daemon      | `{ "operation": LifecycleOperation }`, or normalized `OPERATION_NOT_FOUND` error.                                                                                                                                                                                                    |
| `/__hub/api/operations`                            | `GET`        | Implemented | Token                           | `{ "operations": LifecycleOperation[], "count": number, "filters": object }`; lists the bounded durable ledger with status/type/target/limit filters.                                                                                                                                |
| `/__hub/api/events`                                | `GET`        | Implemented | Token                           | SSE stream of typed `DaemonEvent` payloads. No missed-event replay; reconnect clients must refresh `/__hub/api/state`.                                                                                                                                                               |
| `/__hub/api/apps/:id/logs`                         | `GET`        | Implemented | Token                           | Durable snapshot with paging: `{ "id": string, "logs": string[], "events": LogEvent[], "page": LogPage, "diagnostics": Diagnostic[], "streamUrl": string }`                                                                                                                          |
| `/__hub/api/apps/:id/logs/stream`                  | `GET`        | Implemented | Token                           | SSE events: `status`, `snapshot`, `log`, `ping`.                                                                                                                                                                                                                                     |
| `/__hub/api/logs/export`                           | `POST`       | Implemented | Token                           | Starts a real redacted log export and returns `{ "export": LogExportResult }`. Current implementation completes during the request and writes under `<state-dir>/exports/<exportId>/`.                                                                                               |
| `/__hub/api/exports/:id`                           | `GET`        | Implemented | Token                           | `{ "export": LogExportResult }`, or normalized `LOG_EXPORT_NOT_FOUND` error.                                                                                                                                                                                                         |
| `/__hub/api/preferences`                           | `GET`, `PUT` | Planned     | Read for `GET`, token for `PUT` | Not implemented. R010 TUI preferences are stored locally under `<state-dir>/tui/preferences.json` until the daemon preference API exists.                                                                                                                                            |
| `/__hub/api/diagnostics`                           | `GET`        | Planned     | Read-only                       | Not implemented. Token diagnostics exist in mutation error details and MCP `diagnose_token`, not as this HTTP route.                                                                                                                                                                 |
| `/__hub/api/setup/detect`                          | `POST`       | Implemented | Read-only                       | `{ "setup": SetupDetectResult }`; detects package manager, framework, scripts, port hints, Docker Compose hints, MCP hints, existing manifest analysis, existing launch wrapper, and existing setup profile without writing files.                                                   |
| `/__hub/api/setup/plans`                           | `POST`       | Implemented | Read-only                       | `{ "setup": { "cwd": string, "choices": SetupPlanChoice[], "diagnostics": SetupDiagnostic[] } }`; returns daemon-generated setup plan choices and port strategies.                                                                                                                   |
| `/__hub/api/setup/preview`                         | `POST`       | Implemented | Read-only                       | `{ "setup": SetupPlanPreview }`; returns safe file write previews and diffs for the selected plan. `components[]` returns preview-only component-as-app plans for grouped frontend/backend setup.                                                                                    |
| `/__hub/api/setup/apply`                           | `POST`       | Implemented | Token + confirmation            | `{ "setup": SetupApplyResult }`; applies the selected setup plan through the daemon setup engine, writes approved artifacts, and registers the manifest without starting the app.                                                                                                    |
| `/__hub/api/setup/register-manifest`               | `POST`       | Implemented | Token                           | `{ "setup": RegisterManifestResult }`; registers an existing manifest through the daemon registry and emits `app.registered`.                                                                                                                                                        |
| `/__hub/api/setup/register/preview`                | `POST`       | Implemented | Read-only                       | Requires explicit `verificationMode: "quick" \| "none"`; returns an exact folder-or-manifest registration preview with file/registry risks, bounded health candidates, and whether confirmation will start and stop the app.                                                         |
| `/__hub/api/setup/register/apply`                  | `POST`       | Implemented | Token + confirmation            | Applies the exact preview, then runs `quick` verification or zero lifecycle work for `none`. Returns verified, unverified, verification-failed, or cleanup-failed state; successful proof ends stopped.                                                                              |
| `/__hub/api/setup/register/repair/preview`         | `POST`       | Implemented | Read-only                       | Resolves a repair from retained lifecycle attempts, binds every affected file revision, and returns the exact manifest-only or multi-file setup-plan preview plus new quick-proof intent. Cleanup failure blocks preview.                                                            |
| `/__hub/api/setup/register/repair/apply`           | `POST`       | Implemented | Token + confirmation            | Applies only the exact non-stale previewed file plan, re-registers, and performs one new quick proof. It never repeats an unchanged failed launch-plan digest; a blocked duplicate retains the prior actionable repairs without counting as another lifecycle attempt.               |
| `/__hub/api/setup/register/verification/cancel`    | `POST`       | Implemented | Token                           | Requests abort of one active app verification. Process cleanup remains daemon-owned and the original apply request returns the terminal inspectable result.                                                                                                                          |
| `/__hub/api/setup/inspect-manifest`                | `POST`       | Implemented | Read-only                       | `{ "setup": ExistingManifestAnalysis }`; reads and validates an existing manifest, with secret-like values redacted.                                                                                                                                                                 |
| `/__hub/api/setup/validate-manifest`               | `POST`       | Implemented | Read-only                       | `{ "setup": ExistingManifestAnalysis }`; validates an in-body manifest object or an existing manifest path.                                                                                                                                                                          |
| `/__hub/api/setup/patch-manifest/preview`          | `POST`       | Implemented | Read-only                       | `{ "setup": ManifestPatchPlan }`; previews safe manifest field patches and diffs without writing files.                                                                                                                                                                              |
| `/__hub/api/setup/patch-manifest/apply`            | `POST`       | Implemented | Token + confirmation            | `{ "setup": ManifestPatchResult }`; atomically writes an approved safe manifest patch.                                                                                                                                                                                               |
| `/__hub/api/setup/open`                            | `POST`       | Implemented | Token + confirmation            | `{ "setup": OpenProjectResult }`; delegates to daemon setup/open primitives. It defaults to `noBrowser: true` for TUI safety unless the client explicitly asks otherwise.                                                                                                            |
| `/__hub/api/setup/prove`                           | `POST`       | Implemented | Token + confirmation            | `{ "setup": ProveHealthResult }`; delegates to daemon health/proof primitives and may run lifecycle proof only after confirmation.                                                                                                                                                   |
| `/__hub/api/setup/repair`                          | `POST`       | Implemented | Read-only                       | `{ "setup": RepairSetupResult }`; returns repair choices and previews only. Apply still requires `/setup/apply` confirmation.                                                                                                                                                        |
| `/__hub/api/setup/operations/:id`                  | `GET`        | Diagnostic  | Read-only                       | Async setup operation storage is not implemented yet. The route returns normalized `SETUP_OPERATION_NOT_FOUND`; clients should not pretend replay or polling exists for setup.                                                                                                       |
| `/__hub/api/agent/config`                          | `GET`        | Implemented | Token                           | `{ "agent": { "config": AgentConfig } }`; safe OpenRouter config metadata with key source and configured boolean only.                                                                                                                                                               |
| `/__hub/api/agent/config`                          | `PUT`        | Implemented | Token                           | Updates safe agent config fields. Raw API keys are rejected with `AGENT_RAW_API_KEY_NOT_ALLOWED`.                                                                                                                                                                                    |
| `/__hub/api/agent/sessions`                        | `POST`       | Implemented | Token                           | `{ "agent": { "session": AgentSession } }`; creates a redacted Agent Gateway session with optional `TuiAgentContext` and persists it under the daemon state directory when configured.                                                                                               |
| `/__hub/api/agent/sessions`                        | `GET`        | Implemented | Token                           | `{ "agent": { "sessions": AgentSession[] } }`; lists redacted sessions from the daemon session store.                                                                                                                                                                                |
| `/__hub/api/agent/sessions/active`                 | `GET`        | Implemented | Token                           | `{ "agent": { "session": AgentSession \| null } }`; returns the daemon-selected active Operator Agent thread. Active-thread metadata is stored in SQLite, not TUI preferences.                                                                                                       |
| `/__hub/api/agent/sessions/:sessionId`             | `GET`        | Implemented | Token                           | `{ "agent": { "session": AgentSession } }`, or normalized `AGENT_SESSION_NOT_FOUND`.                                                                                                                                                                                                 |
| `/__hub/api/agent/sessions/:sessionId`             | `PATCH`      | Implemented | Token                           | `{ "agent": { "session": AgentSession } }`; updates safe thread metadata such as title, privacy mode, active flag, and redacted context. Raw secrets are sanitized before persistence.                                                                                               |
| `/__hub/api/agent/sessions/:sessionId/activate`    | `POST`       | Implemented | Token                           | `{ "agent": { "session": AgentSession } }`; switches the active daemon thread. The TUI must refresh its displayed thread state from the returned session or session list.                                                                                                            |
| `/__hub/api/agent/sessions/:sessionId/clear`       | `POST`       | Implemented | Token                           | `{ "agent": { "session": { "sessionId": string, "cleared": true } } }`; soft-clears a thread by marking it deleted and recording a safe audit event.                                                                                                                                 |
| `/__hub/api/agent/sessions/:sessionId`             | `DELETE`     | Implemented | Token                           | Alias for session clear; returns `{ "agent": { "session": { "sessionId": string, "cleared": true } } }`.                                                                                                                                                                             |
| `/__hub/api/agent/sessions/:id/export`             | `GET`        | Implemented | Token                           | `{ "agent": { "export": AgentSessionExportResult } }`; writes a redacted chat/session/audit artifact under `<state-dir>/agent/exports/`. `format=json` writes JSON and `format=markdown` writes Markdown.                                                                            |
| `/__hub/api/agent/sessions/:id/context-preview`    | `GET`        | Implemented | Token                           | `{ "agent": { "contextPreview": AgentThreadContextPreview } }`; returns active-thread-only recall metadata, recent redacted messages, pending/recovered approval counts, and explicit no-raw-secrets/logs/diffs policy flags.                                                        |
| `/__hub/api/agent/sessions/:id/runs`               | `GET`        | Implemented | Token                           | `{ "agent": { "runs": AgentRun[] } }`; returns persisted runs for the session.                                                                                                                                                                                                       |
| `/__hub/api/agent/sessions/:id/runs/active`        | `GET`        | Implemented | Token                           | `{ "agent": { "run": AgentRun \| null } }`; returns the single queued/running/approval-waiting run when present.                                                                                                                                                                     |
| `/__hub/api/agent/sessions/:id/runs/:runId`        | `GET`        | Implemented | Token                           | `{ "agent": { "run": AgentRun } }`, or normalized session/run-not-found errors.                                                                                                                                                                                                      |
| `/__hub/api/agent/sessions/:id/runs/:runId/cancel` | `POST`       | Implemented | Token                           | Cancels queued/model/approval-waiting work and rejects its pending approvals. An already executing approved daemon tool fails with `AGENT_APPROVED_TOOL_IN_PROGRESS` instead of claiming cancellation.                                                                               |
| `/__hub/api/agent/sessions/:id/runs/:runId/retry`  | `POST`       | Implemented | Token                           | Requeues a failed/cancelled run from its original persisted user message and returns `202`. Accepts `Idempotency-Key` or matching body `idempotencyKey`.                                                                                                                             |
| `/__hub/api/agent/sessions/:id/messages`           | `POST`       | Implemented | Token                           | Accepts `{ "content": string, "context"?: TuiAgentContext, "idempotencyKey"?: string }` or `Idempotency-Key`; persists a redacted message plus queued run and returns `202`. Disabled/missing config becomes a diagnostic failed run. Configured execution continues asynchronously. |
| `/__hub/api/agent/sessions/:id/events`             | `GET`        | Implemented | Token                           | SSE stream of typed `AgentRunEvent` payloads with numeric IDs. `afterSequence=<n>` or `Last-Event-ID` replays stored events newer than the requested sequence. The Go client reconnects with bounded backoff and discards duplicate replay sequences.                                |
| `/__hub/api/agent/approvals/:id/approve`           | `POST`       | Implemented | Token                           | Resolves an existing pending approval as approved, or returns normalized `AGENT_APPROVAL_NOT_FOUND` / `AGENT_APPROVAL_ALREADY_RESOLVED`.                                                                                                                                             |
| `/__hub/api/agent/approvals/:id/reject`            | `POST`       | Implemented | Token                           | Resolves an existing pending approval as rejected, or returns normalized `AGENT_APPROVAL_NOT_FOUND` / `AGENT_APPROVAL_ALREADY_RESOLVED`.                                                                                                                                             |
| `/__hub/api/agent/diagnostics`                     | `GET`        | Implemented | Token                           | `{ "agent": { "diagnostics": AgentDiagnostic[] } }`; reports disabled/missing-key/missing-model/runtime status.                                                                                                                                                                      |

R011 context menus and slash commands do not add daemon endpoints. Lifecycle menu actions and `/launch`, `/stop`, and `/restart` call the implemented async lifecycle endpoints. Log export menu actions and `/logs export ...` call `/__hub/api/logs/export` with redaction enabled by default.

R012 deterministic natural-language assistant commands do not add daemon endpoints. The TUI parses supported phrases locally, resolves targets through the same slash-command resolver, and then uses existing daemon APIs only after the same confirmation gates:

- lifecycle phrases call `/__hub/api/apps/:id/start`, `/__hub/api/apps/:id/stop`, or `/__hub/api/apps/:id/restart` after confirmation
- log export phrases call `/__hub/api/logs/export` after confirmation
- log viewing phrases query `/__hub/api/apps/:id/logs` when the target pane resolves
- `what is broken?` and `show diagnostics` read current in-memory TUI state and the last daemon state snapshot; they do not call a planned diagnostics endpoint

The base R013 optional LLM assistant shell did not add daemon endpoints or model execution. The RA Agent Gateway now owns remote model execution through the daemon when explicitly enabled/configured, while deterministic slash/natural commands remain the local fallback. Model-proposed lifecycle, setup, manifest, browser/clipboard-adjacent, or export actions must become daemon approval previews and use the same confirmation-gated daemon APIs above.

RA004 Agent Gateway endpoints add the daemon contract for the Operator Agent. RA005 adds the provider compatibility path. `npm run agent:smoke:openrouter` makes real OpenRouter calls when `OPENROUTER_API_KEY` and `RELAYBASE_AGENT_MODEL` are set, checks basic completion, checks a harmless function-tool call through `@openai/agents`, and checks streaming. Missing key/model states exit nonzero as blocked. This command does not add app lifecycle, setup, file-write, or export tools.

RA006 wires the Agent Gateway to a daemon-side Operator Agent runtime. Configured runs create an OpenAI Agents SDK `Agent`, use the OpenRouter Chat Completions-compatible provider path, build bounded/redacted TUI/daemon prompt context, stream `model.request_started`, `model.delta`, `model.completed`, `answer`, and `run.completed` events, and persist redacted session messages. Disabled, missing-key, missing-model, timeout, and provider errors emit `diagnostic`, `blocked`, and `run.failed`.

RA009 added state-dir backed Agent Gateway session/audit persistence. OA-THREADS-001 moves that persistence source of truth to `agent/agent.sqlite`, with one-time legacy import from `agent/sessions.json` and `agent/audit.jsonl` when those files are present. The daemon keeps budget-block diagnostics before remote model calls, local trace/audit events, redacted chat/session export under `agent/exports/`, and SQLite corruption quarantine diagnostics.

OA-THREADS-002 adds daemon thread lifecycle routes for active-thread read, activate/switch, metadata patch/rename, soft clear, JSON/Markdown export, context preview, and session-event replay by sequence. Active-thread recall is scoped to the active thread only; switching threads changes the daemon context used for future model prompts and does not merge transcripts into TUI preferences.

RA010 connects the Go TUI to the Agent Gateway. The TUI fetches config and diagnostics, creates sessions, sends messages with `TuiAgentContext`, subscribes to session events, renders model/setup/tool diagnostics and previews, and calls approval approve/reject endpoints. OA-THREADS-003 wires thread slash commands and menu actions to the daemon session routes. The Go TUI does not call OpenRouter directly and does not perform lifecycle, setup file writes, manifest patches, or chat/thread persistence directly.

TUI-USAGE-003 adds the token-gated, read-only `GET /__hub/api/agent/usage?scope=active-thread` route. `/usage` renders the most recent completed model call and active-thread totals from daemon-persisted usage audit records. Token counts remain integers; cost values carry reported, estimated, mixed, partial, or unavailable provenance. Opening or refreshing the menu never calls OpenRouter or starts a model run.

`TuiAgentContext.authorizedProjectRoots` is a bounded list that the Go client populates only after parsing an explicit `/add`, `/configure`, or folder `/register` target. The daemon canonicalizes those roots into grants for the bounded `project_*` inspection tools; arbitrary model/tool arguments cannot grant a new inspection root. The transient TUI list is cleared after message submission or failure. This contract does not by itself assert root confinement for other setup/manifest tools; each such tool must enforce the same grant explicitly before that claim applies.

RA007 exposes the daemon-owned Relaybase tool registry to the Operator Agent runtime:

- read-only: `list_apps`, `get_app_state`, `get_app_group`, `get_diagnostics`, `tail_logs`, `search_logs`, `project_list_files`, `project_search_files`, `project_read_file`, `project_detect_start_commands`, `project_inspect_package_scripts`, `detect_project`, `plan_app_setup`, `preview_setup_writes`, `inspect_manifest`, `validate_manifest`, `repair_app_setup`, `propose_tui_action`
- approval-gated: `start_app`, `stop_app`, `restart_app`, `export_logs`, `apply_setup_plan`, `register_manifest`, `patch_manifest_fields`, `set_health_route`, `set_pinned_port`, `set_component_metadata`, `add_env_override_safe`, `open_project_or_app`, `prove_app_health`

Lifecycle tools return operation IDs from the existing operation store. Export tools return export IDs and redacted export results from the daemon export service. Setup/manifest tools call the existing setup API helpers and never write files without the approved execution path. TUI-proposed actions return typed local UI proposals and do not mutate daemon state.

## Exported Types

`src/apiTypes.ts` exports these API contract types:

```text
RelaybaseState
AppState
AppStatus
AppGroup
AppComponent
LifecycleOperation
OperationStatus
LogEvent
LogQuery
LogExportRequest
LogExportResult
PreferenceState
Diagnostic
DaemonEventType
DaemonEvent
RelaybaseError
RelaybaseErrorResponse
AgentConfig
AgentProviderConfig
AgentSession
AgentMessage
AgentRun
AgentRunEvent
AgentApproval
AgentToolCall
AgentToolResult
AgentDiagnostic
AgentAuditEvent
TuiAgentContext
TuiProposedAction
AgentSetupContext
AgentSetupPlanReference
AgentFileWriteApproval
AgentManifestPatchApproval
AgentOpenRouteApproval
SetupDetectRequest
SetupDetectResult
SetupPlanRequest
SetupPlan
SetupPlanChoice
SetupPlanPreview
SetupApplyRequest
SetupApplyResult
FileWritePlan
FileWritePreview
FileDiff
ExistingManifestAnalysis
ExistingSetupArtifactAnalysis
ManifestPatchRequest
ManifestPatchPlan
ManifestPatchResult
RegisterManifestRequest
RegisterManifestResult
OpenProjectRequest
OpenProjectPlan
OpenProjectResult
ProveHealthRequest
ProveHealthResult
RepairSetupRequest
RepairSetupPlan
RepairSetupResult
PortStrategy
FrameworkKind
PackageManagerKind
ComponentSetupMetadata
SetupDiagnostic
SetupApprovalRisk
```

`AppState`, `AppStatus`, and `LogEvent` alias the current daemon runtime shapes so existing endpoint behavior stays compatible. `AppGroup` and `AppComponent` are current R005 read models derived from existing app records and runtime state; they do not introduce native multi-process lifecycle ownership.

`SetupPlanPreview.componentPlans` represents component-as-app setup metadata for grouped panes. It does not introduce native manifest `components[]`, and it does not let the TUI own multiple app processes.

## Agent Gateway Event Examples

Configured message flow:

```text
event: run.started
event: model.request_started
event: model.delta
event: model.completed
event: answer
event: run.completed
```

Blocked message flow:

```text
event: run.started
event: diagnostic
event: blocked
event: run.failed
```

Disabled or missing config diagnostic:

```json
{
  "id": "agent.config.openrouter_key_missing",
  "severity": "error",
  "code": "OPENROUTER_API_KEY_MISSING",
  "message": "OPENROUTER_API_KEY is not set in the daemon environment.",
  "checkedAt": "2026-06-02T00:00:00.000Z",
  "userAction": "Set OPENROUTER_API_KEY before enabling remote Operator Agent runs."
}
```

Setup file-write approval event payload shape:

```json
{
  "kind": "file_write",
  "setupPlanId": "managed-web",
  "risk": "high",
  "fileWritePlan": {
    "root": "C:\\project",
    "approvalRequired": true,
    "writes": [
      {
        "path": "relaybase.app.json",
        "action": "create",
        "reason": "Register app",
        "preview": "{ \"env\": { \"API_KEY\": \"[redacted]\" } }",
        "diff": {
          "path": "relaybase.app.json",
          "beforeExists": false,
          "afterExists": true,
          "changed": true,
          "hunks": ["+ API_KEY=[redacted]"]
        }
      }
    ],
    "risks": []
  }
}
```

Manifest patch approval event payload shape:

```json
{
  "kind": "manifest_patch",
  "risk": "medium",
  "manifestPatchPlan": {
    "cwd": "C:\\project",
    "manifestPath": "relaybase.app.json",
    "manifest": { "id": "notes", "name": "Notes", "command": "npm.cmd run dev" },
    "patchedManifest": {
      "id": "notes",
      "name": "Notes",
      "command": "npm.cmd run dev",
      "healthUrl": "/api/health"
    },
    "fileWritePlan": {
      "root": "C:\\project",
      "approvalRequired": true,
      "writes": [],
      "risks": []
    },
    "diagnostics": []
  }
}
```

## Error Envelope

All API failures handled by `src/api.ts` return:

```ts
type RelaybaseError = {
  code: string;
  message: string;
  detail?: unknown;
  retryable: boolean;
  userAction?: string;
  correlationId: string;
};
```

The wire response keeps the legacy fields and adds the normalized envelope:

```json
{
  "error": "Unauthorized Relaybase mutation.",
  "code": "UNAUTHORIZED_MUTATION",
  "recoverable": true,
  "details": {
    "requiredForMutations": true,
    "acceptedHeaders": ["Authorization: Bearer <token>", "x-relaybase-token: <token>"],
    "stateDir": "<state-dir>",
    "tokenPath": "<state-dir>/session-token",
    "tokenPresent": true,
    "mismatchHint": "Discovery can be healthy while mutations return 401 if the client reads a token from a different Relaybase state directory."
  },
  "correlationId": "request-or-generated-id",
  "relaybaseError": {
    "code": "UNAUTHORIZED_MUTATION",
    "message": "Unauthorized Relaybase mutation.",
    "detail": {
      "requiredForMutations": true,
      "acceptedHeaders": ["Authorization: Bearer <token>", "x-relaybase-token: <token>"],
      "stateDir": "<state-dir>",
      "tokenPath": "<state-dir>/session-token",
      "tokenPresent": true,
      "mismatchHint": "Discovery can be healthy while mutations return 401 if the client reads a token from a different Relaybase state directory."
    },
    "retryable": true,
    "userAction": "Run relaybase diagnose_token or use the session token from this daemon state directory.",
    "correlationId": "request-or-generated-id"
  }
}
```

Error detail redaction removes secret-like object keys and obvious inline token/password/API-key values before serialization. Safe token diagnostics such as token presence and token path remain visible.

## Current State Snapshot

`GET /__hub/api/state` currently returns:

```json
{
  "apps": [],
  "groups": [],
  "components": [],
  "generatedAt": "2026-06-01T00:00:00.000Z"
}
```

Each `apps[]` entry is an `AppState` with runtime status, route health, readiness, URLs, action availability, recent logs, and optional MCP child state. `groups[]` and `components[]` are additive TUI read models. The token value itself is never returned.

If manifest component metadata is malformed, `/state` includes safe diagnostics:

```json
{
  "diagnostics": [
    {
      "id": "manifest.bad-meta.RELAYBASE_COMPONENT_ROLE_INVALID.0",
      "severity": "warning",
      "message": "Manifest field relaybase.componentRole must be one of: frontend, backend, worker, database, service, other.",
      "checkedAt": "2026-06-01T00:00:00.000Z",
      "detail": {
        "appId": "bad-meta",
        "field": "relaybase.componentRole",
        "code": "RELAYBASE_COMPONENT_ROLE_INVALID"
      },
      "userAction": "Fix the relaybase metadata block in the app manifest. Relaybase is using normalized fallback component metadata until it is valid."
    }
  ]
}
```

## App Groups And Components

R005 supports component-as-app metadata. Each existing app remains one daemon-owned command/process, but its manifest may include:

```json
{
  "relaybase": {
    "groupId": "notes",
    "componentRole": "frontend",
    "displayName": "Notes",
    "paneLabel": "frontend",
    "paneOrder": 10
  }
}
```

Supported roles:

```text
frontend
backend
worker
database
service
other
```

`AppComponent`:

```ts
type AppComponent = {
  appId: string;
  groupId: string;
  role: "frontend" | "backend" | "worker" | "database" | "service" | "other";
  paneLabel: string;
  paneOrder: number;
  displayName: string;
  route: {
    humanUrl: string;
    agentUrl: string;
    reachable: boolean;
    health?: RouteHealth;
  };
  pid?: number;
  port?: number;
  status: "stopped" | "starting" | "running" | "stopping" | "failed" | "degraded";
  lastError: string | null;
};
```

`AppGroup`:

```ts
type AppGroup = {
  groupId: string;
  displayName: string;
  components: AppComponent[];
  aggregateStatus: "failed" | "degraded" | "starting" | "running" | "stopped";
};
```

Aggregate status rules are applied in this order:

1. `failed` if any component is failed.
2. `starting` if any component is starting and none failed.
3. `stopped` if all components are stopped.
4. `running` if every component is running and healthy.
5. `degraded` for mixed states, stopped/running splits, stopping components, or running components that are not fully ready.

Apps without `relaybase` metadata appear as one implicit component with `groupId` equal to the app id, `role: "other"`, `paneLabel: "app"`, `paneOrder: 100`, and `displayName` from the app name. Future native manifest `components[]` can map into this read model without removing the component-as-app metadata bridge.

## Lifecycle Mutations

Start, stop, and restart are daemon-owned operation requests. The TUI should use async mode:

```json
{
  "operationId": "op_...",
  "operation": {
    "operationId": "op_...",
    "operationType": "start",
    "target": { "type": "app", "id": "app-id" },
    "status": "queued",
    "createdAt": "2026-06-01T00:00:00.000Z"
  }
}
```

Existing clients that omit async mode receive the compatibility response after the daemon finishes the operation:

```json
{
  "operationId": "op_...",
  "operation": {
    "id": "op_...",
    "operationId": "op_...",
    "operationType": "start",
    "status": "succeeded"
  },
  "runtime": {},
  "state": {}
}
```

Duplicate active requests for the same app and lifecycle action are deduplicated and return the active operation ID. Conflicting active lifecycle actions for the same app return a normalized `OPERATION_CONFLICT` error. Unknown apps and thrown lifecycle failures are recorded as failed operations in async mode. Startup or cleanup timeout outcomes are recorded as `timed_out` operations with a `LIFECYCLE_TIMED_OUT` `RelaybaseError`.

The TUI must treat the daemon response as authoritative and must not move lifecycle sequencing, timeout handling, process cleanup, or stop verification into the Go client.

## App Packages

An app package is a durable, ordered named list of existing registered app IDs. It is not a new lifecycle primitive: package orchestration uses the existing daemon lifecycle enqueue boundary for every member and the Go TUI never starts processes itself.

```ts
type AppPackageDefinition = {
  id: string;
  name: string;
  normalizedName: string;
  memberAppIds: string[];
  revision: number;
  createdAt: string;
  updatedAt: string;
};

type AppPackageRunStatus = "queued" | "running" | "succeeded" | "partial" | "failed" | "aborted" | "interrupted";

type AppPackageRunMember = {
  ordinal: number;
  appId: string;
  state:
    | "pending"
    | "starting"
    | "started"
    | "skipped_already_running"
    | "failed"
    | "skipped_preflight"
    | "skipped_aborted"
    | "skipped_interrupted"
    | "interrupted";
  lifecycleOperationId?: string;
  errorCode?: string;
  errorMessage?: string;
  retryable?: boolean;
  startedAt?: string;
  finishedAt?: string;
};

type AppPackageRun = {
  id: string;
  packageId: string;
  packageName: string;
  packageRevision: number;
  status: AppPackageRunStatus;
  abortRequested: boolean;
  retryOfRunId?: string;
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
  finishedAt?: string;
  members: AppPackageRunMember[];
};
```

Definitions are stored under the daemon state directory in `packages/packages.sqlite` using WAL and full synchronous writes. Package creation validates every member before writing the definition. Rename, add-member, replace-members, and deletion use short-lived previews bound to the package stable ID, current revision, proposed definition hash, and operation. Apply serializes definition mutations per package, rechecks current registered app IDs and active runs, and uses a compare-and-increment SQLite update. Rename changes only the human-facing name; membership replacement preserves explicit order; deletion removes only the definition. Historical run snapshots retain the package name, revision, and members captured when they ran.

Launch rechecks that every stored app is still registered before it enqueues any member; a failed preflight therefore starts nothing. The service runs at most four member starts concurrently, records each existing lifecycle operation ID, treats healthy already-running apps as skipped, continues after individual failures, and does not roll back apps that already started. Retry creates a new run containing only failed, skipped, or interrupted members. Abort only prevents work that has not been enqueued. On daemon restart, unfinished runs are reconciled as interrupted without implicit relaunch.

Package route errors use the normal token-gated Relaybase error envelope and do not serialize raw process error text. The TUI polls the run endpoint and displays only safe run/member status and safe error code/message summaries.

## Operation Status

Implemented operation status values:

```text
queued
running
succeeded
failed
cancelled
timed_out
```

The exported type still includes planned values such as `waiting_for_approval`, `aborted`, and `skipped`, but R003 lifecycle operations emit only the implemented values above.

`GET /__hub/api/operations/:id` returns:

```json
{
  "operation": {
    "operationId": "op_...",
    "operationType": "restart",
    "target": { "type": "app", "id": "app-id" },
    "appId": "app-id",
    "status": "running",
    "createdAt": "2026-06-01T00:00:00.000Z",
    "startedAt": "2026-06-01T00:00:00.000Z",
    "updatedAt": "2026-06-01T00:00:00.000Z",
    "finishedAt": "2026-06-01T00:00:00.000Z",
    "progress": 100,
    "messages": [],
    "events": [],
    "result": {},
    "error": {
      "code": "LIFECYCLE_TIMED_OUT",
      "message": "App did not become healthy before the startup timeout.",
      "retryable": true,
      "correlationId": "request-or-generated-id"
    }
  }
}
```

When constructed with the daemon state directory, `OperationStore` persists a bounded, redacted ledger in `<state-dir>/operations/operations.sqlite` using SQLite WAL and full synchronous writes. On restart, queued/running rows fail closed as retryable `LIFECYCLE_OPERATION_INTERRUPTED` records because completion cannot be inferred. The store still bridges its `subscribe` hook into the global `/__hub/api/events` stream.

## Global Event Stream

`GET /__hub/api/events` is the R004 global daemon event stream. It uses Server-Sent Events with:

```text
retry: 3000
id: <monotonic sequence>
event: <DaemonEvent.type>
data: <DaemonEvent JSON>
```

The stream also writes heartbeat comments:

```text
: heartbeat 2026-06-01T00:00:00.000Z
```

The endpoint requires `Authorization: Bearer <token>` or `x-relaybase-token: <token>`. Missing or wrong auth returns a normalized `UNAUTHORIZED_EVENT_STREAM` error before SSE headers are written.

Initial connection emits `daemon.ready`:

```json
{
  "id": "1",
  "sequence": 1,
  "type": "daemon.ready",
  "at": "2026-06-01T00:00:00.000Z",
  "data": {
    "daemon": {
      "status": "running",
      "host": "127.0.0.1",
      "port": 7777
    },
    "reconnect": {
      "replay": "not_implemented",
      "requiresStateRefresh": true,
      "lastEventId": null
    }
  }
}
```

It also emits the current daemon health:

```json
{
  "id": "2",
  "sequence": 2,
  "type": "daemon.health_changed",
  "at": "2026-06-01T00:00:00.000Z",
  "data": {
    "daemon": {
      "status": "running",
      "host": "127.0.0.1",
      "port": 7777
    }
  }
}
```

R004 does not implement missed-event replay. If the client reconnects with `Last-Event-ID`, the daemon reports that value in `daemon.ready.data.reconnect.lastEventId`, but the client must fetch `/__hub/api/state` to recover an authoritative snapshot.

Implemented emitted event types:

```text
daemon.ready
daemon.health_changed
app.registered
app.unregistered
package.created
package.updated
package.deleted
app.state_changed
app.lifecycle_operation_started
app.lifecycle_operation_progress
app.lifecycle_operation_completed
app.lifecycle_operation_failed
route.health_changed
log.line_available
log.stream_rotated
export.started
export.progress
export.completed
export.failed
setup.detected
setup.plan_created
setup.preview_created
setup.apply_started
setup.apply_completed
setup.apply_failed
setup.registered
setup.prove_started
setup.prove_completed
setup.repair_plan_created
setup.repair_applied
```

Reserved typed event types not emitted until the corresponding features exist:

```text
preference.changed
```

`app.registered` omits manifest env values and command text:

```json
{
  "type": "app.registered",
  "appId": "notes",
  "data": {
    "app": {
      "id": "notes",
      "name": "Notes",
      "protocol": "http",
      "cwd": "<path>",
      "healthUrl": "/health",
      "upstreamPort": 3000,
      "manifestPath": "<path>",
      "createdAt": "2026-06-01T00:00:00.000Z",
      "updatedAt": "2026-06-01T00:00:00.000Z",
      "envVarCount": 1,
      "mcpEnabled": false,
      "relaybase": {
        "groupId": "notes",
        "componentRole": "frontend",
        "displayName": "Notes",
        "paneLabel": "frontend",
        "paneOrder": 10
      }
    }
  }
}
```

Lifecycle operation events include safe operation metadata but omit full operation `result` payloads:

```json
{
  "type": "app.lifecycle_operation_progress",
  "appId": "notes",
  "operationId": "op_...",
  "data": {
    "operation": {
      "operationId": "op_...",
      "operationType": "start",
      "status": "running",
      "progress": 20,
      "message": "Daemon accepted start for app notes."
    }
  }
}
```

`app.state_changed` includes an app state snapshot with `recentLogs` omitted and `recentLogCount` included. When grouped state is available, it also includes the changed app's `component` and containing `group`.

```json
{
  "type": "app.state_changed",
  "appId": "notes-web",
  "data": {
    "state": {
      "id": "notes-web",
      "recentLogCount": 3
    },
    "component": {
      "appId": "notes-web",
      "groupId": "notes",
      "role": "frontend",
      "paneLabel": "frontend",
      "paneOrder": 10,
      "displayName": "Notes",
      "route": {
        "humanUrl": "http://notes-web.localhost:7777",
        "agentUrl": "http://127.0.0.1:7777",
        "reachable": true
      },
      "status": "running",
      "lastError": null
    },
    "group": {
      "groupId": "notes",
      "displayName": "Notes",
      "components": [
        {
          "appId": "notes-web",
          "groupId": "notes",
          "role": "frontend",
          "paneLabel": "frontend",
          "paneOrder": 10,
          "displayName": "Notes",
          "route": {
            "humanUrl": "http://notes-web.localhost:7777",
            "agentUrl": "http://127.0.0.1:7777",
            "reachable": true
          },
          "status": "running",
          "lastError": null
        }
      ],
      "aggregateStatus": "running"
    }
  }
}
```

`log.line_available` intentionally omits raw log line text so the global stream does not broadcast possible app secrets; the TUI can use it as a signal to refresh `/__hub/api/apps/:id/logs`.

```json
{
  "type": "log.line_available",
  "appId": "notes",
  "data": {
    "log": {
      "appId": "notes",
      "stream": "stdout",
      "source": "start",
      "sequence": 42,
      "at": "2026-06-01T00:00:00.000Z"
    }
  }
}
```

`log.stream_rotated` is emitted when the current in-memory log buffer prunes old entries.

## Logs

`GET /__hub/api/apps/:id/logs` returns a durable bounded log snapshot from `LogStore`. It supports:

```text
limit=<positive integer>
before=<sequence>
after=<sequence>
```

The default limit is 500 and the maximum accepted by the store is 5000. The response keeps `logs` as a compatibility array of message strings and exposes structured `events` for TUI scrollback.

```json
{
  "id": "app-id",
  "logs": [],
  "events": [],
  "page": {
    "limit": 500,
    "oldestSequence": 1,
    "newestSequence": 42,
    "nextBefore": 1,
    "hasMore": true
  },
  "diagnostics": [],
  "streamUrl": "http://127.0.0.1:7777/__hub/api/apps/app-id/logs/stream"
}
```

`LogEvent` fields:

```text
sequence
timestamp
at
appId
groupId
componentRole
stream
source
level
message
line
redacted
segment
```

`line` is retained as a compatibility alias. The TUI should prefer `message`. R006 stores presentation-safe redacted messages under `<state-dir>/logs/segments/<appId>/<yyyy-mm-dd>/` with metadata in `<state-dir>/logs/index.json`. It does not add SQLite yet; the dependency-free JSONL design is documented in `docs/logs.md`.

`GET /__hub/api/apps/:id/logs/stream` uses SSE with:

```text
status
snapshot
log
ping
```

## Log Export

`POST /__hub/api/logs/export` writes redacted export artifacts and returns:

```json
{
  "export": {
    "exportId": "exp_...",
    "status": "succeeded",
    "format": "zip",
    "outputPath": "<state-dir>/exports/exp_.../relaybase-logs-exp_....zip",
    "includedApps": ["notes-web"],
    "includedGroups": ["notes"],
    "includedComponents": ["notes-web:frontend"],
    "startedAt": "2026-06-01T00:00:00.000Z",
    "completedAt": "2026-06-01T00:00:00.000Z",
    "sizeBytes": 1234,
    "redactionReport": {
      "replacements": 2,
      "categories": {
        "env_assignment": 1,
        "relaybase_token": 1
      }
    }
  }
}
```

Request shape:

```ts
type LogExportRequest = {
  scope: "pane" | "app" | "group" | "page" | "all";
  appId?: string;
  groupId?: string;
  componentRole?: "frontend" | "backend" | "worker" | "database" | "service" | "other";
  paneIds?: string[];
  format: "log" | "jsonl" | "zip";
  startTime?: string;
  endTime?: string;
  limit?: number;
  destination?: string;
  redact?: boolean;
};
```

Implemented scopes:

- `app`: requires `appId`.
- `group`: requires `groupId`.
- `all`: exports all selected durable log events.
- `page`: exports the bounded page matching optional app/group/component filters.
- `pane`: uses `componentRole` until a native pane model exists; `paneIds` are rejected as planned-only.

Implemented formats:

- `log`: human-readable text lines.
- `jsonl`: structured `LogEvent` JSONL.
- `zip`: bundle containing `logs/export.log`, `logs/export.jsonl`, `metadata/apps.json`, `metadata/state.json`, `metadata/route-health.json`, `diagnostics/diagnostics.json`, `manifest.json`, and `redaction_report.json`.

Exports are redacted by default. R007 does not support unredacted exports; `redact:false` returns normalized `UNREDACTED_LOG_EXPORT_UNSUPPORTED`. Custom `destination` paths must remain under `<state-dir>/exports`; otherwise the daemon returns `LOG_EXPORT_DESTINATION_OUTSIDE_EXPORTS`. Export status is observable at `GET /__hub/api/exports/:id`.

Log export emits `export.started`, `export.progress`, `export.completed`, and `export.failed` on the global daemon event stream. Event payloads include export status and redaction counts, not log line contents.

## Preferences And Diagnostics

HTTP preferences and diagnostics are planned. Until implemented, the TUI must not assume daemon-backed preferences or `/__hub/api/diagnostics` exists.

As of R010, the Go TUI persists UI-only preferences under the Relaybase state directory at `<state-dir>/tui/preferences.json`. This file stores schema version, theme, context-menu key bindings, pane pins, hidden panes, pane order, pane colors, assistant bar color, history retention preference, last page, and layout density. It must not store token contents, env values, raw logs, exports, app commands, or secret-like strings.

As of R012, natural assistant history is local to the running TUI process and is not written to the preference file. The retention preference limits the in-memory assistant history window. Assistant history stores sanitized operator input, response type, timestamp, and safe result text only; it does not store auth tokens, raw logs, environment values, or exported log payloads.

As of R013, optional LLM provider preferences are also local to the TUI preference file. They store provider metadata, model name, optional base URL, API key reference, token budget limits, tool allowlist, and privacy toggles only. Raw API keys are rejected. `sendLogs` and `sendDiagnostics` default to `false`; prompt previews redact before including any opted-in log or diagnostic text.

Diagnostics must remain safe facts only: state path, token presence, route status, package/version facts, operation summaries, and recent safe errors. They must never include token contents, env secret values, raw preference secrets, or unredacted export payloads.
