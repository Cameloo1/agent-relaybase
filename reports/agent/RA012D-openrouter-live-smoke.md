# RA012D OpenRouter Live Smoke

Status: PASS

## Scope

This smoke uses the actual Relaybase Agent Gateway, daemon Operator Agent runtime, OpenAI Agents SDK TypeScript path, and OpenRouter provider. It does not use mocked model responses or a fake OpenRouter server.

## Result

- Model: google/gemini-3.1-flash-lite
- Reasoning: enabled (medium)
- Fork required: no

## Checks

- gatewayRuntime: passed - created token-gated Agent Gateway session and runs through daemon HTTP API
- liveModel: passed - real model response received from google/gemini-3.1-flash-lite
- reasoning: passed - reasoning provider data enabled with medium effort
- readOnlyTool: passed - list_apps emitted tool.call_requested, tool.started, and tool.completed
- streaming: passed - session SSE captured 58 events
- setupPlanning: passed - detect_project, plan_app_setup, and preview_setup_writes ran without file changes
- approvalGate: passed - start_app required approval, was rejected, and did not start the app
- sessionAudit: passed - session and audit artifacts were written under disposable state
- secretScan: passed - artifact secret scan completed without leaks

## Artifacts

- request: C:\Users\wamin\Desktop\development\relaybase\artifacts\agent-live-smoke\openrouter-request-redacted.json
- response: C:\Users\wamin\Desktop\development\relaybase\artifacts\agent-live-smoke\openrouter-response-redacted.json
- events: C:\Users\wamin\Desktop\development\relaybase\artifacts\agent-live-smoke\agent-events.jsonl
- audit: C:\Users\wamin\Desktop\development\relaybase\artifacts\agent-live-smoke\agent-audit.jsonl
- session: C:\Users\wamin\Desktop\development\relaybase\artifacts\agent-live-smoke\session-redacted.json
- daemonLog: C:\Users\wamin\Desktop\development\relaybase\artifacts\agent-live-smoke\daemon.log
- setupPlan: C:\Users\wamin\Desktop\development\relaybase\artifacts\agent-live-smoke\setup-plan.json
- outboundContextPreview: C:\Users\wamin\Desktop\development\relaybase\artifacts\agent-live-smoke\outbound-context-preview.json
- secretScan: C:\Users\wamin\Desktop\development\relaybase\artifacts\agent-live-smoke\secret-scan.txt

## Daemon Log Summary

- started daemon http://127.0.0.1:58049
- stateDir C:\Users\wamin\AppData\Local\Temp\relaybase-agent-live-smoke-p7Ep4w\state
- sampleProject C:\Users\wamin\AppData\Local\Temp\relaybase-agent-live-smoke-p7Ep4w\sample-app
- registered sample app through daemon registry
- configured Agent Gateway for model google/gemini-3.1-flash-lite
- created agent session 606ad714-ebaa-4135-b372-c195ed6b0681
