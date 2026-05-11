import path from "node:path";
import type {
  AppManifestInput,
  AppMcpConfig,
  AppProtocol,
  AppRecord,
  ChildMcpConfig,
  ChildMcpTransport,
  McpExposePolicy
} from "./types.ts";

const APP_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const VALID_PROTOCOLS = new Set<AppProtocol>(["http", "http+ws", "tcp"]);
const VALID_CHILD_MCP_TRANSPORTS = new Set<ChildMcpTransport>(["stdio", "streamable-http", "sse"]);

export function validateAppId(id: string): void {
  if (!APP_ID_PATTERN.test(id)) {
    throw new Error(
      "App id must be 1-63 chars of lowercase letters, numbers, or dashes, and cannot start or end with a dash."
    );
  }
}

export function isValidAppId(id: string): boolean {
  return APP_ID_PATTERN.test(id);
}

export function normalizeManifest(
  input: AppManifestInput,
  options: { manifestPath?: string; now?: Date } = {}
): AppRecord {
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
  const preStartCommand = normalizeLifecycleCommand(input.preStartCommand, "preStartCommand");
  const stopCommand = normalizeLifecycleCommand(input.stopCommand, "stopCommand");
  const verifyStoppedCommand = normalizeLifecycleCommand(input.verifyStoppedCommand, "verifyStoppedCommand");
  const preStartTimeoutMs = normalizeTimeout(input.preStartTimeoutMs, "preStartTimeoutMs");
  const startTimeoutMs = normalizeTimeout(input.startTimeoutMs, "startTimeoutMs");
  const stopTimeoutMs = normalizeTimeout(input.stopTimeoutMs, "stopTimeoutMs");
  const healthTimeoutMs = normalizeTimeout(input.healthTimeoutMs, "healthTimeoutMs");
  const hasLifecycleFields = [
    preStartCommand,
    stopCommand,
    verifyStoppedCommand,
    preStartTimeoutMs,
    startTimeoutMs,
    stopTimeoutMs,
    healthTimeoutMs
  ].some((value) => value !== undefined);
  const schemaVersion = normalizeSchemaVersion(input.schemaVersion, input.mcp !== undefined || hasLifecycleFields);
  const mcp = normalizeMcpConfig(input.mcp, cwd);

  return {
    ...(schemaVersion ? { schemaVersion } : {}),
    id,
    name,
    command,
    cwd,
    protocol: protocol as AppProtocol,
    ...(healthUrl ? { healthUrl } : {}),
    env,
    ...(upstreamPort ? { upstreamPort } : {}),
    ...(preStartCommand ? { preStartCommand } : {}),
    ...(stopCommand ? { stopCommand } : {}),
    ...(verifyStoppedCommand ? { verifyStoppedCommand } : {}),
    ...(preStartTimeoutMs !== undefined ? { preStartTimeoutMs } : {}),
    ...(startTimeoutMs !== undefined ? { startTimeoutMs } : {}),
    ...(stopTimeoutMs !== undefined ? { stopTimeoutMs } : {}),
    ...(healthTimeoutMs !== undefined ? { healthTimeoutMs } : {}),
    ...(mcp ? { mcp } : {}),
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

function normalizeLifecycleCommand(value: unknown, field: string): string | undefined {
  const command = optionalString(value, field)?.trim();
  if (command === "") {
    throw new Error(`Manifest field ${field} cannot be empty.`);
  }

  return command;
}

function normalizeTimeout(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < 100 || value > 3_600_000) {
    throw new Error(`Manifest field ${field} must be an integer between 100 and 3600000 milliseconds.`);
  }

  return value;
}

function normalizeSchemaVersion(value: unknown, hasMcpBlock: boolean): 1 | undefined {
  if (value === undefined || value === null) {
    return hasMcpBlock ? 1 : undefined;
  }

  if (value !== 1) {
    throw new Error("Manifest field schemaVersion must be 1 when provided.");
  }

  return 1;
}

function normalizeMcpConfig(value: unknown, appCwd: string): AppMcpConfig | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Manifest field mcp must be an object.");
  }

  const raw = value as Record<string, unknown>;
  if (typeof raw.enabled !== "boolean") {
    throw new Error("Manifest field mcp.enabled must be a boolean.");
  }

  const childrenValue = raw.children ?? [];
  if (!Array.isArray(childrenValue)) {
    throw new Error("Manifest field mcp.children must be an array.");
  }

  const children = childrenValue.map((child, index) => normalizeChildMcpConfig(child, appCwd, index));
  const ids = new Set<string>();
  for (const child of children) {
    if (ids.has(child.id)) {
      throw new Error(`Duplicate child MCP server id: ${child.id}`);
    }

    ids.add(child.id);
  }

  return {
    enabled: raw.enabled,
    children
  };
}

function normalizeChildMcpConfig(value: unknown, appCwd: string, index: number): ChildMcpConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Manifest field mcp.children[${index}] must be an object.`);
  }

  const raw = value as Record<string, unknown>;
  const id = requiredString(raw.id, `mcp.children[${index}].id`).trim();
  validateAppId(id);

  const transport = requiredString(raw.transport, `mcp.children[${index}].transport`) as ChildMcpTransport;
  if (!VALID_CHILD_MCP_TRANSPORTS.has(transport)) {
    throw new Error(`Manifest field mcp.children[${index}].transport must be one of: stdio, streamable-http, sse.`);
  }

  const expose = normalizeExposePolicy(raw.expose, index);
  const args = normalizeStringArray(raw.args, `mcp.children[${index}].args`);
  const env = normalizeEnv(raw.env);
  const cwdValue = optionalString(raw.cwd, `mcp.children[${index}].cwd`) ?? ".";
  const cwd = path.resolve(appCwd, cwdValue);
  const command = optionalString(raw.command, `mcp.children[${index}].command`)?.trim();
  const url = normalizeHttpUrl(raw.url, `mcp.children[${index}].url`);
  const legacySseUrl = normalizeHttpUrl(raw.legacySseUrl, `mcp.children[${index}].legacySseUrl`);

  if (transport === "stdio" && !command) {
    throw new Error(`Manifest field mcp.children[${index}].command is required for stdio child MCP servers.`);
  }

  if (transport === "streamable-http" && !url) {
    throw new Error(`Manifest field mcp.children[${index}].url is required for streamable-http child MCP servers.`);
  }

  if (transport === "sse" && !url && !legacySseUrl) {
    throw new Error(`Manifest field mcp.children[${index}].url or legacySseUrl is required for sse child MCP servers.`);
  }

  return {
    id,
    transport,
    ...(command ? { command } : {}),
    args,
    cwd,
    env,
    ...(url ? { url } : {}),
    ...(legacySseUrl ? { legacySseUrl } : {}),
    expose
  };
}

function normalizeExposePolicy(value: unknown, childIndex: number): McpExposePolicy {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Manifest field mcp.children[${childIndex}].expose must be an object with exact allowlists.`);
  }

  const raw = value as Record<string, unknown>;
  return {
    tools: normalizeExposeList(raw.tools, `mcp.children[${childIndex}].expose.tools`),
    resources: normalizeExposeList(raw.resources, `mcp.children[${childIndex}].expose.resources`),
    prompts: normalizeExposeList(raw.prompts, `mcp.children[${childIndex}].expose.prompts`)
  };
}

function normalizeExposeList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Manifest field ${field} must be an array.`);
  }

  const seen = new Set<string>();
  const entries: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`Manifest field ${field} entries must be non-empty strings.`);
    }

    const normalized = item.trim();
    if (normalized === "*") {
      throw new Error(`Manifest field ${field} does not support wildcard exposure.`);
    }

    if (!seen.has(normalized)) {
      seen.add(normalized);
      entries.push(normalized);
    }
  }

  return entries;
}

function normalizeStringArray(value: unknown, field: string): string[] {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error(`Manifest field ${field} must be an array.`);
  }

  return value.map((item, index) => {
    if (typeof item !== "string") {
      throw new Error(`Manifest field ${field}[${index}] must be a string.`);
    }

    return item;
  });
}

function normalizeHttpUrl(value: unknown, field: string): string | undefined {
  const url = optionalString(value, field);
  if (!url) {
    return undefined;
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error();
    }

    return parsed.toString();
  } catch {
    throw new Error(`Manifest field ${field} must be an absolute http(s) URL.`);
  }
}
