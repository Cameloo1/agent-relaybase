import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Registry } from "./registry.ts";
import { DEFAULT_HOST, DEFAULT_PORT, DEFAULT_PORT_RANGE_END, DEFAULT_PORT_RANGE_START } from "./state.ts";
import { ChildMcpSupervisor } from "./childMcp.ts";
import { checkAppHealth, waitForHealthy } from "./health.ts";
import { findAvailablePort, isPortOpen } from "./ports.ts";
import type { AppRecord, AppStatusView, ChildMcpDrainResult, RuntimeStatus, RuntimeView } from "./types.ts";

interface RuntimeEntry {
  status: RuntimeStatus;
  health: "unknown" | "healthy" | "unhealthy";
  child?: ChildProcessWithoutNullStreams;
  assignedPort?: number;
  pid?: number;
  startedAt?: string;
  stoppedAt?: string;
  lastError?: string;
  logs: string[];
  mcpDrain?: ChildMcpDrainResult[];
}

export interface ProcessManagerOptions {
  hubHost?: string;
  hubPort?: number;
  portRangeStart?: number;
  portRangeEnd?: number;
}

export class ProcessManager {
  readonly registry: Registry;
  readonly hubHost: string;
  readonly hubPort: number;
  readonly portRangeStart: number;
  readonly portRangeEnd: number;
  readonly mcp: ChildMcpSupervisor;
  #runtime = new Map<string, RuntimeEntry>();

  constructor(registry: Registry, options: ProcessManagerOptions = {}) {
    this.registry = registry;
    this.hubHost = options.hubHost ?? DEFAULT_HOST;
    this.hubPort = options.hubPort ?? DEFAULT_PORT;
    this.portRangeStart = options.portRangeStart ?? DEFAULT_PORT_RANGE_START;
    this.portRangeEnd = options.portRangeEnd ?? DEFAULT_PORT_RANGE_END;
    this.mcp = new ChildMcpSupervisor();
  }

  async start(id: string): Promise<RuntimeView> {
    const app = await this.registry.get(id);
    if (!app) {
      throw new Error(`Unknown app: ${id}`);
    }

    const existing = this.#runtime.get(id);
    if (existing?.child && existing.child.exitCode === null && existing.assignedPort) {
      return this.#view(existing, id);
    }

    const assignedPort = await this.#assignPort(app);
    if (assignedPort === undefined) {
      const conflict = this.#entry("conflict", "unhealthy", undefined, "Requested upstream port is already in use.");
      this.#runtime.set(id, conflict);
      return this.#view(conflict, id);
    }

    const entry = this.#entry("starting", "unknown", assignedPort);
    this.#runtime.set(id, entry);

    const child = spawn(app.command, {
      cwd: app.cwd,
      env: {
        ...process.env,
        ...app.env,
        PORT: String(assignedPort),
        HOST: this.hubHost,
        RELAYBASE_APP_ID: app.id,
        RELAYBASE_BASE_URL: `http://${app.id}.localhost:${this.hubPort}`
      },
      shell: true,
      windowsHide: true
    });

    entry.child = child;
    entry.pid = child.pid;
    entry.startedAt = new Date().toISOString();
    entry.logs.push(`[relaybase] starting ${app.id} on ${this.hubHost}:${assignedPort}`);
    await this.mcp.startApp(app);

    child.stdout.on("data", (chunk) => this.#appendLog(app.id, chunk.toString()));
    child.stderr.on("data", (chunk) => this.#appendLog(app.id, chunk.toString()));
    child.once("error", (error) => {
      entry.status = "errored";
      entry.health = "unhealthy";
      entry.lastError = error.message;
      this.#appendLog(app.id, `[relaybase] process error: ${error.message}`);
    });
    child.once("exit", (code, signal) => {
      if (entry.status !== "stopped") {
        entry.status = code === 0 ? "stopped" : "errored";
      }

      entry.health = "unhealthy";
      entry.stoppedAt = new Date().toISOString();
      entry.lastError = code === 0 ? undefined : `Process exited with code ${code ?? "null"} signal ${signal ?? "null"}.`;
      this.#appendLog(app.id, `[relaybase] exited code=${code ?? "null"} signal=${signal ?? "null"}`);
    });

    const healthy = await waitForHealthy(app, assignedPort, this.hubHost, 8000);
    if (child.exitCode !== null) {
      entry.status = "errored";
      entry.health = "unhealthy";
      entry.lastError ??= "Process exited before becoming healthy.";
    } else if (healthy) {
      entry.status = "running";
      entry.health = "healthy";
    } else {
      entry.status = "starting";
      entry.health = "unhealthy";
      entry.lastError = "App did not become healthy before the startup timeout.";
    }

    return this.#view(entry, id);
  }

  async stop(id: string): Promise<RuntimeView> {
    const entry = this.#runtime.get(id);
    if (!entry?.child || entry.child.exitCode !== null) {
      const stopped = entry ?? this.#entry("stopped", "unknown");
      stopped.status = "stopped";
      stopped.health = "unknown";
      stopped.stoppedAt = new Date().toISOString();
      stopped.mcpDrain = await this.mcp.stopApp(id);
      this.#runtime.set(id, stopped);
      return this.#view(stopped, id);
    }

    entry.status = "stopped";
    entry.health = "unhealthy";
    entry.stoppedAt = new Date().toISOString();
    this.#appendLog(id, "[relaybase] stopping");
    entry.mcpDrain = await this.mcp.stopApp(id);

    if (process.platform === "win32" && entry.child.pid) {
      spawnSync("taskkill", ["/pid", String(entry.child.pid), "/t", "/f"], { windowsHide: true });
    } else {
      entry.child.kill("SIGTERM");
    }

    return this.#view(entry, id);
  }

  async restart(id: string): Promise<RuntimeView> {
    await this.stop(id);
    return this.start(id);
  }

  async logs(id: string): Promise<string[]> {
    return [...(this.#runtime.get(id)?.logs ?? [])];
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
          view.health = app.protocol === "tcp" ? "healthy" : await checkAppHealth(app, app.upstreamPort, this.hubHost)
            ? "healthy"
            : "unhealthy";
          view.assignedPort = app.upstreamPort;
        }
      }

      views.push({ ...app, runtime: view });
    }

    return views;
  }

  async getProxyTarget(app: AppRecord): Promise<{ port: number; external: boolean } | undefined> {
    const runtime = this.#runtime.get(app.id);
    if (runtime?.assignedPort && runtime.status !== "errored" && runtime.status !== "conflict" && runtime.status !== "stopped") {
      return { port: runtime.assignedPort, external: false };
    }

    if (app.upstreamPort && await isPortOpen(app.upstreamPort, this.hubHost)) {
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
    const status = statuses.find((entry) => entry.id === id)?.runtime ?? this.#view(this.#entry("stopped", "unknown"), id);
    const port = status.assignedPort ?? app.upstreamPort;
    const reachable = app.protocol === "tcp"
      ? Boolean(port && await isPortOpen(port, this.hubHost))
      : Boolean(port && await checkAppHealth(app, port, this.hubHost));

    return {
      status: {
        ...status,
        health: reachable ? "healthy" : "unhealthy"
      },
      reachable,
      checkedAt: new Date().toISOString()
    };
  }

  #entry(status: RuntimeStatus, health: "unknown" | "healthy" | "unhealthy", assignedPort?: number, lastError?: string): RuntimeEntry {
    return {
      status,
      health,
      ...(assignedPort ? { assignedPort } : {}),
      ...(lastError ? { lastError } : {}),
      logs: []
    };
  }

  async #assignPort(app: AppRecord): Promise<number | undefined> {
    if (app.upstreamPort) {
      const bindable = await isPortOpen(app.upstreamPort, this.hubHost).then((open) => !open);
      return bindable ? app.upstreamPort : undefined;
    }

    return findAvailablePort(this.portRangeStart, this.portRangeEnd, this.hubHost);
  }

  #appendLog(id: string, text: string): void {
    const entry = this.#runtime.get(id);
    if (!entry) {
      return;
    }

    for (const line of text.split(/\r?\n/)) {
      if (!line) {
        continue;
      }

      entry.logs.push(line);
    }

    if (entry.logs.length > 500) {
      entry.logs.splice(0, entry.logs.length - 500);
    }
  }

  #view(entry: RuntimeEntry, appId?: string): RuntimeView {
    const mcpChildren = appId ? this.mcp.statusForApp(appId) : [];
    return {
      status: entry.status,
      health: entry.health,
      ...(entry.pid ? { pid: entry.pid } : {}),
      ...(entry.assignedPort ? { assignedPort: entry.assignedPort } : {}),
      ...(entry.startedAt ? { startedAt: entry.startedAt } : {}),
      ...(entry.stoppedAt ? { stoppedAt: entry.stoppedAt } : {}),
      ...(entry.lastError ? { lastError: entry.lastError } : {}),
      logLines: entry.logs.length,
      ...(mcpChildren.length ? { mcpChildren } : {}),
      ...(entry.mcpDrain?.length ? { mcpDrain: entry.mcpDrain } : {})
    };
  }
}

