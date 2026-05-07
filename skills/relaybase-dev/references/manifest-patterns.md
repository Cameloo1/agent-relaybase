# Manifest Patterns

Preserve an existing `relaybase.app.json`. Only create one when the app must run and no manifest exists.

## Minimal HTTP App

```json
{
  "schemaVersion": 1,
  "id": "notes",
  "name": "Notes",
  "command": "npm.cmd run dev",
  "cwd": ".",
  "protocol": "http",
  "healthUrl": "/"
}
```

## HTTP With WebSockets

```json
{
  "schemaVersion": 1,
  "id": "chat",
  "name": "Chat",
  "command": "npm.cmd run dev",
  "cwd": ".",
  "protocol": "http+ws",
  "healthUrl": "/"
}
```

## Existing External Upstream

Use `upstreamPort` only when a process is already managed outside Relaybase.

```json
{
  "schemaVersion": 1,
  "id": "api",
  "name": "API",
  "command": "external",
  "cwd": ".",
  "protocol": "http",
  "healthUrl": "/health",
  "upstreamPort": 3000
}
```

## Child MCP Over Stdio

Prefer this for agent-facing tools and data that do not need a browser-visible HTTP server.

```json
{
  "schemaVersion": 1,
  "id": "search",
  "name": "Search",
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
          "tools": ["query"],
          "resources": ["docs://index"],
          "prompts": ["debug"]
        }
      }
    ]
  }
}
```

## Rules

- App ids must be lowercase letters, numbers, and dashes.
- Keep `cwd` relative to the manifest when possible.
- Do not use wildcard child MCP exposure.
- Do not invent fake health. If no health route exists, use `/` and verify the route.
- Do not overwrite unrelated manifest fields.
