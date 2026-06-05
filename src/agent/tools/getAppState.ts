import { z } from "zod";
import { resolveAppTarget, safeToolExecute, successResult, type RelaybaseAgentToolDefinition } from "./common.ts";

const parameters = z
  .object({
    appId: z.string().optional(),
    appName: z.string().optional(),
    groupId: z.string().optional(),
    componentRole: z.enum(["frontend", "backend", "worker", "database", "service", "other"]).optional(),
    target: z.string().optional()
  })
  .strict();

export function createGetAppStateTool(): RelaybaseAgentToolDefinition<z.infer<typeof parameters>> {
  const definition: RelaybaseAgentToolDefinition<z.infer<typeof parameters>> = {
    name: "get_app_state",
    description:
      "Read one app's authoritative Relaybase state. Resolve exact app ids, display names, selected pane context, or group+role. Ask for clarification if ambiguous.",
    parameters,
    approvalRequired: false,
    risk: "low",
    execute: (input, context) =>
      safeToolExecute(definition, input, async () => {
        const resolved = await resolveAppTarget(context.runtime, input, context.tuiContext);
        if ("status" in resolved) {
          return resolved;
        }
        return successResult(definition.name, { app: resolved.app });
      })
  };
  return definition;
}
