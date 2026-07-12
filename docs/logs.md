# Logs

Relaybase R006 stores app logs in a durable segment-backed JSONL store under the daemon state directory.

## Storage

Default paths:

```text
<state-dir>/logs/index.json
<state-dir>/logs/segments/<appId>/<yyyy-mm-dd>/<segment-id>.jsonl
```

R006 intentionally uses JSONL segments plus a small `index.json` instead of SQLite. That keeps the implementation dependency-free and package-friendly on Windows while still supporting restart recovery, sequence paging, rotation, retention cleanup, and corruption diagnostics. The tradeoff is that cross-app/group queries scan segment files instead of using a database index. This is acceptable for the current TUI scrollback phase; a future SQLite index can sit behind the same `LogStore` abstraction.

## Event Shape

Stored log events include:

```text
sequence
timestamp
at
appId
groupId
componentRole
stream
source
level
message
line
redacted
segment
```

`line` is retained as a compatibility alias for existing live log consumers. `message` is the durable read-model field the TUI should prefer.

## Querying

The snapshot endpoint supports paging:

```text
GET /__hub/api/apps/<id>/logs?limit=500&before=<sequence>
GET /__hub/api/apps/<id>/logs?limit=500&after=<sequence>
```

Responses include legacy `logs` and `events` fields plus page metadata:

```json
{
  "id": "app-id",
  "logs": [],
  "events": [],
  "page": {
    "limit": 500,
    "oldestSequence": 1,
    "newestSequence": 42,
    "nextBefore": 1,
    "hasMore": true
  },
  "diagnostics": [],
  "streamUrl": "http://127.0.0.1:7777/__hub/api/apps/app-id/logs/stream"
}
```

Live log SSE behavior remains available at `/__hub/api/apps/<id>/logs/stream`. App log snapshot and stream reads require the local Relaybase token through `Authorization: Bearer <token>` or `x-relaybase-token: <token>`.

## Retention

Default retention is 14 days. Retention cleanup removes old segment files by file modification time. Segment rotation defaults to 1000 events per app segment or a date change. Future preferences can tune retention without changing the TUI API shape.

## Redaction

R006 stores presentation-safe redacted messages rather than durable raw secret payloads. Relaybase redacts obvious token, password, secret, key, API-key, and bearer-token patterns, plus configured secret-like environment values known to the app process. Query presentation redacts again as a defensive pass for older or manually corrupted segment data.

## Export

R007 implements backend export through:

```text
POST /__hub/api/logs/export
GET /__hub/api/exports/<exportId>
```

Export requests support `pane`, `app`, `group`, `page`, and `all` scopes. Current pane exports use `componentRole` because Relaybase does not yet have a native pane model. `paneIds` are reserved and rejected until that model exists.

Supported artifact formats:

```text
log
jsonl
zip
```

Artifacts are written under:

```text
<state-dir>/exports/<exportId>/
```

ZIP bundles contain logs, safe app metadata, app state snapshot, route health snapshot, diagnostics, `manifest.json`, and `redaction_report.json`. App metadata intentionally omits raw environment values and command text. Exports are redacted by default; unredacted export is not supported in R007 and returns a normalized API error.

Export redaction covers token/password/secret/key-like assignments, bearer tokens, secret-like environment values, and the active Relaybase auth token. The redaction report records replacement counts by category only; it never records secret values.

The global daemon event stream emits:

```text
export.started
export.progress
export.completed
export.failed
```

## CLI

The current CLI does not expose log export commands. Authenticated clients can use the implemented backend export API; `relaybase logs <app-id>` remains the CLI path for recent app logs. The following command shapes are not currently implemented:

```text
relaybase export logs --app <id>
relaybase export logs --group <groupId>
relaybase export logs --all
```

## Diagnostics

Corrupt `index.json` files are rebuilt from segments and reported through `LogStore.health()` diagnostics. Corrupt JSONL segment lines are skipped and reported in log query diagnostics. The daemon should degrade log scrollback rather than crash.
