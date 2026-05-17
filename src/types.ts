export type AppProtocol = "http" | "http+ws" | "tcp";

export type RuntimeStatus = "stopped" | "starting" | "running" | "stopping" | "errored" | "conflict";

export type HealthStatus = "unknown" | "healthy" | "unhealthy";

export type RouteSource = "header" | "host";

export type LifecyclePhase =
  | "stopped"
  | "prestarting"
  | "building"
  | "launching"
  | "waiting_for_health"
  | "running"
  | "stopping"
  | "cleanup_failed"
  | "stop_verification_failed"
  | "errored"
  | "conflict";

export type LifecycleAttemptKind = "start" | "stop";

export type LifecycleAttemptStatus = "running" | "succeeded" | "failed" | "skipped";

export type LifecycleHookName = "preStart" | "start" | "stop" | "verifyStopped";

export interface LifecycleHookAttempt {
  name: LifecycleHookName;
  command: string;
  status: LifecycleAttemptStatus;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  stdout?: string[];
  stderr?: string[];
  error?: string;
}

export interface LifecycleAttempt {
  id: string;
  kind: LifecycleAttemptKind;
  status: LifecycleAttemptStatus;
  phase: LifecyclePhase;
  startedAt: string;
  endedAt?: string;
  assignedPort?: number;
  command?: string;
  hooks: LifecycleHookAttempt[];
  error?: string;
}

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
  preStartCommand?: unknown;
  stopCommand?: unknown;
  verifyStoppedCommand?: unknown;
  preStartTimeoutMs?: unknown;
  startTimeoutMs?: unknown;
  stopTimeoutMs?: unknown;
  healthTimeoutMs?: unknown;
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
  preStartCommand?: string;
  stopCommand?: string;
  verifyStoppedCommand?: string;
  preStartTimeoutMs?: number;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  healthTimeoutMs?: number;
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
  phase?: LifecyclePhase;
  pid?: number;
  assignedPort?: number;
  startedAt?: string;
  stoppedAt?: string;
  lastError?: string;
  logLines: number;
  canStart?: boolean;
  canStop?: boolean;
  canOpen?: boolean;
  primaryAction?: "start" | "stop" | "open" | "repair" | "wait";
  blockingReason?: string;
  cleanupStatus?: "not_needed" | "pending" | "succeeded" | "failed" | "timeout" | "verification_failed";
  lastStartAttempt?: LifecycleAttempt;
  lastStopAttempt?: LifecycleAttempt;
  attemptHistory?: LifecycleAttempt[];
  externalPortOpen?: boolean;
  mcpChildren?: ChildMcpRuntimeView[];
  mcpDrain?: ChildMcpDrainResult[];
  stopVerification?: StopVerification;
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
  stopPortOpenProbe?: (port: number, host: string) => Promise<boolean>;
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

export interface StopVerification {
  attempted: boolean;
  checkedAt: string;
  backendPort?: number;
  backendPortOpen: boolean | null;
  portClosureVerified: boolean;
  ok: boolean;
  failureReason?: string;
  cleanupStatus?: RuntimeView["cleanupStatus"];
  stopCommand?: LifecycleHookAttempt;
  verifyStoppedCommand?: LifecycleHookAttempt;
  mcpDrain?: ChildMcpDrainResult[];
}

export type ReadinessState = "unregistered" | "stopped" | "starting" | "ready" | "unhealthy" | "failed";

export interface ReadinessCheck {
  name: string;
  ok: boolean;
  checkedAt: string;
  detail?: string;
  value?: unknown;
}

export interface AppReadiness {
  state: ReadinessState;
  checkedAt: string;
  checks: ReadinessCheck[];
  timeoutMs: number;
  failureReason?: string;
}

export type RouteHealthStatus = "full" | "degraded" | "failed" | "unknown";

export interface RouteProbe {
  ok: boolean;
  url: string;
  statusCode?: number;
  error?: string;
}

export interface RouteHealth {
  status: RouteHealthStatus;
  ok: boolean;
  policy: "human-or-agent";
  humanRoute: RouteProbe;
  agentRoute: RouteProbe;
}

export interface AppState {
  id: string;
  name: string;
  registered: boolean;
  runtime: RuntimeView;
  backendPort?: number;
  backendPortOpen: boolean;
  routeReachable: boolean;
  routeHealth?: RouteHealth;
  humanUrl: string;
  agentUrl: string;
  agentHeaders: Record<string, string>;
  logSnapshotUrl: string;
  logStreamUrl: string;
  recentLogs: string[];
  lastError: string | null;
  readiness: AppReadiness;
  canStart: boolean;
  canStop: boolean;
  canOpen: boolean;
  primaryAction: "start" | "stop" | "open" | "repair" | "wait";
  blockingReason?: string;
  stopVerification?: StopVerification;
  mcpChildren?: ChildMcpRuntimeView[];
}
