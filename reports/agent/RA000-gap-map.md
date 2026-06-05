# RA000 Gap Map

Generated: 2026-06-02

## Summary

RA000 was documentation and governance only. Current status has advanced through RA010: daemon setup/onboarding APIs exist, the Agent Gateway contract exists, OpenRouter compatibility with OpenAI Agents SDK TypeScript is implemented through an adapter, the daemon Operator Agent runtime exists, the daemon-owned Relaybase tool registry exists, durable redacted session/audit storage exists, and the Go TUI is connected to the Agent Gateway for sessions, messages, event streams, setup previews, and approval decisions.

The current Relaybase TUI foundation passed the TUI foundation gate in `reports/fix-planning/TUI-HARDEN-011-final-verification.md`. RA010 adds the Go TUI Agent Gateway client/rendering path, but live OpenRouter proof still requires `OPENROUTER_API_KEY`, `RELAYBASE_AGENT_MODEL`, and `npm run agent:smoke:openrouter`.

RA012A added the planning-only runtime/language setup matrix in `docs/tui-setup-runtime-matrix.md` and `reports/agent/RA012A-runtime-matrix-plan.md`. RA012B implements the daemon-side runtime adapter registry, setup API runtime metadata, runtime repair candidates, and disposable fixture coverage for 16 runtime/process types.

RA012C wires that runtime matrix into the Operator Agent and Go TUI setup surface: prompts forbid Node/npm assumptions, setup tools accept runtime/command/port hints, approval previews include runtime/command/port context, and the TUI setup panel renders runtime candidates, setup questions, command candidates, port strategies, and repair candidates.

## Evidence Inspected

- `AGENTS.md`
- `docs/relaybase-release-roadmap.md`
- `docs/tui-architecture.md`
- `docs/tui-keymap.md`
- `docs/tui-api-contract.md`
- `docs/app-manifest.md`
- `docs/app-components.md`
- `reports/fix-planning/FINAL-PRE-RA-VERIFY.md`
- `reports/fix-planning/TUI-HARDEN-011-final-verification.md`
- `src/cli.ts`
- `src/setup.ts`
- `src/processManager.ts`
- `src/api.ts`
- `src/apiTypes.ts`
- `tui/internal/tui/assistant/provider.go`

## Current Truth

Implemented:

- Node/TypeScript daemon lifecycle, state, logs, events, exports, setup CLI primitives, and registration API.
- Go TUI deterministic local assistant, slash commands, context menus, panes, preferences, and evidence smoke.
- Component-as-app grouping metadata.
- Setup engine plans for managed dynamic port, framework wrapper, pinned upstream port, Docker Compose, static preview, and MCP-only paths.
- Runtime/language adapter matrix for broadening setup beyond current Node/package-manager, Docker, static, MCP, and manifest paths.

Implemented after RA001:

- Daemon setup/onboarding API endpoints for detect, plans, preview, apply, manifest inspect/validate/patch/register, open, prove, and repair.
- Exported setup/onboarding API TypeScript models.
- Setup engine facade over current CLI setup primitives.
- Read-only setup previews, safe file diffs, token/confirmation gates for writes, setup events, and component-as-app preview metadata.
- Agent Gateway endpoints for config, sessions, TUI-context messages, session SSE events, diagnostics, and approval ID validation.
- OpenRouter compatibility adapter for OpenAI Agents SDK TypeScript through the Chat Completions-compatible provider path.
- Daemon-side Operator Agent runtime foundation with bounded/redacted TUI context, disabled/missing-config diagnostics, provider timeout diagnostics, and streamed model events.
- RA007 daemon-owned tool registry for read-only app/log/setup inspection, approval-gated lifecycle/export/setup/manifest/env/open/prove tools, and TUI-proposed actions.
- RA009 state-dir backed `agent/sessions.json`, `agent/audit.jsonl`, budget-block diagnostics, local trace events, and redacted chat/session export.
- RA010 Go TUI Agent Gateway client methods, config/diagnostic loading, session/message/event commands, approval approve/reject commands, and event rendering for setup previews, file-write previews, repair choices, prove results, diagnostics, and TUI proposed actions.

Not implemented:

- Live OpenRouter smoke pass unless `OPENROUTER_API_KEY` and `RELAYBASE_AGENT_MODEL` are configured and the smoke command is run.
- Native manifest `components[]`; current frontend/backend grouping remains component-as-app metadata.
- Platform-specific release packages and local GoReleaser/checksum proof when GoReleaser is not installed.

## Gap Ownership

| Gap                                                                                                                                                | Owner                      | Status                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Operator Agent architecture docs.                                                                                                                  | RA000                      | Filled by docs.                                                                                                               |
| OpenRouter config/key/budget docs.                                                                                                                 | RA000/RA005/RA009          | Filled; provider adapter implemented in RA005 and budget block implemented in RA009.                                          |
| Tool registry docs.                                                                                                                                | RA000/RA007                | Docs filled; daemon registry implemented in RA007.                                                                            |
| Safety and approval docs.                                                                                                                          | RA000/RA007/RA010          | Filled; daemon tool approval gates and TUI approval rendering/approve/reject handoff exist.                                   |
| Testing docs.                                                                                                                                      | RA000/RA010                | Filled by docs; RA010 Go tests cover TUI Agent Gateway client/rendering path.                                                 |
| TUI add/register/configure app from folder and command.                                                                                            | RA003/RA010                | Filled/partial; slash/setup client surface exists and Agent Gateway can route natural setup requests when enabled.            |
| Current-directory setup context.                                                                                                                   | RA003/RA010                | Filled; TUI/bridge forwards current directory and RA010 sends it in `TuiAgentContext`.                                        |
| Daemon-owned configure/dry-run/register/open/health-prove equivalents.                                                                             | RA001, RA002, RA003        | Filled as setup API contract and TUI command surface backed by setup engine facade.                                           |
| Setup plan previews and multiple choices.                                                                                                          | RA001, RA002, RA003, RA010 | Filled; daemon API and TUI/Agent preview rendering exist.                                                                     |
| Confirm file writes before apply.                                                                                                                  | RA001, RA003, RA010        | Filled; daemon confirmation paths and TUI approval rendering exist.                                                           |
| Manifest/wrapper/profile diffs.                                                                                                                    | RA001, RA003, RA010        | Filled; daemon previews and TUI diff/file-write rendering exist.                                                              |
| Existing manifest inspect/validate/repair/re-register.                                                                                             | RA001, RA002, RA003, RA010 | Filled; daemon API, TUI commands, and Agent setup event rendering exist.                                                      |
| Runtime port strategy selection/explanation.                                                                                                       | RA001, RA002, RA003, RA010 | Filled/partial; daemon plan metadata and TUI preview rendering exist, with copy polish left for hardening.                    |
| Runtime-aware setup for Python, Go, JVM, .NET, Ruby, PHP, Rust, Elixir, Scala, Clojure, Dart, native/C/C++, Docker Compose, and Procfile projects. | RA012A/RA012B              | Filled by RA012B daemon runtime adapters and fixture coverage.                                                                |
| Runtime-specific ambiguity questions and repair candidates.                                                                                        | RA012A/RA012B              | Filled by RA012B setup questions, runtime diagnostics, and `/setup/repair` runtime repair candidates.                         |
| Operator Agent and TUI consume runtime matrix instead of assuming Node/npm.                                                                        | RA012C                     | Filled by RA012C prompt/tool/TUI rendering updates and tests.                                                                 |
| Repair app ignores PORT.                                                                                                                           | RA001, RA002, RA003, RA010 | Filled/partial; repair preview/apply and TUI repair choice rendering exist.                                                   |
| Edit safe manifest fields.                                                                                                                         | RA001, RA003, RA010        | Filled; patch preview/apply and TUI approval rendering exist.                                                                 |
| Frontend/backend setup under one group.                                                                                                            | RA001, RA002, RA003, RA010 | Filled/partial; component-as-app metadata patching and setup proposals exist; native components remain deferred.              |
| Prove setup with route/log/stop evidence.                                                                                                          | RA001, RA002, RA003, RA010 | Filled/partial; daemon proof API and TUI prove-result rendering exist; live proof remains RA013.                              |
| No-apps state options.                                                                                                                             | RA003                      | Filled by TUI no-apps onboarding state.                                                                                       |
| Native `components[]` manifest.                                                                                                                    | DEFERRED                   | Future migration only.                                                                                                        |
| Clipboard/browser actions.                                                                                                                         | RA007/RA010                | Deferred/diagnostic. TUI-proposed actions can represent them, but execution remains unavailable unless real support is added. |
| AI-app-builder educational docs.                                                                                                                   | RA000                      | Filled by separate docs.                                                                                                      |
| GoReleaser/checksum release dry-run.                                                                                                               | RELEASE                    | Release-track-only.                                                                                                           |
| Platform-specific npm packages.                                                                                                                    | RELEASE                    | Release-track-only.                                                                                                           |

## Protected Passing Behavior

Do not disturb:

- daemon lifecycle ownership
- token-gated mutations
- durable log/export/redaction behavior
- grouped app/component read models
- TUI deterministic command confirmation gates
- TUI no-direct-lifecycle boundary
- Node bridge TUI launch path
- existing package and TUI verification commands

## Next Prompt

Recommended next implementation prompt after CodeGraph/worktree gates are acceptable:

```text
RA013 - Live Operator Agent and setup/onboarding proof
```

RA013 must preserve the daemon-owned setup boundary, approval gates, redaction, and existing Node/Docker behavior. RA012B does not claim live OpenRouter or real TUI proof; that belongs to RA013/live verification.
