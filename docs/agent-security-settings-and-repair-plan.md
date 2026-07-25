# Agent Security Settings and Repair Plan

Status: implemented in the current working tree; deterministic, native, package, and TUI gates verified on 2026-07-24; Go race proof remains blocked by host application-control denial of `gcc.exe`

Scope: Relaybase Operator Agent credential-security management, diagnosis, repair, TUI settings, CLI controls, daemon APIs, recovery, testing, migration, and release acceptance

Depends on: `docs/agent-config-hot-reload-and-credential-security-plan.md`

Last reviewed against the working tree: 2026-07-24

## 1. Executive Decision

Relaybase should add one daemon-owned Agent security doctor and repair service, then expose that same service through:

- `/settings -> Agent -> Security and credentials` in the TUI.
- A new top-level `relaybase repair` CLI command with Agent-security flags.
- Authenticated, no-store daemon API routes used by both clients.

The Provider page remains the place where a user initially connects OpenRouter or replaces the connected credential. The new Security and credentials page owns ongoing credential management: protection status, validation, migration, legacy-secret cleanup, local disconnect, remote-revocation guidance, high-security capability status, security checks, repair previews, repair execution, recovery, and redacted audit receipts.

The TUI and CLI must not independently diagnose or mutate Agent credential state. They render daemon-owned findings, request a bound repair preview, obtain the required confirmation, submit the preview, and show the daemon's verification result.

The top-level command is `relaybase repair`, not a new global `--repair` mode:

- `relaybase configure --repair` continues to repair project setup.
- `relaybase repair-prefix` continues to repair the source-checkout command link.
- `relaybase repair --agent-security` handles Agent credential security.
- Bare `relaybase repair` runs every registered repair doctor; the first release may register only Agent security and must say so truthfully.

This separation avoids silently changing the meaning of existing commands and gives Relaybase a stable repair framework for future domains.

## 2. Product Outcomes

After implementation, a user must be able to:

1. Open `/settings`, choose **Agent**, and open **Security and credentials**.
2. See whether the Agent credential is connected, readable, validated, protected, limited, and expiring without seeing any secret.
3. Run a local security check without making an OpenRouter request.
4. Understand each finding in plain language.
5. Preview exactly what Relaybase can repair and what it will preserve.
6. Apply an authorized repair in the TUI.
7. Perform the same diagnosis, preview, apply, and verification flow from the CLI.
8. Recover from a stale preview, daemon restart, provider outage, corrupted protected blob, wrong Windows user/profile, invalid external source, ambiguous legacy assignment, or interrupted repair.
9. Know when Relaybase cannot complete an action, especially remote key revocation and shell-owned environment cleanup.
10. Continue normal Agent use without routine unlock or Windows-verification prompts.

## 3. Current Verified Behavior

The implementation must extend the current primitives rather than replace them.

### 3.1 Settings

The `/settings` transient contains General, Appearance, Interaction, and Agent categories. Agent has dedicated Status, Provider, Security and credentials, Configuration, Safety and permissions, Execution, Budgets, and Recovery pages in `tui/internal/tui/model/settings.go`.

Provider owns initial OpenRouter OAuth PKCE connect and replace plus a read-only protection summary and Manage security navigation. Security and credentials owns ongoing validation, DPAPI and ACL status, migration, exact legacy assignment removal, provider key-management guidance, local disconnect, Windows-verification capability, dedicated-key guidance, local diagnosis, findings, bound repair previews, destructive confirmation phrases, verified result pages, and durable latest-receipt recovery.

`/settings agent security` opens the page directly. Settings/control-plane activity remains static and does not drive the thinking shimmer.

### 3.2 Daemon security operations

The daemon already owns:

- OpenRouter OAuth PKCE connect and replace.
- Protected credential storage through current-user Windows DPAPI.
- Durable readback verification before activation.
- Credential validation and safe provider metadata.
- Legacy credential migration.
- Preview-bound removal of exactly one external legacy assignment.
- Local disconnect.
- Remote-revocation guidance that refuses to claim an unconfirmed provider action.
- Configuration revisions and last-known-good reload behavior.
- Secret redaction and Agent audit events.

### 3.3 Daemon API

Agent routes are token-gated and set `Cache-Control: no-store` and `Pragma: no-cache`. Routes cover safe config, reload, provider status, connect, replace, validate, migrate, legacy-removal preview/apply, disconnect, revoke preview, Windows verification mode, security status/diagnosis, repair preview resolution, apply, latest receipt, operation lookup, and bounded cancellation semantics.

### 3.4 CLI

Current Agent CLI controls are:

```text
relaybase agent config status
relaybase agent config reload
relaybase agent provider status
relaybase agent provider connect
relaybase agent provider replace
relaybase agent provider validate
relaybase agent provider migrate --yes
relaybase agent provider cleanup-legacy [--yes]
relaybase agent provider disconnect --yes
relaybase agent provider revoke [--yes]
```

The top-level `relaybase repair` command now exposes the registered Agent-security doctor with diagnosis, explicit online checks, issue filters, exact actions, safe groups, preview-only plans, bound apply, operation lookup, JSON, interactive confirmation, and stable exit codes. Existing narrower repair names retain their meanings:

- `relaybase configure --repair`: project setup repair.
- `relaybase repair-prefix`: source-checkout command-prefix repair.

### 3.5 Existing safety behavior to preserve

- Raw provider keys are rejected from generic Agent config updates.
- Protected secrets are decrypted only for a bounded daemon-owned credential lease.
- Credential buffers are cleared when the lease ends.
- Managed credentials are removed from child-process environments.
- Failed replacement preserves the old credential.
- Invalid external reload preserves the last-known-good revision.
- Legacy cleanup is exact, atomic, preview-bound, and refuses ambiguous or stale sources.
- Remote revocation is never reported as complete without provider confirmation.
- The thinking shimmer is driven only by authoritative model-processing activity. Settings saves, diagnosis, credential validation, repair, OAuth waiting, blocked state, and other control-plane work must not shimmer.

## 4. Scope Boundaries

### 4.1 In scope

- A dedicated Agent Security and credentials settings page.
- A shared Agent security doctor.
- A shared Agent security repair service.
- Persistent, secret-free repair previews and operation receipts.
- TUI diagnosis, preview, confirmation, progress, cancellation where safe, result, retry, and recovery flows.
- CLI diagnosis and repair flags.
- Authenticated repair APIs.
- Migration of management actions from Provider to Security and credentials.
- Exact help, troubleshooting, and security documentation.
- Deterministic unit, API, CLI, TUI, recovery, native, package, and secret-leak tests.

### 4.2 Not in scope

- Moving initial OpenRouter connection out of Provider.
- Accepting a raw key in the TUI, CLI arguments, stdin, generic API, or settings state.
- Automatically editing arbitrary `.env` files.
- Scanning the user's filesystem for secrets.
- Automatically revoking an OpenRouter key without confirmed provider authority.
- Automatically enabling the Agent, remote model mode, or provider spending.
- Automatically selecting a model.
- Automatically restarting the daemon during an Agent-security repair.
- Treating DPAPI as protection from same-user malware.
- Shipping the remote backend-held-key tier.
- Enabling Require Windows verification before secure prompt ownership is implemented and proven.
- Replacing `configure --repair` or `repair-prefix`.
- Running arbitrary repair scripts or shell commands.

## 5. UX Ownership

Actions must have one canonical home.

| Capability                        | Canonical TUI page                  | Reason                                              |
| --------------------------------- | ----------------------------------- | --------------------------------------------------- |
| Connect OpenRouter                | Agent -> Provider                   | Connection and onboarding                           |
| Replace credential                | Agent -> Provider                   | Starts a new provider connection                    |
| Provider/model identity           | Agent -> Provider and Configuration | Provider setup and non-secret runtime configuration |
| Credential protection status      | Agent -> Security and credentials   | Ongoing security posture                            |
| Validate connected credential     | Agent -> Security and credentials   | Credential health management                        |
| Migrate legacy credential         | Agent -> Security and credentials   | Security upgrade                                    |
| Remove legacy external assignment | Agent -> Security and credentials   | Secret-exposure cleanup                             |
| Disconnect local credential       | Agent -> Security and credentials   | Credential lifecycle management                     |
| Remote revoke guidance            | Agent -> Security and credentials   | External security action                            |
| Require Windows verification      | Agent -> Security and credentials   | Security policy                                     |
| Run security check                | Agent -> Security and credentials   | Diagnosis                                           |
| Repair security issue             | Agent -> Security and credentials   | Recovery                                            |
| Reload Agent config               | Agent -> Recovery                   | Configuration-source recovery                       |
| Restart daemon                    | General or Agent -> Recovery        | Lifecycle recovery                                  |

Provider may show a read-only security summary and a **Manage security** navigation row. Security and credentials may show **Connect** or **Replace** as navigation links when needed, but it must route to Provider rather than duplicate the connection implementation.

## 6. Architecture

### 6.1 Components

Add three narrow daemon components:

1. `AgentSecurityDoctor`
   - Performs read-only probes.
   - Produces typed, secret-free findings.
   - Does not mutate config, files, credentials, or provider state.
   - Defaults to local-only checks.

2. `AgentSecurityRepairService`
   - Converts selected findings into a bound repair preview.
   - Applies only actions listed in that preview.
   - Delegates mutations to existing config, credential, provider, and legacy-removal primitives.
   - Runs post-repair diagnosis before reporting success.

3. `AgentSecurityRepairJournal`
   - Persists preview bindings, idempotency receipts, operation state, and verification outcome.
   - Stores no credential, ciphertext, raw external-file content, authorization URL, token, or secret-like value.
   - Supports restart recovery and uncertain-client-result resolution.

The gateway exposes these components. The TUI and CLI remain thin clients.

### 6.2 Dependency direction

```text
TUI settings client ----\
                         -> authenticated Agent repair API
CLI repair client ------/                |
                                         v
                              AgentSecurityRepairService
                               /          |          \
                              v           v           v
                    AgentSecurityDoctor  Journal  Existing daemon primitives
                                                     |
                                      config manager / credential store /
                                      OpenRouter connection / legacy cleanup
```

No lifecycle or credential logic moves into the TUI. The CLI must not read or decrypt the managed credential.

### 6.3 Repair journal

Use a dedicated SQLite database under the Agent state directory, for example:

```text
<state-dir>/agent/repair.sqlite
```

Apply the same current-user path restriction used for sensitive Agent state. The journal is not secret storage, but restricting it prevents tampering with confirmations and idempotency receipts.

Tables:

```text
repair_previews
  preview_id
  scope
  created_at
  expires_at
  expected_config_revision
  expected_credential_id_hash
  expected_source_fingerprint
  requested_action_ids_json
  risk_class
  requires_network
  requires_restart
  status

repair_operations
  operation_id
  preview_id
  idempotency_key
  started_at
  completed_at
  state
  outcome
  applied_action_ids_json
  verification_issue_codes_json
  redacted_error_code
```

Do not store:

- Raw credential IDs when a keyed or one-way identity hash is sufficient.
- External source paths when a safe source label is sufficient.
- Raw error bodies.
- Raw provider metadata beyond already-safe fields.
- Any before/after file contents.

Preview TTL should be short, such as ten minutes. An expired preview is never revived.

### 6.4 Concurrency

- Allow only one active Agent-security repair apply operation per daemon.
- Allow concurrent read-only diagnosis.
- Coalesce identical local-only diagnosis requests when practical.
- Bind every preview to config revision, credential identity, source fingerprint, selected actions, and security mode.
- Reject apply if any binding changed.
- Require a caller-supplied idempotency key for apply.
- Replaying the same idempotency key returns the stored receipt.
- Reusing the key for a different preview is a conflict.
- A daemon restart marks a running operation `interrupted`; startup recovery re-diagnoses but never blindly repeats a mutation.

## 7. Security Doctor Contract

### 7.1 Default probe policy

The default check is local and silent:

- Read the daemon's safe Agent config and active revision.
- Refresh managed-credential readability through the existing credential store.
- Validate the protected envelope structure and bounds.
- Verify current-user ACLs on the credential directory, envelope, and repair journal.
- Report safe credential metadata already held by the daemon.
- Inspect only the currently selected external config source when legacy migration state requires it.
- Detect stale OAuth connection state.
- Check Windows-verification capability without prompting.
- Inspect existing Agent diagnostics.

It must not:

- Contact OpenRouter.
- Launch a browser.
- Prompt for Windows verification.
- Start an Agent run.
- Change configuration.
- Search unselected files.
- Return the secret or any reversible representation of it.

Provider validation is an explicit online probe, requested through the TUI action or CLI `--online`.

### 7.2 Finding shape

```ts
interface AgentSecurityFinding {
  id: string;
  code: string;
  severity: "info" | "warning" | "error";
  state: "healthy" | "attention" | "blocked";
  title: string;
  message: string;
  checkedAt: string;
  evidence: Record<string, boolean | number | string | null>;
  repairability: "none" | "automatic" | "confirmation" | "external" | "manual";
  recommendedActionId?: string;
  alternateActionIds?: string[];
  requiresNetwork: boolean;
  requiresRestart: boolean;
  reversible: boolean;
  userAction?: string;
}
```

Evidence is an allowlisted safe object. Paths, secrets, ciphertext, environment values, provider response bodies, and authorization URLs are forbidden.

### 7.3 Reuse existing codes

Reuse current codes where they already represent the condition:

- `AGENT_CREDENTIAL_MISSING`
- `AGENT_CREDENTIAL_DPAPI_PROTECT_FAILED`
- `AGENT_CREDENTIAL_DPAPI_UNPROTECT_FAILED`
- `AGENT_CREDENTIAL_CORRUPT`
- `AGENT_PROVIDER_KEY_UNVERIFIED`
- `AGENT_CREDENTIAL_EXPIRED`
- `AGENT_CONFIG_SOURCE_UNAVAILABLE`
- `AGENT_CONFIG_SOURCE_UNSTABLE`
- `AGENT_CONFIG_RELOAD_INVALID`
- `AGENT_LEGACY_CREDENTIAL_REMOVAL_UNAVAILABLE`
- `AGENT_LEGACY_CREDENTIAL_REMOVAL_STALE`
- `AGENT_WINDOWS_VERIFICATION_UNAVAILABLE`
- `AGENT_PROVIDER_REVOCATION_UNCONFIRMED`

Add codes only for uncovered states:

- `AGENT_CREDENTIAL_ACL_WEAK`
- `AGENT_LEGACY_CREDENTIAL_PRESENT`
- `AGENT_CREDENTIAL_SOURCE_SHELL_OWNED`
- `AGENT_PROVIDER_METADATA_STALE`
- `AGENT_PROVIDER_CONNECTION_STALE`
- `AGENT_SECURITY_REPAIR_PREVIEW_STALE`
- `AGENT_SECURITY_REPAIR_CONFLICT`
- `AGENT_SECURITY_REPAIR_INTERRUPTED`
- `AGENT_SECURITY_REPAIR_VERIFICATION_FAILED`

Agent disabled, remote model disabled, and model missing remain configuration findings. Bare `relaybase repair` may report them under an Agent configuration lane and link to Configuration, but the Security and credentials page must not imply that enabling remote calls is a security repair.

## 8. Repair Action Taxonomy

Every repair action has a stable ID and risk class.

### 8.1 Risk classes

| Class               | Meaning                                                                                                              | Confirmation                                                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `read_only`         | Diagnosis or preview only                                                                                            | None                                                                           |
| `safe_local`        | Idempotent local reconciliation with no secret deletion, config activation, external call, or lifecycle interruption | May be grouped by `--safe`; mutation still requires explicit CLI authorization |
| `guarded_local`     | Changes ACL, metadata, or active local state                                                                         | Preview and confirmation                                                       |
| `destructive_local` | Deletes a local credential or plaintext assignment                                                                   | Specific preview and strong confirmation                                       |
| `external`          | Contacts or redirects to provider authority                                                                          | Explicit online/external confirmation                                          |
| `manual`            | Relaybase lacks safe authority                                                                                       | No apply operation                                                             |

### 8.2 Initial action registry

| Action ID                           | Risk                | Behavior                                                                                                                |
| ----------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `refresh_managed_credential_state`  | `safe_local`        | Read back the current protected envelope, clear plaintext promptly, and refresh safe readability state                  |
| `clear_stale_provider_connection`   | `safe_local`        | Close and remove an expired daemon-owned OAuth attempt/listener                                                         |
| `repair_credential_acl`             | `guarded_local`     | Reapply current-user ACLs to the exact credential directory and envelope, then verify                                   |
| `validate_managed_credential`       | `external`          | Make the safe provider metadata request and persist verified metadata                                                   |
| `migrate_legacy_credential`         | `guarded_local`     | Validate, protect with DPAPI, durable-readback, and atomically activate managed mode while preserving the legacy source |
| `remove_legacy_external_assignment` | `destructive_local` | Use the existing exact preview-bound atomic removal primitive; never create a plaintext backup                          |
| `disconnect_local_credential`       | `destructive_local` | Delete the exact local protected credential and clear its reference; remote key may remain active                       |
| `open_provider_key_management`      | `external`          | Return the safe OpenRouter management URL and record that revocation is unconfirmed                                     |
| `reload_selected_agent_config`      | `guarded_local`     | Use existing validate-and-activate reload; preserve last-known-good state on failure                                    |
| `route_to_provider_connect`         | `manual`            | Navigate to Provider connect/reconnect; no repair apply                                                                 |
| `route_to_provider_replace`         | `manual`            | Navigate to Provider replace; no repair apply                                                                           |
| `route_to_configuration`            | `manual`            | Navigate to non-secret Agent configuration                                                                              |
| `route_to_daemon_restart`           | `manual`            | Explain why shell-owned startup state needs restart; use the existing restart confirmation flow                         |

Do not add a generic `fix_all`. The only grouped operation is `safe_local`, and its contents must be enumerated in the preview.

## 9. Repair Pipeline

### 9.1 Inspect

The doctor returns a snapshot:

- Scope.
- Config revision.
- Credential identity hash.
- Source fingerprint or safe source state.
- Findings.
- Available action registry entries.
- Whether an online check was requested and completed.

No mutation occurs.

### 9.2 Select

The user or CLI selects:

- One finding.
- One explicit action.
- Or all currently applicable `safe_local` actions.

The daemon refuses action IDs that do not apply to the current finding.

### 9.3 Preview

The repair service re-runs the necessary probes and returns:

```ts
interface AgentSecurityRepairPreview {
  previewId: string;
  scope: "agent-security";
  createdAt: string;
  expiresAt: string;
  findings: AgentSecurityFinding[];
  actions: Array<{
    id: string;
    title: string;
    riskClass: string;
    changes: string[];
    preserves: string[];
    requiresNetwork: boolean;
    requiresRestart: boolean;
    reversible: boolean;
  }>;
  confirmation: {
    required: boolean;
    phrase?: string;
    warning?: string;
  };
  expectedConfigRevision: string;
}
```

The preview describes behavior, not secret values or raw file differences.

### 9.4 Confirm

- `safe_local`: one explicit confirmation in the TUI; CLI requires `--yes` for mutation.
- `guarded_local`: preview plus explicit confirmation.
- `destructive_local`: preview plus action-specific confirmation phrase.
- `external`: explicit opt-in to network or browser use.
- `manual`: no apply button.

The current Enter-again mechanism is insufficient for a multi-action repair flow. Use a dedicated repair preview page inside the settings transient.

### 9.5 Apply

Before the first mutation, the service verifies:

- Preview exists and is unexpired.
- Config revision still matches.
- Credential identity still matches.
- Selected source fingerprint still matches.
- Requested actions exactly match the preview.
- Confirmation token matches.
- No other repair is applying.

Each action calls an existing narrow daemon primitive. Do not duplicate DPAPI, provider, legacy-removal, config reload, or disconnect logic in the repair service.

### 9.6 Verify

The daemon re-runs all relevant local probes after apply. An online validation action also verifies the safe provider metadata result.

Outcomes:

- `verified`: all targeted findings resolved.
- `partial`: at least one action completed but findings remain.
- `blocked`: nothing unsafe was attempted; manual or external action remains.
- `failed`: the requested mutation failed and target state was not reached.
- `interrupted`: daemon stopped before a durable result was known.

`applied` alone is never treated as success.

### 9.7 Receipt

The receipt contains:

- Operation ID.
- Preview ID.
- Start and completion time.
- Applied action IDs.
- Verification outcome.
- Remaining issue codes.
- Whether restart, reconnect, or external provider work remains.
- Redacted audit event IDs.

It contains no raw path, secret, ciphertext, environment value, provider response, or authorization URL except the fixed safe provider-management URL where explicitly requested.

## 10. API Plan

### 10.1 Routes

Add:

```text
GET  /__hub/api/agent/security/status
POST /__hub/api/agent/security/diagnose
POST /__hub/api/agent/security/repair/preview
POST /__hub/api/agent/security/repair/apply
GET  /__hub/api/agent/security/repair/operations/:operationId
POST /__hub/api/agent/security/repair/operations/:operationId/cancel
```

The general `relaybase repair` CLI may later use a generic discovery route:

```text
GET /__hub/api/repair/scopes
```

Do not block the first Agent-security implementation on a generic server-wide repair framework. Define the common TypeScript interfaces now, keep the first routes Agent-owned, and add the discovery route only when a second repair scope exists.

### 10.2 Request rules

- Every route requires the local daemon token.
- Every response is `no-store`.
- Body limit remains bounded.
- Unknown fields are rejected.
- A raw key, token-shaped value, ciphertext, or environment value is rejected before service dispatch.
- Diagnose defaults to `{ online: false }`.
- Online validation requires `{ online: true }`.
- Apply requires `previewId`, `idempotencyKey`, and the exact confirmation value.
- Cancel is accepted only before a non-cancellable atomic mutation begins.

### 10.3 Response rules

- Run every payload through Agent sanitization.
- Serialize only allowlisted DTOs.
- Never serialize internal Error objects.
- Never return DPAPI blobs.
- Never return raw credential IDs unless an existing compatibility contract requires them; prefer safe opaque state or a hash.
- Return typed conflict codes for stale preview, revision drift, credential drift, source drift, duplicate action, and concurrent operation.

### 10.4 Compatibility

Keep existing provider endpoints through at least one compatibility window. The new repair service should call the same underlying gateway methods, not call the old HTTP routes internally.

After the TUI moves management actions to Security and credentials:

- Existing CLI `relaybase agent provider validate|migrate|cleanup-legacy|disconnect|revoke` continues to work.
- Help text points to the new `relaybase repair --agent-security` workflow for diagnosis and recovery.
- No command is silently reinterpreted.

## 11. CLI Plan

### 11.1 Command grammar

```text
relaybase repair
relaybase repair --agent-security
relaybase repair --agent-security --online
relaybase repair --agent-security --issue <code>
relaybase repair --agent-security --action <action-id> --plan
relaybase repair --agent-security --action <action-id> --yes
relaybase repair --agent-security --safe --plan
relaybase repair --agent-security --safe --yes
relaybase repair --agent-security --apply <preview-id> --yes
relaybase repair --operation <operation-id>
relaybase repair --agent-security --json
```

### 11.2 Semantics

- Bare `relaybase repair` is read-only unless an interactive TTY user selects and confirms an action.
- `--agent-security` selects the Agent-security scope.
- `--online` permits provider validation; without it, the command is local-only.
- `--issue` filters the displayed findings and action choices.
- `--action ... --plan` creates and prints a bound preview.
- `--action ... --yes` creates a preview, authorizes that exact action non-interactively, applies it, and verifies it.
- `--safe --plan` previews every currently applicable `safe_local` action.
- `--safe --yes` applies only the enumerated `safe_local` actions.
- `--apply <preview-id> --yes` applies a previously returned preview.
- `--operation` resolves an uncertain or interrupted result.
- `--json` emits one stable JSON document and never prompts.
- Mutation without `--yes` in a non-interactive terminal fails without changing state.

### 11.3 Interactive flow

In a TTY:

1. Diagnose.
2. Show healthy, attention, and blocked summaries.
3. Let the user select a finding.
4. Show available repairs.
5. Render the full preview.
6. Ask the required confirmation.
7. Apply and show progress.
8. Verify and print the receipt.

Ctrl+C before apply changes nothing. Ctrl+C during a cancellable step requests cancel and waits for a bounded receipt. During an atomic mutation, the CLI states that cancellation is pending and resolves the operation before exiting where possible.

### 11.4 Exit codes

| Code | Meaning                                                                                   |
| ---- | ----------------------------------------------------------------------------------------- |
| `0`  | Healthy, or requested repair completed and verified                                       |
| `1`  | Transport, authentication, internal, or unexpected execution failure                      |
| `2`  | Findings remain, confirmation is required, or read-only diagnosis found actionable issues |
| `3`  | Manual or external action is required                                                     |
| `4`  | Preview or state binding is stale; re-run diagnosis                                       |

JSON also returns `outcome`, `healthy`, `issueCount`, `remainingIssueCodes`, and `operationId` so scripts do not parse prose.

### 11.5 Daemon availability

The repair engine is daemon-owned.

- The TUI already has a daemon connection.
- CLI repair first attempts the configured daemon and authenticated state directory.
- It must not silently operate on files when the daemon is unavailable.
- Interactive mode may offer to start the daemon through the existing launcher.
- Non-interactive mode requires an explicit future `--start-daemon` flag if automatic start is needed.
- Starting the daemon must use the existing child-environment scrubber.

### 11.6 CLI environment prerequisite

`src/cli.ts` currently loads Relaybase environment-file state before command dispatch. The implementation must refactor command startup so control-client commands do not hydrate legacy Agent secrets into the CLI process.

At minimum:

- `repair`, daemon-control, and token-gated Agent control commands must skip secret-bearing environment hydration.
- The daemon remains the only process that reads or decrypts the managed credential.
- Repair JSON, stderr, debug output, and spawned browser/daemon environments must be secret-free.
- Legacy source inspection occurs inside the daemon and only for the selected source.

This is a release blocker for the new repair command.

## 12. TUI Settings Plan

### 12.1 Navigation

Agent category becomes:

- Status
- Provider
- Security and credentials
- Configuration
- Safety and permissions
- Execution
- Budgets
- Recovery

Add direct navigation:

```text
/settings agent security
```

Keep:

```text
/settings
/settings agent
```

Update slash parsing, catalog, completion, help, and regression tests without changing unrelated commands.

### 12.2 Provider page after the split

Keep:

- Provider name.
- Connection summary.
- Connect OpenRouter.
- Replace credential.
- Current provider/model summary.
- **Manage security** navigation action.

Move these management actions to Security and credentials:

- Validate.
- Migrate.
- Remove legacy assignment.
- Revoke guidance.
- Disconnect.
- Require Windows verification.
- DPAPI limitation.

Provider can retain concise read-only protection status so users understand the connection result, but it must not duplicate the management controls.

### 12.3 Security and credentials page

Groups and rows:

**Overview**

- Security status: healthy, attention, or blocked.
- Provider connection.
- Credential source.
- Last checked.
- Last successful validation.

**Protection**

- Storage: Windows DPAPI/current user, legacy external, shell environment, or none.
- Protected credential readable.
- Current-user ACL.
- Require Windows verification.
- DPAPI limitation: does not defeat same-user malware.

**Provider key**

- Safe key label.
- Spending limit and remaining limit when provider reports them.
- Expiration.
- **Validate now**.
- **Replace in Provider** navigation.
- Dedicated-key guidance: Relaybase-only key, conservative spending limit, and expiration.

**Migration and cleanup**

- Legacy source status.
- **Move legacy key to protected storage**.
- **Remove legacy external assignment**.
- Shell-owned source guidance when Relaybase cannot remove it.

**Connection management**

- **Open OpenRouter key management**.
- **Disconnect locally**.
- Explicit warning that local disconnect does not prove remote revocation.

**Repair and verification**

- **Run security check**.
- Findings count.
- Last repair outcome.
- **Review findings**.

**Audit**

- Last security event time and safe event type.
- **Review repair receipt**.

No row displays a key, partial key, ciphertext, raw credential ID, raw source path, or provider response body.

### 12.4 Findings page

The findings page remains inside the settings transient:

- Healthy checks are collapsed by default.
- Attention and blocked findings appear first.
- Each row shows severity, title, repairability, network requirement, and restart requirement.
- Enter opens finding detail.
- Finding detail offers the recommended repair, safe alternatives, or a navigation/manual action.
- Refresh re-runs diagnosis.
- Esc returns without mutation.

### 12.5 Repair preview page

Show:

- The issue being repaired.
- Exact action names.
- What will change.
- What will be preserved.
- Whether a network request occurs.
- Whether the action can be reversed.
- Whether a restart remains necessary.
- Confirmation text.

For destructive local actions, require an explicit confirmation phrase or a dedicated second confirmation control. Do not rely on an ambiguous second Enter on the original row.

### 12.6 Progress and cancellation

Progress states:

- Rechecking state.
- Applying local repair.
- Waiting for provider validation.
- Verifying result.
- Completed, partial, blocked, failed, or interrupted.

Cancellation is offered only when the daemon reports the current step cancellable. Closing the TUI does not cancel an atomic repair. Reopening Security and credentials uses the operation ID to resolve the durable result.

### 12.7 Result page

Show:

- Verified outcome.
- Applied actions.
- Remaining findings.
- Required manual/provider/restart step.
- Retry when safe.
- Open Provider, Configuration, Recovery, or provider key management as appropriate.

Do not show a generic success toast before post-repair verification.

### 12.8 Modal behavior

- Existing settings transient remains the input owner.
- No nested global modal may steal focus from the repair preview.
- Keyboard, mouse, small-terminal scrolling, resize, and focus restoration must work.
- Closing the modal returns focus to the prior workspace control.
- Daemon disconnect preserves the last safe snapshot, disables mutations, and offers reconnect.
- No repair/control-plane state drives the Agent thinking shimmer.

## 13. Security Hardening

### 13.1 Silent default

Regular Agent use remains silent. Current-user DPAPI decryption must not show an unlock prompt.

Require Windows verification is optional and off by default. Until Relaybase can prove secure interactive prompt ownership:

- Show it as unavailable.
- Reject attempts to enable it.
- Never silently downgrade a requested high-security mode.
- Do not report unavailable capability as an unhealthy default configuration.

### 13.2 Dedicated credential

Provider onboarding and security guidance should encourage:

- A key dedicated to Relaybase.
- A conservative spending limit.
- An expiration date.
- Rotation through replace-before-disconnect.

Absence of a provider-reported limit or expiration is a warning or informational finding, not proof of insecurity and not an automatic mutation target.

### 13.3 Daemon-only plaintext

Plaintext credentials must never enter:

- TUI models or render data.
- CLI arguments, stdin, stdout, stderr, or JSON.
- API requests or responses.
- Generic Agent config.
- `.env` during managed operation.
- Diagnostics.
- Audit events.
- Session/thread storage.
- Repair previews or journal rows.
- Crash/recovery artifacts.
- Child-process environments.

The daemon may hold plaintext only in a bounded credential lease. Clear:

- DPAPI plaintext buffers.
- Temporary validation buffers.
- Candidate replacement buffers.
- OAuth exchange response buffers where controllable.
- Known-secret redaction lists after the operation.

### 13.4 OAuth PKCE

Connection and replacement remain daemon-owned OAuth PKCE flows:

- Loopback listener on a random port.
- One-use state.
- Short expiry.
- No client secret in the TUI/CLI.
- Credential delivered directly to the daemon.
- Browser child environment scrubbed.
- Listener closed after success, terminal failure, cancellation, or timeout.

The repair service may clear a stale attempt or route to Provider reconnect. It must not recreate OAuth logic.

### 13.5 Audit

Add redacted events:

- `agent.security_diagnosed`
- `agent.security_repair_previewed`
- `agent.security_repair_started`
- `agent.security_repair_cancel_requested`
- `agent.security_repair_completed`
- `agent.security_repair_partial`
- `agent.security_repair_blocked`
- `agent.security_repair_failed`
- `agent.security_repair_interrupted`

Safe fields:

- Operation and preview IDs.
- Issue and action IDs.
- Risk class.
- Outcome.
- Duration.
- Requires-network/restart booleans.
- Redaction replacement counts.

Forbidden fields:

- Secrets and secret-like values.
- Ciphertext.
- Raw credential IDs.
- Raw source paths or contents.
- Authorization URLs.
- Provider error bodies.

### 13.6 Honest DPAPI boundary

Product copy and documentation must say:

> Current-user Windows DPAPI reduces offline, cross-user, and accidental plaintext exposure. It does not defeat malware, injected code, debuggers, or other processes already running with the same Windows user authority.

Do not imply that ACL repair or Windows verification changes this fundamental boundary.

### 13.7 Future stronger tier

A future service may hold the provider key remotely and issue short-lived client access. That can reduce the value of local credential theft, but it introduces account, backend, availability, privacy, and trust requirements.

It is not part of this implementation. Do not add dormant remote-broker code, APIs, settings, or claims.

## 14. Failure and Recovery Matrix

| Condition                                        | Diagnosis                                 | Safe automatic action  | Confirmed action                                                   | Recovery/result                                                |
| ------------------------------------------------ | ----------------------------------------- | ---------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------- |
| Healthy managed credential                       | Healthy                                   | None                   | Optional online validation                                         | No action                                                      |
| Credential reference absent                      | `AGENT_CREDENTIAL_MISSING`                | Refresh state          | None                                                               | Route to Provider connect                                      |
| Envelope missing                                 | `AGENT_CREDENTIAL_MISSING`                | Refresh state          | None                                                               | Reconnect; never invent or scan for a key                      |
| Envelope corrupt                                 | `AGENT_CREDENTIAL_CORRUPT`                | None                   | Disconnect broken local reference only after explicit confirmation | Reconnect/replace                                              |
| DPAPI wrong user/profile                         | `AGENT_CREDENTIAL_DPAPI_UNPROTECT_FAILED` | None                   | None                                                               | Use original user/profile or reconnect                         |
| DPAPI native module unavailable                  | Protect/unprotect failure                 | None                   | None                                                               | Repair installation; do not downgrade to plaintext             |
| Credential ACL weak                              | `AGENT_CREDENTIAL_ACL_WEAK`               | None                   | Reapply exact current-user ACL                                     | Verify access; reconnect if still unsafe                       |
| Credential connected but unverified              | `AGENT_PROVIDER_KEY_UNVERIFIED`           | None                   | Online validation                                                  | Stay blocked until validation succeeds                         |
| Credential expired                               | `AGENT_CREDENTIAL_EXPIRED`                | None                   | None                                                               | Replace in Provider                                            |
| Provider offline/timeout                         | Safe provider diagnostic                  | None                   | Retry online validation                                            | Local credential remains unchanged                             |
| Provider rejects key                             | Provider invalid-key diagnostic           | None                   | None                                                               | Replace; preserve safe metadata                                |
| Legacy external key active                       | `AGENT_LEGACY_CREDENTIAL_PRESENT`         | None                   | Migrate to DPAPI                                                   | Preserve external source until durability and validation pass  |
| Managed credential plus one legacy assignment    | Legacy-present warning                    | None                   | Exact removal                                                      | Preview-bound atomic removal, then reload and verify           |
| Multiple legacy assignments                      | Removal unavailable                       | None                   | None                                                               | Manual disambiguation; no file change                          |
| Selected source changed after preview            | Repair stale/conflict                     | None                   | None                                                               | Re-diagnose and create fresh preview                           |
| Shell-owned legacy key                           | `AGENT_CREDENTIAL_SOURCE_SHELL_OWNED`     | None                   | None                                                               | Clear in parent shell/service config, then safe daemon restart |
| Selected config unavailable                      | Existing source diagnostic                | None                   | Restore source, then guarded reload                                | Last-known-good revision remains active                        |
| Selected config invalid                          | Existing reload diagnostic                | None                   | Edit source, then guarded reload                                   | Last-known-good revision remains active                        |
| OAuth attempt expired                            | Connection-stale finding                  | Clear stale attempt    | Reconnect in Provider                                              | No credential mutation                                         |
| Replace validation/write failure                 | Provider/protect diagnostic               | Clear expired attempt  | Retry replace                                                      | Old credential remains active                                  |
| Remote revocation unsupported                    | Revocation unconfirmed                    | None                   | Open provider management                                           | Revoke externally, then disconnect locally                     |
| Local disconnect succeeds, remote status unknown | Revocation-unconfirmed warning            | None                   | None                                                               | Keep warning until user acknowledges external state            |
| Windows verification unsupported and off         | Informational capability                  | None                   | None                                                               | Normal silent DPAPI use                                        |
| Windows verification required but unavailable    | Verification-unavailable error            | None                   | Disable requested mode or repair supported installation            | Never silently downgrade                                       |
| Repair preview expires                           | Preview stale                             | None                   | None                                                               | Re-diagnose                                                    |
| Concurrent config/credential change              | Repair conflict                           | None                   | None                                                               | Re-diagnose                                                    |
| Duplicate apply request                          | Existing idempotent receipt               | Return receipt         | None                                                               | No repeated mutation                                           |
| CLI loses response after apply                   | Unknown client result                     | Query operation        | None                                                               | Resolve durable receipt before retry                           |
| Daemon exits before mutation                     | Interrupted                               | Re-diagnose            | Reapply fresh preview                                              | No mutation assumed                                            |
| Daemon exits during/after atomic mutation        | Interrupted                               | Startup reconciliation | Fresh confirmation only if target not reached                      | Never blindly replay                                           |
| Post-apply verification fails                    | Verification failed                       | Re-diagnose            | Targeted retry if safe                                             | Report partial/failed, not success                             |
| TUI disconnects during repair                    | Operation continues if atomic             | Query on reconnect     | Cancel only if daemon permits                                      | Show durable result                                            |

## 15. Migration and Compatibility

### 15.1 TUI migration

1. Add Security and credentials while existing Provider actions still work.
2. Route the new page to existing gateway methods through the new repair service.
3. Add tests for both pages.
4. Move management rows from Provider.
5. Leave connect, replace, summary, and Manage security on Provider.
6. Preserve keyboard order and deep-link behavior.
7. Update docs only after tests verify the new ownership.

### 15.2 CLI migration

1. Add `relaybase repair --agent-security` without removing existing Agent provider commands.
2. Refactor command startup so repair/control clients do not hydrate secrets.
3. Add help cross-links:
   - Project setup issue: `relaybase configure --repair`.
   - Source command issue: `relaybase repair-prefix`.
   - Agent credential issue: `relaybase repair --agent-security`.
4. Keep old provider subcommands as direct expert controls.
5. Consider deprecation only after at least one documented release and usage evidence; no deprecation is required by this plan.

### 15.3 Existing credential states

- Managed DPAPI: no migration; doctor verifies it.
- External selected source: offer protected migration, then exact cleanup.
- Shell environment: offer protected migration; cleanup remains manual because a child cannot edit its parent environment.
- Missing/corrupt managed blob: reconnect; do not fall back to a discovered environment key.
- Connected-unverified: online validation.

### 15.4 Repair journal migration

- Create the journal lazily on first repair diagnosis or preview.
- Schema migration is versioned and transactional.
- A journal migration failure disables mutation but not safe Agent operation.
- Report a redacted diagnostic and keep existing credential/config state unchanged.
- Never delete or recreate a corrupt journal automatically without a recovery preview.

## 16. Implementation Phases

### Phase 0: Baseline and protected workspace

- Record current dirty-worktree paths.
- Do not overwrite unrelated Agent/TUI work.
- Run focused existing tests for provider, config manager, credential store, legacy removal, Agent API, CLI parsing, settings, client routes, and shimmer.
- Record pre-existing failures separately.

Gate: the baseline and protected file set are known.

### Phase 1: Contracts and pure doctor

- Add shared finding, action, preview, operation, and receipt types.
- Implement local-only `AgentSecurityDoctor`.
- Reuse current diagnostics and safe config state.
- Add allowlisted evidence serialization.
- Add unit fixtures for every finding.

Gate: diagnosis is deterministic, read-only, and secret-free.

### Phase 2: Journal and preview binding

- Add the SQLite repair journal.
- Restrict its path to the current user.
- Add TTL cleanup.
- Add config revision, credential identity, source fingerprint, action-set, and idempotency bindings.
- Add interrupted-operation startup reconciliation.

Gate: stale, conflicting, duplicate, and interrupted operations are deterministic.

### Phase 3: Repair service

- Register stable action IDs and risk classes.
- Delegate to existing config manager, credential store, provider connection, and legacy-removal primitives.
- Add apply serialization and cancellation boundaries.
- Add mandatory post-apply diagnosis.
- Add redacted audit events.

Gate: no repair reports success without verification.

### Phase 4: API

- Add authenticated security status, diagnose, preview, apply, operation, and cancel routes.
- Enforce no-store, size bounds, strict schemas, confirmation tokens, and secret-shaped input rejection.
- Add DTO sanitization and API tests.

Gate: API tests prove auth, binding, idempotency, redaction, and no raw secret transport.

### Phase 5: CLI

- Add command and flags.
- Refactor pre-dispatch environment loading.
- Implement TTY and non-TTY behavior.
- Add JSON schema and exit codes.
- Add bounded daemon availability handling.
- Update help.

Gate: every mutation requires explicit authorization and the CLI never receives a secret.

### Phase 6: TUI client and settings

- Add client types and methods.
- Add Bubble Tea commands/messages.
- Add Security and credentials page.
- Add findings, preview, progress, result, and reconnect flows.
- Move management actions from Provider.
- Add `/settings agent security`.
- Preserve shimmer authority and modal ownership.

Gate: keyboard, mouse, resize, small-terminal, offline, stale-preview, and reconnect tests pass.

### Phase 7: Migration and recovery

- Add managed, external, shell, missing, corrupt, wrong-profile, weak-ACL, unverified, expired, and stale-OAuth flows.
- Add restart reconciliation.
- Add uncertain-result resolution.
- Verify exact legacy cleanup remains preview-bound.

Gate: every failure-matrix row has deterministic evidence.

### Phase 8: Documentation and release

- Update user docs, CLI docs, keymap, Operator Agent docs, safety docs, troubleshooting, API contract, and testing docs.
- Run focused, full, TUI, native, race, package, and secret-scan gates.
- Run optional live provider validation only with explicit authorization and a dedicated bounded key.
- Do not claim release until Windows architecture and signing gates pass.

## 17. Planned File Map

Likely new files:

```text
src/agent/securityDoctor.ts
src/agent/securityRepairService.ts
src/agent/securityRepairJournal.ts
tests/agent-security-doctor.test.ts
tests/agent-security-repair.test.ts
tui/internal/tui/model/agent_security_settings_test.go
```

Likely modified files:

```text
src/agent/types.ts
src/agent/gateway.ts
src/agent/api.ts
src/agent/configManager.ts
src/agent/credentialStore.ts
src/agent/windowsCredentialStore.ts
src/agent/openrouterConnection.ts
src/agent/auditStore.ts
src/cli.ts
tests/agent-api.test.ts
tests/agent-provider-connection.test.ts
tests/agent-credential-store.test.ts
tests/agent-legacy-credential-removal.test.ts
tests/setup.test.ts
tui/internal/relaybaseclient/types.go
tui/internal/relaybaseclient/client.go
tui/internal/relaybaseclient/client_test.go
tui/internal/tui/commands/commands.go
tui/internal/tui/model/model.go
tui/internal/tui/model/settings.go
tui/internal/tui/model/model_test.go
tui/internal/tui/slash/catalog.go
tui/internal/tui/slash/slash.go
tui/internal/tui/slash/slash_test.go
tui/internal/tui/views/views.go
tui/internal/tui/views/views_test.go
docs/cli.md
docs/operator-agent.md
docs/operator-console.md
docs/troubleshooting.md
docs/tui-agent-openrouter.md
docs/tui-agent-safety.md
docs/tui-agent-testing.md
docs/tui-api-contract.md
docs/tui-keymap.md
```

The implementation may use fewer files if existing components offer a cleaner boundary. It must not put repair logic into `settings.go`, CLI rendering, or TUI commands.

## 18. Test Plan

### 18.1 Doctor unit tests

Test:

- Healthy managed credential.
- Missing reference.
- Missing envelope.
- Corrupt envelope.
- Oversized envelope.
- DPAPI unprotect failure.
- Wrong-user/profile fixture where supported.
- Weak directory ACL.
- Weak file ACL.
- Connected-unverified.
- Expired safe metadata.
- No spending limit/expiration guidance.
- Legacy selected source.
- Shell-owned legacy source.
- Ambiguous legacy assignment.
- Unavailable/invalid/unstable selected source.
- Stale OAuth attempt.
- Windows verification available/unavailable without prompt.
- Local-only diagnosis makes zero provider calls.
- Evidence allowlist excludes paths, IDs, values, and response bodies.

### 18.2 Journal and preview tests

Test:

- Preview persists and loads.
- Expiry.
- Config revision drift.
- Credential identity drift.
- Source fingerprint drift.
- Action-set mismatch.
- Concurrent apply.
- Same-key idempotent replay.
- Same key with different preview conflict.
- Journal ACL failure disables mutation.
- Schema migration rollback.
- Corrupt journal recovery is fail-closed.
- Restart marks running work interrupted.
- Startup reconciliation detects an already-reached target without repeating mutation.

### 18.3 Repair service tests

For every action:

- Applicable findings.
- Risk class.
- Preview text.
- Confirmation requirement.
- Mutation delegation.
- Preserved state on injected failure.
- Post-apply verification.
- Audit event.
- Secret clearing.

Specific recovery assertions:

- Failed ACL repair leaves the credential blocked rather than claiming safety.
- Failed provider validation preserves the credential as unverified.
- Failed migration preserves legacy mode and source.
- Failed replacement preserves the old credential.
- Stale legacy cleanup preserves the changed file.
- Disconnect cannot report remote revocation.
- Config reload failure preserves the last-known-good revision.
- Grouped safe repair never includes guarded, destructive, external, or manual actions.

### 18.4 API tests

Test:

- Token required on every route.
- `no-store` and `no-cache`.
- Strict body size and schema.
- Raw key and secret-shaped field rejection.
- Local diagnosis does not contact provider.
- Online diagnosis requires opt-in.
- Preview binding.
- Confirmation binding.
- Idempotency.
- Concurrent conflict.
- Cancel rules.
- Operation query after uncertain result.
- All success and error bodies are secret-free.
- Authorization URLs appear only in the existing connection flow, never repair receipts.

### 18.5 CLI tests

Test:

- Help distinguishes all three repair surfaces.
- Bare repair is read-only.
- `--agent-security` selection.
- `--online`.
- `--issue`.
- `--action --plan`.
- `--action --yes`.
- `--safe --plan`.
- `--safe --yes`.
- `--apply --yes`.
- Missing confirmation.
- Unknown flag.
- Conflicting flags.
- TTY cancellation.
- Non-TTY no-prompt behavior.
- JSON schema.
- Exit codes 0 through 4.
- Daemon offline/auth mismatch.
- Operation query.
- The CLI process does not hydrate or print a legacy Agent secret for repair/control commands.
- Child daemon/browser environment is scrubbed.

Use generated sentinel secrets and capture stdout, stderr, JSON, debug logs, environment snapshots, and temporary state for secret scans.

### 18.6 TUI client tests

Test:

- Exact route/method/body for diagnose, preview, apply, operation, and cancel.
- No secret fields in Go DTOs.
- Confirmation and idempotency bindings.
- Typed error decoding.
- Context cancellation.
- No direct filesystem or DPAPI access.

### 18.7 TUI model/view tests

Test:

- Agent page includes Security and credentials.
- `/settings agent security` opens it.
- Provider retains Connect and Replace.
- Provider no longer owns credential-management mutations.
- Security page has all specified groups.
- Secret fields cannot render.
- Findings sort correctly.
- Finding detail navigation.
- Preview and confirmation.
- Destructive confirmation.
- Progress and cancellability.
- Verified, partial, blocked, failed, and interrupted results.
- Stale preview refresh.
- Daemon disconnect and reconnect.
- Closing and reopening resolves an active operation.
- Keyboard and mouse parity.
- Focus restoration.
- Small terminal scrolling.
- Resize while preview/progress is open.
- Control-plane activity never activates the thinking shimmer.
- Model-processing activity continues to activate shimmer and terminal events stop it.

### 18.8 Native and credential tests

Retain and extend:

- DPAPI round trip with generated fixture.
- Buffer clearing.
- Envelope corruption and size bounds.
- Current-user ACL enforcement.
- ACL inspection and reapplication.
- x64 and arm64 build/package presence.
- Signed native artifact gates.
- No plaintext in package contents or test artifacts.

Never use the user's real key.

### 18.9 Deterministic end-to-end matrix

Use a disposable state directory, generated sentinel secrets, fake credential store where appropriate, and a local fake OpenRouter metadata endpoint.

Scenarios:

1. Healthy managed credential -> diagnose -> no repair.
2. Connected-unverified -> online preview -> validate -> verified.
3. Legacy selected source -> migrate -> protected verified -> exact cleanup -> verified.
4. Shell-owned legacy source -> migrate -> manual shell cleanup guidance -> restart route.
5. Missing managed blob -> blocked -> Provider reconnect route.
6. Corrupt blob -> blocked -> confirmed local disconnect -> reconnect route.
7. Weak ACL -> preview -> repair -> verified.
8. Provider outage -> validation fails -> credential remains.
9. Source changes after preview -> apply rejected -> fresh preview succeeds.
10. Daemon exits after mutation but before response -> operation query resolves verified result without replay.
11. TUI closes during repair -> reconnect -> durable result.
12. Remote revoke -> external management -> local state preserved until explicit disconnect.

Scan:

- API bodies.
- CLI stdout/stderr/JSON.
- TUI snapshots.
- Agent SQLite databases.
- Repair journal.
- Audit events.
- Logs.
- Session exports.
- Config files.
- External-source replacement artifacts.
- Child environment captures.
- Package archive.

The sentinel must appear nowhere except the intentionally controlled input fixture and DPAPI plaintext inside the native test process before clearing.

### 18.10 Optional live validation

Live OpenRouter validation is:

- Opt-in.
- Non-spending where the provider contract permits metadata validation.
- Run only with a dedicated test key.
- Bounded by time and network retries.
- Not required for deterministic local correctness.
- Never used for automated revoke or destructive key management.

## 19. Verification Commands

Focused implementation loop:

```powershell
npm.cmd exec prettier -- --check src/agent/securityDoctor.ts src/agent/securityRepairService.ts src/agent/securityRepairJournal.ts
npm.cmd run typecheck
npm.cmd exec -- node --experimental-strip-types --test tests/agent-security-doctor.test.ts tests/agent-security-repair.test.ts tests/agent-api.test.ts
npm.cmd run tui:test
```

Full deterministic gate:

```powershell
npm.cmd run format:check
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run test:jest
npm.cmd run agent:test
npm.cmd run tui:test
npm.cmd run tui:vet
npm.cmd run tui:snapshot
npm.cmd run docs:check
```

Windows/native/package gate:

```powershell
npm.cmd run native:build
npm.cmd run package:check
npm.cmd run package:install-smoke
npm.cmd run tui:race
```

Release-candidate gates remain subject to the repository's dual-architecture Windows native and signing requirements.

## 20. Documentation Plan

Update only after behavior is verified:

- `docs/cli.md`: command grammar, exit codes, examples, and distinction from other repairs.
- `docs/operator-agent.md`: page ownership and end-user flows.
- `docs/operator-console.md`: `/settings agent security`.
- `docs/tui-keymap.md`: navigation, focus, confirmation, and result behavior.
- `docs/tui-agent-openrouter.md`: Provider connection versus security management.
- `docs/tui-agent-safety.md`: DPAPI, daemon-only plaintext, audit, and repair boundaries.
- `docs/tui-agent-testing.md`: deterministic and optional live gates.
- `docs/tui-api-contract.md`: routes and DTOs.
- `docs/troubleshooting.md`: failure/recovery matrix in user language.
- `SECURITY.md`: DPAPI limitation and remote-broker non-goal where appropriate.

Documentation must not:

- Claim remote revocation support that is not confirmed.
- Claim Windows verification is available before proof.
- Claim DPAPI defeats same-user malware.
- Include raw local paths, logs, generated databases, fixture secrets, or diagnostic artifacts.
- Call the feature released before release gates pass.

## 21. Acceptance Criteria

Implementation is accepted only when all of the following are true:

1. `/settings -> Agent -> Security and credentials` exists as a dedicated page inside the settings transient.
2. `/settings agent security` opens the page directly.
3. Provider remains the canonical Connect and Replace page.
4. Credential-management actions have moved to Security and credentials without duplicate mutation ownership.
5. The TUI and CLI use one daemon-owned doctor and repair service.
6. Bare diagnosis is read-only and local-only.
7. Provider network validation requires explicit opt-in.
8. Every mutation has a bound preview.
9. Guarded, destructive, and external actions require the correct confirmation.
10. Apply is revision-, credential-, source-, action-, and idempotency-bound.
11. No repair reports success without post-apply verification.
12. A stale preview changes nothing.
13. A duplicate apply does not repeat the mutation.
14. An interrupted or uncertain result can be resolved from a durable receipt.
15. Startup recovery never blindly replays a mutating action.
16. `relaybase repair --agent-security` supports diagnosis, plan, explicit action, safe group, apply, operation query, JSON, and stable exit codes.
17. Existing `configure --repair`, `repair-prefix`, and Agent provider commands keep their meanings.
18. Repair/control CLI commands do not hydrate the Agent credential into the CLI process.
19. Raw credentials never reach TUI state, CLI I/O, API payloads, diagnostics, logs, audits, sessions, repair journal, `.env` in managed mode, crash/recovery artifacts, or child environments.
20. Managed plaintext exists only in a bounded daemon lease and is cleared promptly.
21. Local disconnect never claims remote revocation.
22. Remote revoke guidance preserves the local credential until an explicit disconnect.
23. Failed migration, replacement, validation, config reload, and ACL repair preserve the last safe state.
24. Legacy cleanup changes exactly one preview-bound assignment and creates no plaintext backup.
25. Shell-owned cleanup is reported as manual and may route to safe daemon restart only after the parent source is fixed.
26. Silent current-user DPAPI remains the default.
27. Require Windows verification is either proven and working or visibly unavailable and fail-closed.
28. DPAPI's same-user-malware limitation is visible in Security and credentials and documented.
29. Repair, validation, settings save, OAuth waiting, and all other control-plane work never drive the thinking shimmer.
30. Authoritative model-processing activity continues to drive shimmer, and terminal activity stops it.
31. Keyboard, mouse, focus, resize, small-terminal, offline, reconnect, and cancellation flows pass.
32. Focused, full deterministic, TUI, race, native, package, recovery, and secret-scan gates pass.
33. Optional live validation is separately authorized and does not substitute for deterministic evidence.
34. The feature is not presented as released until Windows architecture and signing gates pass.

## 22. Release Gates

### Gate A: Contract and diagnosis

- Typed findings and actions reviewed.
- Local doctor has no side effects.
- Existing diagnostic codes are reused where correct.
- Secret-free evidence tests pass.

### Gate B: Repair correctness

- Preview/state bindings pass.
- Idempotency and concurrency pass.
- Failure injection preserves safe state.
- Post-apply verification is mandatory.
- Restart reconciliation passes.

### Gate C: Security

- CLI environment-loading prerequisite complete.
- Daemon-only plaintext proof passes.
- ACL and DPAPI tests pass.
- Audit and payload redaction passes.
- Same-user-malware limitation documented.

### Gate D: UX

- Provider/Security ownership is correct.
- TUI navigation, preview, confirmation, progress, result, and recovery pass.
- CLI interactive and automation flows pass.
- Shimmer authority is unchanged.

### Gate E: Compatibility

- Existing provider commands pass.
- `configure --repair` and `repair-prefix` pass.
- Existing Agent config/reload and Provider connect/replace pass.
- Documentation links and help text pass.

### Gate F: Release proof

- Full deterministic suite passes.
- Go race gate passes or a documented platform blocker remains open.
- x64 and arm64 native/package gates pass.
- Windows signatures satisfy release policy.
- No generated databases, raw logs, fixture secrets, or repair artifacts are staged.

## 23. Implementation Outcome

Implemented:

- Pure daemon-owned Agent security doctor with local-default and explicit online probes.
- DPAPI credential and repair-journal ACL inspection/repair through the compiled Windows native module.
- Secret-free SQLite preview/operation journal with expiry, binding, idempotency, serialization, restart interruption, and latest-receipt recovery.
- Repair service delegating to existing credential, provider, legacy-cleanup, config-reload, browser-open, and disconnect primitives.
- Authenticated no-store status, diagnosis, preview, apply, latest-operation, operation, and cancel routes.
- `relaybase repair` diagnosis, action, safe group, plan, apply, operation, JSON, interactive confirmation, and stable exit codes.
- CLI startup isolation so repair, daemon control, and token-gated Agent control commands do not hydrate project `.env` credentials.
- Dedicated TUI Security and credentials, findings, preview, destructive phrase, result, and receipt pages plus `/settings agent security`.
- Provider/management ownership split without removing existing CLI provider compatibility commands.
- Static thinking shimmer behavior for every security/repair control-plane state.
- User, API, security, troubleshooting, CLI, keymap, provider, testing, and operator documentation.

Verified on 2026-07-24:

- TypeScript typecheck, lint, formatting, documentation links, Jest, full 409-test Node suite, all 21 Go TUI test packages, TUI build, vet, snapshots, default and eight-pane TUI smokes, runtime build, Windows native build, DPAPI round trip, native ACL inspection/repair, package check, and disposable package-install smoke.
- The first full Node run exposed one timing-sensitive live-polling test failure under load; that test passed immediately in isolation and the complete 409-test suite passed on the bounded rerun.
- `npm run tui:race` remains an external host blocker: Windows application control denied the configured `gcc.exe` required by Go's race detector. No race pass is claimed.

## 24. Final Implementation Guidance

The smallest durable implementation is not a collection of TUI buttons or CLI wrappers around existing endpoints. It is:

1. A pure, typed, daemon-owned security doctor.
2. A preview-bound, idempotent repair service that reuses existing mutation primitives.
3. A small secret-free journal for recovery and uncertain results.
4. Thin TUI and CLI clients.
5. A dedicated settings page that separates provider onboarding from credential management.
6. Deterministic evidence for every recovery path and every secret boundary.

That structure gives users direct repair controls without letting the TUI, CLI, or generic repair framework become a second credential owner.
