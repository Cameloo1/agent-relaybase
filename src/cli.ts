import http from "node:http";
import readline from "node:readline";
import { createRelaybaseServer } from "./server.ts";
import { Registry, readManifestFile } from "./registry.ts";
import { DEFAULT_HOST, DEFAULT_PORT, getDefaultStateDir, getOrCreateSessionToken } from "./state.ts";
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
  profile?: string;
  answersPath?: string;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args.shift() ?? "help";
  const options = parseOptions(args);

  switch (command) {
    case "configure":
      await configure(options);
      return;
    case "open":
      await openConfiguredApp(options);
      return;
    case "health":
      await health(options);
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
    case "stop":
    case "restart":
      await mutateApp(command, requiredArg(args[0], command), options);
      return;
    case "status":
      await status(options);
      return;
    case "logs":
      await logs(requiredArg(args[0], "logs"), options);
      return;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
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

async function status(options: CliOptions): Promise<void> {
  const response = await apiRequest(options, "GET", "/__hub/api/apps");
  if (!response.ok) {
    const registry = new Registry(options.stateDir);
    await registry.load();
    const apps = await registry.list();
    if (!apps.length) {
      console.log("No apps registered. Relaybase server is not running.");
      return;
    }

    console.table(
      apps.map((app) => ({
        id: app.id,
        name: app.name,
        status: "offline",
        port: app.upstreamPort ?? ""
      }))
    );
    console.log("Relaybase server is not running.");
    return;
  }

  const body = JSON.parse(response.body) as {
    apps: Array<{
      id: string;
      name: string;
      runtime: { status: string; health: string; assignedPort?: number };
      upstreamPort?: number;
    }>;
  };
  console.table(
    body.apps.map((app) => ({
      id: app.id,
      name: app.name,
      status: app.runtime.status,
      health: app.runtime.health,
      port: app.runtime.assignedPort ?? app.upstreamPort ?? ""
    }))
  );
}

async function mutateApp(action: string, id: string, options: CliOptions): Promise<void> {
  const response = await apiRequest(
    options,
    "POST",
    `/__hub/api/apps/${encodeURIComponent(id)}/${action}`,
    undefined,
    await getOrCreateSessionToken(options.stateDir)
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
  const response = await apiRequest(options, "GET", `/__hub/api/apps/${encodeURIComponent(id)}/logs`);
  if (!response.ok) {
    throw new Error(response.body || `Could not read logs for ${id}.`);
  }

  const body = JSON.parse(response.body) as { logs: string[] };
  console.log(body.logs.join("\n"));
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
    mcpInstall: false
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
    } else if (arg === "--profile") {
      options.profile = requiredArg(args[++index], "--profile");
    } else if (arg === "--answers") {
      options.answersPath = requiredArg(args[++index], "--answers");
    }
  }

  return options;
}

async function configure(options: CliOptions): Promise<void> {
  let selectedPlanId = options.profile;
  let envStrategy: EnvStrategy | undefined;
  let noStart = options.noStart ? true : undefined;

  if (!options.yes && !options.json && process.stdin.isTTY && process.stdout.isTTY) {
    const detection = await detectProject(options.cwd);
    const plans = await proposeSetupPlans(detection, { mcpInstall: options.mcpInstall });
    const selected = await choosePlan(plans);
    selectedPlanId = selected.id;
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
    selectedPlanId
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
    json: options.json
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

function apiRequest(
  options: CliOptions,
  method: string,
  path: string,
  body?: unknown,
  token?: string
): Promise<{ ok: boolean; statusCode: number; body: string }> {
  const payload = body === undefined ? undefined : JSON.stringify(body);

  return new Promise((resolve) => {
    const request = http.request(
      {
        host: options.host,
        port: options.port,
        path,
        method,
        timeout: 2000,
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

function printHelp(): void {
  console.log(`Relaybase

Commands:
  configure                     Set up or repair the current project for Relaybase
  open                          Start the configured app and open its Relaybase route
  health                        Inspect Relaybase, project config, route, logs, and readiness

Advanced:
  serve                         Start the localhost hub daemon
  mcp                           Run Relaybase as a stdio MCP server

Options:
  --port <number>                Hub port, default 7777
  --host <host>                  Hub host, default 127.0.0.1
  --state-dir <path>             Relaybase state directory
  --cwd <path>                   Project root, default current directory
  --json                         Print machine-readable output

Configure options:
  --yes                          Use the recommended setup without interactive questions
  --dry-run                      Show the chosen setup without writing files
  --profile <id>                 Use a generated setup profile id
  --repair                       Re-run setup as a repair flow
  --no-start                     Configure files and registry without launching the app
  --mcp-install                  Also write a Relaybase MCP client config artifact
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
    return;
  }
  console.log(`Relaybase open`);
  console.log(`app: ${result.appId}`);
  console.log(`url: ${result.url}`);
  console.log(`started: ${result.started ? "yes" : "no"}`);
  console.log(`ready: ${result.ready ? "yes" : "no"}`);
  console.log(`browser: ${result.openedBrowser ? "opened" : "not opened"}`);
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
    console.log(`Route: ${result.state.routeReachable ? "reachable" : "unreachable"}`);
  }
  for (const finding of result.findings) {
    console.log(`${finding.severity.toUpperCase()} ${finding.code}: ${finding.message}`);
  }
  if (result.recommendedAction) {
    console.log(`Recommended: ${result.recommendedAction}`);
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
