import type { Diagnostic } from "./apiTypes.ts";
import type {
  AppAggregateStatus,
  AppComponent,
  AppComponentStatus,
  AppManifestDiagnostic,
  AppState,
  AppStatusView
} from "./types.ts";

export interface AppComponentState {
  components: AppComponent[];
  groups: Array<{
    groupId: string;
    displayName: string;
    components: AppComponent[];
    aggregateStatus: AppAggregateStatus;
  }>;
  diagnostics: Diagnostic[];
}

export function buildAppComponentState(input: {
  states: AppState[];
  statuses: AppStatusView[];
  generatedAt: string;
}): AppComponentState {
  const statusesById = new Map(input.statuses.map((status) => [status.id, status]));
  const components = input.states
    .map((state) => appComponentForState(state, statusesById.get(state.id)))
    .sort(compareComponents);
  const groups = buildGroups(components);
  const diagnostics = input.statuses.flatMap((status) =>
    manifestDiagnosticsForState(status.id, status.manifestDiagnostics ?? [], input.generatedAt)
  );

  return {
    components,
    groups,
    diagnostics
  };
}

export function aggregateComponentStatus(components: AppComponent[]): AppAggregateStatus {
  if (components.some((component) => component.status === "failed")) {
    return "failed";
  }

  if (components.some((component) => component.status === "starting")) {
    return "starting";
  }

  if (components.every((component) => component.status === "stopped")) {
    return "stopped";
  }

  if (components.every((component) => component.status === "running")) {
    return "running";
  }

  return "degraded";
}

function appComponentForState(state: AppState, status?: AppStatusView): AppComponent {
  const metadata = status?.relaybase;
  const hasExplicitMetadata = Boolean(metadata);
  const role = metadata?.componentRole ?? "other";
  const port = state.backendPort ?? state.runtime.assignedPort ?? status?.upstreamPort;

  return {
    appId: state.id,
    groupId: metadata?.groupId ?? state.id,
    role,
    paneLabel: metadata?.paneLabel ?? (hasExplicitMetadata ? role : "app"),
    paneOrder: metadata?.paneOrder ?? 100,
    displayName: metadata?.displayName ?? status?.name ?? state.name ?? state.id,
    route: {
      humanUrl: state.humanUrl,
      agentUrl: state.agentUrl,
      reachable: state.routeReachable,
      ...(state.routeHealth ? { health: state.routeHealth } : {})
    },
    ...(state.runtime.pid ? { pid: state.runtime.pid } : {}),
    ...(port ? { port } : {}),
    status: componentStatusForState(state),
    lastError: state.lastError ?? state.runtime.lastError ?? null
  };
}

function componentStatusForState(state: AppState): AppComponentStatus {
  if (state.runtime.status === "errored" || state.runtime.status === "conflict" || state.readiness.state === "failed") {
    return "failed";
  }

  if (state.runtime.status === "starting" || state.readiness.state === "starting") {
    return "starting";
  }

  if (state.runtime.status === "stopping") {
    return "stopping";
  }

  if (state.runtime.status === "stopped") {
    return "stopped";
  }

  if (state.runtime.status === "running" && state.readiness.state === "ready" && state.runtime.health === "healthy") {
    return "running";
  }

  return "degraded";
}

function buildGroups(components: AppComponent[]): AppComponentState["groups"] {
  const groupsById = new Map<string, AppComponent[]>();
  for (const component of components) {
    const group = groupsById.get(component.groupId) ?? [];
    group.push(component);
    groupsById.set(component.groupId, group);
  }

  return [...groupsById.entries()]
    .map(([groupId, groupComponents]) => {
      const sortedComponents = [...groupComponents].sort(compareComponents);
      return {
        groupId,
        displayName: sortedComponents[0]?.displayName ?? groupId,
        components: sortedComponents,
        aggregateStatus: aggregateComponentStatus(sortedComponents)
      };
    })
    .sort(
      (left, right) => left.displayName.localeCompare(right.displayName) || left.groupId.localeCompare(right.groupId)
    );
}

function manifestDiagnosticsForState(
  appId: string,
  diagnostics: AppManifestDiagnostic[],
  checkedAt: string
): Diagnostic[] {
  return diagnostics.map((diagnostic, index) => ({
    id: `manifest.${appId}.${diagnostic.code}.${index}`,
    severity: diagnostic.severity,
    message: diagnostic.message,
    checkedAt,
    detail: {
      appId,
      field: diagnostic.field,
      code: diagnostic.code,
      metadata: diagnostic.detail
    },
    userAction:
      "Fix the relaybase metadata block in the app manifest. Relaybase is using normalized fallback component metadata until it is valid."
  }));
}

function compareComponents(left: AppComponent, right: AppComponent): number {
  return (
    left.paneOrder - right.paneOrder ||
    left.paneLabel.localeCompare(right.paneLabel) ||
    left.displayName.localeCompare(right.displayName) ||
    left.appId.localeCompare(right.appId)
  );
}
