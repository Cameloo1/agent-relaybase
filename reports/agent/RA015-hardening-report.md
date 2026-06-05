# RA015 Hardening Report

Generated: 2026-06-03

## Summary

RA015 re-ran the Operator Agent live path on the active requested model, `google/gemini-3.1-flash-lite`, with reasoning enabled. The first live acceptance attempt in this pass exposed a harness strictness issue: Gemini requested an approval-gated `patch_manifest_fields` manifest update for frontend/group metadata instead of the narrower `set_component_metadata` tool name. The daemon safety behavior was correct; the harness failed to recognize the equivalent pending manifest approval.

The harness was repaired to accept that equivalent approval only when the patch exactly matches the expected app id, group id, and component role. Approval remains mandatory and no TUI lifecycle or file-write boundary changed.

## Code Change

- `src/agent/liveAcceptance.ts`
  - Added `requiredComponentMetadataApproval`.
  - Kept direct `set_component_metadata` approval support.
  - Added recognition for equivalent supported `patch_manifest_fields` approval only when:
    - `appId` is `js-node-sample`
    - patch `relaybase.groupId` is `live-demo`
    - patch `relaybase.componentRole` is `frontend`
  - Added `setup.manifest_patch_approval_required` to the accepted approval event types.
  - Added a post-approval assertion that the generated manifest actually contains `relaybase.groupId=live-demo` and `relaybase.componentRole=frontend`.
  - Added honest non-empty artifact markers when an advertised optional generated file is absent.
- `src/agent/tools/patchManifestFields.ts`
  - Changed manifest path resolution to prefer the daemon-known manifest for `appId` before trusting model-supplied `manifestPath`.
  - This prevents a hallucinated manifest path such as `relaybase.json` from overriding a known registered app manifest.
- `tests/agent-tools.test.ts`
  - Added regression coverage proving `set_component_metadata` with `appId` and a bogus `manifestPath` still updates the daemon-known manifest path.

## Hardening Checks

| Scenario | Status | Evidence |
| --- | --- | --- |
| Live OpenRouter Gemini 3.1 Lite | passed | `agent:live:acceptance` PASS and `agent:smoke:openrouter` PASS evidence. |
| Reasoning requested | passed | `model-capability-check.json` and live report show reasoning requested. |
| Tool calls | passed | Live model capability shows tool calls observed. |
| File write approval | passed | JS/Go setup apply required approval before writes. |
| Manifest metadata approval | passed | Equivalent manifest patch approval required before frontend/group metadata write. |
| Manifest metadata applied | passed | Live `manifest-after.json` contains `relaybase.groupId=live-demo` and `relaybase.componentRole=frontend`. |
| Lifecycle approval | passed | Start, restart, stop, and prove slices required approval. |
| Log export approval | passed | Redacted zip export required approval and succeeded. |
| Prompt injection | passed | Manifest/setup write tool did not start without approval. |
| Ambiguous destructive target | passed | Ambiguous backend stop did not create destructive approval. |
| Redaction | passed | Artifact secret scan passed. |
| TUI smoke-render | passed | Real `relaybase-tui` binary rendered no-apps/setup/lifecycle approval frames. |
| SDK fork need | passed | No fork required; upstream SDK adapter path works. |

## P0/P1 Review

No P0/P1 issue remains for the active Operator Agent setup/onboarding path:

- no crash observed
- no data loss observed
- no secret leak observed
- no broken TUI build/launch observed
- no lifecycle action bypassed daemon ownership
- no file write or manifest edit occurred before approval
- no setup Tier 1 apply/prove blocker remains for JS/Python/Go live fixtures
- no OpenRouter always-unavailable or model mismatch issue remains for `google/gemini-3.1-flash-lite`
- no daemon/TUI communication blocker remains

## Commands And Results

| Command | Result |
| --- | --- |
| `node --version` | `v24.15.0` |
| `npm.cmd --version` | `11.12.1` |
| `go version` | `go version go1.26.3 windows/amd64` |
| `codegraph-mcp agent-use status --repo . --json` | PASS, claimable; vector sidecar diagnostic did not block. |
| `codegraph-mcp agent-use context-pack --repo . --task "RA015 post-agent hardening and gap closure" --agent-json` | PASS, claimable. |
| `npm.cmd run format:check` | PASS before report writes. |
| `npm.cmd run lint` | PASS before report writes. |
| `npm.cmd run typecheck` | PASS after harness repair. |
| `npm.cmd test` | PASS, 183/183. |
| `node --experimental-strip-types --test tests\agent-tools.test.ts` | PASS after manifest-path resolver regression test. |
| `npm.cmd run test:jest` | PASS, 1 suite and 4 tests. |
| `npm.cmd run smoke` | PASS command exit; reported current Relaybase repo is not configured as an app, which is the expected health diagnostic for this repository root. |
| `npm.cmd run package:check` | First sandboxed run hit npm cache `EPERM`; rerun with normal cache access PASS and confirmed `bin/relaybase-tui/relaybase-tui-windows-amd64.exe` is present in workspace and npm dry-run. |
| `npm.cmd run tui:build` | PASS. |
| `npm.cmd run tui:test` | PASS. |
| `npm.cmd run tui:vet` | PASS. |
| `npm.cmd run tui:snapshot` | PASS. |
| `$env:RELAYBASE_AGENT_MODEL='google/gemini-3.1-flash-lite'; npm.cmd run agent:smoke:openrouter -- --json` | PASS before harness repair; exact model and real tool-call path observed. |
| `$env:RELAYBASE_AGENT_MODEL='google/gemini-3.1-flash-lite'; npm.cmd run agent:live:acceptance -- --json` | First post-repair attempt blocked by sandboxed pip socket permissions; rerun with network permission PASS. |

## Environmental Note

The first RA015 live rerun failed before model execution because the Python fixture could not install isolated FastAPI dependencies inside the sandbox: Windows returned `WinError 10013`. The same command passed outside the sandbox with network access. This is classified as an environment/sandbox blocker, not a product-code failure.

## Result

RA015 hardening status for the active Gemini 3.1 Lite path: PASS.
