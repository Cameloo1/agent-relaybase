import { randomUUID } from "node:crypto";
import type { AgentApproval, AgentApprovalStatus, AgentToolRisk, TuiAgentContext } from "./types.ts";
import type { ThreadStore } from "./threadStore.ts";

export interface ApprovalCreateInput {
  sessionId: string;
  runId: string;
  toolCallId?: string;
  toolName: string;
  action: string;
  target?: string;
  risk: AgentToolRisk;
  expectedResult: string;
  arguments: Record<string, unknown>;
  argumentsHash: string;
  context: TuiAgentContext;
  preview?: AgentApproval["preview"];
  diagnostic?: AgentApproval["diagnostic"];
}

export interface ApprovalStoreOptions {
  threadStore?: ThreadStore;
}

export class ApprovalStore {
  #approvals = new Map<string, AgentApproval>();
  #rawArguments = new Map<string, Record<string, unknown>>();

  constructor(options: ApprovalStoreOptions = {}) {
    this.#threadStore = options.threadStore;
  }

  #threadStore?: ThreadStore;

  create(input: ApprovalCreateInput): AgentApproval {
    const id = randomUUID();
    const approval: AgentApproval = {
      id,
      sessionId: input.sessionId,
      runId: input.runId,
      ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
      toolName: input.toolName,
      status: "pending",
      createdAt: new Date().toISOString(),
      action: input.action,
      ...(input.target ? { target: input.target } : {}),
      risk: input.risk,
      expectedResult: input.expectedResult,
      arguments: input.arguments,
      argumentsHash: input.argumentsHash,
      context: input.context,
      ...(input.preview ? { preview: input.preview } : {}),
      ...(input.diagnostic ? { diagnostic: input.diagnostic } : {})
    };
    this.#approvals.set(id, approval);
    this.#rawArguments.set(id, structuredClone(input.arguments));
    return this.#threadStore?.upsertApproval(approval, input.arguments) ?? cloneApproval(approval);
  }

  get(approvalId: string): AgentApproval | undefined {
    const persisted = this.#threadStore?.getApproval(approvalId);
    if (persisted) {
      return persisted;
    }
    const approval = this.#approvals.get(approvalId);
    return approval ? cloneApproval(approval) : undefined;
  }

  update(approval: AgentApproval, rawArguments: Record<string, unknown> = approval.arguments): AgentApproval {
    this.#approvals.set(approval.id, cloneApproval(approval));
    this.#rawArguments.set(approval.id, structuredClone(rawArguments));
    return this.#threadStore?.upsertApproval(approval, rawArguments) ?? cloneApproval(approval);
  }

  rawArguments(approvalId: string): Record<string, unknown> | undefined {
    const persisted = this.#threadStore?.rawApprovalArguments(approvalId);
    if (persisted) {
      return persisted;
    }
    const args = this.#rawArguments.get(approvalId);
    return args ? structuredClone(args) : undefined;
  }

  resolve(
    approvalId: string,
    status: Extract<AgentApprovalStatus, "approved" | "rejected">
  ): AgentApproval | undefined {
    const persisted = this.#threadStore?.resolveApproval(approvalId, status);
    if (persisted) {
      const local = this.#approvals.get(approvalId);
      if (local) {
        local.status = status;
        local.resolvedAt = persisted.resolvedAt;
      }
      return persisted;
    }
    if (this.#threadStore) {
      return undefined;
    }
    const approval = this.#approvals.get(approvalId);
    if (!approval) {
      return undefined;
    }
    approval.status = status;
    approval.resolvedAt = new Date().toISOString();
    return cloneApproval(approval);
  }

  listPending(): AgentApproval[] {
    const persisted = this.#threadStore?.listPendingApprovals();
    if (persisted) {
      return persisted;
    }
    return [...this.#approvals.values()]
      .filter((approval) => approval.status === "pending" || approval.status === "recovered_pending")
      .map(cloneApproval);
  }

  recoverPending(): AgentApproval[] {
    const persisted = this.#threadStore?.recoverPendingApprovals();
    if (persisted) {
      return persisted;
    }
    return [];
  }
}

function cloneApproval(approval: AgentApproval): AgentApproval {
  return structuredClone(approval);
}
