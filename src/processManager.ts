import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Registry } from "./registry.ts";
import { DEFAULT_HOST, DEFAULT_PORT, DEFAULT_PORT_RANGE_END, DEFAULT_PORT_RANGE_START } from "./state.ts";
import { ChildMcpSupervisor } from "./childMcp.ts";
import { checkAppHealth, waitForHealthy } from "./health.ts";
import { findAvailablePort, isPortOpen } from "./ports.ts";
import type { AppRecord, AppStatusView, ChildMcpDrainResult, RuntimeStatus, RuntimeView, StopVerification } from "./types.ts";

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
  logEvents: AppLogEvent[];
  mcpDrain?: ChildMcpDrainResult[];
  stopVerification?: StopVerification;
}

interface SpawnSpec {
  command: string;
  args: string[];
  shell: boolean;
}

export interface AppLogEvent {
  appId: string;
  line: string;
  stream: "stdout" | "stderr" | "system";
  sequence: number;
  at: string;
}

export interface ProcessManagerOptions {
  hubHost?: string;
  hubPort?: number;
  portRangeStart?: number;
  portRangeEnd?: number;
  stopPortOpenProbe?: (port: number, host: string) => Promise<boolean>;
}

export class ProcessManager {
  readonly registry: Registry;
  readonly hubHost: string;
  readonly hubPort: number;
  readonly portRangeStart: number;
  readonly portRangeEnd: number;
  readonly mcp: ChildMcpSupervisor;
  readonly stopPortOpenProbe: (port: number, host: string) => Promise<boolean>;
  #runtime = new Map<string, RuntimeEntry>();
  #logSubscribers = new Set<(event: AppLogEvent) => void>();
  #logSequence = 0;

  constructor(registry: Registry, options: ProcessManagerOptions = {}) {
    this.registry = registry;
    this.hubHost = options.hubHost ?? DEFAULT_HOST;
    this.hubPort = options.hubPort ?? DEFAULT_PORT;
    this.portRangeStart = options.portRangeStart ?? DEFAULT_PORT_RANGE_START;
    this.portRangeEnd = options.portRangeEnd ?? DEFAULT_PORT_RANGE_END;
    this.stopPortOpenProbe = options.stopPortOpenProbe ?? ((port, host) => isPortOpen(port, host));
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

    const spawnSpec = this.#spawnSpec(app.command);
    const child = spawn(spawnSpec.command, spawnSpec.args, {
      cwd: app.cwd,
      env: {
        ...process.env,
        ...app.env,
        PORT: String(assignedPort),
        HOST: this.hubHost,
        RELAYBASE_APP_ID: app.id,
        RELAYBASE_BASE_URL: `http://${app.id}.localhost:${this.hubPort}`
      },
      shell: spawnSpec.shell,
      windowsHide: true
    });

    entry.child = child;
    entry.pid = child.pid;
    entry.startedAt = new Date().toISOString();
    this.#appendLog(app.id, `[relaybase] starting ${app.id} on ${this.hubHost}:${assignedPort}`, "system");
    await this.mcp.startApp(app);

    child.stdout.on("data", (chunk) => this.#appendLog(app.id, chunk.toString(), "stdout"));
    child.stderr.on("data", (chunk) => this.#appendLog(app.id, chunk.toString(), "stderr"));
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
      const assignedPort = stopped.assignedPort;
      const checkedAt = new Date().toISOString();
      const backendPortOpen = assignedPort ? await this.stopPortOpenProbe(assignedPort, this.hubHost) : null;
      stopped.mcpDrain = await this.mcp.stopApp(id);
      stopped.stopVerification = {
        attempted: true,
        checkedAt,
        ...(assignedPort ? { backendPort: assignedPort } : {}),
        backendPortOpen,
        portClosureVerified: Boolean(assignedPort && backendPortOpen === false),
        ok: backendPortOpen !== true,
        ...(backendPortOpen ? { failureReason: `Stop requested, but backend port ${assignedPort} is still open.` } : {}),
        ...(stopped.mcpDrain?.length ? { mcpDrain: stopped.mcpDrain } : {})
      };
      stopped.status = stopped.stopVerification.ok ? "stopped" : "errored";
      stopped.health = stopped.stopVerification.ok ? "unknown" : "unhealthy";
      stopped.lastError = stopped.stopVerification.failureReason;
      stopped.stoppedAt = new Date().toISOString();
      this.#runtime.set(id, stopped);
      return this.#view(stopped, id);
    }

    const assignedPort = entry.assignedPort;
    entry.status = "stopping";
    entry.health = "unhealthy";
    this.#appendLog(id, "[relaybase] stopping");
    entry.mcpDrain = await this.mcp.stopApp(id);

    await this.#terminateChild(entry.child);
    entry.stoppedAt = new Date().toISOString();

    const checkedAt = new Date().toISOString();
    let portStillOpen = assignedPort ? !(await this.#waitForPortClosed(assignedPort, 3000)) : false;
    if (portStillOpen && assignedPort && process.platform === "win32") {
      this.#killPortOwner(assignedPort);
      portStillOpen = !(await this.#waitForPortClosed(assignedPort, 3000));
    }
    entry.stopVerification = {
      attempted: true,
      checkedAt,
      ...(assignedPort ? { backendPort: assignedPort } : {}),
      backendPortOpen: assignedPort ? portStillOpen : null,
      portClosureVerified: Boolean(assignedPort && !portStillOpen),
      ok: !portStillOpen,
      ...(portStillOpen ? { failureReason: `Stop requested, but backend port ${assignedPort} is still open.` } : {}),
      ...(entry.mcpDrain?.length ? { mcpDrain: entry.mcpDrain } : {})
    };
    if (portStillOpen) {
      entry.status = "errored";
      entry.health = "unhealthy";
      entry.lastError = entry.stopVerification.failureReason;
      this.#appendLog(id, `[relaybase] stop failed: ${entry.lastError}`);
      return this.#view(entry, id);
    }

    entry.status = "stopped";
    entry.health = "unknown";
    entry.assignedPort = undefined;
    entry.pid = undefined;
    entry.lastError = undefined;
    this.#appendLog(id, "[relaybase] stopped");
    return this.#view(entry, id);
  }

  async restart(id: string): Promise<RuntimeView> {
    await this.stop(id);
    return this.start(id);
  }

  async logs(id: string): Promise<string[]> {
    return [...(this.#runtime.get(id)?.logs ?? [])];
  }

  async logEvents(id: string): Promise<AppLogEvent[]> {
    return [...(this.#runtime.get(id)?.logEvents ?? [])];
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
      logs: [],
      logEvents: []
    };
  }

  async #assignPort(app: AppRecord): Promise<number | undefined> {
    if (app.upstreamPort) {
      const bindable = await isPortOpen(app.upstreamPort, this.hubHost).then((open) => !open);
      return bindable ? app.upstreamPort : undefined;
    }

    return findAvailablePort(this.portRangeStart, this.portRangeEnd, this.hubHost);
  }

  #spawnSpec(command: string): SpawnSpec {
    const tokens = this.#splitCommand(command);
    if (!tokens.length || /[&|<>]/.test(command)) {
      return { command, args: [], shell: true };
    }

    const executable = tokens[0];
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

  #appendLog(id: string, text: string, stream: AppLogEvent["stream"] = "system"): void {
    const entry = this.#runtime.get(id);
    if (!entry) {
      return;
    }

    for (const line of text.split(/\r?\n/)) {
      if (!line) {
        continue;
      }

      entry.logs.push(line);
      const event: AppLogEvent = {
        appId: id,
        line,
        stream,
        sequence: ++this.#logSequence,
        at: new Date().toISOString()
      };
      entry.logEvents.push(event);
      for (const subscriber of this.#logSubscribers) {
        try {
          subscriber(event);
        } catch {
          // Log subscribers are observers; app output should never be blocked by a broken stream.
        }
      }
    }

    if (entry.logs.length > 500) {
      entry.logs.splice(0, entry.logs.length - 500);
    }

    if (entry.logEvents.length > 500) {
      entry.logEvents.splice(0, entry.logEvents.length - 500);
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
      ...(entry.mcpDrain?.length ? { mcpDrain: entry.mcpDrain } : {}),
      ...(entry.stopVerification ? { stopVerification: entry.stopVerification } : {})
    };
  }
}

