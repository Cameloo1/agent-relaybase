import { spawn } from "node:child_process";
import { closeSync, openSync, promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redactDiagnosticText } from "./redaction.ts";

export interface RelaybaseCommandOptions {
  cwd: string;
  host: string;
  port: number;
  stateDir: string;
  json?: boolean;
}

export type DaemonEnsureCode =
  | "daemon_running"
  | "daemon_started"
  | "daemon_not_running"
  | "daemon_start_timeout"
  | "daemon_exited_early"
  | "daemon_spawn_failed"
  | "daemon_state_unavailable"
  | "port_occupied"
  | "non_relaybase_listener";

export interface DaemonDiscoveryResult {
  reachable: boolean;
  body?: Record<string, unknown>;
  statusCode?: number;
  error?: string;
}

export interface DaemonEnsureResult {
  reachable: boolean;
  started: boolean;
  code: DaemonEnsureCode;
  userAction: string;
  pid?: number;
  command?: string;
  args?: string[];
  cwd?: string;
  logPath?: string;
  pidPath?: string;
  metadataPath?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
  logTail?: string[];
}

export async function ensureDaemon(options: RelaybaseCommandOptions, allowStart: boolean): Promise<DaemonEnsureResult> {
  const existing = await discovery(options);
  if (existing.reachable) {
    return {
      reachable: true,
      started: false,
      code: "daemon_running",
      userAction: "Relaybase daemon is already reachable."
    };
  }

  if (existing.statusCode && existing.statusCode > 0) {
    return {
      reachable: false,
      started: false,
      code: "non_relaybase_listener",
      userAction: `Stop the non-Relaybase service on ${options.host}:${options.port}, or run Relaybase on another port.`,
      error: existing.error ?? `HTTP ${existing.statusCode}`
    };
  }

  if (!allowStart) {
    return {
      reachable: false,
      started: false,
      code: "daemon_not_running",
      userAction: "Start Relaybase with: relaybase serve",
      error: existing.error
    };
  }

  const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.ts");
  const command = process.execPath;
  const args = [
    "--experimental-strip-types",
    cliPath,
    "serve",
    "--host",
    options.host,
    "--port",
    String(options.port),
    "--state-dir",
    options.stateDir
  ];
  const logPath = path.join(options.stateDir, "daemon.log");
  const pidPath = path.join(options.stateDir, "daemon.pid");
  const metadataPath = path.join(options.stateDir, "daemon.json");
  const cwd = options.cwd;

  try {
    await ensureDir(options.stateDir);
    await fs.appendFile(logPath, `[${new Date().toISOString()}] relaybase daemon start requested\n`, "utf8");
  } catch (error) {
    return {
      reachable: false,
      started: false,
      code: "daemon_state_unavailable",
      userAction: `Fix permissions for the Relaybase state directory: ${options.stateDir}`,
      command,
      args,
      cwd,
      logPath,
      pidPath,
      metadataPath,
      error: `Relaybase daemon state/log setup failed: ${errorMessage(error)}`
    };
  }

  let stdoutFd: number | undefined;
  let stderrFd: number | undefined;
  let child;
  try {
    stdoutFd = openSync(logPath, "a");
    stderrFd = openSync(logPath, "a");
    child = spawn(command, args, {
      cwd: options.cwd,
      detached: true,
      stdio: ["ignore", stdoutFd, stderrFd],
      windowsHide: true
    });
  } catch (error) {
    return {
      reachable: false,
      started: false,
      code: "daemon_spawn_failed",
      userAction: "Inspect the daemon log and retry from a terminal that can run Node.",
      command,
      args,
      cwd,
      logPath,
      pidPath,
      metadataPath,
      error: `Relaybase daemon spawn failed: ${errorMessage(error)}`
    };
  } finally {
    if (stdoutFd !== undefined) {
      closeSync(stdoutFd);
    }
    if (stderrFd !== undefined) {
      closeSync(stderrFd);
    }
  }

  let spawnError: string | undefined;
  let exitCode: number | null | undefined;
  let signal: NodeJS.Signals | null | undefined;
  child.once("error", (error) => {
    spawnError = error.message;
  });
  child.once("exit", (code, exitSignal) => {
    exitCode = code;
    signal = exitSignal;
  });

  const baseResult: Omit<DaemonEnsureResult, "code" | "userAction"> = {
    reachable: false,
    started: true,
    ...(child.pid ? { pid: child.pid } : {}),
    command,
    args,
    cwd,
    logPath,
    pidPath,
    metadataPath
  };

  if (child.pid) {
    await writeTextAtomic(pidPath, `${child.pid}\n`).catch(() => undefined);
  }
  await writeTextAtomic(
    metadataPath,
    `${JSON.stringify(
      {
        pid: child.pid ?? null,
        command,
        args,
        cwd,
        host: options.host,
        port: options.port,
        stateDir: options.stateDir,
        logPath,
        startedAt: new Date().toISOString()
      },
      null,
      2
    )}\n`
  ).catch(() => undefined);
  child.unref();

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const probe = await discovery(options);
    if (probe.reachable) {
      return {
        ...baseResult,
        reachable: true,
        code: "daemon_started",
        userAction: "Relaybase daemon started and is reachable."
      };
    }
    if (spawnError) {
      const logTail = await readDaemonLogTail(logPath);
      const code = classifyDaemonStartFailure(spawnError, logTail);
      return {
        ...baseResult,
        code,
        userAction: userActionForDaemonCode(code, options),
        error: `Relaybase daemon failed to spawn: ${spawnError}`,
        ...(logTail.length ? { logTail } : {})
      };
    }
    if (exitCode !== undefined || signal !== undefined) {
      const logTail = await readDaemonLogTail(logPath);
      const code = classifyDaemonStartFailure("Relaybase daemon exited before becoming reachable.", logTail);
      return {
        ...baseResult,
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(signal !== undefined ? { signal } : {}),
        code,
        userAction: userActionForDaemonCode(code, options),
        error: "Relaybase daemon exited before becoming reachable.",
        ...(logTail.length ? { logTail } : {})
      };
    }
    await delay(150);
  }

  const logTail = await readDaemonLogTail(logPath);
  return {
    ...baseResult,
    code: "daemon_start_timeout",
    userAction: "Inspect the daemon log and retry; Relaybase did not become reachable before timeout.",
    error: "Relaybase daemon did not become reachable before timeout.",
    ...(logTail.length ? { logTail } : {})
  };
}

export async function discovery(options: RelaybaseCommandOptions): Promise<DaemonDiscoveryResult> {
  const response = await daemonHttpRequest(options, "GET", "/.well-known/mcp.json");
  if (!response.ok) {
    return {
      reachable: false,
      statusCode: response.statusCode,
      error: response.body || `HTTP ${response.statusCode}`
    };
  }

  return { reachable: true, statusCode: response.statusCode, body: safeJson(response.body) };
}

export function daemonHttpRequest(
  options: RelaybaseCommandOptions,
  method: string,
  requestPath: string,
  body?: unknown,
  token?: string
): Promise<{ ok: boolean; statusCode: number; body: string }> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve) => {
    let settled = false;
    const request = http.request(
      {
        host: options.host,
        port: options.port,
        path: requestPath,
        method,
        timeout: 2000,
        headers: {
          host: "localhost",
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
          ...(token ? { "x-relaybase-token": token } : {})
        }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on("end", () => {
          if (settled) {
            return;
          }
          settled = true;
          const statusCode = response.statusCode ?? 500;
          resolve({
            ok: statusCode >= 200 && statusCode < 300,
            statusCode,
            body: Buffer.concat(chunks).toString("utf8")
          });
        });
      }
    );

    request.once("timeout", () => {
      request.destroy();
      if (!settled) {
        settled = true;
        resolve({ ok: false, statusCode: 0, body: "Relaybase server is not reachable." });
      }
    });
    request.once("error", (error) => {
      if (!settled) {
        settled = true;
        resolve({ ok: false, statusCode: 0, body: error.message });
      }
    });
    if (payload) {
      request.write(payload);
    }
    request.end();
  });
}

function classifyDaemonStartFailure(error: string, logTail: string[]): DaemonEnsureCode {
  const text = [error, ...logTail].join("\n").toLowerCase();
  if (text.includes("eaddrinuse") || text.includes("already in use") || text.includes("address in use")) {
    return "port_occupied";
  }
  return "daemon_exited_early";
}

function userActionForDaemonCode(code: DaemonEnsureCode, options: RelaybaseCommandOptions): string {
  switch (code) {
    case "port_occupied":
      return `Free ${options.host}:${options.port}, or choose another Relaybase port with --port.`;
    case "non_relaybase_listener":
      return `Stop the non-Relaybase service on ${options.host}:${options.port}, or run Relaybase on another port.`;
    case "daemon_state_unavailable":
      return `Fix permissions for the Relaybase state directory: ${options.stateDir}`;
    case "daemon_spawn_failed":
      return "Inspect the daemon log and retry from a terminal that can run Node.";
    case "daemon_start_timeout":
      return "Inspect the daemon log and retry; Relaybase did not become reachable before timeout.";
    default:
      return "Inspect the daemon log and retry.";
  }
}

async function readDaemonLogTail(logPath: string, maxLines = 12): Promise<string[]> {
  try {
    const content = await fs.readFile(logPath, "utf8");
    return content
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "")
      .slice(-maxLines)
      .map(redactDiagnosticText);
  } catch {
    return [];
  }
}

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

async function writeTextAtomic(filePath: string, content: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, content, "utf8");
  await fs.rename(tempPath, filePath);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeJson(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
