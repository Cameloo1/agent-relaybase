# TUI Preferences

Relaybase TUI preferences are local to the Go TUI and are stored under the selected Relaybase state directory:

```text
<state-dir>/tui/preferences.json
```

This keeps preferences out of arbitrary project folders and avoids adding a daemon mutation surface before `/__hub/api/preferences` is implemented. The daemon still owns lifecycle, logs, routes, token state, and API truth. The TUI preference file only stores terminal UI customization.

`/settings` is the interactive editor for these local preferences and for separate daemon-owned Agent configuration. General, Appearance, and Interaction rows either show runtime state or persist through this file. `/settings agent` reads and writes only token-gated daemon contracts. `/settings agent security` reads daemon-owned security findings, bound repair previews, and safe receipts; none are copied into `preferences.json`.

## Schema

```json
{
  "version": 1,
  "theme": "auto",
  "keymap": {
    "contextMenu": ["ctrl+z", "ctrl+o"]
  },
  "panes": {
    "pinned": [],
    "hidden": [],
    "order": [],
    "colors": {}
  },
  "assistant": {
    "barColor": "default",
    "historyRetentionDays": 30,
    "provider": {
      "mode": "deterministic",
      "provider": "",
      "model": "",
      "baseUrl": "",
      "apiKeyRef": "",
      "remoteEnabled": false,
      "budget": {
        "monthlyTokenLimit": 0,
        "dailyTokenLimit": 0,
        "sessionTokenLimit": 0
      },
      "enabledTools": [],
      "sendLogs": false,
      "sendDiagnostics": false
    }
  },
  "layout": {
    "lastPage": 0,
    "density": "compact",
    "agentPaneCollapsed": false
  }
}
```

## Safety Rules

- Preferences are never written to a project folder.
- Preferences do not include auth tokens, environment values, raw logs, log exports, app commands, or secret-like strings.
- LLM provider preferences may include API key references such as `env:PROVIDER_API_KEY`, but never raw API key values.
- Remote model mode requires explicit `remoteEnabled: true`; `sendLogs` and `sendDiagnostics` are off by default.
- Save uses an atomic same-directory temp file, file sync, rename, and best-effort directory sync.
- Corrupt or unsupported preference files are moved aside as `preferences.json.broken.<timestamp>`, then defaults are regenerated.
- Schema version `0` or missing version migrates to version `1`; future unknown versions are treated as unsupported and moved aside.

## Persisted Values

- Theme mode.
- Context menu primary/fallback key bindings.
- Pane pins.
- Hidden/closed panes, ordered most-recently closed first for the reopen chooser.
- Pane order.
- Pane border/accent colors.
- Assistant bar color.
- Optional assistant provider shell configuration.
- Last dashboard page.
- Layout density.
- Whether the dockable Agent output pane is collapsed.

Pane preferences are keyed by stable pane IDs derived from daemon group/component state. They do not create apps, mutate lifecycle, or infer process state.

## Assistant History And Threads

The `assistant.historyRetentionDays` preference currently limits the in-memory deterministic assistant history for the running TUI process. Daemon-backed Operator Agent threads, messages, runs, events, approvals, audit records, and chat/session exports are stored by the daemon under the Relaybase state directory, not in TUI preferences. The preference file stores the retention setting, but it does not store assistant prompts, slash commands, natural-language input, daemon operation results, raw logs, chat transcripts, thread summaries, approval payloads, or exports.

Assistant history entries are sanitized before being kept in memory. Secret-like values such as token, password, secret, API key, bearer token, or Relaybase session-token text are redacted.

The durable Operator Agent thread database is:

```text
<state-dir>/agent/agent.sqlite
```

The daemon uses that database for active-thread metadata, thread titles, redacted messages, runs, session events, approval records, audit records, export records, and one-time legacy import from `agent/sessions.json` and `agent/audit.jsonl` when those files exist. Those legacy files are left as backups after import. The TUI reads and updates thread state only through `/__hub/api/agent/*`; it does not use preferences as a fallback transcript store.

## Legacy Provider Preference Fields

The version 1 preference schema retains disabled-by-default provider shell fields for compatibility. They are not the authority for daemon Operator Agent execution. Current behavior is:

- deterministic mode remains the local fallback
- `local_model` and `remote_model` remain local preference/configuration states for UI display and future local-provider work
- OpenRouter execution is daemon-owned through `/__hub/api/agent/*`; the Go TUI does not call OpenRouter directly
- raw API keys are rejected from preference JSON
- remote mode is not callable unless the daemon Agent Gateway is enabled, has a model slug, has a configured key source, is within budget, and passes policy checks
- logs and diagnostics are not included in prompt previews unless their toggles are explicitly enabled
- tool names are allowlisted; unknown tools are blocked
- lifecycle, setup, manifest, browser/clipboard-adjacent, and export proposals still require daemon approval previews

Daemon audit/session storage records safe provider, model, data category, budget, approval, and tool summaries after sanitization. The preference file never stores raw model prompts, raw OpenRouter keys, Relaybase tokens, raw logs, or exported log payloads.
