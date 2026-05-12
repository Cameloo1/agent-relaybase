# MCP

Relaybase exposes its lifecycle control plane through MCP. The same daemon can serve stdio MCP, Streamable HTTP MCP, and legacy SSE MCP compatibility.

## Endpoints

```text
relaybase mcp                 stdio MCP server
http://localhost:7777/mcp     Streamable HTTP MCP
http://localhost:7777/sse     legacy SSE MCP
```

Discovery is available at:

```text
http://localhost:7777/.well-known/mcp.json
```

The discovery document includes endpoint URLs, mutation auth requirements, accepted auth headers, the active state directory, and the session token path. It does not return the token.

## Auth

HTTP mutation tools require the local Relaybase session token through either:

```text
Authorization: Bearer <token>
x-relaybase-token: <token>
```

The token is stored as `session-token` in the Relaybase state directory.

Read-only MCP calls do not require mutation auth. Stdio MCP runs in the local process context and does not receive HTTP headers.

## Tools

Relaybase exposes these lifecycle tools:

```text
configure_project
list_apps
app_status
health_check
verify_app
prove_app
register_app
start_app
stop_app
restart_app
tail_logs
app_url
```

Token-gated mutation tools:

- `configure_project` when `apply: true`
- `prove_app` when `lifecycle: true`
- `register_app`
- `start_app`
- `stop_app`
- `restart_app`

`configure_project` uses the same setup engine as `relaybase configure`. With `apply: false`, it returns a dry-run plan. With `apply: true`, it may write project files, register the app, and optionally start verification. Docker Compose callers can pass `profile: "docker-compose"` with `service`, `targetPort`, `healthPath`, timeout fields, `dependencyPortPolicy`, and `dockerStartDesktop`.

`prove_app` returns a proof snapshot. With `lifecycle: false` or omitted, it is read-only. With `lifecycle: true`, it starts the app, checks routed health and logs, stops the app, and verifies cleanup.

`tail_logs` returns a snapshot. Its `follow` argument is accepted for compatibility, but the tool response marks follow as not accepted. Use the HTTP log stream for live logs.

## Resources

Relaybase resources include:

```text
relaybase://apps
relaybase://dashboard
relaybase://app/<id>/logs
relaybase://app/<id>/manifest
relaybase://app/<id>/mcp/<child-resource-uri>
```

Child resources are exposed only when listed in the app manifest allowlist.

## Prompts

Relaybase provides:

```text
debug_app
```

`debug_app` returns current state, health, recent logs, manifest summary, and human/agent URLs for one app.

Child prompts are surfaced as:

```text
<app-id>.<prompt-name>
```

## Child Aggregation

Child tools are surfaced as:

```text
<app-id>.<tool-name>
```

Child resources are surfaced as:

```text
relaybase://app/<id>/mcp/<resource-uri>
```

Child MCP servers start with `start_app`, stop with `stop_app`, and are included in app state. Relaybase stops accepting new child calls before stop, waits for in-flight calls to drain, closes child transports, and reports structured drain results.

Child server closures are logged. When a child closes unexpectedly, Relaybase schedules restart with exponential backoff from 1000 ms up to 30000 ms.

## Client Config

Local development:

```json
{
  "mcpServers": {
    "relaybase": {
      "command": "npm.cmd",
      "args": ["run", "relaybase", "--", "mcp"]
    }
  }
}
```

Package use:

```json
{
  "mcpServers": {
    "relaybase": {
      "command": "npx",
      "args": ["@cameloo/relaybase", "mcp"]
    }
  }
}
```

`relaybase configure --mcp-install` can also write `.relaybase/mcp.json` with the package-based config shape.
