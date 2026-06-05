import { z } from "zod";
import { repairSetup } from "../../setupApi.ts";
import { safeToolExecute, successResult, type RelaybaseAgentToolDefinition } from "./common.ts";

const parameters = z
  .object({
    cwd: z.string().optional(),
    currentDirectory: z.string().optional(),
    appId: z.string().optional(),
    reason: z.string().optional()
  })
  .strict();

export function createRepairAppSetupTool(): RelaybaseAgentToolDefinition<z.infer<typeof parameters>> {
  const definition: RelaybaseAgentToolDefinition<z.infer<typeof parameters>> = {
    name: "repair_app_setup",
    description:
      "Return daemon-produced runtime-specific setup repair choices and previews for ignored PORT, bad health route, stale manifest, pinned port, Docker service, or command ambiguity. This is preview-only; applying repair writes requires apply_setup_plan approval.",
    parameters,
    approvalRequired: false,
    risk: "medium",
    execute: (input, context) =>
      safeToolExecute(definition, input, async () => {
        const result = await repairSetup({
          ...input,
          cwd: input.cwd ?? input.currentDirectory ?? context.tuiContext.currentCwd
        });
        return successResult(definition.name, result, {
          repairPlanId: result.plan.choices[0]?.id
        });
      })
  };
  return definition;
}
