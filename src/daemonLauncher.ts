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
  | "daemon_state_mismatch"
  | "daemon_auth_missing"
  | "daemon_auth_invalid"
  | "daemon_not_running"
  | "daemon_runtime_missing"
  | "daemon_start_timeout"
  | "daemon_exited_early"
  | "daemon_spawn_failed"
  | "daemon_state_unavailable"
  | "port_occupied"
  | "non_relaybase_listener";

export type DaemonDiscoveryCode =
  | "daemon_ready"
  | "daemon_state_mismatch"
  | "daemon_auth_missing"
  | "daemon_auth_invalid"
  | "daemon_identity_invalid"
  | "daemon_unreachable"
  | "non_relaybase_listener";

export interface DaemonDiscoveryResult {
  transportReachable: boolean;
  reachable: boolean;
  compatible: boolean;
  authenticated: boolean;
  stateDirMatches: boolean;
  code: DaemonDiscoveryCode;
  clientStateDir: string;
  daemonStateDir?: string;
  body?: Record<string, unknown>;
  statusCode?: number;
  authStatusCode?: number;
  error?: string;
}

export interface DaemonEnsureResult {
  reachable: boolean;
  compatible: boolean;
  authenticated: boolean;
  started: boolean;
  code: DaemonEnsureCode;
  userAction: string;
  clientStateDir?: string;
  daemonStateDir?: string;
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

export interface DaemonRuntimeInvocation {
  cliPath: string;
  nodeArgs: string[];
}

export function resolveDaemonRuntimeInvocation(moduleUrl: string): DaemonRuntimeInvocation {
  const launcherPath = fileURLToPath(moduleUrl);
  const extension = path.extname(launcherPath);
  if (extension !== ".ts" && extension !== ".js") {
    throw new Error(`Unsupported Relaybase daemon launcher extension: ${extension || "(none)"}`);
  }

  const cliPath = path.join(path.dirname(launcherPath), `cli${extension}`);
  return {
    cliPath,
    nodeArgs: extension === ".ts" ? ["--experimental-strip-types", cliPath] : [cliPath]
  };
}

export async function ensureDaemon(options: RelaybaseCommandOptions, allowStart: boolean): Promise<DaemonEnsureResult> {
  const existing = await discovery(options);
  if (existing.reachable) {
    if (!existing.compatible) {
      const code: DaemonEnsureCode =
        existing.code === "daemon_state_mismatch"
          ? "daemon_state_mismatch"
          : existing.code === "daemon_auth_missing"
            ? "daemon_auth_missing"
            : "daemon_auth_invalid";
      return {
        reachable: true,
        compatible: false,
        authenticated: existing.authenticated,
        started: false,
        code,
        userAction: userActionForDaemonCode(code, options),
        clientStateDir: options.stateDir,
        ...(existing.daemonStateDir ? { daemonStateDir: existing.daemonStateDir } : {}),
        error: existing.error ?? daemonCompatibilityMessage(existing)
      };
    }
    return {
      reachable: true,
      compatible: true,
      authenticated: true,
      started: false,
      code: "daemon_running",
      userAction: "Relaybase daemon is already reachable and authenticated.",
      clientStateDir: options.stateDir,
      ...(existing.daemonStateDir ? { daemonStateDir: existing.daemonStateDir } : {})
    };
  }

  if (existing.transportReachable) {
    return {
      reachable: false,
      compatible: false,
      authenticated: false,
      started: false,
      code: "non_relaybase_listener",
      userAction: `Stop the non-Relaybase service on ${options.host}:${options.port}, or run Relaybase on another port.`,
      clientStateDir: options.stateDir,
      error: existing.error ?? `HTTP ${existing.statusCode}`
    };
  }

  if (!allowStart) {
    return {
      reachable: false,
      compatible: false,
      authenticated: false,
      started: false,
      code: "daemon_not_running",
      userAction: "Start Relaybase with: relaybase serve",
      clientStateDir: options.stateDir,
      error: existing.error
    };
  }

  const command = process.execPath;
  const logPath = path.join(options.stateDir, "daemon.log");
  const pidPath = path.join(options.stateDir, "daemon.pid");
  const metadataPath = path.join(options.stateDir, "daemon.json");
  const cwd = options.cwd;
  let runtime: DaemonRuntimeInvocation;
  try {
    runtime = resolveDaemonRuntimeInvocation(import.meta.url);
  } catch (error) {
    return {
      reachable: false,
      compatible: false,
      authenticated: false,
      started: false,
      code: "daemon_runtime_missing",
      userAction: userActionForDaemonCode("daemon_runtime_missing", options),
      command,
      cwd,
      logPath,
      pidPath,
      metadataPath,
      error: `Relaybase daemon runtime resolution failed: ${errorMessage(error)}`
    };
  }
  const args = [
    ...runtime.nodeArgs,
    "serve",
    "--host",
    options.host,
    "--port",
    String(options.port),
    "--state-dir",
    options.stateDir
  ];

  try {
    await fs.access(runtime.cliPath);
  } catch (error) {
    return {
      reachable: false,
      compatible: false,
      authenticated: false,
      started: false,
      code: "daemon_runtime_missing",
      userAction: userActionForDaemonCode("daemon_runtime_missing", options),
      command,
      args,
      cwd,
      logPath,
      pidPath,
      metadataPath,
      error: `Relaybase daemon runtime is unavailable at ${runtime.cliPath}: ${errorMessage(error)}`
    };
  }

  try {
    await ensureDir(options.stateDir);
    await fs.appendFile(logPath, `[${new Date().toISOString()}] relaybase daemon start requested\n`, "utf8");
  } catch (error) {
    return {
      reachable: false,
      compatible: false,
      authenticated: false,
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
      compatible: false,
      authenticated: false,
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
    compatible: false,
    authenticated: false,
    started: true,
    clientStateDir: options.stateDir,
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
    if (probe.compatible) {
      return {
        ...baseResult,
        reachable: true,
        compatible: true,
        authenticated: true,
        code: "daemon_started",
        userAction: "Relaybase daemon started and is authenticated.",
        ...(probe.daemonStateDir ? { daemonStateDir: probe.daemonStateDir } : {})
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
      transportReachable: response.statusCode > 0,
      reachable: false,
      compatible: false,
      authenticated: false,
      stateDirMatches: false,
      code: response.statusCode > 0 ? "non_relaybase_listener" : "daemon_unreachable",
      clientStateDir: options.stateDir,
      statusCode: response.statusCode,
      error: response.body || `HTTP ${response.statusCode}`
    };
  }

  const body = safeJson(response.body);
  if (body.product !== "Relaybase" || body.package !== "@cameloo/relaybase") {
    return {
      transportReachable: true,
      reachable: false,
      compatible: false,
      authenticated: false,
      stateDirMatches: false,
      code: "daemon_identity_invalid",
      clientStateDir: options.stateDir,
      statusCode: response.statusCode,
      body,
      error: "The configured listener did not return a valid Relaybase discovery identity."
    };
  }

  const daemonStateDir = discoveryStateDir(body);
  const stateDirMatches = Boolean(daemonStateDir && sameStateDirectory(options.stateDir, daemonStateDir));
  if (!stateDirMatches) {
    return {
      transportReachable: true,
      reachable: true,
      compatible: false,
      authenticated: false,
      stateDirMatches: false,
      code: "daemon_state_mismatch",
      clientStateDir: options.stateDir,
      ...(daemonStateDir ? { daemonStateDir } : {}),
      statusCode: response.statusCode,
      body,
      error: daemonStateDir
        ? "Relaybase is reachable, but the client and daemon use different state directories."
        : "Relaybase discovery did not identify the daemon state directory."
    };
  }

  const token = await readExistingSessionToken(options.stateDir);
  if (!token) {
    return {
      transportReachable: true,
      reachable: true,
      compatible: false,
      authenticated: false,
      stateDirMatches: true,
      code: "daemon_auth_missing",
      clientStateDir: options.stateDir,
      ...(daemonStateDir ? { daemonStateDir } : {}),
      statusCode: response.statusCode,
      body,
      error: "Relaybase is reachable, but the selected state directory has no readable session token."
    };
  }

  const session = await daemonHttpRequest(options, "GET", "/__hub/api/session", undefined, token);
  if (!session.ok) {
    return {
      transportReachable: true,
      reachable: true,
      compatible: false,
      authenticated: false,
      stateDirMatches: true,
      code: "daemon_auth_invalid",
      clientStateDir: options.stateDir,
      ...(daemonStateDir ? { daemonStateDir } : {}),
      statusCode: response.statusCode,
      authStatusCode: session.statusCode,
      body,
      error:
        session.statusCode === 401 || session.statusCode === 403
          ? "Relaybase rejected the session token from the selected state directory."
          : `Relaybase session validation failed with HTTP ${session.statusCode || "unavailable"}.`
    };
  }

  return {
    transportReachable: true,
    reachable: true,
    compatible: true,
    authenticated: true,
    stateDirMatches: true,
    code: "daemon_ready",
    clientStateDir: options.stateDir,
    ...(daemonStateDir ? { daemonStateDir } : {}),
    statusCode: response.statusCode,
    authStatusCode: session.statusCode,
    body
  };
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
    case "daemon_state_mismatch":
      return "Run relaybase diagnose-token. Use the running daemon state directory, or stop it explicitly before starting Relaybase with a different state directory.";
    case "daemon_auth_missing":
      return `Run relaybase diagnose-token and restore read access to ${path.join(options.stateDir, "session-token")}.`;
    case "daemon_auth_invalid":
      return "Run relaybase diagnose-token. Relaybase will not copy or expose either session token.";
    case "port_occupied":
      return `Free ${options.host}:${options.port}, or choose another Relaybase port with --port.`;
    case "non_relaybase_listener":
      return `Stop the non-Relaybase service on ${options.host}:${options.port}, or run Relaybase on another port.`;
    case "daemon_state_unavailable":
      return `Fix permissions for the Relaybase state directory: ${options.stateDir}`;
    case "daemon_spawn_failed":
      return "Inspect the daemon log and retry from a terminal that can run Node.";
    case "daemon_runtime_missing":
      return "Reinstall Relaybase. From a source checkout, run npm run build:runtime, then retry.";
    case "daemon_start_timeout":
      return "Inspect the daemon log and retry; Relaybase did not become reachable before timeout.";
    default:
      return "Inspect the daemon log and retry.";
  }
}

function discoveryStateDir(body: Record<string, unknown>): string | undefined {
  const auth = body.auth;
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) {
    return undefined;
  }
  const stateDir = (auth as Record<string, unknown>).stateDir;
  return typeof stateDir === "string" && stateDir.trim() ? stateDir.trim() : undefined;
}

export function sameStateDirectory(left: string, right: string): boolean {
  return stateDirectoryKey(left) === stateDirectoryKey(right);
}

function stateDirectoryKey(value: string): string {
  const trimmed = value.trim().replace(/[\\/]+$/, "");
  if (/^[a-z]:[\\/]/i.test(trimmed)) {
    return path.win32.normalize(trimmed.replace(/\//g, "\\")).toLowerCase();
  }
  const resolved = path.resolve(trimmed || ".");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function readExistingSessionToken(stateDir: string): Promise<string | undefined> {
  try {
    const token = (await fs.readFile(path.join(stateDir, "session-token"), "utf8")).trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

function daemonCompatibilityMessage(result: DaemonDiscoveryResult): string {
  switch (result.code) {
    case "daemon_state_mismatch":
      return "Relaybase is reachable, but the selected state directory does not match the running daemon.";
    case "daemon_auth_missing":
      return "Relaybase is reachable, but the selected state directory has no readable session token.";
    default:
      return "Relaybase is reachable, but it rejected the selected session token.";
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
