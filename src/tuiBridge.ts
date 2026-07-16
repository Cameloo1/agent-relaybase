import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { discovery, ensureDaemon, type DaemonEnsureResult, type RelaybaseCommandOptions } from "./daemonLauncher.ts";
import { redactDiagnosticText } from "./redaction.ts";

export interface TuiBridgeOptions {
  host: string;
  port: number;
  stateDir: string;
  cwd?: string;
  theme?: string;
  daemonStartPolicy?: "auto" | "never";
  env?: NodeJS.ProcessEnv;
  packageRoot?: string;
  platform?: NodeJS.Platform;
  arch?: string;
}

export interface TuiBinaryResolution {
  ok: boolean;
  path?: string;
  source?: TuiBinarySource;
  reason?: string;
  candidates: string[];
}

export type TuiBinarySource =
  | "RELAYBASE_TUI_BIN"
  | "development-build"
  | "package-assets"
  | "platform-package"
  | "global-path";

export interface TuiBinaryCandidate {
  path: string;
  source: Exclude<TuiBinarySource, "RELAYBASE_TUI_BIN" | "global-path">;
}

export interface DaemonReachability {
  reachable: boolean;
  statusCode: number;
  message: string;
}

type SpawnTui = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; shell: false; stdio: "inherit" | ["ignore", "pipe", "pipe"]; cwd?: string }
) => ChildProcess;

export interface TuiBridgeDependencies {
  fileExists?: (filePath: string) => Promise<boolean>;
  findExecutableOnPath?: (
    command: string,
    options: { env: NodeJS.ProcessEnv; platform: NodeJS.Platform | "windows" }
  ) => Promise<string | undefined>;
  checkDaemon?: (baseURL: string) => Promise<DaemonReachability>;
  ensureDaemon?: (options: RelaybaseCommandOptions, allowStart: boolean) => Promise<DaemonEnsureResult>;
  spawn?: SpawnTui;
  stderr?: Pick<NodeJS.WriteStream, "write">;
}

interface TuiBootstrapServer {
  url: string;
  token: string;
  close(): Promise<void>;
}

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function relaybaseBaseURL(options: Pick<TuiBridgeOptions, "host" | "port">): string {
  return `http://${options.host}:${options.port}`;
}

export function platformTuiBinaryName(platform: NodeJS.Platform | "windows", arch: string): string {
  const osName = platform === "win32" || platform === "windows" ? "windows" : platform;
  const archName = arch === "x64" ? "amd64" : arch;

  if (osName !== "windows" && osName !== "darwin" && osName !== "linux") {
    throw new Error(`Relaybase TUI does not have a packaged binary for platform ${platform}.`);
  }
  if (archName !== "amd64" && archName !== "arm64") {
    throw new Error(`Relaybase TUI does not have a packaged binary for architecture ${arch}.`);
  }

  return `relaybase-tui-${osName}-${archName}${osName === "windows" ? ".exe" : ""}`;
}

export function tuiBinaryCandidates(options: {
  packageRoot?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  developmentCheckout?: boolean;
}): TuiBinaryCandidate[] {
  const packageRoot = options.packageRoot ?? PACKAGE_ROOT;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const binaryName = platformTuiBinaryName(platform, arch);
  const osName = platform === "win32" ? "windows" : platform;
  const archName = arch === "x64" ? "amd64" : arch;
  const developmentLaunchPath = path.join(packageRoot, ".relaybase", "tui-dev-bin", binaryName);
  const packageAssetPath = path.join(packageRoot, "bin", "relaybase-tui", binaryName);
  const candidates: TuiBinaryCandidate[] = [];

  if (options.developmentCheckout) {
    candidates.push({
      source: "development-build",
      path: developmentLaunchPath
    });
  }

  candidates.push(
    {
      source: "package-assets",
      path: packageAssetPath
    },
    {
      source: "platform-package",
      path: path.join(path.dirname(packageRoot), `relaybase-tui-${osName}-${archName}`, "bin", binaryName)
    }
  );

  return candidates;
}

export async function resolveTuiBinary(
  options: {
    env?: NodeJS.ProcessEnv;
    packageRoot?: string;
    platform?: NodeJS.Platform;
    arch?: string;
  } = {},
  dependencies: Pick<TuiBridgeDependencies, "fileExists" | "findExecutableOnPath"> = {}
): Promise<TuiBinaryResolution> {
  const env = options.env ?? process.env;
  const exists = dependencies.fileExists ?? fileExists;
  const packageRoot = options.packageRoot ?? PACKAGE_ROOT;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const developmentCheckout = await exists(path.join(packageRoot, ".git"));
  const candidates = tuiBinaryCandidates({ ...options, packageRoot, platform, arch, developmentCheckout });
  const globalCommand = globalTuiCommandName(platform);
  const globalCandidate = `${globalCommand} on PATH`;
  const envBinary = env.RELAYBASE_TUI_BIN?.trim();

  if (envBinary) {
    if (await exists(envBinary)) {
      return { ok: true, path: envBinary, source: "RELAYBASE_TUI_BIN", candidates: [envBinary] };
    }

    return {
      ok: false,
      reason: `RELAYBASE_TUI_BIN points to a missing file: ${envBinary}`,
      candidates: uniqueCandidates([envBinary, ...candidates.map((candidate) => candidate.path), globalCandidate])
    };
  }

  for (const candidate of candidates) {
    if (await exists(candidate.path)) {
      return {
        ok: true,
        path: candidate.path,
        source: candidate.source,
        candidates: uniqueCandidates([...candidates.map((item) => item.path), globalCandidate])
      };
    }
  }

  const findOnPath = dependencies.findExecutableOnPath ?? findExecutableOnPath;
  const globalPath = await findOnPath(globalCommand, { env, platform });
  if (globalPath) {
    return {
      ok: true,
      path: globalPath,
      source: "global-path",
      candidates: uniqueCandidates([...candidates.map((item) => item.path), globalCandidate])
    };
  }

  return {
    ok: false,
    reason: developmentCheckout
      ? "This source checkout has not built a compatible Relaybase TUI binary."
      : "This installed package is missing a compatible Relaybase TUI binary. Reinstall @cameloo/relaybase for this platform.",
    candidates: uniqueCandidates([...candidates.map((candidate) => candidate.path), globalCandidate])
  };
}

export function buildTuiLaunchArgs(options: TuiBridgeOptions, passthroughArgs: string[] = []): string[] {
  const args = ["--base-url", relaybaseBaseURL(options), "--state-dir", options.stateDir];
  if (options.cwd) {
    args.push("--current-directory", options.cwd);
  }
  if (options.theme) {
    args.push("--theme", options.theme);
  }
  return [...args, ...passthroughArgs];
}

export function buildTuiEnv(options: TuiBridgeOptions): NodeJS.ProcessEnv {
  const env = { ...(options.env ?? process.env) };
  env.RELAYBASE_URL = relaybaseBaseURL(options);
  env.RELAYBASE_HOST = options.host;
  env.RELAYBASE_PORT = String(options.port);
  env.RELAYBASE_STATE_DIR = options.stateDir;
  if (options.cwd) {
    env.RELAYBASE_TUI_CURRENT_DIRECTORY = options.cwd;
  }
  return env;
}

function isSmokeRenderLaunch(passthroughArgs: string[]): boolean {
  return passthroughArgs.includes("--smoke-render");
}

export async function runRelaybaseTui(
  options: TuiBridgeOptions,
  passthroughArgs: string[] = [],
  dependencies: TuiBridgeDependencies = {}
): Promise<number> {
  const stderr = dependencies.stderr ?? process.stderr;
  const baseURL = relaybaseBaseURL(options);
  const packageRoot = options.packageRoot ?? PACKAGE_ROOT;
  const resolution = await resolveTuiBinary(options, dependencies);
  if (!resolution.ok || !resolution.path) {
    stderr.write(formatMissingTuiBinaryDiagnostic(resolution));
    return 1;
  }

  const checkDaemon = dependencies.checkDaemon ?? checkDaemonReachable;
  let daemon = await checkDaemon(baseURL);
  let bootstrapReport: DaemonEnsureResult | undefined;
  if (!daemon.reachable) {
    if (options.daemonStartPolicy === "never") {
      bootstrapReport = {
        reachable: false,
        started: false,
        code: "daemon_not_running",
        userAction: "Start Relaybase with: relaybase serve",
        error: daemon.message
      };
    } else {
      bootstrapReport = await (dependencies.ensureDaemon ?? ensureDaemon)(daemonLaunchOptions(options), true);
      if (bootstrapReport.reachable) {
        daemon = { reachable: true, statusCode: 200, message: bootstrapReport.userAction };
      } else {
        stderr.write(formatDaemonBootstrapDiagnostic(baseURL, bootstrapReport));
      }
    }
  }

  let bootstrap: TuiBootstrapServer | undefined;
  if (!isSmokeRenderLaunch(passthroughArgs)) {
    try {
      bootstrap = await startTuiBootstrapServer(options, dependencies);
    } catch (error) {
      bootstrapReport ??= {
        reachable: daemon.reachable,
        started: false,
        code: daemon.reachable ? "daemon_running" : "daemon_not_running",
        userAction: daemon.reachable
          ? "Relaybase daemon is reachable, but local daemon repair from the TUI is unavailable."
          : "Start Relaybase with: relaybase serve",
        error: `TUI bootstrap channel unavailable: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  const spawnTui = dependencies.spawn ?? spawn;
  const launchEnv = buildTuiEnv(options);
  if (isSmokeRenderLaunch(passthroughArgs)) {
    delete launchEnv.RELAYBASE_STATE_DIR;
  }
  if (bootstrap) {
    launchEnv.RELAYBASE_TUI_BOOTSTRAP_URL = bootstrap.url;
    launchEnv.RELAYBASE_TUI_BOOTSTRAP_TOKEN = bootstrap.token;
  }
  if (bootstrapReport) {
    launchEnv.RELAYBASE_TUI_BOOTSTRAP_REPORT = JSON.stringify(safeBootstrapReport(bootstrapReport));
  }
  const launchArgs = buildTuiLaunchArgs(options, passthroughArgs);
  const launchStdio: "inherit" | ["ignore", "pipe", "pipe"] = isSmokeRenderLaunch(passthroughArgs)
    ? ["ignore", "pipe", "pipe"]
    : "inherit";
  let child: ChildProcess;
  try {
    child = spawnTui(resolution.path, launchArgs, {
      env: launchEnv,
      shell: false,
      stdio: launchStdio
    });
  } catch (error) {
    const fallback = await developmentGoRunFallback({
      resolution,
      packageRoot,
      platform: options.platform ?? process.platform,
      launchArgs,
      launchEnv,
      launchStdio,
      stderr,
      spawnTui,
      error
    });
    if (fallback) {
      child = fallback;
    } else {
      stderr.write(formatTuiLaunchFailure(resolution.path, error, options.platform ?? process.platform));
      if (bootstrap) {
        await bootstrap.close();
      }
      return 1;
    }
  }
  forwardPipedTuiOutput(child, launchStdio);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (code: number) => {
      if (settled) {
        return;
      }
      settled = true;
      if (bootstrap) {
        void bootstrap.close().finally(() => resolve(code));
        return;
      }
      resolve(code);
    };
    child.once("error", (error) => {
      stderr.write(formatTuiLaunchFailure(resolution.path, error, options.platform ?? process.platform));
      finish(1);
    });
    child.once("exit", (code, signal) => {
      finish(code ?? exitCodeForSignal(signal));
    });
  });
}

export function formatMissingTuiBinaryDiagnostic(resolution: TuiBinaryResolution): string {
  const candidates = resolution.candidates.map((candidate) => `  - ${candidate}`).join("\n");
  return [
    "relaybase tui: relaybase-tui binary was not found.",
    resolution.reason ? `Detail: ${resolution.reason}` : undefined,
    "Resolution order:",
    "  1. RELAYBASE_TUI_BIN",
    "  2. repo-local .relaybase/tui-dev-bin/<platform binary> from npm run tui:build",
    "  3. bin/relaybase-tui/<platform binary> inside this package",
    "  4. @cameloo/relaybase-tui-<platform>-<arch> platform package",
    "  5. globally installed relaybase-tui on PATH",
    "Installed package recovery: npm install --global @cameloo/relaybase@latest",
    "Source checkout recovery: npm run doctor:tui && npm run tui:build",
    "Expected candidates:",
    candidates
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n")
    .concat("\n");
}

export function formatDaemonUnavailableDiagnostic(baseURL: string, daemon: DaemonReachability): string {
  return [
    `relaybase tui: Relaybase daemon is not reachable at ${baseURL}.`,
    daemon.message ? `Detail: ${daemon.message}` : undefined,
    "Start the daemon with: relaybase serve",
    "Then run: relaybase tui"
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n")
    .concat("\n");
}

export function formatDaemonBootstrapDiagnostic(baseURL: string, result: DaemonEnsureResult): string {
  return [
    `relaybase tui: Relaybase daemon is not reachable at ${baseURL}.`,
    `Diagnosis: ${result.code}`,
    result.error ? `Detail: ${result.error}` : undefined,
    `Next action: ${result.userAction}`,
    result.logPath ? `Daemon log: ${result.logPath}` : undefined,
    "Launching the TUI anyway; use /daemon repair or 'fix daemon' inside the TUI to retry through the local bridge."
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n")
    .concat("\n");
}

export function formatTuiLaunchFailure(
  binaryPath: string | undefined,
  error: unknown,
  platform: NodeJS.Platform = process.platform
): string {
  const message = error instanceof Error ? error.message : String(error);
  const lines = [`relaybase tui: could not launch ${binaryPath ?? "relaybase-tui"}: ${message}`];
  if (platform === "win32" && /spawn UNKNOWN|EPERM|EACCES|Application Control policy/i.test(message)) {
    lines.push(
      /Application Control policy/i.test(message)
        ? "Windows Application Control blocked this executable."
        : "Windows Application Control may have blocked this executable.",
      "Recovery: install the current signed Relaybase release, then retry `relaybase start`.",
      "Evidence: inspect Microsoft-Windows-CodeIntegrity/Operational in Event Viewer.",
      "Relaybase will not ask you to disable or weaken system policy."
    );
  }
  return `${lines.join("\n")}\n`;
}

async function developmentGoRunFallback(options: {
  resolution: TuiBinaryResolution;
  packageRoot: string;
  platform: NodeJS.Platform;
  launchArgs: string[];
  launchEnv: NodeJS.ProcessEnv;
  launchStdio: "inherit" | ["ignore", "pipe", "pipe"];
  stderr: Pick<NodeJS.WriteStream, "write">;
  spawnTui: SpawnTui;
  error?: unknown;
}): Promise<ChildProcess | undefined> {
  if (
    options.resolution.source !== "development-build" ||
    options.launchEnv.RELAYBASE_TUI_DISABLE_GO_RUN_FALLBACK === "1"
  ) {
    return undefined;
  }
  if (options.platform !== "win32") {
    return undefined;
  }

  const tuiDir = path.join(options.packageRoot, "tui");
  try {
    await access(path.join(tuiDir, "go.mod"), constants.F_OK);
  } catch {
    return undefined;
  }

  const fallbackEnv = await developmentGoRunEnv(options.packageRoot, options.launchEnv);
  if (options.error !== undefined) {
    options.stderr.write(
      [
        formatTuiLaunchFailure(options.resolution.path, options.error).trimEnd(),
        "relaybase tui: falling back to `go run ./cmd/relaybase-tui` from the development checkout.",
        "This fallback is used only for source checkouts when local app-control policy blocks the built launch binary."
      ].join("\n") + "\n"
    );
  }
  try {
    return options.spawnTui("go", ["run", "./cmd/relaybase-tui", ...options.launchArgs], {
      cwd: tuiDir,
      env: fallbackEnv,
      shell: false,
      stdio: options.launchStdio
    });
  } catch (fallbackError) {
    options.stderr.write(formatTuiLaunchFailure("go run ./cmd/relaybase-tui", fallbackError));
    return undefined;
  }
}

async function developmentGoRunEnv(packageRoot: string, baseEnv: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const goCache = path.join(os.tmpdir(), "relaybase-go-build-cache");
  const goTmp = path.join(os.tmpdir(), "relaybase-go-build-tmp");
  await mkdir(goCache, { recursive: true });
  await mkdir(goTmp, { recursive: true });
  return {
    ...baseEnv,
    GOCACHE: baseEnv.GOCACHE || goCache,
    GOTMPDIR: baseEnv.GOTMPDIR || goTmp
  };
}

function forwardPipedTuiOutput(child: ChildProcess, stdio: "inherit" | ["ignore", "pipe", "pipe"]): void {
  if (stdio === "inherit") {
    return;
  }
  child.stdout?.pipe(process.stdout);
  child.stderr?.pipe(process.stderr);
}

async function startTuiBootstrapServer(
  options: TuiBridgeOptions,
  dependencies: Pick<TuiBridgeDependencies, "ensureDaemon"> = {}
): Promise<TuiBootstrapServer> {
  const token = randomBytes(32).toString("hex");
  const server = http.createServer((request, response) => {
    void handleTuiBootstrapRequest(options, token, request, response, dependencies);
  });
  const url = await listenLocal(server);
  return {
    url,
    token,
    close: () => closeTuiBootstrapServer(server)
  };
}

function closeTuiBootstrapServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 1000);
    timer.unref?.();
    try {
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
      server.closeAllConnections?.();
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

async function handleTuiBootstrapRequest(
  options: TuiBridgeOptions,
  token: string,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  dependencies: Pick<TuiBridgeDependencies, "ensureDaemon">
): Promise<void> {
  if (request.headers.authorization !== `Bearer ${token}`) {
    sendBootstrapJson(response, 401, {
      daemon: {
        reachable: false,
        started: false,
        code: "daemon_not_running",
        userAction: "Relaunch the TUI through relaybase tui to get a fresh bootstrap token.",
        error: "Unauthorized bootstrap request."
      }
    });
    return;
  }

  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (request.method === "GET" && pathname === "/daemon/status") {
    const current = await discovery(daemonLaunchOptions(options));
    sendBootstrapJson(response, 200, {
      daemon: current.reachable
        ? {
            reachable: true,
            started: false,
            code: "daemon_running",
            userAction: "Relaybase daemon is reachable."
          }
        : {
            reachable: false,
            started: false,
            code: current.statusCode && current.statusCode > 0 ? "non_relaybase_listener" : "daemon_not_running",
            userAction:
              current.statusCode && current.statusCode > 0
                ? `Stop the non-Relaybase service on ${options.host}:${options.port}, or run Relaybase on another port.`
                : "Use /daemon repair to start the Relaybase daemon through the launch bridge.",
            error: current.error
          }
    });
    return;
  }

  if (request.method === "POST" && pathname === "/daemon/ensure") {
    const result = await (dependencies.ensureDaemon ?? ensureDaemon)(daemonLaunchOptions(options), true);
    sendBootstrapJson(response, 200, { daemon: safeBootstrapReport(result) });
    return;
  }

  sendBootstrapJson(response, 404, {
    daemon: {
      reachable: false,
      started: false,
      code: "daemon_not_running",
      userAction: "Supported bootstrap endpoints are GET /daemon/status and POST /daemon/ensure.",
      error: "Unknown bootstrap route."
    }
  });
}

function listenLocal(server: http.Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (typeof address === "object" && address) {
        resolve(`http://127.0.0.1:${address.port}`);
        return;
      }
      reject(new Error("Bootstrap server did not return a TCP address."));
    });
  });
}

function sendBootstrapJson(response: http.ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload)
  });
  response.end(payload);
}

function daemonLaunchOptions(options: TuiBridgeOptions): RelaybaseCommandOptions {
  return {
    cwd: options.cwd ?? process.cwd(),
    host: options.host,
    port: options.port,
    stateDir: options.stateDir
  };
}

function safeBootstrapReport(result: DaemonEnsureResult): DaemonEnsureResult {
  return {
    reachable: result.reachable,
    started: result.started,
    code: result.code,
    userAction: result.userAction,
    ...(result.pid ? { pid: result.pid } : {}),
    ...(result.logPath ? { logPath: result.logPath } : {}),
    ...(result.pidPath ? { pidPath: result.pidPath } : {}),
    ...(result.metadataPath ? { metadataPath: result.metadataPath } : {}),
    ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
    ...(result.signal !== undefined ? { signal: result.signal } : {}),
    ...(result.error ? { error: redactDiagnosticText(result.error) } : {}),
    ...(result.logTail ? { logTail: result.logTail.map(redactDiagnosticText) } : {})
  };
}

export function checkDaemonReachable(baseURL: string, timeoutMs = 2000): Promise<DaemonReachability> {
  return new Promise((resolve) => {
    let settled = false;
    const endpoint = new URL("/__hub/api/state", baseURL.endsWith("/") ? baseURL : `${baseURL}/`);
    const transport = endpoint.protocol === "https:" ? https : http;
    const request = transport.request(
      endpoint,
      {
        method: "GET",
        timeout: timeoutMs,
        headers: {
          Accept: "application/json"
        }
      },
      (response) => {
        response.resume();
        response.once("end", () => {
          if (settled) {
            return;
          }
          const statusCode = response.statusCode ?? 0;
          const reachable =
            (statusCode >= 200 && statusCode < 300) || statusCode === 401 || statusCode === 403 || statusCode >= 500;
          settled = true;
          resolve({
            reachable,
            statusCode,
            message: response.statusMessage ?? `HTTP ${statusCode}`
          });
        });
      }
    );

    request.once("timeout", () => {
      request.destroy(new Error(`timed out after ${timeoutMs}ms`));
    });
    request.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ reachable: false, statusCode: 0, message: error.message });
    });
    request.end();
  });
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function findExecutableOnPath(
  command: string,
  options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform | "windows" } = {}
): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const pathValue = pathEnvValue(env);
  if (!pathValue) {
    return undefined;
  }

  const searchPaths = pathValue.split(path.delimiter).filter((entry) => entry.trim() !== "");
  for (const searchPath of searchPaths) {
    const candidate = path.join(searchPath, command);
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  if (platform === "win32" || platform === "windows") {
    const fallback = command.endsWith(".exe") ? command : `${command}.exe`;
    for (const searchPath of searchPaths) {
      const candidate = path.join(searchPath, fallback);
      if (await fileExists(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
}

function exitCodeForSignal(signal: NodeJS.Signals | null): number {
  if (signal === "SIGINT") {
    return 130;
  }
  if (signal === "SIGTERM") {
    return 143;
  }
  return 1;
}

function globalTuiCommandName(platform: NodeJS.Platform | "windows"): string {
  return platform === "win32" || platform === "windows" ? "relaybase-tui.exe" : "relaybase-tui";
}

function pathEnvValue(env: NodeJS.ProcessEnv): string {
  return env.PATH ?? env.Path ?? "";
}

function uniqueCandidates(candidates: string[]): string[] {
  return [...new Set(candidates)];
}
