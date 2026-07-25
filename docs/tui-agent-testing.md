# TUI Operator Agent Testing

This document describes the current verification layers for Relaybase's in-TUI Operator Agent. Offline tests cover the daemon Agent Gateway, provider adapter boundary, runtime, tool registry, SQLite threads/audits, redaction, approvals, bounded continuation, spend and no-progress guards, run polling/cancellation/retry, public activity projection, and Go TUI rendering. Live compatibility of a selected OpenRouter model still requires an explicit live command with a configured key, model, and cost boundary.

## Test Layers

### Daemon Unit Tests

Cover:

- Agent Gateway request validation
- provider configuration validation
- key-reference handling
- model capability gating
- budget gating
- tool schema validation
- tool allowlist enforcement
- approval policy decisions
- redaction before prompts and audits
- session and audit storage
- SDK-facing tool schema construction
- approval-gated daemon tool execution
- bounded continuation, inactivity, hard deadline, and no-progress enforcement
- live-spend guard accounting and fail-closed provider usage checks
- current-context, capability, app-explanation, and operation-observability tools
- activity projection redaction and terminal-state finalization
- stable external-source reads, single-flight reload, atomic revisions, and last-known-good failure behavior
- credential lease disposal, Windows DPAPI round trip, ACL application, corruption, and replacement rollback
- OAuth PKCE state, expiry, replay, bounded response, validation, and unverified-provider behavior
- child process and child MCP environment credential exclusion
- Agent security doctor local/online probe separation and secret-free evidence
- repair-journal preview expiry, revision/credential/source binding, idempotency, serialization, restart interruption, and durable receipt recovery
- repair-service safe, guarded, destructive, external, manual, partial, stale, and verification outcomes

### Daemon Integration Tests

Cover:

- TUI-to-daemon agent session creation
- streaming agent events
- tool proposal lifecycle
- approval acceptance and cancellation
- operation ID propagation for lifecycle tools
- export ID propagation for log export tools
- setup plan preview and apply flows
- manifest patch previews and approved writes
- env override redaction behavior
- daemon restart and session/audit recovery
- redacted chat/session export
- budget block before remote model calls
- queued run polling, cancellation, retry, and idempotency
- daemon restart interruption and recovered-approval behavior
- authenticated no-store Agent security diagnosis/preview/apply/operation routes
- `relaybase repair` diagnosis, plan, apply, operation recovery, JSON, exit codes, daemon-unavailable behavior, and `.env` hydration isolation
- Security and credentials navigation, findings, preview, destructive phrase, result, reconnect receipt, and non-shimmering control-plane behavior

### TUI Headless Tests

Cover:

- chat bar input
- streamed assistant text rendering
- approval modal rendering
- setup wizard navigation
- diff preview rendering
- clarification prompts
- cancellation flow
- model/provider unavailable diagnostics
- Agent Gateway config and diagnostics loading
- Agent Gateway session creation and message sending
- session event handling for model deltas, answers, diagnostics, setup previews, file-write approvals, repair choices, prove results, and TUI proposed actions
- approval approve/reject commands for pending daemon approvals
- no direct lifecycle or file-write execution from TUI code
- docked and full-page transcript virtualization
- tool-trace selection, expansion, replay, and same-length content invalidation
- settings category navigation and Agent configuration validation

### Provider Tests

Unit tests may mock model responses. They must not claim live provider readiness.

Live OpenRouter tests may run only when an explicit key reference and budget gate are configured. Live tests must record provider, model slug, safe request metadata, and spend/budget status without printing keys or raw prompts containing secrets.

### Setup Tool Tests

Cover:

- project detection for npm, pnpm, yarn, bun, Next, Vite, Astro, static, Node HTTP, and Docker Compose
- setup plan ranking
- managed dynamic port plan
- framework wrapper plan
- generated `.relaybase/launch.cjs` preview
- pinned upstream port plan
- Docker Compose plan when supported
- manifest diff and wrapper diff
- existing manifest repair
- ignored PORT repair suggestions
- safe env override preview
- apply confirmation required before writes
- raw data is used for approved file writes while returned previews/results are redacted

### Safety Tests

Cover:

- destructive lifecycle action requires approval
- log export requires approval
- file write requires approval
- manifest edit requires approval
- env edit requires approval and redaction
- ambiguous target asks for clarification
- unknown target is blocked
- unknown tool is blocked
- remote model call is blocked when disabled
- raw OpenRouter key is rejected from preferences/audits
- raw secrets are not present in prompts, audits, exports, or reports
- model/default SDK execution cannot approve mutating tools by JSON input

### Smoke And Evidence Tests

Smoke should use isolated temporary state directories and disposable sample apps. It must not touch real user Relaybase state.

Required live evidence:

- TUI starts with Agent Gateway unavailable and shows diagnostic
- TUI starts with missing OpenRouter credential and shows diagnostic
- settings draft saves atomically against its opened revision
- tool execution and settings/provider operations remain static while authoritative model processing shimmers
- daemon streams assistant response events to TUI
- setup plan preview is rendered for a sample app
- manifest and wrapper diffs are rendered before approval
- cancellation leaves files unchanged
- approved setup writes files through daemon APIs
- approved lifecycle action creates daemon operation ID
- no destructive command executes before approval

## Commands

Existing commands still apply to the TUI foundation:

```powershell
npm.cmd run format:check
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run tui:test
npm.cmd run tui:smoke
```

Agent-focused Node tests run through the main Node test command:

```powershell
npm.cmd run agent:test
npm.cmd test
```

Focused Go tests are part of:

```powershell
npm.cmd run tui:test
```

The live provider and semantic checks remain explicit and may be blocked by missing credentials:

```powershell
npm.cmd run agent:smoke:openrouter
npm.cmd run agent:live:correctness
npm.cmd run agent:live:activity
```

If a usable managed/legacy credential or `RELAYBASE_AGENT_MODEL` is missing, the smoke command must fail as blocked. It must not fake provider or setup success. Offline tests use generated fixture credentials only and never read a user's real `.env` or contact OpenRouter.
