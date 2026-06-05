import type http from "node:http";
import type { RelaybaseRuntime } from "../server.ts";
import { sendJson } from "../responses.ts";
import { AgentGatewayRequestError } from "./gateway.ts";
import type { AgentMessageRequest } from "./types.ts";

type RequireToken = (options?: { code?: string; message?: string; userAction?: string }) => void;

export async function handleAgentApiRequest(input: {
  runtime: RelaybaseRuntime;
  request: http.IncomingMessage;
  response: http.ServerResponse;
  parts: string[];
  requireToken: RequireToken;
}): Promise<boolean> {
  const { runtime, request, response, parts, requireToken } = input;
  if (parts[0] !== "__hub" || parts[1] !== "api" || parts[2] !== "agent") {
    return false;
  }

  requireToken({
    code: "UNAUTHORIZED_AGENT_GATEWAY",
    message: "Unauthorized Relaybase Agent Gateway access.",
    userAction: "Use the session token from this daemon state directory before using the Agent Gateway."
  });

  const route = parts.slice(3);

  if (request.method === "GET" && route.length === 1 && route[0] === "config") {
    sendJson(response, 200, { agent: { config: runtime.agentGateway.getConfig() } });
    return true;
  }

  if (request.method === "PUT" && route.length === 1 && route[0] === "config") {
    const body = await readJsonBody(request);
    sendJson(response, 200, { agent: { config: runtime.agentGateway.updateConfig(body) } });
    return true;
  }

  if (request.method === "POST" && route.length === 1 && route[0] === "sessions") {
    const body = await readJsonBody(request);
    const session = await runtime.agentGateway.createSession(runtime, body);
    sendJson(response, 201, { agent: { session } });
    return true;
  }

  if (request.method === "GET" && route.length === 1 && route[0] === "sessions") {
    sendJson(response, 200, { agent: { sessions: runtime.agentGateway.listSessions() } });
    return true;
  }

  if (request.method === "GET" && route.length === 2 && route[0] === "sessions" && route[1] === "active") {
    sendJson(response, 200, { agent: { session: runtime.agentGateway.getActiveSession() ?? null } });
    return true;
  }

  if (request.method === "GET" && route.length === 2 && route[0] === "sessions") {
    sendJson(response, 200, { agent: { session: runtime.agentGateway.getSession(route[1]) } });
    return true;
  }

  if (request.method === "PATCH" && route.length === 2 && route[0] === "sessions") {
    const body = await readJsonBody(request);
    const session = await runtime.agentGateway.updateSession(runtime, route[1], body);
    sendJson(response, 200, { agent: { session } });
    return true;
  }

  if (request.method === "POST" && route.length === 3 && route[0] === "sessions" && route[2] === "activate") {
    sendJson(response, 200, { agent: { session: runtime.agentGateway.activateSession(route[1]) } });
    return true;
  }

  if (request.method === "POST" && route.length === 3 && route[0] === "sessions" && route[2] === "clear") {
    sendJson(response, 200, { agent: { session: runtime.agentGateway.clearSession(route[1]) } });
    return true;
  }

  if (request.method === "DELETE" && route.length === 2 && route[0] === "sessions") {
    sendJson(response, 200, { agent: { session: runtime.agentGateway.clearSession(route[1]) } });
    return true;
  }

  if (request.method === "GET" && route.length === 3 && route[0] === "sessions" && route[2] === "export") {
    const url = new URL(request.url ?? "/", "http://localhost");
    const format = url.searchParams.get("format") === "markdown" ? "markdown" : "json";
    sendJson(response, 200, { agent: { export: runtime.agentGateway.exportSession(route[1], { format }) } });
    return true;
  }

  if (request.method === "GET" && route.length === 3 && route[0] === "sessions" && route[2] === "context-preview") {
    sendJson(response, 200, { agent: { contextPreview: runtime.agentGateway.threadContextPreview(route[1]) } });
    return true;
  }

  if (request.method === "POST" && route.length === 3 && route[0] === "sessions" && route[2] === "messages") {
    const body = await readJsonBody(request);
    const result = await runtime.agentGateway.addMessage(runtime, route[1], body as unknown as AgentMessageRequest);
    sendJson(response, 202, { agent: result });
    return true;
  }

  if (request.method === "GET" && route.length === 3 && route[0] === "sessions" && route[2] === "events") {
    const url = new URL(request.url ?? "/", "http://localhost");
    await streamAgentSessionEvents(runtime, request, response, route[1], parseAfterSequence(url, request));
    return true;
  }

  if (request.method === "POST" && route.length === 3 && route[0] === "approvals" && route[2] === "approve") {
    const body = await readJsonBody(request);
    const approval = await runtime.agentGateway.resolveApproval(runtime, route[1], "approved", body);
    sendJson(response, 200, { agent: { approval } });
    return true;
  }

  if (request.method === "POST" && route.length === 3 && route[0] === "approvals" && route[2] === "reject") {
    const body = await readJsonBody(request);
    const approval = await runtime.agentGateway.resolveApproval(runtime, route[1], "rejected", body);
    sendJson(response, 200, { agent: { approval } });
    return true;
  }

  if (request.method === "GET" && route.length === 1 && route[0] === "diagnostics") {
    sendJson(response, 200, { agent: { diagnostics: await runtime.agentGateway.diagnostics(runtime) } });
    return true;
  }

  throw new AgentGatewayRequestError(404, "AGENT_ROUTE_NOT_FOUND", "Relaybase Agent Gateway route was not found.", {
    retryable: false,
    detail: { method: request.method, route: parts.join("/") },
    userAction: "Use one of the documented /__hub/api/agent routes."
  });
}

async function streamAgentSessionEvents(
  runtime: RelaybaseRuntime,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  sessionId: string,
  afterSequence: number
): Promise<void> {
  runtime.agentGateway.getSession(sessionId);
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  response.flushHeaders?.();

  let closed = false;
  const send = (eventName: string, id: string, data: unknown, retryMs?: number) => {
    if (closed || response.destroyed) {
      return;
    }
    if (retryMs !== undefined) {
      response.write(`retry: ${retryMs}\n`);
    }
    response.write(`id: ${id}\nevent: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send(
    "diagnostic",
    "agent-session-connected",
    {
      sessionId,
      reconnect: {
        replay: "snapshot_only",
        requiresSessionRefresh: true,
        lastEventId: headerText(request.headers["last-event-id"]) || null,
        afterSequence
      }
    },
    3000
  );

  for (const event of runtime.agentGateway.sessionEvents(sessionId, afterSequence)) {
    send(event.type, event.id, event);
  }

  const unsubscribe = runtime.agentGateway.subscribeSession(sessionId, (event) => {
    send(event.type, event.id, event);
  });
  const heartbeat = setInterval(() => {
    if (!closed && !response.destroyed) {
      response.write(`: heartbeat ${new Date().toISOString()}\n\n`);
    }
  }, 1000);

  const cleanup = () => {
    if (closed) {
      return;
    }
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    if (!response.destroyed) {
      response.end();
    }
  };
  request.once("close", cleanup);
  response.once("close", cleanup);
}

function headerText(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join(",") : (value ?? "");
}

function parseAfterSequence(url: URL, request: http.IncomingMessage): number {
  const queryValue = url.searchParams.get("afterSequence");
  const headerValue = headerText(request.headers["last-event-id"]);
  const value = queryValue ?? sequenceFromEventId(headerValue);
  if (!value) {
    return 0;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function sequenceFromEventId(value: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const match = value.match(/(?:^|:)(\d+)$/);
  return match?.[1] ?? (/^\d+$/.test(value) ? value : undefined);
}

async function readJsonBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}
