import { z } from "zod";
import { confirmationContextSchema, type RelaybaseAgentToolDefinition } from "./common.ts";
import { runManifestPatch } from "./patchManifestFields.ts";

const parameters = z
  .object({
    appId: z.string().optional(),
    manifestPath: z.string().optional(),
    cwd: z.string().optional(),
    groupId: z.string().optional(),
    componentRole: z.enum(["frontend", "backend", "worker", "database", "service", "other"]).optional(),
    displayName: z.string().optional(),
    paneLabel: z.string().optional(),
    paneOrder: z.number().int().optional(),
    reason: z.string().optional(),
    confirmationContext: confirmationContextSchema
  })
  .strict();

export function createSetComponentMetadataTool(): RelaybaseAgentToolDefinition<z.infer<typeof parameters>> {
  const definition: RelaybaseAgentToolDefinition<z.infer<typeof parameters>> = {
    name: "set_component_metadata",
    description:
      "Preview or apply approved relaybase component-as-app metadata such as frontend/backend role, group id, pane label, and order.",
    parameters,
    approvalRequired: true,
    risk: "high",
    execute: (input, context) => {
      const relaybase = {
        ...(input.groupId ? { groupId: input.groupId } : {}),
        ...(input.componentRole ? { componentRole: input.componentRole } : {}),
        ...(input.displayName ? { displayName: input.displayName } : {}),
        ...(input.paneLabel ? { paneLabel: input.paneLabel } : {}),
        ...(input.paneOrder !== undefined ? { paneOrder: input.paneOrder } : {})
      };
      return runManifestPatch(definition, { ...input, patch: { relaybase } }, context);
    }
  };
  return definition;
}
