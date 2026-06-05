import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createRelaybaseServer } from "../src/server.ts";
import { canBindPort, isPortOpen } from "../src/ports.ts";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("proxies HTTP by agent header and host header", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-http-"));
  const upstream = await createHttpUpstream((request) =>
    JSON.stringify({
      url: request.url,
      routedApp: request.headers["x-relaybase-routed-app"]
    })
  );
  const hub = await createRelaybaseServer({ port: 0, stateDir });

  try {
    await hub.runtime.registry.upsertManifest({
      id: "notes",
      name: "Notes",
      command: "external",
      cwd: ".",
      protocol: "http",
      upstreamPort: upstream.port
    });
    await hub.listen();
    const address = hub.address();

    const headerResponse = await httpRequest(address.port, "/from-header", {
      "x-relaybase-app": "notes",
      host: "localhost"
    });
    assert.equal(headerResponse.statusCode, 200);
    assert.equal(JSON.parse(headerResponse.body).url, "/from-header");

    const hostResponse = await httpRequest(address.port, "/from-host", {
      host: `notes.localhost:${address.port}`
    });
    assert.equal(hostResponse.statusCode, 200);
    assert.equal(JSON.parse(hostResponse.body).routedApp, "notes");
  } finally {
    await hub.close();
    await upstream.close();
  }
});

test("reports degraded route health when only the agent header route reaches the app", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-route-degraded-"));
  const upstream = await createConditionalHttpUpstream((request) => {
    const forwardedHost = String(request.headers["x-forwarded-host"] ?? "");
    return {
      statusCode: forwardedHost.startsWith("degraded.localhost") ? 500 : 200,
      body: JSON.stringify({ forwardedHost })
    };
  });
  const hub = await createRelaybaseServer({ port: 0, stateDir });

  try {
    await hub.runtime.registry.upsertManifest({
      id: "degraded",
      name: "Degraded",
      command: "external",
      cwd: ".",
      protocol: "http",
      healthUrl: "/health",
      upstreamPort: upstream.port
    });
    await hub.listen();

    const response = await httpRequest(hub.address().port, "/__hub/api/apps/degraded/state", { host: "localhost" });
    assert.equal(response.statusCode, 200);
    const state = JSON.parse(response.body).state;
    assert.equal(state.routeReachable, true);
    assert.equal(state.routeHealth.status, "degraded");
    assert.equal(state.routeHealth.humanRoute.ok, false);
    assert.equal(state.routeHealth.humanRoute.statusCode, 500);
    assert.equal(state.routeHealth.agentRoute.ok, true);
    assert.equal(state.readiness.state, "ready");
    assert.ok(
      state.readiness.checks.some((check: { name: string; ok: boolean }) => check.name === "human-route" && !check.ok)
    );
  } finally {
    await hub.close();
    await upstream.close();
  }
});

test("reports failed route health when both routed paths return server errors", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-route-failed-"));
  const upstream = await createConditionalHttpUpstream((request) => {
    const routedApp = request.headers["x-relaybase-routed-app"];
    return {
      statusCode: routedApp ? 503 : 200,
      body: JSON.stringify({ routedApp: routedApp ?? null })
    };
  });
  const hub = await createRelaybaseServer({ port: 0, stateDir });

  try {
    await hub.runtime.registry.upsertManifest({
      id: "route-failed",
      name: "Route Failed",
      command: "external",
      cwd: ".",
      protocol: "http",
      healthUrl: "/health",
      upstreamPort: upstream.port
    });
    await hub.listen();

    const response = await httpRequest(hub.address().port, "/__hub/api/apps/route-failed/state", { host: "localhost" });
    assert.equal(response.statusCode, 200);
    const state = JSON.parse(response.body).state;
    assert.equal(state.backendPortOpen, true);
    assert.equal(state.routeReachable, false);
    assert.equal(state.routeHealth.status, "failed");
    assert.equal(state.routeHealth.humanRoute.statusCode, 503);
    assert.equal(state.routeHealth.agentRoute.statusCode, 503);
    assert.equal(state.readiness.state, "unhealthy");
    assert.match(state.readiness.failureReason, /route is not reachable/i);
  } finally {
    await hub.close();
    await upstream.close();
  }
});

test("keeps reserved hub routes on the dashboard/API", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-dashboard-"));
  const hub = await createRelaybaseServer({ port: 0, stateDir });

  try {
    await hub.listen();
    const response = await httpRequest(hub.address().port, "/__hub", { host: "unknown.localhost" });
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /Relaybase/);
  } finally {
    await hub.close();
  }
});

test("proxies upgrade sockets for WebSocket-style dev servers", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-ws-"));
  const upstream = await createUpgradeUpstream();
  const hub = await createRelaybaseServer({ port: 0, stateDir });

  try {
    await hub.runtime.registry.upsertManifest({
      id: "socket",
      name: "Socket",
      command: "external",
      cwd: ".",
      protocol: "http+ws",
      upstreamPort: upstream.port
    });
    await hub.listen();

    const transcript = await rawSocketTranscript(
      hub.address().port,
      [
        "GET /live HTTP/1.1",
        `Host: socket.localhost:${hub.address().port}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13",
        "",
        "ping"
      ].join("\r\n")
    );

    assert.match(transcript, /101 Switching Protocols/);
    assert.match(transcript, /upgraded/);
  } finally {
    await hub.close();
    await upstream.close();
  }
});

test("manages process lifecycle and injects hub env", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-process-"));
  const hub = await createRelaybaseServer({ port: 0, stateDir, portRangeStart: 18100, portRangeEnd: 18120 });
  const logEvents: Array<{ line: string; stream: string }> = [];
  let unsubscribeLogs = () => {};
  let startedManaged = false;

  try {
    await hub.listen();
    const fixture = path.join(rootDir, "tests", "fixtures", "fake-managed-app.ts");
    await hub.runtime.registry.upsertManifest({
      id: "managed",
      name: "Managed",
      command: `"${process.execPath}" --experimental-strip-types "${fixture}"`,
      cwd: rootDir,
      protocol: "http",
      healthUrl: "/health"
    });

    unsubscribeLogs = hub.runtime.processes.subscribeLogs("managed", (event) => logEvents.push(event));
    const runtime = await hub.runtime.processes.start("managed");
    assert.equal(runtime.status, "running");
    startedManaged = true;
    assert.equal(runtime.health, "healthy");
    assert.ok(runtime.assignedPort);
    const managedPort = runtime.assignedPort;
    assert.ok(logEvents.some((event) => event.stream === "stdout" && event.line.includes("fake app listening")));

    const response = await httpRequest(hub.address().port, "/env", {
      "x-relaybase-app": "managed",
      host: "localhost"
    });
    const body = JSON.parse(response.body);
    assert.equal(body.app, "managed");
    assert.match(body.baseUrl, /^http:\/\/managed\.localhost:/);

    const stateResponse = await httpRequest(hub.address().port, "/__hub/api/apps/managed/state", { host: "localhost" });
    assert.equal(stateResponse.statusCode, 200);
    const stateBody = JSON.parse(stateResponse.body);
    assert.equal(stateBody.state.id, "managed");
    assert.equal(stateBody.state.registered, true);
    assert.equal(stateBody.state.runtime.status, "running");
    assert.equal(stateBody.state.runtime.health, "healthy");
    assert.equal(stateBody.state.backendPortOpen, true);
    assert.equal(stateBody.state.routeReachable, true);
    assert.match(stateBody.state.humanUrl, /^http:\/\/managed\.localhost:/);
    assert.match(stateBody.state.agentUrl, /^http:\/\/127\.0\.0\.1:/);
    assert.equal(stateBody.state.agentHeaders["X-Relaybase-App"], "managed");
    assert.match(stateBody.state.logSnapshotUrl, /\/__hub\/api\/apps\/managed\/logs$/);
    assert.match(stateBody.state.logStreamUrl, /\/__hub\/api\/apps\/managed\/logs\/stream$/);
    assert.equal(stateBody.state.readiness.state, "ready");

    const allStateResponse = await httpRequest(hub.address().port, "/__hub/api/state", { host: "localhost" });
    assert.equal(allStateResponse.statusCode, 200);
    assert.ok(
      JSON.parse(allStateResponse.body).apps.some(
        (app: { id: string; routeReachable: boolean }) => app.id === "managed" && app.routeReachable
      )
    );

    const stream = openSseCollector(hub.address().port, "/__hub/api/apps/managed/logs/stream");
    await stream.until("event: snapshot");
    await httpRequest(hub.address().port, "/emit-log?message=fixture%20emitted%20live%20log", {
      "x-relaybase-app": "managed",
      host: "localhost"
    });
    const liveTranscript = await stream.until("fixture emitted live log");
    assert.match(liveTranscript, /event: log/);
    assert.match(liveTranscript, /"appId":"managed"/);
    assert.match(liveTranscript, /"stream":"stdout"/);
    assert.match(liveTranscript, /"sequence":/);
    assert.match(liveTranscript, /"at":/);
    stream.close();

    const stopped = await hub.runtime.processes.stop("managed");
    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.stopVerification?.ok, true);
    assert.equal(await canConnect(managedPort), false);
  } finally {
    if (startedManaged) {
      await hub.runtime.processes.stop("managed").catch(() => undefined);
    }
    unsubscribeLogs();
    await hub.close();
  }
});

test("daemon port policy reserves unique dynamic ports and preserves routes across restart", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-port-policy-"));
  const hub = await createRelaybaseServer({ port: 0, stateDir, portRangeStart: 18640, portRangeEnd: 18649 });
  const fixture = path.join(rootDir, "tests", "fixtures", "fake-managed-app.ts");

  try {
    await hub.listen();
    for (const id of ["port-a", "port-b"]) {
      await hub.runtime.registry.upsertManifest({
        id,
        name: id,
        command: `"${process.execPath}" --experimental-strip-types "${fixture}"`,
        cwd: rootDir,
        protocol: "http",
        healthUrl: "/health",
        env: {
          HEALTH_READY_DELAY_MS: "200"
        }
      });
    }

    const [first, second] = await Promise.all([
      hub.runtime.processes.start("port-a"),
      hub.runtime.processes.start("port-b")
    ]);
    assert.equal(first.status, "running");
    assert.equal(second.status, "running");
    assert.ok(first.assignedPort);
    assert.ok(second.assignedPort);
    assert.notEqual(first.assignedPort, second.assignedPort);

    for (const [appId, runtime] of [
      ["port-a", first],
      ["port-b", second]
    ] as const) {
      const response = await httpRequest(hub.address().port, "/port-check", {
        "x-relaybase-app": appId,
        host: "localhost"
      });
      assert.equal(response.statusCode, 200);
      assert.equal(JSON.parse(response.body).port, String(runtime.assignedPort));
    }

    const restarted = await hub.runtime.processes.restart("port-a");
    assert.equal(restarted.status, "running");
    assert.ok(restarted.assignedPort);
    assert.notEqual(restarted.assignedPort, second.assignedPort);
    const stateResponse = await apiRequest(hub.address().port, "GET", "/__hub/api/apps/port-a/state");
    const state = JSON.parse(stateResponse.body).state;
    assert.equal(state.runtime.status, "running");
    assert.equal(state.routeReachable, true);
    assert.equal(state.runtime.assignedPort, restarted.assignedPort);
  } finally {
    await hub.runtime.processes.stop("port-a").catch(() => undefined);
    await hub.runtime.processes.stop("port-b").catch(() => undefined);
    await hub.close();
  }
});

test("HTTP log snapshots page durable logs across daemon restart", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-durable-logs-"));
  const fixture = path.join(rootDir, "tests", "fixtures", "fake-managed-app.ts");
  let hub: Awaited<ReturnType<typeof createRelaybaseServer>> | undefined = await createRelaybaseServer({
    port: 0,
    stateDir,
    portRangeStart: 18121,
    portRangeEnd: 18129
  });
  let started = false;

  try {
    await hub.listen();
    await hub.runtime.registry.upsertManifest({
      id: "durable",
      name: "Durable",
      command: `"${process.execPath}" --experimental-strip-types "${fixture}"`,
      cwd: rootDir,
      protocol: "http",
      healthUrl: "/health",
      relaybase: {
        groupId: "durable-suite",
        componentRole: "backend",
        displayName: "Durable API",
        paneLabel: "backend",
        paneOrder: 20
      }
    });

    const runtime = await hub.runtime.processes.start("durable");
    started = true;
    assert.equal(runtime.status, "running");
    await httpRequest(hub.address().port, "/emit-log?message=durable%20scrollback%20line", {
      "x-relaybase-app": "durable",
      host: "localhost"
    });
    await hub.runtime.logStore.flush();

    const liveResponse = await apiRequest(hub.address().port, "GET", "/__hub/api/apps/durable/logs?limit=5");
    assert.equal(liveResponse.statusCode, 200);
    const liveBody = JSON.parse(liveResponse.body);
    const liveEvent = liveBody.events.find((event: { message: string }) => event.message === "durable scrollback line");
    assert.equal(liveEvent.groupId, "durable-suite");
    assert.equal(liveEvent.componentRole, "backend");
    assert.equal(liveBody.page.hasMore, typeof liveBody.page.nextBefore === "number");

    await hub.runtime.processes.stop("durable");
    started = false;
    await hub.close();
    hub = undefined;

    hub = await createRelaybaseServer({ port: 0, stateDir });
    await hub.listen();
    const recoveredResponse = await apiRequest(
      hub.address().port,
      "GET",
      `/__hub/api/apps/durable/logs?limit=1&before=${encodeURIComponent(String(liveEvent.sequence + 1))}`
    );
    assert.equal(recoveredResponse.statusCode, 200);
    const recoveredBody = JSON.parse(recoveredResponse.body);
    assert.deepEqual(
      recoveredBody.events.map((event: { message: string }) => event.message),
      ["durable scrollback line"]
    );
    assert.equal(recoveredBody.page.before, liveEvent.sequence + 1);
  } finally {
    if (started) {
      await hub?.runtime.processes.stop("durable").catch(() => undefined);
    }
    await hub?.close();
  }
});

test("exports app logs as log and jsonl artifacts with default redaction", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-log-export-app-"));
  const hub = await createRelaybaseServer({ port: 0, stateDir });

  try {
    await hub.listen();
    await seedExportApps(hub);

    const logResponse = await apiRequest(
      hub.address().port,
      "POST",
      "/__hub/api/logs/export",
      {
        scope: "app",
        appId: "export-web",
        format: "log",
        limit: 100
      },
      { "x-relaybase-token": hub.runtime.token }
    );
    assert.equal(logResponse.statusCode, 202);
    const logExport = JSON.parse(logResponse.body).export;
    assert.equal(logExport.status, "succeeded");
    assert.equal(logExport.format, "log");
    assert.deepEqual(logExport.includedApps, ["export-web"]);
    assert.ok(logExport.outputPath.startsWith(path.join(stateDir, "exports")));
    const logContent = await fs.readFile(logExport.outputPath, "utf8");
    assert.match(logContent, /export-web/);
    assert.match(logContent, /\[redacted\]/);
    assert.doesNotMatch(logContent, /inline-token|hunter2/);
    assert.equal(logContent.includes(hub.runtime.token), false);

    const statusResponse = await apiRequest(
      hub.address().port,
      "GET",
      `/__hub/api/exports/${encodeURIComponent(logExport.exportId)}`,
      undefined,
      { "x-relaybase-token": hub.runtime.token }
    );
    assert.equal(statusResponse.statusCode, 200);
    assert.equal(JSON.parse(statusResponse.body).export.exportId, logExport.exportId);

    const jsonlResponse = await apiRequest(
      hub.address().port,
      "POST",
      "/__hub/api/logs/export",
      {
        scope: "app",
        appId: "export-api",
        format: "jsonl",
        limit: 100
      },
      { "x-relaybase-token": hub.runtime.token }
    );
    assert.equal(jsonlResponse.statusCode, 202);
    const jsonlExport = JSON.parse(jsonlResponse.body).export;
    const jsonlContent = await fs.readFile(jsonlExport.outputPath, "utf8");
    const events = jsonlContent
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { appId: string; message: string; redacted: boolean });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.appId, "export-api");
    assert.equal(events[0]?.redacted, true);
    assert.match(events[0]?.message ?? "", /\[redacted\]/);
    assert.doesNotMatch(jsonlContent, /api-token|super-secret/);
  } finally {
    await hub.close();
  }
});

test("exports group, all, and zip bundles with status and events", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-log-export-zip-"));
  const hub = await createRelaybaseServer({ port: 0, stateDir });
  let stream: ReturnType<typeof openDaemonEventStream> | undefined;

  try {
    await hub.listen();
    await seedExportApps(hub);

    const groupResponse = await apiRequest(
      hub.address().port,
      "POST",
      "/__hub/api/logs/export",
      {
        scope: "group",
        groupId: "export-suite",
        format: "log",
        limit: 100
      },
      { "x-relaybase-token": hub.runtime.token, "x-relaybase-correlation-id": "export-group-test" }
    );
    assert.equal(groupResponse.statusCode, 202);
    const groupExport = JSON.parse(groupResponse.body).export;
    assert.deepEqual(groupExport.includedApps, ["export-api", "export-web"]);
    assert.deepEqual(groupExport.includedGroups, ["export-suite"]);

    stream = openDaemonEventStream(hub.address().port, hub.runtime.token);
    await stream.untilEvent("daemon.ready");
    const allResponse = await apiRequest(
      hub.address().port,
      "POST",
      "/__hub/api/logs/export",
      {
        scope: "all",
        format: "zip",
        limit: 100
      },
      { "x-relaybase-token": hub.runtime.token, "x-relaybase-correlation-id": "export-all-test" }
    );
    assert.equal(allResponse.statusCode, 202);
    const allExport = JSON.parse(allResponse.body).export;
    assert.equal(allExport.status, "succeeded");
    assert.equal(allExport.format, "zip");
    assert.ok(allExport.sizeBytes > 0);
    assert.ok(allExport.redactionReport.replacements >= 2);

    const started = await stream.untilEvent("export.started");
    assert.equal(started.data.type, "export.started");
    const progress = await stream.untilEvent("export.progress");
    assert.equal(progress.data.type, "export.progress");
    const completed = await stream.untilEvent("export.completed");
    assert.equal(completed.data.operationId, allExport.exportId);
    assert.equal(completed.data.correlationId, "export-all-test");

    const zipEntries = readStoredZipEntries(await fs.readFile(allExport.outputPath));
    assert.ok(zipEntries.has("logs/export.log"));
    assert.ok(zipEntries.has("logs/export.jsonl"));
    assert.ok(zipEntries.has("metadata/apps.json"));
    assert.ok(zipEntries.has("metadata/state.json"));
    assert.ok(zipEntries.has("metadata/route-health.json"));
    assert.ok(zipEntries.has("diagnostics/diagnostics.json"));
    assert.ok(zipEntries.has("manifest.json"));
    assert.ok(zipEntries.has("redaction_report.json"));
    const zipLog = zipEntries.get("logs/export.log")?.toString("utf8") ?? "";
    const zipApps = zipEntries.get("metadata/apps.json")?.toString("utf8") ?? "";
    const redactionReport = JSON.parse(zipEntries.get("redaction_report.json")?.toString("utf8") ?? "{}");
    assert.match(zipLog, /\[redacted\]/);
    assert.doesNotMatch(zipLog, /inline-token|api-token|super-secret/);
    assert.equal(zipLog.includes(hub.runtime.token), false);
    assert.doesNotMatch(zipApps, /super-secret/);
    assert.equal(zipApps.includes(hub.runtime.token), false);
    assert.ok(redactionReport.replacements >= 2);
  } finally {
    stream?.close();
    await hub.close();
  }
});

test("rejects invalid log export app, group, and unredacted requests", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-log-export-errors-"));
  const hub = await createRelaybaseServer({ port: 0, stateDir });

  try {
    await hub.listen();
    await seedExportApps(hub);

    const missingApp = await apiRequest(
      hub.address().port,
      "POST",
      "/__hub/api/logs/export",
      { scope: "app", appId: "missing", format: "log" },
      { "x-relaybase-token": hub.runtime.token, "x-relaybase-correlation-id": "missing-export-app" }
    );
    assert.equal(missingApp.statusCode, 404);
    assert.equal(JSON.parse(missingApp.body).relaybaseError.code, "LOG_EXPORT_APP_NOT_FOUND");
    assert.equal(JSON.parse(missingApp.body).relaybaseError.correlationId, "missing-export-app");

    const missingGroup = await apiRequest(
      hub.address().port,
      "POST",
      "/__hub/api/logs/export",
      { scope: "group", groupId: "missing-group", format: "log" },
      { "x-relaybase-token": hub.runtime.token }
    );
    assert.equal(missingGroup.statusCode, 404);
    assert.equal(JSON.parse(missingGroup.body).relaybaseError.code, "LOG_EXPORT_GROUP_NOT_FOUND");

    const unredacted = await apiRequest(
      hub.address().port,
      "POST",
      "/__hub/api/logs/export",
      { scope: "all", format: "log", redact: false },
      { "x-relaybase-token": hub.runtime.token }
    );
    assert.equal(unredacted.statusCode, 400);
    assert.equal(JSON.parse(unredacted.body).relaybaseError.code, "UNREDACTED_LOG_EXPORT_UNSUPPORTED");

    const outsideDestination = await apiRequest(
      hub.address().port,
      "POST",
      "/__hub/api/logs/export",
      {
        scope: "all",
        format: "log",
        destination: path.join(stateDir, "..", "outside-release-candidate.log")
      },
      { "x-relaybase-token": hub.runtime.token, "x-relaybase-correlation-id": "invalid-export-destination" }
    );
    assert.equal(outsideDestination.statusCode, 400);
    const outsideBody = JSON.parse(outsideDestination.body);
    assert.equal(outsideBody.relaybaseError.code, "LOG_EXPORT_DESTINATION_OUTSIDE_EXPORTS");
    assert.equal(outsideBody.relaybaseError.correlationId, "invalid-export-destination");
  } finally {
    await hub.close();
  }
});

test("runs lifecycle hooks, labels hook logs, redacts secrets, and records attempts", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-hooks-"));
  const marker = path.join(stateDir, "hook-marker.txt");
  const hub = await createRelaybaseServer({ port: 0, stateDir, portRangeStart: 18150, portRangeEnd: 18170 });
  const logEvents: Array<{ line: string; stream: string; source?: string }> = [];
  let unsubscribeLogs = () => {};
  let started = false;

  try {
    await hub.listen();
    const fixture = path.join(rootDir, "tests", "fixtures", "fake-managed-app.ts");
    await hub.runtime.registry.upsertManifest({
      id: "hooked",
      name: "Hooked",
      command: `"${process.execPath}" --experimental-strip-types "${fixture}"`,
      cwd: rootDir,
      protocol: "http",
      healthUrl: "/health",
      preStartCommand: hookCommand("success", marker, "pre"),
      stopCommand: hookCommand("success", marker, "stop"),
      verifyStoppedCommand: hookCommand("success", marker, "verify"),
      env: {
        SECRET_TOKEN: "super-secret-value"
      }
    });

    unsubscribeLogs = hub.runtime.processes.subscribeLogs("hooked", (event) => logEvents.push(event));
    const runtime = await hub.runtime.processes.start("hooked");
    started = true;
    assert.equal(runtime.status, "running");
    assert.equal(runtime.phase, "running");
    assert.equal(runtime.lastStartAttempt?.status, "succeeded");
    assert.equal(runtime.lastStartAttempt?.hooks[0]?.name, "preStart");
    assert.equal(runtime.canOpen, true);
    assert.ok(
      logEvents.some((event) => event.source === "preStart" && event.line.includes("[fake-compose:pre] stdout"))
    );
    assert.equal(
      logEvents.some((event) => event.line.includes("super-secret-value")),
      false
    );
    assert.ok(logEvents.some((event) => event.line.includes("[redacted]")));

    const stopped = await hub.runtime.processes.stop("hooked");
    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.phase, "stopped");
    assert.equal(stopped.cleanupStatus, "succeeded");
    assert.equal(stopped.stopVerification?.ok, true);
    assert.equal(stopped.stopVerification?.stopCommand?.status, "succeeded");
    assert.equal(stopped.stopVerification?.verifyStoppedCommand?.status, "succeeded");
    assert.equal(stopped.lastStopAttempt?.status, "succeeded");
    assert.match(await fs.readFile(marker, "utf8"), /pre:success/);
    assert.match(await fs.readFile(marker, "utf8"), /stop:success/);
    assert.match(await fs.readFile(marker, "utf8"), /verify:success/);
  } finally {
    if (started) {
      await hub.runtime.processes.stop("hooked").catch(() => undefined);
    }
    unsubscribeLogs();
    await hub.close();
  }
});

test("does not report stopped when stopCommand fails, times out, or verifyStopped fails", async () => {
  const scenarios: Array<{
    id: string;
    stopMode: string;
    verifyMode?: string;
    expectedPhase: string;
    expectedCleanup: string;
  }> = [
    { id: "stop-fails", stopMode: "fail", expectedPhase: "cleanup_failed", expectedCleanup: "failed" },
    { id: "stop-hangs", stopMode: "hang", expectedPhase: "cleanup_failed", expectedCleanup: "timeout" },
    {
      id: "verify-fails",
      stopMode: "success",
      verifyMode: "fail",
      expectedPhase: "stop_verification_failed",
      expectedCleanup: "verification_failed"
    }
  ];

  for (const scenario of scenarios) {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), `relaybase-${scenario.id}-`));
    const marker = path.join(stateDir, "hook-marker.txt");
    const hub = await createRelaybaseServer({ port: 0, stateDir, portRangeStart: 18180, portRangeEnd: 18199 });
    let started = false;

    try {
      await hub.listen();
      const fixture = path.join(rootDir, "tests", "fixtures", "fake-managed-app.ts");
      await hub.runtime.registry.upsertManifest({
        id: scenario.id,
        name: scenario.id,
        command: `"${process.execPath}" --experimental-strip-types "${fixture}"`,
        cwd: rootDir,
        protocol: "http",
        healthUrl: "/health",
        stopCommand: hookCommand(scenario.stopMode, marker, "stop"),
        ...(scenario.verifyMode ? { verifyStoppedCommand: hookCommand(scenario.verifyMode, marker, "verify") } : {}),
        stopTimeoutMs: 200
      });

      const runtime = await hub.runtime.processes.start(scenario.id);
      assert.equal(runtime.status, "running");
      started = true;
      const stopped = await hub.runtime.processes.stop(scenario.id);
      assert.equal(stopped.status, "errored");
      assert.equal(stopped.phase, scenario.expectedPhase);
      assert.equal(stopped.cleanupStatus, scenario.expectedCleanup);
      assert.equal(stopped.stopVerification?.ok, false);
      assert.equal(stopped.lastStopAttempt?.status, "failed");
    } finally {
      if (started) {
        await hub.close();
      } else {
        await hub.close();
      }
    }
  }
});

test("cleans up after a start that never reaches health", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-start-cleanup-"));
  const marker = path.join(stateDir, "cleanup-marker.txt");
  const hub = await createRelaybaseServer({ port: 0, stateDir, portRangeStart: 18220, portRangeEnd: 18240 });

  try {
    await hub.listen();
    const fixture = path.join(rootDir, "tests", "fixtures", "fake-managed-app.ts");
    await hub.runtime.registry.upsertManifest({
      id: "never-healthy",
      name: "Never Healthy",
      command: `"${process.execPath}" --experimental-strip-types "${fixture}"`,
      cwd: rootDir,
      protocol: "http",
      healthUrl: "/health",
      healthTimeoutMs: 200,
      stopCommand: hookCommand("success", marker, "cleanup"),
      env: {
        HEALTH_READY_DELAY_MS: "5000"
      }
    });

    const runtime = await hub.runtime.processes.start("never-healthy");
    assert.equal(runtime.status, "errored");
    assert.equal(runtime.phase, "errored");
    assert.equal(runtime.cleanupStatus, "succeeded");
    assert.equal(runtime.lastStartAttempt?.status, "failed");
    assert.ok(runtime.lastStartAttempt?.hooks.some((hook) => hook.name === "stop" && hook.status === "succeeded"));
    assert.match(await fs.readFile(marker, "utf8"), /cleanup:success/);
  } finally {
    await hub.runtime.processes.stop("never-healthy").catch(() => undefined);
    await hub.close();
  }
});

test("serializes repeated starts and does not create duplicate backend launches", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-locks-"));
  const hub = await createRelaybaseServer({ port: 0, stateDir, portRangeStart: 18260, portRangeEnd: 18280 });

  try {
    await hub.listen();
    const fixture = path.join(rootDir, "tests", "fixtures", "fake-managed-app.ts");
    await hub.runtime.registry.upsertManifest({
      id: "locked",
      name: "Locked",
      command: `"${process.execPath}" --experimental-strip-types "${fixture}"`,
      cwd: rootDir,
      protocol: "http",
      healthUrl: "/health",
      healthTimeoutMs: 2000,
      env: {
        HEALTH_READY_DELAY_MS: "300"
      }
    });

    const [first, second] = await Promise.all([
      hub.runtime.processes.start("locked"),
      hub.runtime.processes.start("locked")
    ]);

    assert.equal(first.status, "running");
    assert.equal(second.status, "running");
    assert.equal(first.assignedPort, second.assignedPort);
    assert.equal(second.attemptHistory?.filter((attempt) => attempt.kind === "start").length, 1);
  } finally {
    await hub.runtime.processes.stop("locked").catch(() => undefined);
    await hub.close();
  }
});

test("external upstream stop remains route-only unless app owns cleanup", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-external-stop-"));
  const upstream = await createHttpUpstream(() => "external");
  const hub = await createRelaybaseServer({ port: 0, stateDir });

  try {
    await hub.listen();
    await hub.runtime.registry.upsertManifest({
      id: "external",
      name: "External",
      command: "external",
      cwd: ".",
      protocol: "http",
      healthUrl: "/",
      upstreamPort: upstream.port
    });

    const stopped = await hub.runtime.processes.stop("external");
    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.stopVerification?.ok, true);
    assert.equal(await isPortOpen(upstream.port), true);
  } finally {
    await hub.close();
    await upstream.close();
  }
});

test("HTTP API state and apps responses keep current contract and correlation header", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-api-contract-"));
  const hub = await createRelaybaseServer({ port: 0, stateDir });

  try {
    await hub.listen();
    const stateResponse = await apiRequest(hub.address().port, "GET", "/__hub/api/state", undefined, {
      "x-relaybase-correlation-id": "contract-success"
    });
    assert.equal(stateResponse.statusCode, 200);
    assert.equal(stateResponse.headers["x-relaybase-correlation-id"], "contract-success");
    const stateBody = JSON.parse(stateResponse.body);
    assert.ok(Array.isArray(stateBody.apps));
    assert.equal("relaybaseError" in stateBody, false);

    const appsResponse = await apiRequest(hub.address().port, "GET", "/__hub/api/apps");
    assert.equal(appsResponse.statusCode, 200);
    assert.ok(Array.isArray(JSON.parse(appsResponse.body).apps));
  } finally {
    await hub.close();
  }
});

test("HTTP API state includes component groups and manifest metadata diagnostics", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-api-components-"));
  const frontend = await createHttpUpstream(() => "frontend");
  const backend = await createHttpUpstream(() => "backend");
  const hub = await createRelaybaseServer({ port: 0, stateDir });

  try {
    await hub.runtime.registry.upsertManifest({
      id: "notes-web",
      name: "Notes Web",
      command: "external",
      cwd: ".",
      protocol: "http",
      healthUrl: "/",
      upstreamPort: frontend.port,
      relaybase: {
        groupId: "notes",
        componentRole: "frontend",
        displayName: "Notes",
        paneLabel: "frontend",
        paneOrder: 10
      }
    });
    await hub.runtime.registry.upsertManifest({
      id: "notes-api",
      name: "Notes API",
      command: "external",
      cwd: ".",
      protocol: "http",
      healthUrl: "/",
      upstreamPort: backend.port,
      relaybase: {
        groupId: "notes",
        componentRole: "backend",
        displayName: "Notes API",
        paneLabel: "backend",
        paneOrder: 20
      }
    });
    await hub.runtime.registry.upsertManifest({
      id: "solo",
      name: "Solo",
      command: "external",
      cwd: ".",
      protocol: "http"
    });
    await hub.runtime.registry.upsertManifest({
      id: "bad-meta",
      name: "Bad Metadata",
      command: "external",
      cwd: ".",
      protocol: "http",
      relaybase: {
        groupId: "Bad.Group",
        componentRole: "ui",
        paneOrder: "first"
      }
    });
    await hub.listen();

    const response = await apiRequest(hub.address().port, "GET", "/__hub/api/state");
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.ok(Array.isArray(body.apps));
    assert.ok(Array.isArray(body.groups));
    assert.ok(Array.isArray(body.components));
    assert.equal(typeof body.generatedAt, "string");

    const notesGroup = body.groups.find((group: { groupId: string }) => group.groupId === "notes");
    assert.equal(notesGroup.displayName, "Notes");
    assert.equal(notesGroup.aggregateStatus, "running");
    assert.deepEqual(
      notesGroup.components.map((component: { appId: string }) => component.appId),
      ["notes-web", "notes-api"]
    );

    const frontendComponent = body.components.find((component: { appId: string }) => component.appId === "notes-web");
    assert.equal(frontendComponent.role, "frontend");
    assert.equal(frontendComponent.paneLabel, "frontend");
    assert.equal(frontendComponent.paneOrder, 10);
    assert.equal(frontendComponent.route.reachable, true);
    assert.equal(frontendComponent.status, "running");
    assert.equal(frontendComponent.port, frontend.port);

    const backendComponent = body.components.find((component: { appId: string }) => component.appId === "notes-api");
    assert.equal(backendComponent.role, "backend");
    assert.equal(backendComponent.status, "running");

    const soloGroup = body.groups.find((group: { groupId: string }) => group.groupId === "solo");
    assert.equal(soloGroup.components[0].role, "other");
    assert.equal(soloGroup.components[0].paneLabel, "app");
    assert.equal(soloGroup.aggregateStatus, "stopped");

    const badComponent = body.components.find((component: { appId: string }) => component.appId === "bad-meta");
    assert.equal(badComponent.groupId, "bad-meta");
    assert.equal(badComponent.role, "other");
    assert.equal(badComponent.paneOrder, 100);
    assert.ok(
      body.diagnostics.some(
        (diagnostic: { detail: { appId: string; field: string } }) =>
          diagnostic.detail.appId === "bad-meta" && diagnostic.detail.field === "relaybase.componentRole"
      )
    );
  } finally {
    await hub.close();
    await frontend.close();
    await backend.close();
  }
});

test("HTTP mutations return structured unauthorized diagnostics", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-unauth-"));
  const hub = await createRelaybaseServer({ port: 0, stateDir });

  try {
    await hub.listen();
    const suppliedToken = "supplied-secret-token";
    const response = await apiRequest(hub.address().port, "POST", "/__hub/api/apps/anything/start", undefined, {
      "x-relaybase-token": suppliedToken,
      "x-relaybase-correlation-id": "contract-unauthorized"
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.headers["x-relaybase-correlation-id"], "contract-unauthorized");
    const body = JSON.parse(response.body);
    assert.equal(body.code, "UNAUTHORIZED_MUTATION");
    assert.equal(body.recoverable, true);
    assert.equal(body.correlationId, "contract-unauthorized");
    assert.equal(body.details.requiredForMutations, true);
    assert.match(body.details.tokenPath, /session-token$/);
    assert.equal(body.details.tokenPresent, true);
    assert.equal(body.relaybaseError.code, "UNAUTHORIZED_MUTATION");
    assert.equal(body.relaybaseError.retryable, true);
    assert.equal(body.relaybaseError.correlationId, "contract-unauthorized");
    assert.equal(body.relaybaseError.detail.requiredForMutations, true);
    assert.doesNotMatch(response.body, new RegExp(suppliedToken));

    const generated = await apiRequest(hub.address().port, "POST", "/__hub/api/apps/anything/stop");
    const generatedBody = JSON.parse(generated.body);
    const generatedCorrelationId = generated.headers["x-relaybase-correlation-id"];
    assert.equal(generated.statusCode, 401);
    assert.equal(typeof generatedCorrelationId, "string");
    assert.equal(generatedBody.relaybaseError.correlationId, generatedCorrelationId);

    const notFound = await apiRequest(hub.address().port, "GET", "/__hub/api/not-here", undefined, {
      "x-relaybase-correlation-id": "contract-not-found"
    });
    const notFoundBody = JSON.parse(notFound.body);
    assert.equal(notFound.statusCode, 404);
    assert.equal(notFoundBody.code, "NOT_FOUND");
    assert.equal(notFoundBody.recoverable, false);
    assert.equal(notFoundBody.relaybaseError.retryable, false);
    assert.equal(notFoundBody.relaybaseError.correlationId, "contract-not-found");
  } finally {
    await hub.close();
  }
});

test("HTTP lifecycle operations expose async polling and keep synchronous compatibility", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-api-ops-"));
  const hub = await createRelaybaseServer({ port: 0, stateDir, portRangeStart: 18300, portRangeEnd: 18340 });
  const fixture = path.join(rootDir, "tests", "fixtures", "fake-managed-app.ts");

  try {
    await hub.listen();
    await hub.runtime.registry.upsertManifest({
      id: "async-app",
      name: "Async App",
      command: `"${process.execPath}" --experimental-strip-types "${fixture}"`,
      cwd: rootDir,
      protocol: "http",
      healthUrl: "/health"
    });
    await hub.runtime.registry.upsertManifest({
      id: "sync-app",
      name: "Sync App",
      command: `"${process.execPath}" --experimental-strip-types "${fixture}"`,
      cwd: rootDir,
      protocol: "http",
      healthUrl: "/health"
    });

    const startResponse = await apiRequest(
      hub.address().port,
      "POST",
      "/__hub/api/apps/async-app/start?async=true",
      undefined,
      {
        "x-relaybase-token": hub.runtime.token
      }
    );
    assert.equal(startResponse.statusCode, 202);
    const startBody = JSON.parse(startResponse.body);
    assert.equal(typeof startBody.operationId, "string");
    assert.ok(["queued", "running"].includes(startBody.operation.status));

    const startedOperation = await waitForOperation(hub.address().port, startBody.operationId);
    assert.equal(startedOperation.status, "succeeded");
    assert.equal(startedOperation.result.runtime.status, "running");
    assert.equal(startedOperation.result.state.routeReachable, true);

    const stopResponse = await apiRequest(
      hub.address().port,
      "POST",
      "/__hub/api/apps/async-app/stop?async=true",
      undefined,
      {
        "x-relaybase-token": hub.runtime.token
      }
    );
    assert.equal(stopResponse.statusCode, 202);
    const stoppedOperation = await waitForOperation(hub.address().port, JSON.parse(stopResponse.body).operationId);
    assert.equal(stoppedOperation.status, "succeeded");
    assert.equal(stoppedOperation.result.runtime.status, "stopped");

    const syncResponse = await apiRequest(hub.address().port, "POST", "/__hub/api/apps/sync-app/start", undefined, {
      "x-relaybase-token": hub.runtime.token
    });
    assert.equal(syncResponse.statusCode, 200);
    const syncBody = JSON.parse(syncResponse.body);
    assert.equal(typeof syncBody.operationId, "string");
    assert.equal(syncBody.operation.status, "succeeded");
    assert.equal(syncBody.runtime.status, "running");
    assert.equal(syncBody.state.id, "sync-app");
  } finally {
    await hub.runtime.processes.stop("async-app").catch(() => undefined);
    await hub.runtime.processes.stop("sync-app").catch(() => undefined);
    await hub.close();
  }
});

test("HTTP restart operation reports daemon stop-start phase and final running state", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-api-restart-"));
  const hub = await createRelaybaseServer({ port: 0, stateDir, portRangeStart: 18350, portRangeEnd: 18380 });
  const fixture = path.join(rootDir, "tests", "fixtures", "fake-managed-app.ts");

  try {
    await hub.listen();
    await hub.runtime.registry.upsertManifest({
      id: "restartable",
      name: "Restartable",
      command: `"${process.execPath}" --experimental-strip-types "${fixture}"`,
      cwd: rootDir,
      protocol: "http",
      healthUrl: "/health"
    });
    assert.equal((await hub.runtime.processes.start("restartable")).status, "running");

    const response = await apiRequest(
      hub.address().port,
      "POST",
      "/__hub/api/apps/restartable/restart?async=true",
      undefined,
      {
        "x-relaybase-token": hub.runtime.token
      }
    );
    assert.equal(response.statusCode, 202);
    const operation = await waitForOperation(hub.address().port, JSON.parse(response.body).operationId);
    assert.equal(operation.status, "succeeded");
    assert.equal(operation.result.runtime.status, "running");
    assert.ok(operation.messages.some((message: string) => message.includes("stop phase followed by a start phase")));
  } finally {
    await hub.runtime.processes.stop("restartable").catch(() => undefined);
    await hub.close();
  }
});

test("HTTP operation polling returns normalized not-found errors", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-api-op-missing-"));
  const hub = await createRelaybaseServer({ port: 0, stateDir });

  try {
    await hub.listen();
    const response = await apiRequest(hub.address().port, "GET", "/__hub/api/operations/op_missing", undefined, {
      "x-relaybase-correlation-id": "missing-operation"
    });
    assert.equal(response.statusCode, 404);
    const body = JSON.parse(response.body);
    assert.equal(body.code, "OPERATION_NOT_FOUND");
    assert.equal(body.relaybaseError.code, "OPERATION_NOT_FOUND");
    assert.equal(body.relaybaseError.correlationId, "missing-operation");
  } finally {
    await hub.close();
  }
});

test("HTTP lifecycle operations capture failures and timeouts as Relaybase errors", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-api-op-failure-"));
  const hub = await createRelaybaseServer({ port: 0, stateDir, portRangeStart: 18390, portRangeEnd: 18420 });
  const fixture = path.join(rootDir, "tests", "fixtures", "fake-managed-app.ts");

  try {
    await hub.listen();
    const unknownResponse = await apiRequest(
      hub.address().port,
      "POST",
      "/__hub/api/apps/missing/start?async=true",
      undefined,
      {
        "x-relaybase-token": hub.runtime.token,
        "x-relaybase-correlation-id": "missing-start"
      }
    );
    assert.equal(unknownResponse.statusCode, 202);
    const failedOperation = await waitForOperation(hub.address().port, JSON.parse(unknownResponse.body).operationId);
    assert.equal(failedOperation.status, "failed");
    assert.equal(failedOperation.error.code, "LIFECYCLE_OPERATION_FAILED");
    assert.equal(failedOperation.error.correlationId, "missing-start");

    await hub.runtime.registry.upsertManifest({
      id: "timeout-app",
      name: "Timeout App",
      command: `"${process.execPath}" --experimental-strip-types "${fixture}"`,
      cwd: rootDir,
      protocol: "http",
      healthUrl: "/health",
      healthTimeoutMs: 150,
      env: {
        HEALTH_READY_DELAY_MS: "5000"
      }
    });
    const timeoutResponse = await apiRequest(
      hub.address().port,
      "POST",
      "/__hub/api/apps/timeout-app/start?async=true",
      undefined,
      {
        "x-relaybase-token": hub.runtime.token,
        "x-relaybase-correlation-id": "timeout-start"
      }
    );
    assert.equal(timeoutResponse.statusCode, 202);
    const timedOutOperation = await waitForOperation(hub.address().port, JSON.parse(timeoutResponse.body).operationId);
    assert.equal(timedOutOperation.status, "timed_out");
    assert.equal(timedOutOperation.error.code, "LIFECYCLE_TIMED_OUT");
    assert.equal(timedOutOperation.error.correlationId, "timeout-start");
    assert.equal(timedOutOperation.result.runtime.status, "errored");
  } finally {
    await hub.runtime.processes.stop("timeout-app").catch(() => undefined);
    await hub.close();
  }
});

test("HTTP lifecycle operations deduplicate duplicate requests and reject conflicting active requests", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-api-op-concurrent-"));
  const hub = await createRelaybaseServer({ port: 0, stateDir, portRangeStart: 18430, portRangeEnd: 18460 });
  const fixture = path.join(rootDir, "tests", "fixtures", "fake-managed-app.ts");

  try {
    await hub.listen();
    await hub.runtime.registry.upsertManifest({
      id: "concurrent",
      name: "Concurrent",
      command: `"${process.execPath}" --experimental-strip-types "${fixture}"`,
      cwd: rootDir,
      protocol: "http",
      healthUrl: "/health",
      healthTimeoutMs: 3000,
      env: {
        HEALTH_READY_DELAY_MS: "1000"
      }
    });

    const first = await apiRequest(
      hub.address().port,
      "POST",
      "/__hub/api/apps/concurrent/start?async=true",
      undefined,
      {
        "x-relaybase-token": hub.runtime.token
      }
    );
    const second = await apiRequest(
      hub.address().port,
      "POST",
      "/__hub/api/apps/concurrent/start?async=true",
      undefined,
      {
        "x-relaybase-token": hub.runtime.token
      }
    );
    const firstBody = JSON.parse(first.body);
    const secondBody = JSON.parse(second.body);
    assert.equal(first.statusCode, 202);
    assert.equal(second.statusCode, 200);
    assert.equal(secondBody.operationId, firstBody.operationId);
    assert.equal(secondBody.deduplicated, true);

    const conflict = await apiRequest(
      hub.address().port,
      "POST",
      "/__hub/api/apps/concurrent/stop?async=true",
      undefined,
      {
        "x-relaybase-token": hub.runtime.token
      }
    );
    assert.equal(conflict.statusCode, 409);
    const conflictBody = JSON.parse(conflict.body);
    assert.equal(conflictBody.code, "OPERATION_CONFLICT");
    assert.equal(conflictBody.relaybaseError.detail.activeOperation.operationId, firstBody.operationId);

    const operation = await waitForOperation(hub.address().port, firstBody.operationId);
    assert.equal(operation.status, "succeeded");
  } finally {
    await hub.runtime.processes.stop("concurrent").catch(() => undefined);
    await hub.close();
  }
});

test("global daemon event stream connects, heartbeats, reconnects, and cleans up subscribers", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-events-connect-"));
  const hub = await createRelaybaseServer({ port: 0, stateDir });

  try {
    await hub.listen();
    const unauthorized = await apiRequest(hub.address().port, "GET", "/__hub/api/events");
    assert.equal(unauthorized.statusCode, 401);
    const unauthorizedBody = JSON.parse(unauthorized.body);
    assert.equal(unauthorizedBody.code, "UNAUTHORIZED_EVENT_STREAM");
    assert.equal(unauthorizedBody.relaybaseError.code, "UNAUTHORIZED_EVENT_STREAM");

    const stream = openDaemonEventStream(hub.address().port, hub.runtime.token);
    const ready = await stream.untilEvent("daemon.ready");
    assert.equal(ready.data.type, "daemon.ready");
    assert.equal(ready.data.data.reconnect.replay, "not_implemented");
    assert.match(stream.transcript(), /retry: 3000/);

    const health = await stream.untilEvent("daemon.health_changed");
    assert.equal(health.data.type, "daemon.health_changed");
    assert.ok(Number(health.id) > Number(ready.id));
    await waitForCondition(() => hub.runtime.events.subscriberCount === 1);
    await stream.untilRaw(": heartbeat");

    stream.close();
    await waitForCondition(() => hub.runtime.events.subscriberCount === 0);

    const reconnect = openDaemonEventStream(hub.address().port, hub.runtime.token, {
      "Last-Event-ID": health.id ?? ""
    });
    const reconnectReady = await reconnect.untilEvent("daemon.ready");
    assert.equal(reconnectReady.data.data.reconnect.replay, "not_implemented");
    assert.equal(reconnectReady.data.data.reconnect.requiresStateRefresh, true);
    assert.equal(reconnectReady.data.data.reconnect.lastEventId, health.id);
    reconnect.close();
  } finally {
    await hub.close();
  }
});

test("global daemon event stream emits registration, lifecycle, state, route, and log events", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-events-lifecycle-"));
  const hub = await createRelaybaseServer({ port: 0, stateDir, portRangeStart: 18470, portRangeEnd: 18500 });
  const fixture = path.join(rootDir, "tests", "fixtures", "fake-managed-app.ts");
  let stream: ReturnType<typeof openDaemonEventStream> | undefined;

  try {
    await hub.listen();
    stream = openDaemonEventStream(hub.address().port, hub.runtime.token);
    await stream.untilEvent("daemon.ready");

    const registerResponse = await apiRequest(
      hub.address().port,
      "POST",
      "/__hub/api/apps/register",
      {
        id: "evented",
        name: "Evented",
        command: `"${process.execPath}" --experimental-strip-types "${fixture}"`,
        cwd: rootDir,
        protocol: "http",
        healthUrl: "/health",
        env: {
          SECRET_TOKEN: "super-secret-event-token"
        },
        relaybase: {
          groupId: "evented-group",
          componentRole: "frontend",
          displayName: "Evented",
          paneLabel: "frontend",
          paneOrder: 10
        }
      },
      { "x-relaybase-token": hub.runtime.token }
    );
    assert.equal(registerResponse.statusCode, 201);
    const registered = await stream.untilEvent("app.registered");
    assert.equal(registered.data.appId, "evented");
    assert.equal(registered.data.data.app.id, "evented");
    assert.equal(registered.data.data.app.envVarCount, 1);
    assert.equal(registered.data.data.app.relaybase.groupId, "evented-group");
    assert.doesNotMatch(JSON.stringify(registered.data), /super-secret-event-token/);

    const startResponse = await apiRequest(
      hub.address().port,
      "POST",
      "/__hub/api/apps/evented/start?async=true",
      undefined,
      { "x-relaybase-token": hub.runtime.token }
    );
    assert.equal(startResponse.statusCode, 202);
    const operationId = JSON.parse(startResponse.body).operationId;

    const started = await stream.untilEvent("app.lifecycle_operation_started");
    assert.equal(started.data.operationId, operationId);
    const progress = await stream.untilEvent("app.lifecycle_operation_progress");
    assert.equal(progress.data.appId, "evented");
    const log = await stream.untilEvent("log.line_available");
    assert.equal(log.data.appId, "evented");
    assert.equal("line" in log.data.data.log, false);

    const completed = await stream.untilEvent("app.lifecycle_operation_completed");
    assert.equal(completed.data.operationId, operationId);
    assert.equal(completed.data.data.operation.status, "succeeded");
    const stateChanged = await stream.untilEvent("app.state_changed");
    assert.equal(stateChanged.data.appId, "evented");
    assert.equal(stateChanged.data.data.state.id, "evented");
    assert.equal(stateChanged.data.data.component.groupId, "evented-group");
    assert.equal(stateChanged.data.data.component.role, "frontend");
    assert.equal(stateChanged.data.data.group.groupId, "evented-group");
    assert.equal(stateChanged.data.data.group.aggregateStatus, "running");
    assert.equal("recentLogs" in stateChanged.data.data.state, false);
    const routeChanged = await stream.untilEvent("route.health_changed");
    assert.equal(routeChanged.data.data.route.appId, "evented");
  } finally {
    stream?.close();
    await hub.runtime.processes.stop("evented").catch(() => undefined);
    await hub.close();
  }
});

test("global daemon event stream emits lifecycle failure events", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-events-failure-"));
  const hub = await createRelaybaseServer({ port: 0, stateDir });
  let stream: ReturnType<typeof openDaemonEventStream> | undefined;

  try {
    await hub.listen();
    stream = openDaemonEventStream(hub.address().port, hub.runtime.token);
    await stream.untilEvent("daemon.ready");
    const response = await apiRequest(
      hub.address().port,
      "POST",
      "/__hub/api/apps/missing/start?async=true",
      undefined,
      {
        "x-relaybase-token": hub.runtime.token,
        "x-relaybase-correlation-id": "event-failure"
      }
    );
    assert.equal(response.statusCode, 202);
    const failed = await stream.untilEvent("app.lifecycle_operation_failed");
    assert.equal(failed.data.data.operation.status, "failed");
    assert.equal(failed.data.data.operation.error.code, "LIFECYCLE_OPERATION_FAILED");
    assert.equal(failed.data.data.operation.error.correlationId, "event-failure");
  } finally {
    stream?.close();
    await hub.close();
  }
});

test("reports failed stop when backend port remains open", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-stale-port-"));
  let stalePort: number | undefined;
  const hub = await createRelaybaseServer({
    port: 0,
    stateDir,
    portRangeStart: 18130,
    portRangeEnd: 18140,
    stopPortOpenProbe: async (port, host) => (port === stalePort ? true : isPortOpen(port, host))
  });
  let startedStale = false;

  try {
    await hub.listen();
    const fixture = path.join(rootDir, "tests", "fixtures", "fake-managed-app.ts");
    await hub.runtime.registry.upsertManifest({
      id: "stale",
      name: "Stale",
      command: `"${process.execPath}" --experimental-strip-types "${fixture}"`,
      cwd: rootDir,
      protocol: "http",
      healthUrl: "/health"
    });

    const runtime = await hub.runtime.processes.start("stale");
    assert.equal(runtime.status, "running");
    startedStale = true;
    assert.ok(runtime.assignedPort);
    stalePort = runtime.assignedPort;

    const stopped = await hub.runtime.processes.stop("stale");
    assert.equal(stopped.status, "errored");
    assert.match(stopped.lastError ?? "", /backend port .* still open/);
    assert.equal(stopped.stopVerification?.ok, false);
    assert.equal(stopped.stopVerification?.backendPort, stalePort);
    assert.equal(stopped.stopVerification?.backendPortOpen, true);

    const stateResponse = await httpRequest(hub.address().port, "/__hub/api/apps/stale/state", { host: "localhost" });
    const state = JSON.parse(stateResponse.body).state;
    assert.equal(state.stopVerification.ok, false);
    assert.equal(state.stopVerification.backendPortOpen, true);
  } finally {
    if (startedStale) {
      stalePort = undefined;
      await hub.runtime.processes.stop("stale").catch(() => undefined);
    }
    await hub.close();
  }
});

test("reports conflict when fixed managed port is occupied", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-conflict-"));
  const occupied = await createHttpUpstream(() => "occupied");
  const hub = await createRelaybaseServer({ port: 0, stateDir });

  try {
    await hub.listen();
    await hub.runtime.registry.upsertManifest({
      id: "conflict",
      name: "Conflict",
      command: `"${process.execPath}" -e "setInterval(() => {}, 1000)"`,
      cwd: rootDir,
      protocol: "http",
      upstreamPort: occupied.port
    });

    const runtime = await hub.runtime.processes.start("conflict");
    assert.equal(runtime.status, "conflict");
  } finally {
    await hub.close();
    await occupied.close();
  }
});

test("routes basic TCP tunnel handshakes", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-tcp-"));
  const upstream = await createTcpEchoServer();
  const hub = await createRelaybaseServer({ port: 0, stateDir });

  try {
    await hub.runtime.registry.upsertManifest({
      id: "echo",
      name: "Echo",
      command: "external",
      cwd: ".",
      protocol: "tcp",
      upstreamPort: upstream.port
    });
    await hub.listen();

    const response = await tcpEcho(hub.address().port, "RELAYBASE-TCP echo\n\nhello");
    assert.equal(response, "hello");
  } finally {
    await hub.close();
    await upstream.close();
  }
});

test("serves HTTP requests from a child process after TCP tunnel sniff", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-child-http-"));
  const hub = await createRelaybaseServer({ port: 0, stateDir });

  try {
    await hub.listen();
    const result = await childFetchState(hub.address().port, hub.runtime.token);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /^200\n/);
    assert.match(result.stdout, /"apps"/);
  } finally {
    await hub.close();
  }
});

async function createHttpUpstream(
  handler: (request: http.IncomingMessage) => string
): Promise<{ port: number; close(): Promise<void> }> {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(handler(request));
  });
  await listen(server);
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () => closeServer(server)
  };
}

async function waitForOperation(port: number, operationId: string, timeoutMs = 12_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let lastOperation: any;

  while (Date.now() < deadline) {
    const response = await apiRequest(port, "GET", `/__hub/api/operations/${encodeURIComponent(operationId)}`);
    assert.equal(response.statusCode, 200);
    lastOperation = JSON.parse(response.body).operation;
    if (["succeeded", "failed", "timed_out", "cancelled"].includes(lastOperation.status)) {
      return lastOperation;
    }
    await sleep(50);
  }

  assert.fail(`Operation ${operationId} did not finish. Last state: ${JSON.stringify(lastOperation)}`);
}

function openDaemonEventStream(
  port: number,
  token: string,
  headers: Record<string, string> = {}
): {
  untilEvent(eventName: string, timeoutMs?: number): Promise<{ id?: string; event?: string; data: any; raw: string }>;
  untilRaw(needle: string, timeoutMs?: number): Promise<string>;
  transcript(): string;
  close(): void;
} {
  let transcript = "";
  let buffer = "";
  let responseStream: http.IncomingMessage | undefined;
  const events: Array<{ id?: string; event?: string; data: any; raw: string }> = [];
  const eventWaiters: Array<{
    eventName: string;
    resolve: (value: { id?: string; event?: string; data: any; raw: string }) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  const rawWaiters: Array<{
    needle: string;
    resolve: (value: string) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  const request = http.request(
    {
      host: "127.0.0.1",
      port,
      path: "/__hub/api/events",
      headers: {
        accept: "text/event-stream",
        "x-relaybase-token": token,
        ...headers
      }
    },
    (response) => {
      responseStream = response;
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        transcript += chunk;
        buffer += chunk;
        notifyRawWaiters();
        let separator = buffer.indexOf("\n\n");
        while (separator >= 0) {
          const block = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          const event = parseSseBlock(block);
          if (event) {
            events.push(event);
            notifyEventWaiters(event);
          }
          separator = buffer.indexOf("\n\n");
        }
      });
    }
  );

  request.once("error", (error) => {
    rejectWaiters(error instanceof Error ? error : new Error(String(error)));
  });
  request.end();

  return {
    untilEvent(eventName: string, timeoutMs = 8000) {
      const existing = events.find((event) => event.event === eventName);
      if (existing) {
        return Promise.resolve(existing);
      }

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          eventWaiters.splice(
            eventWaiters.findIndex((waiter) => waiter.timer === timer),
            1
          );
          reject(new Error(`Timed out waiting for SSE event ${eventName}. Transcript:\n${transcript}`));
        }, timeoutMs);
        eventWaiters.push({ eventName, resolve, reject, timer });
      });
    },
    untilRaw(needle: string, timeoutMs = 8000) {
      if (transcript.includes(needle)) {
        return Promise.resolve(transcript);
      }

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          rawWaiters.splice(
            rawWaiters.findIndex((waiter) => waiter.timer === timer),
            1
          );
          reject(new Error(`Timed out waiting for SSE text ${needle}. Transcript:\n${transcript}`));
        }, timeoutMs);
        rawWaiters.push({ needle, resolve, reject, timer });
      });
    },
    transcript: () => transcript,
    close() {
      responseStream?.destroy();
      request.destroy();
    }
  };

  function notifyRawWaiters(): void {
    for (const waiter of [...rawWaiters]) {
      if (transcript.includes(waiter.needle)) {
        clearTimeout(waiter.timer);
        rawWaiters.splice(rawWaiters.indexOf(waiter), 1);
        waiter.resolve(transcript);
      }
    }
  }

  function notifyEventWaiters(event: { id?: string; event?: string; data: any; raw: string }): void {
    for (const waiter of [...eventWaiters]) {
      if (event.event === waiter.eventName) {
        clearTimeout(waiter.timer);
        eventWaiters.splice(eventWaiters.indexOf(waiter), 1);
        waiter.resolve(event);
      }
    }
  }

  function rejectWaiters(error: Error): void {
    for (const waiter of eventWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    for (const waiter of rawWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}

function parseSseBlock(block: string): { id?: string; event?: string; data: any; raw: string } | undefined {
  if (!block.trim() || block.startsWith(":")) {
    return undefined;
  }

  const dataLines: string[] = [];
  let id: string | undefined;
  let event: string | undefined;
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("id:")) {
      id = line.slice(3).trim();
    } else if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
  }

  if (!event || dataLines.length === 0) {
    return undefined;
  }

  return {
    id,
    event,
    data: JSON.parse(dataLines.join("\n")),
    raw: block
  };
}

async function seedExportApps(hub: Awaited<ReturnType<typeof createRelaybaseServer>>): Promise<void> {
  await hub.runtime.registry.upsertManifest({
    id: "export-web",
    name: "Export Web",
    command: "external",
    cwd: ".",
    protocol: "http",
    env: {
      SECRET_TOKEN: "super-secret"
    },
    relaybase: {
      groupId: "export-suite",
      componentRole: "frontend",
      displayName: "Export",
      paneLabel: "frontend",
      paneOrder: 10
    }
  });
  await hub.runtime.registry.upsertManifest({
    id: "export-api",
    name: "Export API",
    command: "external",
    cwd: ".",
    protocol: "http",
    env: {
      API_TOKEN: "api-token"
    },
    relaybase: {
      groupId: "export-suite",
      componentRole: "backend",
      displayName: "Export API",
      paneLabel: "backend",
      paneOrder: 20
    }
  });
  await hub.runtime.logStore.append({
    appId: "export-web",
    groupId: "export-suite",
    componentRole: "frontend",
    stream: "stdout",
    source: "start",
    message: `web ready token=inline-token relaybase_token=${hub.runtime.token}`
  });
  await hub.runtime.logStore.append({
    appId: "export-api",
    groupId: "export-suite",
    componentRole: "backend",
    stream: "stderr",
    source: "start",
    message: "api warning password=hunter2 Authorization: Bearer api-token"
  });
  await hub.runtime.logStore.flush();
}

function readStoredZipEntries(buffer: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;

  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    assert.equal(method, 0);
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString("utf8");
    entries.set(name, buffer.subarray(dataStart, dataEnd));
    offset = dataEnd;
  }

  assert.ok(entries.size > 0);
  assert.equal(buffer.readUInt32LE(offset), 0x02014b50);
  return entries;
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(25);
  }
  assert.fail("Timed out waiting for condition.");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createConditionalHttpUpstream(
  handler: (request: http.IncomingMessage) => { statusCode: number; body: string }
): Promise<{ port: number; close(): Promise<void> }> {
  const server = http.createServer((request, response) => {
    const result = handler(request);
    response.writeHead(result.statusCode, { "content-type": "application/json" });
    response.end(result.body);
  });
  await listen(server);
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () => closeServer(server)
  };
}

async function createUpgradeUpstream(): Promise<{ port: number; close(): Promise<void> }> {
  const server = http.createServer();
  server.on("upgrade", (_request, socket) => {
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    socket.end("upgraded");
  });
  await listen(server);
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () => closeServer(server)
  };
}

async function createTcpEchoServer(): Promise<{ port: number; close(): Promise<void> }> {
  const server = net.createServer((socket) => socket.pipe(socket));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () => new Promise((resolve) => server.close(() => resolve()))
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

function hookCommand(mode: string, marker: string, label: string): string {
  const fixture = path.join(rootDir, "tests", "fixtures", "fake-compose-hook.cjs");
  return `"${process.execPath}" "${fixture}" --mode ${mode} --marker "${marker}" --label ${label}`;
}

function httpRequest(
  port: number,
  pathName: string,
  headers: Record<string, string>
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: pathName, headers }, (response) => {
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

function childFetchState(
  port: number,
  token: string
): Promise<{ status: number | null; stdout: string; stderr: string; error?: string }> {
  const code = [
    "const url = process.env.RELAYBASE_TEST_URL;",
    "const token = process.env.RELAYBASE_TEST_TOKEN;",
    "fetch(url, { headers: { authorization: `Bearer ${token}` } })",
    "  .then(async (response) => {",
    "    console.log(response.status);",
    "    console.log(await response.text());",
    "  })",
    "  .catch((error) => {",
    "    console.error(error instanceof Error ? error.message : String(error));",
    "    process.exitCode = 1;",
    "  });"
  ].join("\n");

  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", code], {
      env: {
        ...process.env,
        RELAYBASE_TEST_URL: `http://127.0.0.1:${port}/__hub/api/state`,
        RELAYBASE_TEST_TOKEN: token
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      resolve({ status: null, stdout, stderr, error: "timed out after 5000ms" });
    }, 5000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({ status: null, stdout, stderr, error: error.message });
    });
    child.once("exit", (status) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({ status, stdout, stderr });
    });
  });
}

function apiRequest(
  port: number,
  method: string,
  pathName: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<{ statusCode: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathName,
        method,
        headers: {
          host: "localhost",
          ...(payload
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload).toString() }
            : {}),
          ...headers
        }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on("end", () =>
          resolve({
            statusCode: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            headers: response.headers
          })
        );
      }
    );
    request.once("error", reject);
    if (payload) {
      request.write(payload);
    }
    request.end();
  });
}

function openSseCollector(
  port: number,
  pathName: string,
  headers: Record<string, string> = {}
): {
  until(needle: string, timeoutMs?: number): Promise<string>;
  close(): void;
} {
  let transcript = "";
  let responseStream: http.IncomingMessage | undefined;
  const waiters: Array<{
    needle: string;
    resolve: (value: string) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  const request = http.request(
    {
      host: "127.0.0.1",
      port,
      path: pathName,
      headers: { accept: "text/event-stream", ...headers }
    },
    (response) => {
      responseStream = response;
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        transcript += chunk;
        for (const waiter of [...waiters]) {
          if (transcript.includes(waiter.needle)) {
            clearTimeout(waiter.timer);
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.resolve(transcript);
          }
        }
      });
    }
  );

  request.once("error", (error) => {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
  request.end();

  return {
    until(needle: string, timeoutMs = 5000): Promise<string> {
      if (transcript.includes(needle)) {
        return Promise.resolve(transcript);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.needle === needle);
          if (index >= 0) {
            waiters.splice(index, 1);
          }
          reject(new Error(`Timed out waiting for SSE text: ${needle}`));
        }, timeoutMs);
        waiters.push({ needle, resolve, reject, timer });
      });
    },
    close(): void {
      responseStream?.destroy();
      request.destroy();
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
      }
    }
  };
}

function rawSocketTranscript(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];
    socket.once("connect", () => socket.write(payload));
    socket.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      if (Buffer.concat(chunks).toString("utf8").includes("ping")) {
        socket.end();
      }
    });
    socket.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.once("error", reject);
    setTimeout(() => {
      socket.end();
      resolve(Buffer.concat(chunks).toString("utf8"));
    }, 1000).unref();
  });
}

function tcpEcho(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];
    socket.once("connect", () => socket.write(payload));
    socket.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      socket.end();
    });
    socket.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.once("error", reject);
  });
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 1000).unref();
  });
}

test("can bind random test ports", async () => {
  assert.equal(await canBindPort(0), true);
});
