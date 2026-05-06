import type http from "node:http";
import { readManifestFile } from "./registry.ts";
import { notFound, sendJson } from "./responses.ts";
import type { PortHubRuntime } from "./server.ts";

export async function handleApiRequest(runtime: PortHubRuntime, request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);

  try {
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
        sendJson(response, 200, { runtime: await runtime.processes.start(id) });
        return;
      }

      if (request.method === "POST" && action === "stop") {
        requireToken(runtime, request);
        sendJson(response, 200, { runtime: await runtime.processes.stop(id) });
        return;
      }

      if (request.method === "POST" && action === "restart") {
        requireToken(runtime, request);
        sendJson(response, 200, { runtime: await runtime.processes.restart(id) });
        return;
      }
    }

    if (request.method === "GET" && parts.length === 5 && parts[0] === "__hub" && parts[1] === "api" && parts[2] === "apps" && parts[4] === "logs") {
      sendJson(response, 200, { id: parts[3], logs: await runtime.processes.logs(parts[3]) });
      return;
    }

    notFound(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown PortHub API error.";
    sendJson(response, message === "Unauthorized" ? 401 : 400, { error: message });
  }
}

function requireToken(runtime: PortHubRuntime, request: http.IncomingMessage): void {
  const token = request.headers["x-port-hub-token"] ?? request.headers.authorization?.replace(/^Bearer\s+/i, "");
  const actual = Array.isArray(token) ? token[0] : token;
  if (actual !== runtime.token) {
    throw new Error("Unauthorized");
  }
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

