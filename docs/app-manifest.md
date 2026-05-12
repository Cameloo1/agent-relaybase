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

## Fields

```text
schemaVersion
id
name
command
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
```

`id` must be 1 to 63 characters, lowercase letters, numbers, and dashes only. It cannot start or end with a dash.

`protocol` must be `http`, `http+ws`, or `tcp`.

`healthUrl` may be an absolute `http` or `https` URL, or a path beginning with `/`. If no `healthUrl` is present, Relaybase checks whether the backend port is open.

`env` must be an object with valid environment-variable names and string values. It is merged into the process environment when Relaybase starts the app. Relaybase also injects `PORT`, `HOST`, `RELAYBASE_APP_ID`, and `RELAYBASE_BASE_URL`.

`upstreamPort` pins the app to a fixed backend port. If present, it must be an integer between `1` and `65535`. Without it, Relaybase chooses a port from its runtime range.

Lifecycle timeout fields must be integers between `100` and `3600000` milliseconds.

## Lifecycle Hooks

Apps can add app-owned hooks:

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

Relaybase treats hooks as generic commands. It records stdout, stderr, exit codes, timeout status, start/end timestamps, cleanup status, and lifecycle attempts.

On Windows, `.ps1` commands are run through:

```text
powershell.exe -NoProfile -ExecutionPolicy Bypass -File <script>
```

If a stop hook or stop verification hook fails, Relaybase does not report the app as stopped.

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

Child ids use the same validation rule as app ids.

`expose.tools`, `expose.resources`, and `expose.prompts` are exact allowlists. Wildcard exposure is rejected.

Child `cwd` is resolved relative to the parent app `cwd`.

## Docker Manifests

When `relaybase configure` selects the Docker Compose setup plan, the manifest still uses generic hook fields. Docker-specific details go into `.relaybase/docker-profile.json`, `.relaybase/docker-compose.relaybase.yml`, and generated PowerShell scripts.

The Docker guide has the exact generated files, timings, evidence, and limits: [docker-compose-lifecycle.md](docker-compose-lifecycle.md).
