import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { namespaceChildName, relaybaseChildResourceUri } from "../src/childMcp.ts";
import { composeAppState } from "../src/appState.ts";
import { dashboardHtml } from "../src/dashboard.ts";
import { Registry } from "../src/registry.ts";
import { appIdFromHost, resolveRoute } from "../src/router.ts";
import { normalizeManifest, validateAppId } from "../src/validation.ts";

test("validates app ids", () => {
  assert.doesNotThrow(() => validateAppId("notes"));
  assert.doesNotThrow(() => validateAppId("notes-api-2"));
  assert.throws(() => validateAppId("Notes"));
  assert.throws(() => validateAppId("-notes"));
  assert.throws(() => validateAppId("notes.local"));
});

test("normalizes manifests with relative cwd and env", () => {
  const manifestPath = path.join(os.tmpdir(), "relaybase-manifest", "relaybase.app.json");
  const app = normalizeManifest(
    {
      id: "notes",
      name: "Notes",
      command: "npm.cmd run dev",
      cwd: "app",
      protocol: "http",
      healthUrl: "/health",
      env: { NODE_ENV: "development" },
      upstreamPort: 18001
    },
    { manifestPath, now: new Date("2026-05-06T00:00:00.000Z") }
  );

  assert.equal(app.id, "notes");
  assert.equal(app.cwd, path.join(os.tmpdir(), "relaybase-manifest", "app"));
  assert.equal(app.env.NODE_ENV, "development");
  assert.equal(app.upstreamPort, 18001);
});

test("normalizes lifecycle hook fields and rejects invalid timeouts", () => {
  const app = normalizeManifest({
    id: "compose-app",
    name: "Compose App",
    command: ".\\scripts\\relaybase-start.ps1",
    cwd: ".",
    protocol: "http",
    preStartCommand: ".\\scripts\\relaybase-prestart.ps1",
    stopCommand: ".\\scripts\\relaybase-stop.ps1",
    verifyStoppedCommand: ".\\scripts\\relaybase-verify-stopped.ps1",
    preStartTimeoutMs: 120000,
    startTimeoutMs: 600000,
    stopTimeoutMs: 60000,
    healthTimeoutMs: 30000
  });

  assert.equal(app.schemaVersion, 1);
  assert.equal(app.preStartCommand, ".\\scripts\\relaybase-prestart.ps1");
  assert.equal(app.stopTimeoutMs, 60000);
  assert.throws(
    () =>
      normalizeManifest({
        id: "bad-timeout",
        name: "Bad Timeout",
        command: "node server.js",
        stopTimeoutMs: 1
      }),
    /stopTimeoutMs/
  );
});

test("normalizes MCP child blocks with exact allowlists", () => {
  const manifestPath = path.join(os.tmpdir(), "relaybase-mcp-manifest", "relaybase.app.json");
  const app = normalizeManifest(
    {
      schemaVersion: 1,
      id: "notes",
      name: "Notes",
      command: "npm.cmd run dev",
      cwd: "app",
      protocol: "http",
      mcp: {
        enabled: true,
        children: [
          {
            id: "tools",
            transport: "stdio",
            command: "node",
            args: ["./mcp-server.js"],
            cwd: ".",
            expose: {
              tools: ["search", "search"],
              resources: ["docs://index"],
              prompts: ["debug"]
            }
          }
        ]
      }
    },
    { manifestPath, now: new Date("2026-05-06T00:00:00.000Z") }
  );

  assert.equal(app.schemaVersion, 1);
  assert.equal(app.mcp?.enabled, true);
  assert.equal(app.mcp?.children[0].cwd, path.join(os.tmpdir(), "relaybase-mcp-manifest", "app"));
  assert.deepEqual(app.mcp?.children[0].expose.tools, ["search"]);
});

test("rejects wildcard MCP child exposure", () => {
  assert.throws(
    () =>
      normalizeManifest({
        id: "notes",
        name: "Notes",
        command: "npm.cmd run dev",
        cwd: ".",
        protocol: "http",
        mcp: {
          enabled: true,
          children: [
            {
              id: "tools",
              transport: "stdio",
              command: "node",
              expose: {
                tools: ["*"],
                resources: [],
                prompts: []
              }
            }
          ]
        }
      }),
    /wildcard/
  );
});

test("generates child MCP namespaces and Relaybase resource URIs", () => {
  assert.equal(namespaceChildName("notes", "search"), "notes.search");
  assert.equal(relaybaseChildResourceUri("notes", "docs://index"), "relaybase://app/notes/mcp/docs://index");
});

test("generates standard app state shape", () => {
  const state = composeAppState({
    id: "notes",
    name: "Notes",
    registered: true,
    runtime: {
      status: "running",
      health: "healthy",
      pid: 123,
      assignedPort: 18001,
      logLines: 2
    },
    hubHost: "127.0.0.1",
    hubPort: 7777,
    backendPort: 18001,
    backendPortOpen: true,
    routeReachable: true,
    recentLogs: ["ready"],
    readinessCheckedAt: "2026-05-08T00:00:00.000Z",
    timeoutMs: 8000
  });

  assert.equal(state.id, "notes");
  assert.equal(state.registered, true);
  assert.equal(state.runtime.status, "running");
  assert.equal(state.backendPortOpen, true);
  assert.equal(state.routeReachable, true);
  assert.equal(state.humanUrl, "http://notes.localhost:7777");
  assert.equal(state.agentUrl, "http://127.0.0.1:7777");
  assert.deepEqual(state.agentHeaders, { "X-Relaybase-App": "notes" });
  assert.match(state.logSnapshotUrl, /\/__hub\/api\/apps\/notes\/logs$/);
  assert.match(state.logStreamUrl, /\/__hub\/api\/apps\/notes\/logs\/stream$/);
  assert.equal(state.readiness.state, "ready");
  assert.ok(state.readiness.checks.some((check) => check.name === "route-reachable" && check.ok));
});

test("persists registry records", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-registry-"));
  const registry = new Registry(stateDir);
  await registry.load();
  await registry.upsertManifest({
    id: "alpha",
    name: "Alpha",
    command: "node server.js",
    cwd: ".",
    protocol: "http"
  });

  const reloaded = new Registry(stateDir);
  await reloaded.load();
  assert.equal((await reloaded.get("alpha"))?.name, "Alpha");
});

test("dashboard labels app backend ports explicitly", () => {
  const html = dashboardHtml({
    token: "test-token",
    apps: [
      {
        id: "fixed-app",
        name: "Fixed App",
        command: "node server.js",
        cwd: ".",
        protocol: "http",
        env: {},
        upstreamPort: 3000,
        createdAt: "2026-05-08T00:00:00.000Z",
        updatedAt: "2026-05-08T00:00:00.000Z",
        runtime: {
          status: "stopped",
          health: "unknown",
          logLines: 0,
          canStart: true,
          canStop: false
        }
      }
    ]
  });

  assert.match(html, /<th scope="col">Backend port<\/th>/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /aria-label="Start ' \+ appLabel/);
  assert.match(html, /aria-label="Stop ' \+ appLabel/);
  assert.match(html, /disabled aria-disabled="true"/);
  assert.doesNotMatch(html, /<th>Port<\/th>/);
  assert.match(html, /fixed :/);
  assert.match(html, /requested/);
});

test("resolves agent header before host header", () => {
  const route = resolveRoute({
    url: "/",
    headers: {
      "x-relaybase-app": "api",
      host: "human.localhost:7777"
    }
  });

  assert.deepEqual(route, { kind: "app", appId: "api", source: "header" });
});

test("resolves hub and host routes", () => {
  assert.deepEqual(resolveRoute({ url: "/__hub", headers: { host: "notes.localhost:7777" } }), { kind: "hub" });
  assert.equal(appIdFromHost("notes.localhost:7777"), "notes");
  assert.equal(appIdFromHost("localhost:7777"), undefined);
});
