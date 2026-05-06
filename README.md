# PortHub

> PortHub is experimental and has not been fully tested yet.

PortHub is a localhost-only routing and lifecycle hub for many AI-built apps. Agents can target apps through a stable custom header, while humans can open readable hostnames through one hub port.

## Why It Exists

AI-assisted development makes it easy to create many small local apps, previews, services, and test servers. PortHub gives those apps stable names, routes them through one hub port, and keeps process/port state visible instead of leaving every agent or developer to guess which app owns which port.

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
- Agent app route: `X-Port-Hub-App: <app-id>`
- TCP tunnel preface: `PORTHUB-TCP <app-id>\n\n`

## App Manifest

Create `porthub.app.json` beside an app:

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
npm.cmd run porthub -- register .\porthub.app.json
npm.cmd run serve
npm.cmd run porthub -- start notes
```

## CLI

```powershell
npm.cmd run porthub -- serve
npm.cmd run porthub -- register .\porthub.app.json
npm.cmd run porthub -- start notes
npm.cmd run porthub -- stop notes
npm.cmd run porthub -- restart notes
npm.cmd run porthub -- status
npm.cmd run porthub -- logs notes
```

## Security Defaults

PortHub binds to `127.0.0.1` by default. Mutating control API calls require the local session token stored in the PortHub state directory. LAN exposure, TLS termination, and transparent TCP/SNI routing are intentionally outside V1.

## Current Limits

- V1 TCP support uses an explicit PortHub handshake and is intended for agents, not transparent public TCP routing.
- PortHub is local-first and does not include TLS termination, authentication for remote users, or LAN exposure.
- The implementation has automated coverage for routing, WebSocket upgrades, lifecycle management, port conflicts, TCP tunneling, and dashboard smoke loading, but it still needs broader real-world testing across more dev servers.

## Development

```powershell
npm.cmd test
```
