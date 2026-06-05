import http from "node:http";
import net from "node:net";
import { handleApiRequest } from "./api.ts";
import { AgentGatewayService } from "./agent/gateway.ts";
import {
  appStateEventData,
  DaemonEventBus,
  lifecycleOperationEventData,
  lifecycleOperationEventType,
  logLineEventData,
  logRotationEventData,
  routeHealthEventData
} from "./daemonEvents.ts";
import { getRelaybaseState } from "./appState.ts";
import { dashboardHtml } from "./dashboard.ts";
import { LogExportService } from "./logExport.ts";
import { LogStore } from "./logStore.ts";
import { OperationStore } from "./operationStore.ts";
import { ProcessManager } from "./processManager.ts";
import { Registry } from "./registry.ts";
import { RelaybaseMcpService } from "./relaybaseMcp.ts";
import { proxyHttpRequest, proxyUpgrade, writeSocketHttpError } from "./proxy.ts";
import { resolveRoute } from "./router.ts";
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_PORT_RANGE_END,
  DEFAULT_PORT_RANGE_START,
  getDefaultStateDir,
  getOrCreateSessionToken
} from "./state.ts";
import { sendHtml, sendJson } from "./responses.ts";
import { maybeHandleTcpTunnel } from "./tcpTunnel.ts";
import type { AppComponent, AppGroup, AppState, ServerOptions } from "./types.ts";

export interface RelaybaseRuntime {
  host: string;
  port: number;
  stateDir: string;
  token: string;
  registry: Registry;
  processes: ProcessManager;
  logStore: LogStore;
  exports: LogExportService;
  agentGateway: AgentGatewayService;
  operations: OperationStore;
  events: DaemonEventBus;
  mcp: RelaybaseMcpService;
}

export interface RelaybaseServer {
  runtime: RelaybaseRuntime;
  httpServer: http.Server;
  netServer: net.Server;
  listen(): Promise<void>;
  close(): Promise<void>;
  address(): { host: string; port: number };
}

export async function createRelaybaseServer(options: ServerOptions = {}): Promise<RelaybaseServer> {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? Number(process.env.RELAYBASE_PORT ?? DEFAULT_PORT);
  const stateDir = options.stateDir ?? getDefaultStateDir();
  const registry = new Registry(stateDir);
  await registry.load();
  const logStore = await LogStore.open(stateDir);
  const token = await getOrCreateSessionToken(stateDir);
  const runtime = {
    host,
    port,
    stateDir,
    token,
    registry,
    logStore,
    exports: undefined as unknown as LogExportService,
    agentGateway: new AgentGatewayService({ stateDir }),
    operations: new OperationStore(),
    events: new DaemonEventBus(),
    processes: new ProcessManager(registry, {
      hubHost: host,
      hubPort: port,
      portRangeStart: options.portRangeStart ?? DEFAULT_PORT_RANGE_START,
      portRangeEnd: options.portRangeEnd ?? DEFAULT_PORT_RANGE_END,
      logStore,
      stopPortOpenProbe: options.stopPortOpenProbe
    })
  } as RelaybaseRuntime;
  runtime.exports = new LogExportService(runtime);
  runtime.mcp = new RelaybaseMcpService(runtime);
  wireDaemonEvents(runtime);

  const sockets = new Set<net.Socket>();
  const httpServer = http.createServer((request, response) => {
    void handleHttp(runtime, request, response);
  });

  httpServer.on("upgrade", (request, socket, head) => {
    void handleUpgrade(runtime, request, socket as net.Socket, Buffer.isBuffer(head) ? head : Buffer.from(head));
  });

  httpServer.on("clientError", (error, socket) => {
    socket.end(`HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n${error.message}`);
  });

  const netServer = net.createServer((socket) => {
    socket.once("data", (chunk) => {
      const firstChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      void maybeHandleTcpTunnel(runtime, socket, firstChunk)
        .then((handled) => {
          if (!handled) {
            socket.pause();
            socket.unshift(firstChunk);
            httpServer.emit("connection", socket);
            socket.resume();
          }
        })
        .catch((error) => {
          socket.end(`Relaybase connection failed: ${error instanceof Error ? error.message : String(error)}\n`);
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
    listen: async () => {
      runtime.port = await listen(netServer, host, port);
    },
    close: () => close(runtime, netServer, httpServer, sockets),
    address: () => {
      const address = netServer.address();
      if (typeof address === "object" && address) {
        return { host, port: address.port };
      }

      return { host, port };
    }
  };
}

function wireDaemonEvents(runtime: RelaybaseRuntime): void {
  runtime.operations.subscribe((operation) => {
    const type = lifecycleOperationEventType(operation);
    runtime.events.publish({
      type,
      appId: operation.appId,
      operationId: operation.operationId,
      correlationId: operation.error?.correlationId,
      data: lifecycleOperationEventData(operation)
    });

    if (type !== "app.lifecycle_operation_completed" && type !== "app.lifecycle_operation_failed") {
      return;
    }

    const state = lifecycleOperationState(operation.result);
    if (!state) {
      return;
    }

    void publishGroupedAppStateChange(runtime, state, operation.operationId, operation.error?.correlationId);
  });

  runtime.processes.subscribeAllLogs((log) => {
    runtime.events.publish({
      type: "log.line_available",
      appId: log.appId,
      data: logLineEventData(log)
    });
  });

  runtime.processes.subscribeLogRotations((rotation) => {
    runtime.events.publish({
      type: "log.stream_rotated",
      appId: rotation.appId,
      data: logRotationEventData(rotation)
    });
  });
}

async function publishGroupedAppStateChange(
  runtime: RelaybaseRuntime,
  fallbackState: AppState,
  operationId: string,
  correlationId?: string
): Promise<void> {
  let state = fallbackState;
  let component: AppComponent | undefined;
  let group: AppGroup | undefined;

  try {
    const snapshot = await getRelaybaseState(runtime);
    state = snapshot.apps.find((app) => app.id === fallbackState.id) ?? fallbackState;
    component = snapshot.components.find((entry) => entry.appId === fallbackState.id);
    if (component) {
      const groupId = component.groupId;
      group = snapshot.groups.find((entry) => entry.groupId === groupId);
    }
  } catch {
    // State-change events are best-effort notifications; clients can recover with /__hub/api/state.
  }

  runtime.events.publish({
    type: "app.state_changed",
    appId: state.id,
    operationId,
    ...(correlationId ? { correlationId } : {}),
    data: appStateEventData(state, operationId, { component, group })
  });

  if (state.routeHealth) {
    runtime.events.publish({
      type: "route.health_changed",
      appId: state.id,
      operationId,
      ...(correlationId ? { correlationId } : {}),
      data: routeHealthEventData(state, operationId)
    });
  }
}

function lifecycleOperationState(result: unknown): AppState | undefined {
  if (!result || typeof result !== "object" || !("state" in result)) {
    return undefined;
  }

  const state = (result as { state?: unknown }).state;
  if (!state || typeof state !== "object" || !("id" in state)) {
    return undefined;
  }

  return state as AppState;
}

async function handleHttp(
  runtime: RelaybaseRuntime,
  request: http.IncomingMessage,
  response: http.ServerResponse
): Promise<void> {
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
    sendJson(response, 404, { error: `Unknown Relaybase app: ${route.appId}`, source: route.source });
    return;
  }

  const target = await runtime.processes.getProxyTarget(app);
  if (!target) {
    sendJson(response, 502, { error: `Relaybase app is not reachable: ${route.appId}`, app });
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

async function handleHub(
  runtime: RelaybaseRuntime,
  request: http.IncomingMessage,
  response: http.ServerResponse
): Promise<void> {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;

  if (pathname === "/__hub" || pathname === "/__hub/") {
    sendHtml(response, 200, dashboardHtml({ token: runtime.token, apps: await runtime.processes.listStatuses() }));
    return;
  }

  if (pathname === "/mcp") {
    await runtime.mcp.handleStreamableHttp(request, response);
    return;
  }

  if (pathname === "/sse") {
    await runtime.mcp.handleSse(request, response);
    return;
  }

  if (pathname === "/.well-known/mcp.json") {
    sendJson(response, 200, runtime.mcp.discoveryDocument());
    return;
  }

  if (pathname.startsWith("/__hub/api/")) {
    await handleApiRequest(runtime, request, response);
    return;
  }

  sendJson(response, 404, { error: "Unknown Relaybase route" });
}

async function handleUpgrade(
  runtime: RelaybaseRuntime,
  request: http.IncomingMessage,
  socket: net.Socket,
  head: Buffer
): Promise<void> {
  const route = resolveRoute({ url: request.url, headers: request.headers });

  if (route.kind === "hub") {
    writeSocketHttpError(socket, 400, "Relaybase dashboard does not accept WebSocket upgrades.");
    return;
  }

  if (route.kind === "unknown") {
    writeSocketHttpError(socket, route.statusCode, route.message);
    return;
  }

  const app = await runtime.registry.get(route.appId);
  if (!app) {
    writeSocketHttpError(socket, 404, `Unknown Relaybase app: ${route.appId}`);
    return;
  }

  const target = await runtime.processes.getProxyTarget(app);
  if (!target) {
    writeSocketHttpError(socket, 502, `Relaybase app is not reachable: ${route.appId}`);
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

function listen(server: net.Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      if (error.code === "EADDRINUSE") {
        reject(new Error(`Relaybase cannot start because ${host}:${port} is already in use.`));
      } else {
        reject(error);
      }
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

async function close(
  runtime: RelaybaseRuntime,
  netServer: net.Server,
  httpServer: http.Server,
  sockets: Set<net.Socket>
): Promise<void> {
  await runtime.mcp.close();
  await runtime.logStore.close();

  return new Promise((resolve) => {
    for (const socket of sockets) {
      socket.destroy();
    }

    httpServer.closeAllConnections?.();
    httpServer.closeIdleConnections?.();
    netServer.close(() => resolve());
  });
}
