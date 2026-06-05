# RA015 Known Issues

Generated: 2026-06-03

## No P0/P1 Operator Agent Blockers

No known P0/P1 issue remains for the active Gemini 3.1 Lite Operator Agent setup/onboarding path after RA015.

## Known Issues And Deferrals

| Issue | Severity | Classification | Current status | Recommendation |
| --- | --- | --- | --- | --- |
| Original pasted RA015 text asked for Gemini 3.5 | P2 | scope correction | Superseded by user instruction to use `google/gemini-3.1-flash-lite`; 3.5 is not claimed. | Keep future prompts explicit about the active model. |
| Live OpenRouter availability/account budget | P2 | external dependency | Live tests pass now but future runs depend on OpenRouter availability, account budget, and the configured key. | Keep blocked diagnostics and budget gates. |
| Python fixture dependency install under sandbox | P2 | environment | Sandboxed pip failed with `WinError 10013`; unrestricted live rerun passed. | Run live acceptance with approved network access or preseed fixture dependencies. |
| `npm run setup:test` script is absent | P2 | script naming | Setup coverage is included in `npm test`; no dedicated script exists. | Add aliases if command ergonomics matter. |
| `npm run agent:test` script is absent | P2 | script naming | Agent coverage is included in `npm test`; no dedicated script exists. | Add aliases if command ergonomics matter. |
| GoReleaser/checksum local proof | P2 | release tooling | Release-track-only. Missing GoReleaser diagnostics are implemented. | Verify in release CI or install GoReleaser locally for final release dry-run. |
| Platform-specific npm packages | P2 | packaging | Release-track-only; bridge/package diagnostics are honest. | Implement before public package distribution if needed. |
| Native manifest `components[]` | P2 | deferred product scope | Current grouping uses component-as-app metadata. | Defer until a manifest migration prompt. |
| Clipboard copy route | P2 | intentionally unavailable | TUI/agent returns unavailable diagnostic unless real clipboard capability exists. | Implement with platform-safe clipboard support and tests if desired. |
| Browser open route | P2 | intentionally unavailable | TUI/agent returns unavailable diagnostic unless real browser-open capability exists. | Implement as daemon/TUI proposed action with approval and platform tests if desired. |
| Full live runtime matrix beyond JS/Python/Go | P2 | coverage expansion | Broad runtime matrix is unit/integration tested; only JS/Python/Go are fully live-proven. | Add release-hardening live slices for Java/.NET/Ruby/PHP/Docker and selected Tier 2 runtimes. |
| Forced OpenRouter rate-limit live test | P2 | external condition | Timeout/error handling is tested; rate-limit condition is not forced live. | Add provider-level fixture or documented live error capture only when safe. |
| Raw `reasoning_details` preservation | P2 | provider metadata | Reasoning request is live-proven; raw reasoning details are not exposed as a Relaybase contract. | Only add if product needs traceable reasoning metadata. |
| Dirty workspace from accumulated RA/TUI work | P2 | workspace hygiene | Worktree remains intentionally dirty with broad prior implementation work. | Classify/stage/commit in a separate publication task; do not clean blindly. |

## Release-Track Items

- GoReleaser/checksum dry-run
- platform-specific package artifacts
- optional video/screenshot capture beyond PTY transcripts
- expanded live runtime matrix
- clean publication branch/worktree

## Result

Known issues are explicit and do not block the active Operator Agent + TUI setup/onboarding path on Gemini 3.1 Lite.
