import { z } from "zod";
import { planSetup } from "../../setupApi.ts";
import { safeToolExecute, successResult, type RelaybaseAgentToolDefinition } from "./common.ts";

const runtimeIdSchema = z.enum([
  "javascript-typescript",
  "powershell",
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
    portStrategyHint: portStrategySchema.optional(),
    command: z.string().optional(),
    envStrategy: z.enum(["runtime-injection", "env-relaybase-file", "guarded-env-block", "none"]).optional(),
    componentMetadata: componentMetadataSchema.optional(),
    components: z.array(componentMetadataSchema).optional()
  })
  .strict();

export function createPlanAppSetupTool(): RelaybaseAgentToolDefinition<z.infer<typeof parameters>> {
  const definition: RelaybaseAgentToolDefinition<z.infer<typeof parameters>> = {
    name: "plan_app_setup",
    description:
      "Generate daemon setup plan choices after detect_project. This writes nothing. Accept runtimePreference, commandHint, and portStrategyHint only as user hints; the daemon runtime matrix remains source of truth. Return runtime-aware command candidates, port strategies, health candidates, setup questions, and repair candidates instead of assuming Node/npm.",
    parameters,
    approvalRequired: false,
    risk: "low",
    execute: (input, context) =>
      safeToolExecute(definition, input, async () =>
        successResult(
          definition.name,
          await planSetup({ ...input, cwd: input.cwd ?? input.currentDirectory ?? context.tuiContext.currentCwd })
        )
      )
  };
  return definition;
}
