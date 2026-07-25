import type http from "node:http";
import path from "node:path";
import { handleAgentApiRequest } from "./agent/api.ts";
import { AgentGatewayRequestError } from "./agent/gateway.ts";
import { handleAppPackageApiRequest } from "./appPackageApi.ts";
import { correlationIdForRequest, relaybaseErrorResponse, setCorrelationHeader } from "./apiErrors.ts";
import type {
  AppState,
  DaemonEvent,
  LifecycleOperationType,
  OperationStatus,
  RecordedOperationType
} from "./apiTypes.ts";
import { getAppState, getRelaybaseState } from "./appState.ts";
import { applyAppUnregister, previewAppUnregister } from "./appUnregister.ts";
import { AppRenameError, applyAppRename, previewAppRename } from "./appRename.ts";
import { appRecordEventData } from "./daemonEvents.ts";
import { DaemonRestartRequestError } from "./daemonRestart.ts";
import { dashboardInventory } from "./dashboard.ts";
import { LogExportRequestError } from "./logExport.ts";
import {
  OperationConflictError,
  OperationStoreClosedError,
  OperationTargetGateError,
  type OperationListOptions,
  type OperationOutcome
} from "./operationStore.ts";
import { readManifestFile } from "./registry.ts";
import { sendJson } from "./responses.ts";
import type { RelaybaseRuntime } from "./server.ts";
import { handleSetupApiRequest, SetupApiRequestError } from "./setupApi.ts";
import type { LifecycleAttempt, RuntimeView } from "./types.ts";

const DAEMON_EVENTS_HEARTBEAT_MS = 1000;
const DAEMON_EVENTS_RETRY_MS = 3000;
const MAX_JSON_BODY_BYTES = 1024 * 1024;
const OPERATION_STATUSES = new Set<OperationStatus>([
  "queued",
  "running",
  "waiting_for_approval",
  "succeeded",
  "failed",
  "cancelled",
  "aborted",
  "skipped",
  "timed_out"
]);

class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly recoverable: boolean;
  readonly retryable: boolean;
  readonly detail?: unknown;
  readonly userAction?: string;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    options: {
      recoverable?: boolean;
      retryable?: boolean;
      detail?: unknown;
      details?: unknown;
      userAction?: string;
    } = {}
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.retryable = options.retryable ?? options.recoverable ?? statusCode >= 400;
    this.recoverable = this.retryable;
    this.detail = options.detail ?? options.details;
    this.userAction = options.userAction;
  }
}

export async function handleApiRequest(
  runtime: RelaybaseRuntime,
  request: http.IncomingMessage,
  response: http.ServerResponse
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  const correlationId = correlationIdForRequest(request);
  setCorrelationHeader(response, correlationId);

  try {
    if (request.method === "GET" && url.pathname === "/__hub/api/session") {
      requireToken(runtime, request, {
        code: "UNAUTHORIZED_SESSION",
        message: "Unauthorized Relaybase session check.",
        userAction: "Run relaybase diagnose-token with the same state directory as the running daemon."
      });
      sendJson(response, 200, {
        session: {
          authenticated: true,
          stateDir: runtime.stateDir
        }
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/__hub/api/daemon/restart-preview") {
      requireToken(runtime, request, {
        code: "UNAUTHORIZED_DAEMON_RESTART_PREVIEW",
        message: "Unauthorized daemon restart preview.",
        userAction: "Use the session token from this daemon state directory before previewing restart."
      });
      sendJson(response, 200, { restart: { preview: await runtime.restart.preview() } });
      return;
    }

    if (request.method === "POST" && url.pathname === "/__hub/api/daemon/prepare-restart") {
      requireToken(runtime, request, {
        code: "UNAUTHORIZED_DAEMON_RESTART",
        message: "Unauthorized daemon restart preparation.",
        userAction: "Use the session token from this daemon state directory before restarting."
      });
      const body = await readJsonBody(request);
      assertExactRestartBodyFields(body, ["requestId", "expectedInstanceId", "previewId"]);
      const requestId = requiredRestartField(body.requestId, "requestId");
      const expectedInstanceId = requiredRestartField(body.expectedInstanceId, "expectedInstanceId");
      const previewId = requiredRestartField(body.previewId, "previewId");
      const prepared = await runtime.restart.prepare({ requestId, expectedInstanceId, previewId });
      sendJson(response, 200, { restart: { prepared } });
      return;
    }

    if (request.method === "POST" && url.pathname === "/__hub/api/daemon/shutdown") {
      requireToken(runtime, request, {
        code: "UNAUTHORIZED_DAEMON_SHUTDOWN",
        message: "Unauthorized daemon shutdown request.",
        userAction: "Use the session token from this daemon state directory before restarting."
      });
      const body = await readJsonBody(request);
      if (body.confirm !== true) {
        throw new ApiError(400, "DAEMON_RESTART_CONFIRMATION_REQUIRED", "Daemon restart requires confirm=true.", {
          retryable: false,
          userAction: "Review a fresh restart preview, then submit the bound preview with confirm=true."
        });
      }
      assertExactRestartBodyFields(body, ["requestId", "expectedInstanceId", "previewId", "confirm"]);
      const requestId = requiredRestartField(body.requestId, "requestId");
      const expectedInstanceId = requiredRestartField(body.expectedInstanceId, "expectedInstanceId");
      const previewId = requiredRestartField(body.previewId, "previewId");
      const prepared = await runtime.restart.prepare({ requestId, expectedInstanceId, previewId });
      sendJson(response, 202, { restart: { accepted: true, prepared } });
      runtime.requestShutdown("restart");
      return;
    }

    if (
      runtime.restart.quiescing &&
      request.method !== "GET" &&
      request.method !== "HEAD" &&
      request.method !== "OPTIONS"
    ) {
      throw new ApiError(503, "DAEMON_RESTART_QUIESCING", "Relaybase is quiescing for daemon restart.", {
        retryable: true,
        userAction: "Wait for the daemon restart to finish before submitting new work."
      });
    }

    if (request.method === "GET" && url.pathname === "/__hub/api/state") {
      requireToken(runtime, request, {
        code: "UNAUTHORIZED_STATE_READ",
        message: "Unauthorized Relaybase state read.",
        userAction: "Use the session token from this daemon state directory before reading full app state."
      });
      sendJson(response, 200, await getRelaybaseState(runtime));
      return;
    }

    if (request.method === "GET" && url.pathname === "/__hub/api/apps") {
      requireToken(runtime, request, {
        code: "UNAUTHORIZED_APP_INVENTORY",
        message: "Unauthorized Relaybase app inventory read.",
        userAction: "Use the session token from this daemon state directory before reading full app records."
      });
      sendJson(response, 200, { apps: await runtime.processes.listStatuses() });
      return;
    }

    if (request.method === "GET" && url.pathname === "/__hub/api/dashboard/apps") {
      sendJson(response, 200, { apps: dashboardInventory(await runtime.processes.listStatuses()) });
      return;
    }

    if (request.method === "GET" && url.pathname === "/__hub/api/events") {
      requireToken(runtime, request, {
        code: "UNAUTHORIZED_EVENT_STREAM",
        message: "Unauthorized Relaybase event stream.",
        userAction: "Use the session token from this daemon state directory before opening the event stream."
      });
      await streamDaemonEvents(runtime, request, response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/__hub/api/operations") {
      requireToken(runtime, request, {
        code: "UNAUTHORIZED_OPERATION_INVENTORY",
        message: "Unauthorized Relaybase operation inventory read.",
        userAction: "Use the session token from this daemon state directory before reading lifecycle history."
      });
      const filters = operationListOptions(url);
      const operations = runtime.operations.list(filters);
      sendJson(response, 200, { operations, count: operations.length, filters });
      return;
    }

    if (
      request.method === "GET" &&
      parts.length === 4 &&
      parts[0] === "__hub" &&
      parts[1] === "api" &&
      parts[2] === "operations"
    ) {
      requireToken(runtime, request, {
        code: "UNAUTHORIZED_OPERATION_READ",
        message: "Unauthorized Relaybase operation read.",
        userAction: "Use the session token from this daemon state directory before reading lifecycle history."
      });
      const operation = runtime.operations.get(parts[3]);
      if (!operation) {
        throw new ApiError(404, "OPERATION_NOT_FOUND", "Relaybase operation was not found.", {
          retryable: false,
          detail: { operationId: parts[3] },
          userAction: "Refresh the operation list or start a new lifecycle operation."
        });
      }
      sendJson(response, 200, { operation });
      return;
    }

    if (request.method === "POST" && url.pathname === "/__hub/api/apps/register") {
      requireToken(runtime, request);
      const body = await readJsonBody(request);
      const manifest = typeof body.manifestPath === "string" ? await readManifestFile(body.manifestPath) : body;
      const app = await runtime.registry.upsertManifest(
        manifest,
        typeof body.manifestPath === "string" ? { manifestPath: body.manifestPath } : {}
      );
      runtime.events.publish({
        type: "app.registered",
        appId: app.id,
        correlationId,
        data: appRecordEventData(app)
      });
      sendJson(response, 201, { app });
      return;
    }

    if (request.method === "POST" && url.pathname === "/__hub/api/logs/export") {
      requireToken(runtime, request, {
        code: "UNAUTHORIZED_LOG_EXPORT",
        message: "Unauthorized Relaybase log export.",
        userAction: "Use the session token from this daemon state directory before exporting logs."
      });
      const body = await readJsonBody(request);
      const exportResult = await runtime.exports.create(body, correlationId);
      sendJson(response, 202, { export: exportResult });
      return;
    }

    if (
      await handleAppPackageApiRequest({
        service: runtime.packages,
        request,
        response,
        parts,
        correlationId,
        requireToken: (options) => requireToken(runtime, request, options)
      })
    ) {
      return;
    }

    if (parts[0] === "__hub" && parts[1] === "api" && parts[2] === "agent") {
      if (
        await handleAgentApiRequest({
          runtime,
          request,
          response,
          parts,
          requireToken: (options) => requireToken(runtime, request, options)
        })
      ) {
        return;
      }
    }

    if (parts[0] === "__hub" && parts[1] === "api" && parts[2] === "setup") {
      if (
        await handleSetupApiRequest({
          runtime,
          request,
          response,
          url,
          parts,
          correlationId,
          requireToken: (options) => requireToken(runtime, request, options)
        })
      ) {
        return;
      }
    }

    if (
      request.method === "GET" &&
      parts.length === 4 &&
      parts[0] === "__hub" &&
      parts[1] === "api" &&
      parts[2] === "exports"
    ) {
      requireToken(runtime, request, {
        code: "UNAUTHORIZED_LOG_EXPORT_STATUS",
        message: "Unauthorized Relaybase log export status.",
        userAction: "Use the session token from this daemon state directory before reading export status."
      });
      const exportResult = runtime.exports.get(parts[3]);
      if (!exportResult) {
        throw new ApiError(404, "LOG_EXPORT_NOT_FOUND", "Relaybase log export was not found.", {
          retryable: false,
          detail: { exportId: parts[3] },
          userAction: "Start a new export or refresh the export status list."
        });
      }
      sendJson(response, 200, { export: exportResult });
      return;
    }

    if (parts.length === 5 && parts[0] === "__hub" && parts[1] === "api" && parts[2] === "apps") {
      const id = parts[3];
      const action = parts[4];

      if (action === "unregister" && request.method === "GET") {
        requireToken(runtime, request, {
          code: "UNAUTHORIZED_APP_UNREGISTER_PREVIEW",
          message: "Unauthorized Relaybase app unregister preview.",
          userAction: "Use the session token from this daemon state directory before inspecting unregister gates."
        });
        const preview = await previewAppUnregister(runtime, id);
        if (!preview) {
          throw appUnregisterNotFound(id);
        }
        sendJson(response, 200, { preview });
        return;
      }

      if (action === "unregister" && request.method === "POST") {
        requireToken(runtime, request, {
          code: "UNAUTHORIZED_APP_UNREGISTER",
          message: "Unauthorized Relaybase app unregister request.",
          userAction: "Use the session token from this daemon state directory before unregistering an app."
        });
        const body = await readJsonBody(request);
        if (body.confirm !== true) {
          throw new ApiError(
            400,
            "APP_UNREGISTER_CONFIRMATION_REQUIRED",
            "App unregister requires explicit confirmation.",
            {
              retryable: false,
              detail: { appId: id, required: { confirm: true } },
              userAction: "Preview unregister first, then submit the exact app id with confirm=true."
            }
          );
        }
        try {
          const applied = await applyAppUnregister(runtime, id);
          if (!applied.preview) {
            throw appUnregisterNotFound(id);
          }
          if (!applied.result) {
            throw new ApiError(409, "APP_UNREGISTER_BLOCKED", "App unregister failed its authoritative daemon gates.", {
              retryable: true,
              detail: { preview: applied.preview },
              userAction: "Resolve every unregister blocker, refresh the preview, and confirm again."
            });
          }
          runtime.events.publish({
            type: "app.unregistered",
            appId: id,
            correlationId,
            data: { app: applied.result.app, preserved: applied.result.preserved }
          });
          sendJson(response, 200, { result: applied.result });
          return;
        } catch (error) {
          if (error instanceof OperationConflictError) {
            throw new ApiError(409, "APP_UNREGISTER_OPERATION_ACTIVE", error.message, {
              retryable: true,
              detail: { activeOperation: error.activeOperation },
              userAction: "Wait for the active lifecycle operation to finish, then preview unregister again."
            });
          }
          if (error instanceof OperationTargetGateError) {
            throw new ApiError(409, "APP_UNREGISTER_ALREADY_ACTIVE", error.message, {
              retryable: true,
              detail: { appId: error.targetId, gate: error.gate },
              userAction: "Wait for the existing app management operation to finish, then refresh."
            });
          }
          throw error;
        }
      }

      if (request.method === "POST" && isLifecycleOperationType(action)) {
        requireToken(runtime, request);
        await handleLifecycleMutation(runtime, request, response, url, id, action, correlationId);
        return;
      }
    }

    if (
      request.method === "POST" &&
      parts.length === 6 &&
      parts[0] === "__hub" &&
      parts[1] === "api" &&
      parts[2] === "apps" &&
      parts[4] === "rename"
    ) {
      const appId = parts[3];
      const action = parts[5];
      requireToken(runtime, request, {
        code: action === "preview" ? "UNAUTHORIZED_APP_RENAME_PREVIEW" : "UNAUTHORIZED_APP_RENAME",
        message:
          action === "preview"
            ? "Unauthorized Relaybase app rename preview."
            : "Unauthorized Relaybase app rename request.",
        userAction: "Use the session token from this daemon state directory before renaming an app."
      });
      const body = await readJsonBody(request);
      if (action === "preview") {
        assertExactBodyFields(body, ["name"], "APP_RENAME_PREVIEW_BODY_INVALID");
        const preview = await previewAppRename(runtime, appId, body.name);
        sendJson(response, 200, { preview });
        return;
      }
      if (action === "apply") {
        assertExactBodyFields(body, ["previewId", "confirm"], "APP_RENAME_APPLY_BODY_INVALID");
        if (body.confirm !== true) {
          throw new ApiError(400, "APP_RENAME_CONFIRMATION_REQUIRED", "App rename requires explicit confirmation.", {
            retryable: false,
            detail: { appId, required: { previewId: "<preview id>", confirm: true } },
            userAction: "Preview rename first, then confirm that exact preview id."
          });
        }
        try {
          const result = await applyAppRename(runtime, appId, body.previewId);
          runtime.events.publish({
            type: "app.renamed",
            appId,
            correlationId,
            data: { appId, oldName: result.app.oldName, newName: result.app.newName }
          });
          sendJson(response, 200, { result });
          return;
        } catch (error) {
          if (error instanceof OperationConflictError) {
            throw new ApiError(409, "APP_RENAME_OPERATION_ACTIVE", error.message, {
              retryable: true,
              detail: { activeOperation: error.activeOperation },
              userAction: "Wait for the active lifecycle operation to finish, then request a new rename preview."
            });
          }
          if (error instanceof OperationTargetGateError) {
            throw new ApiError(409, "APP_RENAME_ALREADY_ACTIVE", error.message, {
              retryable: true,
              detail: { appId: error.targetId, gate: error.gate },
              userAction: "Wait for the existing app management operation to finish, then refresh /manage."
            });
          }
          throw error;
        }
      }
    }

    if (
      request.method === "GET" &&
      parts.length === 5 &&
      parts[0] === "__hub" &&
      parts[1] === "api" &&
      parts[2] === "apps" &&
      parts[4] === "state"
    ) {
      requireToken(runtime, request, {
        code: "UNAUTHORIZED_APP_STATE",
        message: "Unauthorized Relaybase app state read.",
        userAction: "Use the session token from this daemon state directory before reading full app state."
      });
      sendJson(response, 200, { state: await getAppState(runtime, parts[3]) });
      return;
    }

    if (
      request.method === "GET" &&
      parts.length === 6 &&
      parts[0] === "__hub" &&
      parts[1] === "api" &&
      parts[2] === "apps" &&
      parts[4] === "logs" &&
      parts[5] === "stream"
    ) {
      requireToken(runtime, request, {
        code: "UNAUTHORIZED_APP_LOG_STREAM",
        message: "Unauthorized Relaybase app log stream.",
        userAction: "Use the session token from this daemon state directory before streaming app logs."
      });
      await streamAppLogs(runtime, request, response, parts[3]);
      return;
    }

    if (
      request.method === "GET" &&
      parts.length === 5 &&
      parts[0] === "__hub" &&
      parts[1] === "api" &&
      parts[2] === "apps" &&
      parts[4] === "logs"
    ) {
      requireToken(runtime, request, {
        code: "UNAUTHORIZED_APP_LOGS",
        message: "Unauthorized Relaybase app logs.",
        userAction: "Use the session token from this daemon state directory before reading app logs."
      });
      const query = parseLogQuery(url);
      const result = await runtime.processes.queryLogs({ appId: parts[3], ...query });
      sendJson(response, 200, {
        id: parts[3],
        logs: result.events.map((event) => event.message),
        events: result.events,
        page: result.page,
        diagnostics: result.diagnostics,
        streamUrl: `http://${runtime.host}:${runtime.port}/__hub/api/apps/${encodeURIComponent(parts[3])}/logs/stream`
      });
      return;
    }

    throw new ApiError(404, "NOT_FOUND", "Not found.", {
      retryable: false,
      userAction: "Use one of the documented Relaybase API routes."
    });
  } catch (error) {
    sendApiError(runtime, response, error, correlationId);
  }
}

function appUnregisterNotFound(id: string): ApiError {
  return new ApiError(404, "APP_NOT_REGISTERED", `Registered app ${id} was not found.`, {
    retryable: false,
    detail: { appId: id },
    userAction: "Refresh registered app state and choose an existing stable app id."
  });
}

function requiredRestartField(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw new ApiError(400, "DAEMON_RESTART_REQUEST_INVALID", `Daemon restart ${field} is invalid.`, {
      retryable: false,
      detail: { field },
      userAction: "Request a fresh restart preview and submit its exact bound identifiers."
    });
  }
  return value.trim();
}

function assertExactRestartBodyFields(body: Record<string, unknown>, expected: string[]): void {
  const actual = Object.keys(body).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((field, index) => field !== wanted[index])) {
    throw new ApiError(
      400,
      "DAEMON_RESTART_BODY_INVALID",
      "Daemon restart request fields do not match the bound contract.",
      {
        retryable: false,
        detail: { expected: wanted, received: actual },
        userAction: "Request a fresh restart preview and send only its exact documented binding fields."
      }
    );
  }
}

function assertExactBodyFields(body: Record<string, unknown>, expected: string[], code: string): void {
  const actual = Object.keys(body).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((field, index) => field !== wanted[index])) {
    throw new ApiError(400, code, "Request body does not match the documented app rename contract.", {
      retryable: false,
      detail: { expected: wanted, received: actual },
      userAction: "Send only the documented rename fields."
    });
  }
}

interface LifecycleOperationResult {
  runtime: RuntimeView;
  state: AppState;
}

async function handleLifecycleMutation(
  runtime: RelaybaseRuntime,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  url: URL,
  id: string,
  action: LifecycleOperationType,
  correlationId: string
): Promise<void> {
  const handle = enqueueLifecycleOperation(runtime, id, action, correlationId);

  if (prefersAsyncLifecycle(request, url)) {
    sendJson(response, handle.created ? 202 : 200, {
      operationId: handle.operationId,
      operation: handle.operation,
      ...(handle.deduplicated ? { deduplicated: true } : {})
    });
    return;
  }

  const operation = await handle.done;
  if (!isLifecycleOperationResult(operation.result)) {
    throw new ApiError(
      400,
      operation.error?.code ?? "LIFECYCLE_OPERATION_FAILED",
      operation.error?.message ?? `${action} failed before producing an app state.`,
      {
        retryable: operation.error?.retryable ?? true,
        detail: { operationId: operation.operationId, operation },
        userAction: operation.error?.userAction ?? "Inspect the operation status and app logs before retrying."
      }
    );
  }

  sendJson(response, 200, {
    operationId: operation.operationId,
    operation,
    runtime: operation.result.runtime,
    state: operation.result.state
  });
}

export function enqueueLifecycleOperation(
  runtime: RelaybaseRuntime,
  id: string,
  action: LifecycleOperationType,
  correlationId: string
) {
  try {
    return runtime.operations.enqueueLifecycle<LifecycleOperationResult>({
      operationType: action,
      targetId: id,
      correlationId,
      run: async (context) => {
        context.addProgress(`Daemon accepted ${action} for app ${id}.`, 20, "accepted");
        if (action === "restart") {
          context.addProgress("Restart is a daemon-owned stop phase followed by a start phase.", 30, "restart");
        }
        const lifecycleRuntime = await runLifecycleAction(runtime, id, action, context.signal);
        context.addProgress(`Daemon lifecycle call completed for ${action}.`, 85, "state-refresh");
        return {
          runtime: lifecycleRuntime,
          state: await getAppState(runtime, id)
        };
      },
      evaluate: (result) => evaluateLifecycleOutcome(action, id, result.runtime)
    });
  } catch (error) {
    if (error instanceof OperationConflictError) {
      throw new ApiError(409, "OPERATION_CONFLICT", error.message, {
        retryable: true,
        detail: { activeOperation: error.activeOperation },
        userAction: "Poll the active operation before starting a conflicting lifecycle action."
      });
    }
    if (error instanceof OperationStoreClosedError) {
      throw new ApiError(503, "LIFECYCLE_STORE_SHUTTING_DOWN", error.message, {
        retryable: true,
        userAction: "Wait for the daemon to restart before submitting another lifecycle action."
      });
    }
    if (error instanceof OperationTargetGateError) {
      throw new ApiError(409, "APP_TARGET_LOCKED", error.message, {
        retryable: true,
        detail: { appId: error.targetId, gate: error.gate },
        userAction: "Wait for the current app management operation to finish before retrying."
      });
    }
    throw error;
  }
}

function operationListOptions(url: URL): OperationListOptions {
  const statusValues = url.searchParams
    .getAll("status")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  const invalidStatus = statusValues.find((status) => !OPERATION_STATUSES.has(status as OperationStatus));
  if (invalidStatus) {
    throw new ApiError(400, "OPERATION_STATUS_FILTER_INVALID", `Unknown operation status filter: ${invalidStatus}`, {
      retryable: false,
      userAction: "Use a documented operation status such as failed, timed_out, or succeeded."
    });
  }

  const operationType = url.searchParams.get("type")?.trim();
  if (operationType && !isRecordedOperationType(operationType)) {
    throw new ApiError(400, "OPERATION_TYPE_FILTER_INVALID", `Unknown operation type: ${operationType}`, {
      retryable: false,
      userAction: "Use start, stop, restart, or registration_verification."
    });
  }

  const retryable = url.searchParams.get("retryable")?.trim().toLowerCase();
  if (retryable && retryable !== "true" && retryable !== "false") {
    throw new ApiError(400, "OPERATION_RETRYABLE_FILTER_INVALID", "Operation retryable filter must be true or false.", {
      retryable: false,
      userAction: "Use retryable=true to list only retryable operations."
    });
  }

  const rawLimit = url.searchParams.get("limit")?.trim();
  const limit = rawLimit ? Number(rawLimit) : 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new ApiError(400, "OPERATION_LIMIT_INVALID", "Operation list limit must be an integer from 1 through 200.", {
      retryable: false,
      userAction: "Use a bounded limit between 1 and 200."
    });
  }

  const targetId = url.searchParams.get("targetId")?.trim();
  if (targetId && targetId.length > 200) {
    throw new ApiError(400, "OPERATION_TARGET_FILTER_INVALID", "Operation target filter is too long.", {
      retryable: false,
      userAction: "Use an exact registered app id no longer than 200 characters."
    });
  }

  return {
    ...(statusValues.length ? { statuses: statusValues as OperationStatus[] } : {}),
    ...(operationType ? { operationType: operationType as RecordedOperationType } : {}),
    ...(targetId ? { targetId } : {}),
    retryableOnly: retryable === "true",
    limit
  };
}

async function runLifecycleAction(
  runtime: RelaybaseRuntime,
  id: string,
  action: LifecycleOperationType,
  signal?: AbortSignal
): Promise<RuntimeView> {
  if (action === "start") {
    return runtime.processes.start(id, { signal });
  }

  if (action === "stop") {
    return runtime.processes.stop(id, { signal });
  }

  return runtime.processes.restart(id, { signal });
}

function evaluateLifecycleOutcome(action: LifecycleOperationType, id: string, runtime: RuntimeView): OperationOutcome {
  const succeeded = action === "stop" ? runtime.status === "stopped" : runtime.status === "running";
  if (succeeded) {
    return {
      status: "succeeded",
      retryable: false,
      message: `Succeeded ${action} for app ${id}.`
    };
  }

  const message =
    runtime.lastError ??
    runtime.blockingReason ??
    `Lifecycle ${action} for app ${id} finished with runtime status ${runtime.status}.`;
  const timedOut = didLifecycleTimeOut(runtime, message);

  return {
    status: timedOut ? "timed_out" : "failed",
    code: timedOut ? "LIFECYCLE_TIMED_OUT" : "LIFECYCLE_OPERATION_FAILED",
    retryable: true,
    message,
    userAction: "Inspect the app logs, lifecycle attempt history, and manifest timeouts before retrying.",
    detail: {
      appId: id,
      action,
      runtime
    }
  };
}

function didLifecycleTimeOut(runtime: RuntimeView, message: string): boolean {
  if (runtime.cleanupStatus === "timeout" || /timeout|timed out|did not become healthy/i.test(message)) {
    return true;
  }

  const attempts = [runtime.lastStartAttempt, runtime.lastStopAttempt, ...(runtime.attemptHistory ?? [])].filter(
    (attempt): attempt is LifecycleAttempt => Boolean(attempt)
  );
  return attempts.some((attempt) => attempt.hooks.some((hook) => hook.timedOut));
}

function prefersAsyncLifecycle(request: http.IncomingMessage, url: URL): boolean {
  const asyncParam = url.searchParams.get("async");
  const waitParam = url.searchParams.get("wait");
  const prefer = headerText(request.headers.prefer);
  const relaybaseAsync = headerText(request.headers["x-relaybase-async"]);
  return (
    asyncParam === "true" ||
    asyncParam === "1" ||
    waitParam === "false" ||
    prefer.toLowerCase().includes("respond-async") ||
    relaybaseAsync.toLowerCase() === "true"
  );
}

function headerText(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join(",") : (value ?? "");
}

function isLifecycleOperationType(action: string): action is LifecycleOperationType {
  return action === "start" || action === "stop" || action === "restart";
}

function isRecordedOperationType(action: string): action is RecordedOperationType {
  return isLifecycleOperationType(action) || action === "registration_verification";
}

function isLifecycleOperationResult(result: unknown): result is LifecycleOperationResult {
  return Boolean(result && typeof result === "object" && "runtime" in result && "state" in result);
}

function parseLogQuery(url: URL): { limit?: number; before?: number; after?: number } {
  return {
    ...parseOptionalPositiveInt(url.searchParams.get("limit"), "limit"),
    ...parseOptionalPositiveInt(url.searchParams.get("before"), "before"),
    ...parseOptionalPositiveInt(url.searchParams.get("after"), "after")
  };
}

function parseOptionalPositiveInt(value: string | null, field: "limit" | "before" | "after"): Record<string, number> {
  if (value === null || value === "") {
    return {};
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new ApiError(400, "INVALID_LOG_QUERY", `Log query parameter ${field} must be a positive integer.`, {
      retryable: false,
      detail: { field, value },
      userAction: "Use positive integer log pagination parameters."
    });
  }

  return { [field]: parsed };
}

async function streamAppLogs(
  runtime: RelaybaseRuntime,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  id: string
): Promise<void> {
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
  const snapshot = await runtime.processes.queryLogs({ appId: id, limit: 300 });
  send("snapshot", {
    id,
    lines: snapshot.events.map((event) => event.message),
    events: snapshot.events,
    page: snapshot.page,
    diagnostics: snapshot.diagnostics,
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

async function streamDaemonEvents(
  runtime: RelaybaseRuntime,
  request: http.IncomingMessage,
  response: http.ServerResponse
): Promise<void> {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  response.flushHeaders?.();

  let closed = false;
  const send = (event: DaemonEvent, retryMs?: number) => {
    if (closed || response.destroyed) {
      return;
    }
    if (retryMs !== undefined) {
      response.write(`retry: ${retryMs}\n`);
    }
    response.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  };
  const sendComment = (comment: string) => {
    if (!closed && !response.destroyed) {
      response.write(`: ${comment}\n\n`);
    }
  };

  const lastEventId = headerText(request.headers["last-event-id"]);
  send(
    runtime.events.create({
      type: "daemon.ready",
      data: {
        daemon: {
          status: "running",
          host: runtime.host,
          port: runtime.port
        },
        reconnect: {
          replay: "not_implemented",
          requiresStateRefresh: true,
          lastEventId: lastEventId || null
        }
      }
    }),
    DAEMON_EVENTS_RETRY_MS
  );
  send(
    runtime.events.create({
      type: "daemon.health_changed",
      data: {
        daemon: {
          status: "running",
          host: runtime.host,
          port: runtime.port
        }
      }
    })
  );

  const unsubscribe = runtime.events.subscribe((event) => send(event));
  const heartbeat = setInterval(() => {
    sendComment(`heartbeat ${new Date().toISOString()}`);
  }, DAEMON_EVENTS_HEARTBEAT_MS);

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

function requireToken(
  runtime: RelaybaseRuntime,
  request: http.IncomingMessage,
  options: { code?: string; message?: string; userAction?: string } = {}
): void {
  const token = request.headers["x-relaybase-token"] ?? request.headers.authorization?.replace(/^Bearer\s+/i, "");
  const actual = Array.isArray(token) ? token[0] : token;
  if (actual !== runtime.token) {
    throw new ApiError(
      401,
      options.code ?? "UNAUTHORIZED_MUTATION",
      options.message ?? "Unauthorized Relaybase mutation.",
      {
        retryable: true,
        detail: tokenDiagnostics(runtime),
        userAction:
          options.userAction ??
          "Run relaybase diagnose-token or use the session token from this daemon state directory."
      }
    );
  }
}

function sendApiError(
  runtime: RelaybaseRuntime,
  response: http.ServerResponse,
  error: unknown,
  correlationId: string
): void {
  if (response.headersSent) {
    response.end();
    return;
  }

  setCorrelationHeader(response, correlationId);

  if (error instanceof ApiError) {
    sendJson(
      response,
      error.statusCode,
      relaybaseErrorResponse({
        code: error.code,
        message: error.message,
        detail: error.detail,
        retryable: error.retryable,
        userAction: error.userAction,
        correlationId
      })
    );
    return;
  }

  if (error instanceof DaemonRestartRequestError) {
    sendJson(
      response,
      error.statusCode,
      relaybaseErrorResponse({
        code: error.code,
        message: error.message,
        detail: error.detail,
        retryable: error.statusCode >= 500 || error.statusCode === 409,
        userAction: error.userAction,
        correlationId
      })
    );
    return;
  }

  if (error instanceof LogExportRequestError) {
    sendJson(
      response,
      error.statusCode,
      relaybaseErrorResponse({
        code: error.code,
        message: error.message,
        detail: error.detail,
        retryable: error.retryable,
        userAction: error.userAction,
        correlationId
      })
    );
    return;
  }

  if (error instanceof AppRenameError) {
    sendJson(
      response,
      error.statusCode,
      relaybaseErrorResponse({
        code: error.code,
        message: error.message,
        detail: error.detail,
        retryable: error.retryable,
        userAction: error.userAction,
        correlationId
      })
    );
    return;
  }

  if (error instanceof SetupApiRequestError) {
    sendJson(
      response,
      error.statusCode,
      relaybaseErrorResponse({
        code: error.code,
        message: error.message,
        detail: error.detail,
        retryable: error.retryable,
        userAction: error.userAction,
        correlationId
      })
    );
    return;
  }

  if (error instanceof AgentGatewayRequestError) {
    sendJson(
      response,
      error.statusCode,
      relaybaseErrorResponse({
        code: error.code,
        message: error.message,
        detail: error.detail,
        retryable: error.retryable,
        userAction: error.userAction,
        correlationId
      })
    );
    return;
  }

  const message = error instanceof Error ? error.message : "Unknown Relaybase API error.";
  sendJson(
    response,
    400,
    relaybaseErrorResponse({
      code: "RELAYBASE_API_ERROR",
      message,
      retryable: true,
      detail: {
        stateDir: runtime.stateDir
      },
      userAction: "Inspect the Relaybase command output and retry the API request after correcting the input.",
      correlationId
    })
  );
}

function tokenDiagnostics(runtime: RelaybaseRuntime): Record<string, unknown> {
  return {
    requiredForMutations: true,
    acceptedHeaders: ["Authorization: Bearer <token>", "x-relaybase-token: <token>"],
    stateDir: runtime.stateDir,
    tokenPath: path.join(runtime.stateDir, "session-token"),
    tokenPresent: Boolean(runtime.token),
    mismatchHint:
      "Discovery can be healthy while mutations return 401 if the client reads a token from a different Relaybase state directory."
  };
}

async function readJsonBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > MAX_JSON_BODY_BYTES) {
      request.destroy();
      throw new ApiError(413, "REQUEST_BODY_TOO_LARGE", "Request body exceeds the 1 MB limit.", {
        retryable: false
      });
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}
