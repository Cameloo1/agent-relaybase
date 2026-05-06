# Relaybase

> Relaybase is experimental and has not been fully tested yet.

Relaybase is a localhost-only routing and lifecycle hub for many AI-built apps. Agents can target apps through a stable custom header, while humans can open readable hostnames through one hub port.

## Why It Exists

AI-assisted development makes it easy to create many small local apps, previews, services, and test servers. Relaybase gives those apps stable names, routes them through one hub port, and keeps process/port state visible instead of leaving every agent or developer to guess which app owns which port.

## Quick Start

```powershell
npm.cmd run serve
```

Open the dashboard:

```text
http://localhost:7777/__hub
```

## Routing

- Dashboard: `http://localhost:7777/__hub`
- Human app route: `http://<app-id>.localhost:7777`
- Agent app route: `X-Relaybase-App: <app-id>`
- TCP tunnel preface: `RELAYBASE-TCP <app-id>\n\n`

## App Manifest

Create `relaybase.app.json` beside an app:

```json
{
  "id": "notes",
  "name": "Notes",
  "command": "npm.cmd run dev",
  "cwd": ".",
  "protocol": "http",
  "healthUrl": "/",
  "env": {
    "NODE_ENV": "development"
  }
}
```

Then register and run it:

```powershell
npm.cmd run relaybase -- register .\relaybase.app.json
npm.cmd run serve
npm.cmd run relaybase -- start notes
```

## CLI

```powershell
npm.cmd run relaybase -- serve
npm.cmd run relaybase -- register .\relaybase.app.json
npm.cmd run relaybase -- start notes
npm.cmd run relaybase -- stop notes
npm.cmd run relaybase -- restart notes
npm.cmd run relaybase -- status
npm.cmd run relaybase -- logs notes
```

## Security Defaults

Relaybase binds to `127.0.0.1` by default. Mutating control API calls require the local session token stored in the Relaybase state directory. LAN exposure, TLS termination, and transparent TCP/SNI routing are intentionally outside V1.

## Current Limits

- V1 TCP support uses an explicit Relaybase handshake and is intended for agents, not transparent public TCP routing.
- Relaybase is local-first and does not include TLS termination, authentication for remote users, or LAN exposure.
- The implementation has automated coverage for routing, WebSocket upgrades, lifecycle management, port conflicts, TCP tunneling, and dashboard smoke loading, but it still needs broader real-world testing across more dev servers.

## Development

```powershell
npm.cmd test
```
