import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import test from "node:test";
import { Registry } from "../src/registry.ts";
import { createRelaybaseServer } from "../src/server.ts";
import { createFakeMcpServer } from "./fixtures/fake-mcp-server.ts";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("serves MCP discovery metadata", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-mcp-discovery-"));
  const hub = await createRelaybaseServer({ port: 0, stateDir });

  try {
    await hub.listen();
    const response = await httpRequest(hub.address().port, "/.well-known/mcp.json");
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.product, "Relaybase");
    assert.match(body.endpoints.streamableHttp, /\/mcp$/);
    assert.match(body.endpoints.legacySse, /\/sse$/);
    assert.equal(body.capabilities.tools, true);
  } finally {
    await hub.close();
  }
});

test("HTTP MCP rejects unauthorized mutation and accepts token auth", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-mcp-auth-"));
  const hub = await createRelaybaseServer({ port: 0, stateDir, portRangeStart: 18200, portRangeEnd: 18220 });

  try {
    await hub.listen();
    await registerManagedApp(hub.runtime.registry, "managed-auth");

    const unauthorized = await createHttpMcpClient(hub.address().port);
    const readOnlyList = await unauthorized.callTool({ name: "list_apps", arguments: { filter: "stopped" } });
    assert.equal(readOnlyList.structuredContent?.summary.stopped, 1);
    assert.equal((readOnlyList.structuredContent?.items as Array<{ id: string }>)[0].id, "managed-auth");
    assert.equal((readOnlyList.structuredContent?.apps as Array<{ id: string }>)[0].id, "managed-auth");
    assert.equal((readOnlyList.structuredContent?.states as Array<{ id: string }>)[0].id, "managed-auth");
    await assert.rejects(
      () => unauthorized.callTool({ name: "list_apps", arguments: { filter: "bogus" } }),
      /App list filter/
    );
    await assert.rejects(
      () => unauthorized.callTool({ name: "start_app", arguments: { id: "managed-auth" } }),
      /UNAUTHORIZED_MUTATION.*diagnose_token/
    );
    const manifestResource = await unauthorized.readResource({ uri: "relaybase://app/managed-auth/manifest" });
    const manifestText = String(manifestResource.contents[0]?.text ?? "");
    assert.doesNotMatch(manifestText, /env/);
    assert.doesNotMatch(manifestText, /raw-mcp-secret/);
    const tokenDiagnostic = await unauthorized.callTool({ name: "diagnose_token", arguments: {} });
    assert.equal(tokenDiagnostic.structuredContent?.tokenPresent, true);
    assert.match(String(tokenDiagnostic.structuredContent?.tokenPath), /session-token$/);
    await unauthorized.close();

    const authorized = await createHttpMcpClient(hub.address().port, hub.runtime.token);
    const started = await authorized.callTool({ name: "start_app", arguments: { id: "managed-auth" } });
    assert.equal(started.structuredContent?.runtime.status, "running");
    assert.equal(started.structuredContent?.state.routeReachable, true);

    const runningList = await authorized.callTool({ name: "list_apps", arguments: { filter: "running" } });
    assert.equal(runningList.structuredContent?.summary.running, 1);
    assert.equal((runningList.structuredContent?.items as Array<{ id: string }>)[0].id, "managed-auth");

    const appStatus = await authorized.callTool({ name: "app_status", arguments: { id: "managed-auth" } });
    assert.equal(appStatus.structuredContent?.app.registered, true);
    assert.equal(appStatus.structuredContent?.app.readiness.state, "ready");
    assert.equal(appStatus.structuredContent?.app.primaryAction, "open");
    assert.equal(appStatus.structuredContent?.app.runtime.phase, "running");
    assert.equal(appStatus.structuredContent?.app.runtime.lastStartAttempt.status, "succeeded");
    assert.match(String(appStatus.structuredContent?.app.logStreamUrl), /\/logs\/stream$/);

    const health = await authorized.callTool({ name: "health_check", arguments: { id: "managed-auth" } });
    assert.equal(health.structuredContent?.routeReachable, true);
    assert.equal(health.structuredContent?.backendPortOpen, true);
    assert.equal(health.structuredContent?.state.canOpen, true);

    const verified = await authorized.callTool({ name: "verify_app", arguments: { id: "managed-auth" } });
    assert.equal(verified.structuredContent?.state.routeReachable, true);

    const logs = await authorized.callTool({
      name: "tail_logs",
      arguments: { id: "managed-auth", follow: true }
    });
    assert.equal(logs.structuredContent?.followSupported, false);
    assert.equal(logs.structuredContent?.followAccepted, false);
    assert.match(String(logs.structuredContent?.message), /snapshot/);

    const stream = await authorized.callTool({ name: "log_stream_info", arguments: { id: "managed-auth" } });
    assert.equal(stream.structuredContent?.transport, "http-sse");
    assert.match(String(stream.structuredContent?.streamUrl), /\/logs\/stream$/);

    const readOnlyProof = await authorized.callTool({ name: "prove_app", arguments: { id: "managed-auth" } });
    assert.equal(readOnlyProof.structuredContent?.mode, "read-only");
    assert.equal(readOnlyProof.structuredContent?.lifecycleAttempted, false);

    const stopped = await authorized.callTool({ name: "stop_app", arguments: { id: "managed-auth" } });
    assert.equal(stopped.structuredContent?.runtime.status, "stopped");
    assert.equal(stopped.structuredContent?.state.stopVerification.ok, true);
    await authorized.close();
  } finally {
    await hub.close();
  }
});

test("MCP prove_app lifecycle proof is token-gated and verifies start logs stop cleanup", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-mcp-prove-"));
  const hub = await createRelaybaseServer({ port: 0, stateDir, portRangeStart: 18230, portRangeEnd: 18240 });

  try {
    await hub.listen();
    await registerManagedApp(hub.runtime.registry, "managed-prove");
    const unauthenticated = await createHttpMcpClient(hub.address().port);
    await assert.rejects(
      () => unauthenticated.callTool({ name: "prove_app", arguments: { id: "managed-prove", lifecycle: true } }),
      /UNAUTHORIZED_MUTATION/
    );
    await unauthenticated.close();

    const authorized = await createHttpMcpClient(hub.address().port, hub.runtime.token);
    const proof = await authorized.callTool({ name: "prove_app", arguments: { id: "managed-prove", lifecycle: true } });
    assert.equal(proof.structuredContent?.mode, "lifecycle");
    assert.equal(proof.structuredContent?.ok, true);
    assert.equal(proof.structuredContent?.started, true);
    assert.equal(proof.structuredContent?.stopped, true);
    assert.ok(
      (proof.structuredContent?.checks as Array<{ name: string; ok: boolean }>).some(
        (check) => check.name === "stop-verification" && check.ok
      )
    );
    await authorized.close();
  } finally {
    await hub.close();
  }
});

test("MCP configure_project uses the shared setup flow and gates writes behind token auth", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-mcp-configure-state-"));
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-mcp-configure-project-"));
  await fs.writeFile(
    path.join(project, "package.json"),
    JSON.stringify(
      {
        name: "mcp-configured-app",
        scripts: {
          dev: "node server.js"
        }
      },
      null,
      2
    )
  );
  const hub = await createRelaybaseServer({ port: 0, stateDir });

  try {
    await hub.listen();
    const unauthenticated = await createHttpMcpClient(hub.address().port);
    const dryRun = await unauthenticated.callTool({
      name: "configure_project",
      arguments: { cwd: project, apply: false }
    });
    assert.equal(dryRun.structuredContent?.selectedPlan.id, "managed-web");
    await assert.rejects(
      () =>
        unauthenticated.callTool({ name: "configure_project", arguments: { cwd: project, apply: true, start: false } }),
      /UNAUTHORIZED_MUTATION/
    );
    await unauthenticated.close();

    const authenticated = await createHttpMcpClient(hub.address().port, hub.runtime.token);
    const applied = await authenticated.callTool({
      name: "configure_project",
      arguments: { cwd: project, apply: true, start: false }
    });
    assert.equal(applied.structuredContent?.verification.attempted, false);
    assert.ok(await exists(path.join(project, "relaybase.app.json")));
    assert.equal((await hub.runtime.registry.get("mcp-configured-app"))?.id, "mcp-configured-app");
    await authenticated.close();
  } finally {
    await hub.close();
  }
});

test("MCP registration requires explicit verification intent and returns the typed result", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-mcp-registration-state-"));
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-mcp-registration-project-"));
  const manifestPath = path.join(project, "relaybase.app.json");
  await fs.writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      id: "mcp-registration",
      name: "MCP Registration",
      command: "external",
      cwd: "."
    }),
    "utf8"
  );
  const hub = await createRelaybaseServer({ port: 0, stateDir });
  try {
    await hub.listen();
    const client = await createHttpMcpClient(hub.address().port, hub.runtime.token);
    await assert.rejects(
      () => client.callTool({ name: "plan_registration", arguments: { path: manifestPath, mode: "manifest" } }),
      /verificationMode|required/i
    );
    const planned = await client.callTool({
      name: "plan_registration",
      arguments: { path: manifestPath, mode: "manifest", verificationMode: "none" }
    });
    assert.equal(planned.structuredContent?.verificationIntent.mode, "none");
    const registered = await client.callTool({
      name: "register_app",
      arguments: { previewId: planned.structuredContent?.previewId, confirm: true }
    });
    assert.equal(registered.structuredContent?.registration.status, "registered_unverified");
    assert.equal(registered.structuredContent?.registration.verification.status, "not_requested");
    await client.close();
  } finally {
    await hub.close();
  }
});

test("stdio MCP fake client can list and start apps", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-mcp-stdio-"));
  const registry = new Registry(stateDir);
  await registry.load();
  await registerManagedApp(registry, "managed-stdio");

  const client = new Client({ name: "relaybase-stdio-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--experimental-strip-types",
      path.join(rootDir, "src", "cli.ts"),
      "mcp",
      "--state-dir",
      stateDir,
      "--port",
      "18250"
    ],
    cwd: rootDir,
    stderr: "pipe"
  });

  await client.connect(transport);
  try {
    const listed = await client.callTool({ name: "list_apps", arguments: {} });
    assert.equal((listed.structuredContent?.apps as Array<{ id: string }>)[0].id, "managed-stdio");

    const started = await client.callTool({ name: "start_app", arguments: { id: "managed-stdio" } });
    assert.equal(started.structuredContent?.runtime.status, "running");

    const stopped = await client.callTool({ name: "stop_app", arguments: { id: "managed-stdio" } });
    assert.equal(stopped.structuredContent?.runtime.status, "stopped");
  } finally {
    await client.close();
  }
});

test("aggregates child stdio MCP tools, resources, and prompts with exact allowlists", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-child-stdio-"));
  const hub = await createRelaybaseServer({ port: 0, stateDir, portRangeStart: 18300, portRangeEnd: 18320 });

  try {
    await hub.listen();
    await registerManagedApp(hub.runtime.registry, "managed", {
      mcp: {
        enabled: true,
        children: [
          {
            id: "tools",
            transport: "stdio",
            command: process.execPath,
            args: ["--experimental-strip-types", path.join(rootDir, "tests", "fixtures", "fake-mcp-child.ts")],
            cwd: rootDir,
            expose: {
              tools: ["echo"],
              resources: ["docs://index"],
              prompts: ["debug"]
            }
          }
        ]
      }
    });

    const runtime = await hub.runtime.processes.start("managed");
    assert.equal(runtime.mcpChildren?.[0].status, "connected");

    const client = await createHttpMcpClient(hub.address().port, hub.runtime.token);
    try {
      const tools = await client.listTools();
      assert.ok(tools.tools.some((tool) => tool.name === "managed.echo"));
      assert.equal(
        tools.tools.some((tool) => tool.name === "managed.hidden"),
        false
      );

      const result = await client.callTool({ name: "managed.echo", arguments: { text: "hello" } });
      assert.equal(result.structuredContent?.name, "echo");

      const resources = await client.listResources();
      const childUri = "relaybase://app/managed/mcp/docs://index";
      assert.ok(resources.resources.some((resource) => resource.uri === childUri));
      assert.equal(
        resources.resources.some((resource) => resource.uri.includes("secret://hidden")),
        false
      );

      const read = await client.readResource({ uri: childUri });
      assert.match(read.contents[0].text, /stdio resource/);

      const prompts = await client.listPrompts();
      assert.ok(prompts.prompts.some((prompt) => prompt.name === "managed.debug"));
      assert.equal(
        prompts.prompts.some((prompt) => prompt.name === "managed.hidden"),
        false
      );
    } finally {
      await client.close();
      await hub.runtime.processes.stop("managed");
    }
  } finally {
    await hub.close();
  }
});

test("aggregates child Streamable HTTP MCP tools with exact allowlists", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-child-http-"));
  const child = await createFakeHttpMcpChild();
  const hub = await createRelaybaseServer({ port: 0, stateDir, portRangeStart: 18400, portRangeEnd: 18420 });

  try {
    await hub.listen();
    await registerManagedApp(hub.runtime.registry, "webapp", {
      mcp: {
        enabled: true,
        children: [
          {
            id: "remote-tools",
            transport: "streamable-http",
            url: `http://127.0.0.1:${child.port}/mcp`,
            expose: {
              tools: ["query"],
              resources: ["docs://http-index"],
              prompts: ["debug"]
            }
          }
        ]
      }
    });

    const runtime = await hub.runtime.processes.start("webapp");
    assert.equal(runtime.mcpChildren?.[0].status, "connected");

    const unauthenticated = await createHttpMcpClient(hub.address().port);
    const client = await createHttpMcpClient(hub.address().port, hub.runtime.token);
    try {
      const tools = await unauthenticated.listTools();
      assert.ok(tools.tools.some((tool) => tool.name === "webapp.query"));
      assert.equal(
        tools.tools.some((tool) => tool.name === "webapp.hidden"),
        false
      );
      await assert.rejects(
        () => unauthenticated.callTool({ name: "webapp.query", arguments: { text: "hello" } }),
        /UNAUTHORIZED_MUTATION/
      );

      const result = await client.callTool({ name: "webapp.query", arguments: { text: "hello" } });
      assert.equal(result.structuredContent?.child, "http");
      assert.equal(result.structuredContent?.name, "query");
    } finally {
      await unauthenticated.close();
      await client.close();
      await hub.runtime.processes.stop("webapp");
    }
  } finally {
    await hub.close();
    await child.close();
  }
});

test("cleans up child MCP exposure when app start fails health", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-child-failed-start-"));
  const hub = await createRelaybaseServer({ port: 0, stateDir, portRangeStart: 18430, portRangeEnd: 18440 });

  try {
    await hub.listen();
    await hub.runtime.registry.upsertManifest({
      schemaVersion: 1,
      id: "failed-child",
      name: "failed-child",
      command: `"${process.execPath}" -e "setInterval(()=>{},1000)"`,
      cwd: rootDir,
      protocol: "http",
      healthUrl: "/health",
      healthTimeoutMs: 500,
      mcp: {
        enabled: true,
        children: [
          {
            id: "tools",
            transport: "stdio",
            command: process.execPath,
            args: ["--experimental-strip-types", path.join(rootDir, "tests", "fixtures", "fake-mcp-child.ts")],
            cwd: rootDir,
            expose: {
              tools: ["echo"],
              resources: ["docs://index"],
              prompts: ["debug"]
            }
          }
        ]
      }
    });

    const runtime = await hub.runtime.processes.start("failed-child");
    assert.equal(runtime.status, "errored");
    assert.equal(runtime.mcpChildren, undefined);
    assert.deepEqual(hub.runtime.processes.mcp.statusForApp("failed-child"), []);

    const client = await createHttpMcpClient(hub.address().port, hub.runtime.token);
    try {
      const tools = await client.listTools();
      assert.equal(
        tools.tools.some((tool) => tool.name === "failed-child.echo"),
        false
      );
    } finally {
      await client.close();
    }
  } finally {
    await hub.close();
  }
});

async function registerManagedApp(registry: Registry, id: string, extra: Record<string, unknown> = {}): Promise<void> {
  const fixture = path.join(rootDir, "tests", "fixtures", "fake-managed-app.ts");
  await registry.upsertManifest({
    schemaVersion: 1,
    id,
    name: id,
    command: `"${process.execPath}" --experimental-strip-types "${fixture}"`,
    cwd: rootDir,
    protocol: "http",
    healthUrl: "/health",
    env: { SECRET_TOKEN: "raw-mcp-secret" },
    ...extra
  });
}

async function createHttpMcpClient(port: number, token?: string): Promise<Client> {
  const client = new Client({ name: "relaybase-http-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : undefined
    })
  );
  return client;
}

async function createFakeHttpMcpChild(): Promise<{ port: number; close(): Promise<void> }> {
  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname === "/health") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
      return;
    }

    if (pathname === "/mcp") {
      const mcpServer = createFakeMcpServer("http");
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true
      });
      await mcpServer.connect(transport);
      await transport.handleRequest(request, response);
      response.on("close", () => {
        void transport.close();
        void mcpServer.close();
      });
      return;
    }

    response.writeHead(404);
    response.end();
  });

  await listen(server);
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () => closeServer(server)
  };
}

function listen(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function httpRequest(port: number, pathName: string): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: pathName }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on("end", () =>
        resolve({ statusCode: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") })
      );
    });
    request.once("error", reject);
    request.end();
  });
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
