# Artifact Hygiene

Relaybase release verification must be repeatable from a clean or disposable
checkout. Generated evidence is useful, but it should not create surprise source
changes or hide unrelated user work.

## Committed Paths

Use these paths only for intentional source, current public documentation,
scripts, or tests:

- `docs/` for current verified documentation.
- `scripts/` for reusable local or CI tooling.
- `src/`, `tests/`, and `tui/` for product and test source.

`reports/` is ignored and local by default. Promote a report only when a task
explicitly defines it as stable public documentation; otherwise keep plans,
raw evidence, diagnostics, and readiness notes out of publication branches.

## Ignored Generated Paths

Generated outputs should use ignored locations:

- `artifacts/` for TUI evidence, PTY transcripts, screenshots, terminal
  recordings, exported verification bundles, and captured before/after status
  JSON.
- `dist/` for GoReleaser snapshot archives and checksum outputs.
- `dist/release/` for hashed npm/GitHub release candidates and `dist/signpath-signed/` for downloaded signing output.
- `coverage/` for coverage reports.
- `*.tgz` for npm package dry-run tarballs if a package command creates one.
- `.relaybase/` for local daemon state inside the repo, though smoke tests
  should prefer an OS temp state directory.
- `bin/relaybase-tui/relaybase-tui-*` for generated TUI binaries.
- `packages/relaybase-tui-*/bin/relaybase-tui-*` for generated platform-package payloads.
- `dist-runtime/` for the compiled npm runtime generated during package preparation.
- `tui/cmd/relaybase-tui/rsrc_windows_*.syso` for generated PE version-resource objects; `winres.json` remains tracked source.

`bin/relaybase-tui/README.md` remains tracked so the expected binary directory
is visible in source. Generated platform binaries in that directory are ignored
by Git but can still be included in npm package dry-runs when built.

## Clean-Worktree Commands

Run the strict local gate:

```powershell
npm.cmd run verify:clean-worktree
```

On macOS and Linux:

```bash
npm run verify:clean-worktree
```

The command runs:

```bash
git status --short --untracked-files=all
```

It fails when any unexpected tracked or untracked source path is dirty. It does
not delete, stage, or reset files.

For release verification, capture before and after status snapshots under
`artifacts/`:

```powershell
npm.cmd run verify:workspace:before
npm.cmd run verify:workspace:after
```

Those commands write:

- `artifacts/workspace-status-before.json`
- `artifacts/workspace-status-after.json`

Both files are generated evidence and are ignored by Git.

## Report Exceptions

When a planning task intentionally creates only local report files, this
diagnostic variant can classify report paths as allowed while still failing on
source or generated artifacts outside `reports/`:

```powershell
npm.cmd run verify:clean-worktree:allow-reports
```

Use the strict `verify:clean-worktree` command for final release verification.

## Safe Cleanup

Do not use `git clean` or reset commands unless the user explicitly authorizes
that action. Before removing anything, inspect the dirty set:

```powershell
git status --short
git diff --stat
git diff --name-only
git ls-files --others --exclude-standard
```

Generated ignored paths can be removed after inspection and approval. Keep
source changes, stable reports, and any user-authored files intact unless a
publication task explicitly classifies them for staging, deletion, or carryover.

## CI Behavior

CI runs `npm run verify:clean-worktree` after Node, Go TUI, TUI build, package,
and release artifact checks. Build outputs under ignored paths are allowed, but
unexpected source or report mutations fail the job.
