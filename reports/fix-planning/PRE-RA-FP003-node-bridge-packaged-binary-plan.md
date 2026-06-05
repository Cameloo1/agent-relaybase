# PRE-RA-FP003 Node Bridge Packaged Binary Plan

Date: 2026-06-01

Mode: planning only. No product code was changed by this task.

## 1. Current Bridge Behavior

`relaybase tui` is wired through the Node CLI in `src/cli.ts`. The command parses normal Relaybase options, splits TUI passthrough arguments after `--`, then calls `runRelaybaseTui(options, passthroughArgs)` from `src/tuiBridge.ts`.

Current launch behavior:

- Builds daemon base URL from `--host` and `--port`.
- Checks daemon reachability first with `GET /__hub/api/state`.
- If the daemon is unavailable, fails closed with a daemon diagnostic and does not resolve or spawn a TUI binary.
- Resolves a TUI binary only after the daemon is reachable.
- Spawns the resolved binary with `shell: false` and `stdio: "inherit"`.
- Forwards child exit code, including signal-derived exit codes for `SIGINT` and `SIGTERM`.
- Passes connection details as argv: `--base-url <url>` and `--state-dir <dir>`.
- Passes TUI-only arguments after the Node `--` separator.
- Passes environment details through `RELAYBASE_URL`, `RELAYBASE_HOST`, `RELAYBASE_PORT`, and `RELAYBASE_STATE_DIR`.
- Does not pass raw auth token content from the bridge.

The current bridge is not the process manager. It does not start apps, stop apps, inspect app ports, read manifests for lifecycle decisions, or own lifecycle state. That boundary must remain unchanged.

## 2. Current Binary Resolution Behavior

`src/tuiBridge.ts` currently resolves binaries in this order:

| Order | Source                    | Current path behavior                                                                                                                                                                                                              |
| ----- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `RELAYBASE_TUI_BIN`       | Uses the exact env var path if it exists. If it is set but missing, the bridge reports that exact missing path and stops.                                                                                                          |
| 2     | Package assets            | `<packageRoot>/bin/relaybase-tui/<platform binary>`. In the repository checkout, `packageRoot` resolves to the repo root, so this also acts as the local development build path.                                                   |
| 3     | Optional platform package | `<node_modules parent>/relaybase-tui-<os>-<arch>/bin/<platform binary>`. Current docs call this `@cameloo/relaybase-tui-<platform>-<arch>`, but the code currently checks the unscoped directory name `relaybase-tui-<os>-<arch>`. |

Supported binary names are already centralized:

- `relaybase-tui-windows-amd64.exe`
- `relaybase-tui-windows-arm64.exe`
- `relaybase-tui-darwin-amd64`
- `relaybase-tui-darwin-arm64`
- `relaybase-tui-linux-amd64`
- `relaybase-tui-linux-arm64`

What is missing today:

- No actual current-platform binary exists under `bin/relaybase-tui/`.
- No global `relaybase-tui` PATH fallback exists.
- The optional platform package path is not yet proven and appears to be inconsistent with the scoped package name documented in `docs/cli.md` and `docs/tui-architecture.md`.
- The missing-binary diagnostic does not explicitly distinguish repo-local development build from installed package asset because those currently share the same path shape.

## 3. Why The Packaged Binary Is Missing

This is a packaging/environment blocker, not evidence of a daemon/control-plane product failure.

Observed evidence:

- `bin/relaybase-tui/` contains only `README.md`.
- `npm.cmd run tui:doctor` reports the expected Windows amd64 binary is missing:
  `bin\relaybase-tui\relaybase-tui-windows-amd64.exe`.
- `where.exe go` reports no Go executable on this host.
- `npm.cmd run tui:doctor` reports Go `1.24` is required but missing.
- `where.exe relaybase-tui` reports no globally installed TUI binary.
- `npm.cmd run package:check` succeeds only when allowed to use the npm cache outside the sandbox, and the dry-run tarball includes `bin/relaybase-tui/README.md` but no TUI executable.

The build script already intends to write binaries to the bridge's package-asset path:

```text
scripts/tui-go.mjs -> bin/relaybase-tui/<platform binary>
```

The release gap is that no Go-capable verification run has produced that binary yet. Because the binary is absent, the current npm dry-run cannot include it and `relaybase tui` cannot launch it after the daemon check passes.

## 4. Recommended Binary Resolution Order

Use this order for the release-readiness fix:

| Order | Source                                      | Recommendation                                                                                                                                                                                                              |
| ----- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `RELAYBASE_TUI_BIN`                         | Keep as the highest-priority explicit override. It must launch the exact file supplied by the user and fail closed if the path is missing.                                                                                  |
| 2     | Repo-local development binary               | Explicitly treat `<repo>/bin/relaybase-tui/<platform binary>` as the dev-checkout build output when running from source. This can remain the same path as package assets, but diagnostics/tests should call it out clearly. |
| 3     | Packaged binary inside the main npm package | Use `<packageRoot>/bin/relaybase-tui/<platform binary>` for installed packages. This is the lowest-risk release path because `package.json` already includes `bin/`.                                                        |
| 4     | Platform-specific optional npm package      | Keep as planned, but fix or document the scoped/unscoped package-name mismatch before relying on it. Do not make this the first release blocker fix.                                                                        |
| 5     | Globally installed `relaybase-tui`          | Add only if implemented with safe PATH lookup and `shell: false`. It is useful as a fallback, but should not be the primary release packaging proof.                                                                        |
| 6     | Helpful missing-binary diagnostic           | Preserve fail-closed diagnostics with exact expected paths and build/install commands.                                                                                                                                      |

The bridge may keep daemon reachability before binary resolution for normal operator UX: if the daemon is offline, the user needs `relaybase serve` first. Binary-resolution tests and package smoke tests should use a fake reachable daemon or dependency injection so missing/package binary behavior remains independently provable.

## 5. Windows, macOS, And Linux Path Handling

Windows requirements:

- Use `.exe` names for Windows targets.
- Use `path.join` for all candidate paths.
- Keep `spawn(..., { shell: false })` for the TUI process.
- Canonical local commands should use `npm.cmd`.
- `relaybase tui --port <port> --state-dir <dir>` must produce TUI argv:
  `--base-url http://<host>:<port> --state-dir <dir>`.
- Do not spawn through `cmd.exe`, PowerShell, or shell strings to launch the TUI binary.

macOS and Linux requirements:

- Use extensionless binary names.
- Preserve executable bits for packaged artifacts.
- Keep argv-based passthrough handling, including TUI args after `--`.
- If a global PATH fallback is added, resolve the executable path explicitly and spawn that resolved path with `shell: false`.

Cross-platform package checks:

- `npm run tui:build` should produce only the current platform binary.
- `npm run tui:build:all` or GoReleaser should produce all six release names.
- `npm pack --dry-run` must show the expected binary for the packaging strategy being verified.

## 6. npm Package Inclusion Plan

Recommended lowest-risk strategy for now:

1. Keep the main `@cameloo/relaybase` package as the first package lane.
2. Build the current platform binary into `bin/relaybase-tui/` with `npm run tui:build`.
3. For release packaging, build all target binaries with either `npm run tui:build:all` or GoReleaser.
4. Include generated TUI binaries in the npm tarball through the existing `files: ["bin/", ...]` configuration.
5. Verify package contents with `npm run package:check`.
6. Keep generated binaries out of ordinary source commits unless the release policy explicitly says npm source tarballs carry binaries.

This avoids introducing a new optional-package release architecture before the existing bridge/package path is proven.

Platform-specific optional npm packages can come later if the main package becomes too large or if release policy needs per-platform installs. Before that route is used, the implementation must align the code's platform-package candidate directory with the documented package name and add tests for Windows, macOS, and Linux package layouts.

## 7. Dev-Mode Launch Plan

Recommended behavior:

- Do not auto-build from `relaybase tui` by default.
- If Go is installed and no binary exists, fail with the existing actionable command: `npm run tui:build`.
- After `npm run tui:build`, a development checkout should launch through the same package-asset path:
  `bin/relaybase-tui/<platform binary>`.
- Keep `RELAYBASE_TUI_BIN` for local override, temporary builds, or externally downloaded binaries.
- If auto-build is ever desired, gate it behind an explicit opt-in flag or env var and never run it in installed-package mode.

Development proof should use disposable state:

```powershell
npm.cmd run tui:build
node --experimental-strip-types src\cli.ts serve --port <port> --state-dir <temp-state-dir>
node --experimental-strip-types src\cli.ts tui --port <port> --state-dir <temp-state-dir>
```

The smoke lane must not start unknown user apps or use the user's normal Relaybase state.

## 8. Security Review

Current safe behavior to preserve:

- The bridge spawns the TUI with `shell: false`.
- TUI args are passed as an argv array, not concatenated into a shell command.
- Stdio is inherited, so stderr diagnostics are not swallowed.
- Exit codes are forwarded.
- Daemon connection details are passed as argv/env values without moving lifecycle logic into the TUI.
- The bridge fails closed when `RELAYBASE_TUI_BIN` points to a missing file.

Security requirements for future implementation:

- Do not use `cmd /c`, PowerShell command strings, or shell concatenation for binary launch.
- Do not sanitize by string interpolation; preserve structured argv.
- If global PATH lookup is added, resolve to an executable path first and spawn that path directly.
- Do not pass auth token contents in package diagnostics, argv previews, or reports.
- Do not auto-build the TUI without explicit user/developer intent.
- Do not make missing-binary recovery start apps or mutate daemon lifecycle state.

## 9. Proposed Implementation Tasks

### PRE-RA-FIX003A - Bridge Resolution Clarification And Tests

Likely files to change:

- `src/tuiBridge.ts`
- `tests/unit.test.ts`
- `docs/cli.md`
- `docs/tui-architecture.md`

Commands:

- `npm.cmd run test`
- `npm.cmd run test:jest`
- `npm.cmd run lint`
- `npm.cmd run typecheck`
- `node --experimental-strip-types src\cli.ts tui --help`

Acceptance criteria:

- Resolution order is documented and tested as `RELAYBASE_TUI_BIN`, dev/package binary, optional platform package, optional global binary, diagnostic.
- The scoped/unscoped optional platform package path is either fixed or explicitly documented as planned.
- Missing-binary diagnostics remain clear.
- Daemon-unavailable diagnostics still happen before spawning.
- No lifecycle logic moves into the TUI.

### PRE-RA-FIX003B - Real Dev Binary Launch Proof

Likely files to change:

- `tui/go.sum` if not already generated by a Go-capable run.
- No product source unless a real bridge defect appears.
- Possibly `reports/release-candidate/test-matrix.md` after evidence exists.

Commands:

- `go version`
- `cd tui; go env GOVERSION GOOS GOARCH GOMOD GOMODCACHE`
- `npm.cmd run tui:build`
- `Get-ChildItem bin\relaybase-tui -Force`
- `node --experimental-strip-types src\cli.ts tui --help`
- `node --experimental-strip-types src\cli.ts tui --port <port> --state-dir <temp-state-dir>`

Acceptance criteria:

- Current-platform binary exists under `bin/relaybase-tui/`.
- `relaybase tui` launches that binary when pointed at a reachable test daemon.
- The bridge forwards stderr and exit code.
- The launch uses disposable state only.

### PRE-RA-FIX003C - npm Package Binary Dry-Run Proof

Likely files to change:

- `package.json` only if `files` does not include the built binary.
- No source changes if the current `bin/` inclusion works after build.
- Release report files only after real evidence exists.

Commands:

- `npm.cmd run tui:build`
- `npm.cmd run package:check`
- Inspect dry-run output for `bin/relaybase-tui/<platform binary>`.

Acceptance criteria:

- Package dry-run includes the expected current-platform binary, or the report intentionally documents that npm package mode is source-only and requires external `RELAYBASE_TUI_BIN`.
- Missing-binary diagnostic remains helpful when the binary is absent.
- Generated package artifacts are not staged accidentally.

### PRE-RA-FIX003D - Optional Platform Package Decision

Likely files to change:

- `src/tuiBridge.ts`
- `tests/unit.test.ts`
- `docs/cli.md`
- `docs/tui-toolchain.md`
- Possibly package metadata for optional dependencies if this lane is selected.

Commands:

- `npm.cmd run test`
- `npm.cmd run lint`
- `npm.cmd run typecheck`
- Package-layout fixture tests for Windows, macOS, and Linux names.

Acceptance criteria:

- If optional platform packages are supported, the code and docs agree on scoped package paths.
- If deferred, docs mark optional packages as planned and do not rely on them for release readiness.

### PRE-RA-FIX003E - Installed-Package Smoke

Likely files to change:

- A smoke script under `scripts/` if needed.
- `package.json` if adding `tui:smoke`.
- Release-candidate reports after evidence exists.

Commands:

- `npm.cmd run package:check`
- Install or unpack the dry-run package into a disposable temp workspace.
- `relaybase tui --port <port> --state-dir <temp-state-dir>`
- Direct `relaybase-tui` binary launch from the unpacked package.

Acceptance criteria:

- Installed package layout resolves the same binary path the bridge expects.
- `RELAYBASE_TUI_BIN=<path>` launches exactly that path.
- Missing binary produces a useful diagnostic.
- Exit code and stderr are forwarded.

## 10. Acceptance Criteria

This blocker is fixed only when all of the following have real evidence:

- `RELAYBASE_TUI_BIN=<path>` launches that exact binary.
- A dev checkout can launch TUI through `relaybase tui` after `npm run tui:build`.
- `npm run package:check` includes the expected TUI binary, or the package intentionally documents an external install path and release readiness accepts that policy.
- Windows launch uses `.exe` correctly.
- macOS/Linux launch uses extensionless target names correctly.
- Missing-binary diagnostics remain helpful and fail closed.
- Exit code and stderr are forwarded.
- The Node bridge does not spawn through an unsafe shell.
- `relaybase tui --port <port> --state-dir <dir>` passes connection details to the TUI.
- No product lifecycle logic moves into the TUI.

## Recommendation

The lowest-risk packaging strategy is to keep the main npm package lane and make the existing `bin/relaybase-tui/<platform binary>` asset path real. Build the TUI with Go, verify the bridge launches it from that path, and confirm `npm pack --dry-run` includes it. Keep `RELAYBASE_TUI_BIN` as the operator override. Treat platform-specific optional npm packages and global PATH fallback as secondary hardening items, not the first P0 fix.

AI-agent prompts remain blocked. This is still a P0 release-readiness blocker until a real TUI binary is built, packaged or intentionally externalized, and launched through the Node bridge with evidence.
