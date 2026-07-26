import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { dashboardHtml, dashboardInventory } from "../src/dashboard.ts";
import { createRelaybaseServer } from "../src/server.ts";
import type { AppStatusView } from "../src/types.ts";

test("dashboard keeps read-only inventory UX without lifecycle credentials", () => {
  const unsafeOptions = { token: "local-dashboard-token", apps: [appFixture()] };
  const html = dashboardHtml(unsafeOptions);

  for (const expected of [
    'id="search"',
    'id="status-filter"',
    'value="attention"',
    'id="details"',
    "actionButton('inspect'",
    "/__hub/api/dashboard/apps",
    'credentials: "omit"',
    "Needs attention",
    "return true",
    "return false"
  ]) {
    assert.ok(html.includes(expected), `expected dashboard HTML to include ${expected}`);
  }

  for (const forbidden of [
    "local-dashboard-token",
    "X-Relaybase-Token",
    'method: "POST"',
    "actionButton('start'",
    "actionButton('stop'",
    "/logs?limit=",
    "/state"
  ]) {
    assert.equal(html.includes(forbidden), false, `dashboard must not expose ${forbidden}`);
  }
});

test("dashboard initial state omits private app and runtime fields", () => {
  const unsafeOptions = {
    token: "credential-should-never-render",
    apps: [
      appFixture({
        command: "secret-command --api-key command-secret",
        cwd: "C:\\sensitive\\workspace",
        env: { API_TOKEN: "environment-secret" },
        manifestPath: "C:\\sensitive\\relaybase.app.json",
        runtime: {
          status: "errored",
          health: "unhealthy",
          logLines: 2,
          canOpen: false,
          lastError: "failed with runtime-secret"
        }
      })
    ]
  };
  const html = dashboardHtml(unsafeOptions);

  for (const forbidden of [
    "credential-should-never-render",
    "secret-command",
    "command-secret",
    "sensitive\\\\workspace",
    "API_TOKEN",
    "environment-secret",
    "relaybase.app.json",
    "runtime-secret"
  ]) {
    assert.equal(html.includes(forbidden), false, `dashboard initial state must omit ${forbidden}`);
  }
});

test("dashboard inventory has an explicit public field allowlist", () => {
  const [app] = dashboardInventory([
    appFixture({
      upstreamPort: 3100,
      runtime: {
        status: "running",
        health: "healthy",
        assignedPort: 3100,
        logLines: 20,
        canOpen: true,
        lastError: "must not cross public boundary"
      }
    })
  ]);

  assert.deepEqual(app, {
    id: "notes",
    name: "Notes",
    status: "running",
    health: "healthy",
    routeAvailable: true,
    backendPort: 3100,
    configuredPort: 3100,
    backendPortKind: "fixed",
    needsAttention: false
  });
  assert.deepEqual(Object.keys(app ?? {}).sort(), [
    "backendPort",
    "backendPortKind",
    "configuredPort",
    "health",
    "id",
    "name",
    "needsAttention",
    "routeAvailable",
    "status"
  ]);
});

test("dashboard protects initial state from closing the script element", () => {
  const html = dashboardHtml({ apps: [appFixture({ name: "</script><script>alert(1)</script>" })] });

  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /\\u003c\/script>/);
});

test("an app localhost origin receives only the safe dashboard inventory", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-dashboard-security-"));
  const hub = await createRelaybaseServer({ port: 0, stateDir });
  try {
    await hub.runtime.registry.upsertManifest({
      id: "private-app",
      name: "Private App",
      command: "secret-dashboard-command",
      cwd: "C:\\private-dashboard-cwd",
      protocol: "http",
      env: { DASHBOARD_SECRET: "private-dashboard-secret" }
    });
    await hub.listen();
    const headers = { host: `private-app.localhost:${hub.address().port}` };

    const page = await request(hub.address().port, "/__hub", headers);
    assert.equal(page.statusCode, 200);
    for (const forbidden of [
      hub.runtime.token,
      "secret-dashboard-command",
      "private-dashboard-cwd",
      "private-dashboard-secret"
    ])
      assert.equal(page.body.includes(forbidden), false);
    assert.equal(page.body.includes('method: "POST"'), false);

    const inventoryResponse = await request(hub.address().port, "/__hub/api/dashboard/apps", headers);
    assert.equal(inventoryResponse.statusCode, 200);
    const inventory = JSON.parse(inventoryResponse.body) as { apps: Array<Record<string, unknown>> };
    assert.deepEqual(Object.keys(inventory.apps[0] ?? {}).sort(), [
      "backendPortKind",
      "health",
      "id",
      "name",
      "needsAttention",
      "routeAvailable",
      "status"
    ]);
    assert.equal(inventoryResponse.body.includes(hub.runtime.token), false);
    assert.equal(inventoryResponse.body.includes("private-dashboard-secret"), false);

    for (const richPath of ["/__hub/api/state", "/__hub/api/apps", "/__hub/api/apps/private-app/state"]) {
      const blocked = await request(hub.address().port, richPath, headers);
      assert.equal(blocked.statusCode, 401, `${richPath} must require the session token`);
      assert.equal(blocked.body.includes(hub.runtime.token), false);
      assert.equal(blocked.body.includes("private-dashboard-secret"), false);
    }
  } finally {
    await hub.close();
  }
});

function request(
  port: number,
  pathName: string,
  headers: Record<string, string>
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const pending = http.request({ host: "127.0.0.1", port, path: pathName, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on("end", () =>
        resolve({ statusCode: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") })
      );
    });
    pending.once("error", reject);
    pending.end();
  });
}

function appFixture(overrides: Partial<AppStatusView> = {}): AppStatusView {
  return {
    id: "notes",
    name: "Notes",
    command: "npm.cmd run dev",
    cwd: ".",
    protocol: "http",
    env: {},
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    runtime: {
      status: "stopped",
      health: "unknown",
      logLines: 0,
      canStart: true,
      canStop: false,
      canOpen: false,
      primaryAction: "start"
    },
    ...overrides
  };
}
