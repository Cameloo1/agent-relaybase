import { z } from "zod";
import { inspectManifest } from "../../setupApi.ts";
import { safeToolExecute, successResult, type RelaybaseAgentToolDefinition } from "./common.ts";

const parameters = z
  .object({
    manifestPath: z.string(),
    cwd: z.string().optional()
  })
  .strict();

export function createInspectManifestTool(): RelaybaseAgentToolDefinition<z.infer<typeof parameters>> {
  const definition: RelaybaseAgentToolDefinition<z.infer<typeof parameters>> = {
    name: "inspect_manifest",
    description:
      "Read and normalize a Relaybase manifest without writing files or registering it. Use this before register_manifest or manifest patch tools.",
    parameters,
    approvalRequired: false,
    risk: "low",
    execute: (input, _context) =>
      safeToolExecute(definition, input, async () =>
        successResult(definition.name, await inspectManifest({ manifestPath: input.manifestPath, cwd: input.cwd }))
      )
  };
  return definition;
}
