import path from "node:path";
import type { AppManifestInput, AppProtocol, AppRecord } from "./types.ts";

const APP_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const VALID_PROTOCOLS = new Set<AppProtocol>(["http", "http+ws", "tcp"]);

export function validateAppId(id: string): void {
  if (!APP_ID_PATTERN.test(id)) {
    throw new Error("App id must be 1-63 chars of lowercase letters, numbers, or dashes, and cannot start or end with a dash.");
  }
}

export function isValidAppId(id: string): boolean {
  return APP_ID_PATTERN.test(id);
}

export function normalizeManifest(input: AppManifestInput, options: { manifestPath?: string; now?: Date } = {}): AppRecord {
  const now = (options.now ?? new Date()).toISOString();
  const manifestDir = options.manifestPath ? path.dirname(path.resolve(options.manifestPath)) : process.cwd();
  const id = requiredString(input.id, "id").trim();
  const name = requiredString(input.name, "name").trim();
  const command = requiredString(input.command, "command").trim();
  const protocol = optionalString(input.protocol, "protocol") ?? "http";

  validateAppId(id);

  if (!name) {
    throw new Error("Manifest field name cannot be empty.");
  }

  if (!command) {
    throw new Error("Manifest field command cannot be empty.");
  }

  if (!VALID_PROTOCOLS.has(protocol as AppProtocol)) {
    throw new Error("Manifest field protocol must be one of: http, http+ws, tcp.");
  }

  const cwdRaw = optionalString(input.cwd, "cwd") ?? ".";
  const cwd = path.resolve(manifestDir, cwdRaw);
  const env = normalizeEnv(input.env);
  const upstreamPort = normalizePort(input.upstreamPort);
  const healthUrl = normalizeHealthUrl(input.healthUrl);

  return {
    id,
    name,
    command,
    cwd,
    protocol: protocol as AppProtocol,
    ...(healthUrl ? { healthUrl } : {}),
    env,
    ...(upstreamPort ? { upstreamPort } : {}),
    ...(options.manifestPath ? { manifestPath: path.resolve(options.manifestPath) } : {}),
    createdAt: now,
    updatedAt: now
  };
}

export function mergeAppRecord(existing: AppRecord | undefined, incoming: AppRecord, now = new Date()): AppRecord {
  return {
    ...incoming,
    createdAt: existing?.createdAt ?? incoming.createdAt,
    updatedAt: now.toISOString()
  };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Manifest field ${field} is required and must be a string.`);
  }

  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`Manifest field ${field} must be a string.`);
  }

  return value;
}

function normalizeEnv(value: unknown): Record<string, string> {
  if (value === undefined || value === null) {
    return {};
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Manifest field env must be an object.");
  }

  const env: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid env key: ${key}`);
    }

    if (typeof raw !== "string") {
      throw new Error(`Env value for ${key} must be a string.`);
    }

    env[key] = raw;
  }

  return env;
}

function normalizePort(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error("Manifest field upstreamPort must be an integer between 1 and 65535.");
  }

  return value;
}

function normalizeHealthUrl(value: unknown): string | undefined {
  const healthUrl = optionalString(value, "healthUrl");
  if (!healthUrl) {
    return undefined;
  }

  if (healthUrl.startsWith("/") || healthUrl.startsWith("http://") || healthUrl.startsWith("https://")) {
    return healthUrl;
  }

  throw new Error("Manifest field healthUrl must be an absolute http(s) URL or a path starting with '/'.");
}

