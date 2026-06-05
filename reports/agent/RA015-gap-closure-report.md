# RA015 Gap Closure Report

Generated: 2026-06-03

## Scope

RA015 verifies the Operator Agent, TUI setup/onboarding surface, runtime matrix, and live OpenRouter path after RA013F/RA014. The original pasted RA015 text asked for `google/gemini-3.5-flash`; the user explicitly superseded that with `google/gemini-3.1-flash-lite`. This report therefore treats exact Gemini 3.1 Lite live proof as the active acceptance target and does not claim 3.5 coverage.

## Evidence

- `reports/agent/live-agent-test-report.md`: PASS with real daemon, real TUI smoke-render path, real OpenRouter, exact `google/gemini-3.1-flash-lite`, reasoning enabled.
- `artifacts/agent-live/openrouter-response-redacted.json`: PASS summary and artifact paths.
- `artifacts/agent-live/model-capability-check.json`: model completed, tool calls observed, reasoning requested.
- `artifacts/agent-live/secret-scan.txt`: PASS secret scan.
- `reports/agent/automated-test-report.md`: RA012 non-live automated coverage map.
- `docs/tui-setup-gap-map.md` and `reports/agent/RA000-gap-map.md`: current gap ownership.
- `docs/tui-setup-runtime-matrix.md`: runtime adapter matrix.
- `reports/agent/sdk-fork-decision.md`: no SDK fork required.

## Gap Closure Table

| Gap | Status | Evidence |
| --- | --- | --- |
| No-apps TUI state | filled | Live TUI smoke-render frames in `reports/agent/live-agent-test-report.md`; Go tests cover no-apps state. |
| Configure current folder | filled | Setup API/TUI/agent coverage in `tests/setup-api.test.ts`, `tests/setup.test.ts`, `tests/agent-tools.test.ts`; live JS/Go configure-from-folder flows passed. |
| Add app from explicit path and command | filled | Live JS setup used a temp explicit folder and `npm run dev`; automated setup tests cover explicit paths and commands. |
| Dry-run setup preview | filled | Setup preview/dry-run tests and live setup preview artifacts under `artifacts/agent-live/setup-preview-*.json`. |
| Multiple setup plan choices | filled | Runtime/setup tests cover multiple plan choices and framework strategies; live JS/Go setup generated plan/preview artifacts. |
| File-write confirmation | filled | Live file-write approval required before JS/Go setup apply; TUI smoke rendered setup approval frames. |
| Setup diff preview | filled | Live `file-write-preview.json`, generated manifest/profile artifacts, explicit wrapper-not-generated evidence for the selected plan, and automated setup diff/wrapper tests. |
| Existing manifest inspect/validate/repair/re-register | filled | Live Python FastAPI registered an existing manifest after approval; setup API tests cover inspect/validate/repair/register. |
| Ambiguous project setup | filled | Runtime matrix tests cover ambiguity questions; Docker Compose and Procfile ambiguity diagnostics are tested. |
| Safe env override | filled | Automated tests reject raw secret-like env values and require approved safe references. |
| Health route edit | filled | Setup API tests cover health route edits; live prove health passed for JS/Python/Go paths. |
| Pinned port edit | filled | Setup tests cover pinned upstream port plans and safe patch paths. |
| Ignored PORT repair | filled | Live repair fixture produced repair choices; automated tests cover ignored-PORT runtime repair candidates. |
| Framework wrapper choices | filled | Tests cover Next/Vite/Astro and generated wrapper choices. |
| Frontend/backend component-as-app setup | filled | Component-as-app metadata model is implemented and tested; native `components[]` remains deferred. |
| Group/pane metadata edit | filled | Live metadata step required a manifest patch approval for `groupId=live-demo`, `componentRole=frontend`; harness now accepts this daemon-equivalent approval without weakening gates. |
| List apps | filled | Agent tools and daemon API tests cover app state/list/group tools. |
| Start app | filled | Live JS/Python/Go start flows required approval and started through daemon lifecycle APIs. |
| Stop app | filled | Live Go stop required approval and verified stopped state. |
| Restart app | filled | Live Python restart required approval and verified PID change. |
| Export logs | filled | Live redacted zip log export passed; durable export tests cover log/jsonl/zip. |
| Prove health | filled | Live JS/Python/Go health proof passed through daemon tools. |
| Route display | filled | App state includes route; TUI and tests render route/status metadata. |
| TUI stream output | filled | Agent Gateway event stream and TUI model tests cover stream handling; live TUI smoke-render path passed. |
| TUI approval prompts | filled | Live setup/lifecycle approval frames rendered; Go TUI tests cover approval rendering. |
| Esc cancels / rejection blocks | filled | TUI/model tests and runtime tests verify rejection blocks execution; live smoke includes approval rejection safety in OpenRouter smoke. |
| No direct TUI file writes | filled | Go TUI tests assert daemon client calls; setup writes are daemon-owned. |
| No direct TUI lifecycle management | filled | Go TUI remains a daemon client; lifecycle actions route through daemon API/tools. |
| Runtime/language display | filled | RA012C TUI setup panel tests cover runtime candidates, command candidates, port strategies, and repair candidates. |
| Setup choices display | filled | TUI setup preview/rendering tests and live TUI smoke evidence. |
| File diff display | filled | TUI file-write preview rendering tests. |
| Copy route | deferred with diagnostic | Real clipboard write is not implemented; TUI/agent returns unavailable diagnostic or route text. |
| Browser open | deferred with diagnostic | Real browser open is not implemented; TUI/agent returns unavailable diagnostic. |
| Chat/session history persistence | filled for daemon, partial for TUI menu | Daemon state-dir sessions/audit/export are implemented and tested; TUI surface must use daemon session flow or honest diagnostic. |
| Chat export | filled for daemon, partial for TUI menu | RA009 redacted session export exists and is tested; TUI menu wiring remains diagnostic unless it calls daemon export. |
| Missing OpenRouter key | filled | Unit/smoke tests return `BLOCKED_OPENROUTER_KEY_MISSING` without fake output. |
| Invalid model | filled non-live | Provider tests validate bad model slug syntax/config. Live unavailable model is not forced. |
| Gemini 3.5 unavailable | superseded | User directed Gemini 3.1 Lite; no 3.5 claim is made. |
| Reasoning parameter rejected | filled for active path | Gemini 3.1 Lite live run passed with reasoning requested at medium effort. |
| Tool calling unsupported/failed | filled for active path | Live model capability artifact shows tool calls observed; unsupported tool behavior returns diagnostics. |
| Budget exceeded | filled | RA009 tests block before model call and audit the budget block. |
| Prompt injection approval bypass | filled | Live prompt injection slice did not start manifest/setup write tools without approval. |
| Path traversal | filled | Runtime/setup tests reject traversal through setup APIs and policy. |
| Arbitrary command attempt | filled | Policy/runtime tests block arbitrary command inputs; no arbitrary shell tool exists. |
| Secret in env/log/manifest | filled | Redaction tests and artifact secret scan passed. |
| Ambiguous destructive target | filled | Live "stop the backend" ambiguity produced clarification/diagnostic and no destructive approval. |
| Ambiguous setup target | filled | Runtime matrix ambiguity questions tested. |
| Daemon unavailable | filled | TUI/client diagnostics and smoke tests cover unavailable daemon. |
| Daemon restart while TUI open | partial | Event reconnect/state tests exist; live long-running restart-with-TUI scenario remains hardening coverage, not a P0 for active acceptance. |
| Event stream disconnect/reconnect | filled | Node event stream and TUI client tests cover disconnect/reconnect behavior. |
| OpenRouter timeout | filled non-live | Runtime timeout tests return diagnostics. |
| OpenRouter rate limit | partial | Provider/error normalization exists; a live rate-limit condition is not forced. |
| Approval pending across reconnect | filled non-live | Gateway/session approval tests cover persistence/final-state behavior; pending approval storage is still process-bound by design. |
| Session/audit durability | filled | RA009 tests verify state-dir session/audit files survive restart. |
| Redaction before prompt | filled | Prompt/session/audit tests and live artifact scan passed. |
| `reasoning_details` handling | partial | Reasoning request is live-proven; raw provider reasoning details are not required or exposed in current acceptance. |
| Native manifest `components[]` | deferred | Current grouping remains component-as-app metadata. |
| GoReleaser/checksum | release-track-only | Local GoReleaser is not required for Operator Agent readiness; release docs/scripts diagnose absence. |
| Platform-specific npm packages | release-track-only | Node bridge/package strategy remains honest; platform package publishing is release-track. |

## Result

No known P0/P1 Operator Agent or TUI setup/onboarding blocker remains for the active Gemini 3.1 Lite path. Remaining items are either intentionally diagnostic, deferred product scope, broad live-matrix expansion, or release-track packaging/tooling.
