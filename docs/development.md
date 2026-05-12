# Development

Relaybase is a Node 24 TypeScript package. The package bin is `relaybase`, backed by `bin/relaybase.cjs`.

## Common Commands

```powershell
npm.cmd run relaybase -- serve
npm.cmd run relaybase -- configure
npm.cmd run relaybase -- open
npm.cmd run relaybase -- health
```

Full local verification:

```powershell
npm.cmd run verify
```

Package check:

```powershell
npm.cmd run package:check
```

## Verification Gate

`npm.cmd run verify` runs:

```text
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:jest
npm run smoke
```

`npm test` runs Node's built-in test suite against `tests/*.test.ts`.

`npm run test:jest` runs the Jest compatibility tests with `jest.config.mjs`.

`npm run smoke` runs the read-only CLI health command:

```text
node --experimental-strip-types src/cli.ts health
```

## CI

The GitHub Actions workflow runs the release verification gate on:

- `windows-latest`
- `ubuntu-latest`
- `macos-latest`

The package job runs after verification and executes `npm run package:check`.

## Package Contents

The npm package includes:

```text
bin/
src/
docs/
examples/
skills/
```

The package requires Node `>=24.0.0`.

## Repo-Local Skill

The repo includes a Codex skill at:

```text
skills/relaybase-dev/SKILL.md
```

The skill describes the Relaybase-first local development workflow: prefer stable Relaybase routes, app manifests, lifecycle actions, logs, routed health, and stop checks; use direct ports only as a documented fallback.

## Windows Helper Wrapper

On Windows/Codex App, use the checked-in wrapper for helper actions:

```powershell
.\skills\relaybase-dev\scripts\relaybase-dev.cmd -Action preflight
```

The wrapper calls `relaybase-dev.ps1` with process-local execution-policy bypass and preserves the helper exit code. It does not require `Set-ExecutionPolicy`.

The skill reference is summarized in [relaybase-dev-skill.md](relaybase-dev-skill.md).
