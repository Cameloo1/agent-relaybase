import { z } from "zod";
import { applyManifestPatch, previewManifestPatch } from "../../setupApi.ts";
import {
  confirmationContextSchema,
  diagnosticResult,
  manifestPathForApp,
  requireApproved,
  safeToolExecute,
  successResult,
  type AgentToolExecutionContext,
  type RelaybaseAgentToolDefinition
} from "./common.ts";

const relaybasePatchSchema = z
  .object({
    groupId: z.string().optional(),
    componentRole: z.enum(["frontend", "backend", "worker", "database", "service", "other"]).optional(),
    displayName: z.string().optional(),
    paneLabel: z.string().optional(),
    paneOrder: z.number().int().optional()
  })
  .strict();

const manifestPatchSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    command: z.string().optional(),
    cwd: z.string().optional(),
    protocol: z.enum(["http", "http+ws", "tcp"]).optional(),
    healthUrl: z.string().optional(),
    upstreamPort: z.number().int().positive().optional(),
    relaybase: relaybasePatchSchema.optional()
  })
  .strict();

const parameters = z
  .object({
    appId: z.string().optional(),
    manifestPath: z.string().optional(),
    cwd: z.string().optional(),
    patch: manifestPatchSchema,
    reason: z.string().optional(),
    confirmationContext: confirmationContextSchema
  })
  .strict();

export function createPatchManifestFieldsTool(): RelaybaseAgentToolDefinition<z.infer<typeof parameters>> {
  const definition: RelaybaseAgentToolDefinition<z.infer<typeof parameters>> = {
    name: "patch_manifest_fields",
    description:
      "Preview or apply safe manifest field patches. Requires approval for apply. Use preview first and never claim manifest edits before apply result.",
    parameters,
    approvalRequired: true,
    risk: "high",
    execute: (input, context) => runManifestPatch(definition, input, context)
  };
  return definition;
}

export async function runManifestPatch(
  definition: RelaybaseAgentToolDefinition<Record<string, unknown>>,
  input: Record<string, unknown>,
  context: AgentToolExecutionContext
) {
  return safeToolExecute(definition, input, async () => {
    const manifestPath = await resolveManifestPathFromInput(context, input);
    if (!manifestPath) {
      return diagnosticResult(definition.name, "AGENT_MANIFEST_PATH_REQUIRED", "A manifest path is required.", {
        severity: "error",
        userAction: "Provide manifestPath or appId for an app with a manifestPath."
      });
    }
    const body = {
      manifestPath,
      cwd: typeof input.cwd === "string" ? input.cwd : context.tuiContext.currentCwd,
      patch: input.patch as Record<string, unknown>
    };
    const approval = requireApproved(definition, body, context, "Apply a safe manifest patch.");
    if (approval) {
      const preview = await previewManifestPatch(body);
      return {
        ...approval,
        data: { preview }
      };
    }
    return successResult(
      definition.name,
      await applyManifestPatch({
        ...body,
        confirm: true,
        confirmation: { confirmed: true, reason: typeof input.reason === "string" ? input.reason : undefined }
      })
    );
  });
}

async function resolveManifestPathFromInput(
  context: AgentToolExecutionContext,
  input: Record<string, unknown>
): Promise<string | undefined> {
  if (typeof input.appId === "string" && input.appId.trim()) {
    return manifestPathForApp(context.runtime, input.appId.trim());
  }
  if (typeof input.manifestPath === "string" && input.manifestPath.trim()) {
    return input.manifestPath.trim();
  }
  if (context.tuiContext.selectedAppId) {
    return manifestPathForApp(context.runtime, context.tuiContext.selectedAppId);
  }
  return undefined;
}
