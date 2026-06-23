import type { AgentToolExecutionContext, RelaybaseAgentToolDefinition } from "./common.ts";
import { createSdkTool } from "./common.ts";
import { createAddEnvOverrideSafeTool } from "./addEnvOverrideSafe.ts";
import { createApplySetupPlanTool } from "./applySetupPlan.ts";
import { createDetectProjectTool } from "./detectProject.ts";
import { createExportLogsTool } from "./exportLogs.ts";
import { createGetAppGroupTool } from "./getAppGroup.ts";
import { createGetAppStateTool } from "./getAppState.ts";
import { createGetDiagnosticsTool } from "./getDiagnostics.ts";
import { createInspectManifestTool } from "./inspectManifest.ts";
import { createListAppsTool } from "./listApps.ts";
import { createOpenProjectOrAppTool } from "./openProjectOrApp.ts";
import { createPatchManifestFieldsTool } from "./patchManifestFields.ts";
import { createPlanAppSetupTool } from "./planAppSetup.ts";
import { createPreviewSetupWritesTool } from "./previewSetupWrites.ts";
import { createProposeTuiActionTool } from "./proposeTuiAction.ts";
import { createProveAppHealthTool } from "./proveAppHealth.ts";
import { createRegisterManifestTool } from "./registerManifest.ts";
import { createRepairAppSetupTool } from "./repairAppSetup.ts";
import { createRestartAppTool } from "./restartApp.ts";
import { createSearchLogsTool } from "./searchLogs.ts";
import { createSetComponentMetadataTool } from "./setComponentMetadata.ts";
import { createSetHealthRouteTool } from "./setHealthRoute.ts";
import { createSetPinnedPortTool } from "./setPinnedPort.ts";
import { createSetupAndStartProjectTool } from "./setupAndStartProject.ts";
import { createStartAppTool } from "./startApp.ts";
import { createStopAppTool } from "./stopApp.ts";
import { createTailLogsTool } from "./tailLogs.ts";
import { createValidateManifestTool } from "./validateManifest.ts";

export interface RelaybaseAgentToolRegistry {
  definitions: RelaybaseAgentToolDefinition[];
  sdkTools: unknown[];
  toolNames: string[];
  readOnlyToolNames: string[];
  mutatingToolNames: string[];
}

export function relaybaseAgentToolDefinitions(): RelaybaseAgentToolDefinition[] {
  return [
    createListAppsTool(),
    createGetAppStateTool(),
    createGetAppGroupTool(),
    createGetDiagnosticsTool(),
    createTailLogsTool(),
    createSearchLogsTool(),
    createStartAppTool(),
    createStopAppTool(),
    createRestartAppTool(),
    createExportLogsTool(),
    createDetectProjectTool(),
    createPlanAppSetupTool(),
    createPreviewSetupWritesTool(),
    createApplySetupPlanTool(),
    createRegisterManifestTool(),
    createInspectManifestTool(),
    createValidateManifestTool(),
    createPatchManifestFieldsTool(),
    createSetHealthRouteTool(),
    createSetPinnedPortTool(),
    createSetComponentMetadataTool(),
    createAddEnvOverrideSafeTool(),
    createOpenProjectOrAppTool(),
    createSetupAndStartProjectTool(),
    createProveAppHealthTool(),
    createRepairAppSetupTool(),
    createProposeTuiActionTool()
  ];
}

export function createRelaybaseAgentToolRegistry(context: AgentToolExecutionContext): RelaybaseAgentToolRegistry {
  const allDefinitions = relaybaseAgentToolDefinitions();
  const allowlist = context.config?.toolAllowlist ? new Set(context.config.toolAllowlist) : undefined;
  const definitions = allDefinitions.filter((definition) => {
    if (allowlist && !allowlist.has(definition.name)) {
      return false;
    }
    return context.config?.approvalPolicy !== "read_only_only" || !definition.approvalRequired;
  });
  return {
    definitions,
    sdkTools: definitions.map((definition) => createSdkTool(definition, context)),
    toolNames: definitions.map((definition) => definition.name),
    readOnlyToolNames: definitions
      .filter((definition) => !definition.approvalRequired)
      .map((definition) => definition.name),
    mutatingToolNames: definitions
      .filter((definition) => definition.approvalRequired)
      .map((definition) => definition.name)
  };
}

export function relaybaseAgentToolNames(): string[] {
  return relaybaseAgentToolDefinitions().map((definition) => definition.name);
}

export function relaybaseAgentReadOnlyToolNames(): string[] {
  return relaybaseAgentToolDefinitions()
    .filter((definition) => !definition.approvalRequired)
    .map((definition) => definition.name);
}

export function relaybaseAgentMutatingToolNames(): string[] {
  return relaybaseAgentToolDefinitions()
    .filter((definition) => definition.approvalRequired)
    .map((definition) => definition.name);
}

export async function executeRelaybaseAgentTool(
  name: string,
  input: Record<string, unknown>,
  context: AgentToolExecutionContext
) {
  const definition = relaybaseAgentToolDefinitions().find((entry) => entry.name === name);
  if (!definition) {
    throw new Error(`Unknown Relaybase agent tool: ${name}`);
  }
  return definition.execute(input, context);
}

export type { AgentToolExecutionContext, RelaybaseAgentToolDefinition } from "./common.ts";
