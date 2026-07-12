import { spawnSync } from "node:child_process";
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
import { Registry, readManifestFile } from "./registry.ts";
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
import { formatRelaybaseEnvFileDiagnostics, loadRelaybaseEnvFile } from "./envFile.ts";
import { runRelaybaseTui } from "./tuiBridge.ts";
import { removeRecognizedRelaybasePowerShellShim } from "./prefixShim.ts";

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
  daemonStartPolicy: "auto" | "never";
  listFilter: AppListFilter;
  profile?: string;
  answersPath?: string;
  docker: DockerSetupOptions;
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
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (args.includes("--help") || args.includes("-h")) {
    printHelp(command);
    return;
  }

  const envFile = loadRelaybaseEnvFile();
  if (envFile.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    throw new Error(formatRelaybaseEnvFileDiagnostics(envFile));
  }

  const isBundledStart = command === "start" && isBundledStartArgs(args);
  const { cliArgs, passthroughArgs } =
    command === "tui" || isBundledStart ? splitPassthroughArgs(args) : { cliArgs: args, passthroughArgs: [] };
  const options = parseOptions(cliArgs);

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
    case "verify":
      process.exitCode = await verifyRelaybase(options);
      return;
    case "repair-prefix":
      process.exitCode = repairRelaybaseCommandPrefix(options);
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

async function checkRelaybase(options: CliOptions): Promise<number> {
  const steps: WorkflowStep[] = [
    { name: "TUI/toolchain doctor", command: process.execPath, args: [scriptPath("tui-go.mjs"), "doctor"] }
  ];
  if (options.plan) {
    printWorkflowPlan("relaybase check", [
      ...steps,
      { name: "Project and daemon health", command: "relaybase", args: ["health"] },
      { name: "Registered apps and runtime state", command: "relaybase", args: ["list", "--verbose"] }
    ]);
    return 0;
  }

  console.log("Relaybase check");
  let exitCode = 0;
  for (const step of steps) {
    const status = runWorkflowStep(step, { allowLiveEnv: false });
    if (status !== 0) {
      exitCode = status;
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

  if (subcommand === "live-acceptance") {
    try {
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
    "Usage: relaybase agent <smoke-openrouter|live-acceptance|live-command-matrix|live-folder-start|threads>"
  );
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
  body?: unknown
): Promise<Record<string, unknown>> {
  const response = await apiRequest(options, method, pathName, body, await getOrCreateSessionToken(options.stateDir));
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

async function register(manifestPath: string | undefined, options: CliOptions): Promise<void> {
  if (!manifestPath) {
    throw new Error("Usage: relaybase register <manifest>");
  }

  const registry = new Registry(options.stateDir);
  await registry.load();
  const manifest = await readManifestFile(manifestPath);
  const app = await registry.upsertManifest(manifest, { manifestPath });
  console.log(`Registered ${app.id} (${app.name})`);
}

async function listApps(options: CliOptions): Promise<void> {
  const token = readExistingSessionToken(options.stateDir);
  const stateResponse = await apiRequest(options, "GET", "/__hub/api/state", undefined, token, STATE_API_TIMEOUT_MS);
  if (!stateResponse.ok) {
    if (stateResponse.statusCode === 401) {
      throw new Error(
        "Relaybase is reachable, but its session token is unavailable or does not match this state directory. Run relaybase diagnose_token."
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
    daemonStartPolicy: "auto",
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
    } else if (arg === "--no-daemon-start") {
      options.daemonStartPolicy = "never";
    } else if (arg === "--daemon-start-policy") {
      options.daemonStartPolicy = requiredDaemonStartPolicy(requiredArg(args[++index], "--daemon-start-policy"));
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
  relaybase agent smoke-openrouter [--json]
  relaybase agent live-acceptance [--json]
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

Runs a live OpenRouter smoke through the daemon Agent Gateway, Operator Agent runtime, and OpenAI Agents SDK TypeScript Chat Completions path.
Requires OPENROUTER_API_KEY and RELAYBASE_AGENT_MODEL in the daemon/CLI environment.
The live-acceptance command runs the stricter RA013 daemon/TUI/setup acceptance flow with exact google/gemini-3.1-flash-lite.
The live-command-matrix command runs the AGENT-TUI-MATRIX-006 diagnostic, safety, acceptance, and artifact gate with exact google/gemini-3.1-flash-lite.
The live-folder-start command runs the AGENT-FOLDER-START-006 natural-language setup/register/start loop with exact google/gemini-3.1-flash-lite.
Thread commands call the daemon Agent Gateway session API; they do not read or mutate the SQLite store directly.
`);
    return;
  }

  console.log(`Relaybase

Commands:
  agent                        Agent Gateway diagnostics and live provider smokes
  start                        Launch Relaybase daemon/TUI, or start an app when given <app-id>
  check                        Diagnose local Relaybase, TUI, project, and app state
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
  register <manifest>           Register or update an app manifest
  stop <app-id>                  Stop an app through the daemon
  restart <app-id>               Restart an app through the daemon
  status                        Alias for list
  logs <app-id>                  Print recent in-memory logs for one app

Options:
  --port <number>                Hub port, default 7777
  --host <host>                  Hub host, default 127.0.0.1
  --state-dir <path>             Relaybase state directory
  --cwd <path>                   Project root, default current directory
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
    console.log(`registered ${result.registryApp.id}`);
  }
  if (result.verification.attempted) {
    console.log(`started: ${result.verification.started ? "yes" : "no"}`);
    console.log(`ready: ${result.verification.ready ? "yes" : "no"}`);
    if (result.verification.url) {
      console.log(`url: ${result.verification.url}`);
    }
    if (result.verification.error) {
      console.log(`failure: ${result.verification.error}`);
    }
    if (result.verification.recoveryHint) {
      console.log(`recovery: ${result.verification.recoveryHint.message}`);
    }
  } else {
    console.log("launch verification skipped");
  }
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
  console.log(`Daemon: ${result.daemon.reachable ? "reachable" : "unreachable"} (${result.daemon.url})`);
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
    const evidence = action.evidence ? ` evidence: ${action.evidence}` : "";
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
    process.stdout.write(`\x1b[${choices.length}A`);
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
        process.stdout.write(`\x1b[${choices.length}B`);
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
