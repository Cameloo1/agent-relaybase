import http from "node:http";
import https from "node:https";
import type { AppRecord } from "./types.ts";
import { isPortOpen } from "./ports.ts";

export async function checkAppHealth(app: AppRecord, port: number, host = "127.0.0.1", timeoutMs = 1000): Promise<boolean> {
  if (!app.healthUrl) {
    return isPortOpen(port, host, timeoutMs);
  }

  const url = app.healthUrl.startsWith("http://") || app.healthUrl.startsWith("https://")
    ? app.healthUrl
    : `http://${host}:${port}${app.healthUrl}`;

  return checkHttpHealth(url, timeoutMs);
}

export async function waitForHealthy(app: AppRecord, port: number, host: string, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await checkAppHealth(app, port, host, 750)) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  return false;
}

function checkHttpHealth(url: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const client = url.startsWith("https://") ? https : http;
    const request = client.request(url, { method: "GET", timeout: timeoutMs }, (response) => {
      response.resume();
      resolve(response.statusCode !== undefined && response.statusCode >= 200 && response.statusCode < 500);
    });

    request.once("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.once("error", () => resolve(false));
    request.end();
  });
}

