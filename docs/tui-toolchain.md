# TUI Development And Toolchain

Relaybase's daemon and CLI are Node/TypeScript. The terminal UI is a separate Go Bubble Tea client under `tui/`, so TUI build, test, vet, race, and release archive checks require Go.

## Required Tools

- Node.js `>=24`
- npm from the Node install
- Go `1.25.x` for TUI verification and builds
- GoReleaser for release archive and checksum dry-runs

The Go version source of truth is `tui/go.mod`. The root `.go-version` mirrors that value for local toolchain managers.

## Windows Setup

Install Go `1.25.x` from the official Go distribution or an approved local package manager. After installation, open a new PowerShell or Command Prompt so `PATH` is refreshed.

Verify the local toolchain:

```powershell
where.exe go
go version
go env GOVERSION GOOS GOARCH GOMOD GOMODCACHE
npm.cmd run doctor
npm.cmd run tui:doctor
npm.cmd run doctor:tui
```

If `go` is not found, TUI scripts fail closed with a Relaybase diagnostic and a retry command. Missing Go is an environment/tooling blocker, not a Node daemon product failure.

The TUI Go wrapper keeps `GOCACHE` under the repo-local ignored `.relaybase/go-build-cache` directory, but defaults `GOTMPDIR` to the OS temp directory under `relaybase-go-build-tmp`. Go test binaries execute from `GOTMPDIR`; keeping that execution path outside the checkout avoids Windows Application Control policies that can block newly compiled test executables from workspace-local temp folders.

## macOS Setup

Install Go `1.25.x` from the official Go distribution or an approved local package manager such as Homebrew. Open a new terminal after installation so the shell can see `go`.

Verify the local toolchain:

```bash
command -v go
go version
go env GOVERSION GOOS GOARCH GOMOD GOMODCACHE
npm run doctor
npm run tui:doctor
npm run doctor:tui
```

## Linux Setup

Install Go `1.25.x` from the official Go distribution or a distro/package-manager source that provides the required version. Open a new shell after installation if `PATH` changes.

Verify the local toolchain:

```bash
command -v go
go version
go env GOVERSION GOOS GOARCH GOMOD GOMODCACHE
npm run doctor
npm run tui:doctor
npm run doctor:tui
```

## Local TUI Checks

Run TUI checks from the repository root:

```powershell
npm.cmd run doctor
npm.cmd run tui:doctor
npm.cmd run tui:test
npm.cmd run tui:vet
npm.cmd run tui:race
npm.cmd run tui:snapshot
npm.cmd run tui:build
```

On macOS and Linux, use the same npm scripts without `.cmd`:

```bash
npm run doctor
npm run tui:doctor
npm run tui:test
npm run tui:vet
npm run tui:race
npm run tui:snapshot
npm run tui:build
```

`npm run tui:snapshot` runs the deterministic render snapshot lane:

```bash
go test ./internal/tui/views -run TestGolden -count=1
```

`npm run tui:race` runs `go test -race ./...`. If the local Go
host/toolchain cannot run race-enabled tests, the script prints an unsupported
race diagnostic and exits with code `2`. That is a blocked race check, not a
pass.

`npm.cmd run tui:build` writes the current platform binary under `bin\relaybase-tui\`, for example:

```powershell
bin\relaybase-tui\relaybase-tui-windows-amd64.exe
```

On macOS and Linux, the output uses the platform name:

```bash
bin/relaybase-tui/relaybase-tui-darwin-arm64
bin/relaybase-tui/relaybase-tui-linux-amd64
```

Direct launch after the daemon is running:

```powershell
relaybase serve
relaybase tui
.\bin\relaybase-tui\relaybase-tui-windows-amd64.exe --base-url http://127.0.0.1:7777 --state-dir "$env:LOCALAPPDATA\Relaybase"
```

Package dry-runs classify the TUI binary path:

```powershell
npm.cmd run package:check
$env:RELAYBASE_REQUIRE_TUI_BINARY = "1"; npm.cmd run package:check; Remove-Item Env:\RELAYBASE_REQUIRE_TUI_BINARY
```

The normal package check remains usable on hosts without Go and reports the package as source-only until the binary is built. Release verification should use the strict environment variable after `npm.cmd run tui:build` so the tarball must include the current-platform binary.

## Release Checks

GoReleaser is required for archive/checksum verification:

```powershell
npm.cmd run release:check
npm.cmd run release:dry-run
```

On macOS and Linux:

```bash
npm run release:check
npm run release:dry-run
```

The local release scripts fail closed when GoReleaser is missing. The diagnostic
names the blocked release command and points back to the same npm script to
rerun after GoReleaser is installed or after the check is moved to CI.

GoReleaser builds the six supported TUI binary names:

- `relaybase-tui-windows-amd64.exe`
- `relaybase-tui-windows-arm64.exe`
- `relaybase-tui-darwin-amd64`
- `relaybase-tui-darwin-arm64`
- `relaybase-tui-linux-amd64`
- `relaybase-tui-linux-arm64`

`npm run release:dry-run` writes snapshot artifacts under `dist/` and must
produce `dist/relaybase-tui-checksums.txt` in a GoReleaser-capable environment.
Do not stage generated `dist/` outputs unless a release task explicitly asks for
them.

See `docs/artifact-hygiene.md` for generated artifact locations, clean-worktree
checks, and safe cleanup rules.

Release verification must capture:

- `go version`
- `go env GOVERSION GOOS GOARCH GOMOD GOMODCACHE`
- `goreleaser --version`
- TUI test, vet, race, and build results
- direct binary launch result
- `relaybase tui` bridge launch result
- GoReleaser checksum artifact path and archive inspection, or an explicit
  GoReleaser environment blocker
