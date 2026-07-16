import type { LifecycleOperation } from "./apiTypes.ts";
import type { RelaybaseRuntime } from "./server.ts";
import type { AppRecord } from "./types.ts";

export interface AppUnregisterBlocker {
  code: "APP_NOT_STOPPED" | "LIFECYCLE_OPERATION_ACTIVE" | "PACKAGE_REFERENCE_ACTIVE";
  message: string;
}

export interface AppUnregisterPackageReference {
  id: string;
  name: string;
}

export interface AppUnregisterPreview {
  app: {
    id: string;
    name: string;
    projectDirectory: string;
    manifestPath?: string;
  };
  runtimeStatus: string;
  canUnregister: boolean;
  blockers: AppUnregisterBlocker[];
  packageReferences: AppUnregisterPackageReference[];
  activeOperation?: Pick<LifecycleOperation, "operationId" | "operationType" | "status">;
  preserved: {
    projectFiles: true;
    manifest: true;
    logs: true;
    operationHistory: true;
  };
}

export interface AppUnregisterResult {
  unregistered: true;
  app: AppUnregisterPreview["app"];
  runtimeStatus: "stopped";
  preserved: AppUnregisterPreview["preserved"];
}

export async function previewAppUnregister(
  runtime: RelaybaseRuntime,
  appId: string
): Promise<AppUnregisterPreview | undefined> {
  const app = await runtime.registry.get(appId);
  if (!app) {
    return undefined;
  }

  const status = (await runtime.processes.listStatuses()).find((candidate) => candidate.id === appId);
  const runtimeStatus = status?.runtime.status ?? "unknown";
  const activeOperation = runtime.operations.activeForTarget(appId);
  const packageReferences = runtime.packages
    .listDefinitions()
    .filter((definition) => definition.memberAppIds.includes(appId))
    .map((definition) => ({ id: definition.id, name: definition.name }));
  const blockers: AppUnregisterBlocker[] = [];

  if (runtimeStatus !== "stopped") {
    blockers.push({
      code: "APP_NOT_STOPPED",
      message: `App ${appId} is ${runtimeStatus}; unregister requires a daemon-proven stopped state.`
    });
  }
  if (activeOperation) {
    blockers.push({
      code: "LIFECYCLE_OPERATION_ACTIVE",
      message: `Lifecycle operation ${activeOperation.operationId} is still active for app ${appId}.`
    });
  }
  if (packageReferences.length > 0) {
    blockers.push({
      code: "PACKAGE_REFERENCE_ACTIVE",
      message: `${packageReferences.length} saved package definition(s) still reference app ${appId}.`
    });
  }

  return {
    app: publicAppIdentity(app),
    runtimeStatus,
    canUnregister: blockers.length === 0,
    blockers,
    packageReferences,
    ...(activeOperation
      ? {
          activeOperation: {
            operationId: activeOperation.operationId,
            operationType: activeOperation.operationType,
            status: activeOperation.status
          }
        }
      : {}),
    preserved: preservedUnregisterData()
  };
}

export async function applyAppUnregister(
  runtime: RelaybaseRuntime,
  appId: string
): Promise<{ preview?: AppUnregisterPreview; result?: AppUnregisterResult }> {
  return runtime.operations.withTargetGate(appId, "app unregister", async () => {
    const preview = await previewAppUnregister(runtime, appId);
    if (!preview || !preview.canUnregister) {
      return { preview };
    }
    const removed = await runtime.registry.remove(appId);
    if (!removed) {
      return {};
    }
    return {
      preview,
      result: {
        unregistered: true,
        app: preview.app,
        runtimeStatus: "stopped",
        preserved: preview.preserved
      }
    };
  });
}

function publicAppIdentity(app: AppRecord): AppUnregisterPreview["app"] {
  return {
    id: app.id,
    name: app.name,
    projectDirectory: app.cwd,
    ...(app.manifestPath ? { manifestPath: app.manifestPath } : {})
  };
}

function preservedUnregisterData(): AppUnregisterPreview["preserved"] {
  return {
    projectFiles: true,
    manifest: true,
    logs: true,
    operationHistory: true
  };
}
