# TUI Keymap

This is the required keymap for the Relaybase Bubble Tea TUI.

## Global Keys

| Key             | Behavior                                                                                                                                 |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Arrow keys      | Move between panes or pane items, depending on focus.                                                                                    |
| PageUp/PageDown | Dashboard: move pane pages. Focused pane: scroll logs and request older logs when available.                                             |
| Enter           | Focus the selected pane, activate the selected command, send assistant input, or approve the visible Agent Gateway approval prompt.      |
| Esc             | Return to the dashboard view from detail, help, menu, slash input, or transient panes; reject the visible Agent Gateway approval prompt. |
| `f`             | Toggle follow mode in log/event panes.                                                                                                   |
| `/`             | Open slash-command input.                                                                                                                |
| Text input      | Start deterministic assistant input from the dashboard.                                                                                  |
| Ctrl+Z          | Open the contextual menu when the terminal supports it.                                                                                  |
| Ctrl+O          | Open the contextual menu as the guaranteed fallback.                                                                                     |
| `?`             | Open help.                                                                                                                               |
| `q`             | Start the quit flow.                                                                                                                     |

## Navigation Model

The dashboard has pane focus and item focus. Arrow keys first move within the active pane. When the pane cannot move further in that direction, the TUI may move to the adjacent pane if the layout supports it.

Enter focuses the selected pane from the dashboard. Esc returns to the dashboard from focused panes and dismisses transient UI before leaving the dashboard.

## Paging

On the dashboard, PageUp and PageDown move between pane pages. This is how 9+ panes are reached after the first 8-pane dashboard page.

Inside a focused pane, PageUp and PageDown scroll logs. PageUp may request older logs from the daemon when the current pane has older scrollback available. They must not start lifecycle actions, dismiss modal state, or bypass confirmation gates.

## Contextual Menu

Ctrl+Z is allowed only when the terminal delivers it to the TUI. Ctrl+O is the required fallback and must always open the same contextual menu, even when preferences customize the secondary binding.

The pane contextual menu currently supports:

- close pane
- pin or unpin pane
- reopen a hidden or stopped pane when pane state is still available
- change pane color
- show route when the selected pane has one; clipboard copy is not implemented yet
- export pane logs through the daemon export API; disabled with a daemon-offline reason when the TUI is not connected
- stop app/component through the daemon lifecycle API after confirmation; disabled with a daemon-offline reason when the TUI is not connected
- restart app/component through the daemon lifecycle API after confirmation; disabled with a daemon-offline reason when the TUI is not connected
- show current diagnostics

The assistant contextual menu currently supports:

- expand history
- start a new daemon-backed Operator Agent thread when the Agent Gateway is enabled; otherwise start a clearly labeled local-only deterministic fallback thread
- clear current slash input
- change assistant bar color
- show command help
- export the active daemon-backed Operator Agent thread through the daemon session export endpoint; show an unavailable diagnostic when no daemon-backed thread is active
- show the active daemon-backed thread context preview, including active-thread-only recall policy and pending/recovered approval counts, without exposing raw secrets, logs, or diffs
- show Operator Agent provider status; model execution is daemon-owned and available only when the daemon Agent Gateway is enabled, configured, and within budget

From the dashboard, Ctrl+Z/Ctrl+O opens the pane contextual menu. While slash input is active, Ctrl+Z/Ctrl+O opens the assistant contextual menu.

## Slash Input

`/` opens command input. Slash commands are TUI commands that call daemon APIs or change local view state. They must not bypass daemon lifecycle ownership.

Implemented deterministic slash commands:

- `/add app`
- `/add app <path> using <command>`
- `/launch <app|group|role>`
- `/stop <app|group|role>`
- `/restart <app|group|role>`
- `/logs export <pane|app|group|page|all>`
- `/page <next|prev|number>`
- `/pane color <pane> <color>`
- `/pin <pane>`
- `/unpin <pane>`
- `/theme <light|dark|auto>`
- `/help`
- `/thread list`
- `/thread new [title]`
- `/thread switch <id|number>`
- `/thread rename <title>`
- `/thread clear`
- `/thread export <json|markdown>`
- `/thread preview`
- `/daemon status`
- `/daemon repair`
- `/daemon retry`
- `/register <manifest-path>`
- `/configure`
- `/configure cwd`
- `/configure current folder`
- `/configure <path>`
- `/configure <path> --dry-run`
- `/open <path-or-app>`
- `/prove <app>`
- `/health <app> --prove`
- `/repair <app-or-path>`
- `/manifest inspect <app-or-path>`
- `/manifest edit <field> <value>`
- `/health route <app> <route>`
- `/port pinned <app> <port>`
- `/component role <app> <role>`
- `/component group <app> <groupId>`
- `/component label <app> <label>`

Pane targets may use `current`, the exact pane/app label, or the visible pane number on the current page. Start, stop, restart, log export, setup apply, manifest registration, project open/prove, and safe manifest patch commands require a confirmation preview unless the command includes `--confirm`. `/configure <path> --dry-run`, `/repair <app-or-path>`, and `/manifest inspect <app-or-path>` are read-only daemon requests and do not require confirmation. The preview shows action, target, risk, and expected result. Ambiguous targets ask the user to choose a more specific app id, group id, or pane id; unknown targets return an actionable error.

Setup commands call daemon setup APIs. The TUI does not write manifests, wrappers, setup profiles, env files, or MCP config files, and it does not spawn app commands. App-targeted manifest edits require the daemon state to expose a manifest path; otherwise the TUI asks for an explicit manifest or project path instead of guessing.

Thread commands call daemon Agent Gateway session APIs. The TUI does not store chat transcripts in preferences and does not merge daemon transcript history into local deterministic history when switching threads. `/thread switch <number>` uses the latest `/thread list` result; exact IDs can be activated directly. `/thread preview` shows the daemon's active-thread context categories, recall policy, redaction state, and approval counts without exposing raw secrets, raw logs, or raw diffs.

`/thread clear` is a daemon soft-clear operation. It removes the thread from normal session lists and records a safe audit event; it does not delete arbitrary files from the project or TUI preference state. `/thread export json` and `/thread export markdown` write redacted daemon exports under the daemon state directory.

Daemon repair commands use the local launch bridge created by `relaybase tui`. `/daemon repair`, `/daemon retry`, `fix daemon`, `retry daemon`, and `start relaybase daemon` may ask the bridge to start or reconnect the Relaybase control-plane daemon after confirmation. They do not start user apps. If the TUI was launched directly as `relaybase-tui` without the Node bridge, these commands stay local and print the safe recovery path: relaunch with `relaybase tui`, or start `relaybase serve` in another terminal with the current state directory and port, then retry from the TUI.

## Natural Assistant Input

Ordinary dashboard text first checks deterministic assistant phrases. This mode is local-only and uses no LLM, remote provider, or assistant-side network call while parsing. Supported phrases include launch/start/run, stop/shut down, restart/reboot/reload, show/tail/view logs, export logs, pin/unpin pane, pane color, page next/previous, diagnostics, daemon status, daemon repair/retry, and help. Supported deterministic phrases map to the same target resolver, confirmation gates, and daemon API calls as slash commands; unsupported text may be sent to the daemon Agent Gateway only when that gateway is explicitly enabled.

Path-rich setup phrases are treated as daemon Agent Gateway setup input instead of local lifecycle targets when the Operator Agent is enabled. Examples include `go start the server in C:\path\to\app`, `start project .\apps\notes`, `configure <path> and start it`, `add <path> using npm run dev`, `use npm run dev in <path>`, `open <path>`, and `repair <path>`. The TUI strips common prompt artifacts such as a trailing PowerShell `>` and preserves Windows paths, relative paths, quoted paths, and `current folder`/`cwd` wording. If the daemon or Agent Gateway is unavailable, the TUI shows the exact `relaybase serve ...` recovery command when relevant plus a slash fallback such as `/configure <path> --dry-run`, `/add app <path> using npm run dev`, `/open <path>`, or `/repair <path>`.

The bottom assistant bar is a single-line input surface. Backspace and Ctrl+H remove the previous character, Delete is inert at the end of the line, Ctrl+U clears the current input, and pasted multiline text is normalized into a single line. The body above the assistant bar scrolls independently, and the assistant bar stays pinned at the bottom.

Implemented deterministic phrases:

- `launch notes`
- `start notes frontend`
- `run the backend`
- `stop the backend`
- `shut down notes`
- `restart api`
- `reboot api`
- `reload api`
- `show frontend logs`
- `tail logs for notes`
- `view logs for notes`
- `export logs for notes`
- `pin this pane`
- `unpin this pane`
- `change this pane to blue`
- `go to next page`
- `go to previous page`
- `what is broken?`
- `show diagnostics`
- `daemon status`
- `fix daemon`
- `retry daemon`
- `start relaybase daemon`
- `help`

Lifecycle mutations and log exports require confirmation previews. Ambiguous role targets ask for clarification; for example, `stop the backend` only resolves when the selected pane/group makes the backend target unambiguous.

## Operator Agent Input

Deterministic assistant mode is checked before Agent Gateway routing. When the daemon Agent Gateway reports that the Operator Agent is enabled and configured, unsupported ordinary assistant input is sent to the daemon with the selected pane/app/group context and current TUI page. The Go TUI does not call OpenRouter directly.

Any model-proposed start, stop, restart, setup write, manifest patch, browser/clipboard-adjacent action, or export action must become a daemon approval preview and pass through the visible confirmation gate before execution.

Recovered approvals are rendered as recovered and require an explicit Enter reconfirmation or Esc rejection. The TUI passes reconfirmation to the daemon; it does not auto-resume recovered tool calls.

## Quit Flow

`q` starts a quit confirmation flow when configured. Quitting the TUI must not stop the daemon or any managed app unless the daemon exposes an explicit, token-gated action and the user chooses it.
