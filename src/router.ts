import type { RequestLike, RouteResolution } from "./types.ts";
import { isValidAppId } from "./validation.ts";

export const HUB_PREFIX = "/__hub";
export const AGENT_APP_HEADER = "x-relaybase-app";
const HUB_RESERVED_PATHS = new Set(["/mcp", "/sse", "/.well-known/mcp.json"]);

export function resolveRoute(request: RequestLike): RouteResolution {
  const pathname = getPathname(request.url);
  if (pathname === HUB_PREFIX || pathname.startsWith(`${HUB_PREFIX}/`) || HUB_RESERVED_PATHS.has(pathname)) {
    return { kind: "hub" };
  }

  const headerApp = headerValue(request.headers[AGENT_APP_HEADER] ?? request.headers["x-relaybase-app"]);
  if (headerApp) {
    const appId = headerApp.trim().toLowerCase();
    if (!isValidAppId(appId)) {
      return { kind: "unknown", statusCode: 400, message: `Invalid app header: ${headerApp}` };
    }

    return { kind: "app", appId, source: "header" };
  }

  const host = headerValue(request.headers.host);
  if (host) {
    const appId = appIdFromHost(host);
    if (appId) {
      return { kind: "app", appId, source: "host" };
    }
  }

  return { kind: "unknown", statusCode: 404, message: "No Relaybase app route matched this request." };
}

export function appIdFromHost(hostHeader: string): string | undefined {
  const host = stripPort(hostHeader.trim().toLowerCase());
  if (!host.endsWith(".localhost")) {
    return undefined;
  }

  const appId = host.slice(0, -".localhost".length);
  return isValidAppId(appId) ? appId : undefined;
}

function getPathname(url: string | undefined): string {
  if (!url) {
    return "/";
  }

  try {
    return new URL(url, "http://localhost").pathname;
  } catch {
    return "/";
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

function stripPort(host: string): string {
  if (host.startsWith("[")) {
    return host;
  }

  const index = host.lastIndexOf(":");
  return index === -1 ? host : host.slice(0, index);
}
