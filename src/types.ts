export type AppProtocol = "http" | "http+ws" | "tcp";

export type RuntimeStatus = "stopped" | "starting" | "running" | "errored" | "conflict";

export type HealthStatus = "unknown" | "healthy" | "unhealthy";

export type RouteSource = "header" | "host";

export type ChildMcpTransport = "stdio" | "streamable-http" | "sse";

export interface McpExposePolicy {
  tools: string[];
  resources: string[];
  prompts: string[];
}

export interface ChildMcpConfig {
  id: string;
  transport: ChildMcpTransport;
  command?: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  url?: string;
  legacySseUrl?: string;
  expose: McpExposePolicy;
}

export interface AppMcpConfig {
  enabled: boolean;
  children: ChildMcpConfig[];
}

export interface AppManifestInput {
  schemaVersion?: unknown;
  id?: unknown;
  name?: unknown;
  command?: unknown;
  cwd?: unknown;
  protocol?: unknown;
  healthUrl?: unknown;
  env?: unknown;
  upstreamPort?: unknown;
  mcp?: unknown;
}

export interface AppRecord {
  schemaVersion?: 1;
  id: string;
  name: string;
  command: string;
  cwd: string;
  protocol: AppProtocol;
  healthUrl?: string;
  env: Record<string, string>;
  upstreamPort?: number;
  mcp?: AppMcpConfig;
  manifestPath?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RegistryFile {
  version: 1;
  apps: AppRecord[];
}

export interface RuntimeView {
  status: RuntimeStatus;
  health: HealthStatus;
  pid?: number;
  assignedPort?: number;
  startedAt?: string;
  stoppedAt?: string;
  lastError?: string;
  logLines: number;
  externalPortOpen?: boolean;
  mcpChildren?: ChildMcpRuntimeView[];
  mcpDrain?: ChildMcpDrainResult[];
}

export interface AppStatusView extends AppRecord {
  runtime: RuntimeView;
}

export type RouteResolution =
  | { kind: "hub" }
  | { kind: "app"; appId: string; source: RouteSource }
  | { kind: "unknown"; statusCode: number; message: string };

export interface RequestLike {
  url?: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface ServerOptions {
  host?: string;
  port?: number;
  stateDir?: string;
  portRangeStart?: number;
  portRangeEnd?: number;
}

export type ChildMcpRuntimeStatus = "stopped" | "starting" | "connected" | "draining" | "errored" | "restarting";

export interface ChildMcpRuntimeView {
  id: string;
  transport: ChildMcpTransport;
  status: ChildMcpRuntimeStatus;
  exposedTools: string[];
  exposedResources: string[];
  exposedPrompts: string[];
  inFlight: number;
  restartAttempts: number;
  lastStartedAt?: string;
  lastStoppedAt?: string;
  lastError?: string;
  nextRestartAt?: string;
}

export interface ChildMcpDrainResult {
  id: string;
  inFlightAtDrainStart: number;
  pendingAfterTimeout: number;
  timedOut: boolean;
  stopped: boolean;
}

