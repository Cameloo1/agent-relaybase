import type { AgentToolExecutionContext, RelaybaseAgentToolDefinition } from "./common.ts";
import { createSdkTool } from "./common.ts";
import { createAddEnvOverrideSafeTool } from "./addEnvOverrideSafe.ts";
import { createApplySetupPlanTool } from "./applySetupPlan.ts";
import { createDetectProjectTool } from "./detectProject.ts";
import { createDiscoverProjectRootsTool } from "./discoverProjectRoots.ts";
import { createExplainAppProblemTool } from "./explainAppProblem.ts";
import { createExportLogsTool } from "./exportLogs.ts";
import { createGetAppGroupTool } from "./getAppGroup.ts";
import { createGetAppStateTool } from "./getAppState.ts";
import { createGetAgentCapabilitiesTool } from "./getAgentCapabilities.ts";
import { createGetCurrentContextTool } from "./getCurrentContext.ts";
import { createGetDiagnosticsTool } from "./getDiagnostics.ts";
import { createInspectManifestTool } from "./inspectManifest.ts";
import { createListAppsTool } from "./listApps.ts";
import { createOpenProjectOrAppTool } from "./openProjectOrApp.ts";
import { createGetOperationStatusTool, createListOperationsTool } from "./operationObservability.ts";
import { createPatchManifestFieldsTool } from "./patchManifestFields.ts";
import { createPlanAppSetupTool } from "./planAppSetup.ts";
import { createPreviewSetupWritesTool } from "./previewSetupWrites.ts";
import { createProposeTuiActionTool } from "./proposeTuiAction.ts";
import { createProveAppHealthTool } from "./proveAppHealth.ts";
import {
  createProjectDetectStartCommandsTool,
  createProjectInspectPackageScriptsTool,
  createProjectListFilesTool,
  createProjectReadFileTool,
  createProjectSearchFilesTool
} from "./projectInspection.ts";
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
import { authorizeAgentToolProjectScope } from "./projectSafety.ts";
import { diagnosticResult } from "./common.ts";
import { bindAgentToolApprovalState, verifyAgentToolApprovalState } from "./approvalStateBinding.ts";

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
    createGetCurrentContextTool(),
    createGetAgentCapabilitiesTool(),
    createExplainAppProblemTool(),
    createGetDiagnosticsTool(),
    createGetOperationStatusTool(),
    createListOperationsTool(),
    createTailLogsTool(),
    createSearchLogsTool(),
    createProjectListFilesTool(),
    createProjectSearchFilesTool(),
    createProjectReadFileTool(),
    createProjectDetectStartCommandsTool(),
    createProjectInspectPackageScriptsTool(),
    createDiscoverProjectRootsTool(),
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
  const resolvedContext = { ...context, registeredToolNames: allDefinitions.map((definition) => definition.name) };
  const allowlist =
    context.config?.toolAllowlistMode === "explicit_allowlist" ? new Set(context.config.toolAllowlist) : undefined;
  const definitions = allDefinitions.filter((definition) => {
    if (allowlist && !allowlist.has(definition.name)) {
      return false;
    }
    return context.config?.approvalPolicy !== "read_only_only" || !definition.approvalRequired;
  });
  return {
    definitions,
    sdkTools: definitions.map((definition) => createSdkTool(definition, resolvedContext)),
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
  const allDefinitions = relaybaseAgentToolDefinitions();
  const definition = allDefinitions.find((entry) => entry.name === name);
  if (!definition) {
    throw new Error(`Unknown Relaybase agent tool: ${name}`);
  }
  context = { ...context, registeredToolNames: allDefinitions.map((entry) => entry.name) };
  const authorization = await authorizeAgentToolProjectScope(
    name,
    input,
    context.tuiContext,
    context.projectRootGrants
  );
  if (!authorization.ok) {
    return diagnosticResult(name, authorization.code, authorization.message, {
      severity: "error",
      userAction: authorization.userAction,
      detail: authorization.detail
    });
  }
  if (context.approved === true) {
    const verification = await verifyAgentToolApprovalState(name, input, context.runtime, context.tuiContext);
    if (!verification.ok) {
      return diagnosticResult(name, verification.code, verification.message, {
        severity: "error",
        userAction: verification.userAction,
        detail: verification.detail
      });
    }
    return definition.execute(input, context);
  }
  let boundInput: Record<string, unknown>;
  try {
    boundInput = await bindAgentToolApprovalState(name, input, context.runtime, context.tuiContext);
  } catch (error) {
    return diagnosticResult(name, "AGENT_APPROVAL_STATE_UNAVAILABLE", "Manifest approval state could not be bound.", {
      severity: "error",
      userAction: "Inspect the manifest target, then request a fresh approval preview.",
      detail: error
    });
  }
  const result = await definition.execute(boundInput, context);
  if (result.status === "approval_required" && result.approval && boundInput !== input) {
    return {
      ...result,
      approval: { ...result.approval, arguments: boundInput }
    };
  }
  return result;
}

export type { AgentToolExecutionContext, RelaybaseAgentToolDefinition } from "./common.ts";
