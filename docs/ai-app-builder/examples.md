# AI App Builder Examples

These examples are for users building apps or external agents that connect to Relaybase. They are not examples of Relaybase's own in-TUI Operator Agent implementation.

## Minimal App Manifest

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

Relaybase injects `PORT`, `HOST`, `RELAYBASE_APP_ID`, and `RELAYBASE_BASE_URL` when it starts a managed app without `upstreamPort`.

## Frontend And Backend As Components

Current Relaybase uses component-as-app metadata. Each component remains one registered app command.

Frontend manifest:

```json
{
  "schemaVersion": 1,
  "id": "notes-frontend",
  "name": "Notes Frontend",
  "command": "npm.cmd run dev",
  "cwd": ".",
  "protocol": "http",
  "healthUrl": "/",
  "relaybase": {
    "groupId": "notes",
    "componentRole": "frontend",
    "displayName": "Notes",
    "paneLabel": "frontend",
    "paneOrder": 10
  }
}
```

Backend manifest:

```json
{
  "schemaVersion": 1,
  "id": "notes-backend",
  "name": "Notes Backend",
  "command": "npm.cmd run dev",
  "cwd": ".",
  "protocol": "http",
  "healthUrl": "/health",
  "relaybase": {
    "groupId": "notes",
    "componentRole": "backend",
    "displayName": "Notes",
    "paneLabel": "backend",
    "paneOrder": 20
  }
}
```

## Next Development Server

For a Next app that does not honor `PORT` automatically, use Relaybase configure's framework wrapper plan when available. The wrapper passes:

```text
npm run dev -- -H <HOST> -p <PORT>
```

The generated wrapper is safer than writing shell-specific `%PORT%` or `$PORT` interpolation into a manifest command.

## External Agent Read Flow

An external agent can read daemon state:

```text
GET /__hub/api/state
GET /__hub/api/apps
GET /__hub/api/apps/<id>/logs
```

Mutation endpoints require token auth. External agents should ask for approval before mutations and should not print token values.
