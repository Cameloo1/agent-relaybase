# AGENT-FOLDER-START-000 Baseline

## Executive Summary

This baseline establishes the current path from TUI natural-language input to daemon-owned setup/start behavior. No product code was changed.

Current Relaybase has the core primitives needed for folder onboarding and startup:

- The Go TUI can parse slash setup commands and send setup/lifecycle requests to daemon APIs.
- The daemon exposes setup detect, plan, preview, apply, register, open, prove, and repair routes.
- The daemon owns process lifecycle through the registry and `ProcessManager`.
- The Agent Gateway exposes typed setup/lifecycle tools and approval events.
- Tests for the local TUI, Agent Gateway, setup, lifecycle, logs, approvals, sessions, and redaction pass.

The main current gap is orchestration and routing for natural folder startup phrases. Some phrases route to deterministic lifecycle handling before the Operator Agent can interpret them as folder setup. Other phrases can reach the Agent Gateway only when the remote Operator Agent is enabled. The setup apply path also does not currently preserve every user command hint from preview to apply.

## CodeGraph Status

Command:

```powershell
codegraph-mcp agent-use status --repo . --json
```

Result:

- Exit code: 0.
- `claimable: true`.
- `graph_freshness: current`.
- `candidate_only_available: false`.
- Candidate/vector sidecars are stale, but the production agent-use DB is claimable.
- The report uses direct source inspection and tests as baseline evidence, not stale candidate sidecar evidence.

Command:

```powershell
codegraph-mcp agent-use context-pack --repo . --task "AGENT-FOLDER-START-000" --agent-json
```

Result:

- Exit code: 0.
- `claimable: true`.
- Context pack returned fallback text evidence with no graph proof path for the task seed.
- This is acceptable for this planning/report task; product-code edits are not part of AGENT-FOLDER-START-000.

## Evidence Inspected

TUI input, slash, setup, client, and model surfaces:

- `tui/internal/tui/assistant/assistant.go`
- `tui/internal/tui/slash/slash.go`
- `tui/internal/tui/model/model.go`
- `tui/internal/relaybaseclient/client.go`
- `tui/internal/relaybaseclient/types.go`

Daemon Agent Gateway and setup surfaces:

- `src/agent/tools/*.ts`
- `src/agent/runtime.ts`
- `src/agent/prompts.ts`
- `src/setup.ts`
- `src/setupApi.ts`
- `src/setupRuntimeAdapters.ts`
- `src/processManager.ts`

Documentation surfaces:

- `docs/tui-setup-onboarding.md`
- `docs/tui-setup-port-strategies.md`
- `docs/tui-agent-tools.md`

## Commands Run

```powershell
codegraph-mcp agent-use status --repo . --json
```

Result: passed; CodeGraph is claimable.

```powershell
codegraph-mcp agent-use context-pack --repo . --task "AGENT-FOLDER-START-000" --agent-json
```

Result: passed; context pack returned diagnostic/fallback evidence and remained claimable.

```powershell
npm.cmd run tui:test
```

Result: passed.

```text
> @cameloo/relaybase@0.1.0 tui:test
> node scripts/tui-go.mjs test

PASS
PASS
PASS
PASS
PASS
PASS
PASS
ok   github.com/cameloo/relaybase/tui/internal/tui/setupwizard (cached)
PASS
PASS
PASS
```

```powershell
npm.cmd run agent:test
```

Result: passed; 61 tests passed.

```powershell
npm.cmd test
```

Result: passed; 221 tests passed.

```powershell
git status --short
```

Initial result: dirty worktree existed before this task. This task intentionally adds only this report.

## Current-State Map

### Natural Input Routing

Source: `tui/internal/tui/assistant/assistant.go` and `tui/internal/tui/model/model.go`.

Current behavior:

- `assistant.ParseInput` trims input and first tries slash parsing when the input starts with `/`.
- Known local natural phrases are parsed deterministically into local command intents.
- `what is broken`, `show diagnostics`, help, daemon status/repair, page navigation, pin/unpin, color, logs, export logs, and lifecycle verbs are handled locally.
- Lifecycle words `launch`, `start`, `run`, `stop`, `restart`, `reboot`, `reload`, and typo `restrt` become slash-style lifecycle commands.
- If natural input cannot be parsed and the Agent Gateway is enabled, `RootModel.submitAssistantInput` sends the raw input to the daemon Agent Gateway.
- If natural input can be parsed as a deterministic command, it does not fall through to the Agent Gateway even if it contains a folder path.

Implication:

- `go start the server in <path>` is not a deterministic command today, so it can reach the Agent Gateway only when the agent is enabled.
- `start the server in <path>` is parsed as a deterministic lifecycle command targeting `server in <path>`, so it does not reach the Agent Gateway. It then fails target resolution unless an app actually matches that target.
- `start this folder` is parsed as a deterministic lifecycle command targeting `folder`, so it does not become setup/open.

### Slash Command Routing

Source: `tui/internal/tui/slash/slash.go` and `tui/internal/tui/model/model.go`.

Current behavior:

- `/add app <path> using <command>` parses into `KindAddApp` with `Path` and `Command`.
- `/configure`, `/configure cwd`, `/configure current folder`, and `/configure <path> --dry-run` parse into `KindConfigure`.
- `/register`, `/open`, `/prove`, `/health --prove`, `/repair`, `/manifest`, `/health route`, `/port pinned`, and `/component` commands exist.
- `slash.RequiresConfirmation` gates setup mutation commands, lifecycle operations, log export, daemon repair, and manifest edits.
- Confirmed setup slash commands route through daemon setup APIs via `setupCmdForCommand`.

Implication:

- The slash path is the most reliable existing path for explicit setup.
- `/configure <path> --dry-run` is read-only.
- `/configure <path>` and `/add app <path> using <command>` require TUI confirmation before daemon setup apply.
- Slash setup commands still do not automatically start the app after setup apply except through `/open` or a separate lifecycle command.

### Agent Gateway Routing

Source: `tui/internal/tui/model/model.go`, `src/agent/runtime.ts`, `src/agent/prompts.ts`, and `src/agent/tools/*.ts`.

Current behavior:

- The TUI sends natural input to Agent Gateway only when `m.agentConfig != nil && m.agentConfig.Enabled`.
- If no active agent session exists, the TUI creates one and then sends the pending input.
- `TuiAgentContext` includes selected pane/app/group/role, current route, current page, current TUI launch cwd, no-apps state, setup wizard state, current setup plan id, diagnostics, and terminal capability diagnostics.
- The Operator Agent prompt instructs the model to call `detect_project`, then `plan_app_setup`, then `preview_setup_writes` before setup apply/registration.
- Mutating tools are approval-gated and the default SDK tool execution context uses `approved:false`.

Implication:

- Natural folder setup through the Agent Gateway depends on the daemon agent being enabled and correctly configured.
- This task did not run live OpenRouter proof. Local/non-live Agent Gateway tests passed.
- Deterministic local parsing can prevent some folder-like phrases from ever reaching Agent Gateway.

### Setup Detect, Plan, Preview, Apply

Source: `src/setupApi.ts` and `src/setup.ts`.

Current behavior:

- `POST /__hub/api/setup/detect` resolves a project directory and returns runtime detection.
- `POST /__hub/api/setup/plans` calls `setupContext`, detects the project, proposes plans, and returns choices.
- `POST /__hub/api/setup/preview` returns setup file write previews and diffs without writing.
- `POST /__hub/api/setup/apply` requires token and confirmation, then calls `applySetup`.
- `applySetup` calls `configureProject` with `noStart: true`, so setup apply writes approved files and registers a manifest but does not start the app.
- `configureProject` can generate setup artifacts, register the manifest, and optionally verify/start when not forced to `noStart`; the daemon setup API currently forces `noStart: true` for apply.

Implication:

- Setup apply is intentionally file/registry work only through the daemon API.
- App start after setup requires a separate daemon lifecycle/open/prove step.
- A one-shot natural flow must orchestrate preview, approval, apply/register, then approval-gated start/open through daemon APIs.

### Command Hint Propagation

Sources:

- `tui/internal/tui/model/model.go`
- `src/agent/tools/planAppSetup.ts`
- `src/agent/tools/previewSetupWrites.ts`
- `src/agent/tools/applySetupPlan.ts`
- `src/setupApi.ts`
- `src/setup.ts`

Current behavior:

- The Agent tools accept `commandHint` and some also accept `command`.
- `preview_setup_writes` explicitly forwards `commandHint: input.commandHint ?? input.command`.
- `/add app <path> using <command>` puts the command into `SetupPlanRequest.ComponentMetadata.Command`.
- `setupContext` applies component metadata to preview plans, so preview can reflect component command metadata.
- `setupContext` currently calls `proposeSetupPlans(detection, { envStrategy, mcpInstall, docker })`; it does not pass `commandHint` or `portStrategyHint` into the setup engine.
- `applySetup` validates the request context only when `selectedPlanId` or `profile` is present, then calls `configureProject` without forwarding `commandHint`, `componentMetadata`, `components`, or `portStrategyHint`.
- `configureProject` recomputes detection/plans and selects by profile/plan id or saved answers.

Current blocker:

- The exact user command from `/add app <path> using npm run dev` or an Agent tool `commandHint` is not guaranteed to survive from preview to apply.
- Preview and apply can diverge when the user-supplied command is not also the setup engine's detected default command.
- For JS projects with a `dev` script, this may appear to work because detection already chooses `npm run dev`. For nonstandard commands, the gap is real.

### Manifest Registration

Source: `src/setupApi.ts`, `src/setup.ts`, `src/api.ts`, and TUI client setup methods.

Current behavior:

- `registerManifest` reads and normalizes a manifest path, then upserts into daemon registry and publishes `app.registered`.
- Setup apply can register a generated manifest as part of `configureProject`.
- `/register <manifest-path>` is confirmation-gated in the TUI.
- Agent `register_manifest` is approval-gated.

Implication:

- Existing manifests can be registered safely through daemon APIs.
- Fast start requires the relevant daemon state directory to already contain the registered app, or the flow must register first.

### App Start Lifecycle

Source: `src/processManager.ts`, `src/api.ts`, `tui/internal/relaybaseclient/client.go`, and Agent lifecycle tools.

Current behavior:

- TUI lifecycle commands call `RequestLifecycle` on daemon app endpoints.
- Agent lifecycle tools call daemon lifecycle operation enqueueing.
- `ProcessManager.start` looks up the app from the registry, assigns a port, injects `PORT`, `HOST`, and Relaybase env, spawns the manifest command in the app cwd, waits for health, records logs, and returns runtime view.
- Pinned `upstreamPort` is respected when configured; otherwise the daemon assigns an available managed port.

Implication:

- Relaybase already has daemon-owned app start.
- The TUI does not own lifecycle, which is correct.
- Folder startup needs to become "setup/register then lifecycle start" through daemon-owned APIs, not direct TUI spawning.

### Approval Rendering And Resume

Source: `tui/internal/tui/model/model.go`, `src/agent/tools/common.ts`, and Agent Gateway tests.

Current behavior:

- TUI deterministic/slash approvals use `pendingConfirm`.
- TUI Agent approvals use `pendingAgentApproval`.
- Enter approves and Esc rejects pending Operator Agent approvals.
- Recovered Operator Agent approvals require explicit reconfirmation.
- Mutating Agent tools return `approval_required` when not approved.
- Tests cover approval interruption, rejection, argument binding, duplicate/unknown approvals, and redaction.

Implication:

- The approval boundary exists and is tested.
- A one-shot folder startup flow must surface separate previews and approvals, or a single composite daemon approval whose exact steps are explicit and bound.

### Port Strategy And Repair

Source: `src/setup.ts`, `src/setupRuntimeAdapters.ts`, `src/processManager.ts`, and docs.

Current behavior:

- Setup plans include managed dynamic port, framework port flag wrapper, pinned upstream port, Docker Compose, static preview, MCP-only, and runtime matrix metadata.
- `ProcessManager` assigns unique managed ports and injects `PORT`/`HOST`.
- Runtime adapters expose env/flag/runtime-specific/pinned port strategies.
- `repairSetup` returns choices and previews only.
- Applying repair writes goes back through approved setup apply/manifest patch paths.

Implication:

- The daemon has the right port and repair primitives.
- Natural-language folder startup should report selected port strategy and repair choices from daemon output instead of guessing.

## Specific Phrase Blockers

| Phrase | Current route | Current blocker | Classification | Likely owner |
| --- | --- | --- | --- | --- |
| `go start the server in <path>` | If agent disabled: unsupported local command. If agent enabled: parse fails locally and falls through to Agent Gateway. | No deterministic setup-start grammar. Live behavior depends on enabled/configured Operator Agent and model/tool-call success. Path normalization must remove prompt artifacts such as trailing `>`. | TUI routing, Agent Gateway config/live model, setup orchestration | AGENT-FOLDER-START-001 and later |
| `start the server in <path>` | Deterministic local lifecycle command: `KindLaunch` target `server in <path>`. | Does not reach Agent Gateway because parsing succeeds. Lifecycle target resolver expects an app/group/role, not a folder phrase. | TUI routing / resolver | AGENT-FOLDER-START-001 |
| `add <path> using npm run dev` | Natural parser does not support this syntax. If agent enabled, parse fails and can fall through to Agent Gateway. | Slash equivalent is `/add app <path> using npm run dev`. Natural equivalent is not first-class deterministic. Agent path depends on remote model and commandHint handling. | TUI routing / Agent Gateway / setup command hint | AGENT-FOLDER-START-001 and AGENT-FOLDER-START-002 |
| `/add app <path> using npm run dev` | Slash command to setup preview/apply through daemon. | Confirmation-gated path exists, but exact command is stored as component metadata for preview and is not guaranteed to survive `applySetup -> configureProject`. | Setup API command propagation | AGENT-FOLDER-START-002 |
| `configure this folder` | Local parser does not support it. If agent enabled, parse fails and can fall through to Agent Gateway. | Slash equivalent `/configure current folder` exists but requires current-directory context. Natural version relies on remote Agent Gateway. | TUI routing / Agent Gateway config | AGENT-FOLDER-START-001 |
| `/configure current folder` | Slash command to setup preview/apply through daemon. | Works only when trusted current-directory context is available from the TUI launch bridge or direct binary. Applies setup/register but does not start. | Environment/context / setup orchestration | AGENT-FOLDER-START-003 |
| `start this folder` | Deterministic local lifecycle command: `KindLaunch` target `folder`. | Does not reach Agent Gateway. Target resolver treats `folder` as app/group/role and fails. | TUI routing / resolver | AGENT-FOLDER-START-001 |
| Existing registered app fast start: `start <app>` | Deterministic lifecycle command with confirmation. | Works when daemon state is available and target resolves exactly. It does not accept a project path. Ambiguous/unknown target correctly does not guess. | Working for app targets; not a folder startup path | AGENT-FOLDER-START-003 can reuse this after setup/register |

## Current Blocker Classification

| ID | Blocker | Classification | Evidence | Severity For Folder Startup |
| --- | --- | --- | --- | --- |
| AFS-000-B1 | Natural folder phrases are not consistently routed to setup/open/agent. | TUI routing | `assistant.ParseInput` maps `start`/`run` to lifecycle before Agent Gateway fallback. | P1 |
| AFS-000-B2 | Some folder-like phrases are treated as lifecycle targets and fail target resolution. | Resolver / UX | `start the server in <path>` and `start this folder` become `KindLaunch`. | P1 |
| AFS-000-B3 | Exact command hint may not survive preview to apply. | Setup API / product code | `setupContext` does not pass `commandHint`; `applySetup` calls `configureProject` without command metadata/hints. | P1 |
| AFS-000-B4 | Setup apply does not start apps. | Product design / orchestration | `applySetup` calls `configureProject` with `noStart: true`. This is safe but incomplete for one-shot startup. | P1 |
| AFS-000-B5 | Agent Gateway natural setup requires daemon config and live provider. | Environment/config/model | TUI only submits to Agent Gateway when `agentConfig.Enabled` is true. | P1 for natural-language agent path |
| AFS-000-B6 | Relative paths such as `development\...` depend on TUI/daemon current-directory context. | Context / UX | `cwdForSetupTarget` returns path-like strings as-is; setup API resolves from daemon process cwd. | P2 |
| AFS-000-B7 | Existing registered app fast start works only for exact app/group/role targets, not paths. | Expected current behavior | Lifecycle target resolution is app-state based. | P2 |
| AFS-000-B8 | Repair flow is preview-only until approved apply/patch. | Intentional safety gate | `repairSetup` returns choices/previews; writes route through approved apply/patch. | Not a defect |

## What Is Working And Should Not Be Disturbed

- Daemon-owned lifecycle, including process spawn, port assignment, health wait, log capture, stop/restart, and conflict diagnostics.
- Daemon setup routes with token/confirmation gates for apply/register/open/prove/manifest patch.
- TUI slash setup commands and local confirmation gates.
- Agent Gateway session creation, message sending, event streaming, approvals, rejection, resume, sessions, audit, and redaction in local tests.
- Setup runtime matrix coverage in non-live tests.
- TUI does not write setup files or own lifecycle.
- Mutating Agent tools are approval-gated and do not execute early in tests.

## Recommended Next Fix Order

1. Fix TUI natural-language routing so folder/path startup phrases become setup/open intents or pass to Agent Gateway before lifecycle target resolution.
2. Fix command hint and command metadata propagation so preview and apply use the same approved command.
3. Add daemon-owned setup/register/start orchestration for folder startup, with explicit preview and approval boundaries.
4. Polish TUI approval rendering for the setup/register/start sequence.
5. Add exhaustive temp-fixture tests for folder startup edge cases.
6. Run live OpenRouter/TUI/daemon folder startup only after local deterministic and setup API gaps are fixed.

## Acceptance State

- Report exists: yes.
- Every current blocker is classified: yes.
- No product behavior changed: yes; only this report was added.
- Required tests passed: yes.
- Live OpenRouter proof was not run in this baseline task and is not claimed.
