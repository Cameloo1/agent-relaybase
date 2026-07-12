import type { DurableLogEvent } from "./logStore.ts";
import type {
  AppComponentRole,
  AppComponent as CurrentAppComponent,
  AppGroup as CurrentAppGroup,
  AppState as CurrentAppState,
  AppStatusView
} from "./types.ts";

export type AppState = CurrentAppState;

export type AppStatus = AppStatusView;

export type AppGroup = CurrentAppGroup;

export type AppComponent = CurrentAppComponent;

export type OperationStatus =
  | "queued"
  | "running"
  | "waiting_for_approval"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "aborted"
  | "skipped"
  | "timed_out";

export type LifecycleOperationType = "start" | "stop" | "restart";
export type RecordedOperationType =
  | LifecycleOperationType
  | "register"
  | "registration_verification"
  | "log-export"
  | "diagnostics"
  | "preferences";

export interface OperationTarget {
  type: "app" | "component";
  id: string;
}

export interface OperationProgressEvent {
  at: string;
  message: string;
  phase?: string;
  progress?: number;
}

export interface RelaybaseState {
  apps: AppState[];
  groups: AppGroup[];
  components: AppComponent[];
  diagnostics?: Diagnostic[];
  operations?: LifecycleOperation[];
  generatedAt?: string;
}

export interface LifecycleOperation {
  id: string;
  operationId: string;
  kind: RecordedOperationType;
  operationType: RecordedOperationType;
  target: OperationTarget;
  status: OperationStatus;
  appId?: string;
  componentId?: string;
  owner?: "daemon" | "cli" | "tui" | "mcp" | "api";
  createdAt: string;
  startedAt?: string;
  updatedAt?: string;
  finishedAt?: string;
  endedAt?: string;
  progress?: number;
  message?: string;
  messages?: string[];
  events?: OperationProgressEvent[];
  retryable?: boolean;
  canRetry?: boolean;
  canAbort?: boolean;
  result?: unknown;
  error?: RelaybaseError;
  evidence?: string[];
}

export type LogEvent = DurableLogEvent;

export interface LogQuery {
  appId?: string;
  groupId?: string;
  componentRole?: "frontend" | "backend" | "worker" | "database" | "service" | "other";
  limit?: number;
  before?: number;
  after?: number;
  stream?: "stdout" | "stderr" | "system";
}

export type LogExportScope = "pane" | "app" | "group" | "page" | "all";

export type LogExportFormat = "log" | "jsonl" | "zip";

export type LogExportStatus = "queued" | "running" | "succeeded" | "failed";

export interface RedactionReport {
  replacements: number;
  categories: Record<string, number>;
}

export interface LogExportRequest {
  scope: LogExportScope;
  appId?: string;
  groupId?: string;
  componentRole?: AppComponentRole;
  paneIds?: string[];
  format: LogExportFormat;
  startTime?: string;
  endTime?: string;
  limit?: number;
  destination?: string;
  redact?: boolean;
}

export interface LogExportResult {
  exportId: string;
  status: LogExportStatus;
  format: LogExportFormat;
  outputPath?: string;
  includedApps: string[];
  includedGroups: string[];
  includedComponents: string[];
  startedAt: string;
  completedAt?: string;
  sizeBytes?: number;
  redactionReport: RedactionReport;
  error?: RelaybaseError;
}

export interface PreferenceState {
  theme?: "system" | "light" | "dark";
  defaultPane?: string;
  logFollow?: boolean;
  logPageSize?: number;
  confirmQuit?: boolean;
  confirmLifecycleMutations?: boolean;
  redactionMode?: "default" | "strict";
}

export interface Diagnostic {
  id: string;
  severity: "info" | "warning" | "error";
  message: string;
  checkedAt: string;
  detail?: unknown;
  userAction?: string;
}

export type DaemonEventType =
  | "daemon.ready"
  | "daemon.health_changed"
  | "app.registered"
  | "app.state_changed"
  | "app.lifecycle_operation_started"
  | "app.lifecycle_operation_progress"
  | "app.lifecycle_operation_completed"
  | "app.lifecycle_operation_failed"
  | "route.health_changed"
  | "log.line_available"
  | "log.stream_rotated"
  | "preference.changed"
  | "export.started"
  | "export.progress"
  | "export.completed"
  | "export.failed"
  | "setup.detected"
  | "setup.plan_created"
  | "setup.preview_created"
  | "setup.apply_started"
  | "setup.apply_completed"
  | "setup.apply_failed"
  | "setup.registered"
  | "setup.prove_started"
  | "setup.prove_completed"
  | "setup.repair_plan_created"
  | "setup.repair_applied";

export interface DaemonEvent {
  id: string;
  sequence: number;
  type: DaemonEventType;
  at: string;
  appId?: string;
  operationId?: string;
  correlationId?: string;
  data?: unknown;
}

export interface RelaybaseError {
  code: string;
  message: string;
  detail?: unknown;
  retryable: boolean;
  userAction?: string;
  correlationId: string;
}

export interface RelaybaseErrorResponse {
  error: string;
  code: string;
  recoverable: boolean;
  details?: unknown;
  correlationId: string;
  relaybaseError: RelaybaseError;
}

export type {
  AgentApproval,
  AgentAuditEvent,
  AgentConfig,
  AgentConfigUpdate,
  AgentDiagnostic,
  AgentFileWriteApproval,
  AgentManifestPatchApproval,
  AgentMessage,
  AgentMessageRequest,
  AgentOpenRouteApproval,
  AgentProviderConfig,
  AgentRun,
  AgentRunEvent,
  AgentRunEventType,
  AgentSession,
  AgentSessionCreateRequest,
  AgentSetupContext,
  AgentSetupPlanReference,
  AgentToolCall,
  AgentToolResult,
  TuiAgentContext,
  TuiProposedAction
} from "./agent/types.ts";

export type {
  ComponentSetupMetadata,
  ExistingManifestAnalysis,
  ExistingSetupArtifactAnalysis,
  FileDiff,
  FileWritePlan,
  FileWritePreview,
  FrameworkKind,
  ManifestPatchPlan,
  ManifestPatchRequest,
  ManifestPatchResult,
  OpenProjectPlan,
  OpenProjectRequest,
  OpenProjectResult,
  PackageManagerKind,
  PortStrategy,
  ProveHealthRequest,
  ProveHealthResult,
  RegisterManifestRequest,
  RegisterManifestResult,
  RepairSetupPlan,
  RepairSetupRequest,
  RepairSetupResult,
  SetupApplyRequest,
  SetupApplyResult,
  SetupApprovalRisk,
  SetupDetectRequest,
  SetupDetectResult,
  SetupDiagnostic,
  SetupPlan,
  SetupPlanChoice,
  SetupPlanPreview,
  SetupPlanRequest
} from "./setupApiTypes.ts";
