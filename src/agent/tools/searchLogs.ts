import { z } from "zod";
import { safeToolExecute, successResult, type RelaybaseAgentToolDefinition } from "./common.ts";

const parameters = z
  .object({
    query: z.string().min(1),
    appId: z.string().optional(),
    groupId: z.string().optional(),
    componentRole: z.enum(["frontend", "backend", "worker", "database", "service", "other"]).optional(),
    limit: z.number().int().positive().max(100).optional(),
    scanLimit: z.number().int().positive().max(500).optional()
  })
  .strict();

export function createSearchLogsTool(): RelaybaseAgentToolDefinition<z.infer<typeof parameters>> {
  const definition: RelaybaseAgentToolDefinition<z.infer<typeof parameters>> = {
    name: "search_logs",
    description:
      "Search a bounded redacted log window and return only the latest bounded matches. Use appId/groupId/componentRole to narrow scope, limit to cap returned matches, and scanLimit only when a wider recent search window is necessary.",
    parameters,
    approvalRequired: false,
    risk: "medium",
    execute: (input, context) =>
      safeToolExecute(definition, input, async () => {
        const result = await context.runtime.logStore.query({
          ...(input.appId ? { appId: input.appId } : {}),
          ...(input.groupId ? { groupId: input.groupId } : {}),
          ...(input.componentRole ? { componentRole: input.componentRole } : {}),
          limit: input.scanLimit ?? 500
        });
        const needle = input.query.toLowerCase();
        const matches = result.events.filter((event) => event.message.toLowerCase().includes(needle));
        const limit = input.limit ?? 50;
        const events = matches.slice(-limit);
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
          matched: matches.length,
          returned: events.length,
          truncated: matches.length > events.length,
          page: result.page,
          diagnostics: result.diagnostics
        });
      })
  };
  return definition;
}
