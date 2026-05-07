# Relaybase MCP Manifest Convention

Relaybase app manifests remain backward compatible. MCP support is additive through optional `schemaVersion` and `mcp` fields.

## Shape

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
    "children": []
  }
}
```

`schemaVersion` may be omitted for legacy manifests. If provided, it must be `1`.

## Child Transports

Stdio child:

```json
{
  "id": "tools",
  "transport": "stdio",
  "command": "node",
  "args": ["./mcp-server.js"],
  "cwd": ".",
  "expose": {
    "tools": ["search"],
    "resources": ["docs://index"],
    "prompts": ["debug"]
  }
}
```

Streamable HTTP child:

```json
{
  "id": "remote-tools",
  "transport": "streamable-http",
  "url": "http://127.0.0.1:4100/mcp",
  "legacySseUrl": "http://127.0.0.1:4100/sse",
  "expose": {
    "tools": ["query"],
    "resources": [],
    "prompts": []
  }
}
```

Legacy SSE child:

```json
{
  "id": "legacy-tools",
  "transport": "sse",
  "legacySseUrl": "http://127.0.0.1:4100/sse",
  "expose": {
    "tools": ["query"],
    "resources": [],
    "prompts": []
  }
}
```

Child `cwd` is resolved relative to the parent app `cwd`.

## Exposure Rules

Exposure uses exact allowlists only.

```json
{
  "expose": {
    "tools": ["search", "summarize"],
    "resources": ["docs://index"],
    "prompts": ["debug"]
  }
}
```

Relaybase does not support wildcard exposure in this milestone. If a child tool, resource, or prompt is not listed, Relaybase does not surface it.

## Namespacing

Child tools:

```text
<app-id>.<tool-name>
```

Child resources:

```text
relaybase://app/<id>/mcp/<resource-uri>
```

Child prompts:

```text
<app-id>.<prompt-name>
```

Relaybase generates these names in its MCP schema. Apps declare original child names only.

## Lifecycle Semantics

`start_app(id)` starts the app process and declared child MCP servers.

`stop_app(id)` stops accepting new child MCP tool calls, waits up to a fixed drain timeout for in-flight calls, then stops child MCP servers and the app process. The result includes per-child drain data.

Child crashes are logged and scheduled for exponential backoff restart. Child list-change notifications propagate upward to connected Relaybase MCP clients.
