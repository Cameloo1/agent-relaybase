import http from "node:http";
import { buildAppComponentState } from "./appComponents.ts";
import { isHealthyHttpStatus } from "./health.ts";
import type { RelaybaseRuntime } from "./server.ts";
import { isPortOpen } from "./ports.ts";
import type { RelaybaseState } from "./apiTypes.ts";
import type {
  AppReadiness,
  AppState,
  AppStatusView,
  ReadinessCheck,
  ReadinessState,
  RouteHealth,
  RouteProbe,
  RuntimeView
} from "./types.ts";

const DEFAULT_READINESS_TIMEOUT_MS = 8000;
// State snapshots feed interactive clients. They must not inherit a full app
// startup budget from a slow or wedged route; explicit lifecycle proof already
// owns the longer readiness wait.
const MAX_ROUTE_PROBE_TIMEOUT_MS = 2_000;

export async function getRelaybaseState(runtime: RelaybaseRuntime): Promise<RelaybaseState> {
  const generatedAt = new Date().toISOString();
  const statuses = await runtime.processes.listStatuses();
  const apps = await Promise.all(statuses.map((app) => buildAppState(runtime, app.id, { status: app })));
  const componentState = buildAppComponentState({ states: apps, statuses, generatedAt });

  return {
    apps,
    groups: componentState.groups,
    components: componentState.components,
    ...(componentState.diagnostics.length ? { diagnostics: componentState.diagnostics } : {}),
    generatedAt
  };
}

export async function getAllAppStates(runtime: RelaybaseRuntime): Promise<AppState[]> {
  return (await getRelaybaseState(runtime)).apps;
}

export async function getAppState(runtime: RelaybaseRuntime, id: string): Promise<AppState> {
  const statuses = await runtime.processes.listStatuses();
  const status = statuses.find((app) => app.id === id);
  return buildAppState(runtime, id, { status });
}

export function composeAppState(input: {
  id: string;
  name?: string;
  cwd?: string;
  manifestPath?: string;
  registered: boolean;
  runtime: RuntimeView;
  hubHost: string;
  hubPort: number;
  backendPort?: number;
  backendPortOpen: boolean;
  routeReachable: boolean;
  routeHealth?: RouteHealth;
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
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.manifestPath ? { manifestPath: input.manifestPath } : {}),
    registered: input.registered,
    runtime: input.runtime,
    ...(input.backendPort ? { backendPort: input.backendPort } : {}),
    backendPortOpen: input.backendPortOpen,
    routeReachable: input.routeReachable,
    ...(input.routeHealth ? { routeHealth: input.routeHealth } : {}),
    humanUrl,
    agentUrl,
    agentHeaders: { "X-Relaybase-App": input.id },
    logSnapshotUrl: `${agentUrl}/__hub/api/apps/${encodeURIComponent(input.id)}/logs`,
    logStreamUrl: `${agentUrl}/__hub/api/apps/${encodeURIComponent(input.id)}/logs/stream`,
    recentLogs: input.recentLogs,
    lastError: input.runtime.lastError ?? null,
    readiness,
    canStart:
      input.runtime.canStart ??
      (input.runtime.status === "stopped" || input.runtime.status === "errored" || input.runtime.status === "conflict"),
    canStop: input.runtime.canStop ?? (input.runtime.status === "running" || input.runtime.status === "starting"),
    canOpen: input.runtime.canOpen ?? readiness.state === "ready",
    primaryAction: input.runtime.primaryAction ?? primaryAction(input.runtime, readiness.state),
    ...(input.runtime.blockingReason ? { blockingReason: input.runtime.blockingReason } : {}),
    ...(input.runtime.stopVerification ? { stopVerification: input.runtime.stopVerification } : {}),
    ...(input.runtime.mcpChildren?.length ? { mcpChildren: input.runtime.mcpChildren } : {})
  };
}

async function buildAppState(
  runtime: RelaybaseRuntime,
  id: string,
  options: { status?: AppStatusView } = {}
): Promise<AppState> {
  const checkedAt = new Date().toISOString();
  const status = options.status;
  const runtimeView = status?.runtime ?? stoppedRuntime();
  const backendPort = runtimeView.assignedPort ?? status?.upstreamPort;
  const backendPortOpen = backendPort ? await isPortOpen(backendPort, runtime.host) : false;
  const timeoutMs = status?.healthTimeoutMs ?? status?.startTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  const routeHealth =
    status && status.protocol !== "tcp" ? await checkRouteHealth(runtime, status, timeoutMs) : undefined;
  const routeReachable = status?.protocol === "tcp" ? backendPortOpen : Boolean(routeHealth?.ok);
  const recentLogs = status ? (await runtime.processes.logs(id)).slice(-50) : [];

  const state = composeAppState({
    id,
    name: status?.name,
    cwd: status?.cwd,
    manifestPath: status?.manifestPath,
    registered: Boolean(status),
    runtime: runtimeView,
    hubHost: runtime.host,
    hubPort: runtime.port,
    ...(backendPort ? { backendPort } : {}),
    backendPortOpen,
    routeReachable,
    ...(routeHealth ? { routeHealth } : {}),
    recentLogs,
    readinessCheckedAt: checkedAt,
    timeoutMs
  });

  const routeFailure = routeHealth ? routeFailureDetail(routeHealth) : undefined;
  if (!state.readiness.failureReason && routeFailure) {
    state.readiness.failureReason = routeFailure;
  }

  if (routeHealth) {
    state.readiness.checks.push(
      {
        name: "route-health",
        ok: routeHealth.ok,
        checkedAt,
        value: routeHealth.status,
        detail: routeHealth.policy
      },
      {
        name: "human-route",
        ok: routeHealth.humanRoute.ok,
        checkedAt,
        ...(routeHealth.humanRoute.statusCode ? { value: routeHealth.humanRoute.statusCode } : {}),
        ...(routeHealth.humanRoute.error ? { detail: routeHealth.humanRoute.error } : {})
      },
      {
        name: "agent-route",
        ok: routeHealth.agentRoute.ok,
        checkedAt,
        ...(routeHealth.agentRoute.statusCode ? { value: routeHealth.agentRoute.statusCode } : {}),
        ...(routeHealth.agentRoute.error ? { detail: routeHealth.agentRoute.error } : {})
      }
    );
  }

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
    {
      name: "runtime-running",
      ok: input.runtime.status === "running",
      checkedAt: input.checkedAt,
      value: input.runtime.status
    },
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

function readinessState(input: {
  registered: boolean;
  runtime: RuntimeView;
  backendPortOpen: boolean;
  routeReachable: boolean;
}): ReadinessState {
  if (!input.registered) {
    return "unregistered";
  }

  if (input.runtime.status === "stopped") {
    return "stopped";
  }

  if (
    input.runtime.phase === "prestarting" ||
    input.runtime.phase === "building" ||
    input.runtime.phase === "launching" ||
    input.runtime.phase === "waiting_for_health"
  ) {
    return "starting";
  }

  if (input.runtime.status === "starting") {
    return "starting";
  }

  if (input.runtime.status === "errored" || input.runtime.status === "conflict") {
    return "failed";
  }

  if (
    input.runtime.status === "running" &&
    input.runtime.health === "healthy" &&
    input.backendPortOpen &&
    input.routeReachable
  ) {
    return "ready";
  }

  return "unhealthy";
}

function readinessFailureReason(input: {
  registered: boolean;
  runtime: RuntimeView;
  backendPortOpen: boolean;
  routeReachable: boolean;
}): string | undefined {
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

function primaryAction(
  runtime: RuntimeView,
  readinessState: ReadinessState
): "start" | "stop" | "open" | "repair" | "wait" {
  if (readinessState === "ready") {
    return "open";
  }

  if (runtime.status === "starting" || runtime.status === "stopping") {
    return "wait";
  }

  if (runtime.status === "running") {
    return "stop";
  }

  if (runtime.status === "errored" || runtime.status === "conflict") {
    return "repair";
  }

  return "start";
}

async function checkRouteHealth(
  runtime: RelaybaseRuntime,
  app: AppStatusView,
  timeoutMs: number
): Promise<RouteHealth> {
  const path = routeHealthPath(app.healthUrl);
  const [humanRoute, agentRoute] = await Promise.all([
    checkRoute(runtime, {
      path,
      timeoutMs,
      url: `http://${app.id}.localhost:${runtime.port}${path}`,
      headers: { host: `${app.id}.localhost:${runtime.port}` }
    }),
    checkRoute(runtime, {
      path,
      timeoutMs,
      url: `http://${runtime.host}:${runtime.port}${path}`,
      headers: { host: "localhost", "x-relaybase-app": app.id }
    })
  ]);
  const status = humanRoute.ok && agentRoute.ok ? "full" : humanRoute.ok || agentRoute.ok ? "degraded" : "failed";
  return {
    status,
    ok: status !== "failed",
    policy: "human-or-agent",
    humanRoute,
    agentRoute
  };
}

async function checkRoute(
  runtime: RelaybaseRuntime,
  input: { path: string; timeoutMs: number; url: string; headers: Record<string, string> }
): Promise<RouteProbe> {
  return new Promise((resolve) => {
    const request = http.request(
      {
        host: runtime.host,
        port: runtime.port,
        path: input.path,
        method: "GET",
        timeout: routeProbeTimeoutMs(input.timeoutMs),
        headers: input.headers
      },
      (response) => {
        response.resume();
        const statusCode = response.statusCode ?? 0;
        resolve({
          ok: isHealthyHttpStatus(statusCode),
          url: input.url,
          statusCode
        });
      }
    );

    request.once("timeout", () => {
      request.destroy();
      resolve({ ok: false, url: input.url, error: "Relaybase route check timed out." });
    });
    request.once("error", (error) => resolve({ ok: false, url: input.url, error: error.message }));
    request.end();
  });
}

function routeProbeTimeoutMs(timeoutMs: number): number {
  return Math.min(Math.max(250, Math.min(timeoutMs, MAX_ROUTE_PROBE_TIMEOUT_MS)), timeoutMs);
}

function routeFailureDetail(routeHealth: RouteHealth): string | undefined {
  if (routeHealth.ok) {
    return undefined;
  }

  const details = [routeHealth.humanRoute.error, routeHealth.agentRoute.error].filter(Boolean);
  return details.length ? details.join("; ") : "Relaybase human and agent routes are not reachable.";
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
