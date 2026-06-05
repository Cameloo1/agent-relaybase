import { z } from "zod";
import { safeToolExecute, successResult, unavailableResult, type RelaybaseAgentToolDefinition } from "./common.ts";

const parameters = z
  .object({
    kind: z.enum([
      "focus_pane",
      "pin_pane",
      "unpin_pane",
      "change_pane_color",
      "show_route",
      "copy_route",
      "open_browser"
    ]),
    paneId: z.string().optional(),
    appId: z.string().optional(),
    groupId: z.string().optional(),
    componentRole: z.enum(["frontend", "backend", "worker", "database", "service", "other"]).optional(),
    route: z.string().optional(),
    color: z.string().optional(),
    reason: z.string().optional()
  })
  .strict();

export function createProposeTuiActionTool(): RelaybaseAgentToolDefinition<z.infer<typeof parameters>> {
  const definition: RelaybaseAgentToolDefinition<z.infer<typeof parameters>> = {
    name: "propose_tui_action",
    description:
      "Return a typed proposed TUI action for the Go TUI to apply. Do not mutate daemon state. Clipboard/browser actions must report unavailable when terminal support is missing.",
    parameters,
    approvalRequired: false,
    risk: "low",
    execute: (input, context) =>
      safeToolExecute(definition, input, async () => {
        if (input.kind === "copy_route" && context.tuiContext.terminalCapabilities?.clipboard !== "available") {
          return unavailableResult(
            definition.name,
            "AGENT_TUI_CLIPBOARD_UNAVAILABLE",
            "Clipboard copy is not available in this terminal session.",
            "Show the route as text instead."
          );
        }
        if (input.kind === "open_browser" && context.tuiContext.terminalCapabilities?.browserOpen !== "available") {
          return unavailableResult(
            definition.name,
            "AGENT_TUI_BROWSER_OPEN_UNAVAILABLE",
            "Browser open is not available in this terminal session.",
            "Show the route as text instead."
          );
        }
        const action = {
          kind: input.kind,
          target: {
            paneId: input.paneId ?? context.tuiContext.selectedPaneId,
            appId: input.appId ?? context.tuiContext.selectedAppId,
            groupId: input.groupId ?? context.tuiContext.selectedGroupId,
            componentRole: input.componentRole ?? context.tuiContext.selectedComponentRole
          },
          ...((input.route ?? context.tuiContext.currentRoute)
            ? { route: input.route ?? context.tuiContext.currentRoute }
            : {}),
          ...(input.color ? { color: input.color } : {}),
          requiresApproval: input.kind === "open_browser" || input.kind === "copy_route"
        };
        context.emit?.({ type: "tui.proposed_action", data: { action, reason: input.reason } });
        return successResult(definition.name, { action, reason: input.reason });
      })
  };
  return definition;
}
