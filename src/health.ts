import http from "node:http";
import https from "node:https";
import type { AppRecord } from "./types.ts";
import { isPortOpen } from "./ports.ts";

export async function checkAppHealth(
  app: AppRecord,
  port: number,
  host = "127.0.0.1",
  timeoutMs = 1000,
  signal?: AbortSignal
): Promise<boolean> {
  if (signal?.aborted) {
    return false;
  }
  if (!app.healthUrl) {
    return isPortOpen(port, host, timeoutMs);
  }

  const url =
    app.healthUrl.startsWith("http://") || app.healthUrl.startsWith("https://")
      ? app.healthUrl
      : `http://${host}:${port}${app.healthUrl}`;

  return checkHttpHealth(url, timeoutMs, signal);
}

export async function waitForHealthy(
  app: AppRecord,
  port: number,
  host: string,
  timeoutMs = 8000,
  signal?: AbortSignal
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !signal?.aborted) {
    const remainingMs = Math.max(1, deadline - Date.now());
    const probeTimeoutMs = Math.min(remainingMs, healthProbeTimeoutMs(timeoutMs));
    if (await checkAppHealth(app, port, host, probeTimeoutMs, signal)) {
      return true;
    }

    if (!(await abortableDelay(150, signal))) {
      return false;
    }
  }

  return false;
}

function healthProbeTimeoutMs(timeoutMs: number): number {
  return Math.min(Math.max(750, Math.min(timeoutMs, 10_000)), timeoutMs);
}

function checkHttpHealth(url: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (healthy: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener("abort", abort);
      resolve(healthy);
    };
    const client = url.startsWith("https://") ? https : http;
    const request = client.request(url, { method: "GET", timeout: timeoutMs }, (response) => {
      response.resume();
      finish(isHealthyHttpStatus(response.statusCode));
    });
    const abort = () => {
      request.destroy();
      finish(false);
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }

    request.once("timeout", () => {
      request.destroy();
      finish(false);
    });
    request.once("error", () => finish(false));
    request.end();
  });
}

function abortableDelay(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  if (!signal) {
    return new Promise((resolve) => setTimeout(() => resolve(true), timeoutMs));
  }
  if (signal.aborted) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(true), timeoutMs);
    const abort = () => finish(false);
    const finish = (completed: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve(completed);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function isHealthyHttpStatus(statusCode: number | undefined): boolean {
  return statusCode !== undefined && statusCode >= 200 && statusCode < 300;
}
