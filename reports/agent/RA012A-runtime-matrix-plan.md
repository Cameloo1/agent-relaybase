# RA012A Runtime Matrix Upgrade Plan

Generated: 2026-06-03

## Summary

RA012A is a planning/design task for broadening Relaybase setup/onboarding beyond the current Node-oriented setup engine. No product behavior was changed.

The current setup engine has strong daemon-owned boundaries for detect, plan, preview, apply, register, prove, repair, file-write approval, manifest patching, redaction, and setup events. Its runtime detection model is still mostly shaped around `package.json`, JavaScript package managers, Node framework flags, static preview, MCP hints, and Docker Compose. RA012B should preserve the existing daemon setup boundary and introduce a runtime adapter registry that can detect and plan common server apps across JavaScript/TypeScript, Python, Go, Java/Kotlin, .NET, Ruby, PHP, Docker Compose, Rust, Elixir, Scala, Clojure, Dart, native/C/C++, and Procfile projects.

RA012B may proceed after this plan if it stays scoped to daemon setup engine types, detection, adapters, fixtures, tests, and docs. It must not move lifecycle logic into the TUI and must not add arbitrary shell execution.

## Evidence Inspected

- `AGENTS.md`
- `docs/relaybase-release-roadmap.md`
- `docs/tui-architecture.md`
- `docs/tui-agent-architecture.md`
- `docs/tui-setup-onboarding.md`
- `docs/tui-setup-port-strategies.md`
- `docs/tui-agent-tools.md`
- `docs/tui-setup-gap-map.md`
- `reports/agent/RA000-gap-map.md`
- `reports/agent/automated-test-report.md`
- `src/setup.ts`
- `src/setupEngine.ts`
- `src/setupApi.ts`
- `src/setupApiTypes.ts`
- `tests/setup.test.ts`
- `tests/setup-api.test.ts`

## Commands Run For Inspection

| Command | Result |
| --- | --- |
| `codegraph-mcp agent-use status --repo . --json` | PASS. `claimable:true`, graph DB ready/current, no stale candidate layers. |
| `codegraph-mcp agent-use context-pack --repo . --task "RA012A Runtime language setup matrix upgrade plan" --agent-json` | PASS. `claimable:true`, context-pack returned with bounded/compacted candidate evidence. |
| `rg --files src tests docs reports \| Select-String -Pattern "setup\|agent\|runtime\|port\|fixture\|gap\|onboarding"` | PASS. Located setup engine, setup API, setup docs, agent docs, gap maps, and tests. |
| `rg -n "^(export )?(type\|interface\|class\|function\|const) \|^async function\|export async function\|export function" src\setup.ts src\setupApi.ts src\setupApiTypes.ts src\setupEngine.ts` | PASS. Mapped setup exported types and key implementation seams. |
| `rg -n "detect\|framework\|port\|wrapper\|manifest\|repair\|prove\|Docker\|Procfile\|python\|go.mod\|Cargo\|pyproject\|compose\|health" src\setup.ts src\setupApi.ts tests\setup.test.ts tests\setup-api.test.ts` | PASS. Confirmed Node/Docker/static/MCP focus and existing test coverage. |

## Current Implementation Findings

Current useful primitives to preserve:

- `src/setup.ts` exports `detectProject`, `proposeSetupPlans`, `configureProject`, `openProject`, `healthProject`, and `classifyLaunchFailure`.
- `ProjectDetection` already captures root, package manager, scripts, framework, app kind, env files, port env keys, detected ports, existing manifest/setup artifacts, Docker Compose files, Docker metadata, MCP hints, monorepo hints, and health candidates.
- `SetupPlan` already carries id, label, architecture, score, reasons, risks, env strategy, manifest, write previews, recovery steps, and required input.
- `src/setupApi.ts` exposes read-only detect/plan/preview and confirmation-gated apply/register/open/prove/manifest patch flows.
- `src/setupApiTypes.ts` has `PortStrategy`, `SetupDetectResult`, `SetupPlanChoice`, file diff/preview types, apply results, manifest patch requests, prove requests, and repair plan results.
- Existing tests cover Node generic setup, Next/Vite/Astro wrappers, env redaction, Docker Compose profiles, ambiguous Docker service selection, confirmation gates, path safety, proof, and repair classifications.

Current limits:

- Runtime detection is mostly `package.json` and top-level file based.
- Package manager types are limited to npm/pnpm/yarn/bun/node/unknown.
- Framework types are limited to generic/next/vite/astro/node/docker_compose/unknown in the API layer.
- `startCommandFor` falls back to `node server.js`, which is not appropriate for non-Node projects.
- Framework wrapper generation currently writes a Node `.relaybase/launch.cjs` wrapper and cannot represent Python, Go, JVM, .NET, Ruby, PHP, Rust, Elixir, Scala, Clojure, Dart, native, or Procfile launch adapters.
- Repair logic identifies ignored ports and recommends known architectures, but runtime-specific repair candidates are not modeled.

## Root Cause

This is primarily a daemon setup engine design gap. The engine already has safe setup APIs and approval boundaries, but runtime knowledge is encoded as Node-specific helper functions instead of a runtime adapter matrix.

Classification:

- Product code gap: setup engine detection/planning breadth.
- Test coverage gap: no runtime fixture coverage for most non-Node languages.
- Documentation gap: port strategy docs describe current Node/Docker primitives but not a broad runtime matrix.
- Not a TUI lifecycle gap: the TUI boundary is correct and should remain unchanged.
- Not an OpenRouter gap: model provider work is unrelated to runtime detection breadth.

## Planned Architecture

RA012B should add a runtime adapter layer under the daemon setup engine. Exact filenames may change, but the expected boundary is:

- `RuntimeDetector`: detects runtime evidence from bounded file metadata and safe text snippets.
- `RuntimeAdapter`: turns a detection result into setup plan candidates and repair candidates.
- `StartCommandCandidate`: typed command arrays and previews; not raw shell strings for execution.
- `PortBindingStrategy`: env, explicit flags, runtime-specific env, generated wrapper, fixed upstream, Compose mapping, or manual.
- `HealthCandidate`: candidate health paths with confidence and reason.
- `SetupQuestion`: explicit user decision needed before plan/apply.
- `SetupConfidence`: high/medium/low/unsupported.
- `RepairCandidate`: runtime-specific repair preview, with approval requirement.
- `FixtureBuilder`: test fixture recipe per runtime.
- `RuntimeAdapterRegistry`: ordered detector/adapter registry.
- `RuntimeMatrixSnapshot`: serializable documentation/test snapshot.

The new adapter layer should feed the existing `SetupPlan`, `SetupPlanChoice`, `FileWritePreview`, `SetupApplyResult`, and manifest patch APIs instead of bypassing them.

## Runtime Coverage Target

The complete runtime matrix is documented in `docs/tui-setup-runtime-matrix.md`. It covers 16 runtime/process types:

1. JavaScript / TypeScript
2. Python
3. Go
4. Java
5. Kotlin / JVM
6. C# / .NET
7. Ruby
8. PHP
9. Docker Compose
10. Rust
11. Elixir
12. Scala
13. Clojure
14. Dart
15. generic native / C / C++
16. Procfile

## Prioritization

Tier 1 for RA012B:

- JavaScript / TypeScript
- Python
- Go
- Java / Kotlin JVM
- C# / .NET
- Ruby
- PHP
- Docker Compose

Tier 2 for follow-up after the registry is stable:

- Rust
- Elixir
- Scala
- Clojure
- Dart
- generic native / C / C++
- Procfile

RA012B should implement the registry and enough Tier 1 adapters to prove the abstraction. Tier 2 can be implemented in the same task only if tests remain complete and bounded.

## Future Implementation Tasks

1. Add setup runtime types.
   - Likely files: `src/setupRuntimeTypes.ts`, `src/setupApiTypes.ts`.
   - Acceptance: exported types compile and preserve existing API compatibility.

2. Add runtime adapter registry.
   - Likely files: `src/setupRuntimeRegistry.ts`, `src/setupRuntimeAdapters/*.ts`, `src/setup.ts`.
   - Acceptance: `detectProject` can return runtime detections without removing existing fields.

3. Split current Node detection into JavaScript/TypeScript adapter.
   - Likely files: `src/setupRuntimeAdapters/javascript.ts`, `src/setup.ts`, `tests/setup.test.ts`.
   - Acceptance: existing Node/Next/Vite/Astro tests still pass.

4. Add Tier 1 runtime adapters.
   - Likely files: `src/setupRuntimeAdapters/python.ts`, `go.ts`, `jvm.ts`, `dotnet.ts`, `ruby.ts`, `php.ts`, `dockerCompose.ts`.
   - Acceptance: each runtime has detection, command candidates, port strategies, health candidates, ambiguity questions, and unsupported diagnostics.

5. Add runtime-aware setup API output.
   - Likely files: `src/setupApiTypes.ts`, `src/setupApi.ts`.
   - Acceptance: setup detect/plans expose runtime id/confidence while current clients keep working.

6. Add runtime-specific repair candidates.
   - Likely files: `src/setup.ts`, `src/setupApi.ts`, adapter modules.
   - Acceptance: ignored-port repair can recommend runtime-specific flags/env/config/pinned-port options without applying changes.

7. Add fixture builders and tests.
   - Likely files: `tests/setup-runtime-matrix.test.ts`, `tests/fixtures/runtime-matrix/*`.
   - Acceptance: every targeted runtime has detection and plan fixture coverage, preview writes nothing, apply requires confirmation, secrets redact, path traversal rejects.

8. Add docs snapshot check.
   - Likely files: `tests/setup-runtime-matrix-docs.test.ts` or existing docs test location.
   - Acceptance: runtime matrix docs list every adapter id in the registry or explicitly mark it planned.

## Required RA012B Tests

- Detection fixture per runtime.
- Plan fixture per runtime.
- Preview writes nothing.
- Apply requires confirmation.
- Prove/repair behavior where feasible.
- Secret redaction for env/config snippets.
- Path traversal rejection.
- Ambiguous project questions.
- Runtime adapter registry ordering.
- Existing Node setup tests remain green.
- Existing Agent Gateway setup tool tests remain green.
- TUI tests still prove no direct process management or file writes.
- Docs snapshot for runtime matrix.

## Acceptance Criteria For RA012B

- At least 10 runtime/process types are implemented and tested.
- JavaScript/TypeScript, Python, Go, Java/Kotlin JVM, .NET, Ruby, PHP, and Docker Compose have Tier 1 coverage or explicit blockers.
- Current Node/Next/Vite/Astro/Docker behavior remains compatible.
- Setup API returns honest diagnostics when a runtime is ambiguous or unsupported.
- Setup preview remains read-only.
- Apply/file writes/manifest edits/env edits remain approval-gated.
- No arbitrary shell command tool is introduced.
- The TUI remains a daemon client only.
- Tests pass and do not touch real user state.

## RA012B Go/No-Go

RA012B may proceed.

Conditions:

- Keep product edits limited to the TypeScript daemon setup engine, setup API types, tests, fixtures, and docs.
- Preserve all current setup API confirmation/redaction behavior.
- Do not claim live OpenRouter or live TUI evidence as part of RA012B.
