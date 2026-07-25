import { getRelaybaseState } from "../appState.ts";
import type { RelaybaseRuntime } from "../server.ts";
import type { TuiAgentContext } from "./types.ts";

export async function resolveAuthoritativeAgentContext(runtime: RelaybaseRuntime, context: TuiAgentContext) {
  const state = await getRelaybaseState(runtime);
  const app = context.selectedAppId ? state.apps.find((entry) => entry.id === context.selectedAppId) : undefined;
  const group = context.selectedGroupId
    ? state.groups.find((entry) => entry.groupId === context.selectedGroupId)
    : app
      ? state.groups.find((entry) => entry.components.some((component) => component.appId === app.id))
      : undefined;
  const components = group
    ? group.components.filter((component) =>
        context.selectedComponentRole ? component.role === context.selectedComponentRole : true
      )
    : [];
  const selectionState =
    context.selectedAppId && !app
      ? "stale"
      : context.selectedGroupId && !group
        ? "stale"
        : context.selectedComponentRole && components.length > 1
          ? "ambiguous"
          : context.selectedAppId || context.selectedGroupId
            ? "current"
            : "none";

  return {
    resolvedAt: new Date().toISOString(),
    inventoryGeneratedAt: state.generatedAt,
    tuiCapturedAt: context.capturedAt,
    selectionState,
    selection: {
      paneId: context.selectedPaneId,
      appId: app?.id,
      groupId: group?.groupId,
      componentRole: context.selectedComponentRole,
      currentRoute: app?.humanUrl ?? context.currentRoute,
      currentPage: context.currentPage
    },
    origin: app
      ? {
          appId: app.id,
          projectDirectory: app.cwd,
          manifestPath: app.manifestPath,
          registered: app.registered
        }
      : undefined,
    app,
    group,
    components,
    staleReasons: [
      ...(context.selectedAppId && !app ? [`Selected app ${context.selectedAppId} is no longer registered.`] : []),
      ...(context.selectedGroupId && !group ? [`Selected group ${context.selectedGroupId} is no longer present.`] : [])
    ],
    daemonHasZeroApps: state.apps.length === 0,
    currentCwd: context.currentCwd,
    setup: {
      wizardState: context.setupWizardState,
      planId: context.currentSetupPlanId
    }
  };
}
