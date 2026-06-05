# AI App Builder Docs

These docs are for users building AI apps or external agents that connect to Relaybase.

They are not the implementation docs for Relaybase's own in-TUI Operator Agent. Operator Agent architecture lives in `docs/tui-agent-architecture.md` and related `docs/tui-agent-*` files.

## Audience

Use these docs if you are:

- building an app that Relaybase will run and route
- adding child MCP tools to an app manifest
- connecting an external agent to Relaybase daemon APIs or MCP tools
- using Relaybase logs, routes, health checks, or app state as app-builder infrastructure

Do not use these docs as the plan for Relaybase's internal Operator Agent implementation.

## Current Relaybase Primitives

Relevant existing docs:

- `docs/app-manifest.md`
- `docs/app-components.md`
- `docs/tui-api-contract.md`
- `docs/mcp.md`
- `docs/cli.md`
- `docs/logs.md`

Relaybase exposes local app lifecycle, routing, health, logs, exports, state, and MCP surfaces. Apps remain responsible for their own code, commands, dependencies, health endpoints, and secrets.

## Boundary

External AI apps and agents should call Relaybase through documented daemon APIs, CLI commands, or MCP tools. They should not assume access to Relaybase internal process manager state or TUI local preferences.

Relaybase's own Operator Agent is different: it runs inside the Relaybase daemon Agent Gateway, may use OpenRouter only when explicitly enabled, and routes all mutations through daemon approval gates. External apps and agents are users of Relaybase APIs/MCP; they are not allowed to bypass token auth, approval policy, lifecycle APIs, log redaction, or setup file-write safety.

## External Agent Security Checklist

- Use daemon APIs or MCP tools; do not inspect Relaybase internal stores directly.
- Require user approval before lifecycle mutations, log exports, setup writes, or manifest patches.
- Never print Relaybase tokens, OpenRouter keys, app env values, cookies, bearer tokens, or private registry tokens.
- Treat log exports as sensitive even when redacted.
- Use component-as-app metadata for frontend/backend grouping; native manifest `components[]` is not the current public app model.
