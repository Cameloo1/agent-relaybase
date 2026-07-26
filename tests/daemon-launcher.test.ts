import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { discovery, ensureDaemon, resolveDaemonRuntimeInvocation, sameStateDirectory } from "../src/daemonLauncher.ts";

test("daemon launcher resolves the TypeScript sibling with strip-types enabled", () => {
  const launcherPath = path.join(os.tmpdir(), "relaybase-source", "daemonLauncher.ts");
  const cliPath = path.join(path.dirname(launcherPath), "cli.ts");

  assert.deepEqual(resolveDaemonRuntimeInvocation(pathToFileURL(launcherPath).href), {
    cliPath,
    nodeArgs: ["--experimental-strip-types", cliPath]
  });
});

test("daemon launcher resolves the compiled JavaScript sibling without TypeScript flags", () => {
  const launcherPath = path.join(os.tmpdir(), "relaybase-package", "dist-runtime", "daemonLauncher.js");
  const cliPath = path.join(path.dirname(launcherPath), "cli.js");

  assert.deepEqual(resolveDaemonRuntimeInvocation(pathToFileURL(launcherPath).href), {
    cliPath,
    nodeArgs: [cliPath]
  });
});

test("daemon launcher rejects unsupported runtime extensions", () => {
  const launcherPath = path.join(os.tmpdir(), "relaybase-package", "dist-runtime", "daemonLauncher.mjs");

  assert.throws(
    () => resolveDaemonRuntimeInvocation(pathToFileURL(launcherPath).href),
    /Unsupported Relaybase daemon launcher extension: \.mjs/
  );
});

test("daemon discovery proves Relaybase identity, state directory, and authenticated session", async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-discovery-ready-"));
  await fs.writeFile(path.join(stateDir, "session-token"), "matching-token\n", "utf8");
  const fixture = await discoveryServer(stateDir, "matching-token");
  t.after(fixture.close);

  const result = await discovery({ cwd: process.cwd(), host: "127.0.0.1", port: fixture.port, stateDir });
  assert.equal(result.code, "daemon_ready");
  assert.equal(result.transportReachable, true);
  assert.equal(result.reachable, true);
  assert.equal(result.compatible, true);
  assert.equal(result.authenticated, true);
  assert.equal(result.stateDirMatches, true);
  assert.equal(result.daemonStateDir, stateDir);
  assert.equal(result.instanceId, "daemon-fixture-instance");
  assert.equal(result.pid, 4242);
  assert.equal(result.startedAt, "2026-07-23T00:00:00.000Z");
});

test("daemon discovery reports a state mismatch without reading or copying the daemon token", async (t) => {
  const daemonStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-discovery-daemon-"));
  const clientStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-discovery-client-"));
  await fs.writeFile(path.join(clientStateDir, "session-token"), "client-only-token\n", "utf8");
  const fixture = await discoveryServer(daemonStateDir, "daemon-only-token");
  t.after(fixture.close);

  const options = { cwd: process.cwd(), host: "127.0.0.1", port: fixture.port, stateDir: clientStateDir };
  const result = await discovery(options);
  assert.equal(result.code, "daemon_state_mismatch");
  assert.equal(result.reachable, true);
  assert.equal(result.compatible, false);
  assert.equal(result.authenticated, false);
  assert.equal(fixture.sessionRequests(), 0);
  assert.doesNotMatch(JSON.stringify(result), /client-only-token|daemon-only-token/);

  const ensured = await ensureDaemon(options, true);
  assert.equal(ensured.code, "daemon_state_mismatch");
  assert.equal(ensured.reachable, true);
  assert.equal(ensured.compatible, false);
  assert.equal(ensured.started, false);
});

test("daemon discovery distinguishes a rejected token from an offline daemon", async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-discovery-auth-"));
  await fs.writeFile(path.join(stateDir, "session-token"), "stale-token\n", "utf8");
  const fixture = await discoveryServer(stateDir, "current-token");
  t.after(fixture.close);

  const result = await discovery({ cwd: process.cwd(), host: "127.0.0.1", port: fixture.port, stateDir });
  assert.equal(result.code, "daemon_auth_invalid");
  assert.equal(result.transportReachable, true);
  assert.equal(result.reachable, true);
  assert.equal(result.compatible, false);
  assert.equal(result.authStatusCode, 401);
});

test("daemon discovery distinguishes a missing selected-state token from offline", async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-discovery-missing-auth-"));
  const fixture = await discoveryServer(stateDir, "daemon-token");
  t.after(fixture.close);

  const result = await discovery({ cwd: process.cwd(), host: "127.0.0.1", port: fixture.port, stateDir });
  assert.equal(result.code, "daemon_auth_missing");
  assert.equal(result.transportReachable, true);
  assert.equal(result.reachable, true);
  assert.equal(result.compatible, false);
  assert.equal(result.authenticated, false);
  assert.equal(result.stateDirMatches, true);
  assert.equal(fixture.sessionRequests(), 0);
});

test("state directory comparison is stable for Windows path case and separators", () => {
  assert.equal(sameStateDirectory("C:\\Users\\Example\\Relaybase\\", "c:/users/example/relaybase"), true);
  assert.equal(sameStateDirectory("C:\\Users\\Example\\tmp\\..\\Relaybase", "c:/users/example/relaybase"), true);
  assert.equal(sameStateDirectory("C:\\Users\\Example\\Relaybase", "C:\\Users\\Example\\Other"), false);
});

async function discoveryServer(
  stateDir: string,
  token: string
): Promise<{
  port: number;
  close: () => Promise<void>;
  sessionRequests: () => number;
}> {
  let sessionRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === "/.well-known/mcp.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          product: "Relaybase",
          package: "@cameloo/relaybase",
          auth: { stateDir, tokenPresent: true },
          daemon: {
            instanceId: "daemon-fixture-instance",
            pid: 4242,
            startedAt: "2026-07-23T00:00:00.000Z"
          }
        })
      );
      return;
    }
    if (request.url === "/__hub/api/session") {
      sessionRequests += 1;
      if (request.headers["x-relaybase-token"] !== token) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ code: "UNAUTHORIZED_SESSION" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ session: { authenticated: true, stateDir } }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not return a TCP address");
  }
  return {
    port: address.port,
    sessionRequests: () => sessionRequests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}
