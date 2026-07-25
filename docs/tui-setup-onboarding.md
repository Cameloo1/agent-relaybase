# TUI Setup And Onboarding

This document describes the current Relaybase TUI setup workflow for adding, registering, configuring, opening, proving, and repairing apps. The Node/TypeScript daemon exposes setup/onboarding APIs backed by the shared setup engine facade in `src/setupEngine.ts`; the Go TUI supplies commands, no-apps onboarding, preview/repair rendering, and confirmation surfaces without owning file writes or lifecycle.

## Current Source Primitives

Current implemented setup primitives:

- `relaybase configure`
- `relaybase configure --dry-run`
- `relaybase configure --profile <id>`
- `relaybase configure --repair`
- `relaybase register <folder|manifest>`
- `relaybase register <folder|manifest> --no-verify`
- `relaybase open`
- `relaybase health`
- `relaybase health --prove`
- `relaybase health --prove --yes`
- `src/setup.ts` project detection, setup plans, write previews, apply flow, verification, and proof bundle support
- `src/setupEngine.ts` daemon-facing facade over the existing CLI setup primitives
- `src/setupRuntimeTypes.ts` runtime adapter contract models
- `src/setupRuntimeAdapters.ts` daemon runtime adapter registry
- `src/api.ts` `POST /__hub/api/apps/register`
- `src/setupApi.ts` daemon setup/onboarding API routes
- `src/setupApiTypes.ts` exported setup/onboarding API types

Disposable fixtures cover runtime adapters for JavaScript/TypeScript, Python, Go, Java, Kotlin/JVM, C#/.NET, Ruby, PHP, Docker Compose, Rust, Elixir, Scala, Clojure, Dart, native/C/C++, and Procfile projects. These adapters expose runtime-aware detection, command candidates, port strategies, health candidates, setup questions, and repair candidates. Live launch/proof still depends on the host having the relevant runtime tools and the user approving setup/lifecycle actions.

Current TUI setup behavior:

- The TUI can preview setup plans and write diffs through `POST /__hub/api/setup/preview`.
- The TUI can apply setup plans through `POST /__hub/api/setup/apply` only after confirmation.
- The TUI can register manifests, inspect/validate manifests, preview/apply safe manifest patches, open projects, prove health, and request repair plans through daemon setup APIs.
- The TUI can render a no-apps onboarding state with commands for configuring the current directory, choosing a project path, registering a manifest, reading setup docs, or starting the daemon.
- The TUI can parse `/add`, `/configure`, `/register`, `/open`, `/prove`, `/health`, `/repair`, `/manifest`, `/port`, and `/component` setup commands.

The TUI still does not write files, run package managers, spawn app commands, probe ports, or manage lifecycle directly. Setup execution remains daemon-owned.

## Implemented Daemon Setup API

Implemented daemon-owned setup routes:

- `POST /__hub/api/setup/detect`
- `POST /__hub/api/setup/plans`
- `POST /__hub/api/setup/preview`
- `POST /__hub/api/setup/apply`
- `POST /__hub/api/setup/register-manifest`
- `POST /__hub/api/setup/register/preview`
- `POST /__hub/api/setup/register/apply`
- `POST /__hub/api/setup/register/repair/preview`
- `POST /__hub/api/setup/register/repair/apply`
- `POST /__hub/api/setup/register/verification/cancel`
- `POST /__hub/api/setup/inspect-manifest`
- `POST /__hub/api/setup/validate-manifest`
- `POST /__hub/api/setup/patch-manifest/preview`
- `POST /__hub/api/setup/patch-manifest/apply`
- `POST /__hub/api/setup/open`
- `POST /__hub/api/setup/prove`
- `POST /__hub/api/setup/repair`
- `GET /__hub/api/setup/operations/:operationId`

Read-only routes return detection, choices, previews, manifest diagnostics, registration verification intent, and repair previews without mutating the project. Apply, register, patch apply, open, and prove use existing daemon auth rules, and write/start/proof actions require explicit confirmation where they can mutate files or lifecycle state. Registration apply completes during the request, but its daemon-owned verification can be cancelled through the dedicated token-gated cancel route. `/setup/operations/:operationId` remains a normalized diagnostic route; bounded registration verification evidence is stored in the existing operation ledger.

Daemon setup routes emit safe setup events on the global event bus:

- `setup.detected`
- `setup.plan_created`
- `setup.preview_created`
- `setup.apply_started`
- `setup.apply_completed`
- `setup.apply_failed`
- `setup.registered`
- `setup.prove_started`
- `setup.prove_completed`
- `setup.repair_plan_created`
- `setup.repair_applied`

Event payloads contain safe summaries such as cwd, choice count, selected plan id, registered app id, proof status, and diagnostic counts. They do not include raw env values or setup file contents.

## Agent Gateway Setup Context

The daemon Agent Gateway receives bounded TUI context for setup/onboarding messages, exposes daemon-owned setup tools, and streams setup/approval events back to the Go TUI. `TuiAgentContext` includes:

- selected pane id
- selected app id
- selected group id
- selected component role
- current route
- current TUI page
- current cwd from TUI launch
- bounded project roots selected through parsed setup commands
- whether the daemon has zero apps
- current setup wizard state
- current setup plan id
- current diagnostics
- terminal clipboard/browser-open capability metadata

The Agent Gateway event contract represents setup-related event shapes that the TUI can render from the daemon session stream:

- `setup.plan_preview`
- `setup.file_write_approval_required`
- `setup.manifest_patch_approval_required`
- `setup.repair_choices`
- `setup.prove_result`

The daemon implements tools for project detection, setup planning, setup write preview, approved setup apply, manifest registration, manifest inspect/validate/patch, health route and pinned-port patches, component metadata patches, safe env override patches, composed setup/start, open/prove flows, and repair previews. Mutating tools return `approval_required` unless executed through an approved daemon path. The Go TUI renders model-selected setup previews, file-write/manifest approval prompts, repair choices, and prove results, then approves or rejects the pending daemon approval.

All path-bearing setup/manifest Agent tools are authorized only for a canonical trusted current directory or a canonical root selected through parsed `/add`, `/configure`, or folder `/register` input. Arbitrary model text cannot create a root grant. `apply_setup_plan` and the composed `setup_and_start_project` `apply_setup` phase are bound to the exact generated preview; preview drift fails closed before mutation and requires a fresh review. Manifest registration and safe manifest/env edits also bind their canonical target and file-content revision before approval.

## User Workflow

Example natural-language flow:

```text
TUI > /add C:\path\to\ratemygithub
TUI > approve setup
TUI > approve start
TUI > launch ratemygithub
```

When the start command is already known, the user may provide it as a setup hint:

```text
TUI > /add C:\path\to\ratemygithub using npm run dev
TUI > launch ratemygithub
```

Runtime-aware examples:

```text
TUI > configure this folder
TUI > start this folder
TUI > add this Python FastAPI app
TUI > add this Django app
TUI > add this Go server
TUI > add this Rust app
TUI > add this Spring Boot app
TUI > add this .NET app
TUI > add this Rails app
TUI > add this Laravel app
TUI > add this Phoenix app
TUI > add this Docker Compose service
TUI > repair this app because it ignores PORT
TUI > use fixed port 3000
TUI > make this app a frontend component
```

The current daemon/TUI behavior is:

1. TUI captures the path and command intent.
2. Daemon setup APIs or Agent Gateway tools run project detection and return runtime matrix metadata.
3. Daemon returns setup plan choices with runtime/language/framework confidence, command candidates, port strategy candidates, setup questions, repair candidates, and diagnostics.
4. TUI shows manifest, wrapper, setup-profile, env write previews, runtime-specific command/port context, and ambiguity questions.
5. User approves or cancels.
6. Daemon applies approved writes and registers the manifest.
7. For normal registration, daemon performs one approved start, health, stop, and closure proof; `--no-verify` skips this lifecycle work.
8. TUI reports verified, unverified, repairable failure, cancellation, or cleanup failure. Successful proof ends stopped.
9. User launches through a separate daemon lifecycle operation.

## Implemented Slash Commands

Implemented TUI setup commands:

```text
/add <path>
/add <path> using <command>
/add app <path> using <command>
/register <manifest-or-project-path>
/register <manifest-or-project-path> --no-verify
/configure
/configure cwd
/configure current folder
/configure .
/configure <path>
/configure <path> --dry-run
/open <path-or-app>
/health <app> --prove
/prove <app>
/repair <app-or-path>
/manifest inspect <app-or-path>
/manifest edit <field> <value>
/health route <app> <route>
/port pinned <app> <port>
/component role <app> <role>
/component group <app> <groupId>
/component label <app> <label>
```

These commands call daemon setup/onboarding APIs. They must not write files, spawn app processes, probe health, or stop processes directly from the TUI. `/register` always uses the deterministic daemon registration coordinator and shows whether confirmation will briefly start and stop the app. `/cancel` requests cancellation when a registration proof is active. The compatibility alias `/add app <path> using <command>` remains accepted temporarily for older instructions.

## Configure Current Folder

The TUI has current-directory context when the Node bridge passes `--current-directory` or `RELAYBASE_TUI_CURRENT_DIRECTORY`, or when the direct binary can read its launch working directory. If no trusted current-directory context exists, `/configure current folder` asks for a path instead of guessing.

## No-Apps State

When the daemon has no registered apps, the TUI offers:

- configure current project when trusted current-directory context exists
- register manifest
- read setup docs
- start daemon if missing
- choose a project path

If the daemon is unavailable, the TUI may show how to start `relaybase serve`, but it must not silently start unknown user apps.

Registered stopped apps are not treated as an empty daemon. When no active panes are open but registered apps exist, the TUI shows a separate sorted inventory with status and a confirmation-gated start action for the selected app.

## Setup Plan Choices

The daemon setup API returns setup candidates with:

- plan id
- label
- architecture
- score
- reasons
- risks
- required inputs
- recovery steps
- files that would be created, updated, skipped, or left unchanged
- runtime id and confidence
- runtime command candidates
- runtime port strategy candidates
- runtime health candidates
- setup questions
- runtime repair candidates

The TUI separates dry-run preview from apply. `/configure <path> --dry-run`, `/repair <app-or-path>`, and `/manifest inspect <app-or-path>` are read-only. `/configure <path>`, `/add <path>`, `/add <path> using <command>`, `/register`, `/open`, `/prove`, `/health --prove`, and manifest patch commands require confirmation or daemon approval before the daemon mutates files, registration state, proof artifacts, or lifecycle state. Registration confirmation shows the expected maximum duration, health candidates, and the guarantee that successful proof ends stopped.

Runtime-specific setup choices now come through the daemon setup engine, not the TUI. The TUI should continue to render daemon-produced plan choices, setup questions, diffs, and diagnostics without detecting runtimes or writing files locally.

## Repair Flows

When an app ignores `PORT`, has a wrong health route, has stale manifest fields, or fails proof, the TUI should offer daemon-produced repair choices:

- retry with framework wrapper
- retry with pinned upstream port
- repair manifest
- change health route
- re-register manifest
- prove route and stop behavior again

The daemon returns no more than three ordered, preview-only repairs. `register/repair/preview` binds the selected repair to the current manifest revision. Confirmed `register/repair/apply` writes the exact patch, re-registers, and runs one new quick proof. Drift performs zero repair writes and zero starts. Cleanup failure disables further repair/launch retries until the remaining process or port is resolved.

## Safe Manifest Fields

Implemented setup manifest patch APIs may prepare approved edits for:

- `id`
- `name`
- `command`
- `cwd`
- `protocol`
- `healthUrl`
- `upstreamPort`
- `env` with secret-safe handling
- `relaybase.groupId`
- `relaybase.componentRole`
- `relaybase.displayName`
- `relaybase.paneLabel`
- `relaybase.paneOrder`

Native `components[]` is a future migration. Current frontend/backend setup means component-as-app metadata unless implementation adds native components in a later roadmap. TUI component commands edit safe `relaybase.*` manifest metadata through the daemon manifest patch API when the target app exposes a manifest path in daemon state.

## Frontend And Backend Groups

The TUI guides users through creating or editing component-as-app metadata so separate frontend and backend manifests appear under one group:

- frontend component app with `relaybase.componentRole: "frontend"`
- backend component app with `relaybase.componentRole: "backend"`
- shared `relaybase.groupId`
- pane labels and pane order

Each component remains one daemon-owned app process. The TUI should not combine multiple commands into a TUI-managed process group.

## Proof

`/prove <app>` and `/health <app> --prove` should show:

- backend port opened
- Relaybase route works
- logs are captured
- stop closes a daemon-owned port when applicable
- proof artifact path when the daemon writes one
- failure owner and next actions

Lifecycle proof requires explicit approval because it can start and stop apps.
