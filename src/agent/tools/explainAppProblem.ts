import { z } from "zod";
import { buildAppExplanation } from "../appExplanation.ts";
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

export function createExplainAppProblemTool(): RelaybaseAgentToolDefinition<z.infer<typeof parameters>> {
  const definition: RelaybaseAgentToolDefinition<z.infer<typeof parameters>> = {
    name: "explain_app_problem",
    description:
      "Build one evidence-backed explanation from authoritative app state, operations, routes, readiness, packages, manifest origin, and bounded redacted logs. Separates observed facts from likely causes and safe next actions.",
    parameters,
    approvalRequired: false,
    risk: "medium",
    execute: (input, context) =>
      safeToolExecute(definition, input, async () => {
        const resolved = await resolveAppTarget(context.runtime, input, context.tuiContext);
        if ("status" in resolved) return resolved;
        const group = resolved.state.groups.find((entry) =>
          entry.components.some((component) => component.appId === resolved.app.id)
        );
        return successResult(definition.name, await buildAppExplanation(context.runtime, resolved.app, group));
      })
  };
  return definition;
}
