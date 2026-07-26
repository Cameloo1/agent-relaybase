import { z } from "zod";
import { resolveAuthoritativeAgentContext } from "../currentContext.ts";
import { safeToolExecute, successResult, type RelaybaseAgentToolDefinition } from "./common.ts";

const parameters = z.object({}).strict();

export function createGetCurrentContextTool(): RelaybaseAgentToolDefinition<z.infer<typeof parameters>> {
  const definition: RelaybaseAgentToolDefinition<z.infer<typeof parameters>> = {
    name: "get_current_context",
    description:
      "Resolve the current TUI pane/app/group selection against a fresh daemon snapshot. Returns freshness, provenance, origin, and stale or ambiguous reasons.",
    parameters,
    approvalRequired: false,
    risk: "low",
    execute: (input, context) =>
      safeToolExecute(definition, input, async () =>
        successResult(definition.name, await resolveAuthoritativeAgentContext(context.runtime, context.tuiContext))
      )
  };
  return definition;
}
