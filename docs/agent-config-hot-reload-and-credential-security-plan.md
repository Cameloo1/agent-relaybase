# Agent Configuration Hot Reload and Credential Security Plan

Status: implemented; release proof pending

Scope: Relaybase Operator Agent configuration, OpenRouter connection, credential protection, settings UX, runtime revision binding, diagnostics, recovery, and acceptance testing

Implementation state: the minimal Windows implementation and deterministic acceptance suite are complete. It must not be presented as released until the dual-architecture Windows CI and SignPath release gates complete on the release candidate.

## 1. Executive Decision

Relaybase should refresh Agent configuration at the beginning of each new user-submitted Agent run, not before every internal model request or tool step. Each accepted run receives one immutable configuration revision. All model calls, tool offers, approval previews, execution bounds, budget decisions, and redaction behavior for that run are bound to that revision unless a stricter live safety control intervenes.

The normal Windows user path should not depend on `.env` for the OpenRouter credential. Relaybase should connect to OpenRouter with OAuth PKCE where practical, receive the resulting dedicated OpenRouter key directly in the daemon, and protect it with user-scoped Windows DPAPI. Regular Agent use must remain silent: no unlock or Windows verification prompt is shown by default.

The long-term source split is:

- Non-secret Agent configuration may hot-reload from an explicitly selected external file or be managed in Relaybase settings.
- The managed OpenRouter credential is never written to `.env`, ordinary config, preferences, API responses, diagnostics, logs, exports, audit payloads, or child-process environments.
- Existing environment-backed credentials remain a compatibility and migration path, not the intended secure steady state.
- An optional high-security mode may require Windows verification before credential use. It is opt-in and must not change the silent default.
- A future remote credential broker with backend-held keys and short-lived client access tokens is a stronger tier, but it is outside the minimal local implementation.

## 2. Why This Design

The current gateway already captures an `AgentConfig` before queueing a run and passes that snapshot into the runtime. That is the correct execution shape. The current weaknesses are:

- Agent configuration is initially derived from startup `process.env`.
- Provider construction can read `process.env` again.
- Model/key presence is conflated with Agent/remote enablement.
- An external `.env` change is detected as restart-required instead of being validated and applied for the next run.
- The current settings page saves Agent fields one at a time rather than applying a complete validated draft.
- Environment-backed secrets can remain in process-wide state and can be inherited by child processes.
- The current public configuration model has no explicit immutable revision contract.

Reading `.env` on every internal model call would avoid one stale-startup problem but introduce worse consistency and security problems:

- One run could change model, credential, tools, or limits halfway through.
- Concurrent requests could observe different values.
- Editors can briefly expose partially written files.
- Audit records could not identify which configuration governed a run.
- The secret would be reread and copied more often.
- Per-request working directories could resolve different files.

The correct boundary is therefore:

```text
user submits
  -> resolve or refresh the selected configuration source
  -> validate one complete candidate
  -> atomically activate one revision
  -> bind that revision to the run
  -> use it for every internal call in that run
```

## 3. Goals

### 3.1 Product goals

- Apply valid non-secret Agent configuration changes to the next run without a daemon restart.
- Make `/settings -> Agent` the normal control surface.
- Make OpenRouter connection simple and silent after initial setup.
- Show truthful configuration source, readiness, credential status, revision, and recovery state.
- Preserve the existing safe daemon restart as recovery rather than routine configuration application.
- Preserve long-running, multi-tool Agent completion behavior.
- Preserve exact thinking-shimmer semantics.

### 3.2 Security goals

- Reduce the number of locations and processes that can observe the OpenRouter key.
- Protect the stored key with current-user Windows DPAPI.
- Keep decrypted managed credentials daemon-only.
- Never pass the key in a command line, environment variable, child-process stdin, generic IPC payload, TUI model, API response, log, diagnostic, export, or audit event.
- Use OAuth PKCE S256 and a daemon-owned loopback callback when OpenRouter connection supports it.
- Encourage a dedicated Relaybase key with a spending limit and expiration.
- Support replacement, remote-revocation guidance, and local disconnection.
- Clear native plaintext buffers promptly and minimize JavaScript plaintext lifetime.
- State the limits of DPAPI honestly.

### 3.3 Operational goals

- Use explicit state, revisions, bounded retries, atomic writes, conflict detection, audit events, and recovery paths.
- Keep invalid candidates from replacing the last-known-good revision.
- Prevent stale revisions from weakening later safety changes.
- Preserve idempotency and approval bindings.
- Produce deterministic, secret-free acceptance evidence.

## 4. Non-Goals

- DPAPI is not a defense against malware already running as the same Windows user.
- The minimal implementation does not provide a remote Relaybase credential broker.
- The minimal implementation does not automatically obtain or retain an OpenRouter management key.
- Relaybase must not claim successful remote key revocation unless OpenRouter confirms it.
- Relaybase must not silently edit or delete user `.env` files during migration.
- Non-Windows managed credential storage must not fall back to plaintext. External configuration may remain available until platform-native stores are implemented.
- Agent configuration reload must not become an excuse to reload daemon process, routing, lifecycle, or executable configuration dynamically.

## 5. Security Model and Explicit Limitations

### 5.1 Threats reduced

User-scoped DPAPI and daemon-only credential use reduce exposure from:

- Accidental Git commits of `.env`.
- Log, diagnostic, report, or support-bundle leakage.
- Child processes inheriting `OPENROUTER_API_KEY`.
- Other local OS users reading Relaybase state files.
- Offline copying of an encrypted credential blob to another machine or user profile.
- Ordinary TUI/API inspection.
- Broad process environment inspection after migration to managed mode.

### 5.2 Threats not defeated

The product and documentation must explicitly state:

> Windows DPAPI does not defeat malware, debuggers, injected code, or other processes already executing with the same user authority. Same-user malware may be able to invoke DPAPI, inspect Relaybase memory, intercept requests, or control the daemon. DPAPI primarily protects stored credentials from offline theft, cross-user access, and accidental plaintext exposure.

High-security Windows verification reduces unattended use but still does not make a compromised same-user session trustworthy after verification.

### 5.3 Trust boundaries

- The Node daemon is the only process allowed to decrypt and use the managed OpenRouter credential.
- The Go TUI is a control and status client. It never receives the key.
- Child MCP servers and managed app processes never receive the key.
- The browser participates only in OpenRouter authorization. The daemon exchanges the returned authorization code for the key.
- The encrypted DPAPI blob is persisted; plaintext is not.
- OpenRouter remains a trusted remote processor for prompts and model requests selected by the user.

## 6. State Model

Do not collapse source health, readiness, credential connection, and runtime activity into one status.

### 6.1 Configuration source health

- `healthy`
- `changed`
- `reloading`
- `invalid`
- `unavailable`
- `legacy_mixed`

### 6.2 Agent readiness

- `disabled`
- `needs_configuration`
- `ready`

Readiness is:

```text
agent enabled
AND remote model enabled
AND model configured
AND credential configured
AND selected source healthy
```

Model and credential presence must remain visible independently of `agent enabled` and `remote model enabled`.

### 6.3 Credential connection state

- `disconnected`
- `connecting`
- `connected_unverified`
- `connected`
- `verification_required`
- `verification_unavailable`
- `replace_pending`
- `revocation_pending`
- `revocation_unconfirmed`
- `invalid`
- `expired`

### 6.4 Runtime activity

- `idle`
- `queued`
- `thinking`
- `using_tool`
- `waiting_for_approval`
- `completed`
- `failed`
- `cancelled`

Only authoritative model-processing activity may drive the Agent thinking shimmer.

## 7. Configuration Source Contract

### 7.1 Managed mode

Managed mode is the intended general-user path.

- Provider/model and ordinary Agent settings are persisted in Relaybase state.
- The OpenRouter key is stored only as a DPAPI-protected credential blob.
- The public configuration contains only a credential reference and safe metadata.
- `/settings -> Agent` provides connection and configuration controls.
- New validated revisions apply to new runs without restart.
- Managed mode ignores legacy `OPENROUTER_API_KEY` values after migration completes.

### 7.2 External non-secret configuration mode

External mode remains useful for developers.

- One canonical configuration path is selected explicitly.
- The path is resolved once and stored as source metadata.
- Relaybase checks file metadata/fingerprint at each new run.
- The file is reread only when changed.
- Changes are parsed and applied atomically.
- The reload path does not mutate global `process.env`.
- Provider model, optional attribution headers, and non-secret Agent settings may be external.
- The managed key must not be exported to or written into this file.

### 7.3 Shell environment mode

- Shell values are an immutable startup snapshot.
- The UI labels them as `Shell environment`.
- Parent-shell changes require restart.
- Relaybase does not pretend shell configuration supports hot reload.
- Shell credential mode is legacy after managed DPAPI support ships.

### 7.4 Legacy mixed mode

Existing installations may combine:

- Environment-derived Agent flags.
- Environment-derived key.
- Persisted model.
- Persisted tool, budget, or execution settings.

Relaybase must reproduce the current effective behavior initially and label it `legacy_mixed`. The user then chooses:

- Migrate credential to protected managed storage.
- Select external non-secret configuration.
- Continue legacy behavior with an explicit security warning.

No credential is moved or removed without explicit user action.

## 8. Agent Configuration Manager

Create a daemon-owned `AgentConfigManager` outside the TUI and outside `AgentGatewayService`.

Suggested files:

- `src/agent/configManager.ts`
- `src/agent/configSource.ts`
- `src/agent/credentialStore.ts`
- `src/agent/windowsCredentialStore.ts`

Suggested contract:

```ts
interface AgentConfigManager {
  getSafeState(): AgentConfigState;
  resolveForNewRun(): Promise<ResolvedAgentRunConfig>;
  reload(options: ReloadOptions): Promise<AgentConfigReloadResult>;
  updateManagedConfig(update: AgentConfigUpdate, expectedRevisionId: string): Promise<AgentConfigReloadResult>;
}
```

Internal run resolution:

```ts
interface ResolvedAgentRunConfig {
  revisionId: string;
  generation: number;
  config: AgentConfig;
  credentialLease: CredentialLease;
  redactionSecrets: string[];
  loadedAt: string;
}
```

`ResolvedAgentRunConfig` is internal and must not be JSON serializable.

### 8.1 Revision contract

Each successful activation receives:

- A random opaque `revisionId`.
- A monotonic in-process `generation`.
- `loadedAt`.
- Safe source metadata.
- Safe changed-field names.

Do not expose a raw hash of the `.env` file or encrypted credential. Hashes derived from secret-bearing files can become secret-verification or correlation oracles.

### 8.2 Single-flight refresh

Concurrent submissions share one refresh:

- The first request checks/reloads.
- Later requests await the same promise.
- All receive the same activated revision.
- No request observes a partial candidate.
- A bounded lock timeout returns an inspectable retryable diagnostic.

### 8.3 Stable file reads

For external configuration:

1. Resolve the already selected canonical path.
2. Read file metadata.
3. Read the complete file.
4. Read metadata again.
5. Retry a small bounded number of times when size or timestamp changes during the read.
6. Return `AGENT_CONFIG_SOURCE_UNSTABLE` if no stable read is available.

Filesystem watchers may mark a source dirty, but they are hints rather than the authority. The run-boundary metadata check remains authoritative.

### 8.4 Atomic candidate activation

Build a candidate in isolation:

- Parse.
- Normalize.
- Resolve source ownership.
- Validate the model slug.
- Resolve the credential reference.
- Validate execution bounds.
- Validate tool policy.
- Validate budgets.
- Build safe diagnostics.
- Activate only after all required checks pass.

On failure:

- Preserve the last-known-good revision for existing runs and observability.
- Do not use it silently for a new run.
- Block the new run with a safe diagnostic.
- Preserve a user-editable settings draft.
- Allow an explicit retry after repair.

## 9. Windows DPAPI Credential Store

### 9.1 Default protection mode

Use current-user DPAPI:

- Call `CryptProtectData` without `CRYPTPROTECT_LOCAL_MACHINE`.
- Pass a null prompt structure.
- Use `CRYPTPROTECT_UI_FORBIDDEN` for the default silent path.
- Call `CryptUnprotectData` only inside the daemon.
- Free DPAPI output buffers with `LocalFree`.
- Clear native plaintext buffers with `SecureZeroMemory` before release.

Do not use DPAPI prompt-structure UI for high-security mode. Microsoft marks that prompt flow deprecated. Windows verification must be a separate gate.

### 9.2 Native implementation boundary

Prefer a small repository-owned Node-API native module over:

- Shelling out to PowerShell or .NET.
- Passing plaintext through child-process stdin.
- Passing plaintext through environment variables or command arguments.
- Trusting an unaudited prebuilt third-party binary.

The native API should remain narrow:

```text
protectCurrentUser(plaintextBuffer) -> protectedBuffer
unprotectCurrentUser(protectedBuffer) -> plaintextBuffer
checkUserVerificationAvailability() -> safe status
requestUserVerification(reason) -> success/cancel/unavailable
```

The addon must:

- Never log inputs or outputs.
- Return stable error codes and safe messages.
- Zero native plaintext buffers on success and error paths.
- Free every Windows allocation.
- Reject oversized input.
- Support the packaged Windows architectures Relaybase claims.
- Be included in package-install and signature verification.

### 9.3 Protected blob format

Persist an application envelope around the DPAPI ciphertext:

```json
{
  "schemaVersion": 1,
  "provider": "openrouter",
  "credentialId": "opaque-random-id",
  "protection": "windows-dpapi-current-user",
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601",
  "ciphertext": "base64"
}
```

The decrypted payload should contain:

- A fixed magic/version.
- Provider identifier.
- Credential ID.
- Credential bytes.
- A strict length.
- An internal integrity/corruption marker.

Validate every field after decryption. DPAPI supplies integrity protection, but Relaybase should still reject malformed or unexpected plaintext rather than treating any decrypted bytes as a key.

### 9.4 Storage and ACLs

- Store the protected blob under the daemon state directory in a dedicated Agent credential directory.
- Restrict the directory and file to the current user and required system authority.
- Write a same-directory temporary file, flush it, apply ACLs, and atomically replace the active blob.
- Never create a plaintext backup.
- Exclude the blob from ordinary exports, diagnostics bundles, and project artifacts.
- Backup/restore documentation must state that user-scoped DPAPI blobs are normally bound to the user and machine/profile context.

### 9.5 Memory handling

Credential use should be lease-based:

1. Resolve the credential for a run.
2. Decrypt into the smallest practical native buffer.
3. Construct the provider transport.
4. Zero temporary native buffers.
5. Retain only the minimum provider-held representation for the run.
6. Drop references when the run finishes.

JavaScript strings cannot be reliably zeroized. Relaybase must not claim guaranteed JavaScript memory erasure. The implementation should instead:

- Avoid global secret caches.
- Avoid copying the key into config objects.
- Avoid interpolation and serialization.
- Create provider clients per run rather than daemon lifetime.
- Drop all known references promptly.
- Prevent request/response debug logging of authorization headers.
- Disable production inspector/debug surfaces that would expose memory.

### 9.6 No child-process inheritance

Managed credentials must never be written to `process.env`. Child app, MCP, hook, setup, repair, and tool processes must be constructed from an allowlisted environment that excludes Agent credentials even if a legacy parent process still contains them.

Add an explicit regression guard for:

- `OPENROUTER_API_KEY`
- Configured custom credential variable names.
- Authorization headers.
- DPAPI plaintext buffers.

## 10. OpenRouter OAuth PKCE Connection

OpenRouter documents OAuth PKCE and arbitrary localhost callback ports. Use S256 only.

### 10.1 Connect flow

1. User selects `/settings -> Agent -> Provider -> Connect OpenRouter`.
2. Daemon creates:
   - A cryptographically random PKCE verifier.
   - S256 challenge.
   - Independent random state.
   - Opaque connection attempt ID.
   - Short expiration time.
3. Daemon binds a one-use callback listener to `127.0.0.1` on an OS-assigned port.
4. Daemon opens the OpenRouter authorization URL. If browser opening is unavailable, the TUI may show/copy the non-secret authorization URL.
5. Callback validates:
   - Loopback listener identity.
   - Expected path.
   - Exact state.
   - Attempt expiration.
   - Single use.
   - Presence of one authorization code.
6. Daemon closes the listener immediately after success, terminal failure, or timeout.
7. Daemon exchanges the code and verifier directly with OpenRouter over HTTPS.
8. The returned key is never returned through Relaybase’s API.
9. Daemon validates the key with a minimal safe OpenRouter metadata request when available.
10. Daemon protects it with DPAPI and atomically stores it.
11. Daemon activates a new config revision.
12. TUI receives only safe status and metadata.

### 10.2 PKCE storage rules

- Verifier and state are memory-only.
- Do not persist callback codes.
- Do not log authorization URLs with sensitive query state unless redacted.
- Never allow `plain` PKCE.
- Never allow an arbitrary remote callback URL.
- Bind to loopback, not all interfaces.
- Reject redirects or exchanges to non-OpenRouter origins.
- Do not forward authorization headers across redirects.

### 10.3 Dedicated key guidance

The connection UX should encourage:

- A key dedicated to Relaybase.
- A recognizable provider-side label.
- A conservative spending limit.
- A daily or monthly reset where appropriate.
- An expiration date.
- Periodic replacement.

OpenRouter supports key limits and expiration in its key-management surfaces. Relaybase must not ask users for a broad management key merely to automate those settings. If the PKCE flow cannot request these restrictions directly, the UI should:

- Explain how to set them in OpenRouter.
- Read and display safe current-key metadata when the connected key permits it.
- Warn when no limit or expiration is visible.
- Avoid claiming the limit was applied unless OpenRouter confirms it.

### 10.4 Connection failure states

- Browser unavailable: show/copy the safe URL.
- Callback port unavailable: retry bounded random loopback ports.
- User cancels: return `connection_cancelled`.
- Attempt expires: close listener and clear verifier/state.
- State mismatch: fail closed and emit a redacted security audit event.
- Exchange fails: retain no credential and offer retry.
- Validation network failure after exchange: store only as `connected_unverified`, do not enable remote use until validation succeeds.
- DPAPI protect/write failure: discard candidate, preserve the old active credential, and offer retry.

## 11. Provider Controls

Add `/settings -> Agent -> Provider` controls.

### 11.1 Status

Show only safe information:

- Connected/disconnected.
- Provider.
- Credential source.
- Local protection mode.
- Safe key label if returned by OpenRouter.
- Spending limit and remaining amount if safely available.
- Expiration.
- Last validation.
- Active revision.
- High-security mode.

Never show:

- Raw key.
- Full authorization header.
- DPAPI ciphertext.
- Secret-bearing source fingerprints.

### 11.2 Replace

Replacement must be zero-downtime and reversible until activation:

1. Start a fresh PKCE connection.
2. Validate the new key.
3. Protect and write a new blob.
4. Atomically switch the active credential reference.
5. Activate a new config revision for new runs.
6. Keep existing runs on the old in-memory revision.
7. Drop old local plaintext references.
8. Explain that the old remote key remains valid until revoked at OpenRouter.

Do not delete the old local protected blob until the new blob is durable and readable.

### 11.3 Revoke

Remote revocation is an external destructive action and requires explicit confirmation.

- If OpenRouter exposes a supported revocation operation authorized by the connected flow, preview and execute it, verify the provider response, then remove the local blob.
- If Relaybase lacks the required provider authority, open the exact OpenRouter key-management surface and mark the state `revocation_unconfirmed`.
- Never report `revoked` based only on opening a browser or deleting the local blob.
- Allow the user to confirm remote revocation after completing it externally, followed by a metadata check when possible.

Relaybase must not collect a management key solely to make this button automatic.

### 11.4 Disconnect

Disconnect is local-only:

- Confirm that the remote key will remain active.
- Remove the local protected credential atomically.
- Clear active leases.
- Disable new remote Agent runs.
- Preserve non-secret Agent settings.
- Emit a redacted audit event.
- Offer an OpenRouter link for optional remote revocation.

### 11.5 Optional Require Windows Verification

Default: off.

When enabled:

- Require Windows user verification before unprotecting a credential for a new Agent run.
- Verify once per run or once per explicitly configured short unlock window, never per internal model call.
- Use Windows `UserConsentVerifier`/desktop interop or another Microsoft-supported Windows Hello user-verification API.
- Do not use deprecated DPAPI prompt structures.
- Check availability before enabling.
- If unavailable, disabled by policy, not configured, or device busy, show a precise status and do not silently downgrade.
- Cancellation blocks the new run without damaging configuration.
- Existing in-flight runs keep their already granted lease unless the user explicitly disables the Agent.

The native implementation must be proven in the actual headless/console daemon launch modes Relaybase supports. If a prompt requires an owning window, the native layer must create or bind an appropriate secure owner rather than delegating the credential to another process.

## 12. Remote Credential Broker: Future Stronger Tier

A future service may keep the long-lived OpenRouter key on a Relaybase-controlled backend and issue the local client short-lived, scoped access tokens.

Potential benefits:

- Long-lived key is absent from the local machine.
- Same-user malware has a shorter theft window.
- Central revocation, rotation, spending policy, and device/session controls.

New risks and requirements:

- Backend becomes a high-value credential target.
- Relaybase must operate authentication, encryption, tenancy isolation, incident response, and availability.
- Users must trust Relaybase with prompts and/or provider access.
- Offline and local-first behavior changes.

This tier is not part of the minimal DPAPI implementation. Do not add dormant backend scaffolding or imply that local DPAPI has remote-broker strength.

## 13. Gateway and Run Integration

### 13.1 Submission ordering

Update `AgentGatewayService.addMessage` in this order:

1. Validate content and normalize idempotency key.
2. Return an existing idempotent message/run before new side effects.
3. Confirm the session has no active run.
4. Resolve/refresh configuration through `AgentConfigManager`.
5. Acquire a credential lease, including optional Windows verification.
6. Redact the user message with runtime token, current credential, and any candidate credential transiently observed during migration.
7. Create message and run with safe config revision metadata.
8. If configuration or credential resolution failed, persist a truthful blocked run.
9. Reserve budget against the resolved revision.
10. Queue execution with the immutable internal snapshot.

Persist only:

```ts
interface AgentRun {
  configRevisionId?: string;
  configGeneration?: number;
  provider: string;
  modelSlug?: string;
}
```

### 13.2 Provider construction

Remove production Agent fallback reads from `process.env`.

Construct the OpenRouter provider from the internal run snapshot:

```ts
createOpenRouterAgentProvider({
  config: snapshot.config,
  credential: snapshot.credentialLease
});
```

Standalone smoke tools may retain explicit test-only injection, but production Agent execution must not use mutable process-global secrets.

### 13.3 In-flight changes

Model, key, and ordinary policy changes apply to new runs.

Immediate safety controls behave differently:

- Turning the Agent off aborts queued/running model execution.
- Turning remote-model access off prevents further remote calls.
- Approved local mutations already executing are not killed unsafely; the daemon enters a draining state and reports them.
- Tool/approval-policy tightening is checked again at approval resolution.
- The most restrictive combination of pinned and current live safety policy wins.

### 13.4 Waiting approvals

Persist the run revision ID and retain:

- Original arguments.
- Original preview.
- Original project and manifest bindings.
- Original model provenance.
- Original policy decision.

Before applying an approval:

- Recheck live disable/remote/tool safety controls.
- Do not silently rebuild the approval under a new revision.
- Do not reacquire the OpenRouter credential for an approved local tool unless the workflow genuinely resumes model reasoning.

### 13.5 Idempotency and retries

- Repeating the same idempotency key returns the original run and revision.
- A user-requested retry creates a new run linked to the original and resolves the newest valid config revision.
- A config reload must not mutate an already persisted idempotent result.

## 14. API Contract

All routes remain daemon-token authenticated.

### 14.1 Safe config state

`GET /__hub/api/agent/config` returns:

- Effective safe config.
- Source mode and safe label.
- Source health.
- Agent readiness.
- Credential connection/protection status.
- Revision ID and generation.
- Last loaded/checked times.
- Last safe reload error.
- Whether an active run uses an older revision.

### 14.2 Atomic config update

`PUT /__hub/api/agent/config` accepts:

```json
{
  "expectedRevisionId": "opaque-id",
  "update": {}
}
```

Return `409 AGENT_CONFIG_REVISION_CONFLICT` when stale.

Continue rejecting raw credential fields through the generic config endpoint.

### 14.3 External reload

`POST /__hub/api/agent/config/reload` returns:

- `unchanged`
- `applied`
- `blocked`
- Safe old/new revision IDs.
- Safe changed-field names.
- Safe diagnostics.

### 14.4 Provider operations

Suggested routes:

- `GET /__hub/api/agent/provider/openrouter/status`
- `POST /__hub/api/agent/provider/openrouter/connect`
- `POST /__hub/api/agent/provider/openrouter/replace`
- `POST /__hub/api/agent/provider/openrouter/revoke/preview`
- `POST /__hub/api/agent/provider/openrouter/revoke`
- `POST /__hub/api/agent/provider/openrouter/disconnect`
- `PUT /__hub/api/agent/provider/openrouter/security-mode`

The OAuth callback is handled by a separate one-use loopback listener. It must not return the key through a Relaybase JSON response.

### 14.5 Credential endpoint hardening

- Authenticate before reading mutation bodies where practical.
- Enforce small body limits.
- Apply no-store response headers.
- Never echo request bodies.
- Disable generic request-body logging.
- Reject cross-origin browser calls except the explicit OAuth callback flow.
- Use idempotency/attempt IDs for connect/replace.
- Require confirmation bindings for revoke/disconnect.
- Redact provider error details before persistence.

## 15. Diagnostics and Audit

### 15.1 Diagnostics

Add:

- `AGENT_CONFIG_SOURCE_UNAVAILABLE`
- `AGENT_CONFIG_SOURCE_UNSTABLE`
- `AGENT_CONFIG_RELOAD_INVALID`
- `AGENT_CONFIG_REVISION_CONFLICT`
- `AGENT_CREDENTIAL_MISSING`
- `AGENT_CREDENTIAL_DPAPI_PROTECT_FAILED`
- `AGENT_CREDENTIAL_DPAPI_UNPROTECT_FAILED`
- `AGENT_CREDENTIAL_CORRUPT`
- `AGENT_CREDENTIAL_EXPIRED`
- `AGENT_PROVIDER_CONNECTION_CANCELLED`
- `AGENT_PROVIDER_CONNECTION_EXPIRED`
- `AGENT_PROVIDER_CONNECTION_STATE_MISMATCH`
- `AGENT_PROVIDER_KEY_UNVERIFIED`
- `AGENT_PROVIDER_REVOCATION_UNCONFIRMED`
- `AGENT_WINDOWS_VERIFICATION_REQUIRED`
- `AGENT_WINDOWS_VERIFICATION_UNAVAILABLE`
- `AGENT_WINDOWS_VERIFICATION_CANCELLED`
- `AGENT_CONFIG_LEGACY_MIXED_SOURCE`

Presence diagnostics must be independent:

- Remote disabled does not manufacture model/key missing.
- Key connected does not imply remote enabled.
- Source changed does not imply source missing.

### 15.2 Redacted audit events

Add safe events:

- `agent.config_reload_applied`
- `agent.config_reload_failed`
- `agent.credential_connected`
- `agent.credential_replaced`
- `agent.credential_disconnect_requested`
- `agent.credential_disconnected`
- `agent.credential_revocation_requested`
- `agent.credential_revoked`
- `agent.credential_revocation_unconfirmed`
- `agent.credential_unprotect_failed`
- `agent.windows_verification_succeeded`
- `agent.windows_verification_failed`

Audit payloads may contain:

- Opaque credential ID.
- Opaque config revision ID.
- Provider name.
- Safe action/result code.
- Protection mode.
- Changed field names.
- Timing.

They must not contain:

- Key.
- Key prefix or suffix.
- Authorization header.
- OAuth code/verifier/state.
- DPAPI ciphertext.
- Secret-bearing file fingerprint.
- Raw provider response.

Do not emit an audit record for every unchanged per-run source check.

## 16. Settings UX

The existing `/settings` category modal and dedicated Agent page remain the correct structure.

### 16.1 Agent page sections

- Status
- Provider
- Configuration source
- Credential security
- Safety and permissions
- Execution
- Budgets
- Recovery

### 16.2 Provider rows and actions

- Provider: OpenRouter
- Connection: connected/disconnected/etc.
- Credential storage: Windows DPAPI/current user
- Key safety: dedicated-key recommendation
- Spending limit: safe provider metadata
- Expiration: safe provider metadata
- Last validation
- Connect
- Replace
- Revoke
- Disconnect
- Require Windows verification

### 16.3 Configuration rows

- Source mode.
- Safe source label.
- Source health.
- Active revision.
- Last applied.
- Reload now.
- Active-run revision notice.
- Last safe error.

### 16.4 Atomic editing

Agent settings use a draft:

1. Edit locally.
2. Mark dirty.
3. Save and validate.
4. Send one expected-revision update.
5. Apply only after full daemon validation.
6. Preserve draft on failure.
7. Offer Reset/Discard.

Appearance and other low-risk preferences may continue saving immediately.

### 16.5 Sensitive UX rules

- TUI never accepts or renders a raw OpenRouter key.
- OAuth connection is the default entry path.
- Provider URLs shown to the user contain no key.
- Disconnect clearly says it is local-only.
- Revoke clearly distinguishes confirmed remote revocation from an external provider action still required.
- High-security mode explains its prompt behavior before enabling.
- Default mode explicitly says regular use remains silent.
- DPAPI limitation text is available from the security details page without alarming routine users.

### 16.6 Thinking shimmer

Configuration and credential operations use settings-local progress text/spinner, not Agent thinking shimmer.

Shimmer starts only on authoritative `model.processing_started` and stops on:

- `model.processing_completed`
- run completion
- run failure
- cancellation
- approval wait
- disconnect recovery where no persisted model-processing activity exists

Queued, connecting, OAuth waiting, validating, DPAPI protect/unprotect, saving settings, reloading config, blocked, idle, stopped, and disconnected states must not shimmer.

## 17. CLI

Retain:

```text
relaybase daemon restart
relaybase tui --restart-daemon
```

Add advanced controls:

```text
relaybase agent config status --json
relaybase agent config reload --json
relaybase agent provider status --json
relaybase agent provider connect
relaybase agent provider disconnect
```

CLI status never prints secrets. Connect initiates the daemon-owned browser/PKCE flow. Disconnect and revoke require explicit confirmation or a purpose-built non-interactive confirmation flag.

Parse relevant launch options before selecting an external configuration path. Store the canonical source once; never recompute it from request `cwd`.

## 18. Migration

### 18.1 Detect

The daemon may detect that a legacy credential is available from startup environment or the selected external source, but it returns only:

- Present/missing.
- Source kind.
- Migration available.

It never returns the value.

### 18.2 Migrate to DPAPI

1. User selects `Move credential to protected storage`.
2. Daemon resolves the legacy credential internally.
3. Daemon validates it with OpenRouter when possible.
4. Daemon protects and writes the DPAPI blob.
5. Daemon rereads/decrypts the new blob to prove durability.
6. Daemon switches managed mode to the new credential reference.
7. Daemon activates a new config revision.
8. TUI reports success without key material.
9. User is guided to remove the old external value.

Migration is not complete while the old secret remains in `.env` or parent-shell state.

### 18.3 External secret removal

- Never silently modify `.env`.
- Offer an explicit, previewed removal flow only when Relaybase can target exactly one key assignment without disturbing other content.
- Do not create a plaintext backup.
- Use a same-directory restricted temporary file and atomic replacement.
- If exact removal cannot be guaranteed, provide precise manual guidance.
- Shell variables cannot be removed from the parent process; explain how to clear them and restart the shell/daemon.
- Managed mode ignores the old external credential after activation so it cannot override the protected key.

### 18.4 Migration rollback

- If DPAPI storage or validation fails, keep legacy mode active.
- If the user removes the old external credential before DPAPI durability is proven, show recovery instructions and remain disconnected rather than inventing success.
- Preserve non-secret settings through every migration outcome.

## 19. Failure and Recovery Matrix

| Failure                          | New runs                                            | Existing run                                      | User-visible recovery                      |
| -------------------------------- | --------------------------------------------------- | ------------------------------------------------- | ------------------------------------------ |
| External config unchanged        | Use active revision                                 | Unchanged                                         | None                                       |
| Valid external change            | Use new revision                                    | Keep pinned revision                              | Show applied revision                      |
| Invalid external change          | Block                                               | Continue pinned revision                          | Repair and reload                          |
| Config source deleted            | Block                                               | Continue pinned revision                          | Restore/select source                      |
| DPAPI blob missing               | Block                                               | Existing lease may finish                         | Reconnect or migrate                       |
| DPAPI blob corrupt               | Block                                               | Existing lease may finish                         | Replace/reconnect                          |
| Wrong Windows user/profile       | Block                                               | None after restart                                | Sign in as owning user or reconnect        |
| Windows verification cancelled   | Block requested run                                 | Existing run unchanged                            | Retry                                      |
| Windows verification unavailable | Block only in high-security mode                    | Existing run unchanged                            | Disable mode or configure Windows Hello    |
| OAuth user cancellation          | No config change                                    | Unchanged                                         | Retry connect                              |
| OAuth state mismatch             | Fail closed                                         | Unchanged                                         | Start fresh connection                     |
| Provider exchange failure        | No new credential                                   | Unchanged                                         | Retry                                      |
| Key validation offline           | Connected-unverified; remote blocked                | Unchanged                                         | Retry validation                           |
| Key expired/revoked              | New calls blocked                                   | Fail safely at provider boundary                  | Replace/reconnect                          |
| Replace write failure            | Keep old credential                                 | Keep old revision                                 | Retry replacement                          |
| Remote revoke unavailable        | Local state unchanged unless user disconnects       | Unchanged                                         | Open provider management; mark unconfirmed |
| Disconnect                       | Block new remote runs                               | Abort queued/running model work per safety policy | Reconnect                                  |
| Daemon crash during write        | Old or new complete blob, never partial active blob | Run recovered as interrupted                      | Restart and inspect                        |

## 20. Implementation Phases

### Phase 0: Protect current WIP

- Record staged, unstaged, and untracked boundaries.
- Do not reset, checkout, or bulk-format existing changes.
- Treat current Agent/settings/restart work as the integration baseline.
- Exclude `target/`, logs, generated databases, smoke payloads, and local reports.
- Run focused baseline tests and record pre-existing failures.

### Phase 1: Correct current configuration semantics

- Decouple model/key presence from remote authorization.
- Correct safe config reporting.
- Correct `needs_config` diagnostics.
- Add warning-cascade regression tests.
- Preserve strict execution gates.

### Phase 2: Pure configuration manager

- Extract pure external parsing from `envFile.ts`.
- Add source modes.
- Add stable reads, revision generation, single-flight reload, atomic validation, and conflict detection.
- Keep the manager independent of provider network calls in unit tests.

### Phase 3: DPAPI native foundation

- Build the narrow repository-owned Node-API module.
- Implement user-scoped silent protect/unprotect.
- Implement safe blob persistence and ACL enforcement.
- Add native allocation, zeroing, corruption, wrong-user, and packaging tests.
- Do not expose Managed mode yet.

### Phase 4: Daemon credential store

- Add credential leases.
- Add protected blob repository.
- Add safe credential status.
- Add provider construction without `process.env`.
- Add child-environment exclusion.
- Add secret scanning and audit redaction.

### Phase 5: Run-boundary integration

- Resolve config and credential before queueing each new run.
- Persist safe revision metadata.
- Preserve idempotency/retry behavior.
- Apply live safety overrides.
- Bind approvals and budgets.
- Prove multi-tool runs remain stable.

### Phase 6: OAuth PKCE

- Add one-use loopback callback server.
- Add S256 verifier/state handling.
- Add daemon-side code exchange and validation.
- Protect the key before activation.
- Add cancellation, timeout, mismatch, offline, and retry recovery.

### Phase 7: API and audit

- Add safe config/reload/provider routes.
- Add expected-revision mutation.
- Add confirmation-bound revoke/disconnect.
- Add safe diagnostics and redacted audit events.
- Add no-store and body/logging hardening.

### Phase 8: TUI

- Add nested Provider page.
- Add status/connect/replace/revoke/disconnect.
- Add draft config editing and Save/validate.
- Add source/revision/recovery state.
- Add high-security setting, initially hidden until its implementation gate passes.
- Preserve keyboard, mouse, focus, modal, scrolling, and small-terminal behavior.
- Preserve shimmer truth.

### Phase 9: Windows verification

- Implement availability detection.
- Implement user verification with a Microsoft-supported desktop API.
- Prove actual daemon launch modes and prompt ownership.
- Add cancellation, policy-disabled, busy, no-device, and timeout handling.
- Enable the UI switch only when fully supported.

### Phase 10: Migration and CLI

- Add legacy detection and protected migration.
- Add explicit source selection.
- Add advanced CLI status/reload/provider commands.
- Add exact, safe old-source removal guidance.

### Phase 11: Documentation and release

- Update current behavior docs only after implementation is verified.
- Document the DPAPI limitation.
- Document dedicated-key limits/expiration.
- Document backup/profile implications.
- Run full deterministic, race, package, and live-gated acceptance.

## 21. Test Plan

### 21.1 Configuration manager unit tests

- Unchanged source avoids full reread.
- Valid model edit creates one revision.
- Valid key-reference change creates one revision.
- Invalid edit does not replace active revision.
- Deleted/renamed source blocks new runs.
- Partial write never activates.
- Concurrent reloads collapse into one operation.
- Explicit path remains stable across request CWDs.
- Shell mode remains startup-only.
- Empty and absent values differ.
- Model/key presence is independent from enablement.
- Safe outputs contain no raw values.

### 21.2 DPAPI/native tests

- Current user can round-trip a fixture secret.
- Protected blob does not contain fixture plaintext.
- Machine-wide protection is never used.
- Default calls are non-interactive.
- Corrupted blob fails closed.
- Truncated/oversized blobs fail safely.
- Native output allocations are freed.
- Plaintext buffers are zeroed on success/error paths.
- Wrong user/profile fixture fails with a safe code where test infrastructure permits.
- Atomic replacement survives injected failures.
- ACLs match the intended user boundary.
- Packaged x64/arm64 binaries load on claimed platforms.

Use generated fixture secrets only. Never test against the user’s real credential.

### 21.3 OAuth PKCE tests

- S256 challenge is correct.
- Plain PKCE is rejected.
- Verifier/state meet entropy and length requirements.
- Callback binds only to loopback.
- State mismatch fails closed.
- Expired/reused attempts fail.
- Callback listener always closes.
- Exchange key is never included in API response.
- Provider error bodies are redacted.
- Validation failure yields connected-unverified.
- Protect/write failure preserves old credential.
- Browser-unavailable fallback exposes only a safe URL.

### 21.4 Gateway tests

- Run A stays on revision A during replacement.
- Run B uses revision B without restart.
- Multiple model/tool turns use one revision.
- Failed reload creates a truthful blocked run.
- Repair allows next run.
- Duplicate idempotency key returns original revision.
- Retry uses newest revision.
- Agent disable aborts queued/running model work.
- Remote disable blocks further calls.
- Tightened tool policy is honored at approval.
- Budget reservations survive reload correctly.
- Credential never enters run/session/audit persistence.
- Multi-tool tasks complete without refresh stopping them.

### 21.5 API tests

- Every route requires daemon authentication.
- Generic config rejects raw key fields.
- Provider connect responses contain no key.
- Reload returns unchanged/applied/blocked accurately.
- Revision conflicts return 409.
- Revoke/disconnect require confirmation binding.
- Remote revocation is never falsely reported.
- No-cache/no-store headers are present.
- Request bodies and provider authorization headers never reach logs.
- API response, diagnostics, audit, session, and export scans find no fixture secret.

### 21.6 TUI tests

- `/settings` opens categories.
- Agent opens its dedicated page.
- Provider opens its dedicated page.
- Status/source/revision/readiness/credential state remain distinct.
- Connect/replace/revoke/disconnect flows render truthfully.
- External and managed fields have correct editability.
- Draft save, failure, retry, conflict, and discard work.
- High-security availability states render correctly.
- Keyboard, mouse, focus, scroll, and small terminals work.
- Daemon restart remains available.
- Credential/config work never starts shimmer.
- Thinking always shimmers.
- Idle, queued, tool-only, approval wait, failed, cancelled, stopped, and disconnected states do not shimmer unless an authoritative model-processing state is active.

### 21.7 Migration tests

- Legacy environment key is detected without value exposure.
- Migration validates, protects, rereads, and then activates.
- Failed migration leaves legacy behavior unchanged.
- Managed mode ignores old environment key after activation.
- Exact `.env` removal preview changes only the selected assignment.
- Removal failure preserves the original file.
- No plaintext backup/temp artifact survives.
- Shell cleanup guidance is accurate.

### 21.8 Deterministic end-to-end test

Use temporary state, temporary configuration, fixture credentials, and a fake provider:

1. Start daemon.
2. Connect a fixture key through a fake PKCE exchange.
3. Prove DPAPI-protected persistence and safe status.
4. Submit run A and hold it open.
5. Apply config/model revision B.
6. Confirm run A remains on A.
7. Submit run B and confirm B without restart.
8. Inject invalid external config and confirm run C blocks.
9. Repair and confirm run D succeeds.
10. Replace credential and confirm only new runs use it.
11. Disconnect and confirm new remote runs block.
12. Scan all outputs/artifacts for fixture secrets.
13. Confirm configuration/OAuth/DPAPI activity never drives thinking shimmer.
14. Stop daemon and prove process/port cleanup.

### 21.9 Optional live OpenRouter test

A real-provider test is:

- Explicitly gated.
- Budget-limited.
- Uses a dedicated disposable key.
- Never required for deterministic correctness.
- Proves PKCE only if a test account and provider flow are intentionally authorized.
- Deletes/revokes the disposable key when supported and verifies the outcome.

## 22. Verification Commands

Focused:

```powershell
npm.cmd run typecheck
npm.cmd run agent:test
npm.cmd run tui:test
npm.cmd run tui:race
```

Full:

```powershell
npm.cmd run lint
npm.cmd run format:check
npm.cmd run typecheck
npm.cmd test
npm.cmd run test:jest
npm.cmd run tui:test
npm.cmd run tui:vet
npm.cmd run tui:race
npm.cmd run package:check
git diff --check
```

Add native/package checks for:

- Node-API binary loading.
- Claimed Windows architectures.
- Signature/trust policy where required.
- Fresh package install.
- Secret artifact scan.

Do not broad-format until overlapping WIP is reconciled.

## 23. Planned File Map

Likely new implementation files:

- `src/agent/configManager.ts`
- `src/agent/configSource.ts`
- `src/agent/credentialStore.ts`
- `src/agent/windowsCredentialStore.ts`
- `src/agent/openrouterConnection.ts`
- `tests/agent-config-manager.test.ts`
- `tests/agent-credential-store.test.ts`
- `tests/agent-openrouter-connection.test.ts`
- Repository-owned Windows Node-API native module and build files.

Likely modified files:

- `src/envFile.ts`
- `src/cli.ts`
- `src/server.ts`
- `src/agent/types.ts`
- `src/agent/gateway.ts`
- `src/agent/runtime.ts`
- `src/agent/openrouterProvider.ts`
- `src/agent/api.ts`
- `src/agent/auditStore.ts`
- `src/agent/sessionStore.ts`
- `tui/internal/relaybaseclient/types.go`
- `tui/internal/relaybaseclient/client.go`
- `tui/internal/tui/commands/commands.go`
- `tui/internal/tui/model/settings.go`
- `tui/internal/tui/model/model.go`
- `tui/internal/tui/views/views.go`
- Focused Node and Go tests.

Docs should be updated only after verification:

- `README.md`
- `docs/cli.md`
- `docs/security-and-limits.md`
- `docs/tui-agent-architecture.md`
- `docs/tui-agent-openrouter.md`
- `docs/tui-agent-safety.md`
- `docs/tui-agent-testing.md`
- `docs/tui-api-contract.md`
- `docs/tui-keymap.md`
- `docs/tui-preferences.md`
- `.env.example`

## 24. Acceptance Criteria

The minimal Windows implementation is complete only when:

1. A new user can connect OpenRouter through daemon-owned S256 PKCE.
2. The returned key is stored with current-user DPAPI and never returned to the TUI/API.
3. Regular Agent runs produce no unlock/verification prompt.
4. Managed mode does not use `.env` or child-process environment for the key.
5. A valid non-secret configuration change applies to the next run without restart.
6. Active runs keep their original immutable revision.
7. Invalid changes block new runs and recover without restart.
8. Model/key presence diagnostics are truthful and independent.
9. Connect, status, replace, revoke, and disconnect have truthful, recoverable UX.
10. Remote revocation is reported only after provider confirmation.
11. High-security mode is either fully working with Windows verification or visibly unavailable; it never silently downgrades.
12. Raw fixture credentials are absent from API responses, TUI state, logs, audits, diagnostics, sessions, exports, `.env`, child environments, crash/recovery artifacts under test control, and package contents.
13. Native plaintext buffers are cleared promptly, and JavaScript memory limitations are documented honestly.
14. DPAPI’s same-user-malware limitation is documented.
15. A dedicated key with spending limit and expiration is encouraged and safe metadata is shown when available.
16. Configuration/credential operations never produce thinking shimmer.
17. Thinking always produces shimmer and every non-thinking terminal/waiting state clears it.
18. Multi-call, multi-tool, approval-bearing Agent tasks complete without configuration refresh stopping them.
19. Daemon restart remains safe and available but is unnecessary for normal Agent configuration.
20. Focused, full, race, package, native, migration, recovery, and secret-scan gates pass.
21. Exact changed files, commands, results, exclusions, and remaining platform limitations are reported.

## 25. Release Gates

### Gate A: State correctness

- Presence/authorization split verified.
- Revisions and reload semantics verified.
- No runtime regression.

### Gate B: Local credential protection

- DPAPI/native review complete.
- Silent default proven.
- Storage/ACL/zeroing tests pass.
- Secret scans pass.

### Gate C: Connection and recovery

- PKCE/callback threat tests pass.
- Replace/disconnect/revoke truthfulness pass.
- Migration and rollback pass.

### Gate D: UX

- Settings flows pass keyboard/mouse/small-terminal tests.
- High-security availability is truthful.
- Shimmer contract passes.

### Gate E: Release proof

- Full deterministic suite passes.
- Windows package/install proof passes.
- Optional live provider evidence is clearly separated from deterministic proof.
- No generated or secret-bearing artifacts are staged.

## 26. Official Design References

- Microsoft `CryptProtectData`: https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata
- Microsoft `CryptUnprotectData`: https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptunprotectdata
- Microsoft desktop Windows user verification interop: https://learn.microsoft.com/en-us/windows/win32/api/userconsentverifierinterop/nf-userconsentverifierinterop-iuserconsentverifierinterop-requestverificationforwindowasync
- OpenRouter OAuth PKCE: https://openrouter.ai/docs/guides/overview/auth/oauth
- OpenRouter current-key metadata: https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key
- OpenRouter key creation limits/expiration: https://openrouter.ai/docs/api/api-reference/api-keys/create-keys
- OpenRouter key management: https://openrouter.ai/docs/guides/overview/auth/management-api-keys
- OAuth PKCE specification, RFC 7636: https://datatracker.ietf.org/doc/html/rfc7636

## 27. Implementation and Verification Record

Implementation completed on 2026-07-24:

- Phases 1 through 8 and Phase 10 are implemented in the daemon, CLI, API, and TUI.
- Phase 9 is fail-closed: Windows verification is reported as unavailable and cannot be enabled until secure interactive prompt ownership is implemented and proven. Silent current-user DPAPI remains the default.
- Phase 11 source, documentation, x64 native, package-install, and deterministic runtime checks are complete.
- The release workflow builds x64 and ARM64 native modules on Windows, submits both native modules and both Windows TUI executables for Authenticode signing, verifies certificate presence, and requires installed-artifact trust before publication.

Verified local gates:

- Formatting, lint, TypeScript type checking, documentation links, the full Node suite, Jest, Agent tests, TUI tests, TUI vet, and the Go race detector.
- Actual x64 Node-API build, current-user DPAPI round trip, protected storage ACL, corruption and size failure behavior, and disposable npm package installation.
- Bounded isolated-daemon smoke covering explicit external config selection, CLI status, CLI reload, revision replacement, restart preview binding, process teardown, and port closure.
- Provider, PKCE, migration, rollback, disconnect, revoke, config-conflict, secret-redaction, and authoritative shimmer behavior through deterministic fixtures.

Release-only gates:

- This workstation does not have the Visual Studio ARM64 v143 build component, so the local all-architecture and strict package checks correctly stop at the missing ARM64 native module. The Windows CI job is the required ARM64 build/load gate.
- Development binaries are intentionally unsigned. Authenticode certificate and Windows trust validation run only against the exact release candidate after SignPath returns the signed artifacts.
- A real OpenRouter request remains optional and was not run. It requires explicit user authorization, a disposable limited key, and a spend ceiling; it is not evidence for deterministic correctness.

No real user credential or repository `.env` was read, modified, migrated, or used during this implementation or verification.
