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
| Ctrl+V          | Paste the system clipboard into the assistant input when the terminal does not send bracketed paste text itself.                         |
| Ctrl+Shift+V    | Paste the system clipboard into the assistant input.                                                                                     |
| Ctrl+C          | Copy the current assistant input while the input is active; outside active input, it is left to the terminal/runtime.                    |
| Ctrl+Shift+C    | Copy the current assistant input while the input is active.                                                                              |
| Ctrl+Left/Right | Move the active assistant-input cursor by one word.                                                                                      |
| Ctrl+Backspace  | Delete the previous word in the active assistant input.                                                                                  |
| Ctrl+Delete     | Delete the next word in the active assistant input.                                                                                      |
| Ctrl+Z          | Open the contextual menu when the terminal supports it.                                                                                  |
| Ctrl+O          | Open the contextual menu as the guaranteed fallback.                                                                                     |
| Ctrl+R          | From pane navigation, open a confirmation to stop the selected pane's app/component.                                                     |
| Ctrl+G          | Toggle the Agent output surface; use the dedicated Agent modal when the terminal cannot fit the right-side pane.                         |
| Ctrl+D          | Toggle the diagnostics drawer when diagnostics are present.                                                                              |
| `?`             | Open help.                                                                                                                               |
| `q`             | Start the quit flow.                                                                                                                     |

## Pane Log Controls

Each pane places `[c] [r] [·]` below its PID/backend-port metadata. The active `[c]` control copies the newest 20 non-empty retained log lines, in chronological order, to the system clipboard. It copies only the sanitized display lines and never echoes the payload into TUI history or diagnostics. The `c` key performs the same copy action only while that pane is focused. If the host clipboard is unavailable or the pane has no retained logs, Relaybase reports a safe diagnostic instead of claiming success.

Clicking `[r]` selects that pane and opens the existing confirmation preview to restart its app/component through the daemon lifecycle API. It never restarts before confirmation. If the daemon becomes unavailable, the shared lifecycle gate reports recovery guidance without creating lifecycle work; the established full offline screen continues to replace pane content while disconnected. Plain `r` remains normal assistant input. The final dot control remains intentionally inert reserved space.

Mouse-wheel scrolling applies to a compact dashboard pane only while the pointer is over that pane's log content. It changes that pane's retained-log offset without selecting, focusing, or scrolling a different pane. At the older-log boundary, Relaybase may request an older daemon log page for that same app. Wheel events over non-log content retain their existing body-scroll behavior.

## Command Discovery

`?` opens searchable help with a focused text input at the top. Search matches command names, aliases, descriptions, categories, and keywords. Up/Down select results; PageUp/PageDown move five results; Home/End jump; Ctrl+Up/Ctrl+Down scroll the selected command's usage/example detail; Enter inserts the selected command into the normal assistant input without executing it; Esc closes help in one step.

Typing `/` in the assistant input shows a temporary command palette directly above the pinned input. It displays up to five filtered commands at normal terminal heights (and fewer only when the terminal is too short), each with a concise description. Up/Down, PageUp/PageDown, Home/End, mouse wheel, and mouse click move/select the result. Tab always inserts the selected command; Enter inserts it when the current slash text is incomplete, or submits it once it is syntactically complete. Filtering is recalculated after typing and backspacing.

After `/start` is complete, the command palette becomes a dedicated registered-app completion table with the same `Name` / shortened `Project` / `Status` projection as `/list`. Typing filters by stable app id or display name. Tab or the first Enter on a partial match inserts the selected stable app id without starting it; a separate Enter submits the completed command. A bare `/start` submits immediately and opens the complete registered-app window.

## Navigation Model

The dashboard has pane focus and item focus. Arrow keys first move within the active pane. When the pane cannot move further in that direction, the TUI may move to the adjacent pane if the layout supports it.

Enter focuses the selected pane from the dashboard. Esc returns to the dashboard from focused panes and dismisses transient UI before leaving the dashboard.

## Paging

On the dashboard, PageUp and PageDown move between pane pages. This is how 9+ panes are reached after the first 8-pane dashboard page.

Inside a focused pane, PageUp and PageDown scroll logs. PageUp may request older logs from the daemon when the current pane has older scrollback available. They must not start lifecycle actions, dismiss modal state, or bypass confirmation gates.

In diagnostics, setup, confirmation, stopped-app inventory, and the Agent surface, Up/Down scroll by line, PageUp/PageDown scroll by a viewport page, and Home/End move to the beginning/end. Searchable help owns those keys for its result list as described above. The composer remains pinned while the active surface scrolls.

At supported terminal sizes, the Agent output pane occupies the rightmost one-third of the terminal above the composer, including its left divider. App panes retain the other two-thirds. The composer remains full width and independently grows from one to three visible input rows. Collapsing the Agent pane returns its width to the app workspace without changing the selected app pane or moving the composer.

The dock is used only when the Agent side can retain at least 36 columns and the app workspace at least 80 columns. At smaller usable widths, Ctrl+G opens a dedicated Agent modal instead of compressing either surface. Growing or shrinking the terminal transfers an open Agent surface between the dock and modal while preserving the selected pane, valid dashboard page, Agent scroll/follow state, and prior keyboard focus. Esc returns focus to the surface that owned input before the Agent pane; Ctrl+G closes either presentation. The Composer header keeps the visible `[Ctrl+G agent pane]` pointer in both layouts.

## Contextual Menu

Ctrl+Z is allowed only when the terminal delivers it to the TUI. Ctrl+O is the required fallback and must always open the same contextual menu, even when preferences customize the secondary binding.

The pane contextual menu currently supports:

- restart app/component through the daemon lifecycle API after confirmation; disabled with a daemon-offline reason when the TUI is not connected
- stop app/component through the daemon lifecycle API after confirmation; disabled with a daemon-offline reason when the TUI is not connected
- close pane
- open a dedicated `Reopen pane…` chooser for hidden or stopped panes; user-closed panes are listed most-recently closed first, followed by other hidden panes in stable pane order
- pin or unpin pane
- show route when the selected pane has one; the pane-local `[c]` control copies the retained log tail
- export pane logs through the daemon export API; disabled with a daemon-offline reason when the TUI is not connected
- change pane color
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

- `/add <path>`
- `/add <path> using <command>`
- `/add app <path> using <command>` (temporary compatibility alias)
- `/launch <app|group|role>`
- `/start [app]`
- `/stop <app|group|role>`
- `/restart <app|group|role>`
- `/logs export <pane|app|group|page|all>`
- `/page <next|prev|number>`
- `/pane color <pane> <color>`
- `/pin <pane>`
- `/unpin <pane>`
- `/theme <light|dark|auto>`
- `/help`
- `/list`
- `/usage`
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
- `/create-package {'Registered App','Other App'} 'package-name'`
- `/packages`
- `/launch-package <package-name>`
- `/delete-package <package-name>`
- `/package-run retry <run-id>`
- `/package-run abort <run-id>`
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

Pane targets may use `current`, the exact pane/app label, or the visible pane number on the current page. Targeted start, launch, stop, restart, log export, package launch/delete/run retry/run abort, setup apply, manifest registration, project open/prove, and safe manifest patch commands require a confirmation preview unless the command includes `--confirm`. Bare `/start` is read-only and opens the chooser. `/configure <path> --dry-run`, `/repair <app-or-path>`, and `/manifest inspect <app-or-path>` are read-only daemon requests and do not require confirmation. The preview shows action, target, risk, and expected result. Ambiguous targets ask the user to choose a more specific app id, group id, or pane id; unknown targets return an actionable error.

`/list` and bare `/start` open the same dedicated registered-app window from any normal dashboard state, including while monitoring panes are open. The window uses a `Name` / shortened `Project` directory / `Status` table; running/healthy status is green, stopped/transitional status is yellow, failed/error status is red, and unknown status is muted while the status text remains readable without color. Arrow keys, PageUp/PageDown, Home, and End move through the daemon-backed inventory. Enter on a running app opens and focuses its existing monitoring pane; when that app has multiple panes, Relaybase opens a filtered pane chooser. Enter on a stopped app opens the existing confirmation-gated daemon start request. Starting, stopping, failed, degraded, and unavailable apps are never implicitly launched or restarted. Esc returns to the prior dashboard focus. When the daemon is offline, the window labels any retained inventory as last known and provides daemon recovery guidance.

`/create-package` persists an ordered package only after every quoted member resolves to one registered app id or a unique registered display name. It refuses empty, duplicate, ambiguous, unknown, reserved, or conflicting names without starting an app. `/launch-package` creates a daemon-owned package run only after confirmation; it preflights the entire package, skips healthy running members, starts at most four members concurrently, continues after individual failures, and never rolls back already-started apps. `/package-run retry` retries only failed, skipped, or interrupted members. `/package-run abort` prevents remaining members from being enqueued; it does not stop apps that were already started.

Setup commands call daemon setup APIs. The TUI does not write manifests, wrappers, setup profiles, env files, or MCP config files, and it does not spawn app commands. `/add <path>` without a command, `/configure <path>` when setup details are unclear, and `/register <project-path>` route to the daemon Agent Gateway when the Operator Agent is enabled so the daemon-owned agent can inspect the project and prepare a safe setup preview. The compatibility alias `/add app <path> using <command>` remains accepted for one release. App-targeted manifest edits require the daemon state to expose a manifest path; otherwise the TUI asks for an explicit manifest or project path instead of guessing.

Only parsed `/add`, `/configure`, and folder `/register` targets populate the transient `authorizedProjectRoots` sent to the daemon. The root is canonicalized and bounded; free-form/model text does not authorize filesystem access. When the daemon is connected but the Agent is disabled or incompletely configured, `/add <path>` requests a deterministic read-only setup preview instead of becoming a dead end.

Thread commands call daemon Agent Gateway session APIs. The TUI does not store chat transcripts in preferences and does not merge daemon transcript history into local deterministic history when switching threads. `/thread switch <number>` uses the latest `/thread list` result; exact IDs can be activated directly. `/thread preview` shows the daemon's active-thread context categories, recall policy, redaction state, and approval counts without exposing raw secrets, raw logs, or raw diffs.

`/thread clear` is a daemon soft-clear operation. It removes the thread from normal session lists and records a safe audit event; it does not delete arbitrary files from the project or TUI preference state. `/thread export json` and `/thread export markdown` write redacted daemon exports under the daemon state directory.

Daemon repair commands use the local launch bridge created by `relaybase tui`. `/daemon repair`, `/daemon retry`, `fix daemon`, `retry daemon`, and `start relaybase daemon` may ask the bridge to start or reconnect the Relaybase control-plane daemon after confirmation. They do not start user apps. If the TUI was launched directly as `relaybase-tui` without the Node bridge, these commands stay local and print the safe recovery path: relaunch with `relaybase tui`, or start `relaybase serve` in another terminal with the current state directory and port, then retry from the TUI.

## Natural Assistant Input

Ordinary dashboard text first checks deterministic assistant phrases. This mode is local-only and uses no LLM, remote provider, or assistant-side network call while parsing. Supported phrases include launch/start/run, stop/shut down, restart/reboot/reload, show/tail/view logs, export logs, pin/unpin pane, pane color, page next/previous, diagnostics, daemon status, daemon repair/retry, and help. Supported deterministic phrases map to the same target resolver, confirmation gates, and daemon API calls as slash commands; unsupported text may be sent to the daemon Agent Gateway only when that gateway is explicitly enabled.

Path-rich setup phrases are treated as daemon Agent Gateway setup input instead of local lifecycle targets when the Operator Agent is enabled. Examples include `go start the server in C:\path\to\app`, `start project .\apps\notes`, `configure <path> and start it`, `add <path>`, `add <path> using npm run dev`, `use npm run dev in <path>`, `open <path>`, and `repair <path>`. The TUI strips common prompt artifacts such as a trailing PowerShell `>` and preserves Windows paths, relative paths, quoted paths, and `current folder`/`cwd` wording. If the daemon or Agent Gateway is unavailable, the TUI shows the exact `relaybase serve ...` recovery command when relevant plus a slash fallback such as `/configure <path> --dry-run`, `/add <path> using npm run dev`, `/open <path>`, or `/repair <path>`.

The bottom composer is a multiline input surface that grows from one to three visible rows while retaining longer drafts internally. Backspace and Ctrl+H remove the previous character, Delete removes the next character, Ctrl+Left/Ctrl+Right move by word, Ctrl+Backspace/Ctrl+Delete remove the previous/next word, Ctrl+Home/Ctrl+End move to the draft boundaries, Ctrl+U clears text before the cursor, and Ctrl+J inserts a newline. Bracketed terminal paste, Ctrl+V, Ctrl+Shift+V, and Shift+Insert paste sanitized text into the composer while preserving safe line breaks. Ctrl+C and Ctrl+Shift+C copy only the current active composer input without logging the copied value. If the host clipboard command is unavailable, the TUI shows a diagnostic instead of pretending the action worked. The Agent response and app panes scroll independently, and the composer stays pinned at the bottom.

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

The Agent session stream reconnects from the last accepted numeric sequence with both `afterSequence` and `Last-Event-ID`, uses bounded backoff, shows reconnecting state, and ignores replayed duplicate sequence IDs. Exhausted reconnect attempts become an explicit disconnected diagnostic.

## Quit Flow

`q` starts a quit confirmation flow when configured. Quitting the TUI must not stop the daemon or any managed app unless the daemon exposes an explicit, token-gated action and the user chooses it.
