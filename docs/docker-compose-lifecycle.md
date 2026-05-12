# Docker Compose Lifecycle

Relaybase supports Docker Compose apps through generated app-owned profiles and hook scripts. Relaybase core stays app-agnostic: it executes lifecycle hooks, records state, routes traffic, captures logs, and refuses fake stop success when cleanup verification fails. The app repo still owns its Compose files, images, Dockerfiles, service behavior, migrations, and secrets.

## Public Flow

The user-facing flow remains the same three commands:

```powershell
relaybase configure
relaybase open
relaybase health
```

When `relaybase configure` sees a Compose file in the project root, it can select the `docker-compose` setup profile. Noninteractive callers can choose it directly:

```powershell
relaybase configure --profile docker-compose
```

MCP callers use the same setup engine through `configure_project` with `profile: "docker-compose"`. Dry-run planning is allowed without mutation credentials; applying the configuration is token-gated.

## Detection

The current detector looks for these root-level files:

```text
compose.yaml
compose.yml
docker-compose.yaml
docker-compose.yml
```

It reads the Compose text to infer service names, images, `build`, `ports`, `expose`, `depends_on`, `profiles`, and whether a `healthcheck` key is present. Service selection is heuristic: services with ports, exposed ports, health checks, and app-like names score higher; database, cache, worker, queue, and search-like names score lower.

This detection is not a full YAML engine. The generated prestart script still runs `docker compose config` before launch, which is the authoritative Compose validation step.

## Generated Files

The Docker profile writes these files under the app root:

```text
relaybase.app.json
.relaybase/docker-profile.json
.relaybase/docker-compose.relaybase.yml
.relaybase/scripts/relaybase-prestart.ps1
.relaybase/scripts/relaybase-start.ps1
.relaybase/scripts/relaybase-stop.ps1
.relaybase/scripts/relaybase-verify-stopped.ps1
```

`relaybase.app.json` uses generic lifecycle hook fields. Docker-specific behavior lives in `.relaybase/docker-profile.json` and the generated PowerShell scripts.

## Manifest Contract

Generated Docker manifests use the app's existing id, name, protocol, and health URL when available. Docker setup replaces the app command with hook commands:

```json
{
  "command": ".\\.relaybase\\scripts\\relaybase-start.ps1",
  "preStartCommand": ".\\.relaybase\\scripts\\relaybase-prestart.ps1",
  "stopCommand": ".\\.relaybase\\scripts\\relaybase-stop.ps1",
  "verifyStoppedCommand": ".\\.relaybase\\scripts\\relaybase-verify-stopped.ps1",
  "preStartTimeoutMs": 25000,
  "startTimeoutMs": 600000,
  "stopTimeoutMs": 60000,
  "healthTimeoutMs": 300000
}
```

The generated hook files are PowerShell scripts. On Windows, Relaybase runs `.ps1` commands through `powershell.exe -NoProfile -ExecutionPolicy Bypass -File`.

## Port Override

`.relaybase/docker-compose.relaybase.yml` adds labels and maps Relaybase's assigned runtime `PORT` to the selected service's target container port:

```yaml
services:
  web:
    labels:
      relaybase.app: "app"
      relaybase.compose_project: "relaybase-app"
    ports:
      - "127.0.0.1:${PORT:-0}:3000"
```

The override does not edit the app's Compose file. If the detector cannot infer a target port, the generated profile uses container port `3000` and records a setup risk telling the user to rerun configure if the app listens elsewhere.

## Runtime Hooks

`preStartCommand`:

- Reads `.relaybase/docker-profile.json`.
- Creates a run directory under `.relaybase/runs/`.
- Retries `docker info --format "{{json .}}"` until the Docker preflight budget expires.
- Records `docker-context.json`.
- Fails if the Docker context output appears remote and `approvals.remoteContext` is false.
- Requires `docker compose version` to succeed.
- Runs `docker compose config` and records `compose-config.redacted.json`.
- Fails on blocked Compose settings unless `approvals.dangerousConfig` is true.
- Records `compose-ps.before.json`.
- Fails if Relaybase's assigned `PORT` is already open before start.
- Records `ports.before.json`.

`command`:

- Runs `docker compose up --build --remove-orphans` in the foreground.
- Lets Relaybase own the process handle and process logs.

`stopCommand`:

- Records `compose-ps.before-stop.json`.
- Runs `docker compose down --remove-orphans --timeout 30`.
- Does not pass `--volumes`, so volumes are kept by default.
- Verifies cleanup after `down`.

`verifyStoppedCommand`:

- Runs the same cleanup verification without starting or stopping services.
- Fails when Compose still reports project containers.
- Fails when Relaybase-owned ports are still open.

The generated scripts temporarily relax PowerShell's error action around native `docker` calls, then check `$LASTEXITCODE`. This is needed because Docker can write successful progress output to stderr on Windows.

## Docker Profile Fields

`.relaybase/docker-profile.json` is inspectable JSON. It records:

- `composeProjectName`
- `composeFiles`
- `overrideFile`
- `selectedService`
- `targetContainerPort`
- `healthPath`
- `hostPortStrategy`
- `buildPolicy`
- `cleanupPolicy`
- `volumePolicy`
- `migrationPolicy`
- `requiredServices`
- `optionalServices`
- `dependencyServices`
- `dependencyPorts`
- `timingsMs`
- `retryBackoffMs`
- `lifecycleStates`
- `errorTaxonomy`
- `approvals`
- `artifacts`
- `retention`
- `redactionKeys`
- `securityFindings`
- `missingEnvVars`
- `privateImages`

Current generated defaults include:

```json
{
  "hostPortStrategy": "relaybase-assigned-port",
  "buildPolicy": "pull-build-with-approval",
  "cleanupPolicy": "down-remove-orphans-keep-volumes",
  "volumePolicy": "never-remove-by-default",
  "migrationPolicy": "no-op-unless-approved",
  "retryBackoffMs": [1000, 2000, 4000, 8000, 15000]
}
```

The profile also declares expected artifact names. A run writes the artifacts reached by that code path; not every listed artifact is guaranteed to exist for every run.

## Health Diagnostics

`relaybase health` is read-only. For Compose projects it can report:

- `DOCKER_PROFILE_MISSING`: Compose files exist but `.relaybase/docker-profile.json` does not.
- `COMPOSE_ENV_MISSING`: the generated profile found required Compose env variables that were missing during detection.
- `DANGEROUS_COMPOSE_CONFIG`: the generated profile contains blocked Compose settings.

The Docker profile is included in the machine-readable `health --json` result when present.

## Helper Diagnostics

The repo-local helper has Docker-aware diagnostics for proof and troubleshooting:

```powershell
.\skills\relaybase-dev\scripts\relaybase-dev.ps1 -Action docker-preflight -ManifestPath .\relaybase.app.json
.\skills\relaybase-dev\scripts\relaybase-dev.ps1 -Action compose-detect -ManifestPath .\relaybase.app.json
.\skills\relaybase-dev\scripts\relaybase-dev.ps1 -Action compose-status -ManifestPath .\relaybase.app.json
.\skills\relaybase-dev\scripts\relaybase-dev.ps1 -Action compose-health -ManifestPath .\relaybase.app.json
.\skills\relaybase-dev\scripts\relaybase-dev.ps1 -Action compose-logs -ManifestPath .\relaybase.app.json
.\skills\relaybase-dev\scripts\relaybase-dev.ps1 -Action compose-cleanup -ManifestPath .\relaybase.app.json
.\skills\relaybase-dev\scripts\relaybase-dev.ps1 -Action compose-verify-stop -ManifestPath .\relaybase.app.json
.\skills\relaybase-dev\scripts\relaybase-dev.ps1 -Action docker-diagnose -ManifestPath .\relaybase.app.json
```

These are supporting diagnostics, not additional public setup commands.

## Risk Detection

The current detector marks these as blocked Compose settings:

- `privileged: true`
- `network_mode: host`
- `pid: host`
- `ipc: host`
- Docker socket mounts containing `docker.sock`

The current detector marks these as warnings:

- broad host mounts
- public `0.0.0.0:<port>` binds
- secret-like environment values

Blocked settings make generated prestart fail unless the profile approval flag is changed. There is no high-level Docker approval wizard command in this implementation.

## What Relaybase Does Not Do

Relaybase does not currently:

- manage Docker through the Docker SDK or Docker API
- parse Compose YAML inside the daemon at runtime
- provide a container management UI
- remove Docker volumes by default
- run migrations or seed scripts automatically
- authenticate to private registries for the user
- guarantee that image pulls, builds, or Docker Desktop startup will succeed
- select Compose profiles interactively

Those boundaries are intentional for now. Docker-specific intelligence stays in generated app-owned files, while Relaybase owns lifecycle execution, state, logs, routing, health proof, and stop correctness.
