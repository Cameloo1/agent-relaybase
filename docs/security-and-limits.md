# Security and Limits

Relaybase is local-first infrastructure. The default host is `127.0.0.1`, and the current implementation is not designed to be exposed directly to a public network.

## Local State

Relaybase stores registry and token data in its state directory.

Default state directory:

- Windows with `LOCALAPPDATA`: `%LOCALAPPDATA%\Relaybase`
- Other platforms: `~/.relaybase`

Override:

```powershell
$env:RELAYBASE_STATE_DIR = "C:\path\to\state"
```

The registry is stored in `registry.json`. The local mutation token is stored in `session-token`.

## Mutation Auth

HTTP mutations require the session token through one of these headers:

```text
Authorization: Bearer <token>
x-relaybase-token: <token>
```

Discovery at `/.well-known/mcp.json` tells clients which state directory and token path the running daemon is using, but it does not reveal the token.

If discovery works but mutations return `401` with `UNAUTHORIZED_MUTATION`, the client is usually reading a token from a different state directory than the running daemon.

## Secrets

Relaybase does not intentionally print the mutation token in discovery or normal CLI output.

Process hook output is redacted on a best-effort basis for environment keys containing `token`, `secret`, `password`, or `key` when the value is at least four characters. Docker generated scripts use a broader redaction key list for saved evidence.

This is not a replacement for app-level secret hygiene. Apps should avoid printing secrets to stdout, stderr, Docker logs, or health responses.

## Current Limits

Relaybase currently does not provide:

- public remote MCP exposure
- OAuth
- TLS termination
- dashboard approval flows
- Docker SDK or Docker API management
- a container management UI
- automatic Docker volume removal
- automatic migration or seed execution
- private registry login management
- wildcard child MCP exposure
- direct backend-port access buttons

Legacy SSE exists for compatibility. Streamable HTTP MCP is the preferred HTTP MCP transport.

TCP support uses an explicit Relaybase handshake:

```text
RELAYBASE-TCP <app-id>\n\n
```

## Docker Boundaries

Docker Compose support is generated-profile based. Relaybase generates app-owned files, then executes generic lifecycle hooks.

Relaybase does not guarantee Docker Desktop startup, image pulls, builds, registry auth, or Compose profile correctness. Generated hooks can try Windows Docker Desktop recovery only when the profile approves it; otherwise prestart records evidence and fails with classified errors when it can.

Docker volumes are kept by default. Generated stop hooks run `docker compose down --remove-orphans --timeout 30` without `--volumes`.
