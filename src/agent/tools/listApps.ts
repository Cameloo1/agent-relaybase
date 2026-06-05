import { z } from "zod";
import { getRelaybaseState } from "../../appState.ts";
import { safeToolExecute, successResult, type RelaybaseAgentToolDefinition } from "./common.ts";

const parameters = z.object({}).strict();

export function createListAppsTool(): RelaybaseAgentToolDefinition<z.infer<typeof parameters>> {
  const definition: RelaybaseAgentToolDefinition<z.infer<typeof parameters>> = {
    name: "list_apps",
    description:
      "Read current Relaybase apps, groups, components, readiness, and route status. Use this before proposing lifecycle or setup actions. Never invent app names or statuses.",
    parameters,
    approvalRequired: false,
    risk: "low",
    execute: (input, context) =>
      safeToolExecute(definition, input, async () => {
        const state = await getRelaybaseState(context.runtime);
        return successResult(definition.name, {
          apps: state.apps.map((app) => ({
            id: app.id,
            name: app.name,
            runtimeStatus: app.runtime.status,
            readiness: app.readiness.state,
            routeReachable: app.routeReachable,
            canStart: app.canStart,
            canStop: app.canStop,
            humanUrl: app.humanUrl
          })),
          groups: state.groups,
          components: state.components,
          diagnostics: state.diagnostics ?? []
        });
      })
  };
  return definition;
}
