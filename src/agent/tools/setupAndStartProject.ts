import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { enqueueLifecycleOperation } from "../../api.ts";
import { getAppState } from "../../appState.ts";
import {
  applySetup,
  inspectManifest,
  previewSetup,
  registerManifest,
  repairSetup,
  validateManifest
} from "../../setupApi.ts";
import type { AppRecord, AppState } from "../../types.ts";
import {
  confirmationContextSchema,
  correlationId,
  diagnosticResult,
  requireApproved,
  safeToolExecute,
  successResult,
  text,
  type AgentToolStructuredResult,
  type RelaybaseAgentToolDefinition
} from "./common.ts";
import { createSetupPreviewBinding, verifySetupPreviewBinding } from "./setupPreviewBinding.ts";

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

const previewBindingSchema = z
  .object({
    schemaVersion: z.literal(1),
    algorithm: z.literal("sha256"),
    digest: z.string().regex(/^[a-f0-9]{64}$/i),
    revision: z.string().regex(/^[a-f0-9]{64}$/i),
    setupPlanId: z.string().min(1)
  })
  .strict();

const parameters = z
  .object({
    phase: z.enum(["apply_setup", "register_manifest", "start_registered"]),
    cwd: z.string().optional(),
    currentDirectory: z.string().optional(),
    appId: z.string().optional(),
    manifestPath: z.string().optional(),
    selectedPlanId: z.string().optional(),
    profile: z.string().optional(),
    commandHint: z.string().optional(),
    command: z.string().optional(),
    portStrategyHint: z
      .enum([
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
      ])
      .optional(),
    envStrategy: z.enum(["runtime-injection", "env-relaybase-file", "guarded-env-block", "none"]).optional(),
    componentMetadata: componentMetadataSchema.optional(),
    previewBinding: previewBindingSchema.optional(),
    reason: z.string().optional(),
    confirmationContext: confirmationContextSchema
  })
  .strict();

type SetupAndStartInput = z.infer<typeof parameters>;

export function createSetupAndStartProjectTool(): RelaybaseAgentToolDefinition<SetupAndStartInput> {
  const definition: RelaybaseAgentToolDefinition<SetupAndStartInput> = {
    name: "setup_and_start_project",
    description:
      "Compose daemon-owned setup, registration, and lifecycle start for a project path in explicit approval-gated phases. Use apply_setup for missing manifests, register_manifest for existing unregistered manifests, and start_registered only after the app is registered. Never writes setup files or starts processes before approval.",
    parameters,
    approvalRequired: true,
    risk: "high",
    execute: (input, context) =>
      safeToolExecute(definition, input, async () => {
        if (input.phase === "apply_setup") {
          return setupApplyPhase(definition, input, context);
        }
        if (input.phase === "register_manifest") {
          return registerManifestPhase(definition, input, context);
        }
        return startRegisteredPhase(definition, input, context);
      })
  };
  return definition;
}

async function setupApplyPhase(
  definition: RelaybaseAgentToolDefinition<SetupAndStartInput>,
  input: SetupAndStartInput,
  context: Parameters<RelaybaseAgentToolDefinition<SetupAndStartInput>["execute"]>[1]
): Promise<AgentToolStructuredResult> {
  const setupArgs = setupRequest(input, context);
  const preview = await previewSetup(setupArgs);
  const currentBinding = createSetupPreviewBinding(preview);
  context.emit?.({ type: "setup.plan_preview", data: { preview, previewBinding: currentBinding } });
  const approval = requireApproved(
    definition,
    { ...input, previewBinding: currentBinding },
    context,
    "Apply only the setup writes bound to this exact preview revision, then register the app."
  );
  if (approval) {
    return {
      ...approval,
      data: {
        phase: "apply_setup",
        preview,
        previewBinding: currentBinding,
        nextApprovedPhase: "apply_setup"
      },
      setupPlanId: preview.selectedPlan.id
    };
  }

  const bindingVerification = verifySetupPreviewBinding(preview, input.previewBinding);
  if (!bindingVerification.ok) {
    const missing = bindingVerification.failure === "missing";
    return diagnosticResult(
      definition.name,
      missing ? "SETUP_PREVIEW_BINDING_REQUIRED" : "SETUP_PREVIEW_STALE",
      missing
        ? "Approved setup apply is missing its immutable preview binding."
        : "The approved setup preview no longer matches the current project state.",
      {
        severity: "error",
        userAction: "Generate a fresh setup preview, review it, and approve that exact revision before applying.",
        detail: {
          failure: bindingVerification.failure,
          setupPlanId: preview.selectedPlan.id,
          mutationPerformed: false
        }
      }
    );
  }

  const setup = await applySetup(
    context.runtime,
    {
      ...setupArgs,
      confirm: true,
      confirmation: { confirmed: true, reason: input.reason }
    },
    correlationId(context)
  );
  return successResult(
    definition.name,
    {
      phase: "setup_applied",
      setup,
      next: {
        tool: definition.name,
        input: {
          phase: "start_registered",
          cwd: setup.cwd,
          appId: setup.registeredApp?.id,
          reason: input.reason
        },
        approvalRequired: true
      }
    },
    { setupPlanId: setup.selectedPlan.id }
  );
}

async function registerManifestPhase(
  definition: RelaybaseAgentToolDefinition<SetupAndStartInput>,
  input: SetupAndStartInput,
  context: Parameters<RelaybaseAgentToolDefinition<SetupAndStartInput>["execute"]>[1]
): Promise<AgentToolStructuredResult> {
  const cwd = projectCwd(input, context);
  const manifestPath = input.manifestPath ?? path.join(cwd, "relaybase.app.json");
  const analysis = await validateManifest({ manifestPath, cwd });
  if (!analysis.valid) {
    return diagnosticResult(definition.name, "SETUP_AND_START_MANIFEST_INVALID", "Manifest is invalid.", {
      severity: "error",
      userAction: "Fix relaybase.app.json before registration.",
      detail: analysis
    });
  }

  const approval = requireApproved(definition, input, context, "Register the manifest through the daemon registry.");
  if (approval) {
    return {
      ...approval,
      data: {
        phase: "register_manifest",
        manifest: analysis,
        nextApprovedPhase: "register_manifest"
      }
    };
  }

  const registered = await registerManifest(context.runtime, { manifestPath, cwd }, correlationId(context));
  return successResult(definition.name, {
    phase: "manifest_registered",
    registered,
    next: {
      tool: definition.name,
      input: {
        phase: "start_registered",
        cwd,
        appId: registered.app.id,
        reason: input.reason
      },
      approvalRequired: true
    }
  });
}

async function startRegisteredPhase(
  definition: RelaybaseAgentToolDefinition<SetupAndStartInput>,
  input: SetupAndStartInput,
  context: Parameters<RelaybaseAgentToolDefinition<SetupAndStartInput>["execute"]>[1]
): Promise<AgentToolStructuredResult> {
  const cwd = projectCwd(input, context, false);
  const app = await registeredAppForInput(context.runtime, input, cwd);
  if (!app) {
    const manifest = cwd ? await inspectManifestIfPresent(cwd, input.manifestPath) : undefined;
    if (manifest?.valid) {
      return diagnosticResult(
        definition.name,
        "SETUP_AND_START_REGISTRATION_REQUIRED",
        "Project has a valid manifest, but the app is not registered in the daemon.",
        {
          severity: "warning",
          userAction:
            "Approve setup_and_start_project with phase=register_manifest, then approve phase=start_registered.",
          detail: { cwd, manifestPath: manifest.path, appId: manifest.app?.id }
        }
      );
    }
    return diagnosticResult(definition.name, "SETUP_AND_START_SETUP_REQUIRED", "Project is not configured yet.", {
      severity: "warning",
      userAction: "Run detect_project, plan_app_setup, preview_setup_writes, then approve phase=apply_setup.",
      detail: { cwd }
    });
  }

  const approval = requireApproved(definition, { ...input, appId: app.id }, context, "Start the registered app.");
  if (approval) {
    return approval;
  }

  const handle = enqueueLifecycleOperation(context.runtime, app.id, "start", correlationId(context));
  const operation = await handle.done;
  const state = await safeAppState(context.runtime, app.id);
  const logs = await tailAppLogs(context.runtime, app.id);

  if (operation.status !== "succeeded") {
    const repairChoices = cwd ? await safeRepairChoices(cwd, operation.message) : undefined;
    return {
      tool: definition.name,
      status: "failed",
      operationId: operation.operationId,
      data: {
        phase: "start_failed",
        appId: app.id,
        operation,
        state,
        logs,
        repairChoices,
        route: state?.humanUrl,
        healthRouteCandidates: repairChoices?.plan.choices.flatMap((choice) => choice.runtimeHealthCandidates ?? [])
      },
      repairPlanId: repairChoices?.plan.choices[0]?.id,
      diagnostic: {
        code: "SETUP_AND_START_START_FAILED",
        severity: "error",
        message: operation.error?.message ?? operation.message ?? "Daemon lifecycle start failed.",
        userAction: "Inspect logs and approve one of the daemon repair choices before retrying.",
        detail: { operationId: operation.operationId, appId: app.id }
      }
    };
  }

  return successResult(
    definition.name,
    {
      phase: "started",
      appId: app.id,
      operation,
      state,
      logs,
      route: state?.humanUrl,
      logSnapshotUrl: state?.logSnapshotUrl
    },
    {
      operationId: operation.operationId,
      next: { poll: `/__hub/api/operations/${encodeURIComponent(operation.operationId)}` }
    }
  );
}

function setupRequest(
  input: SetupAndStartInput,
  context: { tuiContext: { currentCwd?: string } }
): Record<string, unknown> {
  return {
    cwd: projectCwd(input, context),
    ...(input.selectedPlanId ? { selectedPlanId: input.selectedPlanId } : {}),
    ...(input.profile ? { profile: input.profile } : {}),
    ...((input.commandHint ?? input.command) ? { commandHint: input.commandHint ?? input.command } : {}),
    ...(input.portStrategyHint ? { portStrategyHint: input.portStrategyHint } : {}),
    ...(input.envStrategy ? { envStrategy: input.envStrategy } : {}),
    ...(input.componentMetadata ? { componentMetadata: input.componentMetadata } : {})
  };
}

function projectCwd(
  input: Pick<SetupAndStartInput, "cwd" | "currentDirectory">,
  context: { tuiContext: { currentCwd?: string } },
  required = true
): string {
  const cwd = text(input.cwd ?? input.currentDirectory ?? context.tuiContext.currentCwd);
  if (!cwd && required) {
    throw new Error("A project cwd/currentDirectory is required.");
  }
  return cwd ? path.resolve(cwd) : "";
}

async function registeredAppForInput(
  runtime: { registry: { list(): Promise<AppRecord[]>; get(id: string): Promise<AppRecord | undefined> } },
  input: Pick<SetupAndStartInput, "appId" | "manifestPath">,
  cwd: string
): Promise<AppRecord | undefined> {
  if (input.appId) {
    return runtime.registry.get(input.appId);
  }

  const manifest = cwd ? await inspectManifestIfPresent(cwd, input.manifestPath) : undefined;
  if (manifest?.app?.id) {
    const registered = await runtime.registry.get(manifest.app.id);
    if (registered) {
      return registered;
    }
  }

  if (!cwd) {
    return undefined;
  }
  const apps = await runtime.registry.list();
  return apps.find((app) => appMatchesCwd(app, cwd));
}

async function inspectManifestIfPresent(cwd: string, manifestPath?: string) {
  const resolvedManifestPath = manifestPath ?? path.join(cwd, "relaybase.app.json");
  try {
    await fs.access(resolvedManifestPath);
  } catch {
    return undefined;
  }
  return inspectManifest({ manifestPath: resolvedManifestPath, cwd });
}

function appMatchesCwd(app: AppRecord, cwd: string): boolean {
  const candidates = [app.cwd];
  if (app.manifestPath) {
    candidates.push(path.dirname(app.manifestPath));
    candidates.push(path.resolve(path.dirname(app.manifestPath), app.cwd));
  }
  return candidates.some((candidate) => path.resolve(candidate) === path.resolve(cwd));
}

async function safeAppState(runtime: Parameters<typeof getAppState>[0], appId: string): Promise<AppState | undefined> {
  try {
    return await getAppState(runtime, appId);
  } catch {
    return undefined;
  }
}

async function tailAppLogs(
  runtime: {
    logStore: { query(input: Record<string, unknown>): Promise<{ events: unknown[]; diagnostics: unknown[] }> };
  },
  appId: string
): Promise<unknown> {
  try {
    const result = await runtime.logStore.query({ appId, limit: 50 });
    return { events: result.events, diagnostics: result.diagnostics };
  } catch (error) {
    return {
      events: [],
      diagnostics: [
        {
          code: "SETUP_AND_START_LOGS_UNAVAILABLE",
          severity: "warning",
          message: error instanceof Error ? error.message : "Could not read logs."
        }
      ]
    };
  }
}

async function safeRepairChoices(
  cwd: string,
  reason?: string
): Promise<Awaited<ReturnType<typeof repairSetup>> | undefined> {
  try {
    return await repairSetup({ cwd, reason });
  } catch {
    return undefined;
  }
}
