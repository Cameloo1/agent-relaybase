import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createRelaybaseServer } from "../src/server.ts";
import { canBindPort } from "../src/ports.ts";

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

    const runtime = await hub.runtime.processes.start("managed");
    assert.equal(runtime.status, "running");
    assert.equal(runtime.health, "healthy");
    assert.ok(runtime.assignedPort);

    const response = await httpRequest(hub.address().port, "/env", {
      "x-relaybase-app": "managed",
      host: "localhost"
    });
    const body = JSON.parse(response.body);
    assert.equal(body.app, "managed");
    assert.match(body.baseUrl, /^http:\/\/managed\.localhost:/);

    const stopped = await hub.runtime.processes.stop("managed");
    assert.equal(stopped.status, "stopped");
  } finally {
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

test("can bind random test ports", async () => {
  assert.equal(await canBindPort(0), true);
});
