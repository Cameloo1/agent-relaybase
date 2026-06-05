import { randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Registry } from "./registry.ts";
import { DEFAULT_HOST, DEFAULT_PORT, DEFAULT_PORT_RANGE_END, DEFAULT_PORT_RANGE_START } from "./state.ts";
import { ChildMcpSupervisor } from "./childMcp.ts";
import { checkAppHealth, waitForHealthy } from "./health.ts";
import { type DurableLogEvent, type LogStore, type LogStoreQuery, type LogStoreQueryResult } from "./logStore.ts";
import { canBindPort, isPortOpen } from "./ports.ts";
import { redactSecretLikeValues } from "./redaction.ts";
import type {
  AppRecord,
  AppStatusView,
  ChildMcpDrainResult,
  LifecycleAttempt,
  LifecycleHookAttempt,
  LifecycleHookName,
  LifecyclePhase,
  RuntimeStatus,
  RuntimeView,
  StopVerification
} from "./types.ts";

interface RuntimeEntry {
  status: RuntimeStatus;
  health: "unknown" | "healthy" | "unhealthy";
  phase: LifecyclePhase;
  child?: ChildProcessWithoutNullStreams;
  assignedPort?: number;
  pid?: number;
  startedAt?: string;
  stoppedAt?: string;
  lastError?: string;
  logs: string[];
  logEvents: AppLogEvent[];
  lastStartAttempt?: LifecycleAttempt;
  lastStopAttempt?: LifecycleAttempt;
  attemptHistory: LifecycleAttempt[];
  blockingReason?: string;
  cleanupStatus?: RuntimeView["cleanupStatus"];
  mcpDrain?: ChildMcpDrainResult[];
  stopVerification?: StopVerification;
}

interface SpawnSpec {
  command: string;
  args: string[];
  shell: boolean;
}

export type AppLogEvent = DurableLogEvent;

export interface AppLogStreamRotatedEvent {
  appId: string;
  droppedLogs: number;
  droppedEvents: number;
  retainedLogs: number;
  retainedEvents: number;
  at: string;
}

export interface ProcessManagerOptions {
  hubHost?: string;
  hubPort?: number;
  portRangeStart?: number;
  portRangeEnd?: number;
  stopPortOpenProbe?: (port: number, host: string) => Promise<boolean>;
  logStore?: LogStore;
}

export class ProcessManager {
  readonly registry: Registry;
  readonly hubHost: string;
  readonly hubPort: number;
  readonly portRangeStart: number;
  readonly portRangeEnd: number;
  readonly mcp: ChildMcpSupervisor;
  readonly stopPortOpenProbe: (port: number, host: string) => Promise<boolean>;
  readonly logStore?: LogStore;
  #runtime = new Map<string, RuntimeEntry>();
  #mutations = new Map<string, { action: "start" | "stop" | "restart"; promise: Promise<RuntimeView> }>();
  #portReservations = new Map<number, string>();
  #logSubscribers = new Set<(event: AppLogEvent) => void>();
  #logRotationSubscribers = new Set<(event: AppLogStreamRotatedEvent) => void>();
  #logSequence = 0;

  constructor(registry: Registry, options: ProcessManagerOptions = {}) {
    this.registry = registry;
    this.hubHost = options.hubHost ?? DEFAULT_HOST;
    this.hubPort = options.hubPort ?? DEFAULT_PORT;
    this.portRangeStart = options.portRangeStart ?? DEFAULT_PORT_RANGE_START;
    this.portRangeEnd = options.portRangeEnd ?? DEFAULT_PORT_RANGE_END;
    this.stopPortOpenProbe = options.stopPortOpenProbe ?? ((port, host) => isPortOpen(port, host));
    this.logStore = options.logStore;
    this.#logSequence = options.logStore?.lastSequence ?? 0;
    this.mcp = new ChildMcpSupervisor();
  }

  async start(id: string): Promise<RuntimeView> {
    const active = this.#mutations.get(id);
    if (active) {
      if (active.action === "start") {
        return active.promise;
      }

      const entry = this.#runtime.get(id) ?? this.#entry("stopped", "unknown");
      entry.blockingReason = `${active.action}_in_progress`;
      return this.#view(entry, id);
    }

    const promise = this.#startLocked(id).finally(() => {
      this.#mutations.delete(id);
    });
    this.#mutations.set(id, { action: "start", promise });
    return promise;
  }

  async #startLocked(id: string): Promise<RuntimeView> {
    const app = await this.registry.get(id);
    if (!app) {
      throw new Error(`Unknown app: ${id}`);
    }

    const existing = this.#runtime.get(id);
    if (existing?.child && existing.child.exitCode === null && existing.assignedPort) {
      existing.phase = "running";
      existing.status = "running";
      existing.health = "healthy";
      return this.#view(existing, id);
    }

    const assignedPort = await this.#assignPort(app);
    if (assignedPort === undefined) {
      const conflict = this.#entry(
        "conflict",
        "unhealthy",
        undefined,
        "Requested upstream port is already in use.",
        "conflict"
      );
      this.#runtime.set(id, conflict);
      return this.#view(conflict, id);
    }

    const entry = this.#entry("starting", "unknown", assignedPort, undefined, "prestarting");
    entry.cleanupStatus = "not_needed";
    const attempt = this.#startAttempt(app, assignedPort);
    entry.lastStartAttempt = attempt;
    this.#recordAttempt(entry, attempt);
    this.#runtime.set(id, entry);

    const env = this.#appEnv(app, assignedPort);
    if (app.preStartCommand) {
      const preStart = await this.#runHook(
        app,
        entry,
        "preStart",
        app.preStartCommand,
        app.preStartTimeoutMs ?? 120_000,
        env
      );
      attempt.hooks.push(preStart);
      if (preStart.status !== "succeeded") {
        const message = preStart.error ?? `preStartCommand failed with exit code ${preStart.exitCode ?? "unknown"}.`;
        entry.status = "errored";
        entry.health = "unhealthy";
        entry.phase = "errored";
        entry.lastError = message;
        this.#finishAttempt(attempt, "failed", entry.phase, message);
        return this.#view(entry, id);
      }
    }

    entry.phase = "launching";
    const spawnSpec = this.#spawnSpec(app.command);
    const child = spawn(spawnSpec.command, spawnSpec.args, {
      cwd: app.cwd,
      env,
      shell: spawnSpec.shell,
      windowsHide: true
    });

    entry.child = child;
    entry.pid = child.pid;
    entry.startedAt = new Date().toISOString();
    this.#appendLog(
      app.id,
      `[relaybase] starting ${app.id} on ${this.hubHost}:${assignedPort}`,
      "system",
      "system",
      app,
      env
    );
    await this.mcp.startApp(app);

    child.stdout.on("data", (chunk) => this.#appendLog(app.id, chunk.toString(), "stdout", "start", app, env));
    child.stderr.on("data", (chunk) => this.#appendLog(app.id, chunk.toString(), "stderr", "start", app, env));
    child.once("error", (error) => {
      entry.status = "errored";
      entry.health = "unhealthy";
      entry.phase = "errored";
      entry.lastError = error.message;
      this.#appendLog(app.id, `[relaybase] process error: ${error.message}`, "system", "system", app, env);
    });
    child.once("exit", (code, signal) => {
      if (entry.status !== "stopped" && entry.status !== "errored") {
        entry.status = code === 0 ? "stopped" : "errored";
        entry.phase = code === 0 ? "stopped" : "errored";
      }

      entry.health = "unhealthy";
      entry.stoppedAt = new Date().toISOString();
      if (entry.status !== "errored") {
        entry.lastError =
          code === 0 ? undefined : `Process exited with code ${code ?? "null"} signal ${signal ?? "null"}.`;
      }
      this.#appendLog(
        app.id,
        `[relaybase] exited code=${code ?? "null"} signal=${signal ?? "null"}`,
        "system",
        "system",
        app,
        env
      );
    });

    entry.phase = "waiting_for_health";
    const healthy = await waitForHealthy(
      app,
      assignedPort,
      this.hubHost,
      app.healthTimeoutMs ?? app.startTimeoutMs ?? 8000
    );
    if (child.exitCode !== null) {
      entry.status = "errored";
      entry.health = "unhealthy";
      entry.phase = "errored";
      entry.lastError ??= "Process exited before becoming healthy.";
      this.#finishAttempt(attempt, "failed", entry.phase, entry.lastError);
      await this.#cleanupAfterFailedStart(app, entry, child);
    } else if (healthy) {
      entry.status = "running";
      entry.health = "healthy";
      entry.phase = "running";
      entry.lastError = undefined;
      this.#finishAttempt(attempt, "succeeded", entry.phase);
    } else {
      entry.status = "errored";
      entry.health = "unhealthy";
      entry.phase = "errored";
      entry.lastError = "App did not become healthy before the startup timeout.";
      this.#finishAttempt(attempt, "failed", entry.phase, entry.lastError);
      await this.#cleanupAfterFailedStart(app, entry, child);
    }

    return this.#view(entry, id);
  }

  async stop(id: string): Promise<RuntimeView> {
    const active = this.#mutations.get(id);
    if (active) {
      if (active.action === "stop") {
        return active.promise;
      }

      const entry = this.#runtime.get(id) ?? this.#entry("stopped", "unknown");
      entry.blockingReason = `${active.action}_in_progress`;
      return this.#view(entry, id);
    }

    const promise = this.#stopLocked(id).finally(() => {
      this.#mutations.delete(id);
    });
    this.#mutations.set(id, { action: "stop", promise });
    return promise;
  }

  async #stopLocked(id: string): Promise<RuntimeView> {
    const app = await this.registry.get(id);
    const entry = this.#runtime.get(id);
    if (!app) {
      throw new Error(`Unknown app: ${id}`);
    }

    const stopped = entry ?? this.#entry("stopped", "unknown");
    const attempt = this.#stopAttempt(app, stopped.assignedPort);
    stopped.lastStopAttempt = attempt;
    this.#recordAttempt(stopped, attempt);

    if (!entry?.child || entry.child.exitCode !== null) {
      const assignedPort = stopped.assignedPort;
      stopped.status = "stopping";
      stopped.phase = "stopping";
      stopped.health = "unhealthy";
      stopped.cleanupStatus = app.stopCommand ? "pending" : "not_needed";
      this.#runtime.set(id, stopped);
      stopped.mcpDrain = await this.mcp.stopApp(id);
      return this.#finalizeStop(app, stopped, attempt, assignedPort);
    }

    const assignedPort = entry.assignedPort;
    entry.status = "stopping";
    entry.phase = "stopping";
    entry.health = "unhealthy";
    entry.cleanupStatus = app.stopCommand ? "pending" : "not_needed";
    this.#appendLog(id, "[relaybase] stopping", "system", "system", app);
    entry.mcpDrain = await this.mcp.stopApp(id);

    await this.#terminateChild(entry.child);
    entry.stoppedAt = new Date().toISOString();
    return this.#finalizeStop(app, entry, attempt, assignedPort);
  }

  async restart(id: string): Promise<RuntimeView> {
    const active = this.#mutations.get(id);
    if (active) {
      return active.promise;
    }

    const promise = (async () => {
      await this.#stopLocked(id);
      return this.#startLocked(id);
    })().finally(() => {
      this.#mutations.delete(id);
    });
    this.#mutations.set(id, { action: "restart", promise });
    return promise;
  }

  async logs(id: string, options: LogStoreQuery = {}): Promise<string[]> {
    if (this.logStore) {
      const result = await this.queryLogs({ ...options, appId: id });
      return result.events.map((event) => event.message);
    }
    const limit = options.limit ?? 500;
    const lines = [...(this.#runtime.get(id)?.logs ?? [])];
    return lines.slice(-limit);
  }

  async logEvents(id: string, options: LogStoreQuery = {}): Promise<AppLogEvent[]> {
    if (this.logStore) {
      return (await this.queryLogs({ ...options, appId: id })).events;
    }
    const limit = options.limit ?? 500;
    return [...(this.#runtime.get(id)?.logEvents ?? [])].slice(-limit);
  }

  async queryLogs(query: LogStoreQuery): Promise<LogStoreQueryResult> {
    if (this.logStore) {
      return this.logStore.query(query);
    }

    const appId = query.appId;
    const events = appId ? [...(this.#runtime.get(appId)?.logEvents ?? [])] : [];
    const filtered = events
      .filter((event) => (query.before === undefined ? true : event.sequence < query.before))
      .filter((event) => (query.after === undefined ? true : event.sequence > query.after))
      .slice(-(query.limit ?? 500));
    const oldestSequence = filtered[0]?.sequence;
    const newestSequence = filtered.at(-1)?.sequence;
    return {
      events: filtered,
      page: {
        limit: query.limit ?? 500,
        ...(query.before !== undefined ? { before: query.before } : {}),
        ...(query.after !== undefined ? { after: query.after } : {}),
        ...(oldestSequence !== undefined ? { oldestSequence } : {}),
        ...(newestSequence !== undefined ? { newestSequence } : {}),
        hasMore: events.length > filtered.length
      },
      diagnostics: []
    };
  }

  subscribeLogs(id: string, listener: (event: AppLogEvent) => void): () => void {
    const wrapped = (event: AppLogEvent) => {
      if (event.appId === id) {
        listener(event);
      }
    };
    this.#logSubscribers.add(wrapped);
    return () => {
      this.#logSubscribers.delete(wrapped);
    };
  }

  subscribeAllLogs(listener: (event: AppLogEvent) => void): () => void {
    this.#logSubscribers.add(listener);
    return () => {
      this.#logSubscribers.delete(listener);
    };
  }

  subscribeLogRotations(listener: (event: AppLogStreamRotatedEvent) => void): () => void {
    this.#logRotationSubscribers.add(listener);
    return () => {
      this.#logRotationSubscribers.delete(listener);
    };
  }

  async listStatuses(): Promise<AppStatusView[]> {
    const apps = await this.registry.list();
    const views: AppStatusView[] = [];

    for (const app of apps) {
      const runtime = this.#runtime.get(app.id);
      const view = runtime ? this.#view(runtime, app.id) : this.#view(this.#entry("stopped", "unknown"), app.id);
      if (!runtime && app.upstreamPort) {
        view.externalPortOpen = await isPortOpen(app.upstreamPort, this.hubHost);
        if (view.externalPortOpen) {
          view.status = "running";
          view.health =
            app.protocol === "tcp"
              ? "healthy"
              : (await checkAppHealth(app, app.upstreamPort, this.hubHost))
                ? "healthy"
                : "unhealthy";
          view.phase = "running";
          view.assignedPort = app.upstreamPort;
          view.canOpen = view.health === "healthy";
        }
      }

      views.push({ ...app, runtime: view });
    }

    return views;
  }

  async getProxyTarget(app: AppRecord): Promise<{ port: number; external: boolean } | undefined> {
    const runtime = this.#runtime.get(app.id);
    if (
      runtime?.assignedPort &&
      runtime.status !== "errored" &&
      runtime.status !== "conflict" &&
      runtime.status !== "stopped"
    ) {
      return { port: runtime.assignedPort, external: false };
    }

    if (app.upstreamPort && (await isPortOpen(app.upstreamPort, this.hubHost))) {
      return { port: app.upstreamPort, external: true };
    }

    return undefined;
  }

  async healthCheck(id: string): Promise<{ status: RuntimeView; reachable: boolean; checkedAt: string }> {
    const app = await this.registry.get(id);
    if (!app) {
      throw new Error(`Unknown app: ${id}`);
    }

    const statuses = await this.listStatuses();
    const status =
      statuses.find((entry) => entry.id === id)?.runtime ?? this.#view(this.#entry("stopped", "unknown"), id);
    const port = status.assignedPort ?? app.upstreamPort;
    const reachable =
      app.protocol === "tcp"
        ? Boolean(port && (await isPortOpen(port, this.hubHost)))
        : Boolean(port && (await checkAppHealth(app, port, this.hubHost)));

    return {
      status: {
        ...status,
        health: reachable ? "healthy" : "unhealthy"
      },
      reachable,
      checkedAt: new Date().toISOString()
    };
  }

  async #finalizeStop(
    app: AppRecord,
    entry: RuntimeEntry,
    attempt: LifecycleAttempt,
    assignedPort?: number
  ): Promise<RuntimeView> {
    const env = this.#appEnv(app, assignedPort ?? app.upstreamPort ?? 0);
    let stopHook: LifecycleHookAttempt | undefined;
    let verifyHook: LifecycleHookAttempt | undefined;
    let failureReason: string | undefined;

    if (app.stopCommand) {
      stopHook = await this.#runHook(app, entry, "stop", app.stopCommand, app.stopTimeoutMs ?? 60_000, env);
      attempt.hooks.push(stopHook);
      if (stopHook.status !== "succeeded") {
        entry.cleanupStatus = stopHook.timedOut ? "timeout" : "failed";
        failureReason = stopHook.error ?? `stopCommand failed with exit code ${stopHook.exitCode ?? "unknown"}.`;
      } else {
        entry.cleanupStatus = "succeeded";
      }
    } else {
      entry.cleanupStatus = "not_needed";
    }

    if (!failureReason && app.verifyStoppedCommand) {
      verifyHook = await this.#runHook(
        app,
        entry,
        "verifyStopped",
        app.verifyStoppedCommand,
        app.stopTimeoutMs ?? 60_000,
        env
      );
      attempt.hooks.push(verifyHook);
      if (verifyHook.status !== "succeeded") {
        entry.cleanupStatus = "verification_failed";
        failureReason =
          verifyHook.error ?? `verifyStoppedCommand failed with exit code ${verifyHook.exitCode ?? "unknown"}.`;
      }
    }

    const checkedAt = new Date().toISOString();
    const shouldCheckPort = Boolean(assignedPort && this.#ownsBackendPort(app, entry));
    let portStillOpen = shouldCheckPort && assignedPort ? !(await this.#waitForPortClosed(assignedPort, 3000)) : false;
    if (!failureReason && portStillOpen && assignedPort && process.platform === "win32" && !app.stopCommand) {
      this.#killPortOwner(assignedPort);
      portStillOpen = !(await this.#waitForPortClosed(assignedPort, 3000));
    }
    if (!failureReason && portStillOpen && assignedPort) {
      entry.cleanupStatus = "verification_failed";
      failureReason = `Stop requested, but backend port ${assignedPort} is still open.`;
    }

    entry.stopVerification = {
      attempted: true,
      checkedAt,
      ...(assignedPort ? { backendPort: assignedPort } : {}),
      backendPortOpen: shouldCheckPort && assignedPort ? portStillOpen : null,
      portClosureVerified: Boolean(shouldCheckPort && assignedPort && !portStillOpen),
      ok: !failureReason,
      ...(failureReason ? { failureReason } : {}),
      ...(entry.cleanupStatus ? { cleanupStatus: entry.cleanupStatus } : {}),
      ...(stopHook ? { stopCommand: stopHook } : {}),
      ...(verifyHook ? { verifyStoppedCommand: verifyHook } : {}),
      ...(entry.mcpDrain?.length ? { mcpDrain: entry.mcpDrain } : {})
    };

    entry.stoppedAt = new Date().toISOString();
    if (failureReason) {
      entry.status = "errored";
      entry.health = "unhealthy";
      entry.phase = entry.cleanupStatus === "verification_failed" ? "stop_verification_failed" : "cleanup_failed";
      entry.lastError = failureReason;
      this.#finishAttempt(attempt, "failed", entry.phase, failureReason);
      this.#appendLog(app.id, `[relaybase] stop failed: ${failureReason}`, "system", "system", app, env);
      return this.#view(entry, app.id);
    }

    entry.status = "stopped";
    entry.health = "unknown";
    entry.phase = "stopped";
    if (entry.assignedPort) {
      this.#releasePortReservation(app.id, entry.assignedPort);
    }
    entry.assignedPort = undefined;
    entry.pid = undefined;
    entry.lastError = undefined;
    entry.blockingReason = undefined;
    this.#finishAttempt(attempt, "succeeded", entry.phase);
    this.#appendLog(app.id, "[relaybase] stopped", "system", "system", app, env);
    return this.#view(entry, app.id);
  }

  async #cleanupAfterFailedStart(
    app: AppRecord,
    entry: RuntimeEntry,
    child: ChildProcessWithoutNullStreams
  ): Promise<void> {
    entry.mcpDrain = await this.mcp.stopApp(app.id);
    await this.#terminateChild(child);
    entry.pid = undefined;
    entry.stoppedAt = new Date().toISOString();
    if (!app.stopCommand) {
      entry.cleanupStatus = "not_needed";
      if (entry.assignedPort && (await this.#waitForPortClosed(entry.assignedPort, 3000))) {
        this.#releasePortReservation(app.id, entry.assignedPort);
        entry.assignedPort = undefined;
      }
      return;
    }

    entry.cleanupStatus = "pending";
    const hook = await this.#runHook(
      app,
      entry,
      "stop",
      app.stopCommand,
      app.stopTimeoutMs ?? 60_000,
      this.#appEnv(app, entry.assignedPort ?? 0)
    );
    entry.lastStartAttempt?.hooks.push(hook);
    entry.cleanupStatus = hook.status === "succeeded" ? "succeeded" : hook.timedOut ? "timeout" : "failed";
    if (hook.status !== "succeeded") {
      entry.lastError = `${entry.lastError} Cleanup also failed: ${hook.error ?? `stopCommand exited ${hook.exitCode ?? "unknown"}`}`;
      return;
    }

    if (entry.assignedPort && (await this.#waitForPortClosed(entry.assignedPort, 3000))) {
      this.#releasePortReservation(app.id, entry.assignedPort);
      entry.assignedPort = undefined;
    } else if (entry.assignedPort) {
      entry.cleanupStatus = "verification_failed";
      entry.lastError = `${entry.lastError} Cleanup ran, but backend port ${entry.assignedPort} is still open.`;
    }
  }

  async #runHook(
    app: AppRecord,
    entry: RuntimeEntry,
    name: LifecycleHookName,
    command: string,
    timeoutMs: number,
    env: NodeJS.ProcessEnv
  ): Promise<LifecycleHookAttempt> {
    const hook: LifecycleHookAttempt = {
      name,
      command,
      status: "running",
      startedAt: new Date().toISOString(),
      stdout: [],
      stderr: []
    };
    const spec = this.#spawnSpec(command);

    await new Promise<void>((resolve) => {
      const child = spawn(spec.command, spec.args, {
        cwd: app.cwd,
        env,
        shell: spec.shell,
        windowsHide: true
      });
      let settled = false;
      const timer = setTimeout(() => {
        hook.timedOut = true;
        hook.error = `${name} hook timed out after ${timeoutMs}ms.`;
        this.#terminateChild(child);
      }, timeoutMs);

      child.stdout.on("data", (chunk) => {
        const text = this.#redact(chunk.toString(), env);
        hook.stdout?.push(...this.#lines(text));
        this.#appendLog(app.id, chunk.toString(), "stdout", name, app, env);
      });
      child.stderr.on("data", (chunk) => {
        const text = this.#redact(chunk.toString(), env);
        hook.stderr?.push(...this.#lines(text));
        this.#appendLog(app.id, chunk.toString(), "stderr", name, app, env);
      });
      child.once("error", (error) => {
        hook.error = error.message;
      });
      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        hook.exitCode = code;
        hook.signal = signal;
        hook.endedAt = new Date().toISOString();
        hook.status = code === 0 && !hook.timedOut && !hook.error ? "succeeded" : "failed";
        hook.error ??=
          hook.status === "failed"
            ? `${name} hook exited with code ${code ?? "null"} signal ${signal ?? "null"}.`
            : undefined;
        resolve();
      };
      child.once("exit", finish);
      child.once("close", finish);
    });

    return hook;
  }

  #entry(
    status: RuntimeStatus,
    health: "unknown" | "healthy" | "unhealthy",
    assignedPort?: number,
    lastError?: string,
    phase?: LifecyclePhase
  ): RuntimeEntry {
    return {
      status,
      health,
      phase:
        phase ??
        (status === "running"
          ? "running"
          : status === "stopped"
            ? "stopped"
            : status === "conflict"
              ? "conflict"
              : status === "starting"
                ? "launching"
                : status === "stopping"
                  ? "stopping"
                  : "errored"),
      ...(assignedPort ? { assignedPort } : {}),
      ...(lastError ? { lastError } : {}),
      logs: [],
      logEvents: [],
      attemptHistory: []
    };
  }

  #startAttempt(app: AppRecord, assignedPort: number): LifecycleAttempt {
    return {
      id: randomUUID(),
      kind: "start",
      status: "running",
      phase: "prestarting",
      startedAt: new Date().toISOString(),
      assignedPort,
      command: app.command,
      hooks: []
    };
  }

  #stopAttempt(app: AppRecord, assignedPort?: number): LifecycleAttempt {
    return {
      id: randomUUID(),
      kind: "stop",
      status: "running",
      phase: "stopping",
      startedAt: new Date().toISOString(),
      ...(assignedPort ? { assignedPort } : {}),
      command: app.stopCommand,
      hooks: []
    };
  }

  #recordAttempt(entry: RuntimeEntry, attempt: LifecycleAttempt): void {
    entry.attemptHistory.push(attempt);
    if (entry.attemptHistory.length > 20) {
      entry.attemptHistory.splice(0, entry.attemptHistory.length - 20);
    }
  }

  #finishAttempt(
    attempt: LifecycleAttempt,
    status: LifecycleAttempt["status"],
    phase: LifecyclePhase,
    error?: string
  ): void {
    attempt.status = status;
    attempt.phase = phase;
    attempt.endedAt = new Date().toISOString();
    if (error) {
      attempt.error = error;
    }
  }

  #appEnv(app: AppRecord, assignedPort: number): NodeJS.ProcessEnv {
    return {
      ...process.env,
      ...app.env,
      ...(assignedPort ? { PORT: String(assignedPort) } : {}),
      HOST: this.hubHost,
      RELAYBASE_APP_ID: app.id,
      RELAYBASE_BASE_URL: `http://${app.id}.localhost:${this.hubPort}`
    };
  }

  #ownsBackendPort(app: AppRecord, entry: RuntimeEntry): boolean {
    if (app.command === "external" && !entry.child) {
      return false;
    }

    return Boolean(entry.assignedPort);
  }

  #redact(text: string, env: NodeJS.ProcessEnv): string {
    return redactSecretLikeValues(text, env).value;
  }

  #lines(text: string): string[] {
    return text.split(/\r?\n/).filter(Boolean);
  }

  async #assignPort(app: AppRecord): Promise<number | undefined> {
    this.#releaseAppPortReservations(app.id);

    if (app.upstreamPort) {
      if (this.#isPortReserved(app.upstreamPort, app.id)) {
        return undefined;
      }
      const bindable = await isPortOpen(app.upstreamPort, this.hubHost).then((open) => !open);
      if (!bindable) {
        return undefined;
      }
      this.#reservePort(app.id, app.upstreamPort);
      return app.upstreamPort;
    }

    for (let port = this.portRangeStart; port <= this.portRangeEnd; port += 1) {
      if (this.#isPortReserved(port, app.id)) {
        continue;
      }
      if (await canBindPort(port, this.hubHost)) {
        this.#reservePort(app.id, port);
        return port;
      }
    }

    throw new Error(`No available ports in range ${this.portRangeStart}-${this.portRangeEnd}.`);
  }

  #reservePort(appId: string, port: number): void {
    this.#portReservations.set(port, appId);
  }

  #releasePortReservation(appId: string, port: number): void {
    if (this.#portReservations.get(port) === appId) {
      this.#portReservations.delete(port);
    }
  }

  #releaseAppPortReservations(appId: string): void {
    for (const [port, owner] of this.#portReservations) {
      if (owner === appId) {
        this.#portReservations.delete(port);
      }
    }
  }

  #isPortReserved(port: number, appId: string): boolean {
    const owner = this.#portReservations.get(port);
    return Boolean(owner && owner !== appId);
  }

  #spawnSpec(command: string): SpawnSpec {
    const tokens = this.#splitCommand(command);
    if (!tokens.length || /[&|<>]/.test(command)) {
      return { command, args: [], shell: true };
    }

    const executable = tokens[0];
    if (process.platform === "win32" && /\.ps1$/i.test(executable)) {
      return {
        command: "powershell.exe",
        args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", executable, ...tokens.slice(1)],
        shell: false
      };
    }

    if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(executable)) {
      return { command, args: [], shell: true };
    }

    return {
      command: executable,
      args: tokens.slice(1),
      shell: false
    };
  }

  #splitCommand(command: string): string[] {
    const tokens: string[] = [];
    const pattern = /"([^"]*)"|'([^']*)'|([^\s]+)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(command))) {
      tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
    }
    return tokens;
  }

  async #terminateChild(child: ChildProcessWithoutNullStreams): Promise<boolean> {
    const exited = new Promise<boolean>((resolve) => {
      if (child.exitCode !== null) {
        resolve(true);
        return;
      }
      const timer = setTimeout(() => {
        child.off("exit", onExit);
        resolve(false);
      }, 5000);
      const onExit = () => {
        clearTimeout(timer);
        resolve(true);
      };
      child.once("exit", onExit);
    });

    if (process.platform === "win32" && child.pid) {
      const result = spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true
      });
      if (result.status !== 0) {
        try {
          child.kill("SIGTERM");
        } catch {
          // The process may have already exited; the wait below will settle either way.
        }
      }
    } else {
      try {
        child.kill("SIGTERM");
      } catch {
        // The process may have already exited; the wait below will settle either way.
      }
    }

    const didExit = await exited;
    child.stdout.destroy();
    child.stderr.destroy();
    child.stdin.destroy();
    return didExit;
  }

  async #waitForPortClosed(port: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(await this.stopPortOpenProbe(port, this.hubHost))) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return !(await this.stopPortOpenProbe(port, this.hubHost));
  }

  #killPortOwner(port: number): void {
    const result = spawnSync("netstat", ["-ano", "-p", "tcp"], {
      encoding: "utf8",
      windowsHide: true
    });
    if (result.status !== 0 || !result.stdout) {
      return;
    }

    const pids = new Set<string>();
    for (const line of result.stdout.split(/\r?\n/)) {
      const columns = line.trim().split(/\s+/);
      if (columns.length < 5 || columns[0].toUpperCase() !== "TCP") {
        continue;
      }
      const localAddress = columns[1];
      const state = columns[3]?.toUpperCase();
      const pid = columns[4];
      if (state !== "LISTENING" || pid === String(process.pid)) {
        continue;
      }
      if (localAddress.endsWith(`:${port}`) || localAddress.endsWith(`]:${port}`)) {
        pids.add(pid);
      }
    }

    for (const pid of pids) {
      spawnSync("taskkill", ["/pid", pid, "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true
      });
    }
  }

  #appendLog(
    id: string,
    text: string,
    stream: AppLogEvent["stream"] = "system",
    source: AppLogEvent["source"] = "system",
    app?: AppRecord,
    env?: NodeJS.ProcessEnv
  ): void {
    const entry = this.#runtime.get(id);
    if (!entry) {
      return;
    }

    for (const line of text.split(/\r?\n/)) {
      if (!line) {
        continue;
      }

      const redaction = redactSecretLikeValues(line, env);
      const safeLine = redaction.value;
      entry.logs.push(safeLine);
      const timestamp = new Date().toISOString();
      const event: AppLogEvent = {
        sequence: ++this.#logSequence,
        timestamp,
        at: timestamp,
        appId: id,
        groupId: app?.relaybase?.groupId ?? id,
        componentRole: app?.relaybase?.componentRole ?? "other",
        line: safeLine,
        message: safeLine,
        stream,
        source,
        level: stream === "stderr" ? "error" : "info",
        redacted: redaction.redacted
      };
      entry.logEvents.push(event);
      if (this.logStore) {
        void this.logStore
          .append({
            sequence: event.sequence,
            timestamp: event.timestamp,
            appId: event.appId,
            groupId: event.groupId,
            componentRole: event.componentRole,
            stream: event.stream,
            source: event.source,
            level: event.level,
            message: line,
            redacted: event.redacted,
            env
          })
          .catch(() => undefined);
      }
      for (const subscriber of this.#logSubscribers) {
        try {
          subscriber(event);
        } catch {
          // Log subscribers are observers; app output should never be blocked by a broken stream.
        }
      }
    }

    const droppedLogs = entry.logs.length > 500 ? entry.logs.length - 500 : 0;
    if (droppedLogs) {
      entry.logs.splice(0, droppedLogs);
    }

    const droppedEvents = entry.logEvents.length > 500 ? entry.logEvents.length - 500 : 0;
    if (droppedEvents) {
      entry.logEvents.splice(0, droppedEvents);
    }

    if (droppedLogs || droppedEvents) {
      const rotation: AppLogStreamRotatedEvent = {
        appId: id,
        droppedLogs,
        droppedEvents,
        retainedLogs: entry.logs.length,
        retainedEvents: entry.logEvents.length,
        at: new Date().toISOString()
      };
      for (const subscriber of this.#logRotationSubscribers) {
        try {
          subscriber(rotation);
        } catch {
          // Rotation subscribers are observers; log retention must not block on them.
        }
      }
    }
  }

  #view(entry: RuntimeEntry, appId?: string): RuntimeView {
    const mcpChildren = appId ? this.mcp.statusForApp(appId) : [];
    const actionState = this.#actionState(entry);
    return {
      status: entry.status,
      health: entry.health,
      phase: entry.phase,
      ...(entry.pid ? { pid: entry.pid } : {}),
      ...(entry.assignedPort ? { assignedPort: entry.assignedPort } : {}),
      ...(entry.startedAt ? { startedAt: entry.startedAt } : {}),
      ...(entry.stoppedAt ? { stoppedAt: entry.stoppedAt } : {}),
      ...(entry.lastError ? { lastError: entry.lastError } : {}),
      logLines: entry.logs.length,
      ...actionState,
      ...(entry.cleanupStatus ? { cleanupStatus: entry.cleanupStatus } : {}),
      ...(entry.lastStartAttempt ? { lastStartAttempt: entry.lastStartAttempt } : {}),
      ...(entry.lastStopAttempt ? { lastStopAttempt: entry.lastStopAttempt } : {}),
      ...(entry.attemptHistory.length ? { attemptHistory: [...entry.attemptHistory] } : {}),
      ...(mcpChildren.length ? { mcpChildren } : {}),
      ...(entry.mcpDrain?.length ? { mcpDrain: entry.mcpDrain } : {}),
      ...(entry.stopVerification ? { stopVerification: entry.stopVerification } : {})
    };
  }

  #actionState(
    entry: RuntimeEntry
  ): Pick<RuntimeView, "canStart" | "canStop" | "canOpen" | "primaryAction" | "blockingReason"> {
    if (entry.blockingReason) {
      return {
        canStart: false,
        canStop: false,
        canOpen: false,
        primaryAction: "wait",
        blockingReason: entry.blockingReason
      };
    }

    if (entry.status === "running" && entry.health === "healthy") {
      return {
        canStart: false,
        canStop: true,
        canOpen: true,
        primaryAction: "open"
      };
    }

    if (entry.status === "starting" || entry.status === "stopping") {
      return {
        canStart: false,
        canStop: entry.status === "starting",
        canOpen: false,
        primaryAction: "wait",
        blockingReason: `${entry.phase}_in_progress`
      };
    }

    if (entry.status === "errored" || entry.status === "conflict") {
      return {
        canStart: true,
        canStop: Boolean(entry.assignedPort),
        canOpen: false,
        primaryAction: "repair",
        ...(entry.lastError ? { blockingReason: entry.lastError } : {})
      };
    }

    return {
      canStart: true,
      canStop: false,
      canOpen: false,
      primaryAction: "start"
    };
  }
}
