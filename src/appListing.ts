import type { AppRecord, AppState, AppStatusView, ChildMcpRuntimeView } from "./types.ts";

export const APP_LIST_FILTERS = ["all", "running", "active", "stopped", "ready", "attention"] as const;

export type AppListFilter = (typeof APP_LIST_FILTERS)[number];

export interface AppListSummary {
  registered: number;
  shown: number;
  running: number;
  active: number;
  ready: number;
  stopped: number;
  attention: number;
}

export interface ChildMcpListSummary {
  total: number;
  connected: number;
  errored: number;
  statuses: Record<string, number>;
}

export interface AppListItem {
  id: string;
  name: string;
  registered: boolean;
  readiness: string;
  runtime: string;
  health: string;
  route: "reachable" | "unreachable" | "unknown";
  routeReachable: boolean | null;
  port: number | null;
  action: string;
  attention: boolean;
  attentionReason: string | null;
  humanUrl?: string;
  agentUrl?: string;
  cwd?: string;
  manifestPath?: string;
  pid?: number;
  phase?: string;
  logs?: number;
  childMcp?: ChildMcpListSummary;
  stopVerification?: {
    attempted: boolean;
    ok: boolean;
    backendPortOpen: boolean | null;
    cleanupStatus?: string;
    failureReason?: string;
  };
  lastError: string | null;
}

export interface AppListResult {
  filter: AppListFilter;
  daemonReachable: boolean;
  runtimeKnown: boolean;
  summary: AppListSummary;
  items: AppListItem[];
}

export function isAppListFilter(value: unknown): value is AppListFilter {
  return typeof value === "string" && (APP_LIST_FILTERS as readonly string[]).includes(value);
}

export function requireAppListFilter(value: unknown): AppListFilter {
  if (value === undefined || value === null || value === "") {
    return "all";
  }
  if (isAppListFilter(value)) {
    return value;
  }
  throw new Error(`App list filter must be one of: ${APP_LIST_FILTERS.join(", ")}.`);
}

export function listFilterNeedsRuntime(filter: AppListFilter): boolean {
  return filter !== "all";
}

export function buildAppListResult(input: {
  states: AppState[];
  statuses?: AppStatusView[];
  filter?: AppListFilter;
  daemonReachable?: boolean;
  runtimeKnown?: boolean;
}): AppListResult {
  const filter = input.filter ?? "all";
  const statusesById = new Map((input.statuses ?? []).map((status) => [status.id, status]));
  const allItems = input.states.map((state) => compactAppState(state, statusesById.get(state.id)));
  const items = allItems.filter((item) => matchesAppListFilter(item, filter));

  return {
    filter,
    daemonReachable: input.daemonReachable ?? true,
    runtimeKnown: input.runtimeKnown ?? true,
    summary: summarizeAppList(allItems, items.length),
    items
  };
}

export function buildOfflineAppListResult(input: { apps: AppRecord[]; filter?: AppListFilter }): AppListResult {
  const filter = input.filter ?? "all";
  const allItems = input.apps.map(compactOfflineApp);
  const items = filter === "all" ? allItems : allItems.filter((item) => matchesAppListFilter(item, filter));

  return {
    filter,
    daemonReachable: false,
    runtimeKnown: false,
    summary: summarizeAppList(allItems, items.length),
    items
  };
}

function compactAppState(state: AppState, status?: AppStatusView): AppListItem {
  const lastError = state.lastError ?? state.runtime.lastError ?? null;
  const attentionReason = attentionReasonForState(state, lastError);
  const children = state.mcpChildren ?? state.runtime.mcpChildren ?? [];
  const childMcp = summarizeChildMcp(children);

  return {
    id: state.id,
    name: state.name,
    registered: state.registered,
    readiness: state.readiness.state,
    runtime: state.runtime.status,
    health: state.runtime.health,
    route: state.routeReachable ? "reachable" : "unreachable",
    routeReachable: state.routeReachable,
    port: state.backendPort ?? state.runtime.assignedPort ?? status?.upstreamPort ?? null,
    action: state.primaryAction,
    attention: Boolean(attentionReason),
    attentionReason,
    humanUrl: state.humanUrl,
    agentUrl: state.agentUrl,
    cwd: status?.cwd,
    manifestPath: status?.manifestPath,
    pid: state.runtime.pid,
    phase: state.runtime.phase,
    logs: state.runtime.logLines,
    ...(childMcp.total ? { childMcp } : {}),
    ...(state.stopVerification
      ? {
          stopVerification: {
            attempted: state.stopVerification.attempted,
            ok: state.stopVerification.ok,
            backendPortOpen: state.stopVerification.backendPortOpen,
            ...(state.stopVerification.cleanupStatus ? { cleanupStatus: state.stopVerification.cleanupStatus } : {}),
            ...(state.stopVerification.failureReason ? { failureReason: state.stopVerification.failureReason } : {})
          }
        }
      : {}),
    lastError
  };
}

function compactOfflineApp(app: AppRecord): AppListItem {
  return {
    id: app.id,
    name: app.name,
    registered: true,
    readiness: "unknown",
    runtime: "unknown",
    health: "unknown",
    route: "unknown",
    routeReachable: null,
    port: app.upstreamPort ?? null,
    action: "unknown",
    attention: false,
    attentionReason: null,
    cwd: app.cwd,
    manifestPath: app.manifestPath,
    lastError: null
  };
}

function summarizeAppList(items: AppListItem[], shown: number): AppListSummary {
  return {
    registered: items.filter((item) => item.registered).length,
    shown,
    running: items.filter((item) => item.runtime === "running").length,
    active: items.filter((item) => isActiveRuntime(item.runtime)).length,
    ready: items.filter((item) => item.readiness === "ready").length,
    stopped: items.filter((item) => item.runtime === "stopped").length,
    attention: items.filter((item) => item.attention).length
  };
}

function matchesAppListFilter(item: AppListItem, filter: AppListFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "running":
      return item.runtime === "running";
    case "active":
      return isActiveRuntime(item.runtime);
    case "stopped":
      return item.runtime === "stopped";
    case "ready":
      return item.readiness === "ready";
    case "attention":
      return item.attention;
  }
}

function isActiveRuntime(runtime: string): boolean {
  return runtime === "starting" || runtime === "running" || runtime === "stopping";
}

function attentionReasonForState(state: AppState, lastError: string | null): string | null {
  if (lastError) {
    return lastError;
  }
  if (state.runtime.status === "errored" || state.runtime.status === "conflict") {
    return `runtime ${state.runtime.status}`;
  }
  if (state.runtime.phase === "cleanup_failed" || state.runtime.phase === "stop_verification_failed") {
    return `phase ${state.runtime.phase}`;
  }
  if (state.stopVerification && !state.stopVerification.ok) {
    return state.stopVerification.failureReason ?? "stop verification failed";
  }
  if (state.readiness.state === "unhealthy" || state.readiness.state === "failed") {
    return state.readiness.failureReason ?? `readiness ${state.readiness.state}`;
  }
  return null;
}

function summarizeChildMcp(children: ChildMcpRuntimeView[]): ChildMcpListSummary {
  const statuses: Record<string, number> = {};
  for (const child of children) {
    statuses[child.status] = (statuses[child.status] ?? 0) + 1;
  }

  return {
    total: children.length,
    connected: statuses.connected ?? 0,
    errored: statuses.errored ?? 0,
    statuses
  };
}
