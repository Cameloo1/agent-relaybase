import path from "node:path";
import type { AppLaunch, AppRecord, CompiledLaunchPlan } from "./types.ts";

export const RELAYBASE_LAUNCH_TOKENS = new Set([
  "{relaybase.host}",
  "{relaybase.port}",
  "{relaybase.appId}",
  "{relaybase.baseUrl}",
  "{relaybase.projectRoot}"
]);

export function compileLaunchPlan(
  app: AppRecord,
  options: { host: string; port: number; hubPort: number }
): CompiledLaunchPlan {
  if (!app.launch) {
    return legacyLaunchPlan(app, options.port);
  }

  const values = launchTokenValues(app, options);
  const launch = app.launch;
  const executable = expandLaunchValue(launch.executable, values);
  const args = launch.args.map((value) => expandLaunchValue(value, values));
  const environment = Object.fromEntries(
    Object.entries(launch.environment).map(([key, value]) => [key, expandLaunchValue(value, values)])
  );
  if (launch.portBinding === "environment") {
    environment.PORT = String(options.port);
    environment.HOST = options.host;
  }
  environment.RELAYBASE_APP_ID = app.id;
  environment.RELAYBASE_BASE_URL = values["{relaybase.baseUrl}"];

  return Object.freeze({
    schemaVersion: 1 as const,
    source: "declared" as const,
    adapterId: structuredAdapterId(launch),
    adapterVersion: 1,
    executable,
    args: Object.freeze(args),
    cwd: app.cwd,
    environment: Object.freeze(environment),
    port: Object.freeze({
      ownership:
        launch.portBinding === "external" ? "external" : launch.portBinding === "fixed" ? "fixed" : "relaybase",
      strategy:
        launch.portBinding === "arguments"
          ? "arguments"
          : launch.portBinding === "fixed" || launch.portBinding === "external"
            ? "fixed"
            : "environment",
      ...((launch.portBinding === "fixed" || launch.portBinding === "external") && app.upstreamPort
        ? { requestedPort: app.upstreamPort }
        : {})
    }),
    ...(app.healthUrl
      ? { health: Object.freeze({ protocol: app.protocol, target: app.healthUrl }) }
      : { health: Object.freeze({ protocol: app.protocol }) }),
    generatedFiles: Object.freeze([]),
    warnings: Object.freeze(
      launch.portBinding === "fixed"
        ? [
            {
              code: "REGISTER_FIXED_PORT_CONFLICT_RISK",
              severity: "warning" as const,
              message: `This app uses fixed backend port ${app.upstreamPort}. Relaybase cannot move it automatically if occupied.`
            }
          ]
        : []
    ),
    confidence: "high" as const
  });
}

export function expandLaunchValue(value: string, values: Record<string, string>): string {
  return value.replace(/\{relaybase\.[A-Za-z0-9]+\}/g, (token) => values[token] ?? token);
}

function launchTokenValues(
  app: AppRecord,
  options: { host: string; port: number; hubPort: number }
): Record<string, string> {
  const projectRoot = app.manifestPath ? path.dirname(app.manifestPath) : app.cwd;
  return {
    "{relaybase.host}": options.host,
    "{relaybase.port}": String(options.port),
    "{relaybase.appId}": app.id,
    "{relaybase.baseUrl}": `http://${app.id}.localhost:${options.hubPort}`,
    "{relaybase.projectRoot}": projectRoot
  };
}

function structuredAdapterId(launch: AppLaunch): string {
  if (/\.ps1$/i.test(launch.executable)) return "structured-powershell";
  if (/python(?:\.exe)?$/i.test(path.basename(launch.executable)) || /\.py$/i.test(launch.executable))
    return "structured-python";
  return "structured-process";
}

function legacyLaunchPlan(app: AppRecord, _port: number): CompiledLaunchPlan {
  const [executable = app.command, ...args] = splitCommand(app.command);
  return Object.freeze({
    schemaVersion: 1 as const,
    source: app.command === "external" ? ("external" as const) : ("legacy" as const),
    adapterId: "legacy-command",
    adapterVersion: 1,
    executable,
    args: Object.freeze(args),
    cwd: app.cwd,
    environment: Object.freeze({}),
    port: Object.freeze({
      ownership:
        app.command === "external"
          ? ("external" as const)
          : app.upstreamPort
            ? ("fixed" as const)
            : ("relaybase" as const),
      strategy: app.upstreamPort ? ("fixed" as const) : ("environment" as const),
      ...(app.upstreamPort ? { requestedPort: app.upstreamPort } : {})
    }),
    ...(app.healthUrl ? { health: Object.freeze({ protocol: app.protocol, target: app.healthUrl }) } : {}),
    generatedFiles: Object.freeze([]),
    warnings: Object.freeze([]),
    confidence: "high" as const
  });
}

function splitCommand(command: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|([^\s]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(command))) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return tokens;
}
