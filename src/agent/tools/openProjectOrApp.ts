import { z } from "zod";
import { openSetupProject } from "../../setupApi.ts";
import {
  confirmationContextSchema,
  correlationId,
  requireApproved,
  resolveAppTarget,
  safeToolExecute,
  successResult,
  type RelaybaseAgentToolDefinition
} from "./common.ts";
import { runLifecycleTool } from "./lifecycle.ts";

const parameters = z
  .object({
    cwd: z.string().optional(),
    currentDirectory: z.string().optional(),
    appId: z.string().optional(),
    appName: z.string().optional(),
    target: z.string().optional(),
    noBrowser: z.boolean().optional(),
    reason: z.string().optional(),
    confirmationContext: confirmationContextSchema
  })
  .strict();

export function createOpenProjectOrAppTool(): RelaybaseAgentToolDefinition<z.infer<typeof parameters>> {
  const definition: RelaybaseAgentToolDefinition<z.infer<typeof parameters>> = {
    name: "open_project_or_app",
    description:
      "Open a project or app through daemon setup/lifecycle APIs only. Requires approval because it may register, start, prove, or open a route. Does not directly open a browser unless daemon setup/open supports it and approval is present.",
    parameters,
    approvalRequired: true,
    risk: "high",
    execute: (input, context) =>
      safeToolExecute(definition, input, async () => {
        const approval = requireApproved(definition, input, context, "Open project/app through daemon APIs.");
        if (approval) {
          return approval;
        }
        const hasExplicitAppTarget = Boolean(input.appId ?? input.appName ?? input.target);
        const cwd = hasExplicitAppTarget
          ? undefined
          : (input.cwd ?? input.currentDirectory ?? context.tuiContext.currentCwd);
        if (cwd) {
          const setup = await openSetupProject(context.runtime, {
            cwd,
            noBrowser: input.noBrowser ?? true,
            confirm: true,
            confirmation: { confirmed: true, reason: input.reason }
          });
          return successResult(definition.name, { setup });
        }
        const resolved = await resolveAppTarget(context.runtime, input, context.tuiContext);
        if ("status" in resolved) {
          return resolved;
        }
        return runLifecycleTool(
          definition,
          { appId: resolved.app.id, reason: input.reason },
          { ...context, correlationId: correlationId(context) },
          "start"
        );
      })
  };
  return definition;
}
