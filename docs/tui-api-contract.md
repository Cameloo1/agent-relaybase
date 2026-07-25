# TUI API Contract

This is the current daemon API contract consumed by the Relaybase TUI. It covers authenticated state, asynchronous lifecycle operations, app management, packages, durable logs and exports, the global daemon event stream, setup/registration previews and apply routes, safe daemon replacement, and the Operator Agent Gateway. The Go TUI remains a client: mutations and durable state belong to the daemon, while TUI-only preferences remain in the selected state directory.

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
- Agent Gateway API routes, service, runtime, context, prompts, SQLite threads/audits, activity, execution policy, correctness, spend guard, tools, and types: `src/agent/api.ts`, `src/agent/gateway.ts`, `src/agent/runtime.ts`, `src/agent/context.ts`, `src/agent/prompts.ts`, `src/agent/threadStore.ts`, `src/agent/activity.ts`, `src/agent/executionPolicy.ts`, `src/agent/correctnessOracle.ts`, `src/agent/liveSpendGuard.ts`, `src/agent/tools/`, `src/agent/types.ts`
- OpenRouter compatibility adapter, runtime provider wrapper, and smoke runner: `src/agent/openrouterProvider.ts`, `src/agent/provider/openrouter.ts`, `src/agent/openrouterSmoke.ts`
- Current behavior is verified by the source files above and the automated Node and Go test suites.

The daemon exports explicit TypeScript contract types and validates route/tool payloads at their owning boundary. Agent SDK-facing tools use the supported JSON Schema subset while internal execution retains Relaybase validation.

## Contract Rules

- The daemon is the source of truth for lifecycle, logs, events, Agent configuration, diagnostics, operations, packages, setup, and Agent threads. TUI-only appearance and interaction preferences are local to `<state-dir>/tui/preferences.json`.
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
- Agent Gateway config responses keep source health, readiness, credential connection, runtime activity, and revision distinct. Raw keys and secret-derived hashes are rejected and never serialized. External configuration changes can activate a new revision at a new-run boundary without daemon restart; shell snapshots still require restart.
- Agent Gateway message runs return diagnostics when disabled, missing key, missing model, timed out, or provider-blocked. When enabled and configured, runs may stream real model events through the daemon runtime. They must not return fake assistant/model text.
- Agent Gateway tools are daemon-owned contracts. The SDK/default execution path cannot approve mutations by model-supplied JSON; approved execution must come through daemon approval policy.
- Agent message submission is durable and asynchronous. It returns a queued run with `202`; clients inspect or stream that run rather than holding the POST open for provider completion.
- Each Agent session permits at most one queued, running, or approval-waiting run. Failed and cancelled runs may be retried from their persisted original message. Idempotency keys make safe submission/retry repeats return the existing persisted work.

There is no daemon-wide HTTP request log infrastructure today. Correlation IDs are returned in headers and normalized error payloads so any future request logging can retain the same identity.

## Endpoint Status

| Endpoint                                                      | Method       | Status      | Auth                            | Current response                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------- | ------------ | ----------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/__hub/api/state`                                            | `GET`        | Implemented | Token                           | `{ "apps": AppState[], "groups": AppGroup[], "components": AppComponent[], "diagnostics"?: Diagnostic[], "generatedAt": string }`; rich records require the session token.                                                                                                           |
| `/__hub/api/apps`                                             | `GET`        | Implemented | Token                           | `{ "apps": AppStatus[] }`; full app records require the session token.                                                                                                                                                                                                               |
| `/__hub/api/dashboard/apps`                                   | `GET`        | Implemented | Read-only                       | `{ "apps": DashboardAppView[] }`; safe allowlisted projection containing display id/name, runtime status, health, route availability, safe port metadata, and attention state only.                                                                                                  |
| `/__hub/api/apps/:id`                                         | `GET`        | Planned     | Read-only                       | Not implemented. Current app detail endpoint is `/__hub/api/apps/:id/state`.                                                                                                                                                                                                         |
| `/__hub/api/apps/:id/state`                                   | `GET`        | Implemented | Token                           | `{ "state": AppState }`; full state requires the session token.                                                                                                                                                                                                                      |
| `/__hub/api/apps/:id/start`                                   | `POST`       | Implemented | Token                           | Async mode: `{ "operationId": string, "operation": LifecycleOperation }`. Compatibility mode: `{ "operationId": string, "operation": LifecycleOperation, "runtime": RuntimeView, "state": AppState }`.                                                                               |
| `/__hub/api/apps/:id/stop`                                    | `POST`       | Implemented | Token                           | Async mode: `{ "operationId": string, "operation": LifecycleOperation }`. Compatibility mode: `{ "operationId": string, "operation": LifecycleOperation, "runtime": RuntimeView, "state": AppState }`.                                                                               |
| `/__hub/api/apps/:id/restart`                                 | `POST`       | Implemented | Token                           | Async mode: `{ "operationId": string, "operation": LifecycleOperation }`. Compatibility mode: `{ "operationId": string, "operation": LifecycleOperation, "runtime": RuntimeView, "state": AppState }`.                                                                               |
| `/__hub/api/apps/:id/rename/preview`                          | `POST`       | Implemented | Token                           | Accepts only `{ "name": string }`; returns an expiring, revision-bound preview with blockers, a name-only manifest diff, component display-name behavior, and preserved identity/lifecycle evidence. It does not mutate state.                                                       |
| `/__hub/api/apps/:id/rename/apply`                            | `POST`       | Implemented | Token + confirmation            | Accepts only `{ "previewId": string, "confirm": true }`; rechecks app identity, runtime, lifecycle activity, collisions, manifest path/content, and registry revision under the exclusive app target gate before atomically synchronizing manifest and registry names.               |
| `/__hub/api/apps/:id/unregister`                              | `GET`        | Implemented | Token                           | `{ "preview": AppUnregisterPreview }`; reports stopped state, active lifecycle work, manifest/project identity, saved-package references, blockers, and preserved evidence without mutating registry state.                                                                          |
| `/__hub/api/apps/:id/unregister`                              | `POST`       | Implemented | Token + confirmation            | Accepts `{ "confirm": true }`, rechecks all preview gates under an exclusive app target gate, and removes only the registry entry. Projects, manifests, logs, and operation history are preserved.                                                                                   |
| `/__hub/api/packages`                                         | `GET`        | Implemented | Token                           | `{ "packages": Array<AppPackageDefinition & { "lastRun": AppPackageRun \| null }> }`; lists durable named packages with the newest run summary.                                                                                                                                      |
| `/__hub/api/packages`                                         | `POST`       | Implemented | Token                           | Creates one validated definition from `{ "name": string, "members": string[] }`; members resolve only to registered app IDs or unique registered display names.                                                                                                                      |
| `/__hub/api/packages/:id`                                     | `GET`        | Implemented | Token                           | `{ "package": AppPackageDefinition, "runs": AppPackageRun[] }`.                                                                                                                                                                                                                      |
| `/__hub/api/packages/:id`                                     | `DELETE`     | Implemented | Token                           | `{ "package": AppPackageDefinition, "deleted": true }`; rejects deletion while a package run is active.                                                                                                                                                                              |
| `/__hub/api/packages/:id/change/preview`                      | `POST`       | Implemented | Token                           | Accepts `{ "expectedRevision": number, "change": { "kind": "add-member" \| "rename" \| "replace-members", ... } }`; returns an expiring preview without mutating package state.                                                                                                      |
| `/__hub/api/packages/:id/change/apply`                        | `POST`       | Implemented | Token + confirmation            | Accepts only `{ "previewId": string, "confirm": true }`; rechecks revision, active runs, name collisions, exact registered member IDs, capacity, and preview integrity before one compare-and-increment update.                                                                      |
| `/__hub/api/packages/:id/delete/preview`                      | `POST`       | Implemented | Token                           | Accepts `{ "expectedRevision": number }`; reports active-run blockers and the apps, files, manifests, and historical runs that deletion preserves.                                                                                                                                   |
| `/__hub/api/packages/:id/delete/apply`                        | `POST`       | Implemented | Token + confirmation            | Accepts only `{ "previewId": string, "confirm": true }`; rechecks revision and active-run state, then deletes only the package definition while retaining apps and historical runs.                                                                                                  |
| `/__hub/api/packages/:id/launch`                              | `POST`       | Implemented | Token                           | Starts daemon-owned package orchestration and returns `202 { "runId": string, "run": AppPackageRun }`.                                                                                                                                                                               |
| `/__hub/api/package-runs/:id`                                 | `GET`        | Implemented | Token                           | `{ "run": AppPackageRun }`; clients poll this route for package progress.                                                                                                                                                                                                            |
| `/__hub/api/package-runs/:id/retry`                           | `POST`       | Implemented | Token                           | Creates a new retry run for failed/skipped/interrupted members and returns `202 { "runId": string, "run": AppPackageRun }`.                                                                                                                                                          |
| `/__hub/api/package-runs/:id/abort`                           | `POST`       | Implemented | Token                           | Requests abort and returns `{ "run": AppPackageRun }`; already-enqueued or started apps are not stopped.                                                                                                                                                                             |
| `/__hub/api/operations/:id`                                   | `GET`        | Implemented | Token                           | `{ "operation": LifecycleOperation }`, or normalized `OPERATION_NOT_FOUND` error.                                                                                                                                                                                                    |
| `/__hub/api/operations`                                       | `GET`        | Implemented | Token                           | `{ "operations": LifecycleOperation[], "count": number, "filters": object }`; lists the bounded durable ledger with status/type/target/limit filters.                                                                                                                                |
| `/__hub/api/events`                                           | `GET`        | Implemented | Token                           | SSE stream of typed `DaemonEvent` payloads. No missed-event replay; reconnect clients must refresh `/__hub/api/state`.                                                                                                                                                               |
| `/__hub/api/daemon/restart-preview`                           | `GET`        | Implemented | Token                           | Returns the daemon instance ID, a state-bound preview ID, active Agent/lifecycle/package blockers, Relaybase-owned running apps, and externally managed running apps. Performs no mutation.                                                                                          |
| `/__hub/api/daemon/prepare-restart`                           | `POST`       | Implemented | Token                           | Accepts exact `{ requestId, expectedInstanceId, previewId }`. Rechecks the preview, blocks active work, quiesces mutations, stops only daemon-owned apps, and returns the bound restore list. A partial app-stop failure attempts recovery before returning an error.                |
| `/__hub/api/daemon/shutdown`                                  | `POST`       | Implemented | Token + confirmation            | Accepts the exact restart binding plus `confirm: true`, idempotently verifies preparation, returns `202`, and closes the prepared daemon. The external bridge must prove a distinct replacement instance and restore owned apps through lifecycle operations.                        |
| `/__hub/api/apps/:id/logs`                                    | `GET`        | Implemented | Token                           | Durable snapshot with paging: `{ "id": string, "logs": string[], "events": LogEvent[], "page": LogPage, "diagnostics": Diagnostic[], "streamUrl": string }`                                                                                                                          |
| `/__hub/api/apps/:id/logs/stream`                             | `GET`        | Implemented | Token                           | SSE events: `status`, `snapshot`, `log`, `ping`.                                                                                                                                                                                                                                     |
| `/__hub/api/logs/export`                                      | `POST`       | Implemented | Token                           | Starts a real redacted log export and returns `{ "export": LogExportResult }`. Current implementation completes during the request and writes under `<state-dir>/exports/<exportId>/`.                                                                                               |
| `/__hub/api/exports/:id`                                      | `GET`        | Implemented | Token                           | `{ "export": LogExportResult }`, or normalized `LOG_EXPORT_NOT_FOUND` error.                                                                                                                                                                                                         |
| `/__hub/api/preferences`                                      | `GET`, `PUT` | Planned     | Read for `GET`, token for `PUT` | Not implemented. R010 TUI preferences are stored locally under `<state-dir>/tui/preferences.json` until the daemon preference API exists.                                                                                                                                            |
| `/__hub/api/diagnostics`                                      | `GET`        | Planned     | Read-only                       | Not implemented. Token diagnostics exist in mutation error details and MCP `diagnose_token`, not as this HTTP route.                                                                                                                                                                 |
| `/__hub/api/setup/detect`                                     | `POST`       | Implemented | Read-only                       | `{ "setup": SetupDetectResult }`; detects package manager, framework, scripts, port hints, Docker Compose hints, MCP hints, existing manifest analysis, existing launch wrapper, and existing setup profile without writing files.                                                   |
| `/__hub/api/setup/plans`                                      | `POST`       | Implemented | Read-only                       | `{ "setup": { "cwd": string, "choices": SetupPlanChoice[], "diagnostics": SetupDiagnostic[] } }`; returns daemon-generated setup plan choices and port strategies.                                                                                                                   |
| `/__hub/api/setup/preview`                                    | `POST`       | Implemented | Read-only                       | `{ "setup": SetupPlanPreview }`; returns safe file write previews and diffs for the selected plan. `components[]` returns preview-only component-as-app plans for grouped frontend/backend setup.                                                                                    |
| `/__hub/api/setup/apply`                                      | `POST`       | Implemented | Token + confirmation            | `{ "setup": SetupApplyResult }`; applies the selected setup plan through the daemon setup engine, writes approved artifacts, and registers the manifest without starting the app.                                                                                                    |
| `/__hub/api/setup/register-manifest`                          | `POST`       | Implemented | Token                           | `{ "setup": RegisterManifestResult }`; registers an existing manifest through the daemon registry and emits `app.registered`.                                                                                                                                                        |
| `/__hub/api/setup/register/preview`                           | `POST`       | Implemented | Read-only                       | Requires explicit `verificationMode: "quick" \| "none"`; returns an exact folder-or-manifest registration preview with file/registry risks, bounded health candidates, and whether confirmation will start and stop the app.                                                         |
| `/__hub/api/setup/register/apply`                             | `POST`       | Implemented | Token + confirmation            | Applies the exact preview, then runs `quick` verification or zero lifecycle work for `none`. Returns verified, unverified, verification-failed, or cleanup-failed state; successful proof ends stopped.                                                                              |
| `/__hub/api/setup/register/repair/preview`                    | `POST`       | Implemented | Read-only                       | Resolves a repair from retained lifecycle attempts, binds every affected file revision, and returns the exact manifest-only or multi-file setup-plan preview plus new quick-proof intent. Cleanup failure blocks preview.                                                            |
| `/__hub/api/setup/register/repair/apply`                      | `POST`       | Implemented | Token + confirmation            | Applies only the exact non-stale previewed file plan, re-registers, and performs one new quick proof. It never repeats an unchanged failed launch-plan digest; a blocked duplicate retains the prior actionable repairs without counting as another lifecycle attempt.               |
| `/__hub/api/setup/register/verification/cancel`               | `POST`       | Implemented | Token                           | Requests abort of one active app verification. Process cleanup remains daemon-owned and the original apply request returns the terminal inspectable result.                                                                                                                          |
| `/__hub/api/setup/inspect-manifest`                           | `POST`       | Implemented | Read-only                       | `{ "setup": ExistingManifestAnalysis }`; reads and validates an existing manifest, with secret-like values redacted.                                                                                                                                                                 |
| `/__hub/api/setup/validate-manifest`                          | `POST`       | Implemented | Read-only                       | `{ "setup": ExistingManifestAnalysis }`; validates an in-body manifest object or an existing manifest path.                                                                                                                                                                          |
| `/__hub/api/setup/patch-manifest/preview`                     | `POST`       | Implemented | Read-only                       | `{ "setup": ManifestPatchPlan }`; previews safe manifest field patches and diffs without writing files.                                                                                                                                                                              |
| `/__hub/api/setup/patch-manifest/apply`                       | `POST`       | Implemented | Token + confirmation            | `{ "setup": ManifestPatchResult }`; atomically writes an approved safe manifest patch.                                                                                                                                                                                               |
| `/__hub/api/setup/open`                                       | `POST`       | Implemented | Token + confirmation            | `{ "setup": OpenProjectResult }`; delegates to daemon setup/open primitives. It defaults to `noBrowser: true` for TUI safety unless the client explicitly asks otherwise.                                                                                                            |
| `/__hub/api/setup/prove`                                      | `POST`       | Implemented | Token + confirmation            | `{ "setup": ProveHealthResult }`; delegates to daemon health/proof primitives and may run lifecycle proof only after confirmation.                                                                                                                                                   |
| `/__hub/api/setup/repair`                                     | `POST`       | Implemented | Read-only                       | `{ "setup": RepairSetupResult }`; returns repair choices and previews only. Apply still requires `/setup/apply` confirmation.                                                                                                                                                        |
| `/__hub/api/setup/operations/:id`                             | `GET`        | Diagnostic  | Read-only                       | Async setup operation storage is not implemented yet. The route returns normalized `SETUP_OPERATION_NOT_FOUND`; clients should not pretend replay or polling exists for setup.                                                                                                       |
| `/__hub/api/agent/config`                                     | `GET`        | Implemented | Token                           | Safe config, source health, readiness, credential metadata, and opaque active revision; no raw key, ciphertext, file fingerprint, or secret-bearing path.                                                                                                                            |
| `/__hub/api/agent/config`                                     | `PUT`        | Implemented | Token                           | Atomically validates the complete safe settings draft against `expectedRevisionId`. Raw keys are rejected; invalid execution bounds or stale revisions change nothing.                                                                                                               |
| `/__hub/api/agent/config/reload`                              | `POST`       | Implemented | Token                           | Performs a bounded stable read of the selected external source and atomically applies a new revision, reports unchanged, or blocks while preserving last-known-good state.                                                                                                           |
| `/__hub/api/agent/security/status`                            | `GET`        | Implemented | Token                           | Returns the latest local, secret-free Agent credential-security diagnosis and safe last-event summary. Responses are no-store.                                                                                                                                                       |
| `/__hub/api/agent/security/diagnose`                          | `POST`       | Implemented | Token                           | Runs the daemon-owned doctor. Local-only is the default; `online: true` explicitly permits a provider probe and preserves prior safe metadata on failure.                                                                                                                            |
| `/__hub/api/agent/security/repair/preview`                    | `POST`       | Implemented | Token                           | Creates a short-lived preview bound to config revision, one-way credential identity, source fingerprint, findings, and exact action IDs. Raw key-shaped input is rejected.                                                                                                           |
| `/__hub/api/agent/security/repair/previews/:id`               | `GET`        | Implemented | Token                           | Resolves one active, unexpired, still-bound preview for authorized CLI apply. Stale or consumed previews fail closed.                                                                                                                                                                |
| `/__hub/api/agent/security/repair/apply`                      | `POST`       | Implemented | Token + bound confirmation      | Serially applies only previewed actions through existing daemon primitives, requires an idempotency key, re-diagnoses, and returns a durable verified/partial/blocked/failed receipt.                                                                                                |
| `/__hub/api/agent/security/repair/operations/latest`          | `GET`        | Implemented | Token                           | Returns the latest secret-free repair receipt or `null`, allowing the TUI to recover results after reconnect or restart.                                                                                                                                                             |
| `/__hub/api/agent/security/repair/operations/:id`             | `GET`        | Implemented | Token                           | Resolves a durable operation receipt. Running operations recovered after daemon restart are marked interrupted and are never blindly replayed.                                                                                                                                       |
| `/__hub/api/agent/security/repair/operations/:id/cancel`      | `POST`       | Implemented | Token                           | Returns the receipt for terminal work; active atomic mutation reports not cancellable instead of claiming cancellation.                                                                                                                                                              |
| `/__hub/api/agent/provider/openrouter/status`                 | `GET`        | Implemented | Token                           | Safe DPAPI connection, validation, limit/expiration metadata, and latest OAuth attempt state. Never returns a credential or verifier.                                                                                                                                                |
| `/__hub/api/agent/provider/openrouter/connect`                | `POST`       | Implemented | Token                           | Starts one daemon-owned S256 PKCE loopback attempt. A TUI request can ask the daemon to open the trusted authorization URL with a credential-scrubbed helper environment; the safe URL remains available as fallback.                                                                |
| `/__hub/api/agent/provider/openrouter/replace`                | `POST`       | Implemented | Token                           | Starts replacement; the old reference remains active until candidate validation, DPAPI write, and durable readback succeed.                                                                                                                                                          |
| `/__hub/api/agent/provider/openrouter/validate`               | `POST`       | Implemented | Token                           | Retries safe metadata validation for a managed unverified credential and activates a verified revision only on success.                                                                                                                                                              |
| `/__hub/api/agent/provider/openrouter/migrate`                | `POST`       | Implemented | Token + confirmation            | Validates and moves a legacy environment credential to DPAPI without editing `.env`; reports only safe metadata.                                                                                                                                                                     |
| `/__hub/api/agent/provider/openrouter/legacy-removal/preview` | `POST`       | Implemented | Token                           | Returns a short-lived safe preview only when exactly one external `OPENROUTER_API_KEY` assignment can be removed.                                                                                                                                                                    |
| `/__hub/api/agent/provider/openrouter/legacy-removal/apply`   | `POST`       | Implemented | Token + confirmation            | Applies the exact fingerprint-bound preview through a restricted same-directory temporary file and atomic replacement, with no plaintext backup.                                                                                                                                     |
| `/__hub/api/agent/provider/openrouter/disconnect`             | `POST`       | Implemented | Token + confirmation            | Removes the local protected credential and explicitly reports that the remote key may remain active.                                                                                                                                                                                 |
| `/__hub/api/agent/provider/openrouter/revoke/*`               | `POST`       | Implemented | Token + confirmation            | Preview directs the user to provider management. Relaybase returns unconfirmed rather than claiming remote revocation without management authority.                                                                                                                                  |
| `/__hub/api/agent/sessions`                                   | `POST`       | Implemented | Token                           | `{ "agent": { "session": AgentSession } }`; creates a redacted Agent Gateway session with optional `TuiAgentContext` and persists it under the daemon state directory when configured.                                                                                               |
| `/__hub/api/agent/sessions`                                   | `GET`        | Implemented | Token                           | `{ "agent": { "sessions": AgentSession[] } }`; lists redacted sessions from the daemon session store.                                                                                                                                                                                |
| `/__hub/api/agent/sessions/active`                            | `GET`        | Implemented | Token                           | `{ "agent": { "session": AgentSession \| null } }`; returns the daemon-selected active Operator Agent thread. Active-thread metadata is stored in SQLite, not TUI preferences.                                                                                                       |
| `/__hub/api/agent/sessions/:sessionId`                        | `GET`        | Implemented | Token                           | `{ "agent": { "session": AgentSession } }`, or normalized `AGENT_SESSION_NOT_FOUND`.                                                                                                                                                                                                 |
| `/__hub/api/agent/sessions/:sessionId`                        | `PATCH`      | Implemented | Token                           | `{ "agent": { "session": AgentSession } }`; updates safe thread metadata such as title, privacy mode, active flag, and redacted context. Raw secrets are sanitized before persistence.                                                                                               |
| `/__hub/api/agent/sessions/:sessionId/activate`               | `POST`       | Implemented | Token                           | `{ "agent": { "session": AgentSession } }`; switches the active daemon thread. The TUI must refresh its displayed thread state from the returned session or session list.                                                                                                            |
| `/__hub/api/agent/sessions/:sessionId/clear`                  | `POST`       | Implemented | Token                           | `{ "agent": { "session": { "sessionId": string, "cleared": true } } }`; soft-clears a thread by marking it deleted and recording a safe audit event.                                                                                                                                 |
| `/__hub/api/agent/sessions/:sessionId`                        | `DELETE`     | Implemented | Token                           | Alias for session clear; returns `{ "agent": { "session": { "sessionId": string, "cleared": true } } }`.                                                                                                                                                                             |
| `/__hub/api/agent/sessions/:id/export`                        | `GET`        | Implemented | Token                           | `{ "agent": { "export": AgentSessionExportResult } }`; writes a redacted chat/session/audit artifact under `<state-dir>/agent/exports/`. `format=json` writes JSON and `format=markdown` writes Markdown.                                                                            |
| `/__hub/api/agent/sessions/:id/context-preview`               | `GET`        | Implemented | Token                           | `{ "agent": { "contextPreview": AgentThreadContextPreview } }`; returns active-thread-only recall metadata, recent redacted messages, pending/recovered approval counts, and explicit no-raw-secrets/logs/diffs policy flags.                                                        |
| `/__hub/api/agent/sessions/:id/runs`                          | `GET`        | Implemented | Token                           | `{ "agent": { "runs": AgentRun[] } }`; returns persisted runs for the session.                                                                                                                                                                                                       |
| `/__hub/api/agent/sessions/:id/runs/active`                   | `GET`        | Implemented | Token                           | `{ "agent": { "run": AgentRun \| null } }`; returns the single queued/running/approval-waiting run when present.                                                                                                                                                                     |
| `/__hub/api/agent/sessions/:id/runs/:runId`                   | `GET`        | Implemented | Token                           | `{ "agent": { "run": AgentRun } }`, or normalized session/run-not-found errors.                                                                                                                                                                                                      |
| `/__hub/api/agent/sessions/:id/runs/:runId/cancel`            | `POST`       | Implemented | Token                           | Cancels queued/model/approval-waiting work and rejects its pending approvals. An already executing approved daemon tool fails with `AGENT_APPROVED_TOOL_IN_PROGRESS` instead of claiming cancellation.                                                                               |
| `/__hub/api/agent/sessions/:id/runs/:runId/retry`             | `POST`       | Implemented | Token                           | Requeues a failed/cancelled run from its original persisted user message and returns `202`. Accepts `Idempotency-Key` or matching body `idempotencyKey`.                                                                                                                             |
| `/__hub/api/agent/sessions/:id/messages`                      | `POST`       | Implemented | Token                           | Accepts `{ "content": string, "context"?: TuiAgentContext, "idempotencyKey"?: string }` or `Idempotency-Key`; persists a redacted message plus queued run and returns `202`. Disabled/missing config becomes a diagnostic failed run. Configured execution continues asynchronously. |
| `/__hub/api/agent/sessions/:id/events`                        | `GET`        | Implemented | Token                           | SSE stream of typed `AgentRunEvent` payloads with numeric IDs. `afterSequence=<n>` or `Last-Event-ID` replays stored events newer than the requested sequence. The Go client reconnects with bounded backoff and discards duplicate replay sequences.                                |
| `/__hub/api/agent/approvals/:id/approve`                      | `POST`       | Implemented | Token                           | Resolves an existing pending approval as approved, or returns normalized `AGENT_APPROVAL_NOT_FOUND` / `AGENT_APPROVAL_ALREADY_RESOLVED`.                                                                                                                                             |
| `/__hub/api/agent/approvals/:id/reject`                       | `POST`       | Implemented | Token                           | Resolves an existing pending approval as rejected, or returns normalized `AGENT_APPROVAL_NOT_FOUND` / `AGENT_APPROVAL_ALREADY_RESOLVED`.                                                                                                                                             |
| `/__hub/api/agent/diagnostics`                                | `GET`        | Implemented | Token                           | `{ "agent": { "diagnostics": AgentDiagnostic[] } }`; reports disabled/missing-key/missing-model/runtime status.                                                                                                                                                                      |

Context menus and slash commands do not create separate lifecycle endpoints. Lifecycle menu actions and `/launch`, `/stop`, and `/restart` call the implemented async lifecycle endpoints. Log export actions call `/__hub/api/logs/export` with redaction enabled by default.

Deterministic natural-language commands do not add daemon endpoints. The TUI parses supported phrases locally, resolves targets through the same slash-command resolver, and then uses existing daemon APIs only after the same confirmation gates:

- lifecycle phrases call `/__hub/api/apps/:id/start`, `/__hub/api/apps/:id/stop`, or `/__hub/api/apps/:id/restart` after confirmation
- log export phrases call `/__hub/api/logs/export` after confirmation
- log viewing phrases query `/__hub/api/apps/:id/logs` when the target pane resolves
- `what is broken?` and `show diagnostics` read current in-memory TUI state and the last daemon state snapshot; they do not call a planned diagnostics endpoint

The Agent Gateway owns remote model execution when explicitly enabled and configured, while deterministic slash and natural commands remain the local fallback. Configured message submission persists a redacted user message and queued run, returns `202`, and continues asynchronously through the OpenAI Agents SDK/OpenRouter path. Disabled, missing-key, missing-model, budget, timeout, no-progress, and provider failures emit diagnostics plus a terminal failed/blocked run rather than fake assistant text.

Agent threads, messages, runs, events, approvals, audits, and usage records use `agent/agent.sqlite`, with one-time import from legacy `agent/sessions.json` and `agent/audit.jsonl` when present. Thread lifecycle routes support active-thread read/switch, rename, soft clear, JSON/Markdown export, context preview, run polling/cancel/retry, and event replay by sequence. Active-thread recall does not merge inactive transcripts or TUI preferences into the model context.

The Go TUI fetches Agent config and diagnostics, creates and switches threads, submits messages with `TuiAgentContext`, follows queued/persisted runs and SSE replay, renders transcript activity and setup/tool approvals, and sends approve/reject decisions. It does not call OpenRouter or perform lifecycle, setup writes, manifest patches, or thread persistence directly.

The token-gated read-only `GET /__hub/api/agent/usage?scope=active-thread` route returns the most recent completed model call and active-thread totals from daemon-persisted usage records. Token counts remain integers; cost carries reported, estimated, mixed, partial, or unavailable provenance. Opening or refreshing usage never starts a model run.

`TuiAgentContext.authorizedProjectRoots` is a bounded list that the Go client populates only after parsing an explicit `/add`, `/configure`, or folder `/register` target. The daemon canonicalizes those roots into grants for the bounded `project_*` inspection tools; arbitrary model/tool arguments cannot grant a new inspection root. The transient TUI list is cleared after message submission or failure. This contract does not by itself assert root confinement for other setup/manifest tools; each such tool must enforce the same grant explicitly before that claim applies.

The daemon-owned Relaybase tool registry exposed to the Operator Agent runtime is:

- read-only: `list_apps`, `get_app_state`, `get_app_group`, `get_current_context`, `get_agent_capabilities`, `explain_app_problem`, `get_diagnostics`, `get_operation_status`, `list_operations`, `tail_logs`, `search_logs`, `project_list_files`, `project_search_files`, `project_read_file`, `project_detect_start_commands`, `project_inspect_package_scripts`, `discover_project_roots`, `detect_project`, `plan_app_setup`, `preview_setup_writes`, `inspect_manifest`, `validate_manifest`, `repair_app_setup`, `propose_tui_action`
- approval-gated: `start_app`, `stop_app`, `restart_app`, `export_logs`, `apply_setup_plan`, `register_manifest`, `patch_manifest_fields`, `set_health_route`, `set_pinned_port`, `set_component_metadata`, `add_env_override_safe`, `open_project_or_app`, `setup_and_start_project`, `prove_app_health`

Fresh and historically default Agent configurations use `all_registered` tool mode, which derives availability from the live registry so newly shipped tools are not silently omitted. Deliberately customized subsets use `explicit_allowlist` and remain restricted. Capability inspection reports registered, effective, disabled, and stale unknown tool names.

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

`AppState`, `AppStatus`, and `LogEvent` alias the current daemon runtime shapes so existing endpoint behavior stays compatible. `AppGroup` and `AppComponent` are current read models derived from existing app records and runtime state; they do not introduce native multi-process lifecycle ownership.

`SetupPlanPreview.componentPlans` represents component-as-app setup metadata for grouped panes. It does not introduce native manifest `components[]`, and it does not let the TUI own multiple app processes.

## Agent Gateway Event Examples

Configured message flow:

```text
event: run.started
event: model.request_started
event: model.processing_started
event: model.processing_completed
event: model.delta
event: model.completed
event: answer
event: run.completed
event: run.finalized
```

Relevant run, processing, tool, approval, handoff, and tool-search events may include an additive `data.activity` object. It contains only Relaybase-owned observable UI state: stable `id`, `kind`, `state`, semantic `label`, optional safe `detail`, bounded sanitized `output`, `outputLineCount`, `outputTruncated`, timestamps, and measured `durationMs`. `model.processing_*` activity exposes only public response lifecycle labels such as `Thinking` and `Reviewing tool result`; it never contains model chain-of-thought. The daemon creates and redacts this projection before SQLite persistence and SSE publication. Animation frames remain local to the TUI. New user submissions also publish a persisted `message.user` event so replay can reconstruct exact message/tool/result chronology without joining a separate local TUI history.

Blocked message flow:

```text
event: run.started
event: diagnostic
event: blocked
event: run.failed
event: run.finalized
```

Disabled or missing config diagnostic:

```json
{
  "id": "agent.config.credential_missing",
  "severity": "error",
  "code": "AGENT_CREDENTIAL_MISSING",
  "message": "No usable OpenRouter credential is connected.",
  "checkedAt": "2026-06-02T00:00:00.000Z",
  "userAction": "Connect OpenRouter in Settings > Agent > Provider."
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

Relaybase supports component-as-app metadata. Each existing app remains one daemon-owned command/process, but its manifest may include:

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

The exported type still includes planned values such as `waiting_for_approval`, `aborted`, and `skipped`, but app lifecycle operations emit only the implemented values above.

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

`GET /__hub/api/events` is the global daemon event stream. It uses Server-Sent Events with:

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

The global daemon event stream does not implement missed-event replay. If the client reconnects with `Last-Event-ID`, the daemon reports that value in `daemon.ready.data.reconnect.lastEventId`, but the client must fetch `/__hub/api/state` to recover an authoritative snapshot.

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
app.runtime_changed
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

`app.runtime_changed` is a lightweight invalidation event published for daemon-owned start, readiness, stop, process-error, and spontaneous-exit transitions. Its safe payload contains runtime status, health, phase, optional PID/assigned port, a bounded reason code, and observation time. Clients must fetch `/__hub/api/state` for the authoritative projection. State clients reject older fetch generations so a slower prior request cannot restore stale `running` state after a stop or exit.

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

`line` is retained as a compatibility alias. The TUI should prefer `message`. Relaybase stores presentation-safe redacted messages under `<state-dir>/logs/segments/<appId>/<yyyy-mm-dd>/` with metadata in `<state-dir>/logs/index.json`. The dependency-free JSONL design is documented in `docs/logs.md`.

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

Exports are redacted by default. Unredacted export is unsupported; `redact:false` returns normalized `UNREDACTED_LOG_EXPORT_UNSUPPORTED`. Custom `destination` paths must remain under `<state-dir>/exports`; otherwise the daemon returns `LOG_EXPORT_DESTINATION_OUTSIDE_EXPORTS`. Export status is observable at `GET /__hub/api/exports/:id`.

Log export emits `export.started`, `export.progress`, `export.completed`, and `export.failed` on the global daemon event stream. Event payloads include export status and redaction counts, not log line contents.

## Preferences And Diagnostics

HTTP preferences and diagnostics are planned. Until implemented, the TUI must not assume daemon-backed preferences or `/__hub/api/diagnostics` exists.

The Go TUI persists UI-only preferences under the Relaybase state directory at `<state-dir>/tui/preferences.json`. This file stores schema version, theme, context-menu key bindings, pane pins, hidden panes, pane order, pane colors, assistant bar color, history retention preference, last page, layout density, and Agent-pane collapse state. It must not store token contents, env values, raw logs, exports, app commands, Agent threads, approvals, or secret-like strings.

Deterministic natural-assistant history is local to the running TUI process and is not written to the preference file. The retention preference limits the in-memory history window. Entries contain sanitized operator input, response type, timestamp, and safe result text only; they do not contain auth tokens, raw logs, environment values, or exported log payloads.

Version 1 TUI preferences retain disabled provider-shell fields for compatibility, but daemon Operator Agent execution is governed by the token-gated `/__hub/api/agent/config` contract. The preference file is not provider credential, tool-policy, budget, thread, or approval authority. Raw API keys are accepted only by the daemon-owned OAuth exchange or legacy internal environment resolution; they are rejected from TUI/config requests and never returned.

Diagnostics must remain safe facts only: state path, token presence, route status, package/version facts, operation summaries, and recent safe errors. They must never include token contents, env secret values, raw preference secrets, or unredacted export payloads.
