import { enqueueLifecycleOperation } from "../../api.ts";
import type { LifecycleOperationType } from "../../apiTypes.ts";
import type { AppComponentRole } from "../../types.ts";
import {
  correlationId,
  requireApproved,
  resolveAppTarget,
  safeToolExecute,
  successResult,
  type AgentToolExecutionContext,
  type RelaybaseAgentToolDefinition
} from "./common.ts";

export async function runLifecycleTool(
  definition: RelaybaseAgentToolDefinition<Record<string, unknown>>,
  input: Record<string, unknown>,
  context: AgentToolExecutionContext,
  operationType: LifecycleOperationType
) {
  return safeToolExecute(definition, input, async () => {
    const approval = requireApproved(
      definition,
      input,
      context,
      `Start a daemon-owned ${operationType} operation and return an operationId.`
    );
    if (approval) {
      return approval;
    }

    const componentRole =
      typeof input.componentRole === "string" ? (input.componentRole as AppComponentRole) : undefined;
    const resolved = await resolveAppTarget(
      context.runtime,
      {
        appId: typeof input.appId === "string" ? input.appId : undefined,
        appName: typeof input.appName === "string" ? input.appName : undefined,
        groupId: typeof input.groupId === "string" ? input.groupId : undefined,
        componentRole,
        target: typeof input.target === "string" ? input.target : undefined
      },
      context.tuiContext
    );
    if ("status" in resolved) {
      return resolved;
    }

    const handle = enqueueLifecycleOperation(context.runtime, resolved.app.id, operationType, correlationId(context));
    return successResult(
      definition.name,
      {
        appId: resolved.app.id,
        operation: handle.operation,
        deduplicated: handle.deduplicated
      },
      {
        operationId: handle.operationId,
        next: { poll: `/__hub/api/operations/${encodeURIComponent(handle.operationId)}` }
      }
    );
  });
}
