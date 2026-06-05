# RA015 Runtime Matrix Report

Generated: 2026-06-03

## Scope

This report separates broad runtime adapter support from live proof. The full matrix is unit/integration tested with disposable fixtures. The full live OpenRouter/daemon/TUI/setup/lifecycle proof in RA015 covers JavaScript/TypeScript, Python FastAPI, and Go.

## Evidence

- Runtime adapter implementation: `src/setupRuntimeAdapters.ts`, `src/setupRuntimeTypes.ts`.
- Runtime matrix docs: `docs/tui-setup-runtime-matrix.md`.
- Unit/integration tests: `tests/setup-runtime-matrix.test.ts`, `tests/setup-api.test.ts`, `tests/setup.test.ts`, `tests/agent-tools.test.ts`.
- Live artifacts: `artifacts/agent-live/setup-plan-js.json`, `setup-plan-python.json`, `setup-plan-go.json`, matching previews, state snapshots, process verification, and prove results.

## Matrix

Legend:

- yes: implemented and covered at the stated level.
- partial: implemented through shared setup/lifecycle primitives but not fully live-proven for that runtime.
- no-live: not live tested in RA015.

| Runtime | Detection supported | Setup plan supported | Preview supported | Apply supported | Prove supported | Repair supported | Fixture exists | Live tested | Unit/integration tested | Unsupported diagnostics |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| JavaScript / TypeScript | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes |
| Python | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes |
| Go | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes |
| Rust | yes | yes | yes | partial | partial | yes | yes | no-live | yes | yes |
| Java | yes | yes | yes | partial | partial | yes | yes | no-live | yes | yes |
| Kotlin / JVM | yes | yes | yes | partial | partial | yes | yes | no-live | yes | yes |
| C# / .NET | yes | yes | yes | partial | partial | yes | yes | no-live | yes | yes |
| Ruby | yes | yes | yes | partial | partial | yes | yes | no-live | yes | yes |
| PHP | yes | yes | yes | partial | partial | yes | yes | no-live | yes | yes |
| Elixir | yes | yes | yes | partial | partial | yes | yes | no-live | yes | yes |
| Scala | yes | yes | yes | partial | partial | yes | yes | no-live | yes | yes |
| Clojure | yes | yes | yes | partial | partial | yes | yes | no-live | yes | yes |
| Dart | yes | yes | yes | partial | partial | yes | yes | no-live | yes | yes |
| generic native / C / C++ | yes | yes | yes | partial | partial | yes | yes | no-live | yes | yes |
| Docker Compose | yes | yes | yes | partial | partial | yes | yes | no-live | yes | yes |
| Procfile | yes | yes | yes | partial | partial | yes | yes | no-live | yes | yes |

## Live Runtime Proof

| Runtime | Live proof result |
| --- | --- |
| JavaScript / TypeScript | PASS. Temp JS project configured from folder, previewed writes, approved setup apply, started through daemon, proved health/logs, exported logs, then metadata was patched behind approval. |
| Python | PASS. Temp FastAPI project with existing manifest was approved, registered, started, health-checked, restarted, and left running long enough for verification. |
| Go | PASS. Temp Go server was configured from folder, previewed writes, approved setup apply, started through daemon, health-checked, and stopped with closed-state verification. |

## Non-Live Runtime Coverage

The remaining runtime rows are implemented as runtime adapters and exercised by disposable unit/integration fixtures. These tests verify detection, setup plan metadata, previews, runtime-specific questions, repair candidates, Docker Compose service ambiguity, Procfile process ambiguity, secret redaction, path traversal rejection, and approval gating. They do not prove that every language toolchain is installed locally or that every generated command launches on this Windows host.

## Diagnostics

Unsupported or ambiguous runtime states return setup questions or diagnostics instead of guessed commands. Examples covered by tests include:

- missing JavaScript web script
- ambiguous Python entrypoint
- multiple Go commands
- Java/Kotlin/.NET module or task ambiguity
- Docker Compose service and target-port ambiguity
- Procfile process ambiguity
- native executable/run-target ambiguity
- path traversal attempts
- secret-like env edits

## Result

The runtime adapter matrix is broad enough for Operator Agent setup planning and TUI display. Full live proof is currently Tier 1 for JS/TS, Python, and Go. Expanding live proof for JVM/.NET/Ruby/PHP/Docker and Tier 2 runtimes is recommended release-hardening work, not a current P0/P1 for the active Operator Agent path.
