# Using Relaybase with Codex

Relaybase gives Codex one reliable way to run local apps: configure the app once, open it through a stable route, inspect health and logs, and stop it cleanly.

The primary repo-local Codex skill lives at:

```text
skills/relaybase/SKILL.md
```

The compatibility skill lives at:

```text
skills/relaybase-dev/SKILL.md
```

Use it when a Codex session is starting, previewing, debugging, routing, or stopping a local app that should run through Relaybase.

## Codex Prompt

Point Codex at the skill when the app should use Relaybase:

```text
Use $relaybase at skills/relaybase to run this app through Relaybase with direct ports only as fallback.
```

This tells Codex to prefer manifests, daemon registration, stable routes, routed health checks, logs, and stop verification instead of choosing random localhost ports.

Existing `$relaybase-dev` prompts remain supported for compatibility.

## Normal Flow

For most apps, Codex should keep the user-facing flow to:

```powershell
relaybase configure
relaybase open
relaybase health
```

`configure` owns setup and repair. `open` owns daily launch and routed access. `health` owns read-only diagnosis and `nextActions`.

`relaybase list` is the inventory view for registered apps.

## Success Criteria

A Relaybase launch is successful when:

- the app is registered with the daemon
- the app process starts or an existing upstream is reachable
- the backend port is open when one is known
- the human route works: `http://<app-id>.localhost:7777`
- the agent route works: `http://127.0.0.1:7777` with `X-Relaybase-App: <app-id>`
- logs are available through Relaybase
- stop verification closes Relaybase-owned backend ports

Route health can be `full`, `degraded`, or `failed`. `full` is the target for proof. `degraded` means one route path worked and the other needs attention.

## Manual Proof Helper

For manual checks on Windows or in Codex App, use the checked-in `.cmd` wrapper:

```powershell
.\skills\relaybase-dev\scripts\relaybase-dev.cmd -Action preflight
.\skills\relaybase-dev\scripts\relaybase-dev.cmd -Action status
.\skills\relaybase-dev\scripts\relaybase-dev.cmd -Action ensure-manifest -AppId notes -Name "Notes" -Command "npm.cmd run dev" -Cwd .
.\skills\relaybase-dev\scripts\relaybase-dev.cmd -Action register -ManifestPath .\relaybase.app.json
.\skills\relaybase-dev\scripts\relaybase-dev.cmd -Action start -AppId notes
.\skills\relaybase-dev\scripts\relaybase-dev.cmd -Action route-check -AppId notes
.\skills\relaybase-dev\scripts\relaybase-dev.cmd -Action logs -AppId notes
.\skills\relaybase-dev\scripts\relaybase-dev.cmd -Action verify -AppId notes -ManifestPath .\relaybase.app.json
```

The wrapper keeps PowerShell behavior process-local and does not require changing system policy.

## Fallback Rule

Direct ports are fallback, not the default. Use them only when Relaybase is unreachable, unsuitable for the app shape, explicitly bypassed by the user, or being debugged itself.

When fallback is used, Codex should say why and name the path back to Relaybase.

## Ownership Boundaries

Relaybase owns lifecycle state, routing, assigned ports, logs, health proof, child MCP aggregation, and stop verification.

The app repo owns app code, start commands, health routes, environment values, Docker files, migrations, seeds, and app-specific hook behavior.

Dashboards should call Relaybase APIs for app control. They should not spawn app processes directly unless they are explicitly in fallback mode.

## Docker Compose Apps

For Compose-backed apps, Codex should prefer the generated Docker profile:

```text
.relaybase/docker-profile.json
.relaybase/docker-compose.relaybase.yml
.relaybase/scripts/relaybase-prestart.ps1
.relaybase/scripts/relaybase-start.ps1
.relaybase/scripts/relaybase-stop.ps1
.relaybase/scripts/relaybase-verify-stopped.ps1
```

Relaybase runs these as generic lifecycle hooks. The app repo still owns Dockerfiles, Compose files, images, volumes, migrations, secrets, and registry auth.

Use [docker-compose-lifecycle.md](docker-compose-lifecycle.md) for the exact Compose contract and current limits.

## Troubleshooting Branches

Common branches Codex should identify explicitly:

- Token mismatch: discovery is healthy, but mutations return `401`.
- Missing manifest: run `relaybase configure`.
- Daemon unreachable: use `relaybase open` or start the daemon, then retry.
- App command failure: fix the app-owned start command before blaming Relaybase.
- Backend port failure: verify the expected port is open and owned by the app.
- Route degradation: check both the `.localhost` route and the `X-Relaybase-App` header route.
- Stale runtime: restart the edited dashboard or Relaybase process before assuming code changes failed.
- Stop failure: treat an open Relaybase-owned backend port after stop as a failed stop.
