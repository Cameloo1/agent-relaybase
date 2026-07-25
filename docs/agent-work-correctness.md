# Agent work correctness verification

Relaybase verifies Operator Agent work with evidence that is independent of the model response and tool result. The verifier uses disposable projects and compares filesystem fingerprints, daemon state, operation state, process identity, assigned ports, stable routes, and secret scans before and after each scenario.

Run the deterministic Agent contract suite before using a provider:

```powershell
npm.cmd run agent:test
```

The suite covers all registered tools, read-only execution, approval-required mutation previews, approved daemon-owned execution, exact approval binding, retry and cancellation behavior, project-scope enforcement, fixture detection, and the correctness oracle.

The dedicated live phase is:

```powershell
npm.cmd run agent:live:correctness
```

The command reads the model from `RELAYBASE_AGENT_MODEL`. It executes ordered read-only, setup-preview, approved Node, non-Node, and failure/repair slices. The daemon budget and an external OpenRouter usage guard both enforce a default maximum phase cost of `$0.08`. An explicitly approved maintainer run may set `RELAYBASE_AGENT_LIVE_MAX_COST_USD` for that process; invalid, non-positive, and values above `$1.00` fail closed. Usage capacity is checked before every provider request and again after each slice. The command stops when either local run accounting or the provider account delta reaches the remaining reserved boundary.

The live phase fails unless:

- selected tools and their target arguments match the scenario;
- preview-only work leaves fixture files unchanged;
- approved setup changes only the manifest and `.relaybase` files;
- running apps have daemon-confirmed health, process ID, assigned port, and route evidence;
- restart changes process identity and stop reaches a terminal daemon state;
- ambiguous targets do not create destructive approvals;
- failure handling uses repair preview tools without claiming the repair was applied;
- Agent answers do not claim success while work is pending, failed, or waiting for approval;
- promoted events, sessions, reports, and audits contain no raw provider key, Relaybase token, bearer token, or fixture secret.

Generated evidence remains local under `artifacts/agent-live` and `reports/agent`. It is diagnostic output and must not be committed.
