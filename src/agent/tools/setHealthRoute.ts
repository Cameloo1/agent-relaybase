import { z } from "zod";
import { confirmationContextSchema, type RelaybaseAgentToolDefinition } from "./common.ts";
import { runManifestPatch } from "./patchManifestFields.ts";

const parameters = z
  .object({
    appId: z.string().optional(),
    manifestPath: z.string().optional(),
    cwd: z.string().optional(),
    healthUrl: z.string().min(1),
    reason: z.string().optional(),
    confirmationContext: confirmationContextSchema
  })
  .strict();

export function createSetHealthRouteTool(): RelaybaseAgentToolDefinition<z.infer<typeof parameters>> {
  const definition: RelaybaseAgentToolDefinition<z.infer<typeof parameters>> = {
    name: "set_health_route",
    description:
      "Preview or apply an approved manifest healthUrl patch. Requires approval for apply and must go through the daemon manifest patch path.",
    parameters,
    approvalRequired: true,
    risk: "high",
    execute: (input, context) =>
      runManifestPatch(definition, { ...input, patch: { healthUrl: input.healthUrl } }, context)
  };
  return definition;
}
