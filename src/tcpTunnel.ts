import net from "node:net";
import type { RelaybaseRuntime } from "./server.ts";

const MAX_HANDSHAKE_BYTES = 4096;

export async function maybeHandleTcpTunnel(
  runtime: RelaybaseRuntime,
  socket: net.Socket,
  firstChunk: Buffer
): Promise<boolean> {
  if (!firstChunk.toString("utf8", 0, Math.min(firstChunk.length, 32)).startsWith("RELAYBASE-TCP ")) {
    return false;
  }

  let buffer = firstChunk;
  while (!buffer.includes("\n\n") && !buffer.includes("\r\n\r\n")) {
    if (buffer.length > MAX_HANDSHAKE_BYTES) {
      socket.end("Relaybase TCP handshake too large.\n");
      return true;
    }

    const next = await readOnce(socket);
    if (!next) {
      socket.end("Relaybase TCP handshake ended early.\n");
      return true;
    }

    buffer = Buffer.concat([buffer, next]);
  }

  const marker = buffer.includes("\r\n\r\n") ? "\r\n\r\n" : "\n\n";
  const markerIndex = buffer.indexOf(marker);
  const preface = buffer.subarray(0, markerIndex).toString("utf8").trim();
  const remainder = buffer.subarray(markerIndex + Buffer.byteLength(marker));
  const [, appId] = preface.split(/\s+/, 2);

  if (!appId) {
    socket.end("Relaybase TCP handshake missing app id.\n");
    return true;
  }

  const app = await runtime.registry.get(appId);
  if (!app) {
    socket.end(`Unknown Relaybase app: ${appId}\n`);
    return true;
  }

  const target = await runtime.processes.getProxyTarget(app);
  if (!target) {
    socket.end(`Relaybase app is not reachable: ${appId}\n`);
    return true;
  }

  const upstream = net.connect({ host: runtime.host, port: target.port });
  upstream.once("connect", () => {
    if (remainder.length > 0) {
      upstream.write(remainder);
    }

    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.once("error", (error) => {
    socket.end(`Relaybase TCP proxy failed: ${error.message}\n`);
  });

  return true;
}

function readOnce(socket: net.Socket): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const onData = (chunk: Buffer) => {
      cleanup();
      resolve(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(undefined);
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onEnd);
    };

    socket.once("data", onData);
    socket.once("end", onEnd);
    socket.once("error", onEnd);
  });
}
