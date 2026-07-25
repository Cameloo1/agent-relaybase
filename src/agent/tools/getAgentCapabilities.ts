import { z } from "zod";
import { safeToolExecute, successResult, type RelaybaseAgentToolDefinition } from "./common.ts";

const parameters = z.object({}).strict();

export function createGetAgentCapabilitiesTool(): RelaybaseAgentToolDefinition<z.infer<typeof parameters>> {
  const definition: RelaybaseAgentToolDefinition<z.infer<typeof parameters>> = {
    name: "get_agent_capabilities",
    description:
      "Read the Operator Agent's effective tool policy, project grants, terminal capabilities, daemon feature support, and safe subsystem health without revealing secrets.",
    parameters,
    approvalRequired: false,
    risk: "low",
    execute: (input, context) =>
      safeToolExecute(definition, input, async () => {
        const terminal = context.tuiContext.terminalCapabilities;
        const configuredTools = context.config?.toolAllowlist ?? [];
        const registeredTools = [...(context.registeredToolNames ?? configuredTools)];
        const effectiveTools =
          context.config?.toolAllowlistMode === "explicit_allowlist" ? configuredTools : registeredTools;
        const effectiveSet = new Set(effectiveTools);
        const registeredSet = new Set(registeredTools);
        const logHealth = context.runtime.logStore.health();
        return successResult(definition.name, {
          agent: {
            enabled: context.config?.enabled ?? true,
            approvalPolicy: context.config?.approvalPolicy ?? "always_for_mutations",
            registeredToolCount: registeredTools.length,
            effectiveToolCount: effectiveTools.filter((name) => registeredSet.has(name)).length,
            registeredTools,
            allowedTools: effectiveTools,
            disabledTools: registeredTools.filter((name) => !effectiveSet.has(name)),
            unknownConfiguredTools: configuredTools.filter((name) => !registeredSet.has(name)),
            toolAllowlistMode: context.config?.toolAllowlistMode ?? "all_registered",
            browserOpenConfigured: context.config?.allowBrowserOpen ?? false,
            copyRouteConfigured: context.config?.allowCopyRoute ?? false
          },
          terminal: {
            clipboard: terminal?.clipboard ?? "unknown",
            clipboardReason:
              terminal?.clipboard === "available"
                ? "TUI clipboard writer initialized."
                : "TUI clipboard writer is unavailable or unverified.",
            browserOpen: terminal?.browserOpen ?? "unknown",
            browserOpenReason:
              terminal?.browserOpen === "available"
                ? "TUI browser opening is available."
                : "TUI browser opening is unavailable or unverified.",
            colorDepth: terminal?.colorDepth ?? "unknown"
          },
          authorization: {
            daemonSession: "authenticated",
            projectGrants: (context.projectRootGrants ?? []).map((grant) => ({
              grantId: grant.grantId,
              source: grant.source,
              root: grant.canonicalRoot
            }))
          },
          features: {
            operationPolling: true,
            setupPreview: true,
            repairPreview: true,
            lifecycleApproval: true,
            packageManagement: true,
            durableLogs: true,
            appExplanation: true,
            projectRootDiscovery: true
          },
          logStore: { status: logHealth.status, diagnostics: logHealth.diagnostics }
        });
      })
  };
  return definition;
}
