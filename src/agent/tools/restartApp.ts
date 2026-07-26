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

export function createRestartAppTool(): RelaybaseAgentToolDefinition<z.infer<typeof parameters>> {
  const definition: RelaybaseAgentToolDefinition<z.infer<typeof parameters>> = {
    name: "restart_app",
    description:
      "Request a daemon-owned async restart operation with explicit stop/start phases. Requires approval. Never stop or start processes directly.",
    parameters,
    approvalRequired: true,
    risk: "high",
    execute: (input, context) => runLifecycleTool(definition, input, context, "restart")
  };
  return definition;
}
