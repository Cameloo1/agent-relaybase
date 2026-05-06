import http from "node:http";
import net from "node:net";
import { handleApiRequest } from "./api.ts";
import { dashboardHtml } from "./dashboard.ts";
import { ProcessManager } from "./processManager.ts";
import { Registry } from "./registry.ts";
import { proxyHttpRequest, proxyUpgrade, writeSocketHttpError } from "./proxy.ts";
import { resolveRoute } from "./router.ts";
import { DEFAULT_HOST, DEFAULT_PORT, DEFAULT_PORT_RANGE_END, DEFAULT_PORT_RANGE_START, getDefaultStateDir, getOrCreateSessionToken } from "./state.ts";
import { sendHtml, sendJson } from "./responses.ts";
import { maybeHandleTcpTunnel } from "./tcpTunnel.ts";
import type { ServerOptions } from "./types.ts";

export interface PortHubRuntime {
  host: string;
  port: number;
  stateDir: string;
  token: string;
  registry: Registry;
  processes: ProcessManager;
}

export interface PortHubServer {
  runtime: PortHubRuntime;
  httpServer: http.Server;
  netServer: net.Server;
  listen(): Promise<void>;
  close(): Promise<void>;
  address(): { host: string; port: number };
}

export async function createPortHubServer(options: ServerOptions = {}): Promise<PortHubServer> {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? Number(process.env.PORTHUB_PORT ?? DEFAULT_PORT);
  const stateDir = options.stateDir ?? getDefaultStateDir();
  const registry = new Registry(stateDir);
  await registry.load();
  const token = await getOrCreateSessionToken(stateDir);
  const runtime: PortHubRuntime = {
    host,
    port,
    stateDir,
    token,
    registry,
    processes: new ProcessManager(registry, {
      hubHost: host,
      hubPort: port,
      portRangeStart: options.portRangeStart ?? DEFAULT_PORT_RANGE_START,
      portRangeEnd: options.portRangeEnd ?? DEFAULT_PORT_RANGE_END
    })
  };

  const sockets = new Set<net.Socket>();
  const httpServer = http.createServer((request, response) => {
    void handleHttp(runtime, request, response);
  });

  httpServer.on("upgrade", (request, socket, head) => {
    void handleUpgrade(runtime, request, socket, head);
  });

  httpServer.on("clientError", (error, socket) => {
    socket.end(`HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n${error.message}`);
  });

  const netServer = net.createServer((socket) => {
    socket.once("data", (chunk) => {
      void maybeHandleTcpTunnel(runtime, socket, chunk).then((handled) => {
        if (!handled) {
          socket.unshift(chunk);
          httpServer.emit("connection", socket);
        }
      }).catch((error) => {
        socket.end(`PortHub connection failed: ${error instanceof Error ? error.message : String(error)}\n`);
      });
    });
  });
  netServer.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  return {
    runtime,
    httpServer,
    netServer,
    listen: () => listen(netServer, host, port),
    close: () => close(netServer, httpServer, sockets),
    address: () => {
      const address = netServer.address();
      if (typeof address === "object" && address) {
        return { host, port: address.port };
      }

      return { host, port };
    }
  };
}

async function handleHttp(runtime: PortHubRuntime, request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  const route = resolveRoute({ url: request.url, headers: request.headers });

  if (route.kind === "hub") {
    await handleHub(runtime, request, response);
    return;
  }

  if (route.kind === "unknown") {
    sendJson(response, route.statusCode, { error: route.message });
    return;
  }

  const app = await runtime.registry.get(route.appId);
  if (!app) {
    sendJson(response, 404, { error: `Unknown PortHub app: ${route.appId}`, source: route.source });
    return;
  }

  const target = await runtime.processes.getProxyTarget(app);
  if (!target) {
    sendJson(response, 502, { error: `PortHub app is not reachable: ${route.appId}`, app });
    return;
  }

  proxyHttpRequest({
    request,
    response,
    app,
    targetHost: runtime.host,
    targetPort: target.port
  });
}

async function handleHub(runtime: PortHubRuntime, request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;

  if (pathname === "/__hub" || pathname === "/__hub/") {
    sendHtml(response, 200, dashboardHtml({ token: runtime.token, apps: await runtime.processes.listStatuses() }));
    return;
  }

  if (pathname.startsWith("/__hub/api/")) {
    await handleApiRequest(runtime, request, response);
    return;
  }

  sendJson(response, 404, { error: "Unknown PortHub route" });
}

async function handleUpgrade(runtime: PortHubRuntime, request: http.IncomingMessage, socket: net.Socket, head: Buffer): Promise<void> {
  const route = resolveRoute({ url: request.url, headers: request.headers });

  if (route.kind === "hub") {
    writeSocketHttpError(socket, 400, "PortHub dashboard does not accept WebSocket upgrades.");
    return;
  }

  if (route.kind === "unknown") {
    writeSocketHttpError(socket, route.statusCode, route.message);
    return;
  }

  const app = await runtime.registry.get(route.appId);
  if (!app) {
    writeSocketHttpError(socket, 404, `Unknown PortHub app: ${route.appId}`);
    return;
  }

  const target = await runtime.processes.getProxyTarget(app);
  if (!target) {
    writeSocketHttpError(socket, 502, `PortHub app is not reachable: ${route.appId}`);
    return;
  }

  proxyUpgrade({
    request,
    socket,
    head,
    targetHost: runtime.host,
    targetPort: target.port
  });
}

function listen(server: net.Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      if (error.code === "EADDRINUSE") {
        reject(new Error(`PortHub cannot start because ${host}:${port} is already in use.`));
      } else {
        reject(error);
      }
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function close(netServer: net.Server, httpServer: http.Server, sockets: Set<net.Socket>): Promise<void> {
  return new Promise((resolve) => {
    for (const socket of sockets) {
      socket.destroy();
    }

    httpServer.closeAllConnections?.();
    httpServer.closeIdleConnections?.();
    netServer.close(() => resolve());
  });
}
