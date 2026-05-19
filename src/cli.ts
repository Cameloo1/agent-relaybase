import http from "node:http";
import readline from "node:readline";
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

async function listApps(options: CliOptions): Promise<void> {
  const stateResponse = await apiRequest(options, "GET", "/__hub/api/state");
  if (!stateResponse.ok) {
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
  const appsResponse = await apiRequest(options, "GET", "/__hub/api/apps");
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

  if (topic === "start" || topic === "stop" || topic === "restart") {
    console.log(`Relaybase ${topic}

Usage:
  relaybase ${topic} <app-id> [--port <number>] [--host <host>] [--state-dir <path>]

${topic} calls the running Relaybase daemon and requires the local mutation token.
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

  console.log(`Relaybase

Commands:
  configure                     Set up or repair the current project for Relaybase
  open                          Start the configured app and open its Relaybase route
  health                        Inspect Relaybase, project config, route, logs, and readiness
  list                          List registered apps and runtime state

Advanced:
  serve                         Start the localhost hub daemon
  mcp                           Run Relaybase as a stdio MCP server
  register <manifest>           Register or update an app manifest
  start <app-id>                 Start an app through the daemon
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

function askText(prompt: string, defaultValue: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${prompt} (${defaultValue}): `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue);
    });
  });
}
