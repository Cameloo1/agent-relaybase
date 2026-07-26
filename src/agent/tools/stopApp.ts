import { z } from "zod";
import { confirmationContextSchema, type RelaybaseAgentToolDefinition } from "./common.ts";
import { runLifecycleTool } from "./lifecycle.ts";

const parameters = z
  .object({
    appId: z.string().optional(),
    appName: z.string().optional(),
    groupId: z.string().optional(),
    componentRole: z.enum(["frontend", "backend", "worker", "database", "service", "other"]).optional(),
    target: z.string().optional(),
    reason: z.string().optional(),
    confirmationContext: confirmationContextSchema
  })
  .strict();

export function createStopAppTool(): RelaybaseAgentToolDefinition<z.infer<typeof parameters>> {
  const definition: RelaybaseAgentToolDefinition<z.infer<typeof parameters>> = {
    name: "stop_app",
    description:
      "Request a daemon-owned async stop operation for an existing Relaybase app. Requires approval. Never kill a process directly and never claim completion before polling the operation result.",
    parameters,
    approvalRequired: true,
    risk: "high",
    execute: (input, context) => runLifecycleTool(definition, input, context, "stop")
  };
  return definition;
}
