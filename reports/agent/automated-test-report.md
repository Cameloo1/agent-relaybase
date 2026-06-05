# RA012 Automated Test Report

Generated: 2026-06-02

## Scope

RA012 adds and verifies controlled local automated coverage for the Relaybase Operator Agent, setup/onboarding tools, safety gates, and TUI model/client integration. This report intentionally does not claim live OpenRouter coverage and does not claim real TUI launch proof. Live provider and real terminal proof remain RA013/release verification work.

## Coverage Boundary

- Model responses are mocked or exercised through missing-key/non-live paths.
- Tool execution uses local fake Relaybase runtimes, temporary project directories, or HTTP test servers.
- Setup/onboarding tests write only to temporary directories.
- Go TUI tests are headless model/client/package tests.
- No test in this report proves a real OpenRouter completion, a real OpenRouter tool call, or a real interactive TUI terminal session.

## Fixtures

- `tests/fixtures/agent-non-live.ts` provides sample grouped frontend/backend app data, Next/Vite/Astro package metadata, an existing `relaybase.app.json`, sample logs, setup plan samples, approval interruption samples, and redacted env content.
- Existing setup tests create temporary package.json projects, manifests, setup profiles, and proof artifacts under OS temp directories.
- Existing TUI tests use fake HTTP servers and headless Bubble Tea model updates.

## Automated Coverage Map

| Requirement area | Current automated evidence |
| --- | --- |
| OpenRouter config loading | `tests/openrouter-provider.test.ts`, `tests/agent-api.test.ts` |
| Missing key diagnostic | `tests/openrouter-provider.test.ts`, `tests/agent-runtime.test.ts`, `tests/agent-api.test.ts` |
| Invalid model diagnostic without network | `tests/openrouter-provider.test.ts` |
| Capability/tool-call diagnostic boundary | Missing-key smoke and provider construction tests cover non-live failure paths; live model capability proof is RA013. |
| Agent Gateway session lifecycle | `tests/agent-api.test.ts`, `tests/agent-runtime.test.ts`, `tests/agent-session-audit.test.ts` |
| Agent Gateway stream lifecycle and reconnect/final-state behavior | `tests/agent-api.test.ts`, `tests/agent-runtime.test.ts` |
| Approval lifecycle | `tests/agent-api.test.ts`, `tests/agent-runtime.test.ts`, `tests/agent-session-audit.test.ts` |
| App list/state/group tools | `tests/agent-tools.test.ts` |
| Lifecycle tools | `tests/agent-tools.test.ts`, `tests/agent-runtime.test.ts` |
| Log tools and export approval | `tests/agent-tools.test.ts` |
| Setup detect/plan/preview/apply tools | `tests/agent-tools.test.ts`, `tests/setup-api.test.ts`, `tests/setup.test.ts` |
| Manifest inspect/validate/patch tools | `tests/agent-tools.test.ts`, `tests/setup-api.test.ts`, `tests/agent-runtime.test.ts` |
| Open/prove/repair tools | `tests/setup-api.test.ts`, `tests/agent-session-audit.test.ts` |
| TUI proposed action tools | `tests/agent-tools.test.ts`, `tui/internal/tui/model/model_test.go` |
| Exact app target | `tests/agent-tools.test.ts` RA012 fixture test |
| Display name target | `tests/agent-tools.test.ts` RA012 fixture test |
| Group target | `tests/agent-tools.test.ts` RA012 fixture test |
| Frontend/backend role target | `tests/agent-tools.test.ts` RA012 fixture test |
| Current selected pane target | `tests/agent-tools.test.ts`, `tui/internal/tui/model/model_test.go` |
| Current cwd target | `tests/agent-tools.test.ts`, `tests/agent-runtime.test.ts`, `tui/internal/tui/model/model_test.go` |
| Manifest path target | `tests/agent-tools.test.ts`, `tests/setup-api.test.ts` |
| Ambiguous target handling | `tests/agent-tools.test.ts`, `tests/agent-runtime.test.ts`, `tests/setup-api.test.ts` |
| Unknown target handling | `tests/agent-tools.test.ts` RA012 fixture test |
| File-write approval required | `tests/agent-api.test.ts`, `tests/agent-runtime.test.ts`, `tui/internal/tui/model/model_test.go` |
| Manifest patch approval required | `tests/agent-runtime.test.ts`, `tests/setup-api.test.ts`, `tui/internal/tui/model/model_test.go` |
| Env edit approval and raw secret rejection | `tests/agent-tools.test.ts`, `tests/setup-api.test.ts` |
| Browser-open/clipboard unavailable diagnostics | `tests/agent-tools.test.ts`, `tui/internal/tui/model/model_test.go` |
| Approval resumes execution | `tests/agent-runtime.test.ts`, `tests/agent-session-audit.test.ts` |
| Rejection blocks execution | `tests/agent-runtime.test.ts`, `tui/internal/tui/model/model_test.go` |
| Changed tool args require new approval | `tests/agent-runtime.test.ts` |
| Add app/configure/register/dry-run flows | `tests/setup-api.test.ts`, `tests/setup.test.ts`, `tui/internal/tui/model/model_test.go` |
| Multiple setup choices and framework port strategies | `tests/setup-api.test.ts`, `tests/setup.test.ts` |
| Launch wrapper and pinned upstream port | `tests/setup-api.test.ts`, `tests/setup.test.ts` |
| Health route edit and repair ignores PORT | `tests/setup-api.test.ts`, `tests/agent-runtime.test.ts` |
| Prove health | `tests/setup-api.test.ts`, `tests/setup.test.ts` |
| Frontend/backend component-as-app setup | `tests/setup-api.test.ts`, `tests/agent-tools.test.ts` |
| Existing manifest inspect/repair/re-register | `tests/setup-api.test.ts`, `tests/agent-tools.test.ts` |
| Session persistence | `tests/agent-session-audit.test.ts` |
| Audit logging | `tests/agent-session-audit.test.ts` |
| Redaction | `tests/agent-session-audit.test.ts`, `tests/unit.test.ts`, `tests/agent-tools.test.ts` |
| Budget block | `tests/agent-session-audit.test.ts` |
| Path traversal and arbitrary command block | `tests/agent-runtime.test.ts`, `tests/setup-api.test.ts` |
| No direct process management in TUI | `tui/internal/tui/model/model_test.go`, `tui/internal/relaybaseclient/client_test.go` |
| No direct TUI file writes | `tui/internal/tui/model/model_test.go` |
| TUI stream event handling | `tui/internal/tui/model/model_test.go`, `tui/internal/relaybaseclient/client_test.go` |
| Approval/setup/file diff/repair rendering | `tui/internal/tui/model/model_test.go` |
| No-apps state | `tui/internal/tui/model/model_test.go` |
| Current cwd sent to daemon | `tui/internal/tui/model/model_test.go` |

## Behavior Fixed During RA012

Explicit unknown app targets in `resolveAppTarget` now return `AGENT_TARGET_NOT_FOUND` instead of falling back to the selected pane. The selected pane fallback still works when no explicit target is supplied. This keeps agent execution from silently acting on the selected app when a user or model supplied a misspelled target.

## Commands Run

| Command | Result |
| --- | --- |
| `codegraph-mcp agent-use status --repo . --json` | PASS, claimable true. Candidate spool/vector sidecar diagnostics were present but did not block direct source inspection. |
| `codegraph-mcp agent-use context-pack --repo . --task "RA012 automated tests Operator Agent setup onboarding non-live" --agent-json` | PASS, claimable true with fallback evidence only. |
| `node --experimental-strip-types --test tests\agent-tools.test.ts` | Initially FAIL on explicit unknown target falling back to selected pane; PASS after resolver fix. |
| `node --experimental-strip-types --test tests\agent-api.test.ts tests\agent-runtime.test.ts tests\agent-session-audit.test.ts tests\agent-tools.test.ts tests\openrouter-provider.test.ts` | PASS, 39/39 tests. |
| `node --experimental-strip-types --test tests\setup-api.test.ts tests\setup.test.ts` | PASS, 35/35 tests. |
| `node --experimental-strip-types --test tests\agent-session-audit.test.ts tests\unit.test.ts` | PASS, 58/58 tests. |
| `npm.cmd run format:check` | Initially FAIL on `tests/agent-tools.test.ts`; PASS after `npx.cmd prettier --write tests\agent-tools.test.ts`. |
| `npm.cmd run lint` | PASS. |
| `npm.cmd run typecheck` | PASS. |
| `npm.cmd test` | PASS, 165/165 tests. |
| `npm.cmd run test:jest` | PASS, 1 suite and 4 tests. |
| `npm.cmd run tui:test` | PASS, Go TUI packages tested. |
| `npm.cmd run tui:vet` | PASS. |

## Not Claimed

- No live OpenRouter request was made in RA012.
- No live OpenRouter tool-call compatibility result is claimed here.
- No real interactive TUI launch, screenshot, or terminal recording is claimed here.
- No destructive lifecycle/setup action bypassed approval in these tests.

## Acceptance Status

- Agent automated coverage: PASS.
- Setup/onboarding automated coverage: PASS.
- Safety gate automated coverage: PASS.
- Redaction and audit coverage: PASS.
- TUI model/client integration coverage: PASS.
- Live proof boundary: DEFERRED to RA013.
