# Operator Agent

Relaybase includes an optional Operator Agent inside the terminal interface. It can inspect granted project folders, explain app failures, answer questions about current Relaybase state, and propose setup, registration, lifecycle, manifest, log-export, and interface actions.

The Agent does not replace the Relaybase daemon. The Go terminal interface sends requests and renders results; the TypeScript daemon owns provider calls, tool policy, approvals, redaction, audit state, processes, ports, setup writes, and recovery.

Core Relaybase operation and deterministic console commands do not require a model key.

## Connect and enable the Agent

The intended Windows setup path is:

1. Open `/settings`.
2. Choose **Agent**, then **Provider**.
3. Choose **Connect OpenRouter**.
4. Complete the OpenRouter authorization page opened by Relaybase.
5. Choose an exact model under **Agent > Configuration**, then enable the Agent and remote model.

Relaybase uses a daemon-owned OAuth PKCE callback, validates the returned dedicated OpenRouter key, protects it with current-user Windows DPAPI, and stores only an opaque credential reference in ordinary configuration. Use a Relaybase-only OpenRouter key with a conservative spending limit and expiration.

Regular Agent runs are silent: they do not show an unlock prompt. **Require Windows verification** is visible but unavailable until Relaybase can prove secure interactive prompt ownership in every supported daemon launch mode; it never silently downgrades a required policy.

Environment-backed credentials remain a legacy developer and migration path:

```env
OPENROUTER_API_KEY=
RELAYBASE_AGENT_MODEL=
RELAYBASE_AGENT_ENABLED=1
RELAYBASE_AGENT_REMOTE_MODEL_ENABLED=1
```

Use the exact tool-capable OpenRouter model slug you intend to run. Relaybase does not silently choose a model.

Shell values are an immutable startup snapshot and require restart when changed. `relaybase start --agent-config <path>` or `relaybase tui --agent-config <path>` selects one external configuration file. Relaybase checks that file at each new run, performs a stable bounded read only when it changed, and applies valid changes as a new revision without restarting the daemon. Invalid, unstable, missing, or unreadable changes block new runs while existing pinned runs continue.

Open Agent settings with:

```text
/settings agent
/settings agent security
```

The Agent settings category contains dedicated Status, Provider, Security and credentials, Configuration, Safety and permissions, Execution, Budgets, and Recovery pages. Provider owns initial OAuth PKCE connect and replace. Security and credentials owns validation, protection, migration, exact legacy cleanup, disconnect, provider key-management guidance, local checks, repair previews, and durable receipts. Edits remain a local draft until **Save changes** validates and applies the complete draft against the revision it was opened from. Raw key values are never accepted by settings, repair, or generic config APIs.

## Use the Agent

Open the full Agent Chat page with `F6`, or use `Ctrl+G` for the docked transcript. Type an ordinary request in the composer.

Examples of supported work include:

```text
What is broken with the notes app?
Inspect C:\work\notes and explain how Relaybase would start it.
Add C:\work\notes.
Configure the current folder and start it.
Show the current app and daemon context.
Why did the last operation fail?
```

Project inspection is limited to folders the user explicitly selects or names in a setup request. The daemon canonicalizes that root and issues a bounded grant. Model-generated paths cannot grant access to a new folder.

The Agent has no arbitrary-shell tool. Setup command candidates remain hints until the daemon setup engine validates and previews them.

## Approvals

Read-only inspection can run without a mutation approval. An approval is required before actions such as:

- starting, stopping, or restarting apps;
- applying setup files;
- registering or changing a manifest;
- changing health, port, or component metadata;
- changing env-backed setup values;
- exporting logs;
- opening a browser or copying a route when those integrations are enabled.

The approval preview names the target, risk, expected result, and safe diff or operation. Approval binds to the exact target and source revision. If the project, manifest, preview, or operation state changes, Relaybase rejects the stale approval and requires a fresh preview.

Waiting for approval is not success. Relaybase reports waiting, completed, failed, cancelled, and blocked states separately.

## Settings

The Agent settings page exposes:

- enabled state;
- provider and remote-model state;
- exact model slug and its source;
- credential connection, protection, validation, spending-limit, and expiration metadata;
- connect, replace, migrate, revoke guidance, and local disconnect controls;
- preview-bound removal of exactly one legacy external key assignment after protected migration;
- configuration source health and opaque active revision;
- optional attribution environment-variable names;
- registered-tool or explicit-allowlist mode;
- mutation approval policy;
- the daemon-enforced setup file-write policy;
- browser and route-copy policy;
- turns per segment and total turn ceiling;
- inactivity and hard run deadlines;
- maximum output tokens and reasoning effort;
- no-progress repetition limit;
- daily, monthly, and session budgets.

Execution limits are bounded by the daemon. A run continues in segments while reusing the same run state and stops at completion, approval wait, cancellation, no-progress detection, inactivity timeout, hard deadline, or its cumulative turn ceiling.

Fresh default configurations use all currently registered Relaybase tools. A deliberately customized explicit allowlist remains restricted. Capability inspection distinguishes registered, effective, disabled, and stale unknown tool names.

## Threads and history

Agent threads are daemon-owned and stored under the Relaybase state directory in `agent/agent.sqlite`. The TUI preference file is not a transcript store.

Use:

```text
/thread list
/thread new release checks
/thread switch 1
/thread rename release checks
/thread preview
/thread export markdown
/thread clear
```

Only the active thread contributes bounded, redacted conversational context to a new Agent run. Inactive transcripts, raw logs, raw env values, raw audit records, and unredacted file diffs are not silently added.

JSON and Markdown thread exports are redacted and recorded by the daemon.

## Activity and tool traces

The transcript presents public processing labels, tool calls, approvals, diagnostics, results, and final answers in chronological order. It does not expose private model reasoning.

Tool traces update in place. Select a trace with Up or Down and press Enter or Space to expand its bounded sanitized result. `Ctrl+E` toggles all available tool details.

Only an authoritative `model.processing_started` to `model.processing_completed` interval animates. Queued work, OAuth connection, provider validation, settings saves, config reload, tool execution, replay, reconnect, approval waiting, completed, failed, cancelled, and offline states are static and labeled.

## Cost and live checks

`/usage` shows model, token, and cost information for the last request and active thread when available.

Configured daily, monthly, and session budgets block before a provider call when exhausted. Relaybase does not synthesize a fake response after a budget or provider failure.

Maintainer live commands make real provider calls and are never part of the default verification gate:

```powershell
npm.cmd run agent:smoke:openrouter
npm.cmd run agent:live:correctness
npm.cmd run agent:live:activity
```

Use them only with an explicitly selected model, an approved cost boundary, and a configured key.

## Troubleshooting

| State                   | Recovery                                                                                                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent disabled          | Enable the Agent and remote-model settings under **Agent > Configuration**.                                                                                             |
| Remote model disabled   | Enable remote model use explicitly; a key and model alone do not enable calls.                                                                                          |
| Credential missing      | Connect OpenRouter under **Agent > Provider**; diagnose other credential states under **Agent > Security and credentials** or with `relaybase repair --agent-security`. |
| Model missing           | Set an exact model slug.                                                                                                                                                |
| External source changed | Reload it from **Agent > Configuration**; valid changes also reload at the next new run.                                                                                |
| Shell source changed    | Restart the daemon because shell state is a startup snapshot.                                                                                                           |
| DPAPI blob invalid      | Replace or reconnect the credential; Relaybase does not fall back to plaintext.                                                                                         |
| Budget exhausted        | Review `/usage` and the configured daily, monthly, or session limit.                                                                                                    |
| Approval stale          | Regenerate the preview and review the new target and diff.                                                                                                              |
| Run appears idle        | Inspect its activity and operation status; inactivity and hard deadlines fail visibly.                                                                                  |
| Tool unavailable        | Review tool mode and the effective allowlist in `/settings agent`.                                                                                                      |

See [Operator Agent safety](tui-agent-safety.md), [tools](tui-agent-tools.md), [activity rendering](tui-agent-activity.md), [independent work verification](agent-work-correctness.md), and [architecture](tui-agent-architecture.md) for contributor-level contracts.

Windows DPAPI does not defeat malware, debuggers, injected code, or other processes already running with the same user authority. It reduces offline, cross-user, and accidental plaintext exposure. A future backend-held credential service with short-lived client access would be a stronger tier; it is not part of the current local implementation.
