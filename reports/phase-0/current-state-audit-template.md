# Current State Audit Template

Use this template for the R001 current-state audit. Fill it with verified current behavior only. Cite exact files, commands, outputs, and timestamps where useful. Do not promote intended behavior into current-state claims.

## Audit Metadata

- Date:
- Auditor:
- Repo path:
- Git branch:
- Git status summary:
- CodeGraph command and result:
- Test/check commands:

## Current Endpoints

- Evidence:
- Read-only endpoints:
- Mutation endpoints:
- Auth requirements:
- Response shapes:
- Missing or unclear endpoints:
- Risks/gaps:

## Current CLI Commands

- Evidence:
- Public commands:
- Advanced commands:
- Shared options:
- JSON behavior:
- Failure behavior:
- Risks/gaps:

## Current State Directory Behavior

- Evidence:
- Default state directory:
- `RELAYBASE_STATE_DIR` behavior:
- Token path:
- Registry/state files:
- Generated local files:
- Cleanup/recovery behavior:
- Risks/gaps:

## Current Manifest Schema

- Evidence:
- Accepted fields:
- Validation rules:
- Lifecycle hook fields:
- Docker-related fields or companion files:
- Child MCP fields:
- Risks/gaps:

## Current Lifecycle Behavior

- Evidence:
- Start flow:
- Stop flow:
- Restart flow:
- Retry/skip/abort/recovery behavior:
- Health checks:
- Stop verification:
- Conflict behavior:
- Risks/gaps:

## Current Log Behavior

- Evidence:
- Snapshot endpoint/command:
- Stream endpoint/events:
- Retention:
- Durability:
- Redaction:
- Export support:
- Risks/gaps:

## Current MCP Tool Behavior

- Evidence:
- Stdio MCP:
- HTTP MCP:
- Discovery:
- Tools:
- Resources:
- Prompts:
- Child MCP aggregation:
- Auth behavior:
- Risks/gaps:

## Current Dashboard Behavior

- Evidence:
- Dashboard route:
- App list rendering:
- App detail rendering:
- Lifecycle actions:
- Logs:
- Error states:
- Risks/gaps:

## Current Tests

- Evidence:
- Unit tests:
- Integration tests:
- Jest tests:
- Lint/typecheck:
- Smoke/package checks:
- Known skipped or missing coverage:
- Risks/gaps:

## Current Packaging

- Evidence:
- Package scripts:
- `files` allowlist:
- Binary entry points:
- Skill/plugin assets:
- Package smoke result:
- Risks/gaps:

## Risks/Gaps

| Area | Risk/gap | Evidence | Owner | Proposed next gate |
| ---- | -------- | -------- | ----- | ------------------ |
