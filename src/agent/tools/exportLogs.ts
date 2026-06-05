import { z } from "zod";
import {
  confirmationContextSchema,
  correlationId,
  requireApproved,
  safeToolExecute,
  successResult,
  type RelaybaseAgentToolDefinition
} from "./common.ts";

const parameters = z
  .object({
    scope: z.enum(["pane", "app", "group", "page", "all"]),
    appId: z.string().optional(),
    groupId: z.string().optional(),
    componentRole: z.enum(["frontend", "backend", "worker", "database", "service", "other"]).optional(),
    format: z.enum(["log", "jsonl", "zip"]).default("zip"),
    limit: z.number().int().positive().max(50_000).optional(),
    reason: z.string().optional(),
    confirmationContext: confirmationContextSchema
  })
  .strict();

export function createExportLogsTool(): RelaybaseAgentToolDefinition<z.infer<typeof parameters>> {
  const definition: RelaybaseAgentToolDefinition<z.infer<typeof parameters>> = {
    name: "export_logs",
    description:
      "Create a real daemon-owned redacted log export artifact. Requires approval because exports may include sensitive logs. Never support unredacted exports.",
    parameters,
    approvalRequired: true,
    risk: "high",
    execute: (input, context) =>
      safeToolExecute(definition, input, async () => {
        const approval = requireApproved(definition, input, context, "Write a redacted log export artifact.");
        if (approval) {
          return approval;
        }
        const result = await context.runtime.exports.create(
          {
            scope: input.scope,
            format: input.format,
            ...(input.appId ? { appId: input.appId } : {}),
            ...(input.groupId ? { groupId: input.groupId } : {}),
            ...(input.componentRole ? { componentRole: input.componentRole } : {}),
            ...(input.limit ? { limit: input.limit } : {}),
            redact: true
          },
          correlationId(context)
        );
        return successResult(
          definition.name,
          { export: result },
          {
            next: { poll: `/__hub/api/exports/${encodeURIComponent(result.exportId)}` }
          }
        );
      })
  };
  return definition;
}
