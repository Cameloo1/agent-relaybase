# Pre-Production Readiness Tracker

Review timestamp: 2026-05-06 11:44:41 -05:00
Last updated: 2026-05-11 12:05:30 -05:00
Baseline commit reviewed: `19bfbaf`
Baseline verification: `npm.cmd test` passed 12/12 tests on 2026-05-06 11:44:41 -05:00
Current milestone verification: `npm.cmd run verify` is the local/CI release gate and covers formatting, lint, typecheck, Node tests, Jest tests, and CLI smoke.

## Production Goal

Relaybase should become a local-first agent communication and app-routing platform that can safely route, supervise, and observe many dev workloads: web apps, 3D engines, game/editor tools, quant services, low-latency streams, AI wrappers, MCP-style tools, local APIs, and future binary or message-driven protocols.

Production-level means:

- No silent data loss: traffic is either delivered, backpressured, retried, persisted, or failed visibly.
- No unauthenticated mutation surface: every privileged action has identity, authorization, audit logs, and origin protections.
- No unbounded buffers or sockets: every input path has timeouts, limits, lifecycle cleanup, and abuse controls.
- No ambiguous routing: route selection, protocol selection, and app identity are deterministic and observable.
- No hidden process risk: managed commands, environment variables, secrets, logs, and filesystem access are controlled.
- No unsupported protocol claims: each supported protocol has tests, limits, and compatibility notes.

## Research Basis

Primary references checked during this review:

- Node.js HTTP server, timeout, request, upgrade, and connection behavior: https://nodejs.org/api/http.html
- Node.js `net.Socket`, TCP connection, timeout, and stream behavior: https://nodejs.org/api/net.html
- Node.js Streams and backpressure guidance: https://nodejs.org/en/learn/modules/backpressuring-in-streams
- Node.js `child_process` behavior and shell execution model: https://nodejs.org/api/child_process.html
- OWASP WebSocket Security Cheat Sheet for origin checks, authentication, authorization, and denial-of-service controls: https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html
- OWASP Application Security Verification Standard for authentication, session, access-control, validation, logging, and API expectations: https://owasp.org/www-project-application-security-verification-standard/
- IETF RFC 6455 for WebSocket protocol semantics and security considerations: https://www.rfc-editor.org/rfc/rfc6455
- IETF RFC 9110 and RFC 9112 for HTTP semantics, intermediaries, and HTTP/1.1 message routing: https://www.rfc-editor.org/rfc/rfc9110 and https://www.rfc-editor.org/rfc/rfc9112
- IETF RFC 9293 for TCP reliability, ordering, and stream semantics: https://www.rfc-editor.org/rfc/rfc9293
- W3C Trace Context for cross-service trace propagation: https://www.w3.org/TR/trace-context/
- OpenTelemetry documentation for traces, metrics, logs, and semantic telemetry: https://opentelemetry.io/docs/
- CloudEvents specification for interoperable event envelopes: https://github.com/cloudevents/spec
- AsyncAPI specification for event-driven API contracts: https://www.asyncapi.com/docs/reference/specification/v3.0.0
- Protocol Buffers language guide for typed, evolvable binary schemas: https://protobuf.dev/programming-guides/proto3/

## What Is Already Done

| Logged                     | Area                      | Status | Evidence                                                                                                                                                  |
| -------------------------- | ------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-05-06 11:42:18 -05:00 | GitHub baseline           | Done   | Initial commit `19bfbaf` pushed to `main`.                                                                                                                |
| 2026-05-06 11:44:41 -05:00 | Local routing daemon      | Done   | `src/server.ts` creates one local hub listener and routes hub/app traffic.                                                                                |
| 2026-05-06 11:44:41 -05:00 | Localhost default         | Done   | `src/state.ts` defaults to `127.0.0.1` and port `7777`.                                                                                                   |
| 2026-05-06 11:44:41 -05:00 | Header routing            | Done   | `src/router.ts` resolves `X-Relaybase-App` before host routing.                                                                                           |
| 2026-05-06 11:44:41 -05:00 | Human host routing        | Done   | `src/router.ts` maps `<app>.localhost` to app ids.                                                                                                        |
| 2026-05-06 11:44:41 -05:00 | Reserved hub surface      | Done   | `/__hub` and `/__hub/api/*` are reserved before app routing.                                                                                              |
| 2026-05-06 11:44:41 -05:00 | HTTP proxy                | Done   | `src/proxy.ts` proxies HTTP requests to app upstream ports.                                                                                               |
| 2026-05-06 11:44:41 -05:00 | WebSocket-style upgrades  | Done   | `src/server.ts` and `src/proxy.ts` route upgrade sockets; tests cover a basic 101 upgrade.                                                                |
| 2026-05-06 11:44:41 -05:00 | Basic TCP tunnel          | Done   | `src/tcpTunnel.ts` supports `RELAYBASE-TCP <app-id>` handshakes.                                                                                          |
| 2026-05-06 11:44:41 -05:00 | App manifest validation   | Done   | `src/validation.ts` validates id, command, cwd, protocol, env, health URL, and fixed upstream port.                                                       |
| 2026-05-06 11:44:41 -05:00 | Registry persistence      | Done   | `src/registry.ts` persists `registry.json` in the Relaybase state directory.                                                                              |
| 2026-05-06 11:44:41 -05:00 | Managed process lifecycle | Done   | `src/processManager.ts` supports start, stop, restart, logs, health, and assigned ports.                                                                  |
| 2026-05-06 11:44:41 -05:00 | CLI                       | Done   | `src/cli.ts` supports serve, register, start, stop, restart, status, and logs.                                                                            |
| 2026-05-06 11:44:41 -05:00 | Dashboard                 | Done   | `src/dashboard.ts` renders registered apps and start/stop controls.                                                                                       |
| 2026-05-06 11:44:41 -05:00 | Baseline tests            | Done   | 12 tests cover routing, dashboard smoke, WebSocket upgrade, lifecycle, conflicts, TCP tunnel, validation, and registry.                                   |
| 2026-05-06 11:44:41 -05:00 | CI skeleton               | Done   | GitHub Actions runs tests with Node 24.                                                                                                                   |
| 2026-05-11 12:05:30 -05:00 | Three-command CLI         | Done   | `relaybase configure`, `relaybase open`, and `relaybase health` are the public setup/launch/diagnosis flow.                                               |
| 2026-05-11 12:05:30 -05:00 | Smart setup engine        | Done   | `src/setup.ts` detects project type, proposes launch architectures, writes guarded artifacts, saves setup reports, and supports MCP-driven configuration. |
| 2026-05-11 12:05:30 -05:00 | Generic lifecycle hooks   | Done   | Manifests can define `preStartCommand`, `stopCommand`, `verifyStoppedCommand`, and lifecycle timeouts without making Relaybase Docker-specific.           |
| 2026-05-11 12:05:30 -05:00 | Stop correctness          | Done   | Cleanup and stop-verification failures keep runtime state errored instead of reporting fake `stopped`.                                                    |
| 2026-05-11 12:05:30 -05:00 | Expanded lifecycle tests  | Done   | Node tests cover setup planning, guarded writes, lifecycle hooks, stop failure, cleanup, serialization, MCP auth, and app state fields.                   |
| 2026-05-11 12:05:30 -05:00 | Release verification gate | Done   | `npm.cmd run verify` runs format, lint, typecheck, Node tests, Jest, and CLI smoke locally and in CI.                                                     |

## Current Production Blockers

| Logged                     | Priority | Area                       | Missing Implementation                                                                                                                                      | Why It Matters                                                                                                                                                    |
| -------------------------- | -------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-05-06 11:44:41 -05:00 | P0       | Security model             | Replace single local session token with explicit local identity, origin protection, CSRF protection, scoped capabilities, and per-app authorization.        | Any local webpage or compromised app should not be able to mutate the hub or control unrelated apps.                                                              |
| 2026-05-06 11:44:41 -05:00 | P0       | Dashboard token handling   | Do not embed the mutation token directly into dashboard JavaScript state. Use httpOnly same-site session cookies or a local IPC/CLI auth flow.              | Current dashboard exposes the bearer token to any script that runs in the dashboard page.                                                                         |
| 2026-05-06 11:44:41 -05:00 | P0       | Command execution          | Replace `shell: true` manifest commands with structured command/args, allowlists, working-directory policies, and explicit user consent.                    | Shell command strings are too broad for production process management.                                                                                            |
| 2026-05-06 11:44:41 -05:00 | P0       | Request limits             | Add max request body size, header size policy, JSON body limits, per-route timeouts, idle socket timeouts, and rate limits.                                 | Current API and proxy paths can hold memory or sockets indefinitely under bad clients.                                                                            |
| 2026-05-06 11:44:41 -05:00 | P0       | Backpressure and buffering | Audit every `pipe`, `data`, and socket path for backpressure, half-open handling, abort propagation, and bounded memory.                                    | Production routing must not drop bytes silently or buffer without limit under slow consumers.                                                                     |
| 2026-05-06 11:44:41 -05:00 | P0       | Reliable message layer     | Add optional message envelopes with sequence numbers, correlation ids, ACK/NACK, retries, idempotency keys, and delivery outcome states.                    | TCP provides ordered byte delivery for one connection, but the platform still needs application-level delivery semantics across app restarts and agent workflows. |
| 2026-05-06 11:44:41 -05:00 | P0       | Protocol contracts         | Define stable HTTP, WebSocket, TCP, event, and tool-call contracts with versioning and compatibility rules.                                                 | 3D engines, quant services, and AI wrappers need predictable wire contracts, not only port forwarding.                                                            |
| 2026-05-06 11:44:41 -05:00 | P0       | Observability              | Add structured logs, audit logs, metrics, traces, request ids, traceparent propagation, and per-app traffic counters.                                       | Production incidents cannot be debugged from in-memory process logs alone.                                                                                        |
| 2026-05-06 11:44:41 -05:00 | P0       | Persistence and recovery   | Persist runtime state, app sessions, event journals, delivery state, and process supervision state.                                                         | The current runtime map is in-memory, so restart loses process/log/routing context.                                                                               |
| 2026-05-06 11:44:41 -05:00 | P0       | Security tests             | Add adversarial tests for auth bypass, CSRF, hostile origin, token leakage, SSRF-style routing attempts, malformed frames, slowloris, and oversized bodies. | Existing tests prove happy paths, not hostile or production edge cases.                                                                                           |

## Implementation Tracker

### Phase 1 - Security Hardening

| Logged                     | Status | Task                                             | Acceptance Criteria                                                                                                                                |
| -------------------------- | ------ | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-05-06 11:44:41 -05:00 | Todo   | Add request origin policy for dashboard and API. | Mutating API rejects unexpected `Origin`, `Host`, and `Sec-Fetch-Site` combinations; tests cover local malicious-origin attempts.                  |
| 2026-05-06 11:44:41 -05:00 | Todo   | Replace JS-exposed bearer token.                 | Dashboard uses an httpOnly, same-site local session or local IPC challenge; token is not present in page source or `window` state.                 |
| 2026-05-06 11:44:41 -05:00 | Todo   | Add timing-safe token comparison.                | Bearer/session token checks use constant-time comparison for equal-length secrets.                                                                 |
| 2026-05-06 11:44:41 -05:00 | Todo   | Add scoped app capabilities.                     | Manifest declares capabilities such as `route:http`, `route:tcp`, `process:start`, `logs:read`; API enforces them per app/client.                  |
| 2026-05-06 11:44:41 -05:00 | Todo   | Add local account/device trust model.            | First-run pairing creates a local admin identity; later tokens are scoped and revocable.                                                           |
| 2026-05-06 11:44:41 -05:00 | Todo   | Add audit log.                                   | Every register/start/stop/restart/config change records timestamp, actor, app id, action, result, and request id.                                  |
| 2026-05-06 11:44:41 -05:00 | Todo   | Add content security policy for dashboard.       | Dashboard ships with CSP, no inline token, and tests verify expected headers.                                                                      |
| 2026-05-06 11:44:41 -05:00 | Todo   | Harden state directory permissions.              | Registry and token files are created with restrictive permissions on Windows, macOS, and Linux; tests verify mode/ACL expectations where possible. |

### Phase 2 - Safe Process Management

| Logged                     | Status | Task                                                 | Acceptance Criteria                                                                                                      |
| -------------------------- | ------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 2026-05-06 11:44:41 -05:00 | Todo   | Replace `command` string with `command` plus `args`. | No production path invokes `spawn` with `shell: true` by default; shell mode requires explicit unsafe opt-in.            |
| 2026-05-06 11:44:41 -05:00 | Todo   | Add manifest schema versioning.                      | `relaybase.app.json` includes `schemaVersion`; migrations and validation errors are deterministic.                       |
| 2026-05-06 11:44:41 -05:00 | Todo   | Add process supervision.                             | Managed apps support restart policy, max restart rate, graceful timeout, kill tree behavior, and crash reason reporting. |
| 2026-05-06 11:44:41 -05:00 | Todo   | Add environment and secret policy.                   | Secrets are redacted from logs/API responses; env injection is explicit and auditable.                                   |
| 2026-05-06 11:44:41 -05:00 | Todo   | Add app sandbox boundaries.                          | Apps cannot claim arbitrary filesystem roots or privileged ports without explicit trust.                                 |
| 2026-05-06 11:44:41 -05:00 | Todo   | Add daemon/service installation path.                | Windows service, macOS launch agent, and Linux systemd/user service are documented and tested.                           |

### Phase 3 - Routing and Protocol Correctness

| Logged                     | Status | Task                                              | Acceptance Criteria                                                                                                                         |
| -------------------------- | ------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-05-06 11:44:41 -05:00 | Todo   | Implement protocol-aware route table.             | Route entries declare protocol, host/path/header matchers, upstream policy, timeout profile, and auth requirements.                         |
| 2026-05-06 11:44:41 -05:00 | Todo   | Harden HTTP proxy behavior.                       | Hop-by-hop headers, `Connection` token parsing, request aborts, trailer behavior, absolute-form requests, and upstream timeouts are tested. |
| 2026-05-06 11:44:41 -05:00 | Todo   | Harden WebSocket proxy behavior.                  | Origin checks, subprotocol forwarding, close codes, ping/pong, compression policy, max frame/message size, and idle timeouts are tested.    |
| 2026-05-06 11:44:41 -05:00 | Todo   | Replace TCP preface with framed session protocol. | TCP sessions include version, target app id, auth proof, stream id, sequence id, deadline, and error codes.                                 |
| 2026-05-06 11:44:41 -05:00 | Todo   | Add gRPC/HTTP2 adapter.                           | Unary and streaming gRPC apps can be registered, routed, traced, and load-tested.                                                           |
| 2026-05-06 11:44:41 -05:00 | Todo   | Add SSE adapter for AI streaming.                 | Long-running AI stream responses preserve chunk order, cancellation, client disconnects, and timeout semantics.                             |
| 2026-05-06 11:44:41 -05:00 | Todo   | Add MCP/JSON-RPC adapter.                         | Tool-call style apps can register capabilities and expose methods through typed routing.                                                    |
| 2026-05-06 11:44:41 -05:00 | Todo   | Add binary codec negotiation.                     | Apps declare `json`, `protobuf`, `msgpack`, `cbor`, or raw binary support with content-type enforcement.                                    |

### Phase 4 - Reliability, Ordering, and No Silent Loss

| Logged                     | Status | Task                          | Acceptance Criteria                                                                                                                                   |
| -------------------------- | ------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-05-06 11:44:41 -05:00 | Todo   | Define delivery levels.       | Platform explicitly supports `best-effort`, `at-least-once`, and `exactly-once-effect via idempotency`; docs avoid impossible packet-loss guarantees. |
| 2026-05-06 11:44:41 -05:00 | Todo   | Add request and message ids.  | Every proxied request/message gets correlation id, app id, route id, trace id, and optional idempotency key.                                          |
| 2026-05-06 11:44:41 -05:00 | Todo   | Add ACK/NACK and retry state. | Agent/app messages can be acknowledged, failed, retried with backoff, or expired by deadline.                                                         |
| 2026-05-06 11:44:41 -05:00 | Todo   | Add durable queue/journal.    | Configurable persistent log records accepted messages before delivery for workflows that require restart recovery.                                    |
| 2026-05-06 11:44:41 -05:00 | Todo   | Add backpressure API.         | Producers get explicit flow-control signals instead of writing unlimited data into memory.                                                            |
| 2026-05-06 11:44:41 -05:00 | Todo   | Add overload behavior.        | Under high load, the hub rejects, queues, or sheds traffic according to route policy and records the decision.                                        |
| 2026-05-06 11:44:41 -05:00 | Todo   | Add chaos and fault tests.    | Tests simulate upstream crash, client disconnect, slow consumer, slow producer, partial frame, timeout, restart, and retry.                           |

### Phase 5 - Interoperability for 3D, Quant, and AI Workloads

| Logged                     | Status | Task                                | Acceptance Criteria                                                                                                                                                                     |
| -------------------------- | ------ | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-05-06 11:44:41 -05:00 | Todo   | Add 3D/game-engine adapter profile. | Unity/Unreal/native tools can register control APIs, binary streams, large asset channels, and optional UDP/QUIC future routes without pretending TCP is enough for all realtime cases. |
| 2026-05-06 11:44:41 -05:00 | Todo   | Add quant/market-data profile.      | Supports strict timestamps, monotonic sequence numbers, replay windows, deterministic logs, latency histograms, and loss detection.                                                     |
| 2026-05-06 11:44:41 -05:00 | Todo   | Add AI wrapper profile.             | Supports streaming tokens, cancellation, tool-call routing, model/provider metadata, prompt/session boundaries, and structured error envelopes.                                         |
| 2026-05-06 11:44:41 -05:00 | Todo   | Add schema registry.                | Apps can publish OpenAPI/AsyncAPI/CloudEvents/Protobuf contracts and clients can discover them.                                                                                         |
| 2026-05-06 11:44:41 -05:00 | Todo   | Add event bus mode.                 | Apps can publish/subscribe to typed events with replay, filtering, and consumer offsets.                                                                                                |
| 2026-05-06 11:44:41 -05:00 | Todo   | Add data bridge workers.            | Data transforms between JSON, Protobuf, binary frames, and app-specific formats are isolated and observable.                                                                            |

### Phase 6 - Observability and Operations

| Logged                     | Status | Task                            | Acceptance Criteria                                                                                                     |
| -------------------------- | ------ | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 2026-05-06 11:44:41 -05:00 | Todo   | Add structured logs.            | JSON logs include timestamp, level, route id, app id, request id, actor, duration, bytes in/out, and result.            |
| 2026-05-06 11:44:41 -05:00 | Todo   | Add OpenTelemetry traces.       | Incoming and outgoing requests propagate `traceparent`; dashboard can show route latency and failure paths.             |
| 2026-05-06 11:44:41 -05:00 | Todo   | Add metrics endpoint.           | Expose app status, connections, bytes, queue depth, retries, dropped/rejected messages, errors, and latency histograms. |
| 2026-05-06 11:44:41 -05:00 | Todo   | Add persistent log storage.     | Process logs are persisted with rotation, retention, search, and redaction.                                             |
| 2026-05-06 11:44:41 -05:00 | Todo   | Add admin diagnostics bundle.   | One command exports sanitized config, recent logs, metrics snapshot, route table, and environment facts.                |
| 2026-05-06 11:44:41 -05:00 | Todo   | Add upgrade/migration strategy. | State schema migrations are tested across versions; rollback limitations are documented.                                |

### Phase 7 - Production Build, Packaging, and CI

| Logged                     | Status  | Task                                       | Acceptance Criteria                                                                                                                      |
| -------------------------- | ------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-05-06 11:44:41 -05:00 | Todo    | Replace runtime TypeScript stripping.      | Production package runs compiled JavaScript; `--experimental-strip-types` is not required for users.                                     |
| 2026-05-11 12:05:30 -05:00 | Done    | Add lockfile and dependency policy.        | `package-lock.json` is committed and Dependabot covers npm plus GitHub Actions updates.                                                  |
| 2026-05-11 12:05:30 -05:00 | Done    | Add cross-platform CI matrix.              | Main CI verification runs on Windows, macOS, and Linux with Node 24.                                                                     |
| 2026-05-11 12:05:30 -05:00 | Done    | Add lint, typecheck, and formatting gates. | `npm.cmd run verify` and GitHub CI fail on formatting drift, lint, type errors, Node tests, Jest failures, and CLI smoke failure.        |
| 2026-05-11 12:05:30 -05:00 | Partial | Add package smoke tests.                   | `npm.cmd run package:check` verifies the packed artifact contents; temp install plus routed runtime smoke remains a future release gate. |
| 2026-05-06 11:44:41 -05:00 | Todo    | Add signed release workflow.               | Releases produce checksums, provenance/attestation, changelog, and version tags.                                                         |

### Phase 8 - Security Review and Release Criteria

| Logged                     | Status | Task                                                  | Acceptance Criteria                                                                                                                    |
| -------------------------- | ------ | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-05-06 11:44:41 -05:00 | Todo   | Write threat model.                                   | Threat model covers local malicious webpages, compromised apps, hostile agents, untrusted manifests, LAN exposure, and secret leakage. |
| 2026-05-06 11:44:41 -05:00 | Todo   | Run dependency and static security scans.             | CI includes dependency audit, static checks, and forbidden dangerous patterns.                                                         |
| 2026-05-06 11:44:41 -05:00 | Todo   | Add fuzz tests for protocol parsers.                  | TCP handshake/framing, JSON bodies, host headers, upgrade requests, and manifest parsing are fuzzed.                                   |
| 2026-05-06 11:44:41 -05:00 | Todo   | Add penetration-test checklist.                       | Local auth, dashboard, API, TCP, process control, logs, and registry persistence are manually tested before beta.                      |
| 2026-05-06 11:44:41 -05:00 | Todo   | Define production support boundary.                   | Docs state supported protocols, unsupported protocols, performance envelopes, and security guarantees.                                 |
| 2026-05-06 11:44:41 -05:00 | Todo   | Remove experimental warning only after criteria pass. | README warning stays until security, reliability, CI, and compatibility gates are complete.                                            |

## Reviewer Notes

- The current project is a good prototype: small, dependency-light, testable, and intentionally localhost-only.
- It is not yet safe as a broad agent platform because the control plane is too trusting, process execution is too broad, and routing lacks production limits.
- "No packet loss" should be implemented as no silent loss. TCP already handles reliable ordered delivery inside one connection, but app-to-app workflows still need delivery records, acknowledgements, retries, idempotency, replay, and visible failure states.
- For 3D engines, do not force everything through HTTP. Keep HTTP/WebSocket for control and telemetry, then add binary stream and future UDP/QUIC profiles for realtime data.
- For quant workloads, correctness needs sequence numbers, replay, monotonic timestamps, and latency histograms. A plain proxy is not enough.
- For AI wrappers, support streaming, cancellation, tool-call contracts, structured errors, and trace propagation from day one.
- Production readiness should be treated as a sequence of gates: security hardening, process safety, protocol contracts, reliability semantics, observability, packaging, then external beta testing.
