import { z } from "zod";
import { previewSetup } from "../../setupApi.ts";
import { safeToolExecute, successResult, type RelaybaseAgentToolDefinition } from "./common.ts";

const runtimeIdSchema = z.enum([
  "javascript-typescript",
  "python",
  "go",
  "rust",
  "java",
  "kotlin-jvm",
  "dotnet",
  "ruby",
  "php",
  "elixir",
  "scala",
  "clojure",
  "dart",
  "native",
  "docker-compose",
  "procfile"
]);

const portStrategySchema = z.enum([
  "managed_dynamic_port",
  "fixed_upstream_port",
  "env_port",
  "framework_port_flags",
  "generated_launch_wrapper",
  "docker_compose_wrapper",
  "explicit_host_port_flags",
  "runtime_specific_env",
  "compose_port_mapping",
  "manual_custom"
]);

const componentMetadataSchema = z
  .object({
    appId: z.string().optional(),
    name: z.string().optional(),
    command: z.string().optional(),
    cwd: z.string().optional(),
    healthUrl: z.string().optional(),
    groupId: z.string().optional(),
    componentRole: z.enum(["frontend", "backend", "worker", "database", "service", "other"]).optional(),
    displayName: z.string().optional(),
    paneLabel: z.string().optional(),
    paneOrder: z.number().int().optional()
  })
  .strict();

const parameters = z
  .object({
    cwd: z.string().optional(),
    currentDirectory: z.string().optional(),
    selectedPlanId: z.string().optional(),
    profile: z.string().optional(),
    runtimePreference: runtimeIdSchema.optional(),
    commandHint: z.string().optional(),
    command: z.string().optional(),
    portStrategyHint: portStrategySchema.optional(),
    envStrategy: z.enum(["runtime-injection", "env-relaybase-file", "guarded-env-block", "none"]).optional(),
    componentMetadata: componentMetadataSchema.optional(),
    components: z.array(componentMetadataSchema).optional()
  })
  .strict();

export function createPreviewSetupWritesTool(): RelaybaseAgentToolDefinition<z.infer<typeof parameters>> {
  const definition: RelaybaseAgentToolDefinition<z.infer<typeof parameters>> = {
    name: "preview_setup_writes",
    description:
      "Return runtime-aware setup file write previews and redacted diffs for the selected plan, including generated wrappers/profiles, selected command summary, selected port strategy, runtime-specific files, and env key changes without raw secret values. This writes nothing; do not claim files were written.",
    parameters,
    approvalRequired: false,
    risk: "medium",
    execute: (input, context) =>
      safeToolExecute(definition, input, async () => {
        const preview = await previewSetup({
          ...input,
          commandHint: input.commandHint ?? input.command,
          cwd: input.cwd ?? input.currentDirectory ?? context.tuiContext.currentCwd
        });
        return successResult(definition.name, preview, {
          setupPlanId: preview.selectedPlan.id
        });
      })
  };
  return definition;
}
