import { sanitizeErrorDetail } from "./apiErrors.ts";
import type { DaemonEvent, DaemonEventType, LifecycleOperation } from "./apiTypes.ts";
import type { AppLogEvent, AppLogStreamRotatedEvent } from "./processManager.ts";
import type { AppComponent, AppGroup, AppRecord, AppState } from "./types.ts";

interface PublishDaemonEventInput {
  type: DaemonEventType;
  appId?: string;
  operationId?: string;
  correlationId?: string;
  data?: unknown;
}

export class DaemonEventBus {
  #sequence = 0;
  #subscribers = new Set<(event: DaemonEvent) => void>();

  get subscriberCount(): number {
    return this.#subscribers.size;
  }

  create(input: PublishDaemonEventInput): DaemonEvent {
    const sequence = ++this.#sequence;
    const event: DaemonEvent = {
      id: String(sequence),
      sequence,
      type: input.type,
      at: new Date().toISOString()
    };

    if (input.appId) {
      event.appId = input.appId;
    }

    if (input.operationId) {
      event.operationId = input.operationId;
    }

    if (input.correlationId) {
      event.correlationId = input.correlationId;
    }

    if (input.data !== undefined) {
      event.data = sanitizeErrorDetail(input.data);
    }

    return event;
  }

  publish(input: PublishDaemonEventInput): DaemonEvent {
    const event = this.create(input);
    for (const subscriber of this.#subscribers) {
      try {
        subscriber(event);
      } catch {
        // Event subscribers are observers; daemon work must not block on a broken stream.
      }
    }
    return event;
  }

  subscribe(listener: (event: DaemonEvent) => void): () => void {
    this.#subscribers.add(listener);
    return () => {
      this.#subscribers.delete(listener);
    };
  }
}

export function lifecycleOperationEventType(operation: LifecycleOperation): DaemonEventType {
  if (operation.status === "succeeded") {
    return "app.lifecycle_operation_completed";
  }

  if (operation.status === "failed" || operation.status === "timed_out" || operation.status === "cancelled") {
    return "app.lifecycle_operation_failed";
  }

  const latestPhase = operation.events?.at(-1)?.phase;
  if (operation.status === "running" && latestPhase === "running") {
    return "app.lifecycle_operation_started";
  }

  return "app.lifecycle_operation_progress";
}

export function lifecycleOperationEventData(operation: LifecycleOperation): Record<string, unknown> {
  return {
    operation: {
      id: operation.id,
      operationId: operation.operationId,
      kind: operation.kind,
      operationType: operation.operationType,
      target: operation.target,
      status: operation.status,
      appId: operation.appId,
      owner: operation.owner,
      createdAt: operation.createdAt,
      startedAt: operation.startedAt,
      updatedAt: operation.updatedAt,
      finishedAt: operation.finishedAt,
      progress: operation.progress,
      message: operation.message,
      messages: operation.messages,
      events: operation.events,
      retryable: operation.retryable,
      canRetry: operation.canRetry,
      canAbort: operation.canAbort,
      error: operation.error
    }
  };
}

export function appStateEventData(
  state: AppState,
  operationId?: string,
  context: { component?: AppComponent; group?: AppGroup } = {}
): Record<string, unknown> {
  const { recentLogs: _recentLogs, ...safeState } = state;
  return {
    operationId,
    state: {
      ...safeState,
      recentLogCount: state.recentLogs.length
    },
    ...(context.component ? { component: context.component } : {}),
    ...(context.group ? { group: context.group } : {})
  };
}

export function appRecordEventData(app: AppRecord): Record<string, unknown> {
  return {
    app: {
      id: app.id,
      name: app.name,
      protocol: app.protocol,
      cwd: app.cwd,
      healthUrl: app.healthUrl,
      upstreamPort: app.upstreamPort,
      manifestPath: app.manifestPath,
      createdAt: app.createdAt,
      updatedAt: app.updatedAt,
      envVarCount: Object.keys(app.env).length,
      mcpEnabled: app.mcp?.enabled === true,
      ...(app.relaybase ? { relaybase: app.relaybase } : {}),
      ...(app.manifestDiagnostics?.length ? { manifestDiagnostics: app.manifestDiagnostics } : {})
    }
  };
}

export function routeHealthEventData(state: AppState, operationId?: string): Record<string, unknown> {
  return {
    operationId,
    route: {
      appId: state.id,
      routeReachable: state.routeReachable,
      routeHealth: state.routeHealth,
      readiness: state.readiness
    }
  };
}

export function logLineEventData(log: AppLogEvent): Record<string, unknown> {
  return {
    log: {
      appId: log.appId,
      groupId: log.groupId,
      componentRole: log.componentRole,
      stream: log.stream,
      source: log.source,
      sequence: log.sequence,
      at: log.at
    }
  };
}

export function logRotationEventData(rotation: AppLogStreamRotatedEvent): Record<string, unknown> {
  return { rotation };
}
