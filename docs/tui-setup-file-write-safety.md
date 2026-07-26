# TUI Setup File-Write Safety

This document defines file-write safety for TUI setup/onboarding. Current file writes are performed by the Node/TypeScript setup engine and setup API, not by the Go TUI.

## Principle

The TUI may show setup previews, diffs, choices, and confirmations. The daemon setup API performs actual file writes and registrations after approval.

The TUI must never directly write:

- `relaybase.app.json`
- `.relaybase/launch.cjs`
- `.relaybase/setup-profile.json`
- `.relaybase/launch-profile.json`
- `.relaybase/docker-profile.json`
- `.relaybase/docker-compose.relaybase.yml`
- `.env` or `.env.*`
- MCP client config artifacts

## Setup Plan Preview

The daemon setup API produces a setup plan preview with:

- project root
- detected package manager
- detected framework
- existing manifest path when present
- selected plan id
- plan alternatives
- reasons and risks
- required inputs
- recovery steps
- write plan

Dry-run previews must not mutate files or registry state. Contract tests verify that `/__hub/api/setup/preview` does not create `relaybase.app.json` or `.relaybase/setup-profile.json`.

The Operator Agent's `apply_setup_plan` and composed `setup_and_start_project` `apply_setup` approvals include an immutable versioned SHA-256 binding to the exact preview and its write revision. Approved execution regenerates the preview immediately before apply and verifies the selected plan, full preview digest, and write revision. A missing binding fails with `SETUP_PREVIEW_BINDING_REQUIRED`; any drift fails with `SETUP_PREVIEW_STALE`. Neither path performs a mutation. The user must review and approve a newly generated preview.

Manifest registration and safe manifest/env edit approvals bind both the canonical target path and current file-content digest. Missing bindings fail with `AGENT_APPROVAL_STATE_BINDING_REQUIRED`; target/content drift fails with `AGENT_APPROVAL_STATE_STALE`. Central project-scope authorization also runs for every path-bearing setup/manifest Agent tool before read, preview, approval, or approved execution.

## File Write Plan

Each planned write includes:

- path
- action: create, update, skip, unchanged
- reason
- old file existence
- safe preview
- safe diff when applicable
- whether approval is required
- whether approval is required at the plan level
- recovery hint for failure when the engine can infer one

## Manifest Diff

Manifest diffs should show only safe fields. Env values must be redacted when keys look secret-like.

Fields that may be edited after approval:

- `id`
- `name`
- `command`
- `cwd`
- `protocol`
- `healthUrl`
- `upstreamPort`
- `env`
- `relaybase.groupId`
- `relaybase.componentRole`
- `relaybase.displayName`
- `relaybase.paneLabel`
- `relaybase.paneOrder`

## Wrapper Diff

Wrapper diffs should show generated wrapper content and why it exists. They must not include secrets.

For `.relaybase/launch.cjs`, the preview should show:

- package manager command
- script name
- framework flag mapping
- host and port placeholders
- child process handling

## Setup Profile Diff

Setup profile diffs show setup metadata, selected plan, and architecture. They should not store raw secrets or local diagnostic payloads beyond safe setup evidence.

Current code writes both `.relaybase/launch-profile.json` and `.relaybase/setup-profile.json` from the selected daemon plan. The setup profile mirrors safe launch metadata for TUI/onboarding inspection.

## Confirmation

Confirmation is required before:

- first-time writes
- updates to existing manifests or wrappers
- env file changes
- repair writes
- re-registration after changed manifest fields
- lifecycle proof that starts or stops apps

The approval prompt must show action, target files, risk, expected result, and how to cancel.

The TUI confirmation path is implemented for:

- `/add <path>`
- `/add <path> using <command>`
- `/add app <path> using <command>` as a temporary compatibility alias
- `/configure <path>`
- `/register <manifest-path>`
- `/open <path-or-app>`
- `/prove <app>`
- `/health <app> --prove`
- `/manifest edit <field> <value>`
- `/health route <app> <route>`
- `/port pinned <app> <port>`
- `/component role <app> <role>`
- `/component group <app> <groupId>`
- `/component label <app> <label>`

Read-only setup commands do not require confirmation:

- `/configure <path> --dry-run`
- `/repair <app-or-path>`
- `/manifest inspect <app-or-path>`

## Existing Manifests

When a manifest already exists, setup should:

1. inspect it
2. validate it
3. show normalized state and diagnostics
4. show proposed patch instead of overwriting silently
5. ask for approval before writing
6. re-register only after approval

Malformed metadata should produce diagnostics and safe fallback component metadata rather than a crash.

App-targeted manifest edits require the daemon state to expose `manifestPath` for that app. If the manifest path is missing, the TUI stops and asks for an explicit manifest or project path rather than reading local files to infer the manifest.

## Repair, Validate, And Re-Register

Repair flows should distinguish:

- validation only
- preview patch
- apply patch
- re-register
- start/prove

Each step should be independently inspectable and cancellable.

## Env Override Safety

Env edits are high-risk. Rules:

- never display raw secret values
- never send raw env values to remote models
- show only key names, source kind, and redacted value
- require approval before writing any env file
- prefer runtime injection when possible
- do not overwrite unrelated env content
- use guarded Relaybase blocks when patching an env file

## Failure And Recovery

If apply fails, the daemon should report:

- file path
- attempted action
- failure reason
- whether partial writes occurred
- backup or temp file location when safe
- next action

The TUI should keep the setup session open so the user can retry, skip, abort, or choose another plan.

If the daemon restarts while a lifecycle operation is queued or running, the durable operation ledger records it as failed with `LIFECYCLE_OPERATION_INTERRUPTED`, marks it retryable, and directs the operator to inspect process, port, route, and logs before retrying. Relaybase does not infer that an interrupted file/lifecycle action succeeded.

Graceful daemon shutdown stops accepting new lifecycle work, waits up to a bounded timeout for active operations, fails any still-active work closed with `LIFECYCLE_OPERATION_SHUTDOWN`, persists retry guidance, and closes the operation ledger before MCP/log services and sockets. The durable operation list can discover retryable interrupted work after restart.
