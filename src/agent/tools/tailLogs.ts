import { z } from "zod";
import { safeToolExecute, successResult, type RelaybaseAgentToolDefinition } from "./common.ts";

const parameters = z
  .object({
    appId: z.string().optional(),
    groupId: z.string().optional(),
    componentRole: z.enum(["frontend", "backend", "worker", "database", "service", "other"]).optional(),
    limit: z.number().int().positive().max(500).optional(),
    before: z.number().int().positive().optional(),
    after: z.number().int().positive().optional()
  })
  .strict();

export function createTailLogsTool(): RelaybaseAgentToolDefinition<z.infer<typeof parameters>> {
  const definition: RelaybaseAgentToolDefinition<z.infer<typeof parameters>> = {
    name: "tail_logs",
    description:
      "Read a bounded redacted log page from the durable Relaybase log store. Use appId/groupId/componentRole filters; never request raw secrets or unbounded logs.",
    parameters,
    approvalRequired: false,
    risk: "medium",
    execute: (input, context) =>
      safeToolExecute(definition, input, async () => {
        const result = await context.runtime.logStore.query({
          ...(input.appId ? { appId: input.appId } : {}),
          ...(input.groupId ? { groupId: input.groupId } : {}),
          ...(input.componentRole ? { componentRole: input.componentRole } : {}),
          limit: input.limit ?? 100,
          ...(input.before ? { before: input.before } : {}),
          ...(input.after ? { after: input.after } : {})
        });
        return successResult(definition.name, {
          events: result.events.map((event) => ({
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
          page: result.page,
          diagnostics: result.diagnostics
        });
      })
  };
  return definition;
}
