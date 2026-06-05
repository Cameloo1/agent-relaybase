import { z } from "zod";
import { safeToolExecute, successResult, type RelaybaseAgentToolDefinition } from "./common.ts";

const parameters = z
  .object({
    query: z.string().min(1),
    appId: z.string().optional(),
    groupId: z.string().optional(),
    componentRole: z.enum(["frontend", "backend", "worker", "database", "service", "other"]).optional(),
    limit: z.number().int().positive().max(500).optional()
  })
  .strict();

export function createSearchLogsTool(): RelaybaseAgentToolDefinition<z.infer<typeof parameters>> {
  const definition: RelaybaseAgentToolDefinition<z.infer<typeof parameters>> = {
    name: "search_logs",
    description:
      "Search a bounded redacted log page. This reads from durable logs only and must not expose raw secrets or request unbounded log history.",
    parameters,
    approvalRequired: false,
    risk: "medium",
    execute: (input, context) =>
      safeToolExecute(definition, input, async () => {
        const result = await context.runtime.logStore.query({
          ...(input.appId ? { appId: input.appId } : {}),
          ...(input.groupId ? { groupId: input.groupId } : {}),
          ...(input.componentRole ? { componentRole: input.componentRole } : {}),
          limit: input.limit ?? 500
        });
        const needle = input.query.toLowerCase();
        const events = result.events.filter((event) => event.message.toLowerCase().includes(needle));
        return successResult(definition.name, {
          events: events.map((event) => ({
            sequence: event.sequence,
            timestamp: event.timestamp,
            appId: event.appId,
            groupId: event.groupId,
            componentRole: event.componentRole,
            stream: event.stream,
            level: event.level,
            message: event.message,
            redacted: true
          })),
          searched: result.events.length,
          page: result.page,
          diagnostics: result.diagnostics
        });
      })
  };
  return definition;
}
