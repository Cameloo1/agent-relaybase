# RA013 Live Operator Agent Acceptance Test

Status: FAIL

## Scope

This test uses the real Relaybase daemon, real Agent Gateway, real OpenAI Agents SDK TypeScript runtime, real OpenRouter provider, exact google/gemini-3.1-flash-lite model slug, real setup APIs, real daemon lifecycle APIs, and the real Go TUI binary smoke-render path. It does not use mocked model responses or a fake daemon.

## Result

- Failure: RA013_AGENT_RUN_FAILED_CONFIGURE_JAVASCRIPT_SAMPLE: {"id":"31513629-fd2c-4bcc-8084-3fb2fc87c3ac","sessionId":"86ef957d-2c39-4c56-95f3-1ea1a0595d71","runId":"a7d4efc9-38f3-4e11-8cee-aaa5c35cd38e","sequence":4,"type":"blocked","at":"2026-06-04T19:14:11.030Z","data":{"kind":"blocked","content":"Connection error.","diagnostic":{"id":"agent.runtime.provider_error","severity":"error","code":"AGENT_PROVIDER_ERROR","message":"Connection error.","checkedAt":"2026-06-04T19:14:11.021Z","userAction":"Review provider configuration and retry the request.","detail":{"provider":"openrouter","modelSlug":"google/gemini-3.1-flash-lite"}}}}

## Checks

- Live acceptance did not reach PASS. See artifacts for redacted diagnostics and exact failure evidence.

## Artifacts

- request: C:\Users\wamin\Desktop\development\relaybase\artifacts\agent-live\openrouter-request-redacted.json
- response: C:\Users\wamin\Desktop\development\relaybase\artifacts\agent-live\openrouter-response-redacted.json
- events: C:\Users\wamin\Desktop\development\relaybase\artifacts\agent-live\agent-events.jsonl
- audit: C:\Users\wamin\Desktop\development\relaybase\artifacts\agent-live\agent-audit.jsonl
- session: C:\Users\wamin\Desktop\development\relaybase\artifacts\agent-live\session.json
- daemonLog: C:\Users\wamin\Desktop\development\relaybase\artifacts\agent-live\daemon.log
- ptyTranscript: C:\Users\wamin\Desktop\development\relaybase\artifacts\agent-live\pty-transcript.txt
- setupPlanJs: C:\Users\wamin\Desktop\development\relaybase\artifacts\agent-live\setup-plan-js.json
- setupPlanPython: C:\Users\wamin\Desktop\development\relaybase\artifacts\agent-live\setup-plan-python.json
- setupPlanGo: C:\Users\wamin\Desktop\development\relaybase\artifacts\agent-live\setup-plan-go.json
- setupPreviewJs: C:\Users\wamin\Desktop\development\relaybase\artifacts\agent-live\setup-preview-js.json
- setupPreviewPython: C:\Users\wamin\Desktop\development\relaybase\artifacts\agent-live\setup-preview-python.json
- setupPreviewGo: C:\Users\wamin\Desktop\development\relaybase\artifacts\agent-live\setup-preview-go.json
- fileWritePreview: C:\Users\wamin\Desktop\development\relaybase\artifacts\agent-live\file-write-preview.json
- manifestBefore: C:\Users\wamin\Desktop\development\relaybase\artifacts\agent-live\manifest-before.json
- manifestAfter: C:\Users\wamin\Desktop\development\relaybase\artifacts\agent-live\manifest-after.json
- generatedManifest: C:\Users\wamin\Desktop\development\relaybase\artifacts\agent-live\generated-relaybase-app.json
- generatedLaunchWrapper: C:\Users\wamin\Desktop\development\relaybase\artifacts\agent-live\generated-launch-wrapper.cjs
- generatedSetupProfile: C:\Users\wamin\Desktop\development\relaybase\artifacts\agent-live\generated-setup-profile.json
- exportedLogs: C:\Users\wamin\Desktop\development\relaybase\artifacts\agent-live\exported-logs.zip
- exportSummary: C:\Users\wamin\Desktop\development\relaybase\artifacts\agent-live\export-summary.json
- stateBefore: C:\Users\wamin\Desktop\development\relaybase\artifacts\agent-live\state-before.json
- stateAfter: C:\Users\wamin\Desktop\development\relaybase\artifacts\agent-live\state-after.json
- processVerification: C:\Users\wamin\Desktop\development\relaybase\artifacts\agent-live\process-verification.json
- proveResult: C:\Users\wamin\Desktop\development\relaybase\artifacts\agent-live\prove-result.json
- repairPlan: C:\Users\wamin\Desktop\development\relaybase\artifacts\agent-live\repair-plan.json
- modelCapability: C:\Users\wamin\Desktop\development\relaybase\artifacts\agent-live\model-capability-check.json
- outboundContextPreview: C:\Users\wamin\Desktop\development\relaybase\artifacts\agent-live\outbound-context-preview.json
- secretScan: C:\Users\wamin\Desktop\development\relaybase\artifacts\agent-live\secret-scan.txt

## Daemon/Test Log Summary

- python resolved via PATH python: python  Python 3.14.4
- python stdlib verification: python -c import http.server; print('python stdlib http available') status=0
- python stdlib verification stdout: python stdlib http available
- started daemon http://127.0.0.1:61442
- stateDir C:\Users\wamin\AppData\Local\Temp\relaybase-agent-live-pnDuNX\state
- workspace C:\Users\wamin\AppData\Local\Temp\relaybase-agent-live-pnDuNX
- configured Agent Gateway for exact model google/gemini-3.1-flash-lite
- created agent session 86ef957d-2c39-4c56-95f3-1ea1a0595d71
