import { z } from "zod";
import { getRelaybaseState } from "../../appState.ts";
import { safeToolExecute, successResult, type RelaybaseAgentToolDefinition } from "./common.ts";

const parameters = z.object({ includeLogStore: z.boolean().optional() }).strict();

export function createGetDiagnosticsTool(): RelaybaseAgentToolDefinition<z.infer<typeof parameters>> {
  const definition: RelaybaseAgentToolDefinition<z.infer<typeof parameters>> = {
    name: "get_diagnostics",
    description:
      "Read safe Relaybase daemon, state, Agent Gateway, and optional log-store diagnostics. Do not include raw tokens, env secrets, or raw logs.",
    parameters,
    approvalRequired: false,
    risk: "low",
    execute: (input, context) =>
      safeToolExecute(definition, input, async () => {
        const state = await getRelaybaseState(context.runtime);
        return successResult(definition.name, {
          stateDiagnostics: state.diagnostics ?? [],
          agentDiagnostics: await context.runtime.agentGateway.diagnostics(context.runtime),
          ...(input.includeLogStore ? { logStore: context.runtime.logStore.health() } : {})
        });
      })
  };
  return definition;
}
