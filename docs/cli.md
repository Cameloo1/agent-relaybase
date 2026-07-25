# CLI

Relaybase's normal operator surface is intentionally small:

```powershell
relaybase start
relaybase check
relaybase verify
relaybase --version
```

`relaybase start` with no app id launches the normal daemon + TUI operator surface. `relaybase check` is a read-only local diagnosis bundle. `relaybase verify` is the source-checkout verification gate. Lower-level commands such as `configure`, `open`, `health`, `list`, `serve`, `tui`, and `start <app-id>` remain available for automation and direct lifecycle control.

Inside the TUI, use `?` or `/help` for searchable command help and `/settings` for categorized settings. See [Operator console](operator-console.md) for slash commands, keys, app/package managers, and Agent Chat.

After installing dependencies, build the current-platform TUI once. The npm wrappers then call the same bundled paths from the source checkout:

```powershell
npm.cmd run tui:build
npm.cmd start
npm.cmd run check
npm.cmd run verify
```

If PowerShell says `relaybase` is not recognized, either run `npm.cmd start` from the repo root or explicitly link the checkout with `npm.cmd run relaybase -- repair-prefix`. The start wrapper launches the source checkout directly and does not run `npm link`, change the global npm prefix, or delete shims. Prefix inspection and repair remain separate explicit operations available through `npm.cmd run relaybase -- repair-prefix --diagnose`, `--plan`, and the mutating `repair-prefix` form.

## Shared Options

```text
--port <number>      Hub port. Default: 7777 or RELAYBASE_PORT.
--host <host>        Hub host. Default: 127.0.0.1 or RELAYBASE_HOST.
--state-dir <path>   Relaybase state directory.
--cwd <path>         Project root. Default: current directory.
--agent-config <path>
                     Select one external Agent configuration file for run-boundary reload.
--json               Print machine-readable output for supported commands.
--verbose            Include expanded detail for supported commands.
--restart-daemon     Safely replace the daemon before `start` or `tui`.
```

`--json` results can include `nextActions`: concrete follow-up actions with an owner, command when available, and evidence when Relaybase can name the failing boundary.

## agent

```powershell
relaybase agent --help
relaybase agent config status
relaybase agent config reload
relaybase agent provider status
relaybase agent provider connect
relaybase agent provider replace
relaybase agent provider validate
relaybase agent provider migrate --yes
relaybase agent provider cleanup-legacy
relaybase agent provider cleanup-legacy --yes
relaybase agent provider revoke
relaybase agent provider disconnect --yes
relaybase agent smoke-openrouter
relaybase agent live-correctness
relaybase agent live-command-matrix
relaybase agent live-folder-start
relaybase agent threads list
relaybase agent threads active
relaybase agent threads show <session-id>
relaybase agent threads context <session-id>
relaybase agent threads activate <session-id>
relaybase agent threads rename <session-id> <title>
relaybase agent threads clear <session-id>
relaybase agent threads export <session-id> --markdown
```

Config and provider commands use the token-gated daemon API. Connect and replace use daemon-owned OpenRouter OAuth PKCE; browser helpers receive a credential-scrubbed environment. `validate` retries the safe provider metadata check for a protected but unverified credential. Migration copies a legacy key into current-user DPAPI only after explicit confirmation. `cleanup-legacy` first previews one exact external assignment; `--yes` applies that bound preview atomically without a plaintext backup. It refuses shell-owned, ambiguous, stale, or insecurely writable sources. Disconnect is local-only. Revoke cannot report success without provider confirmation.

## repair

```text
relaybase repair
relaybase repair --agent-security
relaybase repair --agent-security --online
relaybase repair --agent-security --issue <code>
relaybase repair --agent-security --action <action-id> --plan
relaybase repair --agent-security --action <action-id> --yes
relaybase repair --agent-security --safe --plan
relaybase repair --agent-security --safe --yes
relaybase repair --agent-security --apply <preview-id> --yes
relaybase repair --operation <operation-id>
relaybase repair --agent-security --json
```

The initial repair registry contains the Agent security doctor. Bare `repair` and `--agent-security` run a local, silent diagnosis through the authenticated daemon. `--online` explicitly permits an OpenRouter credential probe; it is never implied. `--action` and `--safe` create a short-lived preview bound to the active config revision, credential identity, source fingerprint, and selected actions. `--plan` prints that preview; `--yes` authorizes exactly that preview. `--apply` resumes a stored preview, and `--operation` resolves a durable receipt after a lost response or restart.

Repair exits `0` for healthy or verified, `1` for transport/authentication/execution failure, `2` when findings or confirmation remain, `3` for a provider-owned or manual action, and `4` for stale state. `--json` emits one document and never prompts. Repair, daemon control, and token-gated Agent control commands do not load a project `.env` into the CLI process; legacy-source inspection and managed-credential decryption remain daemon-only.

`relaybase configure --repair` remains project setup repair. `relaybase repair-prefix` remains source-checkout command repair. Neither is reinterpreted by the top-level repair framework.

`smoke-openrouter`, `live-correctness`, `live-command-matrix`, and `live-folder-start` make real provider calls and require explicit credentials, model selection, and cost approval. They are not part of the default offline verification gate.

`live-acceptance` remains a compatibility alias for `live-correctness`.

Thread commands use the daemon Agent Gateway API. They do not read or edit `agent.sqlite` directly.

## tui

```powershell
relaybase serve
relaybase tui
relaybase tui --port 7777 --host 127.0.0.1
relaybase tui --restart-daemon
relaybase tui -- --theme dark
```

`relaybase tui` launches the Go Bubble Tea TUI as a client of the running daemon. It does not start apps, inspect ports, or manage process lifecycle locally. The bridge passes `--base-url` and `--state-dir` to the TUI using the same `--host`, `--port`, and `--state-dir` conventions as other Relaybase commands. TUI-specific arguments can be passed after `--`.

`relaybase tui --restart-daemon` performs the same bound restart workflow as `relaybase daemon restart` before the TUI is launched. A blocked or unverified restart fails the launch and, when a report was written, prints its redacted path instead of silently continuing against an uncertain daemon.

Inside the TUI, `/manage` opens the registered-app management table. Its confirmation-gated **Rename app** action edits the durable display name while preserving the stable app ID, route, current process, packages, panes, logs, history, and automation. Its final **Add to package** action changes only saved package membership. `/packages` opens the dedicated package table for creation, launch/run inspection, ordered member editing, rename, and definition deletion. Bare `/start` remains the faster app launcher and does not expose management actions.

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

## start

```powershell
relaybase start
relaybase start --plan
relaybase start --port 7777 --state-dir "$env:LOCALAPPDATA\Relaybase"
relaybase start --restart-daemon
relaybase start -- --theme dark
relaybase start <app-id>
npm.cmd start
```

With no app id, `start` is the daily launch bundle. It locates the packaged or repo-local TUI binary, builds the TUI binary first when a source checkout is missing it and Go is available, launches the Go TUI through the Node bridge, and lets the bridge safely ensure the Relaybase daemon. It does not silently start unknown user apps or repair the global command prefix.

With an app id, `start <app-id>` keeps the existing lifecycle meaning and starts that registered app through the daemon mutation API.

`--plan` prints the bundled steps without launching the TUI.

## daemon restart

```powershell
relaybase daemon restart
relaybase daemon restart --json
```

The restart command discovers and authenticates the current daemon, obtains a state-bound preview, and refuses to proceed while an Agent run, lifecycle operation, or package run is active. It quiesces new mutations, stops only Relaybase-owned app processes, preserves externally managed processes, shuts down the old daemon, starts a distinct daemon instance, verifies the new instance ID, and restores the previously running owned apps through normal lifecycle operations.

Only one restart lease may exist per state directory. A stale lease is recovered only after its owning process is gone and the bounded stale interval has elapsed. Restart results and per-app restore outcomes are written as redacted JSON under `<state-dir>/restarts/`. A failed app stop attempts to restore apps already stopped before returning control.

If a daemon service reports a shutdown warning but the old listener still closes and a distinct instance starts, the restart is reported as completed with warnings instead of as a clean success. The CLI and in-app result point to the redacted restart report for recovery details.

## check

```powershell
relaybase check
relaybase check --plan
```

`check` is read-only. It runs:

- TUI/toolchain doctor
- `relaybase health`
- `relaybase list --verbose`

It does not run the package dry-run, make OpenRouter requests, start unknown user apps, run `npm link`, or remove command shims.

## diagnose-token

```powershell
relaybase diagnose-token
relaybase diagnose-token --json
```

`diagnose-token` compares the selected state-directory identity with the reachable Relaybase daemon and verifies whether the selected session token is accepted. It reports only token presence and authentication status; it never prints or copies token contents. The older `diagnose_token` spelling remains a compatibility alias.

## repair-prefix

```powershell
relaybase repair-prefix --diagnose
relaybase repair-prefix --plan
relaybase repair-prefix
```

`repair-prefix` is the explicit source-checkout prefix repair. `--diagnose` checks command visibility and whether the command targets the current checkout without changing anything. `--plan` prints the intended repair. The mutating form runs `npm link --no-audit --no-fund`; on Windows it removes `relaybase.ps1` only when the sibling `relaybase.cmd` exists and both are recognized npm-generated Relaybase shims. Unrecognized/custom PowerShell shims are preserved. Removal uses an atomic rename and restores the shim if deletion fails. If link or verification fails, it stops without launching the normal start workflow.

## verify

```powershell
relaybase verify
relaybase verify --full
relaybase verify --release
relaybase verify --live
relaybase verify --race
relaybase verify --all
relaybase verify --plan --full --release
```

The default verification gate runs formatting, lint, typecheck, Node tests, Jest tests, and `relaybase health`.

`--full` adds agent tests, TUI build/test/vet/snapshot/smoke, 8-pane smoke, package check, and clean-worktree hygiene.

`--release` adds GoReleaser config validation. `--race` adds Go race tests and preserves the documented environment-blocked race exit code. `--all` combines the full and release gates. `--live` explicitly opts into live OpenRouter Operator Agent checks. Live checks are never run by default, including under `--all`.

`--plan` prints the selected gate without executing it.

`package:check`, used by the full gate, runs `npm pack --dry-run --json`. By default it creates and removes a disposable cache under the operating-system temp directory. Set `RELAYBASE_PACKAGE_NPM_CACHE` only when an intentional persistent cache override is required.

## register

```powershell
relaybase register C:\path\to\project --plan
relaybase register C:\path\to\project
relaybase register C:\path\to\project --yes --json
relaybase register C:\path\to\project --no-verify
relaybase register C:\path\to\project\relaybase.app.json --plan
```

Folder mode locates or proposes `relaybase.app.json`, compiles the launch plan, binds approval to the manifest, generated-file revisions, and verification policy, and registers only after confirmation. Exact manifest-file mode is strict. `--plan` and `--dry-run` never mutate; `--yes` applies the exact preview without an interactive prompt. Noninteractive apply without `--yes` fails closed.

The default is one quick bounded proof: start, declared health, stop, and backend-port closure. Success ends with the app stopped. `--no-verify` performs zero lifecycle mutation and returns `registered_unverified`. JSON output includes the verification status, attempt and port metadata, health target, stop result, classified failure, and ordered repair previews.

The operator console automatically prepares a read-only preview when one deterministic repair is available without more input, or opens an arrow-key chooser when several safe repairs are available. Applying the selected preview remains confirmation-gated. Repeating the unchanged failed launch plan performs no new lifecycle attempt and preserves the prior repair choices.

Stable registration codes include `REGISTER_MANIFEST_NOT_FOUND`, `REGISTER_MANIFEST_INVALID`, `REGISTER_INPUT_REQUIRED`, `REGISTER_PREVIEW_REQUIRED`, `REGISTER_CONFIRMATION_REQUIRED`, `REGISTER_PREVIEW_STALE`, `REGISTER_REGISTRY_FAILED`, and `REGISTER_ALREADY_CURRENT`. Verification failures use the stable `REGISTER_VERIFY_*` codes documented in [Troubleshooting](troubleshooting.md).

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
relaybase repair-prefix --diagnose
relaybase register <manifest>
relaybase start <app-id>
relaybase stop <app-id>
relaybase restart <app-id>
relaybase status
relaybase logs <app-id>
```

`serve` starts the localhost daemon. `mcp` runs Relaybase as a stdio MCP server. `tui` launches the Go terminal client when a matching binary is installed or configured. `repair-prefix` explicitly diagnoses or repairs a source-checkout global command link. `register` writes a manifest into Relaybase state. `start`, `stop`, and `restart` call the daemon API and require the local mutation token. `status` is a compatibility alias for `list`. `logs` prints the daemon's recent log snapshot for one app.
