import assert from "node:assert/strict";
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
  const upstream = await createHttpUpstream((request) => JSON.stringify({
    url: request.url,
    routedApp: request.headers["x-relaybase-routed-app"]
  }));
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

    const transcript = await rawSocketTranscript(hub.address().port, [
      "GET /live HTTP/1.1",
      `Host: socket.localhost:${hub.address().port}`,
      "Connection: Upgrade",
      "Upgrade: websocket",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      "Sec-WebSocket-Version: 13",
      "",
      "ping"
    ].join("\r\n"));

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
    assert.ok(JSON.parse(allStateResponse.body).apps.some((app: { id: string; routeReachable: boolean }) => app.id === "managed" && app.routeReachable));

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

test("HTTP mutations return structured unauthorized diagnostics", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-unauth-"));
  const hub = await createRelaybaseServer({ port: 0, stateDir });

  try {
    await hub.listen();
    const response = await apiRequest(hub.address().port, "POST", "/__hub/api/apps/anything/start");
    assert.equal(response.statusCode, 401);
    const body = JSON.parse(response.body);
    assert.equal(body.code, "UNAUTHORIZED_MUTATION");
    assert.equal(body.recoverable, true);
    assert.equal(body.details.requiredForMutations, true);
    assert.match(body.details.tokenPath, /session-token$/);
    assert.equal(body.details.tokenPresent, true);
  } finally {
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
    stopPortOpenProbe: async (port, host) => port === stalePort ? true : isPortOpen(port, host)
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

async function createHttpUpstream(handler: (request: http.IncomingMessage) => string): Promise<{ port: number; close(): Promise<void> }> {
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

function httpRequest(port: number, pathName: string, headers: Record<string, string>): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: pathName, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on("end", () => resolve({ statusCode: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.once("error", reject);
    request.end();
  });
}

function apiRequest(port: number, method: string, pathName: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request({
      host: "127.0.0.1",
      port,
      path: pathName,
      method,
      headers: {
        host: "localhost",
        ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload).toString() } : {}),
        ...headers
      }
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on("end", () => resolve({ statusCode: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.once("error", reject);
    if (payload) {
      request.write(payload);
    }
    request.end();
  });
}

function openSseCollector(port: number, pathName: string, headers: Record<string, string> = {}): {
  until(needle: string, timeoutMs?: number): Promise<string>;
  close(): void;
} {
  let transcript = "";
  let responseStream: http.IncomingMessage | undefined;
  const waiters: Array<{ needle: string; resolve: (value: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }> = [];
  const request = http.request({
    host: "127.0.0.1",
    port,
    path: pathName,
    headers: { accept: "text/event-stream", ...headers }
  }, (response) => {
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
  });

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
      chunks.push(chunk);
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
      chunks.push(chunk);
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
