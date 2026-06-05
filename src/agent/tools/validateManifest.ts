import { z } from "zod";
import { validateManifest } from "../../setupApi.ts";
import { safeToolExecute, successResult, type RelaybaseAgentToolDefinition } from "./common.ts";

const parameters = z
  .object({
    manifestPath: z.string().optional(),
    cwd: z.string().optional(),
    manifest: z.record(z.string(), z.unknown()).optional()
  })
  .strict();

export function createValidateManifestTool(): RelaybaseAgentToolDefinition<z.infer<typeof parameters>> {
  const definition: RelaybaseAgentToolDefinition<z.infer<typeof parameters>> = {
    name: "validate_manifest",
    description:
      "Validate a Relaybase manifest object or manifest path without writing files. Use this before registration or patch apply.",
    parameters,
    approvalRequired: false,
    risk: "low",
    execute: (input, _context) =>
      safeToolExecute(definition, input, async () => successResult(definition.name, await validateManifest(input)))
  };
  return definition;
}
