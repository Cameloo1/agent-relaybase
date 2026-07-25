# Operator console

`relaybase start` opens the Relaybase terminal interface and safely starts the local daemon when needed. The console is a client of that daemon: it displays state and sends requests, while the daemon remains responsible for processes, ports, health checks, routes, logs, approvals, packages, and recovery.

## First orientation

Use these controls first:

| Input          | Result                                                                     |
| -------------- | -------------------------------------------------------------------------- |
| `?` or `/help` | Open searchable command help.                                              |
| `/settings`    | Open General, Appearance, Interaction, and Agent settings.                 |
| `/start`       | Open the fast registered-app launcher.                                     |
| `/manage`      | Open complete actions for registered apps.                                 |
| `/packages`    | Manage saved multi-app launch bundles and their runs.                      |
| `Ctrl+G`       | Open or close the docked Agent transcript; narrow terminals use a modal.   |
| `F6`           | Open the full-width Agent Chat page; `F6` or `Esc` restores the workspace. |
| `Ctrl+P`       | Open the searchable command palette.                                       |
| `q`            | Start the quit flow; quitting the TUI does not stop the daemon or apps.    |

The bottom composer accepts slash commands and ordinary text. `Ctrl+J` inserts a newline. `Tab` completes commands and saved app identifiers where completion is available. Up and Down move through matching command suggestions while the composer owns input.

## Launch a development app

For a project that Relaybase has not seen:

```text
/add C:\path\to\project
```

`/add` inspects the selected folder and shows a reviewable setup proposal. It does not write files or start the app before approval.

To coordinate project detection, registration, and one bounded launch proof:

```text
/register C:\path\to\project
```

The default registration proof starts the app once, checks its declared health, stops it, and verifies that its Relaybase-owned backend port closed. Successful proof leaves the app stopped. Use `/start` or `/start <app-id>` when you want it running normally.

Use `/register <path> --no-verify` only when you intentionally accept registration without a launch-readiness claim.

## App launcher and manager

Bare `/start` opens the fast launcher. Select a running app to open its monitoring pane, or select a stopped app to review its start confirmation.

`/manage` opens the full daemon-backed app manager. Depending on app state and available metadata, its actions can:

- open the app or route;
- start, stop, or restart it;
- rename its display name while preserving its stable app ID and route;
- copy its route when clipboard support is available;
- export redacted logs;
- inspect repair choices;
- unregister it;
- add it to a saved package.

Disabled actions include a text explanation. App mutations always use the daemon and retain their approval boundary.

## Packages

A package is a durable, ordered list of registered apps. It is a launch bundle, not a new process type. Each member still uses its own normal Relaybase lifecycle.

`/packages` opens package creation, membership editing, ordering, rename, launch/run inspection, and definition deletion. Package runs retain member-level status. A retry addresses only failed or interrupted members; abort prevents members that have not yet been enqueued from starting.

Deleting a package definition does not stop its apps.

## Help

`/help` and `?` open the same searchable help surface. Start typing to filter by command, usage, description, alias, or keyword. Up and Down select results, PageUp and PageDown move a page, Home and End jump to the boundaries, and Enter inserts the selected command into the composer.

The help catalog is also the command-completion source. It labels commands that always require confirmation and commands, such as targeted `/start`, that require confirmation only when a mutating target is supplied.

## Settings

`/settings` opens four categories:

- **General** shows daemon state and provides the confirmation-gated safe daemon restart.
- **Appearance** changes theme, compact/comfortable density, and whether the Agent pane is collapsed. It also reports the authoritative Agent activity indicator mode.
- **Interaction** shows context-menu shortcuts and edits local history retention.
- **Agent** edits non-secret daemon-owned Operator Agent configuration and execution limits.

The Agent category follows the normal operating flow: **Status**, **Provider**, **Configuration**, **Security and credentials**, **Safety and permissions**, **Execution**, **Budgets**, then **Recovery**. Budget limits are ordered by scope: session, daily, then monthly. Recovery pages show the current error before the progressively broader reload and restart actions.

Use Up and Down or the mouse to select a row. Home and End jump to the first and last rows. Enter opens a category, cycles or toggles a supported value, starts an edit, or invokes the action described by that row. `Esc` or Left returns to the parent page; `q` closes settings. The modal expands with the terminal and shows a row-range indicator when a longer page still needs scrolling.

Appearance and Interaction values are stored in `<state-dir>/tui/preferences.json`. Agent values use the authenticated daemon Agent configuration API and are not copied into the TUI preference file. The Agent page accepts an environment-variable name for the provider key, never a raw key value.

Open the Agent page directly with:

```text
/settings agent
```

See [Operator Agent](operator-agent.md) for configuration and safety details and [TUI preferences](tui-preferences.md) for the storage contract.

## Agent pane, chat page, and tool traces

The Agent transcript contains user messages, Agent text, public processing state, tool calls, approvals, diagnostics, and outcomes in chronological order. It does not expose private model reasoning.

While the transcript owns input:

- Up and Down select tool traces.
- Enter or Space expands or collapses the selected trace.
- `Ctrl+E` expands or collapses all available tool details.
- PageUp, PageDown, Home, and End scroll the transcript.

Only an authoritative active foreground operation animates. Waiting for approval, replay, reconnect, completed, failed, cancelled, and offline states are static and include text labels.

## Command reference

### Apps and lifecycle

| Command                                      | Purpose                                                 |
| -------------------------------------------- | ------------------------------------------------------- |
| `/start`                                     | Open the registered-app launcher.                       |
| `/start <app>`                               | Review and confirm a start for one registered app.      |
| `/manage`                                    | Manage registered apps and their daemon-backed actions. |
| `/launch <app\|group\|role>`                 | Start an app, component group, or component role.       |
| `/stop <app\|group\|role>`                   | Stop an app, component group, or component role.        |
| `/restart <app\|group\|role>`                | Restart an app, component group, or component role.     |
| `/logs export <pane\|app\|group\|page\|all>` | Export a redacted log scope.                            |

### Setup, registration, health, and repair

| Command                          | Purpose                                            |
| -------------------------------- | -------------------------------------------------- |
| `/add <path>`                    | Inspect and add a project.                         |
| `/add <path> using <command>`    | Supply a command hint for daemon validation.       |
| `/register <path> [--no-verify]` | Register a project or exact manifest.              |
| `/configure [path] [--dry-run]`  | Detect and preview or apply project setup.         |
| `/open <path-or-app>`            | Open a configured project or registered app.       |
| `/prove <app>`                   | Run a daemon-owned health proof.                   |
| `/health <app> --prove`          | Use the explicit health-proof form.                |
| `/repair <app-or-path>`          | Inspect safe repair choices without applying them. |

### Packages

| Command                                      | Purpose                                              |
| -------------------------------------------- | ---------------------------------------------------- |
| `/create-package {'App','Other App'} 'name'` | Create an ordered saved package.                     |
| `/packages`                                  | Open package management.                             |
| `/launch-package <name>`                     | Start eligible package members.                      |
| `/delete-package <name>`                     | Delete the package definition without stopping apps. |
| `/package-run retry <run-id>`                | Retry failed or interrupted members.                 |
| `/package-run abort <run-id>`                | Abort members that have not been enqueued.           |

### Operator Agent threads

| Command                           | Purpose                                                                   |
| --------------------------------- | ------------------------------------------------------------------------- |
| `/thread list`                    | List daemon-backed Agent threads.                                         |
| `/thread new [title]`             | Create a thread.                                                          |
| `/thread switch <id-or-number>`   | Activate a thread.                                                        |
| `/thread rename <title>`          | Rename the active thread.                                                 |
| `/thread clear`                   | Soft-clear the active thread.                                             |
| `/thread export <json\|markdown>` | Export the active redacted thread.                                        |
| `/thread preview`                 | Preview active-thread context and approval counts.                        |
| `/usage`                          | Show model, token, and cost usage for the last request and active thread. |

### Manifest and component metadata

| Command                             | Purpose                                        |
| ----------------------------------- | ---------------------------------------------- |
| `/manifest inspect <app-or-path>`   | Inspect and validate without writing.          |
| `/manifest edit <field> <value>`    | Preview and apply an approved safe field edit. |
| `/health route <app> <route>`       | Preview and apply a health-route change.       |
| `/port pinned <app> <port>`         | Preview and apply a pinned-port change.        |
| `/component role <app> <role>`      | Edit component-role metadata.                  |
| `/component group <app> <group-id>` | Edit component-group metadata.                 |
| `/component label <app> <label>`    | Edit component-label metadata.                 |

### Layout, settings, daemon, and safety

| Command                      | Purpose                                                     |
| ---------------------------- | ----------------------------------------------------------- |
| `/help`                      | Open searchable help.                                       |
| `/settings`                  | Open categorized settings.                                  |
| `/settings agent`            | Open Agent settings directly.                               |
| `/settings agent security`   | Open Agent credential security and repair directly.         |
| `/page <next\|prev\|number>` | Move between dashboard pages.                               |
| `/pane color <pane> <color>` | Change a pane accent preference.                            |
| `/pin <pane>`                | Pin a pane.                                                 |
| `/unpin <pane>`              | Unpin a pane.                                               |
| `/theme <light\|dark\|auto>` | Change the TUI theme.                                       |
| `/daemon status`             | Show daemon connection status.                              |
| `/daemon repair`             | Request a confirmation-gated daemon repair or reconnect.    |
| `/daemon retry`              | Alias for daemon repair.                                    |
| `/daemon restart`            | Safely replace the daemon and restore Relaybase-owned apps. |
| `/confirm`                   | Confirm the current pending action.                         |
| `/cancel`                    | Cancel the current pending action.                          |

## Natural-language commands

Before any remote Agent call, the console recognizes a bounded local set of phrases for help, settings, daemon status/repair/restart, launch/start/run, stop, app restart, logs, log export, pin/unpin, pane color, paging, and diagnostics. These deterministic phrases use the same resolver, approvals, and daemon APIs as slash commands and do not call a model.

Unsupported ordinary text is sent to the daemon Operator Agent only when that gateway is explicitly enabled and configured.

## Recovery

Use these in order:

1. `/help` for command discovery.
2. `/daemon status` for the control-plane connection.
3. `relaybase check` in a terminal for a read-only installation, daemon, project, and app diagnosis.
4. `/daemon repair` when the launch bridge can safely reconnect or start the daemon.
5. `/daemon restart` only after reviewing its quiesce, replacement, verification, and app-restore preview.

See [Troubleshooting](troubleshooting.md) for symptom-specific recovery.
