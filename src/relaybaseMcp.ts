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
import type { CallToolResult, GetPromptResult, Prompt, ReadResourceResult, Resource, Tool } from "@modelcontextprotocol/sdk/types.js";
import { getAllAppStates, getAppState } from "./appState.ts";
import { readManifestFile } from "./registry.ts";
import { sendJson } from "./responses.ts";
import type { RelaybaseRuntime } from "./server.ts";
import type { AppRecord } from "./types.ts";

const RELAYBASE_VERSION = "0.1.0";
const LOCAL_TOKEN_HEADER = "x-relaybase-token";

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
          void server.sendLoggingMessage({
            level: event.level,
            logger: `relaybase.${event.appId}.${event.childId}`,
            data: event.message
          }).catch(() => undefined);
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
      let session = sessionId ? this.#streamableSessions.get(sessionId) : undefined;

      if (session) {
        if (!(session.transport instanceof StreamableHTTPServerTransport)) {
          sendJsonRpcError(response, 400, ErrorCode.InvalidRequest, "Session uses a different MCP transport.");
          return;
        }
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
        session = { server, transport };
      } else {
        sendJsonRpcError(response, 400, ErrorCode.InvalidRequest, "No valid MCP session. Initialize with POST /mcp first.");
        return;
      }

      await session.transport.handleRequest(request, response, parsedBody);
    } catch (error) {
      if (!response.headersSent) {
        sendJsonRpcError(response, 500, ErrorCode.InternalError, error instanceof Error ? error.message : "Relaybase MCP error.");
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
        sendJsonRpcError(response, 500, ErrorCode.InternalError, error instanceof Error ? error.message : "Relaybase SSE MCP error.");
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
        accepted: [
          "Authorization: Bearer <token>",
          `${LOCAL_TOKEN_HEADER}: <token>`
        ],
        stateDir: this.runtime.stateDir,
        tokenPath: path.join(this.runtime.stateDir, "session-token"),
        tokenPresent: Boolean(this.runtime.token),
        mismatchHint: "Discovery can be healthy while mutations fail with 401 if the client is reading a token from a different Relaybase state directory."
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
    const server = new Server({
      name: "Relaybase",
      version: RELAYBASE_VERSION
    }, {
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true },
        prompts: { listChanged: true },
        logging: {}
      },
      instructions: "Relaybase manages local app processes, app routes, logs, health checks, and child MCP servers for agent-driven development."
    });

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: this.#listTools() }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => this.#callTool(request.params.name, request.params.arguments ?? {}, extra, mutationAuthMode));
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: await this.#listResources() }));
    server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }));
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => this.#readResource(request.params.uri));
    server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: this.#listPrompts() }));
    server.setRequestHandler(GetPromptRequestSchema, async (request) => this.#getPrompt(request.params.name, request.params.arguments ?? {}));

    this.#servers.add(server);
    return server;
  }

  #listTools(): Tool[] {
    const lifecycleTools: Tool[] = [
      {
        name: "list_apps",
        description: "List registered Relaybase apps and runtime state.",
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
        description: "Return the standard Relaybase app state contract with readiness, route, log, and stop verification fields.",
        inputSchema: objectSchema({ id: stringSchema("Relaybase app id.") }, ["id"])
      },
      {
        name: "register_app",
        description: "Register or update an app manifest.",
        inputSchema: objectSchema({
          manifest: { type: "object", description: "Relaybase app manifest object." },
          manifestPath: stringSchema("Optional path to a relaybase.app.json file.")
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
        description: "Read recent in-memory logs for one app.",
        inputSchema: objectSchema({
          id: stringSchema("Relaybase app id."),
          lines: { type: "number", minimum: 1, maximum: 500, description: "Number of recent log lines to return." },
          follow: { type: "boolean", description: "Accepted for compatibility; this tool returns a snapshot." }
        }, ["id"])
      },
      {
        name: "app_url",
        description: "Return the human hostname route or the agent header route for an app.",
        inputSchema: objectSchema({
          id: stringSchema("Relaybase app id."),
          type: { type: "string", enum: ["human", "agent"] }
        }, ["id", "type"])
      }
    ];

    return [...lifecycleTools, ...this.runtime.processes.mcp.listTools()];
  }

  async #callTool(name: string, args: Record<string, unknown>, extra: unknown, mutationAuthMode: MutationAuthMode): Promise<CallToolResult> {
    switch (name) {
      case "list_apps":
        return structuredToolResult({ apps: await this.runtime.processes.listStatuses(), states: await getAllAppStates(this.runtime) });
      case "app_status":
        return structuredToolResult({ app: await getAppState(this.runtime, requiredArg(args.id, "id")) });
      case "health_check":
        return structuredToolResult(await this.#healthCheck(requiredArg(args.id, "id")));
      case "verify_app":
        return structuredToolResult({ state: await getAppState(this.runtime, requiredArg(args.id, "id")) });
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
      case "app_url":
        return structuredToolResult(await this.#appUrl(requiredArg(args.id, "id"), requiredAppUrlType(args.type)));
      default:
        if (this.runtime.processes.mcp.listTools().some((tool) => tool.name === name)) {
          return this.runtime.processes.mcp.callTool(name, args);
        }

        throw new McpError(ErrorCode.MethodNotFound, `Unknown Relaybase MCP tool: ${name}`);
    }
  }

  async #registerApp(args: Record<string, unknown>): Promise<AppRecord> {
    if (typeof args.manifestPath === "string") {
      const manifest = await readManifestFile(args.manifestPath);
      return this.runtime.registry.upsertManifest(manifest, { manifestPath: args.manifestPath });
    }

    if (typeof args.manifest !== "object" || args.manifest === null || Array.isArray(args.manifest)) {
      throw new Error("register_app requires manifest or manifestPath.");
    }

    return this.runtime.registry.upsertManifest(args.manifest as Record<string, unknown>);
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

  async #lifecycleResult(id: string, action: "start" | "stop" | "restart"): Promise<CallToolResult> {
    const runtime = action === "start"
      ? await this.runtime.processes.start(id)
      : action === "stop"
        ? await this.runtime.processes.stop(id)
        : await this.runtime.processes.restart(id);

    return structuredToolResult({
      runtime,
      state: await getAppState(this.runtime, id)
    });
  }

  async #tailLogs(args: Record<string, unknown>): Promise<{ id: string; lines: string[]; events: unknown[]; follow: boolean; followAccepted: boolean; logStreamUrl: string }> {
    const id = requiredArg(args.id, "id");
    const requestedLines = typeof args.lines === "number" && Number.isFinite(args.lines)
      ? Math.max(1, Math.min(500, Math.trunc(args.lines)))
      : 100;
    const logs = await this.runtime.processes.logs(id);
    const events = await this.runtime.processes.logEvents(id);
    return {
      id,
      lines: logs.slice(-requestedLines),
      events: events.slice(-requestedLines),
      follow: args.follow === true,
      followAccepted: false,
      logStreamUrl: `http://${this.runtime.host}:${this.runtime.port}/__hub/api/apps/${encodeURIComponent(id)}/logs/stream`
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
      resources.push({
        uri: `relaybase://app/${app.id}/logs`,
        name: `${app.id} logs`,
        mimeType: "text/plain"
      }, {
        uri: `relaybase://app/${app.id}/manifest`,
        name: `${app.id} manifest`,
        mimeType: "application/json"
      });
    }

    return [...resources, ...this.runtime.processes.mcp.listResources()];
  }

  async #readResource(uri: string): Promise<ReadResourceResult> {
    if (uri === "relaybase://apps") {
      return textResource(uri, JSON.stringify({ apps: await getAllAppStates(this.runtime) }, null, 2), "application/json");
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

      return textResource(uri, JSON.stringify(app, null, 2), "application/json");
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
        throw new McpError(ErrorCode.InvalidRequest, "UNAUTHORIZED_MUTATION: Unauthorized Relaybase mutation.");
      }

      if (!this.runtime.token) {
        throw new McpError(ErrorCode.InvalidRequest, "Relaybase state token is unavailable for stdio mutation.");
      }

      return;
    }

    const token = headerValue(headers[LOCAL_TOKEN_HEADER]) ?? bearerToken(headerValue(headers.authorization));
    if (token !== this.runtime.token) {
      throw new McpError(ErrorCode.InvalidRequest, "UNAUTHORIZED_MUTATION: Unauthorized Relaybase mutation.");
    }
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

  throw new Error("Argument type must be \"human\" or \"agent\".");
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
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
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
