import type http from "node:http";

export function sendJson(response: http.ServerResponse, statusCode: number, body: unknown): void {
  const payload = `${JSON.stringify(body, null, 2)}\n`;
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload)
  });
  response.end(payload);
}

export function sendText(response: http.ServerResponse, statusCode: number, body: string): void {
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  response.end(body);
}

export function sendHtml(response: http.ServerResponse, statusCode: number, body: string): void {
  response.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  response.end(body);
}

export function notFound(response: http.ServerResponse): void {
  sendJson(response, 404, { error: "Not found" });
}
