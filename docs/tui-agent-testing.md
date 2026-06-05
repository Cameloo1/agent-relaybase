# TUI Operator Agent Testing Plan

This document defines the testing strategy for Relaybase's in-TUI Operator Agent. As of RA010, the daemon Agent Gateway, OpenRouter compatibility adapter, runtime, daemon-owned tool registry, session/audit redaction storage, budget block, approval continuation, and Go TUI Agent Gateway client/rendering path have unit/integration coverage. Live OpenRouter readiness still requires the explicit live smoke command with a configured key and model.

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
- TUI starts with missing OpenRouter key and shows diagnostic
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
node --experimental-strip-types --test tests\agent-api.test.ts tests\agent-runtime.test.ts tests\agent-tools.test.ts
npm.cmd test
```

The live provider proof remains explicit and may be blocked by missing credentials:

```powershell
npm.cmd run agent:smoke:openrouter
```

If `OPENROUTER_API_KEY` or `RELAYBASE_AGENT_MODEL` is missing, the smoke command must fail as blocked. It must not fake provider or setup success.
