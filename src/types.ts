export type AppProtocol = "http" | "http+ws" | "tcp";

export type RuntimeStatus = "stopped" | "starting" | "running" | "errored" | "conflict";

export type HealthStatus = "unknown" | "healthy" | "unhealthy";

export type RouteSource = "header" | "host";

export interface AppManifestInput {
  id?: unknown;
  name?: unknown;
  command?: unknown;
  cwd?: unknown;
  protocol?: unknown;
  healthUrl?: unknown;
  env?: unknown;
  upstreamPort?: unknown;
}

export interface AppRecord {
  id: string;
  name: string;
  command: string;
  cwd: string;
  protocol: AppProtocol;
  healthUrl?: string;
  env: Record<string, string>;
  upstreamPort?: number;
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

