import { z } from "zod";
import { detectSetup } from "../../setupApi.ts";
import { safeToolExecute, successResult, type RelaybaseAgentToolDefinition } from "./common.ts";

const parameters = z
  .object({
    cwd: z.string().optional(),
    currentDirectory: z.string().optional()
  })
  .strict();

export function createDetectProjectTool(): RelaybaseAgentToolDefinition<z.infer<typeof parameters>> {
  const definition: RelaybaseAgentToolDefinition<z.infer<typeof parameters>> = {
    name: "detect_project",
    description:
      "Read project metadata for onboarding and return the daemon runtimeMatrix, primaryRuntime, command candidates, port strategies, health candidates, setup questions, existing manifest, env-port hints, Docker hints, and diagnostics. Use this first for add/configure/start this folder or current-directory setup. This writes nothing.",
    parameters,
    approvalRequired: false,
    risk: "low",
    execute: (input, context) =>
      safeToolExecute(definition, input, async () =>
        successResult(
          definition.name,
          await detectSetup({ cwd: input.cwd ?? input.currentDirectory ?? context.tuiContext.currentCwd })
        )
      )
  };
  return definition;
}
