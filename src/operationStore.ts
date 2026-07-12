import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createRelaybaseError } from "./apiErrors.ts";
import type { LifecycleOperation, LifecycleOperationType, OperationStatus } from "./apiTypes.ts";
import { redactValueForExport } from "./redaction.ts";

type TerminalOperationStatus = Extract<OperationStatus, "succeeded" | "failed" | "timed_out" | "cancelled">;

export interface OperationRunContext {
  readonly signal: AbortSignal;
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
  controller: AbortController;
  done: Promise<LifecycleOperation>;
}

export interface OperationListOptions {
  statuses?: readonly OperationStatus[];
  operationType?: LifecycleOperationType;
  targetId?: string;
  retryableOnly?: boolean;
  limit?: number;
}

export interface OperationStoreShutdownResult {
  drained: boolean;
  activeOperationCount: number;
  interruptedOperationIds: string[];
  timeoutMs: number;
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

export class OperationStoreClosedError extends Error {
  constructor() {
    super("Lifecycle operation store is shutting down and is not accepting new work.");
  }
}

export class OperationStoreShutdownTimeoutError extends Error {
  readonly operationIds: string[];

  constructor(operationIds: string[]) {
    super(`Lifecycle operation shutdown could not settle ${operationIds.length} active operation(s) safely.`);
    this.operationIds = [...operationIds];
  }
}

export class OperationStore {
  readonly retentionLimit: number;
  #operations = new Map<string, LifecycleOperation>();
  #activeByTarget = new Map<string, ActiveOperation>();
  #subscribers = new Set<(operation: LifecycleOperation) => void>();
  #db?: DatabaseSync;
  #accepting = true;
  #closed = false;
  #shutdownFinalized = new Set<string>();
  #shutdownPromise?: Promise<OperationStoreShutdownResult>;
  #shutdownResult?: OperationStoreShutdownResult;

  constructor(options: { retentionLimit?: number; stateDir?: string } = {}) {
    this.retentionLimit = options.retentionLimit ?? 500;
    if (options.stateDir) {
      const operationDir = path.join(options.stateDir, "operations");
      fs.mkdirSync(operationDir, { recursive: true });
      this.#db = new DatabaseSync(path.join(operationDir, "operations.sqlite"));
      this.#db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS lifecycle_operations (
          operation_id TEXT PRIMARY KEY,
          target_id TEXT NOT NULL,
          operation_type TEXT NOT NULL,
          status TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS lifecycle_operations_updated_idx
          ON lifecycle_operations(updated_at);
      `);
      this.#loadPersisted();
      this.#reconcileInterrupted();
      this.#prune();
    }
  }

  enqueueLifecycle<Result>(input: EnqueueLifecycleOperationInput<Result>): OperationHandle {
    if (!this.#accepting || this.#closed) {
      throw new OperationStoreClosedError();
    }
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

    const controller = new AbortController();
    const done = Promise.resolve()
      .then(() => this.#runLifecycleOperation(operation, input, controller.signal))
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
      controller,
      done
    });
    this.#persist(operation);
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

  list(options: OperationListOptions = {}): LifecycleOperation[] {
    const statuses = options.statuses?.length ? new Set(options.statuses) : undefined;
    const targetId = options.targetId?.trim();
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    return [...this.#operations.values()]
      .filter((operation) => (statuses ? statuses.has(operation.status) : true))
      .filter((operation) => (options.operationType ? operation.operationType === options.operationType : true))
      .filter((operation) => (targetId ? (operation.appId ?? operation.target.id) === targetId : true))
      .filter((operation) =>
        options.retryableOnly ? operation.canRetry === true || operation.retryable === true : true
      )
      .sort((left, right) => {
        const updated = String(right.updatedAt ?? right.createdAt).localeCompare(
          String(left.updatedAt ?? left.createdAt)
        );
        return updated || right.operationId.localeCompare(left.operationId);
      })
      .slice(0, limit)
      .map(snapshotOperation);
  }

  subscribe(listener: (operation: LifecycleOperation) => void): () => void {
    this.#subscribers.add(listener);
    return () => {
      this.#subscribers.delete(listener);
    };
  }

  async shutdown(options: { timeoutMs?: number } = {}): Promise<OperationStoreShutdownResult> {
    if (this.#shutdownPromise) {
      return this.#shutdownPromise;
    }
    if (this.#shutdownResult) {
      return this.#shutdownResult;
    }
    const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 2_000, 0), 30_000);
    this.#accepting = false;
    this.#shutdownPromise = this.#shutdown(timeoutMs);
    try {
      this.#shutdownResult = await this.#shutdownPromise;
      return this.#shutdownResult;
    } finally {
      this.#shutdownPromise = undefined;
    }
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#accepting = false;
    const activeOperationCount = this.#activeByTarget.size;
    if (activeOperationCount > 0) {
      const operationIds = [...this.#activeByTarget.values()].map((operation) => operation.operationId);
      for (const active of this.#activeByTarget.values()) {
        active.controller.abort("operation_store_closed");
      }
      this.#failActiveForShutdown();
      throw new OperationStoreShutdownTimeoutError(operationIds);
    }
    const interruptedOperationIds = this.#failActiveForShutdown();
    this.#closed = true;
    this.#db?.close();
    this.#db = undefined;
    this.#shutdownResult = {
      drained: activeOperationCount === 0,
      activeOperationCount,
      interruptedOperationIds,
      timeoutMs: 0
    };
  }

  async #shutdown(timeoutMs: number): Promise<OperationStoreShutdownResult> {
    const active = [...this.#activeByTarget.values()];
    let drained = active.length === 0;
    if (active.length > 0 && timeoutMs > 0) {
      let timeout: NodeJS.Timeout | undefined;
      const timedOut = new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      });
      drained = await Promise.race([Promise.allSettled(active.map((entry) => entry.done)).then(() => true), timedOut]);
      if (timeout) {
        clearTimeout(timeout);
      }
    }
    let interruptedOperationIds: string[] = [];
    if (!drained) {
      for (const operation of active) {
        operation.controller.abort("daemon_shutdown");
      }
      interruptedOperationIds = this.#failActiveForShutdown();
      const abortTimeoutMs = Math.min(Math.max(timeoutMs * 5, 2_000), 10_000);
      const settledAfterAbort = await this.#waitForActive(active, abortTimeoutMs);
      if (!settledAfterAbort) {
        throw new OperationStoreShutdownTimeoutError(
          [...this.#activeByTarget.values()].map((operation) => operation.operationId)
        );
      }
    }
    this.#closed = true;
    this.#db?.close();
    this.#db = undefined;
    return {
      drained,
      activeOperationCount: active.length,
      interruptedOperationIds,
      timeoutMs
    };
  }

  async #runLifecycleOperation<Result>(
    operation: LifecycleOperation,
    input: EnqueueLifecycleOperationInput<Result>,
    signal: AbortSignal
  ): Promise<LifecycleOperation> {
    this.#start(operation);
    const context: OperationRunContext = {
      signal,
      addProgress: (message, progress, phase) => this.#addProgress(operation, message, progress, phase)
    };

    try {
      const result = await input.run(context);
      if (this.#shutdownFinalized.has(operation.operationId)) {
        return snapshotOperation(operation);
      }
      operation.result = result;
      const outcome = input.evaluate(result);
      this.#finish(operation, input, outcome, result);
    } catch (error) {
      if (this.#shutdownFinalized.has(operation.operationId)) {
        return snapshotOperation(operation);
      }
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

  async #waitForActive(active: ActiveOperation[], timeoutMs: number): Promise<boolean> {
    if (active.length === 0) {
      return true;
    }
    if (timeoutMs === 0) {
      return false;
    }
    let timeout: NodeJS.Timeout | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), timeoutMs);
    });
    const settled = await Promise.race([
      Promise.allSettled(active.map((entry) => entry.done)).then(() => true),
      timedOut
    ]);
    if (timeout) {
      clearTimeout(timeout);
    }
    return settled;
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
    if (this.#shutdownFinalized.has(operation.operationId)) {
      return;
    }
    const now = new Date().toISOString();
    operation.status = outcome.status;
    operation.finishedAt = now;
    operation.endedAt = now;
    operation.updatedAt = now;
    operation.progress = outcome.status === "succeeded" ? 100 : operation.progress;
    operation.message = outcome.message ?? defaultTerminalMessage(operation, outcome.status);
    operation.retryable = outcome.retryable;
    operation.canAbort = false;
    operation.canRetry = outcome.status !== "succeeded" && (outcome.retryable ?? true);

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
    if (this.#closed || this.#shutdownFinalized.has(operation.operationId)) {
      return;
    }
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
    this.#persist(operation);
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
      this.#db?.prepare("DELETE FROM lifecycle_operations WHERE operation_id = ?").run(operationId);
    }
  }

  #loadPersisted(): void {
    if (!this.#db) {
      return;
    }
    const rows = this.#db
      .prepare("SELECT operation_id, payload_json FROM lifecycle_operations ORDER BY updated_at ASC")
      .all() as Array<{ operation_id: string; payload_json: string }>;
    for (const row of rows) {
      let operation: LifecycleOperation;
      try {
        operation = JSON.parse(String(row.payload_json)) as LifecycleOperation;
      } catch (error) {
        throw new Error(`Lifecycle operation ledger row ${String(row.operation_id)} is invalid JSON.`, {
          cause: error
        });
      }
      if (!operation.operationId || operation.operationId !== String(row.operation_id) || !operation.status) {
        throw new Error(`Lifecycle operation ledger row ${String(row.operation_id)} is structurally invalid.`);
      }
      this.#operations.set(operation.operationId, operation);
    }
  }

  #reconcileInterrupted(): void {
    const now = new Date().toISOString();
    for (const operation of this.#operations.values()) {
      if (operation.status !== "queued" && operation.status !== "running") {
        continue;
      }
      const previousStatus = operation.status;
      operation.status = "failed";
      operation.updatedAt = now;
      operation.finishedAt = now;
      operation.endedAt = now;
      operation.retryable = true;
      operation.canAbort = false;
      operation.canRetry = true;
      operation.message = `Daemon restarted while ${operation.operationType} was ${previousStatus}; completion could not be confirmed.`;
      operation.messages = [...(operation.messages ?? []), operation.message];
      operation.events = [
        ...(operation.events ?? []),
        {
          at: now,
          phase: "recovered_interrupted",
          progress: operation.progress,
          message: operation.message
        }
      ];
      operation.error = createRelaybaseError({
        code: "LIFECYCLE_OPERATION_INTERRUPTED",
        message: operation.message,
        retryable: true,
        userAction: "Inspect the app process, port, route, and logs, then retry the lifecycle action.",
        correlationId: `recovered:${operation.operationId}`,
        detail: {
          operationId: operation.operationId,
          operationType: operation.operationType,
          targetId: operation.appId ?? operation.target.id,
          previousStatus
        }
      });
      this.#persist(operation);
    }
  }

  #failActiveForShutdown(): string[] {
    const interruptedOperationIds: string[] = [];
    const now = new Date().toISOString();
    for (const active of this.#activeByTarget.values()) {
      const operation = this.#operations.get(active.operationId);
      if (!operation || (operation.status !== "queued" && operation.status !== "running")) {
        continue;
      }
      const previousStatus = operation.status;
      this.#shutdownFinalized.add(operation.operationId);
      operation.status = "failed";
      operation.updatedAt = now;
      operation.finishedAt = now;
      operation.endedAt = now;
      operation.retryable = true;
      operation.canAbort = false;
      operation.canRetry = true;
      operation.message = `Daemon shutdown interrupted ${operation.operationType} while it was ${previousStatus}; completion could not be confirmed.`;
      operation.messages = [...(operation.messages ?? []), operation.message];
      operation.events = [
        ...(operation.events ?? []),
        {
          at: now,
          phase: "shutdown_interrupted",
          progress: operation.progress,
          message: operation.message
        }
      ];
      operation.error = createRelaybaseError({
        code: "LIFECYCLE_OPERATION_SHUTDOWN",
        message: operation.message,
        retryable: true,
        userAction: "Inspect the app process, port, route, and logs after restart, then retry the lifecycle action.",
        correlationId: `shutdown:${operation.operationId}`,
        detail: {
          operationId: operation.operationId,
          operationType: operation.operationType,
          targetId: operation.appId ?? operation.target.id,
          previousStatus
        }
      });
      this.#persist(operation);
      this.#emit(operation);
      interruptedOperationIds.push(operation.operationId);
    }
    return interruptedOperationIds;
  }

  #persist(operation: LifecycleOperation): void {
    if (!this.#db || this.#closed) {
      return;
    }
    const persisted = redactValueForExport(snapshotOperation(operation)).value as LifecycleOperation;
    this.#db
      .prepare(
        `
        INSERT INTO lifecycle_operations (
          operation_id, target_id, operation_type, status, payload_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(operation_id) DO UPDATE SET
          target_id = excluded.target_id,
          operation_type = excluded.operation_type,
          status = excluded.status,
          payload_json = excluded.payload_json,
          updated_at = excluded.updated_at
      `
      )
      .run(
        operation.operationId,
        operation.appId ?? operation.target.id,
        operation.operationType,
        operation.status,
        JSON.stringify(persisted),
        operation.updatedAt ?? new Date().toISOString()
      );
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
