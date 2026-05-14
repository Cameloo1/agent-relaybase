# CLI

Relaybase keeps the normal operator surface to three commands:

```powershell
relaybase configure
relaybase open
relaybase health
```

`relaybase list` is the read-only app inventory view. Advanced commands still exist for daemon work, dashboards, tests, and direct lifecycle control.

## Shared Options

These options are parsed by the CLI:

```text
--port <number>      Hub port. Default: 7777 or RELAYBASE_PORT.
--host <host>        Hub host. Default: 127.0.0.1 or RELAYBASE_HOST.
--state-dir <path>   Relaybase state directory.
--cwd <path>         Project root. Default: current directory.
--json               Print machine-readable output for supported commands.
--verbose            Include expanded detail for supported commands.
```

List filters:

```text
--running            Apps with runtime status running.
--active             Apps with runtime status starting, running, or stopping.
--stopped            Apps with runtime status stopped.
--ready              Apps with readiness state ready.
--attention          Apps that need operator review.
```

## configure

```powershell
relaybase configure
relaybase configure --yes
relaybase configure --dry-run
relaybase configure --profile docker-compose
relaybase configure --profile docker-compose --service web --target-port 3000 --health-path /api/health --start-timeout-ms 600000
relaybase configure --repair
relaybase configure --no-start
relaybase configure --mcp-install
relaybase configure --answers .relaybase/setup.answers.json
```

`configure` runs the setup engine for the project root. In an interactive terminal, it asks arrow-key questions for the setup architecture, env strategy, and whether to start and verify through Relaybase immediately.

Noninteractive mode uses the recommended plan unless `--profile` or `--answers` selects one. `--dry-run` returns the plan without writing files. `--yes` allows approved repair retries when verification fails and the setup engine has a matching alternate plan. `--repair` re-runs setup as a repair flow.

For Docker Compose projects, `--service`, `--target-port`, `--health-path`, `--start-timeout-ms`, `--health-timeout-ms`, `--stop-timeout-ms`, `--dependency-port-policy`, `--compose-profile`, and `--docker-start-desktop` feed the same setup flow. Ambiguous Compose projects require an explicit service and target port instead of guessing.

Env strategies:

- `runtime-injection`: do not write env files; Relaybase injects runtime variables when it starts the app.
- `env-relaybase-file`: write `.env.relaybase` with Relaybase-owned hints.
- `guarded-env-block`: update only the guarded `# relaybase:start` to `# relaybase:end` block in `.env`.
- `none`: do not write Relaybase env values.

Applied setup can write `relaybase.app.json`, `.relaybase/launch-profile.json`, `.relaybase/setup.answers.json`, `.relaybase/rollback.json`, `.relaybase/setup-report.json`, and `.relaybase/runs/<timestamp>.jsonl`. Some setup plans write additional helper files.

## open

```powershell
relaybase open
relaybase open --no-browser
relaybase open --json
```

`open` loads `.relaybase/launch-profile.json` when present, otherwise it uses `relaybase.app.json` in the project root. It registers the manifest, starts the daemon when needed, asks the daemon to start the app, reads app state, and opens `http://<app-id>.localhost:<port>` only when the app is ready unless `--no-browser` is set.

If the project is not configured, it reports that `relaybase configure` must run first.

## health

```powershell
relaybase health
relaybase health --json
relaybase health --prove
relaybase health --prove --yes
```

`health` is read-only by default. It detects the project, reads launch profile and Docker profile data when present, checks whether the daemon is reachable, reads app state when the daemon and app id are available, and returns findings with repair suggestions.

`health --prove` writes a proof artifact under `.relaybase/runs/` with discovery, manifest, Docker profile, current state, and log checks. `health --prove --yes` also runs a lifecycle proof: register, start, routed health, logs, stop, and stop verification.

Current finding codes include:

- `PROJECT_NOT_CONFIGURED`
- `DAEMON_UNREACHABLE`
- `APP_NOT_READY`
- `APP_STATE_UNAVAILABLE`
- `PROFILE_MANIFEST_MISMATCH`
- `DOCKER_PROFILE_MISSING`
- `COMPOSE_ENV_MISSING`
- `DANGEROUS_COMPOSE_CONFIG`
- `PROOF_FAILED`

## list

```powershell
relaybase list
relaybase list --running
relaybase list --active
relaybase list --stopped
relaybase list --ready
relaybase list --attention
relaybase list --verbose
relaybase list --json
```

`list` shows registered apps with their readiness, runtime status, health, route reachability, backend port, and next action. When the daemon is reachable, it reads `/__hub/api/state` so the CLI matches dashboard and MCP state. When the daemon is offline, it falls back to the registry and marks runtime, readiness, health, and route as `unknown`.

Runtime filters require the daemon because Relaybase cannot prove running state from the registry alone. If the daemon is offline, filtered forms such as `relaybase list --running` fail with a clear message instead of pretending the registry is live state.

`--attention` shows apps that need operator review: unhealthy or failed readiness, `errored` or `conflict` runtime status, cleanup or stop-verification failure phases, failed stop verification, or a recorded last error.

## Advanced Commands

```powershell
relaybase serve
relaybase mcp
relaybase register <manifest>
relaybase start <app-id>
relaybase stop <app-id>
relaybase restart <app-id>
relaybase status
relaybase logs <app-id>
```

`serve` starts the localhost daemon. `mcp` runs Relaybase as a stdio MCP server. `register` writes a manifest into the state registry. `start`, `stop`, and `restart` call the daemon HTTP API and require the local mutation token. `status` is a compatibility alias for `list`. `logs` prints the daemon's recent in-memory log snapshot for one app.

The three-command flow remains the intended user path. These lower-level commands are useful for dashboards, tests, debugging, and automation.
