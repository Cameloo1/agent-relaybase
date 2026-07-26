import { createHash } from "node:crypto";
import type { AgentApproval, AgentMessage, AgentRun, AgentSession } from "./types.ts";

const ACTIVE_RUN_STATUSES = new Set<AgentRun["status"]>(["queued", "running", "waiting_for_approval"]);
const RETRYABLE_RUN_STATUSES = new Set<AgentRun["status"]>(["failed", "cancelled"]);

export interface WorkflowApprovalContinuation {
  toolName: string;
  arguments: Record<string, unknown>;
}

export function activeRunForSession(session: AgentSession): AgentRun | undefined {
  return [...session.runs].reverse().find((run) => ACTIVE_RUN_STATUSES.has(run.status));
}

export function retryableRun(run: AgentRun): boolean {
  return RETRYABLE_RUN_STATUSES.has(run.status);
}

export function idempotentMessageId(sessionId: string, idempotencyKey: string): string {
  const digest = createHash("sha256").update(sessionId).update("\0").update(idempotencyKey).digest("hex");
  return `agent_message_idempotent_${digest}`;
}

export function originalUserMessage(session: AgentSession, runId: string): AgentMessage | undefined {
  return session.messages.find((message) => message.runId === runId && message.role === "user");
}

export function workflowContinuationForApprovedTool(
  toolName: string,
  result: unknown,
  approval: AgentApproval
): WorkflowApprovalContinuation | undefined {
  if (!toolSucceeded(result)) {
    return undefined;
  }

  const data = recordValue(recordValue(result)?.data);
  if (!data) {
    return undefined;
  }

  if (toolName === "setup_and_start_project") {
    const declaredNext = approvalContinuation(data.next);
    if (declaredNext) {
      return declaredNext;
    }
    if (textValue(data, "phase") === "started") {
      const appId = textValue(data, "appId") ?? textValue(approval.arguments, "appId");
      if (appId) {
        return {
          toolName: "prove_app_health",
          arguments: compactRecord({
            appId,
            cwd: textValue(approval.arguments, "cwd") ?? approval.context?.currentCwd,
            lifecycleProof: false,
            reason: "Continue the approved setup workflow with a health proof."
          })
        };
      }
    }
    return undefined;
  }

  if (toolName === "apply_setup_plan") {
    const registeredApp = recordValue(data.registeredApp);
    const appId = textValue(registeredApp, "id");
    if (appId) {
      return startRegisteredContinuation(appId, textValue(data, "cwd") ?? approval.context?.currentCwd);
    }
  }

  if (toolName === "register_manifest") {
    const app = recordValue(data.app);
    const appId = textValue(app, "id");
    if (appId) {
      return startRegisteredContinuation(appId, textValue(approval.arguments, "cwd") ?? approval.context?.currentCwd);
    }
  }

  return undefined;
}

function startRegisteredContinuation(appId: string, cwd?: string): WorkflowApprovalContinuation {
  return {
    toolName: "setup_and_start_project",
    arguments: compactRecord({
      phase: "start_registered",
      appId,
      cwd,
      reason: "Continue the approved setup workflow by starting the registered app."
    })
  };
}

function approvalContinuation(value: unknown): WorkflowApprovalContinuation | undefined {
  const next = recordValue(value);
  const toolName = textValue(next, "tool");
  const input = recordValue(next?.input);
  if (!toolName || !input || next?.approvalRequired !== true) {
    return undefined;
  }
  return { toolName, arguments: input };
}

function toolSucceeded(result: unknown): boolean {
  return textValue(recordValue(result), "status") === "succeeded";
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function textValue(value: unknown, key: string): string | undefined {
  const record = recordValue(value);
  const nested = record?.[key];
  return typeof nested === "string" && nested.trim() ? nested.trim() : undefined;
}

function compactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, nested]) => nested !== undefined));
}
