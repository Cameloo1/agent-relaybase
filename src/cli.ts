import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
  buildAppListResult,
  buildOfflineAppListResult,
  listFilterNeedsRuntime,
  type AppListFilter,
  type AppListItem,
  type AppListResult
} from "./appListing.ts";
import type { DockerComposeDetection, DockerSetupOptions } from "./dockerProfile.ts";
import { createRelaybaseServer } from "./server.ts";
import { discovery, ensureDaemon } from "./daemonLauncher.ts";
import { arrowSelectCursorRows } from "./cliPrompt.ts";
import { Registry } from "./registry.ts";
import { DEFAULT_HOST, DEFAULT_PORT, getDefaultStateDir, getOrCreateSessionToken } from "./state.ts";
import type { AppState, AppStatusView } from "./types.ts";
import {
  configureProject,
  defaultCommandOptions,
  detectProject,
  healthProject,
  openProject,
  proposeSetupPlans,
  type ConfigureProjectResult,
  type EnvStrategy,
  type HealthCheckResult,
  type OpenProjectResult,
  type SetupPlan
} from "./setup.ts";
import {
  formatOpenRouterLiveSmokeError,
  printOpenRouterLiveSmokeResult,
  runOpenRouterLiveSmoke
} from "./agent/openrouterLiveSmoke.ts";
import {
  agentLiveCorrectnessPreflight,
  formatAgentLiveAcceptanceError,
  printAgentLiveAcceptanceResult,
  runAgentLiveAcceptance
} from "./agent/liveAcceptance.ts";
import {
  formatAgentLiveCommandMatrixError,
  printAgentLiveCommandMatrixResult,
  runAgentLiveCommandMatrix
} from "./agent/liveCommandMatrix.ts";
import {
  formatAgentFolderStartLiveError,
  printAgentFolderStartLiveResult,
  runAgentFolderStartLive
} from "./agent/liveFolderStart.ts";
import { formatRelaybaseEnvFileDiagnostics, loadRelaybaseEnvFile, relaybaseModelSource } from "./envFile.ts";
import { formatRegistrationPlan } from "./registrationPlanFormat.ts";
import { restartDaemon } from "./daemonRestartClient.ts";
import { formatMissingTuiBinaryDiagnostic, resolveTuiBinary, runRelaybaseTui } from "./tuiBridge.ts";
import { removeRecognizedRelaybasePowerShellShim } from "./prefixShim.ts";
import type {
  AgentSecurityRepairActionId,
  AgentSecurityRepairOperation,
  AgentSecurityRepairPreview,
  AgentSecurityStatus
} from "./agent/types.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_NAME = "@cameloo/relaybase";
const DEFAULT_API_TIMEOUT_MS = 2000;
const STATE_API_TIMEOUT_MS = 65_000;
const LIFECYCLE_API_TIMEOUT_MS = 65_000;
const AGENT_LIVE_ENV_NAMES = [
  "OPENROUTER_API_KEY",
  "OPENROUTER_HTTP_REFERER",
  "OPENROUTER_TITLE",
  "RELAYBASE_AGENT_MODEL",
  "RELAYBASE_AGENT_ENABLED",
  "RELAYBASE_AGENT_REMOTE_MODEL_ENABLED"
];

interface CliOptions {
  port: number;
  host: string;
  stateDir: string;
  cwd: string;
  json: boolean;
  yes: boolean;
  dryRun: boolean;
  noStart: boolean;
  noVerify: boolean;
  noBrowser: boolean;
  repair: boolean;
  mcpInstall: boolean;
  prove: boolean;
  verbose: boolean;
  plan: boolean;
  full: boolean;
  release: boolean;
  live: boolean;
  all: boolean;
  race: boolean;
  diagnose: boolean;
  preflight: boolean;
  agentSecurity: boolean;
  online: boolean;
  safe: boolean;
  daemonStartPolicy: "auto" | "never";
  restartDaemonOnLaunch: boolean;
  listFilter: AppListFilter;
  profile?: string;
  answersPath?: string;
  agentConfigPath?: string;
  repairIssue?: string;
  repairAction?: string;
  repairPreviewId?: string;
  repairOperationId?: string;
  docker: DockerSetupOptions;
  agentEnvironment?: import("./types.ts").ServerOptions["agentEnvironment"];
}

class AgentRepairCliError extends Error {
  readonly statusCode: number;
  readonly code?: string;

  constructor(statusCode: number, message: string, code?: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (process.argv.slice(2).includes("--json")) {
    console.log(JSON.stringify({ ok: false, error: message }, null, 2));
  } else {
    console.error(message);
  }
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args.shift() ?? "help";
  if (command === "--version" || command === "-v" || command === "version") {
    console.log(packageVersion());
    return;
  }
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (args.includes("--help") || args.includes("-h")) {
    printHelp(command);
    return;
  }

  const isBundledStart = command === "start" && isBundledStartArgs(args);
  const { cliArgs, passthroughArgs } =
    command === "tui" || isBundledStart ? splitPassthroughArgs(args) : { cliArgs: args, passthroughArgs: [] };
  const options = parseOptions(cliArgs);
  if (options.restartDaemonOnLaunch && command !== "tui" && !(command === "start" && isBundledStart)) {
    throw new Error("--restart-daemon is supported only by relaybase start (without an app id) and relaybase tui.");
  }
  if (commandNeedsAgentEnvironment(command, args, isBundledStart)) {
    const envFile = loadRelaybaseEnvFile({
      cwd: options.cwd,
      ...(options.agentConfigPath ? { filePath: options.agentConfigPath } : {})
    });
    if (envFile.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      throw new Error(formatRelaybaseEnvFileDiagnostics(envFile));
    }
    options.agentEnvironment = {
      modelSource: relaybaseModelSource(envFile),
      ...(envFile.loaded && envFile.path ? { envFilePath: envFile.path } : {}),
      ...(envFile.fingerprint ? { envFileFingerprint: envFile.fingerprint } : {}),
      ...(envFile.loaded ? { envFileAppliedKeys: [...envFile.appliedKeys] } : {}),
      ...(envFile.loaded ? { envFileSkippedKeys: [...envFile.skippedKeys] } : {}),
      ...(envFile.loaded ? { envFileSourceKind: envFile.sourceKind } : {})
    };
  }

  switch (command) {
    case "agent":
      await agent(args, options);
      return;
    case "configure":
      await configure(options);
      return;
    case "open":
      await openConfiguredApp(options);
      return;
    case "health":
      await health(options);
      return;
    case "check":
      process.exitCode = await checkRelaybase(options);
      return;
    case "diagnose-token":
    case "diagnose_token":
      process.exitCode = await diagnoseToken(options);
      return;
    case "verify":
      process.exitCode = await verifyRelaybase(options);
      return;
    case "repair-prefix":
      process.exitCode = repairRelaybaseCommandPrefix(options);
      return;
    case "repair":
      process.exitCode = await repairRelaybase(options);
      return;
    case "list":
      await listApps(options);
      return;
    case "serve":
      await serve(options);
      return;
    case "mcp":
      await mcp(options);
      return;
    case "daemon":
      process.exitCode = await daemonCommand(args, options);
      return;
    case "register":
      await register(args[0], options);
      return;
    case "start":
      if (isBundledStart) {
        process.exitCode = await startRelaybase(options, passthroughArgs);
        return;
      }
      await mutateApp(command, requiredArg(args[0], command), options);
      return;
    case "stop":
    case "restart":
      await mutateApp(command, requiredArg(args[0], command), options);
      return;
    case "status":
      await listApps(options);
      return;
    case "logs":
      await logs(requiredArg(args[0], "logs"), options);
      return;
    case "tui":
      process.exitCode = await runRelaybaseTui(options, passthroughArgs);
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

function commandNeedsAgentEnvironment(command: string, args: string[], isBundledStart: boolean): boolean {
  if (command === "repair" || command === "daemon" || command === "diagnose-token" || command === "diagnose_token") {
    return false;
  }
  if (command === "agent") {
    return !["config", "provider", "threads"].includes(args[0] ?? "");
  }
  return command !== "start" || isBundledStart;
}

export function packageVersion(packageRoot = ROOT): string {
  const manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as { version?: unknown };
  if (typeof manifest.version !== "string" || !manifest.version.trim()) {
    throw new Error("Relaybase package version is missing from package.json.");
  }
  return manifest.version;
}

interface WorkflowStep {
  name: string;
  command: string;
  args: string[];
  required?: boolean;
  blockerExitCode?: number;
  live?: boolean;
}

function isBundledStartArgs(args: string[]): boolean {
  const first = args[0];
  return first === undefined || first === "--" || first.startsWith("-");
}

async function startRelaybase(options: CliOptions, passthroughArgs: string[]): Promise<number> {
  if (options.plan) {
    printWorkflowPlan("relaybase start", [
      {
        name: "Launch TUI through Node bridge",
        command: "relaybase",
        args: ["tui", ...passthroughArgs]
      }
    ]);
    return 0;
  }

  return runRelaybaseTui(options, passthroughArgs);
}

async function daemonCommand(args: string[], options: CliOptions): Promise<number> {
  if (args[0] !== "restart") {
    throw new Error("Usage: relaybase daemon restart [--json]");
  }
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      continue;
    }
    if (arg === "--host" || arg === "--port" || arg === "--state-dir") {
      requiredArg(args[++index], arg);
      continue;
    }
    throw new Error(`Unsupported daemon restart argument: ${arg ?? ""}`);
  }
  const result = await restartDaemon(options);
  if (options.json) {
    console.log(JSON.stringify({ restart: result }, null, 2));
  } else {
    console.log(result.userAction);
    if (result.oldInstanceId && result.newInstanceId) {
      console.log(`Instance: ${result.oldInstanceId} -> ${result.newInstanceId}`);
    }
    for (const app of result.appResults ?? []) {
      console.log(`${app.status === "restored" ? "restored" : "attention"}: ${app.appId}`);
    }
    for (const warning of result.warnings ?? []) {
      console.log(`warning: ${warning}`);
    }
    if (result.reportPath) {
      console.log(`Restart report: ${result.reportPath}`);
    }
    if (result.error) {
      console.error(`Restart detail: ${result.error}`);
    }
  }
  return result.restarted || result.code === "daemon_started" ? 0 : 1;
}

async function checkRelaybase(options: CliOptions): Promise<number> {
  const sourceDoctor = scriptPath("tui-go.mjs");
  const sourceCheckout = existsSync(sourceDoctor);
  const steps: WorkflowStep[] = sourceCheckout
    ? [{ name: "TUI/toolchain doctor", command: process.execPath, args: [sourceDoctor, "doctor"] }]
    : [{ name: "Resolve installed TUI binary", command: "relaybase", args: ["start"] }];
  if (options.plan) {
    printWorkflowPlan("relaybase check", [
      ...steps,
      { name: "Project and daemon health", command: "relaybase", args: ["health"] },
      { name: "Registered apps and runtime state", command: "relaybase", args: ["list", "--verbose"] }
    ]);
    return 0;
  }

  console.log("Relaybase check");
  console.log(`Relaybase package: ${packageVersion()}`);
  let exitCode = 0;
  if (sourceCheckout) {
    for (const step of steps) {
      const status = runWorkflowStep(step, { allowLiveEnv: false });
      if (status !== 0) {
        exitCode = status;
      }
    }
    const resolution = await resolveTuiBinary();
    if (resolution.ok && resolution.path) {
      console.log(`TUI build: ${formatTuiBuildIdentity(resolution.path, resolution.source ?? "source checkout")}.`);
    } else {
      process.stderr.write(formatMissingTuiBinaryDiagnostic(resolution));
      exitCode = 1;
    }
  } else {
    console.log("");
    console.log("==> Installed TUI");
    const resolution = await resolveTuiBinary();
    if (resolution.ok && resolution.path) {
      console.log(
        `Installed TUI: ready (${formatTuiBuildIdentity(resolution.path, resolution.source ?? "packaged binary")}).`
      );
    } else {
      process.stderr.write(formatMissingTuiBinaryDiagnostic(resolution));
      exitCode = 1;
    }
  }

  try {
    await withNonLiveAgentEnv(() => health(options));
  } catch (error) {
    exitCode = 1;
    console.error(errorMessage(error));
  }

  try {
    await withNonLiveAgentEnv(() => listApps(options));
  } catch (error) {
    exitCode = 1;
    console.error(errorMessage(error));
  }

  return exitCode;
}

async function diagnoseToken(options: CliOptions): Promise<number> {
  const tokenPath = path.join(options.stateDir, "session-token");
  const tokenPresent = Boolean(readExistingSessionToken(options.stateDir));
  const daemon = await discovery(options);
  const result = {
    ok: daemon.compatible,
    diagnosis: daemon.code,
    client: {
      stateDir: options.stateDir,
      tokenPath,
      tokenPresent
    },
    daemon: {
      reachable: daemon.reachable,
      compatible: daemon.compatible,
      authenticated: daemon.authenticated,
      ...(daemon.daemonStateDir ? { stateDir: daemon.daemonStateDir } : {})
    },
    nextAction: tokenDiagnosisNextAction(daemon.code)
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("Relaybase token diagnosis");
    console.log(`Client state: ${result.client.stateDir}`);
    console.log(`Client token: ${tokenPresent ? "present" : "missing"}`);
    console.log(`Daemon: ${daemon.compatible ? "online" : daemon.reachable ? "degraded" : "offline"}`);
    if (daemon.daemonStateDir) {
      console.log(`Daemon state: ${daemon.daemonStateDir}`);
    }
    console.log(`State match: ${daemon.stateDirMatches ? "yes" : "no"}`);
    console.log(`Authentication: ${daemon.authenticated ? "accepted" : "not accepted"}`);
    console.log(`Diagnosis: ${daemon.code}`);
    console.log(`Next: ${result.nextAction}`);
    console.log("Token contents were not read from the daemon or printed.");
  }
  return daemon.compatible ? 0 : 1;
}

function tokenDiagnosisNextAction(code: string): string {
  switch (code) {
    case "daemon_state_mismatch":
      return "Use the running daemon state directory, or stop that daemon explicitly before selecting another state directory.";
    case "daemon_auth_missing":
      return "Restore read access to the selected state directory session-token, then retry relaybase start.";
    case "daemon_auth_invalid":
      return "Restart the client after confirming it uses the same state directory as the running daemon.";
    case "daemon_ready":
      return "No token repair is needed.";
    case "daemon_unreachable":
      return "Run relaybase start to start the daemon and TUI.";
    default:
      return "Inspect the configured host, port, and state directory before retrying.";
  }
}

function tuiBuildIdentity(binaryPath: string): string {
  try {
    return createHash("sha256").update(readFileSync(binaryPath)).digest("hex").slice(0, 12);
  } catch {
    return "unavailable";
  }
}

interface TuiEmbeddedBuildInfo {
  version: string;
  commit: string;
  builtAt: string;
  source: string;
}

function readTuiEmbeddedBuildInfo(binaryPath: string): TuiEmbeddedBuildInfo | undefined {
  const result = spawnSync(binaryPath, ["--build-info"], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 3000,
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
    return undefined;
  }
  try {
    const value = JSON.parse(result.stdout) as Partial<TuiEmbeddedBuildInfo>;
    if (![value.version, value.commit, value.builtAt, value.source].every((entry) => typeof entry === "string")) {
      return undefined;
    }
    return value as TuiEmbeddedBuildInfo;
  } catch {
    return undefined;
  }
}

function formatTuiBuildIdentity(binaryPath: string, resolvedSource: string): string {
  const hash = tuiBuildIdentity(binaryPath);
  const embedded = readTuiEmbeddedBuildInfo(binaryPath);
  if (!embedded) {
    return `${resolvedSource}; build ${hash}; embedded identity unavailable`;
  }
  return `${resolvedSource}; build ${hash}; version ${embedded.version}; source ${embedded.source}; commit ${embedded.commit}; built ${embedded.builtAt}`;
}

async function verifyRelaybase(options: CliOptions): Promise<number> {
  const steps = verifySteps(options);
  if (options.plan) {
    printWorkflowPlan("relaybase verify", steps);
    return 0;
  }

  let exitCode = 0;
  for (const step of steps) {
    const status = runWorkflowStep(step, { allowLiveEnv: step.live === true });
    if (status !== 0) {
      exitCode = step.blockerExitCode ?? status;
      if (step.required !== false) {
        break;
      }
    }
  }
  return exitCode;
}

function verifySteps(options: CliOptions): WorkflowStep[] {
  const steps: WorkflowStep[] = [
    npmStep("format:check"),
    npmStep("lint"),
    npmStep("typecheck"),
    npmStep("test"),
    npmStep("test:jest"),
    npmStep("smoke")
  ];

  const includeFull = options.full || options.all;
  const includeRelease = options.release || options.all;
  const includeLive = options.live;

  if (includeFull) {
    steps.push(
      npmStep("agent:test"),
      npmStep("tui:build"),
      npmStep("tui:test"),
      npmStep("tui:vet"),
      npmStep("tui:snapshot"),
      npmStep("tui:smoke"),
      npmStep("tui:smoke:8pane"),
      npmStep("package:check"),
      npmStep("verify:clean-worktree")
    );
  }

  if (options.race) {
    steps.push(npmStep("tui:race", { blockerExitCode: 2 }));
  }

  if (includeRelease) {
    steps.push(npmStep("release:check", { blockerExitCode: 2 }));
  }

  if (includeLive) {
    steps.push(
      npmStep("agent:smoke:openrouter", { blockerExitCode: 2, live: true }),
      npmStep("agent:live:folder-start", { blockerExitCode: 2, live: true }),
      npmStep("agent:live:acceptance", { blockerExitCode: 2, live: true }),
      npmStep("agent:live:command-matrix", { blockerExitCode: 2, live: true })
    );
  }

  return steps;
}

function npmStep(script: string, options: Partial<WorkflowStep> = {}): WorkflowStep {
  const runner = npmRunner();
  return {
    name: `npm run ${script}`,
    command: runner.command,
    args: [...runner.args, "run", script],
    ...options
  };
}

function npmRunner(): { command: string; args: string[] } {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) {
    return { command: process.execPath, args: [npmExecPath] };
  }
  if (process.platform === "win32") {
    return { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", "npm.cmd"] };
  }
  return { command: "npm", args: [] };
}

function repairRelaybaseCommandPrefix(options: CliOptions): number {
  const runner = npmRunner();
  if (options.plan) {
    printWorkflowPlan("relaybase repair-prefix", [
      {
        name: "Inspect the current relaybase command target",
        command: "relaybase",
        args: ["repair-prefix", "--diagnose"]
      },
      {
        name: "Link this source checkout into the npm global prefix",
        command: runner.command,
        args: [...runner.args, "link", "--no-audit", "--no-fund"]
      },
      {
        name: "On Windows, remove relaybase.ps1 only when its relaybase.cmd sibling exists",
        command: "relaybase",
        args: ["repair-prefix"]
      },
      {
        name: "Verify the relaybase command targets this source checkout",
        command: "relaybase",
        args: ["repair-prefix", "--diagnose"]
      }
    ]);
    return 0;
  }

  if (!isSourceCheckout()) {
    console.error("Relaybase prefix: repair requires a Relaybase source checkout.");
    return 1;
  }

  const commandVisible = relaybaseCommandVisible();
  const targetsSourceCheckout = commandVisible && relaybaseCommandTargetsSourceCheckout();
  console.log(`Relaybase command visible: ${commandVisible ? "yes" : "no"}`);
  console.log(`Relaybase command targets this source checkout: ${targetsSourceCheckout ? "yes" : "no"}`);

  if (options.diagnose) {
    if (!targetsSourceCheckout) {
      console.log("Repair available: relaybase repair-prefix");
    }
    return targetsSourceCheckout ? 0 : 1;
  }

  if (!targetsSourceCheckout) {
    console.error(
      commandVisible
        ? "Relaybase prefix: linking this source checkout because `relaybase` points to another install."
        : "Relaybase prefix: linking this source checkout because `relaybase` is not available on PATH."
    );
    const result = spawnSync(runner.command, [...runner.args, "link", "--no-audit", "--no-fund"], {
      cwd: ROOT,
      stdio: "inherit",
      shell: false,
      env: process.env
    });

    if (result.error || result.status !== 0) {
      console.error(
        [
          "Relaybase prefix: explicit npm link did not complete.",
          result.error ? `Reason: ${result.error.message}` : `Exit code: ${result.status ?? 1}`,
          "No startup workflow was attempted."
        ].join("\n")
      );
      return result.status ?? 1;
    }
  }

  if (!relaybaseCommandVisible() || !relaybaseCommandTargetsSourceCheckout()) {
    console.error(
      [
        "Relaybase prefix: npm link completed, but `relaybase` is still not linked to this source checkout.",
        `Global npm prefix: ${globalNpmPrefix() ?? "unknown"}`,
        "Open a new terminal, make sure the npm global prefix is on PATH, or continue with: npm.cmd start"
      ].join("\n")
    );
    return 1;
  }

  const shimRepairSucceeded = repairWindowsPowerShellShim();
  if (shimRepairSucceeded) {
    console.log("Relaybase prefix: `relaybase` command is linked and ready.");
  }
  return shimRepairSucceeded ? 0 : 1;
}

function isSourceCheckout(): boolean {
  return existsSync(path.join(ROOT, "package.json")) && existsSync(path.join(ROOT, "bin", "relaybase.cjs"));
}

function relaybaseCommandVisible(): boolean {
  if (process.platform === "win32") {
    return windowsRelaybaseCmdVisible();
  }

  const result = spawnSync("sh", ["-c", "command -v relaybase"], {
    cwd: ROOT,
    encoding: "utf8",
    shell: false,
    env: process.env
  });
  return !result.error && result.status === 0 && String(result.stdout ?? "").trim().length > 0;
}

function relaybaseCommandTargetsSourceCheckout(): boolean {
  const packageRoot = globalRelaybasePackageRoot();
  if (!packageRoot || !existsSync(packageRoot)) {
    return false;
  }

  try {
    return samePath(realpathSync(packageRoot), realpathSync(ROOT));
  } catch {
    return false;
  }
}

function globalRelaybasePackageRoot(): string | undefined {
  const prefix = globalNpmPrefix();
  if (!prefix) {
    return undefined;
  }

  const [scope, name] = PACKAGE_NAME.split("/");
  return name ? path.join(prefix, "node_modules", scope, name) : path.join(prefix, "node_modules", PACKAGE_NAME);
}

function samePath(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === "win32"
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function windowsRelaybaseCmdVisible(): boolean {
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-Command", "(Get-Command relaybase.cmd -ErrorAction SilentlyContinue).Source"],
    {
      cwd: ROOT,
      encoding: "utf8",
      shell: false,
      env: process.env
    }
  );
  return !result.error && result.status === 0 && String(result.stdout ?? "").trim().length > 0;
}

function repairWindowsPowerShellShim(): boolean {
  if (process.platform !== "win32" || process.env.RELAYBASE_KEEP_POWERSHELL_SHIM === "1") {
    return true;
  }

  let succeeded = true;
  for (const prefix of npmGlobalBinDirectories()) {
    const ps1Shim = path.join(prefix, "relaybase.ps1");
    const cmdShim = path.join(prefix, "relaybase.cmd");
    if (!existsSync(ps1Shim) || !existsSync(cmdShim)) {
      continue;
    }

    const repair = removeRecognizedRelaybasePowerShellShim(ps1Shim, cmdShim);
    if (repair.removed) {
      console.error(
        "Relaybase prefix: removed generated PowerShell relaybase.ps1 shim; PowerShell will use relaybase.cmd."
      );
      continue;
    }
    succeeded = false;
    console.error(
      repair.reason === "unrecognized"
        ? "Relaybase prefix: preserved relaybase.ps1 because it is not a recognized npm-generated Relaybase shim."
        : [
            "Relaybase prefix: relaybase.ps1 could not be safely removed.",
            ...(repair.error ? [`Reason: ${repair.error}`] : []),
            "Use relaybase.cmd start, npm.cmd start, or inspect the PowerShell shim manually."
          ].join("\n")
    );
  }
  return succeeded;
}

function npmGlobalBinDirectories(): string[] {
  const candidates = [
    globalNpmPrefix(),
    process.platform === "win32" && process.env.APPDATA ? path.join(process.env.APPDATA, "npm") : undefined
  ].filter((entry): entry is string => Boolean(entry));
  return [...new Set(candidates.map((entry) => path.resolve(entry)))];
}

function globalNpmPrefix(): string | undefined {
  const runner = npmRunner();
  const result = spawnSync(runner.command, [...runner.args, "config", "get", "prefix"], {
    cwd: ROOT,
    encoding: "utf8",
    shell: false,
    env: process.env
  });
  if (result.error || result.status !== 0) {
    return undefined;
  }
  return String(result.stdout ?? "").trim() || undefined;
}

function scriptPath(name: string): string {
  return path.join(ROOT, "scripts", name);
}

function runWorkflowStep(step: WorkflowStep, options: { allowLiveEnv?: boolean } = {}): number {
  console.log("");
  console.log(`==> ${step.name}`);
  const result = spawnSync(step.command, step.args, {
    cwd: ROOT,
    stdio: "inherit",
    shell: false,
    env: options.allowLiveEnv === false ? nonLiveAgentEnv(process.env) : process.env
  });
  if (result.error) {
    console.error(`${step.name} failed to launch: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

function nonLiveAgentEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const name of AGENT_LIVE_ENV_NAMES) {
    env[name] = "";
  }
  env.RELAYBASE_AGENT_ENABLED = "0";
  env.RELAYBASE_AGENT_REMOTE_MODEL_ENABLED = "0";
  return env;
}

async function withNonLiveAgentEnv<T>(callback: () => Promise<T>): Promise<T> {
  const previous = new Map(AGENT_LIVE_ENV_NAMES.map((name) => [name, process.env[name]]));
  const env = nonLiveAgentEnv(process.env);
  for (const name of AGENT_LIVE_ENV_NAMES) {
    process.env[name] = env[name];
  }
  try {
    return await callback();
  } finally {
    for (const [name, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

function printWorkflowPlan(title: string, steps: WorkflowStep[]): void {
  console.log(title);
  console.log("");
  for (const [index, step] of steps.entries()) {
    console.log(`${index + 1}. ${step.name}`);
    console.log(`   ${step.command} ${step.args.join(" ")}`.trimEnd());
  }
}

async function serve(options: CliOptions): Promise<void> {
  const server = await createRelaybaseServer(options);
  await server.listen();
  const address = server.address();

  console.log(`Relaybase listening on http://${address.host}:${address.port}/__hub`);
  console.log(`MCP: http://${address.host}:${address.port}/mcp`);
  console.log(`State: ${server.runtime.stateDir}`);

  process.once("SIGINT", () => {
    void server.close().then(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void server.close().then(() => process.exit(0));
  });
}

async function mcp(options: CliOptions): Promise<void> {
  const server = await createRelaybaseServer(options);
  await server.runtime.mcp.connectStdio();

  process.once("SIGINT", () => {
    void server.close().then(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void server.close().then(() => process.exit(0));
  });
}

async function agent(args: string[], options: CliOptions): Promise<void> {
  const subcommand = args[0];
  if (subcommand === "config") {
    const action = args[1] ?? "status";
    if (action !== "status" && action !== "reload") {
      throw new Error("Usage: relaybase agent config <status|reload> [--json]");
    }
    const response = await agentApiRequest(
      options,
      action === "status" ? "GET" : "POST",
      action === "status" ? "/__hub/api/agent/config" : "/__hub/api/agent/config/reload",
      action === "reload" ? {} : undefined
    );
    printAgentApiResponse(response, options);
    return;
  }

  if (subcommand === "provider") {
    await agentProvider(args.slice(1), options);
    return;
  }

  if (subcommand === "smoke-openrouter") {
    try {
      const result = await runOpenRouterLiveSmoke();
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      printOpenRouterLiveSmokeResult(result);
      return;
    } catch (error) {
      throw new Error(formatOpenRouterLiveSmokeError(error), { cause: error });
    }
  }

  if (subcommand === "live-acceptance" || subcommand === "live-correctness") {
    try {
      if (args.includes("--preflight")) {
        const preflight = agentLiveCorrectnessPreflight();
        console.log(JSON.stringify(preflight, null, 2));
        return;
      }
      const result = await runAgentLiveAcceptance();
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      printAgentLiveAcceptanceResult(result);
      return;
    } catch (error) {
      throw new Error(formatAgentLiveAcceptanceError(error), { cause: error });
    }
  }

  if (subcommand === "live-command-matrix") {
    try {
      const result = await runAgentLiveCommandMatrix();
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      printAgentLiveCommandMatrixResult(result);
      return;
    } catch (error) {
      throw new Error(formatAgentLiveCommandMatrixError(error), { cause: error });
    }
  }

  if (subcommand === "live-folder-start") {
    try {
      const result = await runAgentFolderStartLive();
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      printAgentFolderStartLiveResult(result);
      return;
    } catch (error) {
      throw new Error(formatAgentFolderStartLiveError(error), { cause: error });
    }
  }

  if (subcommand === "threads") {
    await agentThreads(args.slice(1), options);
    return;
  }

  throw new Error(
    "Usage: relaybase agent <config|provider|smoke-openrouter|live-correctness|live-acceptance|live-command-matrix|live-folder-start|threads>"
  );
}

async function agentProvider(args: string[], options: CliOptions): Promise<void> {
  const action = args[0] ?? "status";
  if (action === "status") {
    printAgentApiResponse(
      await agentApiRequest(options, "GET", "/__hub/api/agent/provider/openrouter/status"),
      options
    );
    return;
  }
  if (action === "connect" || action === "replace") {
    const response = await agentApiRequest(options, "POST", `/__hub/api/agent/provider/openrouter/${action}`, {
      openBrowser: !options.noBrowser
    });
    printAgentApiResponse(response, options);
    if (!options.json && !options.noBrowser) {
      const authorizationUrl = nestedString(response, ["agent", "provider", "attempt", "authorizationUrl"]);
      const browserOpen = nestedString(response, ["agent", "provider", "attempt", "browserOpen"]);
      if (browserOpen === "opened") {
        console.log("Opened OpenRouter authorization in the default browser.");
      } else if (authorizationUrl) {
        console.log(`Open this URL to continue: ${authorizationUrl}`);
      }
    }
    return;
  }
  if (action === "disconnect") {
    if (!options.yes) {
      throw new Error(
        "Disconnect is local-only and leaves the OpenRouter key active. Re-run with --yes after reviewing this effect."
      );
    }
    printAgentApiResponse(
      await agentApiRequest(options, "POST", "/__hub/api/agent/provider/openrouter/disconnect", {
        confirm: "disconnect_local_only"
      }),
      options
    );
    return;
  }
  if (action === "validate") {
    printAgentApiResponse(
      await agentApiRequest(options, "POST", "/__hub/api/agent/provider/openrouter/validate", {}),
      options
    );
    return;
  }
  if (action === "migrate") {
    if (!options.yes) {
      throw new Error(
        "Migration copies the legacy credential into Windows DPAPI storage without editing .env. Re-run with --yes."
      );
    }
    printAgentApiResponse(
      await agentApiRequest(options, "POST", "/__hub/api/agent/provider/openrouter/migrate", {
        confirm: "migrate_to_windows_dpapi"
      }),
      options
    );
    return;
  }
  if (action === "revoke") {
    if (!options.yes) {
      printAgentApiResponse(
        await agentApiRequest(options, "POST", "/__hub/api/agent/provider/openrouter/revoke/preview", {}),
        options
      );
      return;
    }
    printAgentApiResponse(
      await agentApiRequest(options, "POST", "/__hub/api/agent/provider/openrouter/revoke", {
        confirm: "open_provider_key_management"
      }),
      options
    );
    return;
  }
  if (action === "cleanup-legacy") {
    const preview = await agentApiRequest(
      options,
      "POST",
      "/__hub/api/agent/provider/openrouter/legacy-removal/preview",
      {}
    );
    if (!options.yes) {
      printAgentApiResponse(preview, options);
      return;
    }
    const previewId = nestedString(preview, ["agent", "provider", "legacyRemoval", "previewId"]);
    if (!previewId) {
      throw new Error("The daemon did not return a bound legacy credential removal preview.");
    }
    printAgentApiResponse(
      await agentApiRequest(options, "POST", "/__hub/api/agent/provider/openrouter/legacy-removal/apply", {
        confirm: "remove_legacy_external_credential",
        previewId
      }),
      options
    );
    return;
  }
  throw new Error(
    "Usage: relaybase agent provider <status|connect|replace|validate|migrate|cleanup-legacy|disconnect|revoke> [--yes] [--json]"
  );
}

function nestedString(body: unknown, keys: string[]): string | undefined {
  let value: unknown = body;
  for (const key of keys) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    value = (value as Record<string, unknown>)[key];
  }
  return typeof value === "string" && value ? value : undefined;
}

async function agentThreads(args: string[], options: CliOptions): Promise<void> {
  const subcommand = args[0] ?? "list";
  if (subcommand === "list") {
    const response = await agentApiRequest(options, "GET", "/__hub/api/agent/sessions");
    printAgentApiResponse(response, options);
    return;
  }
  if (subcommand === "active") {
    const response = await agentApiRequest(options, "GET", "/__hub/api/agent/sessions/active");
    printAgentApiResponse(response, options);
    return;
  }
  if (subcommand === "show") {
    const sessionId = requiredArg(args[1], "agent threads show");
    const response = await agentApiRequest(
      options,
      "GET",
      `/__hub/api/agent/sessions/${encodeURIComponent(sessionId)}`
    );
    printAgentApiResponse(response, options);
    return;
  }
  if (subcommand === "context") {
    const sessionId = requiredArg(args[1], "agent threads context");
    const response = await agentApiRequest(
      options,
      "GET",
      `/__hub/api/agent/sessions/${encodeURIComponent(sessionId)}/context-preview`
    );
    printAgentApiResponse(response, options);
    return;
  }
  if (subcommand === "activate") {
    const sessionId = requiredArg(args[1], "agent threads activate");
    const response = await agentApiRequest(
      options,
      "POST",
      `/__hub/api/agent/sessions/${encodeURIComponent(sessionId)}/activate`,
      {}
    );
    printAgentApiResponse(response, options);
    return;
  }
  if (subcommand === "rename") {
    const sessionId = requiredArg(args[1], "agent threads rename");
    const title = requiredArg(args[2], "agent threads rename <session-id> <title>");
    const response = await agentApiRequest(
      options,
      "PATCH",
      `/__hub/api/agent/sessions/${encodeURIComponent(sessionId)}`,
      {
        title
      }
    );
    printAgentApiResponse(response, options);
    return;
  }
  if (subcommand === "clear") {
    const sessionId = requiredArg(args[1], "agent threads clear");
    const response = await agentApiRequest(
      options,
      "POST",
      `/__hub/api/agent/sessions/${encodeURIComponent(sessionId)}/clear`,
      {}
    );
    printAgentApiResponse(response, options);
    return;
  }
  if (subcommand === "export") {
    const sessionId = requiredArg(args[1], "agent threads export");
    const format = args.includes("--markdown") || args.includes("--format=markdown") ? "markdown" : "json";
    const response = await agentApiRequest(
      options,
      "GET",
      `/__hub/api/agent/sessions/${encodeURIComponent(sessionId)}/export?format=${format}`
    );
    printAgentApiResponse(response, options);
    return;
  }
  throw new Error(
    "Usage: relaybase agent threads <list|active|show|context|activate|rename|clear|export> [session-id]"
  );
}

async function agentApiRequest(
  options: CliOptions,
  method: string,
  pathName: string,
  body?: unknown,
  timeoutMs = DEFAULT_API_TIMEOUT_MS
): Promise<Record<string, unknown>> {
  const response = await apiRequest(
    options,
    method,
    pathName,
    body,
    await getOrCreateSessionToken(options.stateDir),
    timeoutMs
  );
  if (!response.ok) {
    throw new Error(response.body || `Relaybase Agent Gateway request failed: ${method} ${pathName}`);
  }
  return JSON.parse(response.body) as Record<string, unknown>;
}

function printAgentApiResponse(response: Record<string, unknown>, options: CliOptions): void {
  if (options.json) {
    console.log(JSON.stringify(response, null, 2));
    return;
  }
  console.log(JSON.stringify(response, null, 2));
}

async function repairRelaybase(options: CliOptions): Promise<number> {
  try {
    validateRepairOptions(options);
    if (options.repairOperationId) {
      const operation = repairOperationFromResponse(
        await repairApiRequest(
          options,
          "GET",
          `/__hub/api/agent/security/repair/operations/${encodeURIComponent(options.repairOperationId)}`
        )
      );
      printRepairOperation(operation, options);
      return repairOperationExitCode(operation);
    }

    if (options.repairPreviewId) {
      const preview = repairPreviewFromResponse(
        await repairApiRequest(
          options,
          "GET",
          `/__hub/api/agent/security/repair/previews/${encodeURIComponent(options.repairPreviewId)}`
        )
      );
      return applyRepairPreview(preview, options);
    }

    if (options.repairAction || options.safe) {
      const preview = repairPreviewFromResponse(
        await repairApiRequest(options, "POST", "/__hub/api/agent/security/repair/preview", {
          ...(options.repairAction ? { actionIds: [options.repairAction] } : {}),
          ...(options.repairIssue ? { issueCodes: [options.repairIssue] } : {}),
          safe: options.safe,
          online: options.online
        })
      );
      if (options.plan || !options.yes) {
        printRepairPreview(preview, options);
        return preview.actions.some((action) => action.riskClass === "manual" || action.riskClass === "external")
          ? 3
          : 2;
      }
      return applyRepairPreview(preview, options);
    }

    const status = repairStatusFromResponse(
      await repairApiRequest(options, "POST", "/__hub/api/agent/security/diagnose", {
        online: options.online
      })
    );
    const filtered = options.repairIssue
      ? { ...status, findings: status.findings.filter((finding) => finding.code === options.repairIssue) }
      : status;
    if (options.repairIssue && filtered.findings.length === 0) {
      throw new AgentRepairCliError(404, `No Agent security finding matched ${options.repairIssue}.`);
    }

    if (
      !options.json &&
      !options.plan &&
      !options.yes &&
      !options.repairIssue &&
      process.stdin.isTTY &&
      process.stdout.isTTY
    ) {
      const interactive = await interactiveRepair(filtered, options);
      if (interactive !== undefined) {
        return interactive;
      }
    }
    printRepairStatus(filtered, options);
    return repairStatusExitCode(filtered);
  } catch (error) {
    const cliError = repairCliError(error);
    const exitCode = repairErrorExitCode(cliError);
    const outcome = exitCode === 4 ? "stale" : exitCode === 2 ? "findings" : "error";
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            outcome,
            healthy: false,
            issueCount: 0,
            remainingIssueCodes: [],
            operationId: null,
            error: { code: cliError.code ?? "RELAYBASE_REPAIR_FAILED", message: cliError.message }
          },
          null,
          2
        )
      );
    } else {
      console.error(`${cliError.code ? `${cliError.code}: ` : ""}${cliError.message}`);
    }
    return exitCode;
  }
}

function validateRepairOptions(options: CliOptions): void {
  if (
    options.repairOperationId &&
    (options.repairPreviewId || options.repairAction || options.safe || options.repairIssue)
  ) {
    throw new Error("--operation cannot be combined with --apply, --action, --safe, or --issue.");
  }
  if (options.repairPreviewId && (options.repairAction || options.safe || options.repairIssue || options.online)) {
    throw new Error("--apply cannot be combined with --action, --safe, --issue, or --online.");
  }
  if (options.repairAction && options.safe) {
    throw new Error("Use either --action or --safe, not both.");
  }
  if (options.repairPreviewId && !options.yes) {
    throw new AgentRepairCliError(
      400,
      "--apply requires --yes because it authorizes the exact stored preview.",
      "AGENT_SECURITY_REPAIR_CONFIRMATION_REQUIRED"
    );
  }
  if (options.json && !options.yes && (options.repairAction || options.safe)) {
    options.plan = true;
  }
}

async function repairApiRequest(
  options: CliOptions,
  method: string,
  pathName: string,
  body?: unknown
): Promise<Record<string, unknown>> {
  const response = await apiRequest(
    options,
    method,
    pathName,
    body,
    await getOrCreateSessionToken(options.stateDir),
    STATE_API_TIMEOUT_MS
  );
  if (!response.ok) {
    const parsed = safeJsonObject(response.body);
    const detail = objectAt(parsed, ["relaybaseError"]) ?? objectAt(parsed, ["error"]) ?? parsed;
    const code = stringAt(detail, ["code"]);
    const message =
      stringAt(detail, ["message"]) ??
      stringAt(parsed, ["message"]) ??
      (response.statusCode === 0
        ? "Relaybase daemon is unavailable. Start it through the existing Relaybase launcher, then retry."
        : `Relaybase Agent security request failed: ${method} ${pathName}`);
    throw new AgentRepairCliError(response.statusCode, message, code);
  }
  return safeJsonObject(response.body);
}

async function interactiveRepair(status: AgentSecurityStatus, options: CliOptions): Promise<number | undefined> {
  const findings = status.findings.filter((finding) => finding.state !== "healthy");
  if (findings.length === 0) {
    return undefined;
  }
  printRepairStatus(status, options);
  const findingIndex = await arrowSelect(
    "Choose an Agent security finding",
    findings.map((finding) => `${finding.state.toUpperCase()} ${finding.title} · ${finding.repairability}`),
    0
  );
  const finding = findings[findingIndex]!;
  const actions = [finding.recommendedActionId, ...(finding.alternateActionIds ?? [])].filter(
    (action): action is AgentSecurityRepairActionId => Boolean(action)
  );
  if (actions.length === 0) {
    console.log(finding.userAction ?? "This finding requires a manual action.");
    return 3;
  }
  const actionIndex =
    actions.length === 1
      ? 0
      : await arrowSelect(
          "Choose a repair or recovery action",
          actions.map((action) => action.replaceAll("_", " ")),
          0
        );
  const preview = repairPreviewFromResponse(
    await repairApiRequest(options, "POST", "/__hub/api/agent/security/repair/preview", {
      actionIds: [actions[actionIndex]],
      issueCodes: [finding.code],
      online: options.online
    })
  );
  printRepairPreview(preview, options);
  const confirmed = preview.confirmation.phrase
    ? (await askText(`Type ${preview.confirmation.phrase} to continue`, "")) === preview.confirmation.phrase
    : await askConfirmation("Apply this exact Agent security repair?");
  if (!confirmed) {
    console.log("Repair cancelled before apply; no state changed.");
    return 2;
  }
  return applyRepairPreview(preview, { ...options, yes: true });
}

async function applyRepairPreview(preview: AgentSecurityRepairPreview, options: CliOptions): Promise<number> {
  if (!options.yes) {
    printRepairPreview(preview, options);
    return 2;
  }
  const operation = repairOperationFromResponse(
    await repairApiRequest(options, "POST", "/__hub/api/agent/security/repair/apply", {
      previewId: preview.previewId,
      idempotencyKey: randomUUID(),
      confirmation: preview.confirmation.value
    })
  );
  printRepairOperation(operation, options);
  return repairOperationExitCode(operation);
}

function repairStatusFromResponse(response: Record<string, unknown>): AgentSecurityStatus {
  return requiredNestedObject(
    response,
    ["agent", "security"],
    "Agent security diagnosis"
  ) as unknown as AgentSecurityStatus;
}

function repairPreviewFromResponse(response: Record<string, unknown>): AgentSecurityRepairPreview {
  return requiredNestedObject(
    response,
    ["agent", "security", "repair", "preview"],
    "Agent security repair preview"
  ) as unknown as AgentSecurityRepairPreview;
}

function repairOperationFromResponse(response: Record<string, unknown>): AgentSecurityRepairOperation {
  return requiredNestedObject(
    response,
    ["agent", "security", "repair", "operation"],
    "Agent security repair operation"
  ) as unknown as AgentSecurityRepairOperation;
}

function requiredNestedObject(value: Record<string, unknown>, keys: string[], label: string): Record<string, unknown> {
  const result = objectAt(value, keys);
  if (!result) {
    throw new AgentRepairCliError(500, `${label} was missing from the daemon response.`);
  }
  return result;
}

function printRepairStatus(status: AgentSecurityStatus, options: CliOptions): void {
  const remaining = status.findings.filter((finding) => finding.state !== "healthy");
  const result = {
    outcome: status.healthy && remaining.length === 0 ? "healthy" : "findings",
    healthy: status.healthy && remaining.length === 0,
    issueCount: remaining.length,
    remainingIssueCodes: remaining.map((finding) => finding.code),
    operationId: null,
    scope: status.scope,
    checkedAt: status.checkedAt,
    online: status.online,
    findings: status.findings
  };
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Relaybase repair · Agent security · ${result.outcome}`);
  console.log(`Checked: ${status.checkedAt} · ${remaining.length} issue${remaining.length === 1 ? "" : "s"}`);
  for (const finding of status.findings) {
    console.log(`${finding.state.toUpperCase()} ${finding.code}: ${finding.title}`);
    console.log(`  ${finding.message}`);
    if (finding.userAction) {
      console.log(`  Next: ${finding.userAction}`);
    }
  }
}

function printRepairPreview(preview: AgentSecurityRepairPreview, options: CliOptions): void {
  const issueCodes = preview.findings.filter((finding) => finding.state !== "healthy").map((finding) => finding.code);
  const result = {
    outcome: "confirmation_required",
    healthy: false,
    issueCount: issueCodes.length,
    remainingIssueCodes: issueCodes,
    operationId: null,
    preview
  };
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Agent security repair preview ${preview.previewId}`);
  console.log(`Expires: ${preview.expiresAt}`);
  for (const action of preview.actions) {
    console.log(`${action.title} · ${action.riskClass}`);
    console.log(`  Changes: ${action.changes.join(" ")}`);
    console.log(`  Preserves: ${action.preserves.join(" ")}`);
    console.log(
      `  Network: ${action.requiresNetwork ? "yes" : "no"} · Restart: ${
        action.requiresRestart ? "yes" : "no"
      } · Reversible: ${action.reversible ? "yes" : "no"}`
    );
  }
  if (preview.confirmation.warning) {
    console.log(`Warning: ${preview.confirmation.warning}`);
  }
  console.log(`Apply: relaybase repair --agent-security --apply ${preview.previewId} --yes`);
}

function printRepairOperation(operation: AgentSecurityRepairOperation, options: CliOptions): void {
  const result = {
    outcome: operation.outcome,
    healthy: operation.outcome === "verified",
    issueCount: operation.remainingIssueCodes.length,
    remainingIssueCodes: operation.remainingIssueCodes,
    operationId: operation.operationId,
    operation
  };
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Agent security repair ${operation.outcome}`);
  console.log(`Operation: ${operation.operationId}`);
  console.log(`Applied: ${operation.appliedActionIds.join(", ") || "none"}`);
  console.log(`Remaining: ${operation.remainingIssueCodes.join(", ") || "none"}`);
  if (operation.requiresExternalAction) {
    console.log("A provider-owned or manual action is still required.");
  }
  if (operation.requiresRestart) {
    console.log("A safe daemon restart is still required.");
  }
}

function repairStatusExitCode(status: AgentSecurityStatus): number {
  const remaining = status.findings.filter((finding) => finding.state !== "healthy");
  if (remaining.length === 0) {
    return 0;
  }
  return remaining.some((finding) => finding.repairability === "manual" || finding.repairability === "external")
    ? 3
    : 2;
}

function repairOperationExitCode(operation: AgentSecurityRepairOperation): number {
  if (operation.outcome === "verified") {
    return 0;
  }
  if (operation.requiresExternalAction || operation.outcome === "blocked") {
    return 3;
  }
  return operation.outcome === "failed" ? 1 : 2;
}

function repairCliError(error: unknown): AgentRepairCliError {
  if (error instanceof AgentRepairCliError) {
    return error;
  }
  return new AgentRepairCliError(500, error instanceof Error ? error.message : String(error));
}

function repairErrorExitCode(error: AgentRepairCliError): number {
  if (error.code === "AGENT_SECURITY_REPAIR_PREVIEW_STALE") {
    return 4;
  }
  if (
    [
      "AGENT_SECURITY_REPAIR_ACTION_REQUIRED",
      "AGENT_SECURITY_REPAIR_ACTION_NOT_APPLICABLE",
      "AGENT_SECURITY_REPAIR_SAFE_SCOPE_INVALID",
      "AGENT_SECURITY_REPAIR_CONFIRMATION_REQUIRED",
      "AGENT_SECURITY_REPAIR_CONFLICT",
      "AGENT_SECURITY_REPAIR_NOT_CANCELLABLE"
    ].includes(error.code ?? "")
  ) {
    return 2;
  }
  return 1;
}

function safeJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function objectAt(value: unknown, keys: string[]): Record<string, unknown> | undefined {
  let current = value;
  for (const key of keys) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current && typeof current === "object" && !Array.isArray(current)
    ? (current as Record<string, unknown>)
    : undefined;
}

function stringAt(value: unknown, keys: string[]): string | undefined {
  let current = value;
  for (const key of keys) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" && current ? current : undefined;
}

async function register(manifestPath: string | undefined, options: CliOptions): Promise<void> {
  if (!manifestPath) {
    throw new Error(
      "Usage: relaybase register <project-folder|relaybase.app.json> [--plan|--yes] [--no-verify] [--json]"
    );
  }
  const daemon = await ensureDaemon(options, options.daemonStartPolicy === "auto");
  if (!daemon.compatible) {
    throw new Error(`${daemon.userAction}${daemon.error ? ` (${daemon.error})` : ""}`);
  }
  const mode = path.basename(manifestPath).toLowerCase() === "relaybase.app.json" ? "manifest" : "folder";
  const previewResponse = await apiRequest(
    options,
    "POST",
    "/__hub/api/setup/register/preview",
    { path: manifestPath, mode, cwd: options.cwd, verificationMode: options.noVerify ? "none" : "quick" },
    undefined,
    STATE_API_TIMEOUT_MS
  );
  if (!previewResponse.ok) {
    throw new Error(previewResponse.body || "Registration preview failed.");
  }
  const previewEnvelope = JSON.parse(previewResponse.body) as { setup: Record<string, unknown> };
  const preview = previewEnvelope.setup;
  if (options.json) {
    console.log(JSON.stringify(preview, null, 2));
  } else if (options.plan) {
    console.log(formatRegistrationPlan(preview));
  } else {
    printRegistrationPreview(preview);
  }
  if (String(preview.status).startsWith("registered_") || options.plan || options.dryRun) {
    return;
  }
  if (preview.approval && (preview.approval as { required?: boolean }).required !== true) {
    throw new Error(String(preview.message ?? "Registration cannot continue from this state."));
  }
  const confirmed =
    options.yes ||
    (process.stdin.isTTY &&
      (await askConfirmation(
        options.noVerify
          ? "Register without lifecycle verification?"
          : "Register, start once, check health, stop, and verify backend-port closure?"
      )));
  if (!confirmed) {
    throw new Error(
      "REGISTER_CONFIRMATION_REQUIRED: no files or registry state were changed. Re-run with --yes after reviewing --plan."
    );
  }
  const token = await getOrCreateSessionToken(options.stateDir);
  const applyResponse = await apiRequest(
    options,
    "POST",
    "/__hub/api/setup/register/apply",
    {
      previewId: preview.previewId,
      confirm: true,
      confirmation: { confirmed: true, reason: options.yes ? "CLI --yes" : "CLI interactive confirmation" }
    },
    token,
    STATE_API_TIMEOUT_MS
  );
  if (!applyResponse.ok) {
    throw new Error(applyResponse.body || "Registration apply failed.");
  }
  const applied = (JSON.parse(applyResponse.body) as { setup: Record<string, unknown> }).setup;
  if (options.json) {
    console.log(JSON.stringify(applied, null, 2));
    return;
  }
  printRegistrationResult(applied);
}

function printRegistrationPreview(preview: Record<string, unknown>): void {
  console.log(String(preview.message ?? "Registration preview ready."));
  const app = preview.app as
    | { id?: string; name?: string; launch?: { executable?: string; args?: string[]; portBinding?: string } }
    | undefined;
  if (app) {
    console.log(`App: ${app.id ?? "unknown"}${app.name ? ` (${app.name})` : ""}`);
    if (app.launch) {
      console.log(`Launch: ${app.launch.executable ?? "unknown"} ${(app.launch.args ?? []).join(" ")}`.trim());
      console.log(`Port binding: ${app.launch.portBinding ?? "environment"}`);
    }
  }
  console.log(`Manifest: ${String(preview.manifestPath ?? "unknown")}`);
  const verification = preview.verificationIntent as
    | {
        mode?: string;
        willStart?: boolean;
        willStop?: boolean;
        expectedMaximumMs?: number;
        healthCandidates?: string[];
      }
    | undefined;
  if (verification?.mode === "quick") {
    console.log("Verification: one bounded start, health check, stop, and backend-port closure check.");
    if (verification.healthCandidates?.length) {
      console.log(`Health targets: ${verification.healthCandidates.join(", ")}`);
    }
    console.log(`Expected maximum: ${verification.expectedMaximumMs ?? "unknown"}ms. No app will be left running.`);
  } else {
    console.log("Verification: disabled. The app will be registered without a launch-readiness claim.");
  }
}

function printRegistrationResult(applied: Record<string, unknown>): void {
  const app = applied.app as { id?: string; name?: string } | undefined;
  const label = `${app?.id ?? "app"}${app?.name ? ` (${app.name})` : ""}`;
  const verification = applied.verification as
    | {
        status?: string;
        assignedPort?: number;
        health?: { successfulTarget?: string; statusCode?: number };
        stop?: { portClosureVerified?: boolean; backendPortOpen?: boolean | null };
        failure?: {
          message?: string;
          recommendedAction?: string;
          processRunning?: boolean;
          backendPortOpen?: boolean | null;
        };
        repairs?: Array<{ label?: string }>;
      }
    | undefined;
  if (verification?.status === "verified") {
    console.log(`Registered and verified ${label}.`);
    console.log(`Started on port ${verification.assignedPort ?? "unknown"}.`);
    console.log(
      `Health ${verification.health?.successfulTarget ?? "target"} returned ${verification.health?.statusCode ?? "2xx"}.`
    );
    console.log("Stopped successfully; backend port closure verified.");
    return;
  }
  if (verification?.status === "not_requested") {
    console.log(`Registered ${label} without launch verification.`);
    return;
  }
  console.log(`Registered ${label}, but launch verification did not pass.`);
  if (verification?.failure) {
    console.log(verification.failure.message ?? "Verification failed.");
    console.log(`Process running: ${Boolean(verification.failure.processRunning)}.`);
    console.log(`Backend port open: ${String(verification.failure.backendPortOpen)}.`);
    console.log(`Next action: ${verification.failure.recommendedAction ?? "Inspect logs and preview a repair."}`);
  }
  if (verification?.repairs?.length) {
    console.log(
      `Repair previews: ${verification.repairs
        .map((repair) => repair.label)
        .filter(Boolean)
        .join("; ")}`
    );
  }
}

async function listApps(options: CliOptions): Promise<void> {
  const token = readExistingSessionToken(options.stateDir);
  const stateResponse = await apiRequest(options, "GET", "/__hub/api/state", undefined, token, STATE_API_TIMEOUT_MS);
  if (!stateResponse.ok) {
    if (stateResponse.statusCode === 401) {
      throw new Error(
        "Relaybase is reachable, but its session token is unavailable or does not match this state directory. Run relaybase diagnose-token."
      );
    }
    if (listFilterNeedsRuntime(options.listFilter)) {
      throw new Error(
        `Relaybase server is not reachable, so --${options.listFilter} cannot be proven. Run relaybase serve or use relaybase list without runtime filters.`
      );
    }

    const registry = new Registry(options.stateDir);
    await registry.load();
    const apps = await registry.list();
    const result = buildOfflineAppListResult({ apps, filter: options.listFilter });

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (!apps.length) {
      console.log("No apps registered. Relaybase server is not running.");
      return;
    }

    printAppList(result, options);
    console.log(`Relaybase server is not running. Showing registry only (${result.summary.registered} registered).`);
    return;
  }

  const stateBody = JSON.parse(stateResponse.body) as { apps: AppState[] };
  const appsResponse = await apiRequest(options, "GET", "/__hub/api/apps", undefined, token);
  const appsBody = appsResponse.ok ? (JSON.parse(appsResponse.body) as { apps: AppStatusView[] }) : { apps: [] };
  const result = buildAppListResult({
    states: stateBody.apps,
    statuses: appsBody.apps,
    filter: options.listFilter,
    daemonReachable: true,
    runtimeKnown: true
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  printAppList(result, options);
}

function readExistingSessionToken(stateDir: string): string | undefined {
  try {
    const token = readFileSync(path.join(stateDir, "session-token"), "utf8").trim();
    return token.length >= 32 ? token : undefined;
  } catch {
    return undefined;
  }
}

async function mutateApp(action: string, id: string, options: CliOptions): Promise<void> {
  const response = await apiRequest(
    options,
    "POST",
    `/__hub/api/apps/${encodeURIComponent(id)}/${action}`,
    undefined,
    await getOrCreateSessionToken(options.stateDir),
    LIFECYCLE_API_TIMEOUT_MS
  );
  if (!response.ok) {
    throw new Error(response.body || `Relaybase ${action} failed.`);
  }

  const body = JSON.parse(response.body) as {
    runtime: { status: string; health: string; assignedPort?: number; lastError?: string };
  };
  console.log(
    `${action} ${id}: ${body.runtime.status} ${body.runtime.assignedPort ? `on ${body.runtime.assignedPort}` : ""}`.trim()
  );
  if (body.runtime.lastError) {
    console.log(body.runtime.lastError);
  }
}

async function logs(id: string, options: CliOptions): Promise<void> {
  const response = await apiRequest(
    options,
    "GET",
    `/__hub/api/apps/${encodeURIComponent(id)}/logs`,
    undefined,
    await getOrCreateSessionToken(options.stateDir)
  );
  if (!response.ok) {
    throw new Error(response.body || `Could not read logs for ${id}.`);
  }

  const body = JSON.parse(response.body) as { logs: string[] };
  console.log(body.logs.join("\n"));
}

function printAppList(result: AppListResult, options: CliOptions): void {
  if (!result.items.length) {
    if (result.summary.registered === 0) {
      console.log("No apps registered.");
    } else {
      console.log(`No apps match filter: ${result.filter}.`);
    }
    console.log(appListSummaryLine(result));
    return;
  }

  console.table(result.items.map((item) => (options.verbose ? verboseAppRow(item) : compactAppRow(item))));
  console.log(appListSummaryLine(result));
}

function compactAppRow(item: AppListItem): Record<string, string | number> {
  return {
    id: item.id,
    name: item.name,
    readiness: item.readiness,
    runtime: item.runtime,
    health: item.health,
    route: item.route,
    port: item.port ?? "",
    action: item.action
  };
}

function verboseAppRow(item: AppListItem): Record<string, string | number> {
  return {
    ...compactAppRow(item),
    phase: item.phase ?? "",
    pid: item.pid ?? "",
    logs: item.logs ?? "",
    cwd: item.cwd ?? "",
    manifest: item.manifestPath ?? "",
    mcp: item.childMcp
      ? `${item.childMcp.total} total, ${item.childMcp.connected} connected, ${item.childMcp.errored} errored`
      : "",
    stop: item.stopVerification
      ? `${item.stopVerification.ok ? "ok" : "failed"}${
          item.stopVerification.cleanupStatus ? `/${item.stopVerification.cleanupStatus}` : ""
        }`
      : "",
    error: item.lastError ?? item.attentionReason ?? ""
  };
}

function appListSummaryLine(result: AppListResult): string {
  const source = result.daemonReachable ? "daemon" : "registry";
  return [
    `${result.summary.shown}/${result.summary.registered} shown`,
    `${result.summary.running} running`,
    `${result.summary.active} active`,
    `${result.summary.ready} ready`,
    `${result.summary.stopped} stopped`,
    `${result.summary.attention} attention`,
    `filter=${result.filter}`,
    `source=${source}`
  ].join(", ");
}

function parseOptions(args: string[]): CliOptions {
  const defaults = defaultCommandOptions();
  const options: CliOptions = {
    host: process.env.RELAYBASE_HOST ?? DEFAULT_HOST,
    port: Number(process.env.RELAYBASE_PORT ?? DEFAULT_PORT),
    stateDir: getDefaultStateDir(),
    cwd: defaults.cwd,
    json: false,
    yes: false,
    dryRun: false,
    noStart: false,
    noVerify: false,
    noBrowser: false,
    repair: false,
    mcpInstall: false,
    prove: false,
    verbose: false,
    plan: false,
    full: false,
    release: false,
    live: false,
    all: false,
    race: false,
    diagnose: false,
    preflight: false,
    agentSecurity: false,
    online: false,
    safe: false,
    daemonStartPolicy: "auto",
    restartDaemonOnLaunch: false,
    listFilter: "all",
    docker: {}
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--port") {
      options.port = Number(requiredArg(args[++index], "--port"));
    } else if (arg === "--host") {
      options.host = requiredArg(args[++index], "--host");
    } else if (arg === "--state-dir") {
      options.stateDir = requiredArg(args[++index], "--state-dir");
    } else if (arg === "--cwd") {
      options.cwd = requiredArg(args[++index], "--cwd");
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--verbose") {
      options.verbose = true;
    } else if (arg === "--plan") {
      options.plan = true;
    } else if (arg === "--full") {
      options.full = true;
    } else if (arg === "--release") {
      options.release = true;
    } else if (arg === "--live") {
      options.live = true;
    } else if (arg === "--all") {
      options.all = true;
    } else if (arg === "--race") {
      options.race = true;
    } else if (arg === "--diagnose") {
      options.diagnose = true;
    } else if (arg === "--preflight") {
      options.preflight = true;
    } else if (arg === "--agent-security") {
      options.agentSecurity = true;
    } else if (arg === "--online") {
      options.online = true;
    } else if (arg === "--safe") {
      options.safe = true;
    } else if (arg === "--issue") {
      options.repairIssue = requiredArg(args[++index], "--issue");
    } else if (arg === "--action") {
      options.repairAction = requiredArg(args[++index], "--action");
    } else if (arg === "--apply") {
      options.repairPreviewId = requiredArg(args[++index], "--apply");
    } else if (arg === "--operation") {
      options.repairOperationId = requiredArg(args[++index], "--operation");
    } else if (arg === "--no-daemon-start") {
      options.daemonStartPolicy = "never";
    } else if (arg === "--daemon-start-policy") {
      options.daemonStartPolicy = requiredDaemonStartPolicy(requiredArg(args[++index], "--daemon-start-policy"));
    } else if (arg === "--restart-daemon") {
      options.restartDaemonOnLaunch = true;
    } else if (arg === "--running") {
      setListFilter(options, "running");
    } else if (arg === "--active") {
      setListFilter(options, "active");
    } else if (arg === "--stopped") {
      setListFilter(options, "stopped");
    } else if (arg === "--ready") {
      setListFilter(options, "ready");
    } else if (arg === "--attention") {
      setListFilter(options, "attention");
    } else if (arg === "--yes" || arg === "-y") {
      options.yes = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--no-start") {
      options.noStart = true;
    } else if (arg === "--no-verify") {
      options.noVerify = true;
    } else if (arg === "--no-browser") {
      options.noBrowser = true;
    } else if (arg === "--repair") {
      options.repair = true;
    } else if (arg === "--mcp-install") {
      options.mcpInstall = true;
    } else if (arg === "--prove") {
      options.prove = true;
    } else if (arg === "--profile") {
      options.profile = requiredArg(args[++index], "--profile");
    } else if (arg === "--answers") {
      options.answersPath = requiredArg(args[++index], "--answers");
    } else if (arg === "--agent-config") {
      options.agentConfigPath = requiredArg(args[++index], "--agent-config");
    } else if (arg === "--service") {
      options.docker.service = requiredArg(args[++index], "--service");
    } else if (arg === "--target-port") {
      options.docker.targetPort = parsePort(requiredArg(args[++index], "--target-port"), "--target-port");
    } else if (arg === "--health-path") {
      options.docker.healthPath = requiredArg(args[++index], "--health-path");
    } else if (arg === "--start-timeout-ms") {
      options.docker.startTimeoutMs = parseTimeout(
        requiredArg(args[++index], "--start-timeout-ms"),
        "--start-timeout-ms"
      );
    } else if (arg === "--health-timeout-ms") {
      options.docker.healthTimeoutMs = parseTimeout(
        requiredArg(args[++index], "--health-timeout-ms"),
        "--health-timeout-ms"
      );
    } else if (arg === "--stop-timeout-ms") {
      options.docker.stopTimeoutMs = parseTimeout(requiredArg(args[++index], "--stop-timeout-ms"), "--stop-timeout-ms");
    } else if (arg === "--dependency-port-policy") {
      options.docker.dependencyPortPolicy = requiredDependencyPortPolicy(
        requiredArg(args[++index], "--dependency-port-policy")
      );
    } else if (arg === "--compose-profile") {
      options.docker.composeProfiles = [
        ...(options.docker.composeProfiles ?? []),
        requiredArg(args[++index], "--compose-profile")
      ];
    } else if (arg === "--docker-start-desktop") {
      options.docker.startDockerDesktop = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function setListFilter(options: CliOptions, filter: AppListFilter): void {
  if (options.listFilter !== "all" && options.listFilter !== filter) {
    throw new Error("Use only one app list filter.");
  }
  options.listFilter = filter;
}

function splitPassthroughArgs(args: string[]): { cliArgs: string[]; passthroughArgs: string[] } {
  const separatorIndex = args.indexOf("--");
  if (separatorIndex === -1) {
    return { cliArgs: args, passthroughArgs: [] };
  }
  return {
    cliArgs: args.slice(0, separatorIndex),
    passthroughArgs: args.slice(separatorIndex + 1)
  };
}

async function configure(options: CliOptions): Promise<void> {
  let selectedPlanId = options.profile;
  let envStrategy: EnvStrategy | undefined;
  let noStart = options.noStart ? true : undefined;
  let docker = hasDockerOptions(options.docker) ? options.docker : undefined;

  if (!options.yes && !options.json && process.stdin.isTTY && process.stdout.isTTY) {
    const detection = await detectProject(options.cwd);
    const plans = await proposeSetupPlans(detection, { mcpInstall: options.mcpInstall, docker });
    const selected = await choosePlan(plans);
    selectedPlanId = selected.id;
    if (selected.architecture === "docker-compose-service" && detection.docker) {
      docker = { ...docker, ...(await chooseDockerSetup(detection.docker)) };
    }
    envStrategy = await chooseEnvStrategy();
    noStart = !(await chooseBoolean("Start and verify through Relaybase now?", true));
  }

  const result = await configureProject({
    cwd: options.cwd,
    host: options.host,
    port: options.port,
    stateDir: options.stateDir,
    json: options.json,
    yes: options.yes,
    dryRun: options.dryRun,
    profile: options.profile,
    answersPath: options.answersPath,
    repair: options.repair,
    noStart,
    mcpInstall: options.mcpInstall,
    envStrategy,
    selectedPlanId,
    docker
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  printConfigureResult(result);
}

async function openConfiguredApp(options: CliOptions): Promise<void> {
  const result = await openProject({
    cwd: options.cwd,
    host: options.host,
    port: options.port,
    stateDir: options.stateDir,
    json: options.json,
    noBrowser: options.noBrowser
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  printOpenResult(result);
}

async function health(options: CliOptions): Promise<void> {
  const result = await healthProject({
    cwd: options.cwd,
    host: options.host,
    port: options.port,
    stateDir: options.stateDir,
    json: options.json,
    prove: options.prove,
    lifecycleProof: options.prove && options.yes,
    startDaemon: options.prove && options.yes
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  printHealthResult(result);
}

function requiredArg(value: string | undefined, command: string): string {
  if (!value) {
    throw new Error(`Missing argument for ${command}.`);
  }

  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function apiRequest(
  options: CliOptions,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
  timeoutMs = DEFAULT_API_TIMEOUT_MS
): Promise<{ ok: boolean; statusCode: number; body: string }> {
  const payload = body === undefined ? undefined : JSON.stringify(body);

  return new Promise((resolve) => {
    const request = http.request(
      {
        host: options.host,
        port: options.port,
        path,
        method,
        timeout: timeoutMs,
        headers: {
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
          ...(token ? { "x-relaybase-token": token } : {})
        }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on("end", () => {
          const bodyText = Buffer.concat(chunks).toString("utf8");
          resolve({
            ok: (response.statusCode ?? 500) >= 200 && (response.statusCode ?? 500) < 300,
            statusCode: response.statusCode ?? 500,
            body: bodyText
          });
        });
      }
    );

    request.once("timeout", () => {
      request.destroy();
      resolve({ ok: false, statusCode: 0, body: "Relaybase server is not reachable." });
    });
    request.once("error", (error) => {
      resolve({ ok: false, statusCode: 0, body: error.message });
    });

    if (payload) {
      request.write(payload);
    }

    request.end();
  });
}

function printHelp(topic?: string): void {
  if (topic === "list" || topic === "status") {
    console.log(`Relaybase list

Usage:
  relaybase list [--running|--active|--stopped|--ready|--attention] [--json] [--verbose]

Options:
  --running                      Show apps with runtime status running
  --active                       Show apps with runtime status starting, running, or stopping
  --stopped                      Show apps with runtime status stopped
  --ready                        Show apps with readiness state ready
  --attention                    Show apps needing operator review
  --json                         Print machine-readable output
  --verbose                      Include cwd, manifest, MCP, stop, and error detail
`);
    return;
  }

  if (topic === "start") {
    console.log(`Relaybase start

Usage:
  relaybase start [--port <number>] [--host <host>] [--state-dir <path>] [--cwd <path>] [--plan] [-- <tui-args>]
  relaybase start <app-id> [--port <number>] [--host <host>] [--state-dir <path>]

Without an app id, starts the normal Relaybase operator surface by launching the Go TUI through the Node bridge. The bridge safely ensures the Relaybase daemon when possible and never starts unknown user apps.

With an app id, starts that registered app through the running Relaybase daemon.

Options:
  --plan                         Print the bundled command plan without launching the TUI
  --restart-daemon              Safely restart the daemon before launching the TUI
  --no-daemon-start              Do not auto-start the Relaybase daemon before launching the TUI
  --daemon-start-policy <mode>   auto or never
`);
    return;
  }

  if (topic === "stop" || topic === "restart") {
    console.log(`Relaybase ${topic}

Usage:
  relaybase ${topic} <app-id> [--port <number>] [--host <host>] [--state-dir <path>]

${topic} calls the running Relaybase daemon and requires the local mutation token.
`);
    return;
  }

  if (topic === "daemon") {
    console.log(`Relaybase daemon controls

Usage:
  relaybase daemon restart [--json]

Safely quiesces active work, stops daemon-owned apps, starts a distinct authenticated daemon instance, and restores previously running apps. Active Agent, lifecycle, or package work blocks restart.
`);
    return;
  }

  if (topic === "check") {
    console.log(`Relaybase check

Usage:
  relaybase check [--port <number>] [--host <host>] [--state-dir <path>] [--cwd <path>] [--plan]

Runs a bundled local diagnosis: TUI/toolchain doctor, project/daemon health, and registered app state. This is read-only, does not run a package dry-run, and does not make OpenRouter requests.
`);
    return;
  }

  if (topic === "repair-prefix") {
    console.log(`Relaybase repair-prefix

Usage:
  relaybase repair-prefix [--plan|--diagnose]

Explicitly repairs the source-checkout command prefix with npm link, then removes a generated Windows relaybase.ps1 shim only when its relaybase.cmd sibling exists. Ordinary start and check commands never perform this repair.

Options:
  --plan                         Print the exact repair plan without changing anything
  --diagnose                     Inspect command visibility and target without changing anything
`);
    return;
  }

  if (topic === "repair") {
    console.log(`Relaybase repair

Usage:
  relaybase repair [--agent-security] [--online] [--json]
  relaybase repair --agent-security --issue <code>
  relaybase repair --agent-security --action <action-id> --plan
  relaybase repair --agent-security --action <action-id> --yes
  relaybase repair --agent-security --safe --plan
  relaybase repair --agent-security --safe --yes
  relaybase repair --agent-security --apply <preview-id> --yes
  relaybase repair --operation <operation-id> [--json]

Runs the daemon-owned repair doctor. The initial repair registry contains Agent security. Diagnosis is local-only unless --online explicitly permits provider validation. Mutations are bound to a short-lived preview and require --yes outside the interactive TTY flow.

Options:
  --agent-security               Select the Agent credential-security doctor
  --online                       Permit an explicit provider validation request
  --issue <code>                 Filter diagnosis and action choices to one finding
  --action <action-id>           Preview or apply one daemon-registered repair
  --safe                         Preview or apply currently applicable safe-local repairs
  --apply <preview-id>           Apply an existing bound preview; requires --yes
  --operation <operation-id>     Resolve a durable repair receipt
  --plan                         Print a bound preview without applying it
  --yes                          Authorize the exact preview non-interactively
  --json                         Emit one stable JSON document and never prompt

Exit codes:
  0 healthy or verified
  1 transport, authentication, or execution failure
  2 findings remain or confirmation is required
  3 manual or provider-owned action is required
  4 preview or state binding is stale
`);
    return;
  }

  if (topic === "verify") {
    console.log(`Relaybase verify

Usage:
  relaybase verify [--full] [--release] [--live] [--race] [--all] [--plan]

Default gate:
  format:check, lint, typecheck, Node tests, Jest tests, and relaybase health.

Options:
  --full                         Add agent tests, TUI build/test/vet/snapshot/smoke, package check, and clean-worktree check
  --release                      Add GoReleaser config validation
  --live                         Add explicit live OpenRouter Operator Agent checks
  --race                         Add Go race tests; blocked hosts return the documented race blocker code
  --all                          Run full and release gates; use --live to add OpenRouter live checks
  --plan                         Print the selected gate without executing it
`);
    return;
  }

  if (topic === "mcp") {
    console.log(`Relaybase MCP

Usage:
  relaybase mcp [--state-dir <path>] [--port <number>] [--host <host>]

Runs Relaybase as a stdio MCP server for local clients.
`);
    return;
  }

  if (topic === "tui") {
    console.log(`Relaybase TUI

Usage:
  relaybase tui [--port <number>] [--host <host>] [--state-dir <path>] [--no-daemon-start] [-- <tui-args>]

Launches the Go Bubble Tea TUI as a daemon client. By default, the Node bridge starts the Relaybase daemon first when it is not reachable.

Options:
  --restart-daemon              Safely restart the daemon before launching the TUI
  --no-daemon-start              Do not auto-start the Relaybase daemon before launching the TUI
  --daemon-start-policy <mode>   auto or never

Binary resolution order:
  1. RELAYBASE_TUI_BIN
  2. repo-local .relaybase/tui-dev-bin/<platform binary> from npm run tui:build
  3. bin/relaybase-tui/<platform binary> inside this package
  4. @cameloo/relaybase-tui-<platform>-<arch> platform package
  5. globally installed relaybase-tui on PATH
`);
    return;
  }

  if (topic === "agent") {
    console.log(`Relaybase Agent

Usage:
  relaybase agent config status [--json]
  relaybase agent config reload [--json]
  relaybase agent provider status [--json]
  relaybase agent provider connect [--no-browser] [--json]
  relaybase agent provider replace [--no-browser] [--json]
  relaybase agent provider validate [--json]
  relaybase agent provider migrate --yes [--json]
  relaybase agent provider cleanup-legacy [--yes] [--json]
  relaybase agent provider disconnect --yes [--json]
  relaybase agent provider revoke [--yes] [--json]
  relaybase agent smoke-openrouter [--json]
  relaybase agent live-correctness [--json]
  relaybase agent live-acceptance [--json]  Compatibility alias for live-correctness.
  relaybase agent live-command-matrix [--json]
  relaybase agent live-folder-start [--json]
  relaybase agent threads list [--json]
  relaybase agent threads active [--json]
  relaybase agent threads show <session-id> [--json]
  relaybase agent threads context <session-id> [--json]
  relaybase agent threads activate <session-id> [--json]
  relaybase agent threads rename <session-id> <title> [--json]
  relaybase agent threads clear <session-id> [--json]
  relaybase agent threads export <session-id> [--markdown|--json]

Config and provider commands use the authenticated daemon API. Connect and replace use a daemon-owned one-use OpenRouter PKCE callback. Disconnect is local-only; revoke remains unconfirmed unless OpenRouter confirms it.
For diagnosis and recovery, use relaybase repair --agent-security. Existing provider management commands remain compatible.
Use --agent-config <path> at daemon/TUI launch to select one external non-secret Agent configuration file. Shell-only changes still require restart.
The smoke command runs a live OpenRouter request through the Agent Gateway and remains an explicit legacy environment-backed diagnostic.
The live-correctness command runs the independent daemon/filesystem/process/route correctness flow with the model selected by RELAYBASE_AGENT_MODEL. It enforces the configured eight-cent phase ceiling. live-acceptance remains a compatibility alias.
The live-command-matrix command runs the AGENT-TUI-MATRIX-006 diagnostic, safety, acceptance, and artifact gate with the selected model.
The live-folder-start command runs the AGENT-FOLDER-START-006 natural-language setup/register/start loop with the selected model.
Thread commands call the daemon Agent Gateway session API; they do not read or mutate the SQLite store directly.
`);
    return;
  }

  console.log(`Relaybase

Commands:
  agent                        Agent Gateway diagnostics and live provider smokes
  repair                       Diagnose and repair registered Relaybase domains
  start                        Launch Relaybase daemon/TUI, or start an app when given <app-id>
  check                        Diagnose local Relaybase, TUI, project, and app state
  diagnose-token               Compare client and daemon state identity without printing tokens
  verify                       Run bundled source-checkout verification gates
  configure                     Set up or repair the current project for Relaybase
  open                          Start the configured app and open its Relaybase route
  health                        Inspect Relaybase, project config, route, logs, and readiness
  list                          List registered apps and runtime state
  tui                           Launch the Go Bubble Tea TUI client

Advanced:
  repair-prefix                 Diagnose or explicitly repair the source-checkout command prefix
  serve                         Start the localhost hub daemon
  mcp                           Run Relaybase as a stdio MCP server
  daemon restart                Safely restart the Relaybase daemon
  register <folder|manifest>    Preview, register, and run one bounded launch proof
  stop <app-id>                  Stop an app through the daemon
  restart <app-id>               Restart an app through the daemon
  status                        Alias for list
  logs <app-id>                  Print recent in-memory logs for one app

Options:
  --port <number>                Hub port, default 7777
  --host <host>                  Hub host, default 127.0.0.1
  --state-dir <path>             Relaybase state directory
  --cwd <path>                   Project root, default current directory
  --agent-config <path>          Explicit Agent configuration source checked at each new run
  --json                         Print machine-readable output
  --verbose                      Include expanded detail for supported commands

List options:
  --running                      Show apps with runtime status running
  --active                       Show apps with runtime status starting, running, or stopping
  --stopped                      Show apps with runtime status stopped
  --ready                        Show apps with readiness state ready
  --attention                    Show apps with unhealthy, failed, errored, conflicted, or cleanup-failed state

Configure options:
  --yes                          Use the recommended setup without interactive questions
  --dry-run                      Show the chosen setup without writing files
  --profile <id>                 Use a generated setup profile id
  --repair                       Re-run setup as a repair flow
  --no-start                     Configure files and registry without launching the app
  --mcp-install                  Also write a Relaybase MCP client config artifact
  --service <name>               Docker Compose app-facing service for the setup flow
  --target-port <number>         Docker target container port for the selected service
  --health-path <path>           Health route for readiness checks, for example /api/health

Register options:
  --plan                         Print the exact registration and verification preview only
  --yes                          Approve the exact preview without an interactive prompt
  --no-verify                    Register without start/health/stop verification
  --start-timeout-ms <number>    Docker cold-start/build timeout budget
  --health-timeout-ms <number>   Docker health wait timeout budget
  --stop-timeout-ms <number>     Docker stop/cleanup timeout budget
  --dependency-port-policy <policy>
                                 Docker dependency ports: internal-only or preserve-existing
  --docker-start-desktop         Allow generated Docker hooks to start Docker Desktop on Windows

Health options:
  --prove                        Write a proof bundle; add --yes to run lifecycle start/stop proof
`);
}

function printConfigureResult(result: ConfigureProjectResult): void {
  console.log(`Relaybase configure`);
  console.log(`Project: ${result.detection.root}`);
  console.log(`Detected: ${result.detection.framework} via ${result.detection.packageManager}`);
  console.log(`Plan: ${result.selectedPlan.label} (${result.selectedPlan.id})`);
  console.log("");
  for (const file of result.appliedFiles) {
    console.log(`${file.action.padEnd(9)} ${file.path}`);
  }
  if (result.registryApp) {
    console.log(
      result.verification.attempted
        ? `registered ${result.registryApp.id}`
        : `saved ${result.registryApp.id} for the selected Relaybase state directory`
    );
  }
  if (result.verification.attempted) {
    console.log(`started: ${result.verification.started ? "yes" : "no"}`);
    console.log(`ready: ${result.verification.ready ? "yes" : "no"}`);
    if (result.verification.url) {
      console.log(`url: ${result.verification.url}`);
    }
    if (result.verification.error) {
      console.log(`failure: ${conciseRelaybaseFailure(result.verification.error)}`);
    }
    if (result.verification.recoveryHint) {
      console.log(`recovery: ${result.verification.recoveryHint.message}`);
    }
  } else {
    console.log("launch verification skipped");
  }
  printNextActions(result.verification.nextActions);
  if (result.reportPath) {
    console.log(`report: ${result.reportPath}`);
  }
}

function printOpenResult(result: OpenProjectResult): void {
  if (result.error) {
    console.log(result.error);
    printNextActions(result.nextActions);
    return;
  }
  console.log(`Relaybase open`);
  console.log(`app: ${result.appId}`);
  console.log(`url: ${result.url}`);
  console.log(`started: ${result.started ? "yes" : "no"}`);
  console.log(`ready: ${result.ready ? "yes" : "no"}`);
  console.log(`browser: ${result.openedBrowser ? "opened" : "not opened"}`);
  printNextActions(result.nextActions);
}

function printHealthResult(result: HealthCheckResult): void {
  console.log(`Relaybase health`);
  console.log(`Project: ${result.cwd}`);
  console.log(`Daemon: ${result.daemon.status} (${result.daemon.url})`);
  console.log(`Configured: ${result.project.configured ? "yes" : "no"}`);
  if (result.appId) {
    console.log(`App: ${result.appId}`);
  }
  if (result.state) {
    console.log(`Readiness: ${result.state.readiness.state}`);
    console.log(
      `Route: ${result.state.routeHealth?.status ?? (result.state.routeReachable ? "reachable" : "unreachable")}`
    );
  }
  for (const finding of result.findings) {
    console.log(`${finding.severity.toUpperCase()} ${finding.code}: ${finding.message}`);
  }
  if (result.proof) {
    console.log(`Proof: ${result.proof.ok ? "passed" : "failed"} (${result.proof.mode})`);
    console.log(`Proof artifact: ${result.proof.artifactPath ?? "not written"}`);
  }
  if (result.recommendedAction) {
    console.log(`Recommended: ${result.recommendedAction}`);
  }
  printNextActions(result.nextActions);
}

function printNextActions(nextActions: OpenProjectResult["nextActions"] | HealthCheckResult["nextActions"]): void {
  if (!nextActions?.length) {
    return;
  }
  console.log("Next actions:");
  for (const action of nextActions) {
    const command = action.command ? ` command: ${action.command}` : "";
    const evidence = action.evidence ? ` evidence: ${conciseRelaybaseFailure(action.evidence)}` : "";
    console.log(`- ${action.owner}: ${action.action}${command}${evidence}`);
  }
}

async function choosePlan(plans: SetupPlan[]): Promise<SetupPlan> {
  const labels = plans.map((plan) => `${plan.label} - ${plan.reasons[0] ?? plan.architecture}`);
  const index = await arrowSelect("Choose Relaybase setup architecture", labels, 0);
  return plans[index] ?? plans[0];
}

async function chooseEnvStrategy(): Promise<EnvStrategy> {
  const choices: Array<{ label: string; value: EnvStrategy }> = [
    { label: "Runtime injection only (Recommended)", value: "runtime-injection" },
    { label: "Create .env.relaybase", value: "env-relaybase-file" },
    { label: "Patch guarded Relaybase block into .env", value: "guarded-env-block" },
    { label: "Do not touch env files", value: "none" }
  ];
  const index = await arrowSelect(
    "How should Relaybase handle env values?",
    choices.map((choice) => choice.label),
    0
  );
  return choices[index]?.value ?? "runtime-injection";
}

async function chooseDockerSetup(docker: DockerComposeDetection): Promise<DockerSetupOptions> {
  const services = docker.services.length ? docker.services : [];
  if (!services.length) {
    return {
      service: await askText("Docker app service", "web"),
      targetPort: parsePort(await askText("Target container port", "3000"), "target container port"),
      healthPath: await askText("Health path", "/api/health"),
      startTimeoutMs: parseTimeout(await askText("Cold start timeout ms", "600000"), "cold start timeout"),
      healthTimeoutMs: parseTimeout(await askText("Health wait timeout ms", "300000"), "health wait timeout"),
      stopTimeoutMs: parseTimeout(await askText("Stop timeout ms", "60000"), "stop timeout"),
      dependencyPortPolicy: "internal-only"
    };
  }
  const candidateLabels = services.map((service) => {
    const candidate = docker.serviceCandidates.find((item) => item.name === service.name);
    const target =
      candidate?.targetPort ?? service.ports.find((port) => port.targetPort)?.targetPort ?? service.expose[0];
    const suffix = target ? `:${target}` : " (needs target port)";
    const reason = candidate?.rejectionReasons.length
      ? ` - ${candidate.rejectionReasons.join(", ")}`
      : candidate?.reasons.length
        ? ` - ${candidate.reasons.join(", ")}`
        : "";
    return `${service.name}${suffix}${reason}`;
  });
  const selectedIndex = await arrowSelect("Choose Docker app service", candidateLabels, 0);
  const selected = services[selectedIndex] ?? services[0];
  const inferredPort = selected?.ports.find((port) => port.targetPort)?.targetPort ?? selected?.expose[0] ?? 3000;
  const targetPort = parsePort(await askText("Target container port", String(inferredPort)), "target container port");
  const healthPath = await askText("Health path", "/api/health");
  const startTimeoutMs = parseTimeout(await askText("Cold start timeout ms", "600000"), "cold start timeout");
  const healthTimeoutMs = parseTimeout(await askText("Health wait timeout ms", "300000"), "health wait timeout");
  const stopTimeoutMs = parseTimeout(await askText("Stop timeout ms", "60000"), "stop timeout");
  const policyIndex = await arrowSelect(
    "Dependency host port policy",
    ["Close dependency host ports (Recommended)", "Preserve existing dependency host ports"],
    0
  );

  return {
    service: selected?.name,
    targetPort,
    healthPath,
    startTimeoutMs,
    healthTimeoutMs,
    stopTimeoutMs,
    dependencyPortPolicy: policyIndex === 0 ? "internal-only" : "preserve-existing"
  };
}

async function chooseBoolean(prompt: string, recommended: boolean): Promise<boolean> {
  const choices = recommended ? ["Yes (Recommended)", "No"] : ["No (Recommended)", "Yes"];
  const index = await arrowSelect(prompt, choices, 0);
  return recommended ? index === 0 : index === 1;
}

async function arrowSelect(prompt: string, choices: string[], initialIndex: number): Promise<number> {
  let index = initialIndex;
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode?.(true);

  const render = () => {
    process.stdout.write("\x1b[2K\r");
    process.stdout.write(`${prompt}\n`);
    for (let choiceIndex = 0; choiceIndex < choices.length; choiceIndex += 1) {
      process.stdout.write(`${choiceIndex === index ? "> " : "  "}${choices[choiceIndex]}\n`);
    }
    process.stdout.write(`\x1b[${arrowSelectCursorRows(choices.length)}A`);
  };

  render();
  return new Promise((resolve) => {
    const onKeypress = (_str: string, key: readline.Key) => {
      if (key.name === "up") {
        index = (index - 1 + choices.length) % choices.length;
        render();
      } else if (key.name === "down") {
        index = (index + 1) % choices.length;
        render();
      } else if (key.name === "return") {
        cleanup();
        process.stdout.write(`\x1b[${arrowSelectCursorRows(choices.length)}B`);
        resolve(index);
      } else if (key.ctrl && key.name === "c") {
        cleanup();
        process.exit(130);
      }
    };
    const cleanup = () => {
      process.stdin.off("keypress", onKeypress);
      process.stdin.setRawMode?.(false);
    };
    process.stdin.on("keypress", onKeypress);
  });
}

function conciseRelaybaseFailure(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) {
    return trimmed.replace(/\s+/g, " ");
  }
  try {
    const parsed = JSON.parse(trimmed) as {
      code?: unknown;
      message?: unknown;
      error?: unknown;
      relaybaseError?: { code?: unknown; message?: unknown };
    };
    const code = parsed.relaybaseError?.code ?? parsed.code;
    const message = parsed.relaybaseError?.message ?? parsed.message ?? parsed.error;
    return (
      [typeof code === "string" ? code : undefined, typeof message === "string" ? message : undefined]
        .filter(Boolean)
        .join(": ") || "Relaybase returned structured diagnostic evidence; rerun with --json for details."
    );
  } catch {
    return "Relaybase returned structured diagnostic evidence; rerun with --json for details.";
  }
}

function hasDockerOptions(options: DockerSetupOptions): boolean {
  return Object.values(options).some((value) => value !== undefined);
}

function parsePort(value: string, label: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} must be an integer between 1 and 65535.`);
  }
  return port;
}

function parseTimeout(value: string, label: string): number {
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 3_600_000) {
    throw new Error(`${label} must be an integer between 100 and 3600000 milliseconds.`);
  }
  return timeout;
}

function requiredDependencyPortPolicy(value: string): "internal-only" | "preserve-existing" {
  if (value === "internal-only" || value === "preserve-existing") {
    return value;
  }
  throw new Error('--dependency-port-policy must be "internal-only" or "preserve-existing".');
}

function requiredDaemonStartPolicy(value: string): "auto" | "never" {
  if (value === "auto" || value === "never") {
    return value;
  }
  throw new Error('--daemon-start-policy must be "auto" or "never".');
}

function askText(prompt: string, defaultValue: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${prompt} (${defaultValue}): `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue);
    });
  });
}

function askConfirmation(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${prompt} [y/N]: `, (answer) => {
      rl.close();
      resolve(/^y(?:es)?$/i.test(answer.trim()));
    });
  });
}
