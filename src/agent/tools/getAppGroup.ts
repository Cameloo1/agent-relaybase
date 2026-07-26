import { z } from "zod";
import { resolveGroupTarget, safeToolExecute, successResult, type RelaybaseAgentToolDefinition } from "./common.ts";
import { summarizeGroupHealth } from "../appExplanation.ts";

const parameters = z
  .object({
    groupId: z.string().optional(),
    groupName: z.string().optional(),
    target: z.string().optional()
  })
  .strict();

export function createGetAppGroupTool(): RelaybaseAgentToolDefinition<z.infer<typeof parameters>> {
  const definition: RelaybaseAgentToolDefinition<z.infer<typeof parameters>> = {
    name: "get_app_group",
    description:
      "Read one Relaybase app group and its component-as-app metadata. Use exact group ids or display names and ask for clarification if ambiguous.",
    parameters,
    approvalRequired: false,
    risk: "low",
    execute: (input, context) =>
      safeToolExecute(definition, input, async () => {
        const resolved = await resolveGroupTarget(context.runtime, input, context.tuiContext);
        if ("status" in resolved) {
          return resolved;
        }
        const group = resolved.state.groups.find((entry) => entry.groupId === resolved.groupId);
        return successResult(definition.name, {
          group,
          healthSummary: group ? summarizeGroupHealth(group) : undefined
        });
      })
  };
  return definition;
}
