import { randomUUID } from "node:crypto";
import { sanitizeAgentPayload } from "./errors.ts";
import type { AgentRunEvent, AgentRunEventType } from "./types.ts";

export type AgentOutputKind =
  | "answer"
  | "action_preview"
  | "approval_required"
  | "setup_plan_preview"
  | "file_write_preview"
  | "repair_choices"
  | "prove_result"
  | "action_result"
  | "diagnostic"
  | "clarification_needed"
  | "blocked";

export interface AgentOutputPayload {
  kind: AgentOutputKind;
  content?: string;
  data?: unknown;
}

export interface AgentRuntimeEvent {
  type: AgentRunEventType;
  data: unknown;
}

export function createAgentRunEvent(input: {
  sequence: number;
  sessionId: string;
  runId?: string;
  type: AgentRunEventType;
  data: unknown;
  knownSecrets?: string[];
}): AgentRunEvent {
  return {
    id: randomUUID(),
    sequence: input.sequence,
    sessionId: input.sessionId,
    ...(input.runId ? { runId: input.runId } : {}),
    type: input.type,
    at: new Date().toISOString(),
    data: sanitizeAgentPayload(input.data, input.knownSecrets)
  };
}

export function outputKindToEventType(kind: AgentOutputKind): AgentRunEventType {
  return kind;
}
