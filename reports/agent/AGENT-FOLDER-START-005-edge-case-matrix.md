# AGENT-FOLDER-START-005 Edge-Case Matrix

## Scope

This task adds non-live coverage for the natural-language-to-folder-start loop. The tests use real setup APIs and daemon-owned Agent tools with fake local runtimes where lifecycle execution is needed. They do not use OpenRouter, do not mutate real user repositories, and do not move setup or lifecycle ownership into the TUI.

## Coverage Map

| Edge case | Coverage |
| --- | --- |
| JS package with `npm run dev` | `tests/agent-folder-start-edge-matrix.test.ts`: project fixture matrix |
| Vite app | `tests/agent-folder-start-edge-matrix.test.ts`: project fixture matrix and repair matrix |
| Next app | `tests/agent-folder-start-edge-matrix.test.ts`: project fixture matrix |
| Astro app | `tests/agent-folder-start-edge-matrix.test.ts`: project fixture matrix |
| Plain Node server honoring `PORT` | `tests/agent-folder-start-edge-matrix.test.ts`: project fixture matrix |
| App ignoring `PORT` | `tests/agent-folder-start-edge-matrix.test.ts`: pinned-port preview and repair matrix |
| `package.json` with no `dev` script | `tests/agent-folder-start-edge-matrix.test.ts`: current fallback behavior captured |
| Invalid `package.json` | `tests/agent-folder-start-edge-matrix.test.ts`: setup/start diagnostic and no writes |
| Existing valid `relaybase.app.json` | `tests/agent-folder-start-edge-matrix.test.ts`: project fixture matrix |
| Existing corrupt `relaybase.app.json` | `tests/agent-folder-start-edge-matrix.test.ts`: manifest registration diagnostic |
| Unregistered manifest | `tests/agent-folder-start-edge-matrix.test.ts`: register-before-start approval flow |
| Already registered app | `tests/agent-folder-start-edge-matrix.test.ts`: path-with-spaces registered start flow |
| Stale registered app path | `tests/agent-folder-start-edge-matrix.test.ts`: failed lifecycle result, no fake success |
| Path with spaces | `tests/agent-folder-start-edge-matrix.test.ts` and TUI path-rich parser tests |
| Windows absolute path | `tests/agent-folder-start-edge-matrix.test.ts` and TUI path-rich parser tests |
| Relative path | `tests/agent-folder-start-edge-matrix.test.ts` and TUI path-rich parser tests |
| Path with trailing `>` | Existing TUI path-rich parser/model tests |
| Nonexistent path | `tests/agent-folder-start-edge-matrix.test.ts`: setup/start diagnostic and no mutation |
| Permission denied path | Not directly simulated; changing ACLs is host/destructive and not reliable in this test suite. Existing setup diagnostics classify permission failures when the OS returns them. |
| Monorepo frontend/backend | `tests/agent-folder-start-edge-matrix.test.ts`: monorepo fixture plus existing component setup tests |
| Two apps with same display name | `tests/agent-folder-start-edge-matrix.test.ts`: target clarification, no lifecycle call |
| Wrong health route | `tests/agent-folder-start-edge-matrix.test.ts`: repair matrix; existing setup/TUI repair rendering tests |
| Fixed port conflict | `tests/agent-folder-start-edge-matrix.test.ts`: repair matrix |
| Missing package manager | `tests/agent-folder-start-edge-matrix.test.ts`: Corepack package-manager command surface captured |
| Missing dependency | `tests/agent-folder-start-edge-matrix.test.ts`: repair matrix |
| Command exits immediately | `tests/agent-folder-start-edge-matrix.test.ts`: repair matrix |
| Long startup logs | Existing TUI log/smoke tests cover bounded rendering; live process behavior remains outside this non-live task. |
| Secret-like logs/env | `tests/agent-folder-start-edge-matrix.test.ts`: setup preview, tool result, session, and audit redaction |

## Required Category Coverage

| Category | Coverage |
| --- | --- |
| Intent parsing/routing | Existing TUI assistant/model path-rich tests |
| Path extraction/normalization | Existing TUI assistant/model path-rich tests plus matrix absolute/relative/spaces cases |
| Setup detection | `tests/agent-folder-start-edge-matrix.test.ts` project fixture matrix |
| Plan/preview/apply consistency | Existing setup API and Agent folder-start tests; matrix asserts preview read-only behavior |
| Approval/rejection | Existing Agent folder-start tests plus register/start approval checks in the matrix |
| Registration | `tests/agent-folder-start-edge-matrix.test.ts` unregistered manifest flow |
| Start lifecycle | `tests/agent-folder-start-edge-matrix.test.ts` registered, stale, and ambiguous target flows |
| Route/log visibility | `tests/agent-folder-start-edge-matrix.test.ts` registered start returns route/logs without secrets |
| Repair | `tests/agent-folder-start-edge-matrix.test.ts` repair matrix |
| Redaction | `tests/agent-folder-start-edge-matrix.test.ts` preview/tool/session/audit checks |
| Session/audit persistence | `tests/agent-folder-start-edge-matrix.test.ts` folder-start-specific persistence test |
| TUI rendering | Existing `tui/internal/tui/model/model_test.go` setup/start preview, approval, route, logs, repair, and chatbar tests |

## Known Notes

- This is non-live coverage only. It does not claim OpenRouter, real TUI PTY, or real process launch proof.
- The current no-dev-script behavior falls back to a generic `node server.js` setup plan for Vite-like projects. This is captured as current behavior rather than promoted as ideal UX.
- Permission-denied path simulation is documented as not feasible here because a reliable Windows ACL mutation would be host-specific and outside the safe temp-project test model.
