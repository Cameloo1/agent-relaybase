import http from "node:http";
import net from "node:net";
import type { AppRecord } from "./types.ts";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

export function proxyHttpRequest(options: {
  request: http.IncomingMessage;
  response: http.ServerResponse;
  app: AppRecord;
  targetHost: string;
  targetPort: number;
}): void {
  const { request, response, app, targetHost, targetPort } = options;
  const headers = filterHeaders(request.headers);
  headers["x-forwarded-host"] = request.headers.host ?? "";
  headers["x-forwarded-proto"] = "http";
  headers["x-relaybase-routed-app"] = app.id;

  const upstream = http.request({
    host: targetHost,
    port: targetPort,
    method: request.method,
    path: request.url,
    headers
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, filterHeaders(upstreamResponse.headers));
    upstreamResponse.pipe(response);
  });

  upstream.once("error", (error) => {
    if (!response.headersSent) {
      response.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    }

    response.end(JSON.stringify({
      error: "Relaybase proxy failed",
      app: app.id,
      detail: error.message
    }, null, 2));
  });

  request.pipe(upstream);
}

export function proxyUpgrade(options: {
  request: http.IncomingMessage;
  socket: net.Socket;
  head: Buffer;
  targetHost: string;
  targetPort: number;
}): void {
  const { request, socket, head, targetHost, targetPort } = options;
  const upstream = net.connect({ host: targetHost, port: targetPort });

  upstream.once("connect", () => {
    upstream.write(rebuildUpgradeRequest(request));
    if (head.length > 0) {
      upstream.write(head);
    }

    upstream.pipe(socket);
    socket.pipe(upstream);
  });

  upstream.once("error", (error) => {
    socket.write(`HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\n${error.message}`);
    socket.destroy();
  });
}

export function writeSocketHttpError(socket: net.Socket, statusCode: number, message: string): void {
  const status = statusCode === 404 ? "Not Found" : statusCode === 400 ? "Bad Request" : "Bad Gateway";
  socket.write(`HTTP/1.1 ${statusCode} ${status}\r\ncontent-type: text/plain; charset=utf-8\r\nconnection: close\r\n\r\n${message}`);
  socket.destroy();
}

function filterHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const filtered: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase()) && value !== undefined) {
      filtered[key] = value;
    }
  }

  return filtered;
}

function rebuildUpgradeRequest(request: http.IncomingMessage): string {
  const lines = [`${request.method ?? "GET"} ${request.url ?? "/"} HTTP/${request.httpVersion}`];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    lines.push(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`);
  }

  return `${lines.join("\r\n")}\r\n\r\n`;
}

