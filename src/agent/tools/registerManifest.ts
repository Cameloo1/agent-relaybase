import { z } from "zod";
import { registerManifest } from "../../setupApi.ts";
import {
  confirmationContextSchema,
  correlationId,
  requireApproved,
  safeToolExecute,
  successResult,
  type RelaybaseAgentToolDefinition
} from "./common.ts";

const parameters = z
  .object({
    manifestPath: z.string(),
    cwd: z.string().optional(),
    reason: z.string().optional(),
    confirmationContext: confirmationContextSchema
  })
  .strict();

export function createRegisterManifestTool(): RelaybaseAgentToolDefinition<z.infer<typeof parameters>> {
  const definition: RelaybaseAgentToolDefinition<z.infer<typeof parameters>> = {
    name: "register_manifest",
    description:
      "Register an existing manifest through the daemon registry API. Requires approval; inspect or validate the manifest first.",
    parameters,
    approvalRequired: true,
    risk: "high",
    execute: (input, context) =>
      safeToolExecute(definition, input, async () => {
        const approval = requireApproved(definition, input, context, "Register or update the daemon manifest record.");
        if (approval) {
          return approval;
        }
        return successResult(
          definition.name,
          await registerManifest(
            context.runtime,
            { manifestPath: input.manifestPath, cwd: input.cwd ?? context.tuiContext.currentCwd },
            correlationId(context)
          )
        );
      })
  };
  return definition;
}
