import http from "node:http";
import { createPortHubServer } from "./server.ts";
import { Registry, readManifestFile } from "./registry.ts";
import { DEFAULT_HOST, DEFAULT_PORT, getDefaultStateDir, getOrCreateSessionToken } from "./state.ts";

interface CliOptions {
  port: number;
  host: string;
  stateDir: string;
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
    case "serve":
      await serve(options);
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
  const server = await createPortHubServer(options);
  await server.listen();
  const address = server.address();

  console.log(`PortHub listening on http://${address.host}:${address.port}/__hub`);
  console.log(`State: ${server.runtime.stateDir}`);

  process.once("SIGINT", () => {
    void server.close().then(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void server.close().then(() => process.exit(0));
  });
}

async function register(manifestPath: string | undefined, options: CliOptions): Promise<void> {
  if (!manifestPath) {
    throw new Error("Usage: porthub register <manifest>");
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
      console.log("No apps registered. PortHub server is not running.");
      return;
    }

    console.table(apps.map((app) => ({
      id: app.id,
      name: app.name,
      status: "offline",
      port: app.upstreamPort ?? ""
    })));
    console.log("PortHub server is not running.");
    return;
  }

  const body = JSON.parse(response.body) as { apps: Array<{ id: string; name: string; runtime: { status: string; health: string; assignedPort?: number }; upstreamPort?: number }> };
  console.table(body.apps.map((app) => ({
    id: app.id,
    name: app.name,
    status: app.runtime.status,
    health: app.runtime.health,
    port: app.runtime.assignedPort ?? app.upstreamPort ?? ""
  })));
}

async function mutateApp(action: string, id: string, options: CliOptions): Promise<void> {
  const response = await apiRequest(options, "POST", `/__hub/api/apps/${encodeURIComponent(id)}/${action}`, undefined, await getOrCreateSessionToken(options.stateDir));
  if (!response.ok) {
    throw new Error(response.body || `PortHub ${action} failed.`);
  }

  const body = JSON.parse(response.body) as { runtime: { status: string; health: string; assignedPort?: number; lastError?: string } };
  console.log(`${action} ${id}: ${body.runtime.status} ${body.runtime.assignedPort ? `on ${body.runtime.assignedPort}` : ""}`.trim());
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
  const options: CliOptions = {
    host: process.env.PORTHUB_HOST ?? DEFAULT_HOST,
    port: Number(process.env.PORTHUB_PORT ?? DEFAULT_PORT),
    stateDir: getDefaultStateDir()
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--port") {
      options.port = Number(requiredArg(args[++index], "--port"));
    } else if (arg === "--host") {
      options.host = requiredArg(args[++index], "--host");
    } else if (arg === "--state-dir") {
      options.stateDir = requiredArg(args[++index], "--state-dir");
    }
  }

  return options;
}

function requiredArg(value: string | undefined, command: string): string {
  if (!value) {
    throw new Error(`Missing argument for ${command}.`);
  }

  return value;
}

function apiRequest(options: CliOptions, method: string, path: string, body?: unknown, token?: string): Promise<{ ok: boolean; statusCode: number; body: string }> {
  const payload = body === undefined ? undefined : JSON.stringify(body);

  return new Promise((resolve) => {
    const request = http.request({
      host: options.host,
      port: options.port,
      path,
      method,
      timeout: 2000,
      headers: {
        ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
        ...(token ? { "x-port-hub-token": token } : {})
      }
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on("end", () => {
        const bodyText = Buffer.concat(chunks).toString("utf8");
        resolve({ ok: (response.statusCode ?? 500) >= 200 && (response.statusCode ?? 500) < 300, statusCode: response.statusCode ?? 500, body: bodyText });
      });
    });

    request.once("timeout", () => {
      request.destroy();
      resolve({ ok: false, statusCode: 0, body: "PortHub server is not reachable." });
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
  console.log(`PortHub

Commands:
  serve                         Start the localhost hub
  register <manifest>           Register a porthub.app.json file
  start <app>                   Start a managed app through the running hub
  stop <app>                    Stop a managed app
  restart <app>                 Restart a managed app
  status                        Show registered app status
  logs <app>                    Show in-memory logs for a managed app

Options:
  --port <number>                Hub port, default 7777
  --host <host>                  Hub host, default 127.0.0.1
  --state-dir <path>             PortHub state directory
`);
}

