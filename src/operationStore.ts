import { randomUUID } from "node:crypto";
import { createRelaybaseError } from "./apiErrors.ts";
import type { LifecycleOperation, LifecycleOperationType, OperationStatus } from "./apiTypes.ts";

type TerminalOperationStatus = Extract<OperationStatus, "succeeded" | "failed" | "timed_out" | "cancelled">;

export interface OperationRunContext {
  addProgress(message: string, progress?: number, phase?: string): void;
}

export interface OperationOutcome {
  status: TerminalOperationStatus;
  message?: string;
  code?: string;
  retryable?: boolean;
  userAction?: string;
  detail?: unknown;
}

export interface EnqueueLifecycleOperationInput<Result> {
  operationType: LifecycleOperationType;
  targetId: string;
  correlationId: string;
  run(context: OperationRunContext): Promise<Result>;
  evaluate(result: Result): OperationOutcome;
}

export interface OperationHandle {
  operationId: string;
  operation: LifecycleOperation;
  done: Promise<LifecycleOperation>;
  created: boolean;
  deduplicated: boolean;
}

interface ActiveOperation {
  operationId: string;
  operationType: LifecycleOperationType;
  done: Promise<LifecycleOperation>;
}

export class OperationConflictError extends Error {
  readonly activeOperation: LifecycleOperation;

  constructor(activeOperation: LifecycleOperation) {
    super(
      `Lifecycle operation ${activeOperation.operationId} (${activeOperation.operationType}) is already active for app ${activeOperation.appId ?? activeOperation.target.id}.`
    );
    this.activeOperation = snapshotOperation(activeOperation);
  }
}

export class OperationStore {
  readonly retentionLimit: number;
  #operations = new Map<string, LifecycleOperation>();
  #activeByTarget = new Map<string, ActiveOperation>();
  #subscribers = new Set<(operation: LifecycleOperation) => void>();

  constructor(options: { retentionLimit?: number } = {}) {
    this.retentionLimit = options.retentionLimit ?? 500;
  }

  enqueueLifecycle<Result>(input: EnqueueLifecycleOperationInput<Result>): OperationHandle {
    const active = this.#activeByTarget.get(input.targetId);
    if (active) {
      const operation = this.#requiredOperation(active.operationId);
      if (active.operationType === input.operationType) {
        this.#addProgress(operation, `Deduplicated duplicate ${input.operationType} request.`, operation.progress);
        return {
          operationId: operation.operationId,
          operation: snapshotOperation(operation),
          done: active.done,
          created: false,
          deduplicated: true
        };
      }

      throw new OperationConflictError(operation);
    }

    const operationId = `op_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const operation: LifecycleOperation = {
      id: operationId,
      operationId,
      kind: input.operationType,
      operationType: input.operationType,
      target: { type: "app", id: input.targetId },
      appId: input.targetId,
      owner: "api",
      status: "queued",
      createdAt,
      updatedAt: createdAt,
      progress: 0,
      message: `Queued ${input.operationType} for app ${input.targetId}.`,
      messages: [`Queued ${input.operationType} for app ${input.targetId}.`],
      events: [
        {
          at: createdAt,
          phase: "queued",
          progress: 0,
          message: `Queued ${input.operationType} for app ${input.targetId}.`
        }
      ],
      canAbort: false,
      canRetry: false
    };

    const done = Promise.resolve()
      .then(() => this.#runLifecycleOperation(operation, input))
      .finally(() => {
        const activeOperation = this.#activeByTarget.get(input.targetId);
        if (activeOperation?.operationId === operationId) {
          this.#activeByTarget.delete(input.targetId);
        }
        this.#prune();
      });

    this.#operations.set(operationId, operation);
    this.#activeByTarget.set(input.targetId, {
      operationId,
      operationType: input.operationType,
      done
    });
    this.#emit(operation);

    return {
      operationId,
      operation: snapshotOperation(operation),
      done,
      created: true,
      deduplicated: false
    };
  }

  get(operationId: string): LifecycleOperation | undefined {
    const operation = this.#operations.get(operationId);
    return operation ? snapshotOperation(operation) : undefined;
  }

  subscribe(listener: (operation: LifecycleOperation) => void): () => void {
    this.#subscribers.add(listener);
    return () => {
      this.#subscribers.delete(listener);
    };
  }

  async #runLifecycleOperation<Result>(
    operation: LifecycleOperation,
    input: EnqueueLifecycleOperationInput<Result>
  ): Promise<LifecycleOperation> {
    this.#start(operation);
    const context: OperationRunContext = {
      addProgress: (message, progress, phase) => this.#addProgress(operation, message, progress, phase)
    };

    try {
      const result = await input.run(context);
      operation.result = result;
      const outcome = input.evaluate(result);
      this.#finish(operation, input, outcome, result);
    } catch (error) {
      this.#finish(operation, input, {
        status: "failed",
        code: "LIFECYCLE_OPERATION_FAILED",
        message: error instanceof Error ? error.message : "Lifecycle operation failed.",
        retryable: true,
        userAction: "Inspect the app manifest, daemon logs, and app logs before retrying.",
        detail: {
          operationId: operation.operationId,
          operationType: operation.operationType,
          targetId: input.targetId
        }
      });
    }

    return snapshotOperation(operation);
  }

  #start(operation: LifecycleOperation): void {
    const now = new Date().toISOString();
    operation.status = "running";
    operation.startedAt = now;
    operation.updatedAt = now;
    operation.progress = 10;
    operation.message = `Running ${operation.operationType} for app ${operation.appId ?? operation.target.id}.`;
    this.#addProgress(operation, operation.message, operation.progress, "running");
  }

  #finish<Result>(
    operation: LifecycleOperation,
    input: EnqueueLifecycleOperationInput<Result>,
    outcome: OperationOutcome,
    result?: Result
  ): void {
    const now = new Date().toISOString();
    operation.status = outcome.status;
    operation.finishedAt = now;
    operation.endedAt = now;
    operation.updatedAt = now;
    operation.progress = outcome.status === "succeeded" ? 100 : operation.progress;
    operation.message = outcome.message ?? defaultTerminalMessage(operation, outcome.status);
    operation.retryable = outcome.retryable;

    if (outcome.status !== "succeeded") {
      operation.error = createRelaybaseError({
        code: outcome.code ?? (outcome.status === "timed_out" ? "LIFECYCLE_TIMED_OUT" : "LIFECYCLE_OPERATION_FAILED"),
        message: operation.message,
        retryable: outcome.retryable ?? true,
        userAction: outcome.userAction ?? "Inspect the app logs and retry the lifecycle operation.",
        correlationId: input.correlationId,
        detail: outcome.detail ?? {
          operationId: operation.operationId,
          operationType: operation.operationType,
          targetId: input.targetId,
          result
        }
      });
    }

    this.#addProgress(operation, operation.message, operation.progress, outcome.status);
  }

  #addProgress(operation: LifecycleOperation, message: string, progress?: number, phase?: string): void {
    const now = new Date().toISOString();
    operation.updatedAt = now;
    operation.message = message;
    if (progress !== undefined) {
      operation.progress = progress;
    }
    operation.messages = [...(operation.messages ?? []), message];
    operation.events = [
      ...(operation.events ?? []),
      {
        at: now,
        message,
        ...(phase ? { phase } : {}),
        ...(operation.progress !== undefined ? { progress: operation.progress } : {})
      }
    ];
    this.#emit(operation);
  }

  #emit(operation: LifecycleOperation): void {
    const snapshot = snapshotOperation(operation);
    for (const subscriber of this.#subscribers) {
      try {
        subscriber(snapshot);
      } catch {
        // Operation event subscribers are observers; they must not block lifecycle work.
      }
    }
  }

  #requiredOperation(operationId: string): LifecycleOperation {
    const operation = this.#operations.get(operationId);
    if (!operation) {
      throw new Error(`Operation ${operationId} is active but missing from the operation store.`);
    }
    return operation;
  }

  #prune(): void {
    if (this.#operations.size <= this.retentionLimit) {
      return;
    }

    const activeIds = new Set([...this.#activeByTarget.values()].map((operation) => operation.operationId));
    for (const [operationId, operation] of this.#operations) {
      if (this.#operations.size <= this.retentionLimit) {
        return;
      }
      if (activeIds.has(operationId) || operation.status === "queued" || operation.status === "running") {
        continue;
      }
      this.#operations.delete(operationId);
    }
  }
}

function defaultTerminalMessage(operation: LifecycleOperation, status: TerminalOperationStatus): string {
  if (status === "succeeded") {
    return `Succeeded ${operation.operationType} for app ${operation.appId ?? operation.target.id}.`;
  }

  if (status === "timed_out") {
    return `Timed out ${operation.operationType} for app ${operation.appId ?? operation.target.id}.`;
  }

  return `Failed ${operation.operationType} for app ${operation.appId ?? operation.target.id}.`;
}

function snapshotOperation(operation: LifecycleOperation): LifecycleOperation {
  return {
    ...operation,
    target: { ...operation.target },
    messages: operation.messages ? [...operation.messages] : undefined,
    events: operation.events ? operation.events.map((event) => ({ ...event })) : undefined,
    error: operation.error ? { ...operation.error } : undefined
  };
}
