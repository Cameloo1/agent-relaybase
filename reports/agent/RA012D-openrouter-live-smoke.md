# RA012D OpenRouter Live Smoke

Status: FAIL

## Scope

This smoke uses the actual Relaybase Agent Gateway, daemon Operator Agent runtime, OpenAI Agents SDK TypeScript path, and OpenRouter provider. It does not use mocked model responses or a fake OpenRouter server.

## Result

- Failure: [object Object]

## Checks

- Live smoke did not reach acceptance. See artifacts for redacted diagnostics.

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

- started daemon http://127.0.0.1:58256
- stateDir C:\Users\wamin\AppData\Local\Temp\relaybase-agent-live-smoke-eLk78A\state
- sampleProject C:\Users\wamin\AppData\Local\Temp\relaybase-agent-live-smoke-eLk78A\sample-app
- registered sample app through daemon registry
- configured Agent Gateway for model google/gemini-3.1-flash-lite
- created agent session 823f4540-feaa-4249-9396-e9005df0873b
