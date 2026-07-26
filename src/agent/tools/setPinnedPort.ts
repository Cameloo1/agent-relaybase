import { z } from "zod";
import { confirmationContextSchema, type RelaybaseAgentToolDefinition } from "./common.ts";
import { runManifestPatch } from "./patchManifestFields.ts";

const parameters = z
  .object({
    appId: z.string().optional(),
    manifestPath: z.string().optional(),
    cwd: z.string().optional(),
    upstreamPort: z.number().int().min(1).max(65535),
    reason: z.string().optional(),
    confirmationContext: confirmationContextSchema
  })
  .strict();

export function createSetPinnedPortTool(): RelaybaseAgentToolDefinition<z.infer<typeof parameters>> {
  const definition: RelaybaseAgentToolDefinition<z.infer<typeof parameters>> = {
    name: "set_pinned_port",
    description:
      "Preview or apply an approved manifest upstreamPort patch for a fixed port strategy across any runtime type. Requires approval and must not directly bind/probe ports from the agent tool.",
    parameters,
    approvalRequired: true,
    risk: "high",
    execute: (input, context) =>
      runManifestPatch(definition, { ...input, patch: { upstreamPort: input.upstreamPort } }, context)
  };
  return definition;
}
