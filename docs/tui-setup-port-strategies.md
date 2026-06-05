# TUI Setup Port Strategies

This document defines how Relaybase explains and plans runtime port strategies for the TUI setup workflow. Current implementation lives in `src/setup.ts`, `src/setupApi.ts`, `src/processManager.ts`, the Go TUI setup commands, and the daemon Operator Agent setup tools.

Runtime breadth note: RA012B adds daemon-side runtime adapters for JavaScript/TypeScript, Python, Go, Java, Kotlin/JVM, C#/.NET, Ruby, PHP, Docker Compose, Rust, Elixir, Scala, Clojure, Dart, native/C/C++, and Procfile projects. The adapters expose runtime command candidates, port strategies, health candidates, setup questions, and repair candidates through setup API metadata. Existing Node/package-manager, Docker Compose, static preview, MCP-only, and manifest setup behavior remains the compatibility path for actual file writes.

## Core Explanation

Relaybase routes stable app URLs to app backend ports. When Relaybase owns lifecycle, the daemon can choose a runtime port and inject it into the app process environment as `PORT`.

User-facing explanation:

```text
Relaybase assigned port X.
Your app command must bind to PORT=X.
If it ignores PORT, use a framework wrapper or fixed upstreamPort.
```

The TUI must explain whether Relaybase owns the port or is proxying to a fixed external port.

## Daemon-Assigned Dynamic Port

Current primitive: managed dynamic port plan in `src/setup.ts`, exposed to clients as `PortStrategy: "managed_dynamic_port"` and `"env_port"` through `/__hub/api/setup/plans` and `/__hub/api/setup/preview`.

Behavior:

- manifest omits `upstreamPort`
- daemon selects an available port from its port range
- daemon injects `PORT`, `HOST`, `RELAYBASE_APP_ID`, and `RELAYBASE_BASE_URL`
- app command must honor `PORT`

Best for apps that read `process.env.PORT` or equivalent. For many `npm run dev` scripts, this works when the underlying app/framework honors `PORT`.

Risk: some framework dev scripts ignore `PORT` unless explicit flags are passed.

## Pinned Upstream Port

Current primitive: pinned upstream plan when setup detects a port, exposed as `PortStrategy: "fixed_upstream_port"`.

Behavior:

- manifest includes `upstreamPort`
- Relaybase routes to that fixed port
- app command or external process must bind to that port

Best for apps that cannot bind a daemon-assigned port.

Risk: fixed ports can conflict with stale processes. Stop verification differs because Relaybase may not own an external process.

## Generic PORT Env Strategy

Behavior:

- command starts normally
- daemon injects `PORT`
- app reads the environment variable

Example:

```json
{
  "command": "npm.cmd run dev",
  "healthUrl": "/"
}
```

This is simple but depends on app/framework support.

If the app supports forwarding framework flags, the command may also be represented as an npm argument-forwarding command such as:

```text
npm run dev -- --port <PORT>
```

or, for frameworks that require host binding too:

```text
npm run dev -- --host <HOST> --port <PORT>
```

Relaybase should use this only when project detection or an approved setup plan knows the runtime accepts those flags. If support is unknown, the daemon should show this as a proposed repair/setup choice instead of silently changing the command.

## Framework Port Flag Wrapper Strategy

Current primitive: `framework-port-flag` setup plan writes `.relaybase/launch.cjs` and is exposed as `PortStrategy: "framework_port_flags"` plus `"generated_launch_wrapper"`.

The generated wrapper reads `process.env.PORT` and `process.env.HOST`, then passes framework-specific flags without relying on shell interpolation.

This is safer than embedding `%PORT%` or `$PORT` directly into a cross-platform manifest command.

### Next Wrapper Strategy

Next dev servers should receive:

```text
npm run dev -- -H <HOST> -p <PORT>
```

The generated wrapper passes those values from `process.env.HOST` and `process.env.PORT`.

### Vite Wrapper Strategy

Vite dev servers should receive:

```text
npm run dev -- --host <HOST> --port <PORT>
```

### Astro Wrapper Strategy

Astro dev servers should receive:

```text
npm run dev -- --host <HOST> --port <PORT>
```

### Generated `.relaybase/launch.cjs` Wrapper

The wrapper should:

- use the detected package manager
- run the configured script
- pass framework port flags
- inherit the daemon-injected environment
- use `shell: false`
- use `stdio: inherit`
- exit with the child exit code
- avoid printing secrets

The wrapper must be previewed and approved before writing.

## Docker Compose Wrapper

Docker Compose support is implemented through `src/dockerProfile.ts` and setup plans when Compose files are detected. The TUI should expose Docker setup choices only when the daemon returns them. Docker Compose setup plans are exposed as `PortStrategy: "docker_compose_wrapper"`.

Docker setup may involve:

- selected app service
- target container port
- generated Docker profile
- generated compose overlay
- generated lifecycle hooks
- dependency port policy
- optional Docker Desktop recovery behavior

The TUI must not pretend Docker Compose is supported for a project when the daemon setup engine rejects or cannot disambiguate the service.

## Custom Or Manual Strategy

Manual setup remains valid when Relaybase cannot infer a safe plan. API choices use `PortStrategy: "manual_custom"` when the selected architecture is MCP-only, static preview, or otherwise not a daemon-managed port strategy.

The TUI should offer:

- custom command
- custom health path
- custom pinned port
- component metadata fields
- manifest preview
- validation before apply

The daemon validates and writes only after approval.

## User Guidance

When startup fails, the TUI should name the likely boundary:

- app ignored `PORT`
- app bound a different port
- fixed port conflict
- health route wrong
- dependency missing
- command not found
- Docker service ambiguous
- daemon route failed

Then it should offer daemon-produced repair choices rather than guessing.

## Runtime Matrix Port Strategies

`docs/tui-setup-runtime-matrix.md` defines the RA012B strategy matrix for JavaScript/TypeScript, Python, Go, Java, Kotlin/JVM, .NET, Ruby, PHP, Docker Compose, Rust, Elixir, Scala, Clojure, Dart, generic native/C/C++, and Procfile projects.

The daemon maps those strategies into runtime-aware setup metadata while preserving the existing setup primitives:

- `env_port` when the app can read a daemon-injected `PORT`.
- `explicit_host_port_flags` when the runtime has safe, detected host/port CLI flags.
- `runtime_specific_env` for runtime env variables such as `SERVER_PORT`, `ASPNETCORE_URLS`, or `ROCKET_PORT`.
- `generated_launch_wrapper` only after preview and approval.
- `fixed_upstream_port` when dynamic port support cannot be proven.
- `compose_port_mapping` for approved Docker Compose service mappings.
- `manual_custom` when Relaybase cannot safely infer command or port behavior.

Important boundary: runtime metadata is not permission to mutate a project. Preview remains read-only, and apply/file writes/manifest edits still require daemon approval. If a command candidate requires placeholders such as `<HOST>` or `<PORT>` and Relaybase cannot safely express that in the current manifest command contract, setup returns the candidate and questions instead of silently writing a fake command.
