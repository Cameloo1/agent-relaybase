import { z } from "zod";
import { confirmationContextSchema, diagnosticResult, type RelaybaseAgentToolDefinition } from "./common.ts";
import { runManifestPatch } from "./patchManifestFields.ts";

const parameters = z
  .object({
    appId: z.string().optional(),
    manifestPath: z.string().optional(),
    cwd: z.string().optional(),
    key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    value: z.string().optional(),
    valueReference: z.string().optional(),
    secret: z.boolean().optional(),
    reason: z.string().optional(),
    confirmationContext: confirmationContextSchema
  })
  .strict();

export function createAddEnvOverrideSafeTool(): RelaybaseAgentToolDefinition<z.infer<typeof parameters>> {
  const definition: RelaybaseAgentToolDefinition<z.infer<typeof parameters>> = {
    name: "add_env_override_safe",
    description:
      "Preview or apply an approved runtime-agnostic manifest env override without exposing raw secret values. For secret-like keys, use valueReference such as env:NAME rather than raw values.",
    parameters,
    approvalRequired: true,
    risk: "high",
    execute: (input, context) => {
      const secretLike = input.secret === true || /token|secret|password|api[_-]?key/i.test(input.key);
      if (secretLike && input.value && !input.valueReference) {
        return Promise.resolve(
          diagnosticResult(
            definition.name,
            "AGENT_ENV_SECRET_VALUE_REJECTED",
            "Raw secret-like env values are not accepted.",
            {
              severity: "error",
              userAction: "Provide a valueReference such as env:MY_SECRET instead of a raw secret value."
            }
          )
        );
      }
      const value = input.valueReference ?? input.value ?? "";
      return runManifestPatch(definition, { ...input, patch: { env: { [input.key]: value } } }, context);
    }
  };
  return definition;
}
