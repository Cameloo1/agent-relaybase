import type { AppGroup, AppState } from "../types.ts";
import type { RelaybaseRuntime } from "../server.ts";

export async function buildAppExplanation(runtime: RelaybaseRuntime, app: AppState, group?: AppGroup) {
  const operations = runtime.operations.list({ targetId: app.id, limit: 10 });
  const latestOperation = operations[0];
  const logs = await runtime.logStore.query({ appId: app.id, limit: 20 });
  const packageReferences = runtime.packages
    .listDefinitions()
    .filter((definition) => definition.memberAppIds.includes(app.id))
    .map((definition) => ({ id: definition.id, name: definition.name, revision: definition.revision }));
  const facts = [
    fact("registry", `App ${app.id} is ${app.registered ? "registered" : "not registered"}.`, "high"),
    fact("runtime", `Runtime status is ${app.runtime.status}.`, "high"),
    fact("readiness", `Readiness is ${app.readiness.state}.`, "high"),
    fact("route", `Route is ${app.routeReachable ? "reachable" : "not reachable"}.`, "high"),
    ...(app.manifestPath ? [fact("registry", "A manifest binding is present.", "high")] : []),
    ...(latestOperation
      ? [
          fact(
            "operation_store",
            `Latest operation ${latestOperation.operationType} is ${latestOperation.status}.`,
            "high"
          )
        ]
      : [])
  ];
  const likelyCauses = deterministicCauses(app, latestOperation?.error?.message);
  const recommendedActions = deterministicActions(app, latestOperation?.operationId);

  return {
    diagnosis: {
      code: diagnosisCode(app),
      scope: diagnosisScope(app),
      facts,
      likelyCauses,
      confidence: likelyCauses.length ? "medium" : "high",
      retryable: latestOperation?.retryable ?? app.canStart,
      requiresApproval: recommendedActions.some((action) => action.requiresApproval)
    },
    app: {
      id: app.id,
      name: app.name,
      runtimeStatus: app.runtime.status,
      readiness: app.readiness,
      routeReachable: app.routeReachable,
      routeHealth: app.routeHealth,
      lastError: app.lastError,
      origin: { projectDirectory: app.cwd, manifestPath: app.manifestPath }
    },
    group: group ? summarizeGroupHealth(group) : undefined,
    latestOperation,
    recentOperations: operations,
    packageReferences,
    relevantLogs: logs.events.slice(-20).map((event) => ({
      sequence: event.sequence,
      timestamp: event.timestamp,
      stream: event.stream,
      level: event.level,
      message: event.message,
      redacted: true
    })),
    recommendedActions
  };
}

export function summarizeGroupHealth(group: AppGroup) {
  const counts = group.components.reduce<Record<string, number>>((result, component) => {
    result[component.status] = (result[component.status] ?? 0) + 1;
    return result;
  }, {});
  const unhealthy = group.components.filter((component) => component.status !== "running");
  return {
    groupId: group.groupId,
    displayName: group.displayName,
    aggregateStatus: group.aggregateStatus,
    componentCount: group.components.length,
    statusCounts: counts,
    affectedComponents: unhealthy.map((component) => ({
      appId: component.appId,
      role: component.role,
      status: component.status,
      lastError: component.lastError
    })),
    summary:
      unhealthy.length === 0
        ? `All ${group.components.length} components are running.`
        : `${unhealthy.length} of ${group.components.length} components need attention.`
  };
}

function fact(source: string, statement: string, confidence: "high" | "medium" | "low") {
  return { source, statement, confidence, observedAt: new Date().toISOString() };
}

function deterministicCauses(app: AppState, operationError?: string): string[] {
  return [
    ...(app.lastError ? [app.lastError] : []),
    ...(operationError && operationError !== app.lastError ? [operationError] : []),
    ...(app.runtime.status === "running" && !app.backendPortOpen
      ? ["The managed process is running but its backend port is not open."]
      : []),
    ...(app.backendPortOpen && !app.routeReachable
      ? ["The backend port is open but Relaybase route health is failing."]
      : []),
    ...(app.runtime.status === "stopped" ? ["The app is stopped; no route is expected until it is started."] : [])
  ];
}

function deterministicActions(app: AppState, operationId?: string) {
  if (["starting", "stopping"].includes(app.runtime.status)) {
    return [{ kind: "poll_operation", operationId, requiresApproval: false }];
  }
  if (app.readiness.state === "ready") {
    return [{ kind: "open_monitoring", appId: app.id, requiresApproval: false }];
  }
  if (app.runtime.status === "stopped") {
    return [{ kind: "preview_start", appId: app.id, requiresApproval: true }];
  }
  return [
    { kind: "inspect_logs", appId: app.id, requiresApproval: false },
    { kind: "preview_repair", appId: app.id, requiresApproval: false }
  ];
}

function diagnosisCode(app: AppState): string {
  if (!app.registered) return "APP_NOT_REGISTERED";
  if (app.readiness.state === "ready") return "APP_READY";
  if (app.runtime.status === "stopped") return "APP_STOPPED";
  if (app.backendPortOpen && !app.routeReachable) return "APP_ROUTE_UNHEALTHY";
  if (!app.backendPortOpen && app.runtime.status === "running") return "APP_BACKEND_UNAVAILABLE";
  return "APP_DEGRADED";
}

function diagnosisScope(app: AppState): "registration" | "lifecycle" | "route" | "health" {
  if (!app.registered) return "registration";
  if (app.backendPortOpen && !app.routeReachable) return "route";
  if (app.runtime.health !== "healthy") return "health";
  return "lifecycle";
}
