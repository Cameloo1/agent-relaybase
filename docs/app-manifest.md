# App Manifest

`relaybase.app.json` is the app lifecycle contract. It tells Relaybase how to start the app, where the app root is, how to check health, how to route traffic, and whether the app exposes child MCP servers.

## Minimal Example

```json
{
  "id": "notes",
  "name": "Notes",
  "command": "npm.cmd run dev",
  "cwd": ".",
  "protocol": "http",
  "healthUrl": "/"
}
```

`schemaVersion` is optional for legacy manifests. If present, the only accepted value is `1`.

## Structured launch

Prefer `launch` when the program accepts explicit arguments. It avoids shell parsing and generated wrappers:

```json
{
  "schemaVersion": 1,
  "id": "computer-stats",
  "name": "Computer Stats",
  "cwd": ".",
  "protocol": "http",
  "healthUrl": "/api/ping",
  "launch": {
    "executable": ".\\Start-Dashboard.ps1",
    "args": ["-HostName", "{relaybase.host}", "-Port", "{relaybase.port}"],
    "environment": {},
    "portBinding": "arguments"
  }
}
```

Structured launches always execute as an executable plus argument array with shell execution disabled. Supported tokens are `{relaybase.host}`, `{relaybase.port}`, `{relaybase.appId}`, `{relaybase.baseUrl}`, and `{relaybase.projectRoot}`. Unknown tokens and shell interpolation such as `$PORT`, `%PORT%`, `$()`, or backticks are rejected.

`portBinding` is `environment`, `arguments`, `fixed`, or `external`. Fixed and external launches require `upstreamPort`. `command` remains supported for existing manifests, but a manifest cannot provide both `command` and `launch`.

## Fields

```text
schemaVersion
id
name
command
launch
cwd
protocol
healthUrl
env
upstreamPort
preStartCommand
stopCommand
verifyStoppedCommand
preStartTimeoutMs
startTimeoutMs
stopTimeoutMs
healthTimeoutMs
mcp
relaybase
```

`id` must be 1 to 63 characters, lowercase letters, numbers, and dashes only. It cannot start or end with a dash.

`protocol` must be `http`, `http+ws`, or `tcp`.

`healthUrl` may be an absolute `http` or `https` URL, or a path beginning with `/`. If no `healthUrl` is present, Relaybase checks whether the backend port is open.

`env` must be an object with valid environment-variable names and string values. Relaybase merges it into the app process environment and also injects `PORT`, `HOST`, `RELAYBASE_APP_ID`, and `RELAYBASE_BASE_URL`.

`upstreamPort` pins the app to a fixed backend port. Without it, Relaybase chooses a runtime port.

## Registration verification implications

Quick registration verification compiles this exact manifest, starts it once, checks the declared health target, stops it, and verifies closure of a Relaybase-owned backend port. Confirmation text names this lifecycle work before it happens. `--no-verify` performs no lifecycle mutation and leaves the app registered but unverified.

Port ownership affects proof behavior:

- `environment` and `arguments`: Relaybase assigns and owns a temporary backend port; successful proof requires that port to close after stop.
- `fixed`: Relaybase preflights `upstreamPort` for conflicts, starts the configured process, and requires cleanup of the owned backend.
- `external`: Relaybase does not spawn or own the external process. Verification checks reachability but does not claim closure of a port it does not own.

When the declared HTTP health route fails while the managed backend is open, Relaybase may issue at most three read-only, one-second, localhost-only `GET` probes from adapter-supplied candidates. It never follows a candidate to a non-local host and never rewrites `healthUrl` automatically. A successful alternate route becomes an approval-bound repair preview.

Lifecycle timeout fields are milliseconds and must be between `100` and `3600000`.

Registration quick proof uses bounded policy defaults rather than silently adopting an unbounded manifest timeout. Ordinary-process verification is capped at 30 seconds. Slow adapters must present an explicit extended-proof choice.

`relaybase` is an optional metadata block for TUI grouping. It never changes lifecycle ownership: each app remains one command/process. See [app-components.md](app-components.md) for the implemented fields, roles, fallback behavior, and aggregate status rules.

## Lifecycle Hooks

Apps can declare app-owned hooks:

```json
{
  "preStartCommand": ".\\scripts\\relaybase-prestart.ps1",
  "command": ".\\scripts\\relaybase-start.ps1",
  "stopCommand": ".\\scripts\\relaybase-stop.ps1",
  "verifyStoppedCommand": ".\\scripts\\relaybase-verify-stopped.ps1",
  "preStartTimeoutMs": 120000,
  "startTimeoutMs": 600000,
  "stopTimeoutMs": 60000,
  "healthTimeoutMs": 30000
}
```

Relaybase treats hooks as generic local commands. It records stdout, stderr, exit codes, timeout status, start and end timestamps, cleanup status, and lifecycle attempts.

On Windows, Relaybase invokes PowerShell hook scripts automatically for the app process. Users do not need to change system execution-policy settings.

If a stop hook or stop-verification hook fails, Relaybase does not report the app as stopped.

## Child MCP Servers

Apps can expose selected child MCP capabilities through the parent Relaybase MCP server:

```json
{
  "schemaVersion": 1,
  "id": "example",
  "name": "Example App",
  "command": "npm.cmd run dev",
  "cwd": ".",
  "protocol": "http",
  "healthUrl": "/",
  "mcp": {
    "enabled": true,
    "children": [
      {
        "id": "tools",
        "transport": "stdio",
        "command": "node",
        "args": ["./mcp-server.js"],
        "cwd": ".",
        "expose": {
          "tools": ["search", "summarize"],
          "resources": ["docs://index"],
          "prompts": ["debug"]
        }
      }
    ]
  }
}
```

Supported child transports:

- `stdio`: requires `command`.
- `streamable-http`: requires `url`.
- `sse`: requires `url` or `legacySseUrl`.

Child ids follow the same validation rule as app ids. Child `cwd` is resolved relative to the parent app `cwd`.

`expose.tools`, `expose.resources`, and `expose.prompts` are exact allowlists. Wildcard exposure is rejected.

## Docker Manifests

Docker Compose setup still uses the same generic manifest hook fields. Docker-specific details live in `.relaybase/docker-profile.json`, `.relaybase/docker-compose.relaybase.yml`, and generated hook scripts.

See [docker-compose-lifecycle.md](docker-compose-lifecycle.md) for the Compose contract and current limits.
