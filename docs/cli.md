# CLI

Relaybase's normal operator surface is intentionally small:

```powershell
relaybase configure
relaybase open
relaybase health
```

Use `relaybase list` for the read-only app inventory. Lower-level commands remain available for automation and direct lifecycle control.

## Shared Options

```text
--port <number>      Hub port. Default: 7777 or RELAYBASE_PORT.
--host <host>        Hub host. Default: 127.0.0.1 or RELAYBASE_HOST.
--state-dir <path>   Relaybase state directory.
--cwd <path>         Project root. Default: current directory.
--json               Print machine-readable output for supported commands.
--verbose            Include expanded detail for supported commands.
```

`--json` results can include `nextActions`: concrete follow-up actions with an owner, command when available, and evidence when Relaybase can name the failing boundary.

## tui

```powershell
relaybase serve
relaybase tui
relaybase tui --port 7777 --host 127.0.0.1
relaybase tui -- --theme dark
```

`relaybase tui` launches the Go Bubble Tea TUI as a client of the running daemon. It does not start apps, inspect ports, or manage process lifecycle locally. The bridge passes `--base-url` and `--state-dir` to the TUI using the same `--host`, `--port`, and `--state-dir` conventions as other Relaybase commands. TUI-specific arguments can be passed after `--`.

Binary resolution order:

1. `RELAYBASE_TUI_BIN`
2. repo-local `.relaybase/tui-dev-bin/<platform binary>` produced by `npm run tui:build`
3. `bin/relaybase-tui/<platform binary>` inside the installed package
4. optional `@cameloo/relaybase-tui-<platform>-<arch>` platform package
5. globally installed `relaybase-tui` on `PATH`

Supported binary names:

- `relaybase-tui-windows-amd64.exe`
- `relaybase-tui-windows-arm64.exe`
- `relaybase-tui-darwin-amd64`
- `relaybase-tui-darwin-arm64`
- `relaybase-tui-linux-amd64`
- `relaybase-tui-linux-arm64`

Local source builds write the package asset binary:

```powershell
npm run doctor:tui
npm run tui:build
npm run tui:build:all
npm run package:check
```

Direct binary launch is also supported:

```powershell
.\bin\relaybase-tui\relaybase-tui-windows-amd64.exe --base-url http://127.0.0.1:7777 --state-dir "$env:LOCALAPPDATA\Relaybase"
```

Troubleshooting:

- Missing binary: build with `npm run tui:build`, install a package that includes the matching asset, or set `RELAYBASE_TUI_BIN`.
- Package verification: `npm run package:check` reports whether the current-platform TUI binary is in the npm dry-run. Use `RELAYBASE_REQUIRE_TUI_BINARY=1 npm run package:check` after `npm run tui:build` for release gating.
- Missing Go: install Go `1.25.x`, open a new terminal so `PATH` is refreshed, then verify with `go version`, `go env GOVERSION GOOS GOARCH GOMOD GOMODCACHE`, and `npm run doctor:tui`.
- Daemon unavailable: start `relaybase serve`; the bridge does not silently start apps.
- Auth failure: verify the selected `--state-dir` contains the Relaybase `session-token`, or set `RELAYBASE_TOKEN` for the TUI process.
- Unsupported terminal: use the TUI dark/light fallback with `relaybase tui -- --theme dark` or `relaybase tui -- --theme light`.

## configure

```powershell
relaybase configure
relaybase configure --yes
relaybase configure --dry-run
relaybase configure --repair
relaybase configure --no-start
relaybase configure --mcp-install
relaybase configure --answers .relaybase/setup.answers.json
```

`configure` detects the project, chooses a setup plan, writes guarded Relaybase files, registers the app, and can start verification through Relaybase.

`--dry-run` returns the selected plan and the manifest that would be written without changing files. `--repair` reruns setup as a repair flow. `--yes` allows approved repair retries when verification fails and the setup engine has a matching alternate plan.

Docker Compose projects can use:

```powershell
relaybase configure --profile docker-compose
relaybase configure --profile docker-compose --service web --target-port 3000 --health-path /api/health
```

Ambiguous Compose projects require explicit service and target-port input instead of guessing.

## open

```powershell
relaybase open
relaybase open --no-browser
relaybase open --json
```

`open` is the daily launch command. It reads the launch profile or root manifest, ensures the daemon, registers through the daemon when it is reachable, starts the app, checks readiness, and opens the stable human route when ready.

If daemon registration is possible, `open` uses that path before local registry mutation. Local registry writes are fallback behavior for offline daemon cases.

When launch fails, `open --json` returns the failing owner when Relaybase can identify it, such as daemon, manifest, token, app command, backend port, health URL, route, or permissions.

## health

```powershell
relaybase health
relaybase health --json
relaybase health --prove
relaybase health --prove --yes
```

`health` is read-only by default. It checks project configuration, daemon reachability, app state, route health, Docker profile findings, and repair suggestions.

`health --prove` writes a proof artifact under `.relaybase/runs/` with discovery, manifest, Docker profile, state, and log checks. `health --prove --yes` also runs a lifecycle proof: register, start, routed health, logs, stop, and stop verification.

Current finding codes:

- `PROJECT_NOT_CONFIGURED`
- `DAEMON_UNREACHABLE`
- `APP_NOT_READY`
- `APP_STATE_UNAVAILABLE`
- `ROUTE_DEGRADED`
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

`list` shows registered apps with readiness, runtime status, health, route reachability, backend port, and next action.

When the daemon is reachable, `list` reads live daemon state. When the daemon is offline, it falls back to the registry and marks runtime, readiness, health, and route as `unknown`.

Runtime filters require the daemon because Relaybase cannot prove running state from the registry alone. If the daemon is offline, filtered forms fail with a clear message instead of treating registry data as live state.

`--attention` shows apps that need operator review: unhealthy or failed readiness, `errored` or `conflict` runtime status, cleanup or stop-verification failure, failed stop verification, or a recorded last error.

## Advanced Commands

```powershell
relaybase serve
relaybase mcp
relaybase tui
relaybase register <manifest>
relaybase start <app-id>
relaybase stop <app-id>
relaybase restart <app-id>
relaybase status
relaybase logs <app-id>
```

`serve` starts the localhost daemon. `mcp` runs Relaybase as a stdio MCP server. `tui` launches the Go terminal client when a matching binary is installed or configured. `register` writes a manifest into Relaybase state. `start`, `stop`, and `restart` call the daemon API and require the local mutation token. `status` is a compatibility alias for `list`. `logs` prints the daemon's recent in-memory log snapshot for one app.
