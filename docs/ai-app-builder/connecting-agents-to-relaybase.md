# Connecting External Agents To Relaybase

This document is for users building external AI agents that connect to Relaybase. It is not the implementation plan for Relaybase's own in-TUI Operator Agent.

## Connection Surfaces

External agents may use:

- Relaybase MCP tools when configured
- daemon HTTP APIs documented in `docs/tui-api-contract.md`
- CLI commands documented in `docs/cli.md`

Mutation surfaces require the local Relaybase token. Never print or store token contents in agent logs.

## Recommended Agent Flow

1. Discover Relaybase.
2. Diagnose token presence without printing token contents.
3. List apps and groups.
4. Read app state and diagnostics.
5. Start, stop, or restart only through daemon lifecycle APIs or MCP tools.
6. Read logs through redacted log APIs.
7. Export logs through the daemon export API when needed.
8. Stop or clean up only through Relaybase-managed lifecycle paths.

## Safety

External agents should preserve the same boundaries as the TUI:

- no direct process management
- no raw secret logging
- no unapproved lifecycle mutations
- no arbitrary shell execution hidden behind Relaybase tool names
- no assumptions that registry state equals live runtime state

## App Setup

For app setup, prefer:

```powershell
relaybase configure
relaybase open
relaybase health --prove
```

Typed setup/onboarding HTTP wrappers are implemented for daemon-owned setup automation:

- `POST /__hub/api/setup/detect`
- `POST /__hub/api/setup/plans`
- `POST /__hub/api/setup/preview`
- `POST /__hub/api/setup/apply`
- `POST /__hub/api/setup/register-manifest`
- `POST /__hub/api/setup/inspect-manifest`
- `POST /__hub/api/setup/validate-manifest`
- `POST /__hub/api/setup/patch-manifest/preview`
- `POST /__hub/api/setup/patch-manifest/apply`
- `POST /__hub/api/setup/open`
- `POST /__hub/api/setup/prove`
- `POST /__hub/api/setup/repair`

External agents should use read-only detect/plan/preview/inspect/validate/repair calls first, show the user the daemon-produced plan or diff, and only then call token-gated apply/register/open/prove/patch routes after explicit approval.
