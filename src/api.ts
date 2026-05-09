import type http from "node:http";
import path from "node:path";
import { getAllAppStates, getAppState } from "./appState.ts";
import { readManifestFile } from "./registry.ts";
import { notFound, sendJson } from "./responses.ts";
import type { RelaybaseRuntime } from "./server.ts";

class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly recoverable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(statusCode: number, code: string, message: string, options: { recoverable?: boolean; details?: Record<string, unknown> } = {}) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.recoverable = options.recoverable ?? statusCode >= 400;
    this.details = options.details;
  }
}

export async function handleApiRequest(runtime: RelaybaseRuntime, request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);

  try {
    if (request.method === "GET" && url.pathname === "/__hub/api/state") {
      sendJson(response, 200, { apps: await getAllAppStates(runtime) });
      return;
    }

    if (request.method === "GET" && url.pathname === "/__hub/api/apps") {
      sendJson(response, 200, { apps: await runtime.processes.listStatuses() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/__hub/api/apps/register") {
      requireToken(runtime, request);
      const body = await readJsonBody(request);
      const manifest = typeof body.manifestPath === "string"
        ? await readManifestFile(body.manifestPath)
        : body;
      const app = await runtime.registry.upsertManifest(manifest, typeof body.manifestPath === "string" ? { manifestPath: body.manifestPath } : {});
      sendJson(response, 201, { app });
      return;
    }

    if (parts.length === 5 && parts[0] === "__hub" && parts[1] === "api" && parts[2] === "apps") {
      const id = parts[3];
      const action = parts[4];

      if (request.method === "POST" && action === "start") {
        requireToken(runtime, request);
        const started = await runtime.processes.start(id);
        sendJson(response, 200, { runtime: started, state: await getAppState(runtime, id) });
        return;
      }

      if (request.method === "POST" && action === "stop") {
        requireToken(runtime, request);
        const stopped = await runtime.processes.stop(id);
        sendJson(response, 200, { runtime: stopped, state: await getAppState(runtime, id) });
        return;
      }

      if (request.method === "POST" && action === "restart") {
        requireToken(runtime, request);
        const restarted = await runtime.processes.restart(id);
        sendJson(response, 200, { runtime: restarted, state: await getAppState(runtime, id) });
        return;
      }
    }

    if (request.method === "GET" && parts.length === 5 && parts[0] === "__hub" && parts[1] === "api" && parts[2] === "apps" && parts[4] === "state") {
      sendJson(response, 200, { state: await getAppState(runtime, parts[3]) });
      return;
    }

    if (request.method === "GET" && parts.length === 6 && parts[0] === "__hub" && parts[1] === "api" && parts[2] === "apps" && parts[4] === "logs" && parts[5] === "stream") {
      await streamAppLogs(runtime, request, response, parts[3]);
      return;
    }

    if (request.method === "GET" && parts.length === 5 && parts[0] === "__hub" && parts[1] === "api" && parts[2] === "apps" && parts[4] === "logs") {
      sendJson(response, 200, {
        id: parts[3],
        logs: await runtime.processes.logs(parts[3]),
        events: await runtime.processes.logEvents(parts[3]),
        streamUrl: `http://${runtime.host}:${runtime.port}/__hub/api/apps/${encodeURIComponent(parts[3])}/logs/stream`
      });
      return;
    }

    notFound(response);
  } catch (error) {
    sendApiError(runtime, response, error);
  }
}

async function streamAppLogs(runtime: RelaybaseRuntime, request: http.IncomingMessage, response: http.ServerResponse, id: string): Promise<void> {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  response.flushHeaders?.();

  let closed = false;
  const send = (event: string, data: unknown) => {
    if (closed || response.destroyed) {
      return;
    }
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send("status", { id, state: "connected", at: new Date().toISOString() });
  send("snapshot", {
    id,
    lines: (await runtime.processes.logs(id)).slice(-300),
    events: (await runtime.processes.logEvents(id)).slice(-300),
    at: new Date().toISOString()
  });

  const unsubscribe = runtime.processes.subscribeLogs(id, (log) => {
    send("log", log);
  });
  const heartbeat = setInterval(() => {
    send("ping", { id, at: new Date().toISOString() });
  }, 15_000);

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

function requireToken(runtime: RelaybaseRuntime, request: http.IncomingMessage): void {
  const token = request.headers["x-relaybase-token"] ?? request.headers.authorization?.replace(/^Bearer\s+/i, "");
  const actual = Array.isArray(token) ? token[0] : token;
  if (actual !== runtime.token) {
    throw new ApiError(401, "UNAUTHORIZED_MUTATION", "Unauthorized Relaybase mutation.", {
      recoverable: true,
      details: tokenDiagnostics(runtime)
    });
  }
}

function sendApiError(runtime: RelaybaseRuntime, response: http.ServerResponse, error: unknown): void {
  if (error instanceof ApiError) {
    sendJson(response, error.statusCode, {
      error: error.message,
      code: error.code,
      recoverable: error.recoverable,
      details: error.details
    });
    return;
  }

  const message = error instanceof Error ? error.message : "Unknown Relaybase API error.";
  sendJson(response, 400, {
    error: message,
    code: "RELAYBASE_API_ERROR",
    recoverable: true,
    details: {
      stateDir: runtime.stateDir
    }
  });
}

function tokenDiagnostics(runtime: RelaybaseRuntime): Record<string, unknown> {
  return {
    requiredForMutations: true,
    acceptedHeaders: [
      "Authorization: Bearer <token>",
      "x-relaybase-token: <token>"
    ],
    stateDir: runtime.stateDir,
    tokenPath: path.join(runtime.stateDir, "session-token"),
    tokenPresent: Boolean(runtime.token),
    mismatchHint: "Discovery can be healthy while mutations return 401 if the client reads a token from a different Relaybase state directory."
  };
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

