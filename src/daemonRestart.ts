import { createHash } from "node:crypto";
import type { RelaybaseRuntime } from "./server.ts";
import type { ProcessManagerShutdownResult } from "./processManager.ts";
import { redactDiagnosticText } from "./redaction.ts";

export type DaemonRestartBlockerKind = "agent_run" | "lifecycle_operation" | "package_run";

export interface DaemonRestartBlocker {
  kind: DaemonRestartBlockerKind;
  id: string;
  status: string;
  detail?: Record<string, unknown>;
}

export interface DaemonRestartPreview {
  instanceId: string;
  startedAt: string;
  previewId: string;
  canRestart: boolean;
  blockers: DaemonRestartBlocker[];
  runningOwnedAppIds: string[];
  runningExternalAppIds: string[];
}

export interface DaemonRestartPrepareResult {
  requestId: string;
  instanceId: string;
  preparedAt: string;
  restoreAppIds: string[];
  externalAppIds: string[];
  processShutdown: ProcessManagerShutdownResult;
  serviceShutdownFailures?: Array<{ service: string; error: string }>;
}

export class DaemonRestartRequestError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly detail?: unknown;
  readonly userAction: string;

  constructor(statusCode: number, code: string, message: string, options: { detail?: unknown; userAction: string }) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.detail = options.detail;
    this.userAction = options.userAction;
  }
}

export class DaemonRestartCoordinator {
  readonly instanceId: string;
  readonly startedAt: string;
  #runtime: RelaybaseRuntime;
  #quiescing = false;
  #activeRequestId?: string;
  #prepared?: DaemonRestartPrepareResult;

  constructor(runtime: RelaybaseRuntime, instanceId: string, startedAt: string) {
    this.#runtime = runtime;
    this.instanceId = instanceId;
    this.startedAt = startedAt;
  }

  get quiescing(): boolean {
    return this.#quiescing;
  }

  get prepared(): boolean {
    return Boolean(this.#prepared);
  }

  async preview(): Promise<DaemonRestartPreview> {
    const activeAgentRuns = this.#runtime.agentGateway.activeRuns();
    const activeOperations = this.#runtime.operations.list({
      statuses: ["queued", "running", "waiting_for_approval"],
      limit: 200
    });
    const activePackageRuns = this.#runtime.packages.activeRuns();
    const blockers: DaemonRestartBlocker[] = [
      ...activeAgentRuns.map((run) => ({
        kind: "agent_run" as const,
        id: run.id,
        status: run.status,
        detail: { sessionId: run.sessionId }
      })),
      ...activeOperations.map((operation) => ({
        kind: "lifecycle_operation" as const,
        id: operation.operationId,
        status: operation.status,
        detail: {
          operationType: operation.operationType,
          targetId: operation.appId ?? operation.target.id
        }
      })),
      ...activePackageRuns.map((run) => ({
        kind: "package_run" as const,
        id: run.id,
        status: run.status,
        detail: { packageId: run.packageId }
      }))
    ];
    const runningOwnedAppIds = this.#runtime.processes.runningOwnedAppIds();
    const runningExternalAppIds = this.#runtime.processes.runningExternalAppIds();
    const digest = createHash("sha256")
      .update(
        JSON.stringify({
          instanceId: this.instanceId,
          blockers,
          runningOwnedAppIds,
          runningExternalAppIds
        })
      )
      .digest("hex");
    return {
      instanceId: this.instanceId,
      startedAt: this.startedAt,
      previewId: `restart_preview_${digest.slice(0, 24)}`,
      canRestart: blockers.length === 0,
      blockers,
      runningOwnedAppIds,
      runningExternalAppIds
    };
  }

  async prepare(input: {
    requestId: string;
    expectedInstanceId: string;
    previewId: string;
  }): Promise<DaemonRestartPrepareResult> {
    if (this.#prepared && this.#prepared.requestId === input.requestId) {
      return this.#prepared;
    }
    if (this.#activeRequestId && this.#activeRequestId !== input.requestId) {
      throw new DaemonRestartRequestError(409, "DAEMON_RESTART_BUSY", "Another daemon restart is already active.", {
        detail: { requestId: this.#activeRequestId },
        userAction: "Wait for the active restart to finish before retrying."
      });
    }
    if (input.expectedInstanceId !== this.instanceId) {
      throw new DaemonRestartRequestError(
        409,
        "DAEMON_RESTART_INSTANCE_CHANGED",
        "The Relaybase daemon instance changed after restart was previewed.",
        {
          detail: { expectedInstanceId: input.expectedInstanceId, currentInstanceId: this.instanceId },
          userAction: "Refresh daemon state and request a new restart preview."
        }
      );
    }
    const preview = await this.preview();
    if (preview.previewId !== input.previewId) {
      throw new DaemonRestartRequestError(
        409,
        "DAEMON_RESTART_PREVIEW_STALE",
        "Daemon state changed after restart was previewed.",
        {
          detail: { preview },
          userAction: "Review the updated restart preview and confirm again."
        }
      );
    }
    if (!preview.canRestart) {
      throw new DaemonRestartRequestError(409, "DAEMON_RESTART_BLOCKED", "Daemon restart is blocked by active work.", {
        detail: { preview },
        userAction: "Wait for or safely cancel the listed active work, then request a new restart preview."
      });
    }

    this.#activeRequestId = input.requestId;
    this.#quiescing = true;
    const processShutdown = safeProcessShutdown(await this.#runtime.processes.shutdownOwnedApps());
    if (processShutdown.failed.length > 0) {
      const recovery = await Promise.all(
        processShutdown.stoppedAppIds.map(async (appId) => {
          try {
            const state = await this.#runtime.processes.start(appId);
            return {
              appId,
              restored: state.status === "running",
              status: state.status,
              ...(state.lastError ? { error: redactDiagnosticText(state.lastError) } : {})
            };
          } catch (error) {
            return {
              appId,
              restored: false,
              status: "errored",
              error: redactDiagnosticText(error instanceof Error ? error.message : String(error))
            };
          }
        })
      );
      this.#quiescing = false;
      this.#activeRequestId = undefined;
      throw new DaemonRestartRequestError(
        500,
        "DAEMON_RESTART_APP_SHUTDOWN_FAILED",
        "Relaybase could not safely stop every daemon-owned app before restart.",
        {
          detail: { processShutdown, recovery },
          userAction: recovery.every((entry) => entry.restored)
            ? "Inspect the failed app stop results, resolve the stop boundary, and retry the daemon restart."
            : "Inspect both the failed stop and recovery results before taking further lifecycle action."
        }
      );
    }
    this.#runtime.packages.requestAbortAll();
    const serviceShutdown = await Promise.allSettled([
      this.#runtime.agentGateway.close(),
      this.#runtime.operations.shutdown(),
      this.#runtime.packages.shutdown()
    ]);
    const serviceNames = ["agent", "operations", "packages"];
    const serviceShutdownFailures = serviceShutdown.flatMap((result, index) =>
      result.status === "rejected"
        ? [
            {
              service: serviceNames[index] ?? "unknown",
              error: redactDiagnosticText(
                result.reason instanceof Error ? result.reason.message : String(result.reason)
              )
            }
          ]
        : []
    );
    this.#prepared = {
      requestId: input.requestId,
      instanceId: this.instanceId,
      preparedAt: new Date().toISOString(),
      restoreAppIds: [...preview.runningOwnedAppIds],
      externalAppIds: [...preview.runningExternalAppIds],
      processShutdown,
      ...(serviceShutdownFailures.length > 0 ? { serviceShutdownFailures } : {})
    };
    return this.#prepared;
  }
}

function safeProcessShutdown(result: ProcessManagerShutdownResult): ProcessManagerShutdownResult {
  return {
    requestedAppIds: [...result.requestedAppIds],
    stoppedAppIds: [...result.stoppedAppIds],
    failed: result.failed.map((failure) => ({
      appId: failure.appId,
      error: redactDiagnosticText(failure.error)
    }))
  };
}
