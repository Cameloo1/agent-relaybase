import { z } from "zod";
import { getRelaybaseState } from "../../appState.ts";
import { safeToolExecute, successResult, type RelaybaseAgentToolDefinition } from "./common.ts";

const parameters = z
  .object({
    query: z.string().trim().min(1).max(200).optional(),
    runtimeStatus: z.enum(["stopped", "starting", "running", "stopping", "degraded", "errored", "conflict"]).optional(),
    groupId: z.string().trim().min(1).max(200).optional(),
    componentRole: z.enum(["frontend", "backend", "worker", "database", "service", "other"]).optional(),
    offset: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().max(50).optional(),
    includeTopology: z.boolean().optional()
  })
  .strict();

export function createListAppsTool(): RelaybaseAgentToolDefinition<z.infer<typeof parameters>> {
  const definition: RelaybaseAgentToolDefinition<z.infer<typeof parameters>> = {
    name: "list_apps",
    description:
      "Read a deterministic bounded page of current Relaybase apps. Filter by query, runtimeStatus, groupId, or componentRole; request includeTopology only when group/component detail is needed. Use get_app_state for an exact known app. Never invent app names or statuses.",
    parameters,
    approvalRequired: false,
    risk: "low",
    execute: (input, context) =>
      safeToolExecute(definition, input, async () => {
        const state = await getRelaybaseState(context.runtime);
        const query = input.query?.toLowerCase();
        const componentsByApp = new Map<string, typeof state.components>();
        for (const component of state.components) {
          const current = componentsByApp.get(component.appId) ?? [];
          current.push(component);
          componentsByApp.set(component.appId, current);
        }
        const matchedApps = [...state.apps]
          .sort((left, right) => left.id.localeCompare(right.id))
          .filter((app) => {
            const components = componentsByApp.get(app.id) ?? [];
            if (input.runtimeStatus && app.runtime.status !== input.runtimeStatus) {
              return false;
            }
            if (input.groupId && !components.some((component) => component.groupId === input.groupId)) {
              return false;
            }
            if (input.componentRole && !components.some((component) => component.role === input.componentRole)) {
              return false;
            }
            if (!query) {
              return true;
            }
            return [
              app.id,
              app.name,
              app.humanUrl,
              ...components.flatMap((component) => [
                component.groupId,
                component.role,
                component.displayName,
                component.paneLabel
              ])
            ].some((value) => value.toLowerCase().includes(query));
          });
        const offset = input.offset ?? 0;
        const limit = input.limit ?? 20;
        const page = matchedApps.slice(offset, offset + limit);
        const returnedAppIds = new Set(page.map((app) => app.id));
        const diagnostics = (state.diagnostics ?? []).slice(0, 10).map((diagnostic) => ({
          id: diagnostic.id,
          severity: diagnostic.severity,
          message: diagnostic.message
        }));
        const truncated = offset + page.length < matchedApps.length;
        return successResult(definition.name, {
          summary: {
            totalApps: state.apps.length,
            matchedApps: matchedApps.length,
            returnedApps: page.length,
            offset,
            limit,
            truncated,
            ...(truncated ? { nextOffset: offset + page.length } : {}),
            diagnosticCount: state.diagnostics?.length ?? 0,
            diagnosticsTruncated: (state.diagnostics?.length ?? 0) > diagnostics.length,
            topologyIncluded: input.includeTopology ?? false
          },
          apps: page.map((app) => ({
            id: app.id,
            name: app.name,
            runtimeStatus: app.runtime.status,
            readiness: app.readiness.state,
            routeReachable: app.routeReachable,
            canStart: app.canStart,
            canStop: app.canStop,
            humanUrl: app.humanUrl
          })),
          ...(input.includeTopology
            ? {
                groups: state.groups
                  .filter((group) => group.components.some((component) => returnedAppIds.has(component.appId)))
                  .map((group) => ({
                    ...group,
                    components: group.components.filter((component) => returnedAppIds.has(component.appId))
                  })),
                components: state.components.filter((component) => returnedAppIds.has(component.appId))
              }
            : {}),
          diagnostics
        });
      })
  };
  return definition;
}
