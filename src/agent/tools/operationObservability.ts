import { z } from "zod";
import type { LifecycleOperation } from "../../apiTypes.ts";
import { diagnosticResult, safeToolExecute, successResult, type RelaybaseAgentToolDefinition } from "./common.ts";

const statuses = z.enum([
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

const operationTypes = z.enum([
  "start",
  "stop",
  "restart",
  "register",
  "registration_verification",
  "log-export",
  "diagnostics",
  "preferences"
]);

const getParameters = z.object({ operationId: z.string().min(1) }).strict();
const listParameters = z
  .object({
    statuses: z.array(statuses).max(10).optional(),
    operationType: operationTypes.optional(),
    targetId: z.string().optional(),
    retryableOnly: z.boolean().optional(),
    limit: z.number().int().positive().max(50).optional()
  })
  .strict();

export function createGetOperationStatusTool(): RelaybaseAgentToolDefinition<z.infer<typeof getParameters>> {
  const definition: RelaybaseAgentToolDefinition<z.infer<typeof getParameters>> = {
    name: "get_operation_status",
    description:
      "Read one daemon-owned operation by exact operationId. Returns status, progress, bounded events, supported recovery actions, and elapsed time without mutating anything.",
    parameters: getParameters,
    approvalRequired: false,
    risk: "low",
    execute: (input, context) =>
      safeToolExecute(definition, input, async () => {
        const operation = context.runtime.operations.get(input.operationId);
        if (!operation) {
          return diagnosticResult(definition.name, "AGENT_OPERATION_NOT_FOUND", "Relaybase operation was not found.", {
            severity: "error",
            userAction: "Refresh the operation list or start a new lifecycle operation.",
            detail: { operationId: input.operationId }
          });
        }
        return successResult(definition.name, { operation: projectOperation(operation) });
      })
  };
  return definition;
}

export function createListOperationsTool(): RelaybaseAgentToolDefinition<z.infer<typeof listParameters>> {
  const definition: RelaybaseAgentToolDefinition<z.infer<typeof listParameters>> = {
    name: "list_operations",
    description:
      "List a bounded, newest-first daemon operation history. Filter by status, type, stable target id, or retryability; this is read-only.",
    parameters: listParameters,
    approvalRequired: false,
    risk: "low",
    execute: (input, context) =>
      safeToolExecute(definition, input, async () => {
        const operations = context.runtime.operations.list({
          ...(input.statuses?.length ? { statuses: input.statuses } : {}),
          ...(input.operationType ? { operationType: input.operationType } : {}),
          ...(input.targetId?.trim() ? { targetId: input.targetId.trim() } : {}),
          ...(input.retryableOnly !== undefined ? { retryableOnly: input.retryableOnly } : {}),
          limit: input.limit ?? 20
        });
        return successResult(definition.name, {
          operations: operations.map(projectOperation),
          count: operations.length
        });
      })
  };
  return definition;
}

function projectOperation(operation: LifecycleOperation) {
  const terminal = ["succeeded", "failed", "cancelled", "aborted", "skipped", "timed_out"].includes(operation.status);
  const end = Date.parse(operation.finishedAt ?? operation.endedAt ?? operation.updatedAt ?? new Date().toISOString());
  const start = Date.parse(operation.startedAt ?? operation.createdAt);
  return {
    operationId: operation.operationId,
    kind: operation.operationType,
    target: operation.target,
    status: operation.status,
    progress: operation.progress,
    phase: operation.events?.at(-1)?.phase,
    message: operation.message,
    createdAt: operation.createdAt,
    startedAt: operation.startedAt,
    finishedAt: operation.finishedAt ?? operation.endedAt,
    elapsedMs: Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : undefined,
    retryable: operation.canRetry === true || operation.retryable === true,
    canCancel: operation.canAbort === true && !terminal,
    next: {
      poll: terminal ? undefined : `get_operation_status:${operation.operationId}`,
      retry: operation.canRetry === true || operation.retryable === true,
      inspectLogs: Boolean(operation.appId ?? operation.target.id)
    },
    events: operation.events?.slice(-20),
    error: operation.error,
    evidence: operation.evidence
  };
}
