# TUI-HARDEN-002 Unavailable Surface Audit

Generated: 2026-06-02

## Executive Summary

This audit inspected the current Relaybase Go TUI menu, slash-command, deterministic assistant, provider-shell, view, keymap, smoke, bridge, and release-tool surfaces for actions that say unavailable, behave partially, or are easy to misunderstand.

No product-code fix was implemented in this task. The correct treatment is a small hardening sequence, not AI-agent expansion:

1. Implement now: improve current TUI menu diagnostics and disabled labels, fix the 8-pane smoke no-destructive assertion, and reconcile quit/page navigation wording with actual behavior.
2. Keep unavailable with better diagnostics: route-missing, no selected pane, no hidden/stopped pane, pane-log fetch failure, daemon unavailable, Ctrl+Z intercepted, missing TUI binary, unsupported race, and missing Go/GoReleaser.
3. Remove or hide from current menu: chat export should not be an enabled action until chat persistence exists.
4. Defer to future AI-agent track: LLM provider execution and model-backed assistant behavior. Deterministic assistant remains the only execution path.
5. Defer to release-tooling track: GoReleaser/checksum local tooling and optional platform-specific npm packages.

The daemon/control-plane passing behavior should not be changed. Lifecycle start, stop, restart, log export, state, logs, auth, events, grouping, and durable logs remain daemon-owned.

## Scope And Evidence

Required files inspected:

- `tui/internal/tui/contextmenu/menu.go`
- `tui/internal/tui/model/model.go`
- `tui/internal/tui/slash/slash.go`
- `tui/internal/tui/assistant/assistant.go`
- `tui/internal/tui/assistant/provider.go`
- `tui/internal/tui/views/views.go`
- `tui/internal/tui/keymap/keymap.go`
- `docs/tui-keymap.md`
- `docs/tui-architecture.md`
- `scripts/tui-smoke.mjs`

Additional related files inspected:

- `tui/internal/tui/panes/panes.go`
- `tui/internal/tui/contextmenu/menu_test.go`
- `tui/internal/tui/model/model_test.go`
- `tui/internal/tui/assistant/assistant_test.go`
- `src/tuiBridge.ts`
- `scripts/tui-go.mjs`
- `docs/tui-api-contract.md`
- `docs/tui-preferences.md`
- `reports/release-candidate/known-issues.md`
- `reports/release-candidate/tui-evidence-report.md`
- `reports/release-candidate/tui-8pane-evidence-report.md`

Commands run:

| Command | Result |
| --- | --- |
| `codegraph-mcp agent-use status --repo . --json` | Blocked: `codegraph-mcp` is not recognized on PATH. Per this task chain, CodeGraph does not block direct inspection. |
| `git status --short` | Existing dirty worktree from TUI-HARDEN-001 and baseline report; no product-code edits made by this audit before report creation. |
| `Get-Content ...` on required files | Completed. |
| `rg -n -i "unavailable\|not implemented\|disabled\|unsupported\|shell only\|not_available" tui docs scripts tests src package.json reports -g "!*node_modules*"` | Completed; inventory below accounts for relevant TUI and adjacent user-visible strings. |
| Targeted `rg` for context menu, confirmation, route, LLM, bridge, release strings | Completed. |

## Current Menu And Action Inventory

### Pane Context Menu

Source: `tui/internal/tui/contextmenu/menu.go:41-60`, execution in `tui/internal/tui/model/model.go:777-837`.

| Action | Current user-visible text | Current behavior | Status | Classification | Proposed fix | Likely files | Tests to add/run | Acceptance criteria |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Close pane | `Close pane` | Enabled only when a selected pane exists. Calls `paneManager.CloseSelected()`, persists preferences. | Working | No fix required | Keep. | None | Existing Go tests plus `npm run tui:test` | Closing hides selected pane and persists hidden state. |
| Pin/unpin pane | `Pin pane` or `Unpin pane` | Enabled only when selected pane exists. Toggles pin and persists preferences. | Working | No fix required | Keep. | None | Existing Go tests plus `npm run tui:test` | Pin state persists and stopped pinned panes remain visible. |
| Reopen hidden/stopped pane | `Reopen hidden/stopped pane` | Always enabled. Calls `ReopenSelectedOrFirstAvailable()`. If none exists, message says `No hidden or stopped pane is available to reopen.` | Partial and easy to misunderstand | Keep unavailable with better diagnostic, or dynamically disable | Make menu label/state reflect availability before activation. Prefer disabling when no reopen candidate exists and showing `Reopen hidden/stopped pane (none available)`. | `tui/internal/tui/contextmenu/menu.go`, `tui/internal/tui/model/model.go`, `tui/internal/tui/panes/panes.go`, `tui/internal/tui/contextmenu/menu_test.go`, `tui/internal/tui/model/model_test.go` | Add menu test for no reopen candidates and hidden/stopped candidate. Run `npm run tui:test`, `npm run tui:smoke`, `npm run tui:smoke:8pane`. | The menu no longer invites a no-op reopen when no candidate exists; real hidden/stopped panes can be reopened. |
| Change pane color | `Change pane color` | Enabled only when selected pane exists. Cycles palette and persists preferences. If execution lacks pane, message says `No selected pane is available for color changes.` | Working with defensive fallback | Keep unavailable with better diagnostic if selected pane missing | Keep action disabled when no pane. The fallback message is acceptable. | Optional: `tui/internal/tui/contextmenu/menu.go`, `tui/internal/tui/model/model_test.go` | Existing Go tests plus no-selected-pane menu test if hardening. | No selected pane shows disabled state or clear message; pane color persists. |
| Show route | `Show route` or rendered as `Show route (unavailable)` when no route | Enabled only when selected pane has `RouteLabel`. It does not copy to clipboard; it prints `Route: <route>`. | Working for show-route; clipboard intentionally absent | Keep unavailable with better diagnostic | Keep no clipboard unless real clipboard support is added. Improve disabled label to `Show route (no route)`. Keep docs clear that clipboard copy is not implemented. | `tui/internal/tui/contextmenu/menu.go`, `tui/internal/tui/views/views.go`, `docs/tui-keymap.md`, `tui/internal/tui/contextmenu/menu_test.go` | Add route-present and route-absent render tests. Run `npm run tui:test`. | No fake clipboard claim. Route-present shows route; route-absent explains no route. |
| Export pane logs | `Export pane logs` | Enabled only with selected pane. Opens confirmation using daemon export API. | Working | No fix required | Keep. | None | Existing confirmation tests plus `npm run tui:smoke` | Export requires confirmation and calls daemon API only after approval. |
| Stop app/component | `Stop app/component` | Enabled only with selected pane. Opens confirmation using daemon lifecycle API. | Working | No fix required | Keep. | None | Existing confirmation tests plus smoke evidence | Stop requires confirmation and calls daemon API only after approval. |
| Restart app/component | `Restart app/component` | Enabled only with selected pane. Opens confirmation using daemon lifecycle API. | Working | No fix required | Keep. | None | Existing confirmation tests plus smoke evidence | Restart requires confirmation and calls daemon API only after approval. |
| Show diagnostics | `Show diagnostics` | Always enabled. Adds `Diagnostics visible: <n>.` to assistant bar. Does not open a dedicated diagnostics pane. | Partial and easy to misunderstand | Implement now | Either rename to `Count diagnostics` or implement a simple diagnostics view/modal that lists current diagnostics. Lowest-risk release fix: show diagnostics list in assistant/history or help body. | `tui/internal/tui/model/model.go`, `tui/internal/tui/views/views.go`, `tui/internal/tui/model/model_test.go`, `docs/tui-keymap.md` | Add model/view test proving diagnostics content, not only count. Run `npm run tui:test`. | User can see diagnostic content after choosing the menu item. |

### Assistant Context Menu

Source: `tui/internal/tui/contextmenu/menu.go:64-77`, execution in `tui/internal/tui/model/model.go:838-875`.

| Action | Current user-visible text | Current behavior | Status | Classification | Proposed fix | Likely files | Tests to add/run | Acceptance criteria |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Expand history | `Expand history` | Toggles `historyExpanded` and updates assistant line. | Working | No fix required | Keep. | None | Existing model tests plus `npm run tui:test` | History expansion toggles visible history. |
| New thread | `New thread` | Clears in-memory assistant histories and input, then says `New assistant thread started.` | Working but local-only | Keep with better diagnostic only if needed | Current text is acceptable because chat persistence is intentionally absent. | Optional docs only | Existing model tests | Does not imply persistent remote chat. |
| Clear current input | `Clear current input` | Clears input and exits command-active state. | Working | No fix required | Keep. | None | Existing model tests | Input clears without daemon mutation. |
| Change bar color | `Change bar color` | Cycles assistant bar palette and persists preferences. | Working | No fix required | Keep. | None | Existing preference tests | Bar color persists. |
| Export chat | `Export chat unavailable` | Enabled menu item that only emits diagnostic `assistant_chat_export_unavailable` and message `Chat export is unavailable until chat persistence exists.` | Intentionally unavailable; user-visible menu clutter | Remove/hide from menu until persistence exists | Do not implement chat persistence here. Remove from the active menu or render as disabled with explicit `requires chat persistence`. Prefer hide for current release. Keep docs noting planned/deferred status. | `tui/internal/tui/contextmenu/menu.go`, `tui/internal/tui/model/model.go`, `docs/tui-keymap.md`, `docs/tui-preferences.md`, `tui/internal/tui/contextmenu/menu_test.go`, `tui/internal/tui/model/model_test.go` | Add test that assistant menu does not offer enabled chat export, or renders it disabled with clear reason. Run `npm run tui:test`. | No selectable menu action only reports unavailable. No chat persistence or AI-agent scope added. |
| Show command help | `Show command help` | Sets help visible and adds assistant message. | Working | No fix required | Keep. | None | Existing help tests | Help renders slash command list. |
| LLM mode status | `LLM mode status` | In deterministic mode says `LLM mode is disabled; deterministic mode remains active.` In configured non-deterministic shell says provider execution is not implemented. Does not call remote endpoint. | Intentionally shell-only | Defer to future AI-agent track, keep status-only | Keep as status-only if the label remains `status`. Do not implement OpenRouter, OpenAI Agents SDK, or provider execution in TUI-HARDEN. Optionally label as `Assistant provider status`. | Optional: `tui/internal/tui/contextmenu/menu.go`, `tui/internal/tui/model/model.go`, `docs/tui-keymap.md` | Existing `TestLLMModeMenuDoesNotCallRemoteEndpoint`; run `npm run tui:test`. | Deterministic remains default; no remote calls; status text is unambiguous. |

## Slash And Deterministic Assistant Surfaces

Source: `tui/internal/tui/slash/slash.go`, `tui/internal/tui/assistant/assistant.go`, `tui/internal/tui/model/model.go`.

| Surface | Current user-visible text | Current behavior | Status | Classification | Proposed fix | Likely files | Tests to add/run | Acceptance criteria |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Unsupported slash command | `Unknown slash command "<cmd>". Use /help.` or `Unsupported command. Use /help.` | Parser rejects unknown commands; model has fallback for unsupported command kind. | Working fail-closed | Keep unavailable with better diagnostic only if needed | Keep. Ensure help includes all implemented commands. | `tui/internal/tui/slash/slash.go`, `tui/internal/tui/views/views.go`, tests | Existing slash parser tests | Unknown slash commands never mutate daemon state. |
| Unsupported assistant command | `Unsupported assistant command. Try /help or a phrase like launch notes, stop the backend, export logs for notes, or what is broken?` | Deterministic parser rejects unsupported natural language. | Working fail-closed | Keep unavailable with better diagnostic | Keep deterministic. Maybe add clearer examples for pane/page/theme commands. | `tui/internal/tui/assistant/assistant.go`, tests | Existing assistant parser tests; add example coverage if changed | Unsupported natural input produces blocked response and no daemon call. |
| Missing selected pane for lifecycle | `No selected pane is available for the lifecycle command.` | Resolver blocks lifecycle action when current pane target cannot resolve. | Working fail-closed | Keep unavailable with better diagnostic | Keep. If no panes exist, show current dashboard state and suggest start/select app where daemon state supports it. | `tui/internal/tui/slash/slash.go`, `tui/internal/tui/model/model_test.go` | Add no-pane lifecycle command test if absent. | No lifecycle command guesses a target. |
| Missing selected pane for pane actions | `No selected pane is available.`, `No selected pane can provide an app target.`, `No selected pane can provide a group target.` | Resolver blocks pin/color/export targets that depend on selection. | Working fail-closed | Keep unavailable with better diagnostic | Keep. Consider showing visible pane choices when page has panes. | `tui/internal/tui/slash/slash.go`, tests | Add resolver tests for page/app/group missing selection. | No target ambiguity is guessed. |
| Ambiguous targets | `Target "<target>" is ambiguous... Options: ...` or role ambiguity text | Resolver asks user to choose more specific app/group/pane. | Working fail-closed | No fix required | Keep. | None | Existing ambiguous target tests | Ambiguous role does not execute lifecycle. |
| Confirmation bypass via `--confirm` | No preview when explicit flag is present | Slash parser supports `--confirm`; lifecycle/export execute directly after explicit flag. | Working by design, but easy to misunderstand | Keep with better docs | The docs already say `--confirm` is explicit. No change unless UX wants a typed confirmation token instead. | Docs/tests if changed | Existing confirmation tests | Destructive action cannot bypass confirmation accidentally. |
| Show frontend/backend logs | `Showing logs for pane ...` | Selects/focuses pane and fetches logs. Fails closed when target cannot resolve. | Working | No fix required | Keep. | None | Existing model tests | Does not open extra stream per pane. |

## TUI Diagnostics And Offline Surfaces

| Surface | Current user-visible text | Current behavior | Status | Classification | Proposed fix | Likely files | Tests to add/run | Acceptance criteria |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Daemon unavailable in TUI | Diagnostic `daemon_unavailable`; smoke transcript checks daemon unavailable output. | Fetch state failure sets `connectionStatus` offline and diagnostic. | Working | Keep unavailable with current diagnostic | Keep. | None | Existing Go tests and `npm run tui:smoke` | TUI renders offline diagnostic and does not start apps. |
| Daemon unavailable in bridge | `relaybase tui: Relaybase daemon is not reachable at <url>. Start the daemon with: relaybase serve` | Bridge checks daemon before resolving/spawning TUI. | Working | Keep unavailable with current diagnostic | Keep. | None | Existing Node tests and smoke | Bridge does not spawn binary when daemon is unreachable. |
| Auth invalid event stream | Diagnostic code `auth_token_invalid` when event stream API error is 401/403. | Event disconnect maps auth errors. | Working but should remain visible | Keep unavailable with current diagnostic | Keep. | None | Existing auth tests | Auth failure is diagnostic, no token leak. |
| Pane logs unavailable | Diagnostic `pane_logs_unavailable`; message includes app id and error. | Log fetch failure does not crash TUI. | Working fail-closed | Keep unavailable with current diagnostic | Keep. | None or add test if coverage gap | Add/confirm log failure model test | Pane remains visible; no fake logs. |
| Ctrl+Z unavailable/conflicting | Diagnostic `context_menu_ctrl_z_unavailable`; help says Ctrl+O fallback opens menu. | Emitted when preference overrides primary context binding. Ctrl+O remains bound. | Working | Keep unavailable with current diagnostic | Keep. | None | Existing Ctrl+Z/Ctrl+O model tests | Ctrl+O always opens same context menu. |
| Unsupported terminal/color | Docs describe theme fallback. Styles tests cover unsupported terminal fallback. | Not a menu action. | Working or environment-specific | Keep diagnostic | Keep. | None | Existing style tests | Readability preserved. |

## Optional LLM Shell And Future AI-Agent Scope

Source: `tui/internal/tui/assistant/provider.go:143-184`, `tui/internal/tui/model/model.go:938-947`, docs.

| Item | Current user-visible text | Current behavior | Status | Classification | Proposed fix | Likely files | Tests to add/run | Acceptance criteria |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| LLM disabled default | `LLM mode is disabled; deterministic mode remains active.` | Deterministic mode is default and only execution path. | Correct | Defer future AI-agent track | Keep. | None | Existing provider tests | No provider call path exists by default. |
| Missing LLM provider/model | `Optional LLM assistant mode is configured, but provider and model are not fully configured.` | Diagnostic only. | Correct shell-only behavior | Defer future AI-agent track | Keep. | None | Existing provider/model tests | Missing provider never fakes response. |
| Remote not enabled | `Remote model mode requires explicit remoteEnabled=true...` | Diagnostic only. | Correct shell-only behavior | Defer future AI-agent track | Keep. | None | Existing tests | No remote calls without explicit config. |
| Remote endpoint/key missing | Endpoint/key-ref diagnostics. | Diagnostic only, raw keys rejected. | Correct shell-only behavior | Defer future AI-agent track | Keep. | None | Existing tests | No secrets stored or sent. |
| Provider execution not implemented | `Optional LLM provider execution is not implemented yet; deterministic assistant mode remains the execution path.` | No provider execution; no fake response. | Correct | Defer future AI-agent track | Keep. Maybe avoid wording that looks like a broken menu by making this a status panel, not an action. | Optional menu/docs | Existing no-remote-call tests | Future AI-agent prompts must start only after TUI hardening, not here. |

## Release Tooling, Packaging, And Evidence Surfaces

These are user-visible around `relaybase tui`, smoke evidence, or release verification, but they are not in-app TUI menu actions.

| Surface | Current user-visible text | Current behavior | Status | Classification | Proposed fix | Likely files | Tests to add/run | Acceptance criteria |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Missing TUI binary | `relaybase tui: relaybase-tui binary was not found.` and resolution order. | Bridge fails closed with build/toolchain instructions. | Working diagnostic | Keep unavailable with current diagnostic | Keep. | None | Existing Node tests; `npm run package:check` | Missing binary never claims launch success. |
| Go missing | `Go <version> is required but go was not found on PATH.` | TUI scripts fail closed with install/verify instructions. | Working diagnostic | Keep unavailable with current diagnostic | Keep. | None | Existing wrapper tests | No raw `spawnSync go ENOENT` as primary diagnostic. |
| Unsupported platform | `relaybase tui: unsupported platform <platform>/<arch>...` | Build wrapper rejects unsupported target. | Working diagnostic | Keep unavailable with current diagnostic | Keep. | None | Existing wrapper tests or add target test | Unsupported platform does not generate bogus binary path. |
| Race unsupported | `Go race testing is unavailable in this environment. The race check did not pass...` | Wrapper exits documented unsupported code. | Working honest skip | Keep unavailable with current diagnostic | Keep. | None | Existing race wrapper tests | Race unsupported is not reported as passed. |
| GoReleaser unavailable | `GoReleaser is required... goreleaser was not found on PATH.` | Release check fails closed locally. | Release-track-only | Defer to release tooling track | Keep for now; install/use GoReleaser in release CI. | `.goreleaser.yml`, `scripts/tui-go.mjs`, CI docs if later changed | `npm run release:check` in GoReleaser-capable lane | Release checksum verification exists before publishing. |
| Platform package unavailable | Docs/bridge mention optional `@cameloo/relaybase-tui-<platform>-<arch>` package; known issue says not implemented. | Bridge includes path in resolution order, but package lane does not exist. | Release packaging gap | Defer to release tooling track | Do not expose as product app feature. Either implement optional packages before release or remove package lane from user-facing diagnostic until packages exist. | `src/tuiBridge.ts`, package docs, release docs, tests | Node bridge diagnostic tests, package smoke | Diagnostic does not suggest an install path that cannot exist unless explicitly labeled optional/future. |
| Recording not available | Evidence report shows `recording | not_available`; notes say terminal transcripts captured. | Honest artifact state; no VHS/asciinema installed. | Working honest limitation | Keep unavailable with current diagnostic | Keep, or install recording tooling only if release evidence requires it. | `scripts/tui-smoke.mjs`, reports | `npm run tui:smoke`, `npm run tui:smoke:8pane` | Do not fake screenshot/recording. Transcript evidence remains present. |

## Docs And API Planned Surfaces

| Surface | Current text | Current behavior | Status | Classification | Proposed fix | Likely files | Tests to add/run | Acceptance criteria |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `/__hub/api/apps/:id` | Planned, not implemented; current app detail is `/__hub/api/apps/:id/state`. | TUI client should use implemented endpoint. | Correct docs | Keep planned | No product fix. | None | API contract tests if endpoint changes later | Docs do not claim fake endpoint. |
| `/__hub/api/preferences` | Planned, not implemented; TUI prefs local under state dir. | Current TUI uses local preference store. | Correct docs | Keep planned | No product fix unless moving prefs to daemon later. | None | Preference tests | No fake daemon prefs API. |
| `/__hub/api/diagnostics` | Planned, not implemented. | TUI combines local diagnostics and daemon state diagnostics. | Correct docs | Keep planned | No product fix unless endpoint implemented later. | None | API tests if endpoint implemented | No fake diagnostics endpoint. |
| Unredacted exports | `redact:false` returns `UNREDACTED_LOG_EXPORT_UNSUPPORTED`. | Daemon rejects unredacted export. TUI defaults redacted. | Correct safety behavior | Keep unavailable | Keep. | None | Existing export/redaction tests | Secrets remain redacted by default. |
| Assistant history persistence | `not implemented yet`; retention controls in-memory history only. | TUI does not persist chat/assistant history. | Correct per current scope | Defer future track, not in TUI-HARDEN | Keep. Do not implement chat persistence here. | None | Preference tests | Preferences never store raw prompts/logs/secrets. |

## Navigation And Wording Mismatches

These items do not necessarily say unavailable, but they are easy to misunderstand in the current app.

| Surface | Current behavior | Current docs/text | Status | Classification | Proposed fix | Likely files | Tests to add/run | Acceptance criteria |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Quit flow | Pressing `q` immediately quits in `model.go`; no confirmation flow is implemented. | `docs/tui-keymap.md` says `q` starts the quit flow and later says quit confirmation flow when configured. | Partial/mismatch | Implement now or docs-correct | Lowest-risk: either implement a lightweight quit confirmation, or update docs/help to say `q` quits immediately until quit confirmation is added. Product spec originally wanted quit flow, so prefer implementing confirmation in a future hardening task. | `tui/internal/tui/model/model.go`, `tui/internal/tui/views/views.go`, `docs/tui-keymap.md`, tests | Add q confirmation/cancel/confirm tests; run `npm run tui:test`, smoke. | User cannot accidentally quit if spec requires a flow, or docs no longer imply one. |
| PageUp/PageDown | In focused pane, PageUp/PageDown scroll logs. On dashboard, they change dashboard pages. | `docs/tui-keymap.md` says PageUp/PageDown page inside the active pane only and must not change app selection outside pane. | Partial/mismatch | Implement now or docs-correct | Decide canonical behavior. For 8 panes/multi-page dashboard, dashboard page navigation is useful and already implemented; docs should likely say PageUp/PageDown move dashboard pages when not focused and scroll focused pane when focused. | `docs/tui-keymap.md`, `tui/internal/tui/views/views.go`, tests if behavior changes | If docs-only, run format. If behavior changes, run `npm run tui:test`, snapshots/smoke. | Navigation help and behavior match. |
| Assistant menu access | Assistant menu opens only while command input is active; otherwise context menu opens pane menu. | Docs say assistant contextual menu exists but do not clearly explain how to focus/open it. | Easy to misunderstand | Keep with better diagnostic/docs | Clarify help text or add visible assistant-bar focus state. Do not add AI-agent behavior. | `docs/tui-keymap.md`, `tui/internal/tui/views/views.go`, model tests if UI changes | `npm run tui:test`, smoke | Users can predict which menu Ctrl+O opens. |
| Diagnostics menu | `Show diagnostics` only reports count. | Menu wording implies diagnostics will be shown. | Partial | Implement now | Show diagnostic contents or rename. | `tui/internal/tui/model/model.go`, `tui/internal/tui/views/views.go`, tests | `npm run tui:test` | Menu action visibly surfaces diagnostic details. |

## Smoke Harness Partial Behavior

| Item | Current behavior | Status | Classification | Proposed fix | Likely files | Tests to add/run | Acceptance criteria |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 8-pane no-destructive assertion | `scripts/tui-smoke.mjs` calls `appsStillRunning(stateAfter, fixture.apps)`, but `appsStillRunning` currently ignores the second argument and checks only `notes-web` and `notes-api`. The 8-pane transcript still proves all 8 panes render, but the no-destructive confirmation evidence is only proving the original two Notes apps stayed running. | Partial evidence coverage | Implement now | Update `appsStillRunning(state, apps)` to require every fixture app still has runtime status `running`. Add a unit test that the helper fails when any 8-pane app is stopped. | `scripts/tui-smoke.mjs`, `tests/unit.test.ts` | `npm run tui:smoke`, `npm run tui:smoke:8pane`, `npm test` | For 8-pane fixture, no-destructive-before-confirmation proves all eight fake apps stayed running. |
| Recording evidence | `recording` is `not_available` when VHS/asciinema are absent; transcripts are captured. | Honest limitation | Keep unavailable with current diagnostic | No fake screenshots. Optional future recording tooling can be added if required. | `scripts/tui-smoke.mjs` only if changed | Smoke commands | Report clearly distinguishes transcript from screenshot/recording. |

## Search String Accounting

The required search terms were found and accounted for as follows:

- `unavailable`: TUI route disabled label, menu unavailable fallbacks, chat export, LLM/provider shell, daemon/log diagnostics, bridge daemon unavailable, smoke recording `not_available`, GoReleaser/race/toolchain diagnostics, durable log store diagnostics, Docker/control-plane diagnostics, docs planned surfaces.
- `not implemented`: chat persistence, LLM provider execution, planned API endpoints, unredacted export/pane id limitations, docs for assistant history persistence.
- `disabled`: dashboard HTML button disabled states, LLM disabled default, docs. Dashboard disabled buttons are not Go TUI menu actions and should not be changed in this task.
- `unsupported`: race/toolchain/platform diagnostics, preference schema handling, unredacted export, registry/log index format, Docker setup diagnostics. These are fail-closed diagnostics, not broken TUI menu actions.
- `shell only`: LLM provider shell is status/config only. No provider execution should be added in TUI-HARDEN.
- `not_available`: smoke recording artifact status. This is an honest evidence limitation, not a product feature claim.

## Recommended Fix Order

1. Fix current TUI UX clarity:
   - route-missing disabled label
   - reopen availability
   - diagnostics menu shows diagnostic content
   - assistant menu hides/disables chat export
   - clarify assistant-menu access
2. Fix behavior/doc mismatches:
   - quit flow
   - PageUp/PageDown dashboard/page behavior wording
3. Fix smoke evidence partial:
   - all 8 fixture apps must be checked in `noDestructiveBeforeConfirmation`
4. Keep future AI-agent items deferred:
   - no OpenRouter
   - no OpenAI Agents SDK
   - no provider execution
   - no chat persistence in this hardening chain
5. Keep release tooling items on release track:
   - GoReleaser local install/CI lane
   - optional platform npm package implementation or diagnostic cleanup

## Proposed Follow-Up Implementation Prompts

### TUI-HARDEN-003: Current Menu UX Hardening

Implement only current non-AI menu clarity fixes:

- Disable or relabel `Show route` when no route exists.
- Disable or relabel `Reopen hidden/stopped pane` when no reopen candidate exists.
- Make `Show diagnostics` display diagnostic details instead of only a count.
- Hide or disable `Export chat unavailable` until chat persistence exists.
- Clarify assistant menu access in help/docs.

Acceptance:

- No AI-agent code.
- No lifecycle logic in TUI.
- `npm run tui:test` passes.
- `npm run tui:smoke` passes.
- Menu tests cover no-pane, no-route, no-reopen, diagnostics, and hidden chat-export behavior.

### TUI-HARDEN-004: Navigation And Quit Wording/Behavior Reconciliation

Resolve the `q` quit-flow and PageUp/PageDown behavior mismatch.

Acceptance:

- Either `q` has a tested confirmation flow, or docs/help honestly say immediate quit.
- PageUp/PageDown help matches implementation.
- `npm run tui:test`, `npm run tui:smoke`, and `npm run tui:smoke:8pane` pass.

### TUI-HARDEN-005: 8-Pane Smoke Evidence Completeness

Fix `appsStillRunning` to validate all fixture apps and add regression coverage.

Acceptance:

- `noDestructiveBeforeConfirmation` fails if any one of the eight fixture apps is stopped.
- `npm test`, `npm run tui:smoke`, and `npm run tui:smoke:8pane` pass.

### TUI-HARDEN-006: Release-Track Diagnostic Cleanup

Release-track only. Do not start AI-agent work.

- Decide whether optional platform package diagnostics should remain visible before platform packages exist.
- Keep GoReleaser/race/missing-Go diagnostics honest.
- Do not mark unavailable release tooling as product failure.

Acceptance:

- `npm run package:check` passes.
- `npm run release:check` either passes in a GoReleaser-capable environment or fails with the existing actionable diagnostic.

## Backend And Control-Plane Preservation

Do not disturb these passing surfaces while implementing follow-up hardening:

- Node daemon lifecycle ownership.
- Async lifecycle operation API.
- Global event stream.
- Group/component state.
- Durable logs and export/redaction.
- Auth/token diagnostics.
- MCP tools.
- Existing dashboard.
- CLI bridge daemon-unavailable and missing-binary diagnostics.

## Audit Verdict

The TUI has several intentionally unavailable or shell-only surfaces, and a few current UX/menu actions that are partial or easy to misunderstand. None of the audited unavailable items require OpenRouter, OpenAI Agents SDK, Operator Agent, chat persistence, fake clipboard behavior, fake screenshots, or moving lifecycle logic into the TUI.

The next implementation prompt should be `TUI-HARDEN-003 - Current Menu UX Hardening`.
