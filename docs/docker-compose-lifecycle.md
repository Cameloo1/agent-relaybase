# Docker Compose Lifecycle

Relaybase supports Docker Compose apps through generated app-owned profiles and hook scripts. Relaybase core stays app-agnostic: it runs hooks, records state, routes traffic, captures logs, and verifies cleanup.

The app repo still owns its Compose files, images, Dockerfiles, service behavior, migrations, volumes, registry auth, and secrets.

## Public Flow

```powershell
relaybase configure
relaybase open
relaybase health
```

When `relaybase configure` sees a Compose file in the project root, it can select the `docker-compose` setup plan. Noninteractive callers can choose it directly:

```powershell
relaybase configure --profile docker-compose
relaybase configure --profile docker-compose --service web --target-port 3000 --health-path /api/health
```

MCP callers use the same setup engine through `configure_project` with `profile: "docker-compose"`. Dry-run planning is read-only; applying the configuration is token-gated.

## Detection

Relaybase currently detects these root-level files:

```text
compose.yaml
compose.yml
docker-compose.yaml
docker-compose.yml
```

Detection is conservative. Services with ports, exposed ports, health checks, and app-like names score higher. Database, cache, storage, worker, queue, and search-like names are rejected as app entrypoints. If the best app-facing service is ambiguous, setup requires explicit `--service` and `--target-port` input.

Compose text detection is not the authoritative parser. The generated prestart script still runs `docker compose config` before launch.

## Generated Files

Docker setup can write:

```text
relaybase.app.json
.relaybase/docker-profile.json
.relaybase/docker-compose.relaybase.yml
.relaybase/scripts/relaybase-prestart.ps1
.relaybase/scripts/relaybase-start.ps1
.relaybase/scripts/relaybase-stop.ps1
.relaybase/scripts/relaybase-verify-stopped.ps1
```

The manifest uses generic lifecycle hook fields:

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

On Windows, Relaybase invokes generated PowerShell hook scripts automatically. Users do not need to change system execution-policy settings.

## Port Override

`.relaybase/docker-compose.relaybase.yml` maps Relaybase's assigned runtime `PORT` to the selected service's target container port:

```yaml
services:
  web:
    labels:
      relaybase.app: "app"
      relaybase.compose_project: "relaybase-app"
    ports:
      - "127.0.0.1:${PORT:-0}:3000"
  db:
    labels:
      relaybase.dependency: "true"
    ports: !reset []
```

The override does not edit the app's Compose file. By default, dependency services do not publish host ports through the Relaybase override.

## Runtime Hooks

`preStartCommand` checks Docker daemon access, Compose availability, Compose config, blocked settings, current project status, required env values, and assigned-port conflicts. It records evidence under `.relaybase/runs/`.

`command` runs `docker compose up --build --remove-orphans` in the foreground so Relaybase captures build and container logs.

`stopCommand` runs `docker compose down --remove-orphans --timeout <budget>` and keeps volumes by default.

`verifyStoppedCommand` refuses success when Compose still reports project containers or Relaybase-owned ports remain open.

The generated scripts account for Docker's Windows behavior where successful progress output may be written to stderr.

## Docker Profile

`.relaybase/docker-profile.json` records the selected service, target container port, Compose files, override file, dependency port policy, timings, retry backoff, cleanup policy, volume policy, approval flags, redaction keys, missing env values, private image hints, and security findings.

Current generated defaults include:

```json
{
  "hostPortStrategy": "relaybase-assigned-port",
  "dependencyPortPolicy": "internal-only",
  "portExposurePolicy": "selected-service-localhost-only",
  "portExposureVerification": "docker-compose-config",
  "buildPolicy": "pull-build-with-approval",
  "cleanupPolicy": "down-remove-orphans-keep-volumes",
  "volumePolicy": "never-remove-by-default",
  "migrationPolicy": "no-op-unless-approved",
  "retryBackoffMs": [1000, 2000, 4000, 8000, 15000]
}
```

A run writes only the artifacts reached by that code path. Not every declared artifact appears in every run.

## Health

`relaybase health` is read-only by default. For Compose projects it can report:

- `DOCKER_PROFILE_MISSING`: Compose files exist but `.relaybase/docker-profile.json` does not.
- `COMPOSE_ENV_MISSING`: the generated profile found required Compose env variables that were missing during detection.
- `DANGEROUS_COMPOSE_CONFIG`: the generated profile contains blocked Compose settings.

`relaybase health --prove` writes a proof artifact under `.relaybase/runs/`. With `--yes`, it also runs register, start, routed health, logs, stop, and stop verification.

## Risk Detection

Blocked Compose settings:

- `privileged: true`
- `network_mode: host`
- `pid: host`
- `ipc: host`
- Docker socket mounts containing `docker.sock`

Warnings:

- broad host mounts
- public `0.0.0.0:<port>` binds
- secret-like environment values

Blocked settings make generated prestart fail unless the profile approval flag is changed.

## Current Limits

Relaybase does not currently:

- manage Docker through the Docker SDK or Docker API
- parse Compose YAML inside the daemon at runtime
- provide a container management UI
- remove Docker volumes by default
- run migrations or seed scripts automatically
- authenticate to private registries
- guarantee Docker Desktop startup, image pulls, builds, or Compose profiles
- select Compose profiles interactively
