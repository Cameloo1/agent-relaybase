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

The TUI Go wrapper defaults both `GOCACHE` and `GOTMPDIR` to OS temp directories under `relaybase-go-build-cache` and `relaybase-go-build-tmp`. Go test binaries execute from `GOTMPDIR`; keeping cache and execution paths outside the checkout avoids hidden repo-local mutations and Windows Application Control policies that can block newly compiled test executables from workspace-local temp folders.

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

For day-to-day source checkout work, use the bundled commands first:

```powershell
npm.cmd run tui:build
npm.cmd start
npm.cmd run check
npm.cmd run verify
```

`npm.cmd run tui:build` creates the current-platform development binary required by a fresh checkout. `npm.cmd start` then calls `relaybase start`, which launches the TUI through the Node bridge and lets the bridge safely ensure the daemon. `npm.cmd run check` performs read-only local diagnosis without a package dry-run. `npm.cmd run verify` runs the default source-checkout verification gate; add `-- --full`, `-- --release`, `-- --live`, or `-- --race` for deeper gates.

After the TUI build, `npm.cmd start` is the no-link entrypoint because it launches the source checkout directly. It does not inspect or mutate the global command prefix. When a global command is intentional, use `npm.cmd run relaybase -- repair-prefix --diagnose` or `--plan` first, then run `npm.cmd run relaybase -- repair-prefix` explicitly. Only that repair command may run `npm link`. On Windows it preserves unrecognized/custom PowerShell shims and removes only a recognized npm-generated Relaybase `.ps1` shim with a recognized `.cmd` sibling, using atomic rename/restore behavior on failure.

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

Release package verification builds the JavaScript runtime and all six TUI binaries before inspecting tarballs:

```powershell
npm.cmd run build:runtime
npm.cmd run tui:build:all
npm.cmd run package:prepare-platforms
npm.cmd run package:check:strict
npm.cmd run package:check-platforms
npm.cmd run package:install-smoke
```

The normal package check remains usable on hosts without Go and reports when strict binary proof is unavailable. Release verification is strict: the slim root tarball must contain the compiled runtime, pin every optional platform package to the same version, and exclude source, tests, caches, reports, and generated binaries. Every platform tarball must contain its exact executable, and a root-plus-platform tarball install must execute the packaged TUI and compiled daemon from a disposable directory. A normal published installation does not execute TypeScript from `node_modules` and does not require Go.

Package checks use a newly created OS-temp npm cache by default and remove it when the check finishes, including failure paths. They package the explicitly built artifacts with npm lifecycle scripts disabled, so inspection cannot rebuild or replace an accepted native module. Clean CI and release runners therefore run `npm run build:runtime` before package inspection or disposable installation; omitting that preparation leaves no compiled CLI in the root tarball. The ordinary npm publication path still runs `prepack`. Set `RELAYBASE_PACKAGE_NPM_CACHE` to an explicit directory only when the operator deliberately wants to preserve and reuse that cache.

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

`npm run release:dry-run` writes unsigned snapshot evidence under `dist/` and must produce `dist/relaybase-tui-checksums.txt` in a GoReleaser-capable environment. Snapshots verify cross-platform naming and archive configuration; they are not publishable Windows artifacts. Do not stage generated `dist/` outputs.

The protected `.github/workflows/release.yml` workflow:

1. verifies the tag, source, toolchain, GoReleaser configuration, and all package versions;
2. builds all six TUI targets with deterministic Windows version metadata;
3. uploads only the two Windows executables to SignPath's GitHub trusted-build connector;
4. waits for the required SignPath approval, accepts the signed files, and rejects missing certificate tables;
5. packs and hashes the root package plus six platform packages without rebuilding the signed files;
6. installs the exact candidate on a Windows runner, requires valid Windows Authenticode trust, and executes the packaged TUI;
7. publishes those exact tarballs to npm and the GitHub release only after every prior gate passes.

Production GitHub assets are the npm `.tgz` files, `release-manifest.json`, and `relaybase-release-checksums.txt` under generated `dist/release/`. The workflow is idempotent: an already-published package version is verified and skipped; unexpected npm lookup failures stop publication.

## One-time publisher configuration

Windows signing uses SignPath Foundation rather than Azure. The public [code signing policy](code-signing-policy.md) and `.signpath/windows-binaries.xml` are the repository-owned configuration. After SignPath approves the project, configure:

- repository secret `SIGNPATH_API_TOKEN`;
- repository variable `SIGNPATH_ORGANIZATION_ID`;
- SignPath project `relaybase`;
- signing policy `release-signing`;
- artifact configuration `windows-binaries`, using the checked-in XML.

SignPath Foundation requires a manual approval for each release. The unsigned workflow artifact has one-day retention and is never uploaded to the public GitHub release.

npm trusted publishing is configured separately for all seven packages. For each package, select GitHub Actions and enter:

- organization or user: `Cameloo1`;
- repository: `relaybase`;
- workflow filename: `release.yml`;
- environment: `npm-production`;
- allowed action: `npm publish`.

The workflow grants `id-token: write`, uses a GitHub-hosted runner, Node 24, and npm 11.5.1 or newer. `NPM_TOKEN` is retained only as an optional bootstrap credential for the first publication before the package settings exist. After all seven trusted publishers are configured and proven, remove that write token. CI and local dry-runs never publish.

See `docs/artifact-hygiene.md` for generated artifact locations, clean-worktree
checks, and safe cleanup rules.

Release verification must capture:

- `go version`
- `go env GOVERSION GOOS GOARCH GOMOD GOMODCACHE`
- `goreleaser --version`
- TUI test, vet, race, and build results
- direct binary launch result
- `relaybase tui` bridge launch result
- GoReleaser checksum artifact path and archive inspection, or an explicit GoReleaser environment blocker
- Authenticode certificate-table presence for both Windows binaries
- Windows `Get-AuthenticodeSignature` status and exact-candidate packaged execution
