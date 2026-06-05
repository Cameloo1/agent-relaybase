import { z } from "zod";
import { proveSetup } from "../../setupApi.ts";
import {
  confirmationContextSchema,
  requireApproved,
  safeToolExecute,
  successResult,
  type RelaybaseAgentToolDefinition
} from "./common.ts";

const parameters = z
  .object({
    cwd: z.string().optional(),
    currentDirectory: z.string().optional(),
    appId: z.string().optional(),
    lifecycleProof: z.boolean().optional(),
    reason: z.string().optional(),
    confirmationContext: confirmationContextSchema
  })
  .strict();

export function createProveAppHealthTool(): RelaybaseAgentToolDefinition<z.infer<typeof parameters>> {
  const definition: RelaybaseAgentToolDefinition<z.infer<typeof parameters>> = {
    name: "prove_app_health",
    description:
      "Run daemon health proof using manifest/setup runtime metadata. Requires approval in the current implementation because proof can write artifacts and lifecycleProof can start/stop apps.",
    parameters,
    approvalRequired: true,
    risk: "high",
    execute: (input, context) =>
      safeToolExecute(definition, input, async () => {
        const approval = requireApproved(
          definition,
          input,
          context,
          "Run daemon health proof and return structured result."
        );
        if (approval) {
          return approval;
        }
        const result = await proveSetup(context.runtime, {
          ...input,
          cwd: input.cwd ?? input.currentDirectory ?? context.tuiContext.currentCwd,
          confirm: true,
          confirmation: { confirmed: true, reason: input.reason }
        });
        return successResult(definition.name, result);
      })
  };
  return definition;
}
