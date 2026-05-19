# Windows Runtime Troubleshooting

Use this reference when Relaybase work involves Windows process behavior, stale local runtimes, token auth, or port ownership.

## Command Rules

- Prefer `npm.cmd` over `npm` or `npm.ps1`.
- Prefer `.\skills\relaybase-dev\scripts\relaybase-dev.cmd` over direct `.ps1` helper invocation in Codex App and Windows shells.
- Never run or recommend `Set-ExecutionPolicy`; use the helper wrapper.
- Assume Windows PowerShell unless `pwsh` is verified.
- If tests or app starts fail with sandbox `spawn EPERM`, treat execution context as the first suspect.
- Generated `relaybase.app.json` files must be UTF-8 without BOM.

## Helper Wrapper

Windows may block direct `.ps1` helper execution. In Codex App or normal Windows shells, use the wrapper:

```powershell
.\skills\relaybase-dev\scripts\relaybase-dev.cmd -Action preflight
```

The wrapper applies process-local bypass and does not change user, machine, or group policy.

## Token Branch

Discovery can pass while mutations fail:

```text
GET /.well-known/mcp.json -> healthy
POST /__hub/api/apps/<id>/start -> 401 Unauthorized
```

Run:

```powershell
.\skills\relaybase-dev\scripts\relaybase-dev.cmd -Action diagnose-token
```

Check:

- `stateDir`
- `tokenPath`
- `hasToken`
- `RELAYBASE_STATE_DIR`
- whether the running Relaybase process was launched with a different `--state-dir`

Do not print token contents unless explicitly asked.

## Stale Runtime Branch

When UI behavior and edited files disagree:

1. Restart the dashboard runtime.
2. Re-check dashboard `/api/status`.
3. Re-check Relaybase `/__hub/api/apps`.
4. Re-check Relaybase discovery.

When Relaybase behavior and edited Relaybase files disagree:

1. Restart Relaybase.
2. Re-check `http://localhost:7777/.well-known/mcp.json`.
3. Re-check `http://localhost:7777/__hub/api/apps`.
4. Retry the exact failing lifecycle action.

## Stop And Port Closure

On Windows, stopping a shell-spawned app may require killing the whole process tree:

```powershell
taskkill /pid <pid> /t /f
```

Relaybase success requires the backend port to close after stop when the port is known. Use:

```powershell
.\skills\relaybase-dev\scripts\relaybase-dev.cmd -Action check-stop -AppId <id> -BackendPort <port>
```

If the port remains open after stop, treat stop as failed even if a wrapper status says `stopped`.

## Port Ownership

Before blaming product code:

- Check whether the expected port is still owned by a stale Node process.
- Restart stale dashboard or Relaybase runtimes before deeper debugging.
- Avoid launching direct fallback servers unless the fallback policy allows it.
