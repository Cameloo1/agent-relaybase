import { getRelaybaseState } from "../appState.ts";
import type { RelaybaseRuntime } from "../server.ts";
import type { RelaybaseState } from "../apiTypes.ts";
import { sanitizeAgentPayload } from "./errors.ts";
import type { AgentDiagnostic, AgentThreadContextPreview, TuiAgentContext } from "./types.ts";

export interface OperatorPromptContext {
  generatedAt: string;
  tuiCapturedAt?: string;
  selected: {
    paneId?: string;
    appId?: string;
    groupId?: string;
    componentRole?: string;
    currentRoute?: string;
    currentPage?: number;
  };
  currentCwd?: string;
  daemonHasZeroApps: boolean;
  setup?: {
    wizardState?: string;
    planId?: string;
  };
  terminalCapabilities?: TuiAgentContext["terminalCapabilities"];
  thread?: AgentThreadContextPreview;
  diagnostics: AgentDiagnostic[];
  state: {
    apps: Array<{
      id: string;
      name: string;
      runtime: string;
      readiness: string;
      routeReachable: boolean;
      lastError?: string | null;
    }>;
    groups: Array<{
      groupId: string;
      displayName: string;
      aggregateStatus: string;
      componentCount: number;
    }>;
    components: Array<{
      appId: string;
      groupId: string;
      role: string;
      label: string;
      status: string;
      route?: string;
      port?: number;
      lastError?: string | null;
    }>;
  };
}

export async function buildOperatorPromptContext(
  runtime: RelaybaseRuntime,
  context: TuiAgentContext,
  thread?: AgentThreadContextPreview
): Promise<OperatorPromptContext> {
  const state = await safeRelaybaseState(runtime);
  const promptContext: OperatorPromptContext = {
    generatedAt: new Date().toISOString(),
    ...(context.capturedAt ? { tuiCapturedAt: context.capturedAt } : {}),
    selected: {
      ...(context.selectedPaneId ? { paneId: context.selectedPaneId } : {}),
      ...(context.selectedAppId ? { appId: context.selectedAppId } : {}),
      ...(context.selectedGroupId ? { groupId: context.selectedGroupId } : {}),
      ...(context.selectedComponentRole ? { componentRole: context.selectedComponentRole } : {}),
      ...(context.currentRoute ? { currentRoute: context.currentRoute } : {}),
      ...(Number.isInteger(context.currentPage) ? { currentPage: context.currentPage } : {})
    },
    ...(context.currentCwd ? { currentCwd: context.currentCwd } : {}),
    daemonHasZeroApps: context.daemonHasZeroApps || state.apps.length === 0,
    ...(context.setupWizardState || context.currentSetupPlanId
      ? {
          setup: {
            ...(context.setupWizardState ? { wizardState: context.setupWizardState } : {}),
            ...(context.currentSetupPlanId ? { planId: context.currentSetupPlanId } : {})
          }
        }
      : {}),
    ...(context.terminalCapabilities ? { terminalCapabilities: context.terminalCapabilities } : {}),
    ...(thread ? { thread } : {}),
    diagnostics: context.diagnostics.map((diagnostic, index) => ({
      id: "code" in diagnostic ? diagnostic.id : `tui.diagnostic.${index}`,
      severity: diagnostic.severity,
      code: "code" in diagnostic ? diagnostic.code : "TUI_DIAGNOSTIC",
      message: diagnostic.message,
      checkedAt: diagnostic.checkedAt,
      ...(diagnostic.userAction ? { userAction: diagnostic.userAction } : {}),
      ...(diagnostic.detail ? { detail: diagnostic.detail } : {})
    })),
    state: {
      apps: state.apps.slice(0, 20).map((app) => ({
        id: app.id,
        name: app.name,
        runtime: app.runtime.status,
        readiness: app.readiness.state,
        routeReachable: app.routeReachable,
        lastError: app.lastError ?? null
      })),
      groups: state.groups.slice(0, 20).map((group) => ({
        groupId: group.groupId,
        displayName: group.displayName,
        aggregateStatus: group.aggregateStatus,
        componentCount: group.components.length
      })),
      components: state.components.slice(0, 40).map((component) => ({
        appId: component.appId,
        groupId: component.groupId,
        role: component.role,
        label: component.paneLabel,
        status: component.status,
        ...(component.route.humanUrl ? { route: component.route.humanUrl } : {}),
        ...(component.port ? { port: component.port } : {}),
        lastError: component.lastError ?? null
      }))
    }
  };

  return sanitizeAgentPayload(promptContext);
}

async function safeRelaybaseState(runtime: RelaybaseRuntime): Promise<RelaybaseState> {
  try {
    return await getRelaybaseState(runtime);
  } catch (error) {
    return {
      apps: [],
      groups: [],
      components: [],
      diagnostics: [
        {
          id: "agent.context.state_snapshot_failed",
          severity: "warning",
          message: "Relaybase state snapshot failed while building agent context.",
          checkedAt: new Date().toISOString(),
          detail: sanitizeAgentPayload(error)
        }
      ],
      generatedAt: new Date().toISOString()
    };
  }
}
