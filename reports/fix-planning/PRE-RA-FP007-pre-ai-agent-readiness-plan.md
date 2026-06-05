# PRE-RA-FP007 Pre-AI-Agent Readiness Plan

Date: 2026-06-02

Mode: planning only. This report does not implement product-code fixes, does
not implement OpenRouter, does not implement the OpenAI Agents SDK TypeScript
path, and does not start the Relaybase Operator Agent roadmap.

## 1. Executive Summary

Decision: `BLOCK_AI_AGENT_PROMPTS`.

Relaybase is not ready for future Operator Agent prompts because the Go Bubble
Tea TUI cannot yet be proven as a real buildable, launchable, keyboard-driven
approval surface. The Node/TypeScript daemon/control plane remains protected:
prior verifier and release reports say daemon APIs, lifecycle operations,
durable logs, grouping, auth failure, exports, redaction, and Node bridge
diagnostics passed or were source-hardened.

The remaining mandatory pre-AI-agent work is not to broaden product scope. It is
to close the concrete TUI and workspace gates:

- prove Go is available in at least one supported environment;
- build `relaybase-tui`;
- run TUI tests, vet, race policy, and snapshots;
- launch the real binary directly and through `relaybase tui`;
- prove daemon connection, unavailable-daemon diagnostics, preference
  persistence, and destructive-action confirmation gates;
- capture a PTY transcript, screenshot, or terminal recording;
- start and end verification from a clean or explicitly classified workspace.

GoReleaser/checksum proof blocks final binary release, but it can remain
release-track-only for AI-agent prompt readiness if the deferral is explicit and
the TUI build/launch/approval surface is already proven.

## 2. Source Inputs

This plan synthesizes:

- `reports/fix-planning/PRE-RA-FP000-release-readiness-triage.md`
- `reports/fix-planning/PRE-RA-FP001-go-toolchain-readiness-plan.md`
- `reports/fix-planning/PRE-RA-FP002-tui-verification-plan.md`
- `reports/fix-planning/PRE-RA-FP003-node-bridge-packaged-binary-plan.md`
- `reports/fix-planning/PRE-RA-FP004-tui-evidence-plan.md`
- `reports/fix-planning/PRE-RA-FP005-goreleaser-checksum-plan.md`
- `reports/fix-planning/PRE-RA-FP006-workspace-artifact-hygiene-plan.md`
- `reports/fix-planning/PRE-RA-blocker-status.json`
- `reports/release-candidate/release-readiness.md`
- `reports/release-candidate/hardening-report.md`
- `reports/release-candidate/tui-evidence-report.md`

No separate final verifier artifact was found by the latest repository search.
The latest direct evidence report currently says TUI evidence is `FAIL -
environment/package blocker`.

## 3. Ordered Implementation Sequence

| Order | Prompt                                             | Purpose                                                                                                                                                                    | Blocks AI-agent prompts                   | Primary blocker IDs                                                   |
| ----- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------- |
| 1     | `PRE-RA-FIX007A-GO-CAPABLE-TUI-VERIFICATION`       | Run a Go-capable verification lane: `go mod tidy`, generate `tui/go.sum`, build, test, vet, race policy, and snapshot.                                                     | Yes                                       | `PRE-RA-BLOCKER-GO-TOOLCHAIN`, `PRE-RA-BLOCKER-TUI-CHECKS-UNVERIFIED` |
| 2     | `PRE-RA-FIX007B-REAL-TUI-BINARY-BRIDGE-LAUNCH`     | Prove current-platform `relaybase-tui` exists and `relaybase tui` launches it through the Node bridge with safe argument forwarding.                                       | Yes                                       | `PRE-RA-BLOCKER-TUI-PACKAGE-BINARY`                                   |
| 3     | `PRE-RA-FIX007C-TUI-UX-EVIDENCE-GATE`              | Run the TUI smoke/evidence harness against isolated state and capture transcript/screenshot evidence for daemon connection, grouping, preferences, and confirmation gates. | Yes                                       | `PRE-RA-BLOCKER-TUI-EVIDENCE-CAPTURE`                                 |
| 4     | `PRE-RA-FIX007D-WORKSPACE-CLEAN-BASELINE`          | Start from a clean or disposable checkout, classify intended source/report changes, and prove clean-worktree before and after verification.                                | Yes                                       | `PRE-RA-BLOCKER-WORKSPACE-HYGIENE`                                    |
| 5     | `PRE-RA-FIX007E-PRE-AI-AGENT-GATE-RERUN`           | Run the full pre-AI-agent command matrix and update blocker status/release reports from evidence only.                                                                     | Yes                                       | all AI-agent-blocking PRE-RA blockers                                 |
| 6     | `PRE-RA-FIX007F-GORELEASER-CHECKSUM-RELEASE-TRACK` | Run GoReleaser check/dry-run and inspect checksums, or explicitly defer this as release-track-only.                                                                        | No, if explicitly deferred after 1-5 pass | `PRE-RA-BLOCKER-GORELEASER-CHECKSUM`                                  |

Existing prompt aliases in earlier reports map into this sequence:

- `PRE-RA-FIX001C` and `PRE-RA-FIX002A-GO-CAPABLE-VERIFICATION` map to
  `PRE-RA-FIX007A-GO-CAPABLE-TUI-VERIFICATION`.
- `PRE-RA-FIX003B`, `PRE-RA-FIX003C`, and the real-binary proof pieces map to
  `PRE-RA-FIX007B-REAL-TUI-BINARY-BRIDGE-LAUNCH`.
- `PRE-RA-FIX006A` through `PRE-RA-FIX006E` map to
  `PRE-RA-FIX007C-TUI-UX-EVIDENCE-GATE`.

## 4. Environment-Only Tasks

These should not require product-code changes unless real command output proves
otherwise:

| Task                      | Required action                                                                                          | Evidence                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Go availability           | Use a host or CI lane with Go matching `tui/go.mod`; do not install globally unless explicitly approved. | `go version`, `go env GOVERSION GOOS GOARCH GOMOD GOMODCACHE` from `tui/`.  |
| GoReleaser availability   | Use release CI or a local release workstation with GoReleaser installed.                                 | `goreleaser --version`, `npm run release:check`, `npm run release:dry-run`. |
| Terminal capture tooling  | Use available PTY/transcript/screenshot tooling; do not fake visual evidence if tooling is absent.       | transcript, screenshot, recording, or explicit "not verified" blocker.      |
| Clean/disposable checkout | Run final verification from a clean worktree or intentionally classified workspace.                      | `npm run verify:clean-worktree` before and after.                           |

## 5. Tasks That May Require Product Code Changes

Product code changes are not the default path. They are allowed only if real
verification exposes a specific defect.

| Surface                     | Expected change type                                                                                                                      | Guardrail                                                                |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Go TUI tests/build          | Fix compile, test, vet, race, or deterministic snapshot failures if observed on a Go-capable host.                                        | Do not add fake skips; do not remove confirmation gates.                 |
| Node bridge                 | Fix binary resolution, `.exe` handling, arg forwarding, stderr/exit forwarding, or missing-binary diagnostics if real launch proof fails. | Keep `shell: false`; do not move lifecycle logic into the bridge or TUI. |
| TUI smoke harness           | Add or repair smoke/evidence code if the harness cannot launch or capture the real TUI.                                                   | Use isolated state; never start unknown user apps.                       |
| Preferences/confirmation UX | Fix only if TUI tests or smoke prove persistence or confirmation behavior is broken.                                                      | No secrets in preferences; no destructive action before confirmation.    |

The daemon lifecycle, process manager, durable logs, export, grouping, auth, and
event behavior should not be refactored for this gate unless a new P0/P1
verification failure points directly at those surfaces.

## 6. Tasks That Require CI Changes

Most CI scaffolding is already present, but this gate still requires CI evidence.

| CI need              | Current state                                                | Required gate                                                                                               |
| -------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Go setup             | CI uses `actions/setup-go` for TUI jobs.                     | A run must show Go version/env and pass TUI checks after `tui/go.sum` exists.                               |
| TUI tests/vet/race   | CI jobs exist; local host cannot run them.                   | `npm run tui:test`, `npm run tui:vet`, and Linux race lane pass or report honest unsupported host behavior. |
| TUI build smoke      | CI job exists.                                               | `npm run tui:build` produces a platform binary.                                                             |
| Clean-worktree check | CI now runs `npm run verify:clean-worktree` after key lanes. | A clean/disposable lane must pass.                                                                          |
| GoReleaser           | CI release-artifacts path is implemented in current status.  | Either run and inspect checksums, or explicitly defer to release-track.                                     |

## 7. Tasks That Require Docs Changes

Docs should change only to record verified current behavior or explicit
deferral. Do not rewrite roadmap architecture.

| Doc/report                                             | Required update                                                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `reports/fix-planning/PRE-RA-blocker-status.json`      | Mark blockers closed only with real evidence; keep `aiAgentPromptsBlocked: true` until mandatory gates pass. |
| `reports/release-candidate/tui-evidence-report.md`     | Replace environment/package blocker with real launch evidence only after `npm run tui:smoke` succeeds.       |
| `reports/release-candidate/release-readiness.md`       | Update release readiness answers only after Go/TUI and bridge evidence exists.                               |
| `reports/release-candidate/test-matrix.md`             | Add exact Go/TUI command results, artifacts, screenshots/transcripts, and failures.                          |
| `docs/tui-toolchain.md` and `docs/artifact-hygiene.md` | Adjust only if commands or artifact locations change during verification.                                    |

## 8. Mandatory Before AI-Agent Prompts

These are hard gates. If any item is missing, the final recommendation remains
`BLOCK_AI_AGENT_PROMPTS`.

| Gate                                        | Required evidence                                                                                                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Go setup is deterministic                   | `go version`; `go env GOVERSION GOOS GOARCH GOMOD GOMODCACHE`; `tui/go.sum` generated or verified.                                                                        |
| TUI builds                                  | `npm run tui:build` passes on at least one supported environment and creates the expected current-platform binary.                                                        |
| TUI tests pass                              | `npm run tui:test` passes.                                                                                                                                                |
| TUI vet passes or is honestly blocked       | `npm run tui:vet` passes, or a documented environment-specific non-pass is recorded without fake success.                                                                 |
| Race behavior is honest                     | `npm run tui:race` passes where supported, or returns documented unsupported status for the host without being counted as a pass.                                         |
| Snapshots/render checks pass                | `npm run tui:snapshot` passes deterministically.                                                                                                                          |
| Bridge launches a real binary               | `relaybase tui` launches built `relaybase-tui` through the Node bridge against isolated daemon state.                                                                     |
| Missing-binary diagnostic still works       | `relaybase tui` or bridge unit/smoke evidence shows clear fail-closed missing-binary diagnostic.                                                                          |
| TUI connects to daemon                      | Smoke evidence shows connected state from a real TUI launch.                                                                                                              |
| Daemon-unavailable diagnostic works         | Direct TUI and/or bridge unavailable-daemon diagnostic captured.                                                                                                          |
| Preferences persist                         | Before/after preference artifacts prove theme/pane preference survives restart and no secrets are stored.                                                                 |
| Slash destructive-action confirmation works | Slash lifecycle/export command shows confirmation and does not call daemon before confirmation.                                                                           |
| Command/assistant confirmation works        | Pre-AI-agent command/assistant bar action preview waits for confirmation.                                                                                                 |
| Visual/terminal evidence exists             | At least one PTY transcript, screenshot, or terminal recording from a real launched TUI.                                                                                  |
| Workspace hygiene passes                    | `npm run verify:clean-worktree` passes before and after in the final verification checkout, except intentional report artifacts if explicitly allowed for planning tasks. |
| GoReleaser is resolved or deferred          | `npm run release:check`/`release:dry-run` passes, or the blocker is explicitly deferred to release-track with no impact on AI-agent development.                          |

## 9. Can Wait Until Release Hardening

These may wait only after all mandatory pre-AI-agent gates pass:

| Item                           | Why it can wait                                                                                   | Required deferral language                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| GoReleaser/checksum dry-run    | It validates final release archives, not the TUI approval surface needed for Operator Agent work. | "Deferred to release-track; final binary release remains blocked until GoReleaser checksums pass." |
| Full platform artifact matrix  | AI-agent work needs one proven supported TUI build/launch environment first.                      | "Cross-platform release publication remains blocked until matrix artifacts pass."                  |
| Optional platform npm packages | Main package/dev binary/`RELAYBASE_TUI_BIN` path can prove the surface first.                     | "Optional platform packages planned, not required for AI-agent gate."                              |
| Extra recording formats        | One real transcript/screenshot is sufficient for AI-agent gate.                                   | "Additional recordings remain release hardening evidence."                                         |

## 10. Required Verification Commands

Run from a clean or disposable checkout. Windows commands use `npm.cmd`; CI/POSIX
may use `npm`.

```powershell
node --version
npm.cmd --version
git status --short
npm.cmd run verify:clean-worktree
where.exe go
go version
Push-Location tui
go env GOVERSION GOOS GOARCH GOMOD GOMODCACHE
go mod tidy
Pop-Location
npm.cmd run doctor
npm.cmd run tui:doctor
npm.cmd run tui:build
npm.cmd run tui:test
npm.cmd run tui:vet
npm.cmd run tui:race
npm.cmd run tui:snapshot
npm.cmd run package:check
npm.cmd run package:check:strict
npm.cmd run tui:smoke
npm.cmd run smoke
npm.cmd run format:check
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run test:jest
npm.cmd run verify:clean-worktree
git status --short
```

Release-track commands, required for final release but deferrable for
AI-agent-prompt readiness if explicitly recorded:

```powershell
where.exe goreleaser
goreleaser --version
npm.cmd run release:check
npm.cmd run release:dry-run
Get-ChildItem dist -Recurse -Force
```

## 11. Required Evidence Artifacts

Use ignored generated paths for raw evidence and stable reports only when
intentionally promoted.

| Artifact                    | Path                                                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Command log                 | `artifacts/tui-verification/<run-id>/commands.md`                                                                       |
| Tool versions               | `artifacts/tui-verification/<run-id>/node-version.txt`, `npm-version.txt`, `go-version.txt`, `go-env.txt`               |
| TUI build/test logs         | `artifacts/tui-verification/<run-id>/tui-build.log`, `tui-test.log`, `tui-vet.log`, `tui-race.log`, `tui-snapshot.log`  |
| Direct launch transcript    | `artifacts/tui-verification/<run-id>/direct-launch-transcript.txt`                                                      |
| Bridge launch transcript    | `artifacts/tui-verification/<run-id>/bridge-launch-transcript.txt`                                                      |
| Daemon unavailable evidence | `artifacts/tui-verification/<run-id>/daemon-unavailable-transcript.txt`                                                 |
| Grouped pane evidence       | `artifacts/tui-verification/<run-id>/grouped-panes-transcript.txt` or `.png`                                            |
| Preference evidence         | `artifacts/tui-verification/<run-id>/preferences-before.json`, `preferences-after.json`, `preferences-diff.txt`         |
| Confirmation evidence       | `slash-stop-confirmation-transcript.txt`, `export-confirmation-transcript.txt`, `assistant-confirmation-transcript.txt` |
| State snapshots             | `artifacts/tui-verification/<run-id>/state-before.json`, `state-after.json`                                             |
| Workspace status            | `artifacts/workspace-status-before.json`, `artifacts/workspace-status-after.json`                                       |
| Stable summary report       | `reports/release-candidate/tui-evidence-report.md`                                                                      |
| Blocker ledger              | `reports/fix-planning/PRE-RA-blocker-status.json`                                                                       |

## 12. Root Cause Classification

| Blocker               | Classification                     | Current status                                                                            |
| --------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------- |
| Go toolchain          | Environment plus repo tooling      | Tooling/docs are implemented; this host still lacks Go and no Go-capable evidence exists. |
| TUI package binary    | Packaging plus environment         | Bridge/package scaffolding exists; no real TUI binary has been built locally.             |
| TUI checks unverified | Test coverage plus environment     | Tests and npm lanes exist; they remain blocked until Go runs them.                        |
| GoReleaser/checksum   | Release tooling plus environment   | CI/local wrapper path exists; can be deferred to release-track for AI-agent prompt gate.  |
| Workspace hygiene     | Workspace hygiene                  | Clean-worktree tooling exists; current checkout remains dirty from release work.          |
| TUI evidence capture  | Evidence coverage plus environment | Smoke harness exists and fails closed; no real TUI launch evidence yet.                   |

## 13. Go/No-Go Recommendation

Recommendation: `BLOCK_AI_AGENT_PROMPTS`.

Do not start RA000, OpenRouter, OpenAI Agents SDK TypeScript, or Relaybase
Operator Agent prompts until the hard TUI gate passes. The future agent work
depends on a real TUI chat/approval surface; planning or implementing that agent
before the TUI can build and launch would convert a release-readiness blocker
into hidden product risk.

Next required prompt:

```text
PRE-RA-FIX007A-GO-CAPABLE-TUI-VERIFICATION
```

If Go is still unavailable and the user does not approve a Go-capable
environment, stop with an environment blocker. Do not mark TUI build, launch,
tests, screenshots, preferences, or confirmation gates as passing.

RA000 is not the next prompt yet.
