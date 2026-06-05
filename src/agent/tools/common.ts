import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getAppState, getRelaybaseState } from "../../appState.ts";
import type { RelaybaseState } from "../../apiTypes.ts";
import type { RelaybaseRuntime } from "../../server.ts";
import type { AppComponentRole, AppRecord, AppState } from "../../types.ts";
import { sanitizeAgentPayload } from "../errors.ts";
import { loadOpenAIAgentsSdk } from "../openrouterProvider.ts";
import type { AgentRunEventType, AgentToolRisk, TuiAgentContext } from "../types.ts";

export const componentRoleSchema = z.enum(["frontend", "backend", "worker", "database", "service", "other"]);

export const confirmationContextSchema = z
  .object({
    reason: z.string().optional(),
    approvalId: z.string().optional()
  })
  .strict()
  .optional();

export interface AgentToolExecutionContext {
  runtime: RelaybaseRuntime;
  tuiContext: TuiAgentContext;
  approved?: boolean;
  correlationId?: string;
  emit?: (event: { type: AgentRunEventType; data: unknown }) => void;
}

export type AgentToolStatus =
  | "succeeded"
  | "approval_required"
  | "clarification_needed"
  | "diagnostic"
  | "unavailable"
  | "failed";

export interface AgentToolStructuredResult {
  tool: string;
  status: AgentToolStatus;
  data?: unknown;
  diagnostic?: {
    code: string;
    severity: "info" | "warning" | "error";
    message: string;
    userAction?: string;
    detail?: unknown;
  };
  approval?: {
    required: boolean;
    action: string;
    risk: AgentToolRisk;
    expectedResult: string;
    arguments: unknown;
  };
  operationId?: string;
  setupPlanId?: string;
  repairPlanId?: string;
  next?: {
    poll?: string;
    stream?: string;
    action?: string;
  };
}

export interface RelaybaseAgentToolDefinition<Input extends Record<string, unknown> = Record<string, unknown>> {
  name: string;
  description: string;
  parameters: z.ZodType<Input>;
  approvalRequired: boolean;
  risk: AgentToolRisk;
  execute(input: Input, context: AgentToolExecutionContext): Promise<AgentToolStructuredResult>;
}

export function createSdkTool(definition: RelaybaseAgentToolDefinition, context: AgentToolExecutionContext): unknown {
  const { tool } = loadOpenAIAgentsSdk();
  return tool({
    name: definition.name,
    description: definition.description,
    parameters: z.toJSONSchema(definition.parameters),
    strict: true,
    needsApproval: definition.approvalRequired,
    execute: async (input: Record<string, unknown>) =>
      sanitizeAgentPayload(
        await definition.execute(definition.parameters.parse(input), { ...context, approved: false })
      )
  });
}

export async function safeToolExecute<Input extends Record<string, unknown>>(
  definition: RelaybaseAgentToolDefinition<Input>,
  input: Input,
  callback: () => Promise<AgentToolStructuredResult>
): Promise<AgentToolStructuredResult> {
  try {
    return sanitizeToolResult(await callback());
  } catch (error) {
    return diagnosticResult(definition.name, "AGENT_TOOL_FAILED", "Agent tool failed.", {
      severity: "error",
      detail: error,
      userAction: "Inspect the daemon/tool diagnostics and retry with a more specific target."
    });
  }
}

export function sanitizeToolResult(result: AgentToolStructuredResult): AgentToolStructuredResult {
  return sanitizeAgentPayload(result);
}

export function successResult(
  tool: string,
  data: unknown,
  options: Pick<AgentToolStructuredResult, "operationId" | "setupPlanId" | "repairPlanId" | "next"> = {}
): AgentToolStructuredResult {
  return sanitizeToolResult({
    tool,
    status: "succeeded",
    data,
    ...options
  });
}

export function approvalRequiredResult(
  tool: string,
  input: unknown,
  options: { action: string; risk: AgentToolRisk; expectedResult: string }
): AgentToolStructuredResult {
  return sanitizeToolResult({
    tool,
    status: "approval_required",
    approval: {
      required: true,
      action: options.action,
      risk: options.risk,
      expectedResult: options.expectedResult,
      arguments: input
    },
    diagnostic: {
      code: "AGENT_TOOL_APPROVAL_REQUIRED",
      severity: "warning",
      message: `${options.action} requires explicit user approval.`,
      userAction: "Show the user the preview/risk and retry only through the approved execution path."
    }
  });
}

export function clarificationResult(tool: string, message: string, candidates: unknown[]): AgentToolStructuredResult {
  return sanitizeToolResult({
    tool,
    status: "clarification_needed",
    diagnostic: {
      code: "AGENT_TARGET_AMBIGUOUS",
      severity: "warning",
      message,
      userAction: "Ask the user to choose one exact app, group, component role, manifest path, or project path.",
      detail: { candidates }
    }
  });
}

export function diagnosticResult(
  tool: string,
  code: string,
  message: string,
  options: {
    severity?: "info" | "warning" | "error";
    userAction?: string;
    detail?: unknown;
    status?: AgentToolStatus;
  } = {}
): AgentToolStructuredResult {
  return sanitizeToolResult({
    tool,
    status: options.status ?? "diagnostic",
    diagnostic: {
      code,
      severity: options.severity ?? "warning",
      message,
      ...(options.userAction ? { userAction: options.userAction } : {}),
      ...(options.detail !== undefined ? { detail: options.detail } : {})
    }
  });
}

export function unavailableResult(
  tool: string,
  code: string,
  message: string,
  userAction: string
): AgentToolStructuredResult {
  return diagnosticResult(tool, code, message, {
    status: "unavailable",
    severity: "warning",
    userAction
  });
}

export function requireApproved(
  definition: RelaybaseAgentToolDefinition,
  input: unknown,
  context: AgentToolExecutionContext,
  expectedResult: string
): AgentToolStructuredResult | undefined {
  if (!definition.approvalRequired || context.approved === true) {
    return undefined;
  }
  return approvalRequiredResult(definition.name, input, {
    action: definition.name,
    risk: definition.risk,
    expectedResult
  });
}

export async function resolveAppTarget(
  runtime: RelaybaseRuntime,
  input: {
    appId?: string;
    appName?: string;
    groupId?: string;
    componentRole?: AppComponentRole;
    target?: string;
  },
  context: TuiAgentContext
): Promise<{ app: AppState; state: RelaybaseState } | AgentToolStructuredResult> {
  const state = await getRelaybaseState(runtime);
  const target = text(input.appId ?? input.target ?? input.appName);
  const role = input.componentRole;
  const groupId = text(input.groupId ?? context.selectedGroupId);

  if (target) {
    const exactApp = state.apps.find((app) => app.id === target);
    if (exactApp) {
      return { app: exactApp, state };
    }

    const normalized = normalizeLabel(target);
    const appMatches = state.apps.filter((app) => normalizeLabel(app.name) === normalized);
    const componentMatches = state.components
      .filter(
        (component) =>
          normalizeLabel(component.displayName) === normalized ||
          normalizeLabel(component.paneLabel) === normalized ||
          component.appId === target
      )
      .filter((component) => (role ? component.role === role : true));
    const appIds = new Set([
      ...appMatches.map((app) => app.id),
      ...componentMatches.map((component) => component.appId)
    ]);
    if (appIds.size === 1) {
      const appId = [...appIds][0]!;
      const app = state.apps.find((entry) => entry.id === appId) ?? (await getAppState(runtime, appId));
      return { app, state };
    }
    if (appIds.size > 1) {
      return clarificationResult(
        "target_resolution",
        `Target ${target} is ambiguous.`,
        [...appIds].map((appId) => ({ appId }))
      );
    }
    return diagnosticResult(
      "target_resolution",
      "AGENT_TARGET_NOT_FOUND",
      "No matching Relaybase app target was found.",
      {
        severity: "error",
        userAction: "Provide an exact app id, app display name, group id with component role, or select a pane first.",
        detail: { target, groupId, role }
      }
    );
  }

  if (groupId && role) {
    const components = state.components.filter((component) => component.groupId === groupId && component.role === role);
    if (components.length === 1) {
      const app =
        state.apps.find((entry) => entry.id === components[0]!.appId) ??
        (await getAppState(runtime, components[0]!.appId));
      return { app, state };
    }
    if (components.length > 1) {
      return clarificationResult(
        "target_resolution",
        `Group ${groupId} has multiple ${role} components.`,
        components.map((component) => ({ appId: component.appId, role: component.role, groupId: component.groupId }))
      );
    }
  }

  if (context.selectedAppId) {
    const app =
      state.apps.find((entry) => entry.id === context.selectedAppId) ??
      (await getAppState(runtime, context.selectedAppId));
    return { app, state };
  }

  return diagnosticResult(
    "target_resolution",
    "AGENT_TARGET_NOT_FOUND",
    "No matching Relaybase app target was found.",
    {
      severity: "error",
      userAction: "Provide an exact app id, app display name, group id with component role, or select a pane first.",
      detail: { target, groupId, role }
    }
  );
}

export async function resolveGroupTarget(
  runtime: RelaybaseRuntime,
  input: { groupId?: string; groupName?: string; target?: string },
  context: TuiAgentContext
): Promise<{ groupId: string; state: RelaybaseState } | AgentToolStructuredResult> {
  const state = await getRelaybaseState(runtime);
  const target = text(input.groupId ?? input.target ?? input.groupName ?? context.selectedGroupId);
  if (!target) {
    return diagnosticResult("target_resolution", "AGENT_GROUP_REQUIRED", "A group target is required.", {
      severity: "error",
      userAction: "Provide groupId/groupName or select a grouped pane first."
    });
  }

  const exact = state.groups.find((group) => group.groupId === target);
  if (exact) {
    return { groupId: exact.groupId, state };
  }

  const normalized = normalizeLabel(target);
  const matches = state.groups.filter((group) => normalizeLabel(group.displayName) === normalized);
  if (matches.length === 1) {
    return { groupId: matches[0]!.groupId, state };
  }
  if (matches.length > 1) {
    return clarificationResult(
      "target_resolution",
      `Group ${target} is ambiguous.`,
      matches.map((group) => ({ groupId: group.groupId, displayName: group.displayName }))
    );
  }

  return diagnosticResult("target_resolution", "AGENT_GROUP_NOT_FOUND", "No matching Relaybase group was found.", {
    severity: "error",
    userAction: "Refresh state and provide an exact group id.",
    detail: { target }
  });
}

export async function manifestPathForApp(runtime: RelaybaseRuntime, appId: string): Promise<string | undefined> {
  const app = (await runtime.registry.get(appId)) as AppRecord | undefined;
  return app?.manifestPath;
}

export function correlationId(context: AgentToolExecutionContext): string {
  return context.correlationId ?? `agent_tool_${randomUUID()}`;
}

export function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function normalizeLabel(value: string): string {
  return value.trim().toLowerCase();
}
