# App Components

Relaybase implements component-as-app metadata for grouping in the operator console. Each registered app is still one daemon-owned command/process. The metadata only groups existing apps into frontend, backend, worker, database, service, or other panes.

## Manifest Metadata

Add an optional `relaybase` block to an existing `relaybase.app.json`:

```json
{
  "id": "notes-web",
  "name": "Notes Web",
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

Supported `componentRole` values:

```text
frontend
backend
worker
database
service
other
```

`groupId` uses the same id rule as app ids. `paneOrder` must be an integer. If the metadata block is malformed, registration still succeeds and Relaybase records manifest diagnostics while falling back to implicit component metadata.

## Implicit Components

Apps without a `relaybase` block remain valid. They appear in `/__hub/api/state` as one implicit component:

- `groupId`: app id
- `role`: `other`
- `paneLabel`: `app`
- `paneOrder`: `100`
- `displayName`: app name

## Read Model

`GET /__hub/api/state` returns additive TUI fields:

```json
{
  "apps": [],
  "components": [],
  "groups": [],
  "diagnostics": [],
  "generatedAt": "2026-06-01T00:00:00.000Z"
}
```

Each component includes app id, group id, role, pane label/order, display name, route URLs/reachability, pid, port, normalized status, and last error. Each group includes `groupId`, `displayName`, sorted `components`, and `aggregateStatus`.

## Aggregate Status Rules

Implemented order:

1. `failed` if any component is failed.
2. `starting` if any component is starting and none failed.
3. `stopped` if all components are stopped.
4. `running` if every component is running and healthy.
5. `degraded` for mixed states, stopped/running splits, stopping components, or running components that are not fully ready.

## Future Migration

This is intentionally a compatibility bridge. Future native `components[]` manifests can map each native component to the same `AppComponent` read model while preserving the current component-as-app fields for existing manifests.
