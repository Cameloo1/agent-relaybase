import { z } from "zod";
import { applySetup } from "../../setupApi.ts";
import {
  confirmationContextSchema,
  correlationId,
  requireApproved,
  safeToolExecute,
  successResult,
  type RelaybaseAgentToolDefinition
} from "./common.ts";

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
    repair: z.boolean().optional(),
    envStrategy: z.enum(["runtime-injection", "env-relaybase-file", "guarded-env-block", "none"]).optional(),
    componentMetadata: componentMetadataSchema.optional(),
    reason: z.string().optional(),
    confirmationContext: confirmationContextSchema
  })
  .strict();

export function createApplySetupPlanTool(): RelaybaseAgentToolDefinition<z.infer<typeof parameters>> {
  const definition: RelaybaseAgentToolDefinition<z.infer<typeof parameters>> = {
    name: "apply_setup_plan",
    description:
      "Apply an approved daemon setup plan. Requires approval because it writes runtime-specific files/wrappers/profiles and registers a manifest. Always run preview_setup_writes first, show runtime/command/port/file-write context, and never claim writes before the apply result.",
    parameters,
    approvalRequired: true,
    risk: "high",
    execute: (input, context) =>
      safeToolExecute(definition, input, async () => {
        const approval = requireApproved(
          definition,
          input,
          context,
          "Apply approved setup writes and register manifest."
        );
        if (approval) {
          return approval;
        }
        const setup = await applySetup(
          context.runtime,
          {
            ...input,
            cwd: input.cwd ?? input.currentDirectory ?? context.tuiContext.currentCwd,
            commandHint: input.commandHint ?? input.command,
            confirm: true,
            confirmation: { confirmed: true, reason: input.reason }
          },
          correlationId(context)
        );
        return successResult(definition.name, setup, {
          setupPlanId: setup.selectedPlan.id
        });
      })
  };
  return definition;
}
