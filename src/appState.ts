import http from "node:http";
import type { RelaybaseRuntime } from "./server.ts";
import { isPortOpen } from "./ports.ts";
import type { AppReadiness, AppState, AppStatusView, ReadinessCheck, ReadinessState, RuntimeView } from "./types.ts";

const DEFAULT_READINESS_TIMEOUT_MS = 8000;

interface RouteCheck {
  reachable: boolean;
  statusCode?: number;
  error?: string;
}

export async function getAllAppStates(runtime: RelaybaseRuntime): Promise<AppState[]> {
  const statuses = await runtime.processes.listStatuses();
  return Promise.all(statuses.map((app) => buildAppState(runtime, app.id, { status: app })));
}

export async function getAppState(runtime: RelaybaseRuntime, id: string): Promise<AppState> {
  const statuses = await runtime.processes.listStatuses();
  const status = statuses.find((app) => app.id === id);
  return buildAppState(runtime, id, { status });
}

export function composeAppState(input: {
  id: string;
  name?: string;
  registered: boolean;
  runtime: RuntimeView;
  hubHost: string;
  hubPort: number;
  backendPort?: number;
  backendPortOpen: boolean;
  routeReachable: boolean;
  recentLogs: string[];
  readinessCheckedAt: string;
  timeoutMs?: number;
}): AppState {
  const humanUrl = `http://${input.id}.localhost:${input.hubPort}`;
  const agentUrl = `http://${input.hubHost}:${input.hubPort}`;
  const readiness = buildReadiness({
    registered: input.registered,
    runtime: input.runtime,
    backendPortOpen: input.backendPortOpen,
    routeReachable: input.routeReachable,
    checkedAt: input.readinessCheckedAt,
    timeoutMs: input.timeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS
  });

  return {
    id: input.id,
    name: input.name ?? input.id,
    registered: input.registered,
    runtime: input.runtime,
    ...(input.backendPort ? { backendPort: input.backendPort } : {}),
    backendPortOpen: input.backendPortOpen,
    routeReachable: input.routeReachable,
    humanUrl,
    agentUrl,
    agentHeaders: { "X-Relaybase-App": input.id },
    logSnapshotUrl: `${agentUrl}/__hub/api/apps/${encodeURIComponent(input.id)}/logs`,
    logStreamUrl: `${agentUrl}/__hub/api/apps/${encodeURIComponent(input.id)}/logs/stream`,
    recentLogs: input.recentLogs,
    lastError: input.runtime.lastError ?? null,
    readiness,
    ...(input.runtime.stopVerification ? { stopVerification: input.runtime.stopVerification } : {}),
    ...(input.runtime.mcpChildren?.length ? { mcpChildren: input.runtime.mcpChildren } : {})
  };
}

async function buildAppState(runtime: RelaybaseRuntime, id: string, options: { status?: AppStatusView } = {}): Promise<AppState> {
  const checkedAt = new Date().toISOString();
  const status = options.status;
  const runtimeView = status?.runtime ?? stoppedRuntime();
  const backendPort = runtimeView.assignedPort ?? status?.upstreamPort;
  const backendPortOpen = backendPort ? await isPortOpen(backendPort, runtime.host) : false;
  const route = status && status.protocol !== "tcp"
    ? await checkRouteReachability(runtime, status, DEFAULT_READINESS_TIMEOUT_MS)
    : { reachable: status?.protocol === "tcp" ? backendPortOpen : false };
  const recentLogs = status ? (await runtime.processes.logs(id)).slice(-50) : [];

  const state = composeAppState({
    id,
    name: status?.name,
    registered: Boolean(status),
    runtime: runtimeView,
    hubHost: runtime.host,
    hubPort: runtime.port,
    ...(backendPort ? { backendPort } : {}),
    backendPortOpen,
    routeReachable: route.reachable,
    recentLogs,
    readinessCheckedAt: checkedAt,
    timeoutMs: DEFAULT_READINESS_TIMEOUT_MS
  });

  if (!state.readiness.failureReason && route.error) {
    state.readiness.failureReason = route.error;
  }

  state.readiness.checks.push({
    name: "route-status-code",
    ok: route.reachable,
    checkedAt,
    ...(route.statusCode ? { value: route.statusCode } : {}),
    ...(route.error ? { detail: route.error } : {})
  });

  return state;
}

function stoppedRuntime(): RuntimeView {
  return {
    status: "stopped",
    health: "unknown",
    logLines: 0
  };
}

function buildReadiness(input: {
  registered: boolean;
  runtime: RuntimeView;
  backendPortOpen: boolean;
  routeReachable: boolean;
  checkedAt: string;
  timeoutMs: number;
}): AppReadiness {
  const checks: ReadinessCheck[] = [
    { name: "registered", ok: input.registered, checkedAt: input.checkedAt },
    { name: "runtime-running", ok: input.runtime.status === "running", checkedAt: input.checkedAt, value: input.runtime.status },
    { name: "health", ok: input.runtime.health === "healthy", checkedAt: input.checkedAt, value: input.runtime.health },
    { name: "backend-port-open", ok: input.backendPortOpen, checkedAt: input.checkedAt },
    { name: "route-reachable", ok: input.routeReachable, checkedAt: input.checkedAt }
  ];

  const state = readinessState(input);
  const failureReason = readinessFailureReason(input);

  return {
    state,
    checkedAt: input.checkedAt,
    checks,
    timeoutMs: input.timeoutMs,
    ...(failureReason ? { failureReason } : {})
  };
}

function readinessState(input: { registered: boolean; runtime: RuntimeView; backendPortOpen: boolean; routeReachable: boolean }): ReadinessState {
  if (!input.registered) {
    return "unregistered";
  }

  if (input.runtime.status === "stopped") {
    return "stopped";
  }

  if (input.runtime.status === "starting") {
    return "starting";
  }

  if (input.runtime.status === "errored" || input.runtime.status === "conflict") {
    return "failed";
  }

  if (input.runtime.status === "running" && input.runtime.health === "healthy" && input.backendPortOpen && input.routeReachable) {
    return "ready";
  }

  return "unhealthy";
}

function readinessFailureReason(input: { registered: boolean; runtime: RuntimeView; backendPortOpen: boolean; routeReachable: boolean }): string | undefined {
  if (!input.registered) {
    return "App is not registered.";
  }

  if (input.runtime.lastError) {
    return input.runtime.lastError;
  }

  if (input.runtime.status === "starting") {
    return "App is still starting or did not become ready before the startup timeout.";
  }

  if (input.runtime.status === "stopped") {
    return "App is stopped.";
  }

  if (!input.backendPortOpen) {
    return "Backend port is not open.";
  }

  if (!input.routeReachable) {
    return "Relaybase route is not reachable.";
  }

  if (input.runtime.health !== "healthy") {
    return "App health is not healthy.";
  }

  return undefined;
}

async function checkRouteReachability(runtime: RelaybaseRuntime, app: AppStatusView, timeoutMs: number): Promise<RouteCheck> {
  const path = routeHealthPath(app.healthUrl);
  return new Promise((resolve) => {
    const request = http.request({
      host: runtime.host,
      port: runtime.port,
      path,
      method: "GET",
      timeout: Math.min(timeoutMs, 1000),
      headers: {
        host: "localhost",
        "x-relaybase-app": app.id
      }
    }, (response) => {
      response.resume();
      const statusCode = response.statusCode ?? 0;
      resolve({
        reachable: statusCode >= 200 && statusCode < 500,
        statusCode
      });
    });

    request.once("timeout", () => {
      request.destroy();
      resolve({ reachable: false, error: "Relaybase route check timed out." });
    });
    request.once("error", (error) => resolve({ reachable: false, error: error.message }));
    request.end();
  });
}

function routeHealthPath(healthUrl?: string): string {
  if (!healthUrl) {
    return "/";
  }

  if (healthUrl.startsWith("http://") || healthUrl.startsWith("https://")) {
    try {
      const parsed = new URL(healthUrl);
      return `${parsed.pathname}${parsed.search}`;
    } catch {
      return "/";
    }
  }

  return healthUrl.startsWith("/") ? healthUrl : `/${healthUrl}`;
}
