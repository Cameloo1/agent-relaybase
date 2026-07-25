# Operator Agent OpenRouter provider

This document describes the current OpenRouter provider path for Relaybase's built-in Operator Agent. It is a contributor/provider reference; user setup begins in [Operator Agent](operator-agent.md).

The provider boundary belongs to the TypeScript daemon Agent Gateway. The Go TUI displays configuration status, messages, activity, usage, diagnostics, and approvals but never stores a raw provider key or calls OpenRouter directly.

## Connection and configuration

On Windows, the normal path is `/settings` → **Agent** → **Provider** → **Connect OpenRouter**. Relaybase:

1. creates a one-use S256 PKCE verifier and loopback callback on `127.0.0.1`;
2. opens the OpenRouter authorization page;
3. verifies callback state and accepts one authorization code;
4. exchanges and validates the candidate in the daemon;
5. protects it with current-user DPAPI and writes an ACL-restricted blob;
6. rereads and decrypts the blob before activating its opaque credential reference.

Replace keeps the previous credential active until the candidate has passed validation, protection, durable write, and readback. Ongoing management lives under **Agent → Security and credentials**. Disconnect removes the local protected credential but cannot claim the remote key was revoked. Provider key management remains an external action, and Relaybase preserves local state until remote revocation is externally confirmed.

If provider validation is temporarily unavailable after exchange, Relaybase stores the candidate as `connected_unverified`, persists that state across restart, and blocks remote runs. **Security and credentials → Validate now** performs the safe current-key metadata request again through a bound repair preview; it activates a new verified revision only after success.

After migration, **Remove legacy external key** can preview one exact `OPENROUTER_API_KEY` assignment and requires a second confirmation before atomic removal. Relaybase creates no plaintext backup and refuses shell-owned, ambiguous, changed, invalid, oversized, or insecurely writable sources. Managed mode remains active throughout. Relaybase never silently edits `.env`.

The legacy compatibility path uses:

```env
OPENROUTER_API_KEY=
RELAYBASE_AGENT_MODEL=
RELAYBASE_AGENT_ENABLED=0
RELAYBASE_AGENT_REMOTE_MODEL_ENABLED=0
OPENROUTER_HTTP_REFERER=
OPENROUTER_TITLE=Relaybase Local
```

Both enablement flags must be `1` for ordinary remote Agent runs. A key and model alone do not enable remote calls.

Existing shell values remain authoritative and are not overwritten. Shell state is captured once at startup. `--agent-config <path>` or `RELAYBASE_ENV_FILE` selects an external source that is checked at each new-run boundary and reread only after metadata changes. Valid changes activate atomically; invalid changes preserve the last-known-good revision but block new runs. Reload never mutates global `process.env`.

`RELAYBASE_AGENT_MODEL` must be the exact model slug to use. Relaybase does not select or silently substitute a default model.

The daemon Agent configuration API and `/settings agent` can edit non-secret values. The key field stores only the environment-variable name. Raw keys are rejected from configuration updates.

## Provider adapter

The implemented adapter:

- constructs an OpenAI client with `baseURL=https://openrouter.ai/api/v1`;
- uses the upstream OpenAI Agents SDK TypeScript Chat Completions model/provider path;
- sets `useResponses=false` for this compatibility path;
- supports optional `HTTP-Referer` and `X-OpenRouter-Title` attribution values;
- keeps provider construction and requests in the daemon;
- does not require a Relaybase-maintained SDK fork.

Provider and model behavior are external and can change. Offline tests prove Relaybase's adapter and policy contract, not the live behavior of every model slug.

## Key handling

Relaybase must never store or return the raw OpenRouter key in:

- TUI preferences or Agent non-secret configuration;
- daemon audit records or SQLite thread data;
- setup plans, manifests, wrappers, or env previews;
- log or thread exports;
- activity events, traces, diagnostics, screenshots, or reports;
- child app environments created from Relaybase state.

Configuration responses contain only safe source health, readiness, an opaque revision, credential presence/reference, DPAPI protection mode, and provider-reported limit/expiration metadata.

Managed credentials are decrypted only in the daemon into a short-lived lease. The lease is cleared after provider use. Agent credential names are removed from child app, hook, setup, repair, browser-helper, and child MCP environments. They are never returned through the TUI, API, logs, diagnostics, exports, audits, `.env`, or ordinary configuration.

Missing or invalid provider state becomes an explicit diagnostic and failed/blocked run:

- `AGENT_DISABLED`
- `AGENT_REMOTE_MODEL_DISABLED`
- missing or unreadable credential
- missing model
- budget exhausted
- provider timeout or failure

Relaybase does not synthesize assistant text for these failures.

## Model and tool capability

The selected model must support the OpenAI Agents SDK tool path used by Relaybase. A model catalog label is not sufficient evidence.

Every model-proposed call is still:

1. parsed through the SDK/tool schema boundary;
2. validated by Relaybase;
3. checked against the effective tool registry;
4. checked against project grants and policy;
5. converted to an approval when the action mutates state;
6. executed through the daemon-owned Relaybase primitive.

The model cannot enable an unregistered tool or approve a mutation by supplying an `approved` JSON field.

## Requests and attribution

Optional attribution values are read from:

- `OPENROUTER_HTTP_REFERER` for `HTTP-Referer`;
- `OPENROUTER_TITLE` for `X-OpenRouter-Title`.

Missing attribution does not affect deterministic local commands. The credential is passed directly to the daemon provider adapter rather than through `process.env`.

## Execution and budgets

Configured Agent runs use bounded continuation with one run state across segments. Daemon configuration controls:

- turns per segment;
- total turn ceiling;
- inactivity timeout;
- hard run deadline;
- maximum output tokens;
- reasoning effort;
- no-progress repetition limit;
- daily, monthly, and session budgets.

The daemon checks configured budget before a provider call. Live semantic verification also uses an external provider-usage guard so a stale local accounting value cannot silently exceed its approved phase cost.

## Prompt and result safety

Prompt construction happens in the daemon after policy and redaction. It may include bounded safe Relaybase state, selected UI/app context, approved project inspection results, and active-thread recall.

It does not silently include raw auth tokens, environment values, provider keys, app logs, file diffs, inactive thread transcripts, or unredacted manifests.

Tool results and public activity are sanitized and bounded before SQLite persistence and SSE publication. Processing labels such as `Thinking` and `Reviewing tool result` describe public runtime state and do not contain private model reasoning.

## Live verification

These commands make real provider calls:

```powershell
npm.cmd run agent:smoke:openrouter
npm.cmd run agent:live:correctness
npm.cmd run agent:live:activity
```

`agent:smoke:openrouter` checks basic completion, a harmless function-tool call, and streaming through the actual provider path.

`agent:live:correctness` checks semantic tool choice, targets, filesystem boundaries, daemon/process/route evidence, cleanup, response truthfulness, and secret safety with disposable projects.

`agent:live:activity` performs a bounded read-only Agent run and verifies the public activity lifecycle.

These commands are opt-in and are not run by the default offline verification gate. Missing credentials, missing model, insufficient spend capacity, or incompatible tool behavior must fail as blocked—not pass through fixtures.

## Security boundary

The silent default does not ask the user to unlock a credential during ordinary runs. The optional Windows-verification mode is reported as unavailable until secure prompt ownership is implemented and proven for service, background, console, and TUI-launched daemon modes.

Current-user DPAPI does not protect against same-user malware, process injection, debuggers, or a compromised Relaybase daemon. It protects primarily against offline copying, another Windows user, and accidental plaintext exposure. A remote broker holding provider keys and issuing short-lived Relaybase client access is a future stronger-security tier, not part of this implementation.

See [Agent work correctness](agent-work-correctness.md), [Operator Agent tools](tui-agent-tools.md), and [Operator Agent safety](tui-agent-safety.md).
