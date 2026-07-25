# Registration Verification And Repair Plan

Status: implementation plan. This document describes intended behavior that is not release-claimable until the acceptance gates below pass.

## Purpose

Make `/register <project-folder>` produce a trustworthy, start-ready Relaybase registration with one fast, bounded launch proof. When proof fails, Relaybase should explain the observed boundary and offer a small ordered set of deterministic repair previews. Asking the user to supply a raw command is the final fallback, not the normal path.

The normal experience should be:

```text
/register <folder>
  -> inspect or create relaybase.app.json
  -> show exact setup and verification preview
  -> confirm
  -> write and register
  -> start once on a Relaybase-managed test port
  -> probe health once ready
  -> stop immediately
  -> verify backend-port closure
  -> report ready to start
```

Registration verification must remain local, deterministic, quick, inspectable, cancellable, and independent of Operator Agent or a remote model.

## Current Verified Primitives

Direct source inspection at repository HEAD `62240056187c28ab6bcbe2a453f24941060dac05` found these existing components:

- folder-form registration preview and approval-bound apply in `src/setupApi.ts`
- runtime detection and setup-plan selection in `src/setup.ts`
- deterministic runtime adapters and repair candidates in `src/setupRuntimeAdapters.ts`
- structured launch compilation in `src/launchPlan.ts`
- daemon-owned process start, health wait, cleanup, stop, and port closure checks in `src/processManager.ts`
- bounded HTTP/TCP health probes in `src/health.ts`
- TUI registration preview/apply routing in `tui/internal/tui/model/model.go`
- normalized setup and registration result types in `src/setupApiTypes.ts`

CodeGraph was not claimable during this planning pass because its passport expected the current HEAD while its stored graph observed an earlier HEAD. This does not block a planning document, but a fresh claimable graph is Gate 0 before product-code implementation.

## Product Decisions

### Verification is explicit in the registration preview

Folder registration may include a one-time lifecycle proof, but the preview must say that confirmation will briefly start and stop the app. The UI must not hide process execution inside wording that sounds registry-only.

Recommended default:

- folder-form `/register <folder>`: verification enabled
- exact-file `/register <manifest>`: verification enabled unless `--no-verify` is explicitly selected
- automation/API callers: explicit `verificationMode: "quick" | "none"`; no ambiguous default
- re-registering an unchanged app: reuse current proof only when the manifest revision, compiled launch plan, adapter version, Relaybase version, and proof policy match; otherwise offer a fresh quick proof

### One attempt means one lifecycle attempt

The default path performs exactly one start, one bounded readiness wait, one successful health request or terminal failure, one stop, and one closure verification. It must not silently cycle through repair plans.

### Repairs are previews, not automatic mutations

Relaybase may run bounded read-only diagnosis after a failed proof, but every manifest or generated-file repair requires a new preview and approval. A repair retry is a new visible lifecycle attempt.

### Registration and normal running remain separate

Successful verification ends with the app stopped. The user receives a separate `Start <app-id>` action. Registration proof must not leave a background app running.

## Backend Architecture

Introduce a daemon-owned `RegistrationVerificationService` that composes existing primitives rather than duplicating process logic.

```text
Registration apply
  -> registry confirms app
  -> RegistrationVerificationService
       -> preflight
       -> ProcessManager.start(appId, verification policy)
       -> health result
       -> ProcessManager.stop(appId, verification policy)
       -> stop/port-closure result
       -> failure classifier
       -> repair planner
  -> RegistrationSetupResult
```

The service must not spawn directly, kill directly, probe through ad hoc code, or write setup files. Process ownership stays in `ProcessManager`; health semantics stay in `health.ts`; setup writes stay in the existing approval-bound setup path.

## Verification Contract

Add a typed policy:

```ts
interface RegistrationVerificationPolicy {
  mode: "quick" | "none";
  startupBudgetMs: number;
  probeTimeoutMs: number;
  stopBudgetMs: number;
  closureBudgetMs: number;
  candidateHealthProbeLimit: number;
}
```

Recommended defaults:

```text
startupBudgetMs: 8000
probeTimeoutMs: 1000
stopBudgetMs: 5000
closureBudgetMs: 3000
candidateHealthProbeLimit: 3
```

Manifest timeouts may raise the startup budget only when explicitly declared. Registration verification must enforce a hard upper bound of 30 seconds for ordinary processes. Docker and other known slow adapters may propose an extended proof as a separate choice instead of silently making registration slow.

### Preflight

Before starting:

1. Re-read and validate the registered manifest.
2. Compile the exact launch plan.
3. Confirm the executable or launch primitive is resolvable when it can be checked without mutation.
4. Confirm the canonical cwd exists.
5. Confirm fixed ports are bindable or correctly classified as external.
6. Reserve one Relaybase-managed port for dynamic plans.
7. Record adapter ID/version, manifest revision, launch-plan digest, and verification policy.

Preflight failure performs no process start.

### Start and readiness

Use the existing process manager start path with an abort signal and verification metadata. Success requires:

- process remains alive
- assigned port is known
- declared HTTP health route returns 2xx, or TCP port opens when no health route exists
- no lifecycle conflict is active

The existing `waitForHealthy` loop may poll during the startup budget; the product-level proof is still one bounded lifecycle attempt. Stop probing as soon as the first declared health success occurs.

### Bounded health-route diagnosis

If the backend port is open but the declared route fails, Relaybase may probe up to three adapter-supplied candidate routes such as `/api/ping`, `/health`, and `/`. This diagnosis is read-only and occurs against the already-started verification process.

Rules:

- GET only
- localhost only
- no redirects to non-local hosts
- one request per candidate
- one-second per-request ceiling
- stop at first 2xx
- never rewrite the manifest automatically
- return the successful candidate as a repair preview

### Stop and closure

After either health success or terminal startup failure:

1. Request stop through `ProcessManager`.
2. Run declared stop and verify-stopped hooks through existing lifecycle logic.
3. Verify the Relaybase-owned backend port closes.
4. Release the reservation only after stop finalization.

A registration is not `verified` when launch succeeds but stop or closure fails. It is `registered_with_cleanup_failure`, and the user must see the remaining process/port risk.

## Result Model

Extend registration results with:

```ts
interface RegistrationVerificationResult {
  attempted: boolean;
  status: "not_requested" | "preflight_failed" | "starting" | "healthy" | "failed" | "cleanup_failed" | "verified";
  attemptId?: string;
  assignedPort?: number;
  startedAt?: string;
  healthyAt?: string;
  stoppedAt?: string;
  durationMs?: number;
  health?: {
    declaredTarget?: string;
    successfulTarget?: string;
    statusCode?: number;
  };
  stop?: {
    ok: boolean;
    portClosureVerified: boolean;
    backendPortOpen: boolean | null;
  };
  failure?: RegistrationVerificationFailure;
  repairs: RegistrationRepairOption[];
}
```

The registration state distinguishes:

```text
registered_unverified
registered_verifying
registered_verified
registered_verification_failed
registered_cleanup_failed
```

Never report merely `registered` as equivalent to launch-ready.

## Failure Classification And User Errors

Create stable verification codes mapped from structured lifecycle state first and redacted logs second:

| Code                                 | Meaning                                       | Primary evidence              | User-facing action                                    |
| ------------------------------------ | --------------------------------------------- | ----------------------------- | ----------------------------------------------------- |
| `REGISTER_VERIFY_CWD_MISSING`        | Working directory unavailable                 | preflight                     | Select or restore the project folder                  |
| `REGISTER_VERIFY_COMMAND_NOT_FOUND`  | Runtime/executable unavailable                | spawn error                   | Install runtime or choose another detected command    |
| `REGISTER_VERIFY_DEPENDENCY_MISSING` | App dependency unavailable                    | exit/log classification       | Run the app's documented dependency setup, then retry |
| `REGISTER_VERIFY_PORT_CONFLICT`      | Fixed port occupied                           | reservation/preflight         | Use dynamic port or choose another fixed port         |
| `REGISTER_VERIFY_PORT_IGNORED`       | Process did not bind assigned port            | process alive plus port state | Apply explicit host/port argument repair              |
| `REGISTER_VERIFY_HEALTH_ROUTE`       | Port open but declared health route failed    | bounded route probes          | Apply successful candidate route                      |
| `REGISTER_VERIFY_EARLY_EXIT`         | Process exited before ready                   | child exit                    | Inspect redacted error excerpt and choose repair      |
| `REGISTER_VERIFY_TIMEOUT`            | Process stayed alive but never became ready   | deadline                      | Use extended proof only when adapter justifies it     |
| `REGISTER_VERIFY_PERMISSION`         | Execution policy or permission blocked launch | spawn/log classification      | Use safe platform launcher repair                     |
| `REGISTER_VERIFY_STOP_FAILED`        | Stop hook/process termination failed          | stop attempt                  | Retry stop or inspect cleanup action                  |
| `REGISTER_VERIFY_PORT_STILL_OPEN`    | Backend remains after stop                    | closure check                 | Identify and stop remaining owner before retry        |
| `REGISTER_VERIFY_UNSUPPORTED`        | No reliable deterministic launch plan         | adapter confidence            | Supply an exact command as the final fallback         |

The user message must contain:

- what Relaybase tried, in safe summarized form
- the boundary that failed
- whether the process is still running
- whether a port remains open
- one recommended repair
- alternate repairs, ordered
- a retry action
- a bounded redacted log excerpt or a log-view action

Never show raw stack dumps, secrets, full environment values, or an unclassified `ENOENT` as the primary message.

## Repair Ordering

Repairs must be few, deterministic, and ordered by evidence.

### Repair 1: Correct health route

Offer when:

- assigned port opened
- process stayed alive
- an alternate bounded candidate returned 2xx

Preview only the `healthUrl` change. After approval, re-register and run one new quick proof.

### Repair 2: Explicit dynamic host/port binding

Offer when:

- process started
- assigned port never opened, or logs show a different/default port
- the runtime adapter has a high-confidence argument or environment strategy

Prefer a structured `launch` declaration with exact argument tokens. Generate a wrapper only when direct structured execution cannot express the runtime contract. After approval, run one new quick proof.

### Repair 3: Pinned upstream port

Offer when:

- the app demonstrably cannot accept dynamic binding
- a fixed port is declared or strongly detected
- the user is shown conflict and external-process implications

Pinned port is not the default repair. After approval, preflight the port and run one new quick proof.

### Final fallback: exact manual command

Ask for an exact command only when all of these are true:

- no high-confidence adapter candidate exists
- no existing manifest command can be proven
- no safe health/port repair applies
- Relaybase explains what evidence was missing

The fallback UI should request structured values where possible:

```text
Executable
Arguments
Port binding: environment | arguments | fixed | external
Health route
```

Do not default to one opaque shell string. Preview and validate the resulting launch contract before apply.

## Repair Attempt Limits

- no automatic repair applies writes
- one user-approved repair creates one new lifecycle proof
- recommend at most three repairs
- do not repeat a failed launch-plan digest
- retain the last five verification attempts in bounded daemon state
- offer `Cancel` and `Keep registered without verification` when cleanup is safe
- disallow further launch retries while cleanup is unresolved

## Logging And Evidence

Add a bounded `registration_verification` lifecycle record containing:

- correlation ID
- registration preview ID
- app ID
- manifest revision
- launch-plan digest
- adapter ID/version
- assigned port
- timestamps and durations
- health target and status code
- process exit classification
- stop and port-closure outcome
- selected repair ID
- redaction counts

Store records in the existing operation/audit boundary, not a new ad hoc log file. App stdout/stderr remains in the existing redacted log store.

User-visible errors receive only:

- the final classified error
- up to 20 relevant redacted lines
- a `View logs` action
- exact next-action labels

Do not publish local verification records, raw logs, or filesystem paths in release artifacts.

## Making Runtime Discovery Reliable

Reliable deterministic discovery is a compiler problem, not a larger regex pile.

Each runtime adapter must implement a versioned contract:

```text
detect(project evidence)
  -> runtime identity and confidence
plan(detection)
  -> structured command candidates, port strategies, health candidates, questions
verify(result)
  -> structured observations relevant to this runtime
repair(failure)
  -> ordered preview-only repair candidates
```

### Evidence requirements

High-confidence commands require converging evidence, for example:

- recognized runtime/project file
- actual entrypoint file
- command interface visible in bounded source/config snippets
- matching host/port mechanism
- web-server indicator

Filename alone is not sufficient for high confidence.

### Adapter conformance suite

Every adapter must pass shared fixtures:

- known-good project produces expected structured launch
- non-web project is not falsely classified
- ambiguous project returns questions
- unsafe filename/path is rejected
- dynamic port reaches the assigned port
- health candidate behavior is correct
- classified failure yields ordered repairs
- no repair mutates before approval

### Fixture corpus

Maintain small checked-in synthetic fixtures covering PowerShell, Python, JavaScript frameworks, Go, Java/JVM, .NET, Ruby, PHP, Rust, Docker Compose, Procfile, and unsupported projects. Fixtures contain no downloaded dependencies or generated payloads.

### Confidence policy

- high: may be selected automatically for preview
- medium: show top choices and require selection
- low: require explicit command/strategy input
- unsupported: produce a clear final fallback explanation

Active verification increases confidence for this registration but must not silently teach or globally mutate adapter rules.

## TUI Experience

Before confirmation:

```text
Register Computer Stats

Relaybase will:
  Create relaybase.app.json
  Register computer-stats
  Start it once on a temporary managed port
  Check /api/ping
  Stop it and verify the port closes

Expected time: under 12 seconds
No app will be left running.

[Confirm and verify] [Register without verification] [Review manifest] [Cancel]
```

On success:

```text
Computer Stats is registered and verified.

Started on port 17042
/api/ping returned 200
Stopped successfully
Backend port closed

[Start computer-stats] [Inspect] [Done]
```

On repairable failure:

```text
Computer Stats registered, but launch verification failed.

The process started but did not listen on Relaybase's assigned port.
It appears to support explicit -HostName and -Port arguments.
The failed process was stopped and port closure was verified.

Recommended:
  Use structured host/port arguments

[Preview repair] [View logs] [Keep unverified] [Cancel]
```

On cleanup failure, `Keep unverified` and further launch actions are disabled until the remaining process/port is resolved.

## Documentation Changes

### Minimal user-facing changes

Update `README.md`, `docs/getting-started.md`, and `docs/troubleshooting.md` with only:

- `/register <folder>` creates or validates the manifest
- registration briefly starts and stops the app when quick verification is approved
- success means health passed and stop/closure passed
- three common repair categories
- `--no-verify` or equivalent opt-out wording
- `View logs` and safe retry guidance

Do not expose adapter internals, state-machine names, or wrapper implementation details in the quick start.

### Extensive public backend documentation

Update:

- `docs/app-manifest.md`: structured launch, port ownership, verification implications
- `docs/tui-setup-onboarding.md`: registration coordinator and approval flow
- `docs/tui-setup-port-strategies.md`: observed failure to repair mapping
- `docs/architecture.md`: service ownership and lifecycle boundaries
- `docs/cli.md`: register preview/apply/verification flags and JSON result
- `docs/mcp.md`: registration preview/apply and verification result schema

Add implementation details to this document rather than expanding the README.

## Implementation Phases And Acceptance Criteria

### Gate 0: claimable baseline

- refresh CodeGraph at the implementation HEAD
- require `claimable: true`, current graph freshness, and matching passport
- run current focused registration, setup API, process-manager, and health tests

Acceptance: no product edit begins from stale graph evidence.

### Phase 1: verification types and service

- add policy, result, failure, and repair types
- add `RegistrationVerificationService`
- reuse process manager and health primitives
- add abort, timing, and attempt metadata

Acceptance:

- no direct spawn/kill in the service
- default policy stays within its declared time budget
- `mode: none` performs zero lifecycle mutation
- success requires health, stop, and closure

### Phase 2: registration integration

- include verification intent in preview
- bind policy to preview ID
- invoke proof only after registry success
- return registered-but-unverified states honestly

Acceptance:

- preview drift performs zero writes and zero starts
- confirmation text explicitly names start/stop behavior
- registration never leaves a successful proof process running
- exact-file and folder forms preserve their strict/smart distinction

### Phase 3: diagnosis and repairs

- classify structured lifecycle failures
- add bounded health candidate probes
- generate the three ordered repair classes
- prevent repeated failed plan digests

Acceptance:

- no more than three candidate health GETs
- no repair writes without approval
- each repair retry is a distinct attempt
- manual command is offered only when no deterministic repair applies
- cleanup failure blocks retries

### Phase 4: logging and UI

- persist bounded verification records
- render progress, success, repair, and cleanup-failure states
- add view logs, retry, keep unverified, and cancel actions

Acceptance:

- secrets and raw env values never render
- errors name the failed boundary and next action
- keyboard focus and modal ownership remain correct
- narrow terminal rendering remains usable
- cancellation produces a terminal inspectable result

### Phase 5: adapter reliability

- implement adapter `verify` observations where runtime-specific behavior matters
- expand conformance fixtures
- enforce confidence policy
- add `computer-stats`-shaped PowerShell fixture

Acceptance:

- PowerShell host/port launcher verifies on a managed dynamic port
- ambiguous and non-web PowerShell/Python projects do not auto-apply
- Windows, macOS, and Linux fixtures agree on normalized plans
- adapter version is included in proof identity

### Phase 6: docs and full proof

- update the minimal user flow and extensive backend docs
- run link/format checks
- run complete Node, Go TUI, race-supported, packaging, and cross-platform CI gates
- perform disposable end-to-end registration proofs

Acceptance:

- a new user can register a supported fixture using only the README
- `computer-stats` flow creates the manifest, verifies `/api/ping`, stops, and closes the port
- command-not-found, ignored-port, wrong-health-route, early-exit, timeout, fixed-port conflict, and stop-failure cases have tested messages and repairs
- all required PR checks are green
- no generated proof artifacts or raw logs are staged

## Final Definition Of Done

The feature is done when `/register <folder>` can create or validate the manifest, visibly obtain approval for one fast start/health/stop proof, end with the app stopped, and either report verified readiness or provide a specific safe repair path. Manual command entry is reachable only after deterministic detection and evidence-driven repairs cannot produce a reliable plan.
