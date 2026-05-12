# CLI

Relaybase keeps the normal operator surface to three commands:

```powershell
relaybase configure
relaybase open
relaybase health
```

Advanced commands still exist for daemon work, dashboards, tests, and direct lifecycle control.

## Shared Options

These options are parsed by the CLI:

```text
--port <number>      Hub port. Default: 7777 or RELAYBASE_PORT.
--host <host>        Hub host. Default: 127.0.0.1 or RELAYBASE_HOST.
--state-dir <path>   Relaybase state directory.
--cwd <path>         Project root. Default: current directory.
--json               Print machine-readable output for supported commands.
```

## configure

```powershell
relaybase configure
relaybase configure --yes
relaybase configure --dry-run
relaybase configure --profile docker-compose
relaybase configure --repair
relaybase configure --no-start
relaybase configure --mcp-install
relaybase configure --answers .relaybase/setup.answers.json
```

`configure` runs the setup engine for the project root. In an interactive terminal, it asks arrow-key questions for the setup architecture, env strategy, and whether to start and verify through Relaybase immediately.

Noninteractive mode uses the recommended plan unless `--profile` or `--answers` selects one. `--dry-run` returns the plan without writing files. `--yes` allows approved repair retries when verification fails and the setup engine has a matching alternate plan. `--repair` re-runs setup as a repair flow.

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
```

`health` is read-only. It detects the project, reads launch profile and Docker profile data when present, checks whether the daemon is reachable, reads app state when the daemon and app id are available, and returns findings with repair suggestions.

Current finding codes include:

- `PROJECT_NOT_CONFIGURED`
- `DAEMON_UNREACHABLE`
- `APP_NOT_READY`
- `APP_STATE_UNAVAILABLE`
- `PROFILE_MANIFEST_MISMATCH`
- `DOCKER_PROFILE_MISSING`
- `COMPOSE_ENV_MISSING`
- `DANGEROUS_COMPOSE_CONFIG`

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

`serve` starts the localhost daemon. `mcp` runs Relaybase as a stdio MCP server. `register` writes a manifest into the state registry. `start`, `stop`, and `restart` call the daemon HTTP API and require the local mutation token. `status` lists apps from the daemon when it is reachable and falls back to the registry when it is not. `logs` prints the daemon's recent in-memory log snapshot for one app.

The three-command flow remains the intended user path. These lower-level commands are useful for dashboards, tests, debugging, and automation.
