import { randomUUID } from "node:crypto";
import type http from "node:http";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  isInitializeRequest,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import type {
  CallToolResult,
  GetPromptResult,
  Prompt,
  ReadResourceResult,
  Resource,
  Tool
} from "@modelcontextprotocol/sdk/types.js";
import { buildAppListResult, requireAppListFilter } from "./appListing.ts";
import { getAllAppStates, getAppState } from "./appState.ts";
import type { DockerSetupOptions } from "./dockerProfile.ts";
import { readManifestFile } from "./registry.ts";
import { sendJson } from "./responses.ts";
import { configureProject } from "./setup.ts";
import { applyRegistration, previewRegistration } from "./setupApi.ts";
import type { RelaybaseRuntime } from "./server.ts";
import type { AppRecord } from "./types.ts";

const RELAYBASE_VERSION = "0.1.0";
const LOCAL_TOKEN_HEADER = "x-relaybase-token";
const MAX_JSON_BODY_BYTES = 1024 * 1024;

interface McpSession {
  server: Server;
  transport: StreamableHTTPServerTransport | SSEServerTransport;
}

type MutationAuthMode = "stdio" | "http";

export class RelaybaseMcpService {
  readonly runtime: RelaybaseRuntime;
  #streamableSessions = new Map<string, McpSession>();
  #sseSessions = new Map<string, McpSession>();
  #servers = new Set<Server>();
  #unsubscribeChildEvents: () => void;

  constructor(runtime: RelaybaseRuntime) {
    this.runtime = runtime;
    this.#unsubscribeChildEvents = runtime.processes.mcp.onEvent((event) => {
      for (const server of this.#servers) {
        if (event.type === "log") {
          void server
            .sendLoggingMessage({
              level: event.level,
              logger: `relaybase.${event.appId}.${event.childId}`,
              data: event.message
            })
            .catch(() => undefined);
        } else if (event.list === "tools") {
          void server.sendToolListChanged().catch(() => undefined);
        } else if (event.list === "resources") {
          void server.sendResourceListChanged().catch(() => undefined);
        } else {
          void server.sendPromptListChanged().catch(() => undefined);
        }
      }
    });
  }

  async connectStdio(): Promise<void> {
    const server = this.#createServer("stdio");
    await server.connect(new StdioServerTransport());
  }

  async handleStreamableHttp(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    try {
      const sessionId = headerValue(request.headers["mcp-session-id"]);
      const parsedBody = request.method === "POST" ? await readJsonBody(request) : undefined;
      const session = sessionId ? this.#streamableSessions.get(sessionId) : undefined;

      if (session) {
        const transport = session.transport;
        if (!(transport instanceof StreamableHTTPServerTransport)) {
          sendJsonRpcError(response, 400, ErrorCode.InvalidRequest, "Session uses a different MCP transport.");
          return;
        }
        await transport.handleRequest(request, response, parsedBody);
        return;
      } else if (!sessionId && request.method === "POST" && isInitializeRequest(parsedBody)) {
        let initializedSessionId: string | undefined;
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            initializedSessionId = newSessionId;
            this.#streamableSessions.set(newSessionId, { server, transport });
          },
          onsessionclosed: (closedSessionId) => {
            const existing = this.#streamableSessions.get(closedSessionId);
            if (existing) {
              this.#streamableSessions.delete(closedSessionId);
              this.#servers.delete(existing.server);
            }
          }
        });
        const server = this.#createServer("http");
        transport.onclose = () => {
          const id = transport.sessionId ?? initializedSessionId;
          if (id) {
            this.#streamableSessions.delete(id);
          }
          this.#servers.delete(server);
        };
        await server.connect(transport);
        await transport.handleRequest(request, response, parsedBody);
        return;
      } else {
        sendJsonRpcError(
          response,
          400,
          ErrorCode.InvalidRequest,
          "No valid MCP session. Initialize with POST /mcp first."
        );
        return;
      }
    } catch (error) {
      if (!response.headersSent) {
        if (error instanceof McpError) {
          sendJsonRpcError(response, 400, error.code, error.message);
          return;
        }

        sendJsonRpcError(
          response,
          500,
          ErrorCode.InternalError,
          error instanceof Error ? error.message : "Relaybase MCP error."
        );
      }
    }
  }

  async handleSse(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/sse", `http://${request.headers.host ?? "localhost"}`);

    try {
      if (request.method === "GET") {
        const transport = new SSEServerTransport("/sse", response);
        const server = this.#createServer("http");
        this.#sseSessions.set(transport.sessionId, { server, transport });
        response.on("close", () => {
          this.#sseSessions.delete(transport.sessionId);
          this.#servers.delete(server);
        });
        await server.connect(transport);
        return;
      }

      if (request.method === "POST") {
        const sessionId = url.searchParams.get("sessionId") ?? "";
        const session = this.#sseSessions.get(sessionId);
        if (!session || !(session.transport instanceof SSEServerTransport)) {
          sendJsonRpcError(response, 400, ErrorCode.InvalidRequest, "No SSE MCP session found for sessionId.");
          return;
        }

        await session.transport.handlePostMessage(request, response);
        return;
      }

      sendJsonRpcError(response, 405, ErrorCode.InvalidRequest, "Method not allowed for /sse.");
    } catch (error) {
      if (!response.headersSent) {
        sendJsonRpcError(
          response,
          500,
          ErrorCode.InternalError,
          error instanceof Error ? error.message : "Relaybase SSE MCP error."
        );
      }
    }
  }

  discoveryDocument(): Record<string, unknown> {
    const baseUrl = `http://localhost:${this.runtime.port}`;
    return {
      product: "Relaybase",
      version: RELAYBASE_VERSION,
      package: "@cameloo/relaybase",
      endpoints: {
        streamableHttp: `${baseUrl}/mcp`,
        legacySse: `${baseUrl}/sse`
      },
      auth: {
        requiredForMutations: true,
        accepted: ["Authorization: Bearer <token>", `${LOCAL_TOKEN_HEADER}: <token>`],
        stateDir: this.runtime.stateDir,
        tokenPath: path.join(this.runtime.stateDir, "session-token"),
        tokenPresent: Boolean(this.runtime.token),
        mismatchHint:
          "Discovery can be healthy while mutations fail with 401 if the client is reading a token from a different Relaybase state directory."
      },
      warning: "Relaybase MCP is local-only by default. Do not expose this endpoint publicly.",
      capabilities: {
        tools: true,
        resources: true,
        prompts: true,
        notifications: true
      }
    };
  }

  async close(): Promise<void> {
    this.#unsubscribeChildEvents();
    await this.runtime.processes.mcp.close();
    for (const session of [...this.#streamableSessions.values(), ...this.#sseSessions.values()]) {
      await session.server.close().catch(() => undefined);
    }
    this.#streamableSessions.clear();
    this.#sseSessions.clear();
    this.#servers.clear();
  }

  #createServer(mutationAuthMode: MutationAuthMode): Server {
    const server = new Server(
      {
        name: "Relaybase",
        version: RELAYBASE_VERSION
      },
      {
        capabilities: {
          tools: { listChanged: true },
          resources: { listChanged: true },
          prompts: { listChanged: true },
          logging: {}
        },
        instructions:
          "Relaybase manages local app processes, app routes, logs, health checks, and child MCP servers for agent-driven development."
      }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: this.#listTools() }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
      this.#callTool(request.params.name, request.params.arguments ?? {}, extra, mutationAuthMode)
    );
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: await this.#listResources() }));
    server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }));
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => this.#readResource(request.params.uri));
    server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: this.#listPrompts() }));
    server.setRequestHandler(GetPromptRequestSchema, async (request) =>
      this.#getPrompt(request.params.name, request.params.arguments ?? {})
    );

    this.#servers.add(server);
    return server;
  }

  #listTools(): Tool[] {
    const lifecycleTools: Tool[] = [
      {
        name: "configure_project",
        description:
          "Analyze, configure, optionally apply, and optionally start one project through the single Relaybase setup flow.",
        inputSchema: objectSchema(
          {
            cwd: stringSchema("Project root directory to configure."),
            apply: {
              type: "boolean",
              description: "When true, write setup artifacts and register the app. False returns a dry-run plan."
            },
            start: {
              type: "boolean",
              description: "When true with apply, start and verify the app through Relaybase."
            },
            profile: stringSchema("Optional setup profile id or architecture to select."),
            envStrategy: {
              type: "string",
              enum: ["runtime-injection", "env-relaybase-file", "guarded-env-block", "none"],
              description: "How Relaybase should handle project env values."
            },
            mcpInstall: {
              type: "boolean",
              description: "Write a Relaybase MCP client config artifact when setup is applied."
            },
            service: stringSchema("Docker Compose app-facing service to select when profile is docker-compose."),
            targetPort: {
              type: "number",
              minimum: 1,
              maximum: 65535,
              description: "Docker target container port for the selected service."
            },
            healthPath: stringSchema("Docker health path to use for readiness, for example /api/health."),
            startTimeoutMs: {
              type: "number",
              minimum: 100,
              maximum: 3600000,
              description: "Docker cold-start/build timeout budget."
            },
            healthTimeoutMs: {
              type: "number",
              minimum: 100,
              maximum: 3600000,
              description: "Docker health wait timeout budget."
            },
            stopTimeoutMs: {
              type: "number",
              minimum: 100,
              maximum: 3600000,
              description: "Docker stop/cleanup timeout budget."
            },
            dependencyPortPolicy: {
              type: "string",
              enum: ["internal-only", "preserve-existing"],
              description: "Whether generated Docker overrides close dependency host ports."
            },
            dockerStartDesktop: {
              type: "boolean",
              description: "Allow generated Docker hooks to start Docker Desktop on Windows."
            }
          },
          ["cwd"]
        ),
        annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      {
        name: "list_apps",
        description: "List registered Relaybase apps and runtime state.",
        inputSchema: objectSchema({
          filter: {
            type: "string",
            enum: ["all", "running", "active", "stopped", "ready", "attention"],
            description: "Optional app list filter. Defaults to all."
          }
        })
      },
      {
        name: "diagnose_token",
        description: "Return read-only Relaybase mutation token diagnostics without exposing token contents.",
        inputSchema: objectSchema()
      },
      {
        name: "app_status",
        description: "Return manifest and runtime status for one app.",
        inputSchema: objectSchema({ id: stringSchema("Relaybase app id.") }, ["id"])
      },
      {
        name: "health_check",
        description: "Run a live health and route reachability check for one app.",
        inputSchema: objectSchema({ id: stringSchema("Relaybase app id.") }, ["id"])
      },
      {
        name: "verify_app",
        description:
          "Return the standard Relaybase app state contract with readiness, route, log, and stop verification fields.",
        inputSchema: objectSchema({ id: stringSchema("Relaybase app id.") }, ["id"])
      },
      {
        name: "prove_app",
        description:
          "Build a proof snapshot for one app; with lifecycle=true, start, verify routed health/logs, stop, and verify cleanup.",
        inputSchema: objectSchema(
          {
            id: stringSchema("Relaybase app id."),
            lifecycle: {
              type: "boolean",
              description: "When true, run start/stop lifecycle proof and require mutation auth."
            }
          },
          ["id"]
        ),
        annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false }
      },
      {
        name: "plan_registration",
        description:
          "Inspect a project folder or exact manifest and return the deterministic approval-bound registration preview without writing files.",
        inputSchema: objectSchema(
          {
            path: stringSchema("Project folder or exact relaybase.app.json path."),
            mode: { type: "string", enum: ["folder", "manifest"] }
          },
          ["path"]
        ),
        annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      {
        name: "register_app",
        description: "Apply an exact registration preview, or register a legacy explicit manifest input.",
        inputSchema: objectSchema({
          manifest: { type: "object", description: "Relaybase app manifest object." },
          manifestPath: stringSchema("Optional path to a relaybase.app.json file."),
          previewId: stringSchema("Exact preview id returned by plan_registration."),
          confirm: { type: "boolean", description: "Must be true when applying previewId." }
        }),
        annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      {
        name: "start_app",
        description: "Start a managed app and its child MCP servers.",
        inputSchema: objectSchema({ id: stringSchema("Relaybase app id.") }, ["id"]),
        annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      {
        name: "stop_app",
        description: "Drain child MCP calls, then stop a managed app.",
        inputSchema: objectSchema({ id: stringSchema("Relaybase app id.") }, ["id"]),
        annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false }
      },
      {
        name: "restart_app",
        description: "Restart a managed app and its child MCP servers.",
        inputSchema: objectSchema({ id: stringSchema("Relaybase app id.") }, ["id"]),
        annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false }
      },
      {
        name: "tail_logs",
        description: "Read recent in-memory logs for one app. This is a snapshot; use log_stream_info for live logs.",
        inputSchema: objectSchema(
          {
            id: stringSchema("Relaybase app id."),
            lines: { type: "number", minimum: 1, maximum: 500, description: "Number of recent log lines to return." },
            follow: {
              type: "boolean",
              description: "Compatibility flag only. Relaybase returns a snapshot and stream instructions."
            }
          },
          ["id"]
        )
      },
      {
        name: "log_stream_info",
        description: "Return the live HTTP SSE log stream URL and event contract for one app.",
        inputSchema: objectSchema({ id: stringSchema("Relaybase app id.") }, ["id"])
      },
      {
        name: "app_url",
        description: "Return the human hostname route or the agent header route for an app.",
        inputSchema: objectSchema(
          {
            id: stringSchema("Relaybase app id."),
            type: { type: "string", enum: ["human", "agent"] }
          },
          ["id", "type"]
        )
      }
    ];

    return [...lifecycleTools, ...this.runtime.processes.mcp.listTools()];
  }

  async #callTool(
    name: string,
    args: Record<string, unknown>,
    extra: unknown,
    mutationAuthMode: MutationAuthMode
  ): Promise<CallToolResult> {
    switch (name) {
      case "list_apps":
        return structuredToolResult(await this.#listApps(args));
      case "diagnose_token":
        return structuredToolResult(this.#tokenDiagnostics());
      case "configure_project":
        if (args.apply === true) {
          this.#requireMutationToken(extra, mutationAuthMode);
        }
        return structuredToolResult(await this.#configureProject(args));
      case "app_status":
        return structuredToolResult({ app: await getAppState(this.runtime, requiredArg(args.id, "id")) });
      case "health_check":
        return structuredToolResult(await this.#healthCheck(requiredArg(args.id, "id")));
      case "verify_app":
        return structuredToolResult({ state: await getAppState(this.runtime, requiredArg(args.id, "id")) });
      case "prove_app":
        if (args.lifecycle === true) {
          this.#requireMutationToken(extra, mutationAuthMode);
        }
        return structuredToolResult(await this.#proveApp(requiredArg(args.id, "id"), args.lifecycle === true));
      case "plan_registration":
        return structuredToolResult(await previewRegistration(this.runtime, args));
      case "register_app":
        this.#requireMutationToken(extra, mutationAuthMode);
        return structuredToolResult({ app: await this.#registerApp(args) });
      case "start_app":
        this.#requireMutationToken(extra, mutationAuthMode);
        return this.#lifecycleResult(requiredArg(args.id, "id"), "start");
      case "stop_app":
        this.#requireMutationToken(extra, mutationAuthMode);
        return this.#lifecycleResult(requiredArg(args.id, "id"), "stop");
      case "restart_app":
        this.#requireMutationToken(extra, mutationAuthMode);
        return this.#lifecycleResult(requiredArg(args.id, "id"), "restart");
      case "tail_logs":
        return structuredToolResult(await this.#tailLogs(args));
      case "log_stream_info":
        return structuredToolResult(await this.#logStreamInfo(requiredArg(args.id, "id")));
      case "app_url":
        return structuredToolResult(await this.#appUrl(requiredArg(args.id, "id"), requiredAppUrlType(args.type)));
      default:
        if (this.runtime.processes.mcp.listTools().some((tool) => tool.name === name)) {
          this.#requireMutationToken(extra, mutationAuthMode);
          return this.runtime.processes.mcp.callTool(name, args);
        }

        throw new McpError(ErrorCode.MethodNotFound, `Unknown Relaybase MCP tool: ${name}`);
    }
  }

  async #registerApp(args: Record<string, unknown>): Promise<AppRecord> {
    if (typeof args.previewId === "string") {
      if (args.confirm !== true) {
        throw new Error("REGISTER_CONFIRMATION_REQUIRED: register_app preview application requires confirm=true.");
      }
      const result = await applyRegistration(
        this.runtime,
        { previewId: args.previewId, confirm: true, confirmation: { confirmed: true, reason: "MCP confirmation" } },
        randomUUID()
      );
      if (!result.app) {
        throw new Error("REGISTER_REGISTRY_FAILED: registration completed without an app record.");
      }
      return result.app;
    }
    if (typeof args.manifestPath === "string") {
      const manifest = await readManifestFile(args.manifestPath);
      return this.runtime.registry.upsertManifest(manifest, { manifestPath: args.manifestPath });
    }

    if (typeof args.manifest !== "object" || args.manifest === null || Array.isArray(args.manifest)) {
      throw new Error("register_app requires manifest or manifestPath.");
    }

    return this.runtime.registry.upsertManifest(args.manifest as Record<string, unknown>);
  }

  async #listApps(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const filter = requireAppListFilter(args.filter);
    const apps = await this.runtime.processes.listStatuses();
    const states = await getAllAppStates(this.runtime);
    const listing = buildAppListResult({
      states,
      statuses: apps,
      filter,
      daemonReachable: true,
      runtimeKnown: true
    });

    return {
      apps,
      states,
      filter: listing.filter,
      summary: listing.summary,
      items: listing.items
    };
  }

  async #configureProject(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const cwd = requiredArg(args.cwd, "cwd");
    const result = await configureProject({
      cwd,
      host: this.runtime.host,
      port: this.runtime.port,
      stateDir: this.runtime.stateDir,
      yes: true,
      dryRun: args.apply !== true,
      noStart: args.start !== true,
      mcpInstall: args.mcpInstall === true,
      startDaemon: false,
      ...(typeof args.profile === "string" ? { profile: args.profile } : {}),
      ...(typeof args.envStrategy === "string" ? { envStrategy: requiredEnvStrategy(args.envStrategy) } : {}),
      docker: dockerSetupOptionsFromArgs(args)
    });

    if (args.apply === true) {
      const manifestPath = path.join(cwd, "relaybase.app.json");
      const manifest = await readManifestFile(manifestPath);
      await this.runtime.registry.upsertManifest(manifest, { manifestPath });
    }

    return result as unknown as Record<string, unknown>;
  }

  async #healthCheck(id: string): Promise<Record<string, unknown>> {
    const health = await this.runtime.processes.healthCheck(id);
    const state = await getAppState(this.runtime, id);
    return {
      ...health,
      status: state.runtime,
      reachable: state.routeReachable,
      backendPortOpen: state.backendPortOpen,
      routeReachable: state.routeReachable,
      readiness: state.readiness,
      state
    };
  }

  async #proveApp(id: string, lifecycle: boolean): Promise<Record<string, unknown>> {
    const checks: Array<Record<string, unknown>> = [];
    const initialState = await getAppState(this.runtime, id);
    checks.push({
      name: "registered",
      ok: initialState.registered,
      message: initialState.registered ? "App is registered." : "App is not registered."
    });
    if (lifecycle) {
      const runtime = await this.runtime.processes.start(id);
      const started = runtime.status === "running";
      const startedState = await getAppState(this.runtime, id);
      checks.push({
        name: "start",
        ok: started,
        message: started ? "App started." : (runtime.lastError ?? "App did not start."),
        runtime
      });
      checks.push({
        name: "routed-health",
        ok: startedState.routeReachable || startedState.readiness.state === "ready",
        message:
          startedState.routeReachable || startedState.readiness.state === "ready"
            ? "Routed health passed."
            : (startedState.readiness.failureReason ?? "Routed health did not pass.")
      });
      const logs = await this.runtime.processes.logs(id);
      checks.push({ name: "logs", ok: true, message: `Log snapshot has ${logs.length} line(s).` });
      const stoppedRuntime = await this.runtime.processes.stop(id);
      const stopped = stoppedRuntime.status === "stopped";
      const stoppedState = await getAppState(this.runtime, id);
      checks.push({
        name: "stop",
        ok: stopped,
        message: stopped ? "App stopped." : (stoppedRuntime.lastError ?? "App did not stop."),
        runtime: stoppedRuntime
      });
      checks.push({
        name: "stop-verification",
        ok: Boolean(stoppedState.stopVerification?.ok),
        message: stoppedState.stopVerification?.ok
          ? "Stop verification passed."
          : (stoppedState.stopVerification?.failureReason ?? "Stop verification did not pass.")
      });
      return {
        id,
        ok: checks.every((check) => check.ok),
        mode: "lifecycle",
        lifecycleAttempted: true,
        started,
        stopped,
        checks,
        finalState: stoppedState
      };
    }

    checks.push({
      name: "routed-health",
      ok: initialState.routeReachable || initialState.readiness.state === "ready",
      message:
        initialState.routeReachable || initialState.readiness.state === "ready"
          ? "Routed health is currently passing."
          : (initialState.readiness.failureReason ?? "Routed health is not currently passing.")
    });
    return {
      id,
      ok: checks.every((check) => check.ok),
      mode: "read-only",
      lifecycleAttempted: false,
      checks,
      state: initialState
    };
  }

  async #lifecycleResult(id: string, action: "start" | "stop" | "restart"): Promise<CallToolResult> {
    const runtime =
      action === "start"
        ? await this.runtime.processes.start(id)
        : action === "stop"
          ? await this.runtime.processes.stop(id)
          : await this.runtime.processes.restart(id);

    return structuredToolResult({
      runtime,
      state: await getAppState(this.runtime, id)
    });
  }

  async #tailLogs(args: Record<string, unknown>): Promise<{
    id: string;
    lines: string[];
    events: unknown[];
    follow: boolean;
    followSupported: boolean;
    followAccepted: boolean;
    logStreamUrl: string;
    message?: string;
  }> {
    const id = requiredArg(args.id, "id");
    const requestedLines =
      typeof args.lines === "number" && Number.isFinite(args.lines)
        ? Math.max(1, Math.min(500, Math.trunc(args.lines)))
        : 100;
    const logs = await this.runtime.processes.logs(id);
    const events = await this.runtime.processes.logEvents(id);
    return {
      id,
      lines: logs.slice(-requestedLines),
      events: events.slice(-requestedLines),
      follow: args.follow === true,
      followSupported: false,
      followAccepted: false,
      logStreamUrl: `http://${this.runtime.host}:${this.runtime.port}/__hub/api/apps/${encodeURIComponent(id)}/logs/stream`,
      ...(args.follow === true
        ? {
            message: "tail_logs returns snapshots only. Use log_stream_info and the HTTP SSE log stream for live logs."
          }
        : {})
    };
  }

  async #logStreamInfo(id: string): Promise<Record<string, unknown>> {
    const app = await this.runtime.registry.get(id);
    if (!app) {
      throw new Error(`Unknown app: ${id}`);
    }

    return {
      id,
      followSupportedInMcpTool: false,
      streamUrl: `http://${this.runtime.host}:${this.runtime.port}/__hub/api/apps/${encodeURIComponent(id)}/logs/stream`,
      transport: "http-sse",
      eventTypes: ["status", "snapshot", "log", "ping"],
      fallbackTool: "tail_logs"
    };
  }

  async #appUrl(id: string, type: "human" | "agent"): Promise<Record<string, unknown>> {
    const app = await this.runtime.registry.get(id);
    if (!app) {
      throw new Error(`Unknown app: ${id}`);
    }

    const port = this.runtime.port;
    if (type === "human") {
      return {
        id,
        type,
        url: `http://${id}.localhost:${port}`
      };
    }

    return {
      id,
      type,
      url: `http://${this.runtime.host}:${port}`,
      headers: {
        "X-Relaybase-App": id
      }
    };
  }

  async #listResources(): Promise<Resource[]> {
    const apps = await this.runtime.registry.list();
    const resources: Resource[] = [
      {
        uri: "relaybase://apps",
        name: "Relaybase apps",
        mimeType: "application/json",
        description: "Registered apps and runtime state."
      },
      {
        uri: "relaybase://dashboard",
        name: "Relaybase dashboard",
        mimeType: "text/plain",
        description: "Human dashboard URL."
      }
    ];

    for (const app of apps) {
      resources.push(
        {
          uri: `relaybase://app/${app.id}/logs`,
          name: `${app.id} logs`,
          mimeType: "text/plain"
        },
        {
          uri: `relaybase://app/${app.id}/manifest`,
          name: `${app.id} manifest`,
          mimeType: "application/json"
        }
      );
    }

    return [...resources, ...this.runtime.processes.mcp.listResources()];
  }

  async #readResource(uri: string): Promise<ReadResourceResult> {
    if (uri === "relaybase://apps") {
      return textResource(
        uri,
        JSON.stringify({ apps: await getAllAppStates(this.runtime) }, null, 2),
        "application/json"
      );
    }

    if (uri === "relaybase://dashboard") {
      return textResource(uri, `http://localhost:${this.runtime.port}/__hub`, "text/plain");
    }

    const appResource = /^relaybase:\/\/app\/([^/]+)\/(logs|manifest)$/.exec(uri);
    if (appResource) {
      const [, id, kind] = appResource;
      if (kind === "logs") {
        return textResource(uri, (await this.runtime.processes.logs(id)).join("\n"), "text/plain");
      }

      const app = await this.runtime.registry.get(id);
      if (!app) {
        throw new Error(`Unknown app: ${id}`);
      }

      return textResource(uri, JSON.stringify(appManifestResource(app), null, 2), "application/json");
    }

    if (uri.startsWith("relaybase://app/") && uri.includes("/mcp/")) {
      return this.runtime.processes.mcp.readResource(uri);
    }

    throw new McpError(ErrorCode.InvalidParams, `Unknown Relaybase MCP resource: ${uri}`);
  }

  #listPrompts(): Prompt[] {
    return [
      {
        name: "debug_app",
        description: "Prefill debugging context for one Relaybase app.",
        arguments: [
          {
            name: "id",
            description: "Relaybase app id.",
            required: true
          }
        ]
      },
      ...this.runtime.processes.mcp.listPrompts()
    ];
  }

  async #getPrompt(name: string, args: Record<string, string>): Promise<GetPromptResult> {
    if (name !== "debug_app") {
      if (this.runtime.processes.mcp.listPrompts().some((prompt) => prompt.name === name)) {
        return this.runtime.processes.mcp.getPrompt(name, args);
      }

      throw new McpError(ErrorCode.InvalidParams, `Unknown Relaybase MCP prompt: ${name}`);
    }

    const id = requiredArg(args.id, "id");
    const state = await getAppState(this.runtime, id);
    const app = await this.runtime.registry.get(id);
    const logs = (await this.runtime.processes.logs(id)).slice(-50);
    const urls = {
      human: await this.#appUrl(id, "human"),
      agent: await this.#appUrl(id, "agent")
    };
    const manifestSummary = {
      id: state.id,
      name: state.name,
      cwd: app?.cwd,
      command: app?.command,
      protocol: app?.protocol,
      healthUrl: app?.healthUrl,
      mcp: app?.mcp,
      humanUrl: state.humanUrl,
      agentUrl: state.agentUrl,
      logSnapshotUrl: state.logSnapshotUrl,
      logStreamUrl: state.logStreamUrl
    };
    const context = {
      state,
      health: state.readiness,
      lastError: state.lastError,
      recentLogs: logs,
      manifest: manifestSummary,
      urls,
      runtime: state.runtime
    };

    return {
      description: `Debug context for Relaybase app ${id}.`,
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Debug Relaybase app "${id}" using this current context:\n\n${JSON.stringify(context, null, 2)}`
          }
        }
      ]
    };
  }

  #requireMutationToken(extra: unknown, mutationAuthMode: MutationAuthMode): void {
    const headers = requestHeaders(extra);
    if (!headers) {
      if (mutationAuthMode === "http") {
        throw this.#mutationAuthError();
      }

      if (!this.runtime.token) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Relaybase state token is unavailable for stdio mutation. ${this.#tokenRecoveryMessage()}`
        );
      }

      return;
    }

    const token = headerValue(headers[LOCAL_TOKEN_HEADER]) ?? bearerToken(headerValue(headers.authorization));
    if (token !== this.runtime.token) {
      throw this.#mutationAuthError();
    }
  }

  #mutationAuthError(): McpError {
    return new McpError(
      ErrorCode.InvalidRequest,
      `UNAUTHORIZED_MUTATION: Unauthorized Relaybase mutation. ${this.#tokenRecoveryMessage()}`
    );
  }

  #tokenRecoveryMessage(): string {
    const diagnostics = this.#tokenDiagnostics();
    return `Run diagnose_token. stateDir=${diagnostics.stateDir}; tokenPath=${diagnostics.tokenPath}; tokenPresent=${diagnostics.tokenPresent}; acceptedHeaders=${diagnostics.acceptedHeaders.join(" or ")}.`;
  }

  #tokenDiagnostics(): {
    requiredForMutations: boolean;
    acceptedHeaders: string[];
    stateDir: string;
    tokenPath: string;
    tokenPresent: boolean;
    tokenLength: number | null;
    mismatchHint: string;
    note: string;
  } {
    return {
      requiredForMutations: true,
      acceptedHeaders: ["Authorization: Bearer <token>", `${LOCAL_TOKEN_HEADER}: <token>`],
      stateDir: this.runtime.stateDir,
      tokenPath: path.join(this.runtime.stateDir, "session-token"),
      tokenPresent: Boolean(this.runtime.token),
      tokenLength: this.runtime.token ? this.runtime.token.length : null,
      mismatchHint:
        "Discovery can be healthy while mutations fail with 401 if the client is reading a token from a different Relaybase state directory.",
      note: "Token contents are intentionally not printed."
    };
  }
}

function objectSchema(properties: Record<string, object> = {}, required: string[] = []): Tool["inputSchema"] {
  return {
    type: "object",
    properties,
    required
  };
}

function stringSchema(description: string): object {
  return {
    type: "string",
    description
  };
}

function structuredToolResult(value: unknown): CallToolResult {
  return {
    structuredContent: value as Record<string, unknown>,
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

function appManifestResource(app: AppRecord): Record<string, unknown> {
  const { env: _env, ...safeApp } = app;
  return safeApp;
}

function textResource(uri: string, text: string, mimeType: string): ReadResourceResult {
  return {
    contents: [
      {
        uri,
        text,
        mimeType
      }
    ]
  };
}

function requiredArg(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Argument ${field} is required.`);
  }

  return value.trim();
}

function requiredAppUrlType(value: unknown): "human" | "agent" {
  if (value === "human" || value === "agent") {
    return value;
  }

  throw new Error('Argument type must be "human" or "agent".');
}

function requiredEnvStrategy(value: string): "runtime-injection" | "env-relaybase-file" | "guarded-env-block" | "none" {
  if (
    value === "runtime-injection" ||
    value === "env-relaybase-file" ||
    value === "guarded-env-block" ||
    value === "none"
  ) {
    return value;
  }

  throw new Error(
    "Argument envStrategy must be one of: runtime-injection, env-relaybase-file, guarded-env-block, none."
  );
}

function dockerSetupOptionsFromArgs(args: Record<string, unknown>): DockerSetupOptions | undefined {
  const docker: DockerSetupOptions = {};
  if (typeof args.service === "string") {
    docker.service = args.service;
  }
  if (typeof args.targetPort === "number" && Number.isInteger(args.targetPort)) {
    docker.targetPort = args.targetPort;
  }
  if (typeof args.healthPath === "string") {
    docker.healthPath = args.healthPath;
  }
  if (typeof args.startTimeoutMs === "number" && Number.isInteger(args.startTimeoutMs)) {
    docker.startTimeoutMs = args.startTimeoutMs;
  }
  if (typeof args.healthTimeoutMs === "number" && Number.isInteger(args.healthTimeoutMs)) {
    docker.healthTimeoutMs = args.healthTimeoutMs;
  }
  if (typeof args.stopTimeoutMs === "number" && Number.isInteger(args.stopTimeoutMs)) {
    docker.stopTimeoutMs = args.stopTimeoutMs;
  }
  if (args.dependencyPortPolicy === "internal-only" || args.dependencyPortPolicy === "preserve-existing") {
    docker.dependencyPortPolicy = args.dependencyPortPolicy;
  }
  if (typeof args.dockerStartDesktop === "boolean") {
    docker.startDockerDesktop = args.dockerStartDesktop;
  }
  return Object.values(docker).some((value) => value !== undefined) ? docker : undefined;
}

function requestHeaders(extra: unknown): http.IncomingHttpHeaders | undefined {
  if (!extra || typeof extra !== "object") {
    return undefined;
  }

  const requestInfo = (extra as { requestInfo?: { headers?: http.IncomingHttpHeaders } }).requestInfo;
  return requestInfo?.headers;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function bearerToken(value: string | undefined): string | undefined {
  return value?.replace(/^Bearer\s+/i, "");
}

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > MAX_JSON_BODY_BYTES) {
      request.destroy();
      throw new McpError(ErrorCode.InvalidRequest, "Request body exceeds the 1 MB limit.");
    }
    chunks.push(buffer);
  }

  if (!chunks.length) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJsonRpcError(response: http.ServerResponse, statusCode: number, code: number, message: string): void {
  sendJson(response, statusCode, {
    jsonrpc: "2.0",
    error: {
      code,
      message
    },
    id: null
  });
}
