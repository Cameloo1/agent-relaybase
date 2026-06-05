import type { AppComponentRole } from "../types.ts";
import type {
  ExistingManifestAnalysis,
  FileWritePlan,
  ManifestPatchPlan,
  OpenProjectResult,
  ProveHealthResult,
  RepairSetupResult,
  SetupPlanPreview
} from "../setupApiTypes.ts";
import type { Diagnostic, RelaybaseError } from "../apiTypes.ts";

export type AgentProvider = "openrouter";

export type AgentRunStatus = "queued" | "running" | "waiting_for_approval" | "completed" | "failed" | "cancelled";

export type AgentMessageRole = "user" | "assistant" | "system" | "tool" | "diagnostic";

export type AgentApprovalStatus = "pending" | "recovered_pending" | "approved" | "rejected" | "expired";

export type AgentToolRisk = "low" | "medium" | "high";

export interface AgentProviderConfig {
  provider: AgentProvider;
  modelSlug?: string;
  apiKeySource: {
    type: "environment";
    envVar: string;
    configured: boolean;
  };
  httpRefererEnvVar?: string;
  titleEnvVar?: string;
  remoteModelEnabled: boolean;
}

export interface AgentConfig {
  enabled: boolean;
  provider: AgentProviderConfig;
  toolAllowlist: string[];
  approvalPolicy: "always_for_mutations" | "read_only_only";
  setupFileWritePolicy: "approval_required";
  allowBrowserOpen: boolean;
  allowCopyRoute: boolean;
  budgets?: {
    dailyLimitUsd?: number;
    monthlyLimitUsd?: number;
    sessionLimitUsd?: number;
  };
  updatedAt: string;
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

export interface AgentDiagnostic {
  id: string;
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  checkedAt: string;
  userAction?: string;
  detail?: unknown;
}

export interface TuiAgentContext {
  selectedPaneId?: string;
  selectedAppId?: string;
  selectedGroupId?: string;
  selectedComponentRole?: AppComponentRole;
  currentRoute?: string;
  currentPage?: number;
  currentCwd?: string;
  daemonHasZeroApps: boolean;
  setupWizardState?: "inactive" | "no_apps" | "detecting" | "planning" | "previewing" | "applying" | "repairing";
  currentSetupPlanId?: string;
  diagnostics: Array<Diagnostic | AgentDiagnostic>;
  terminalCapabilities?: {
    clipboard: "available" | "unavailable" | "unknown";
    browserOpen: "available" | "unavailable" | "unknown";
    colorDepth?: "none" | "ansi" | "256" | "truecolor";
  };
}

export interface AgentSetupPlanReference {
  setupPlanId: string;
  cwd: string;
  label?: string;
  architecture?: string;
  risk?: AgentToolRisk;
}

export interface AgentSetupContext {
  cwd?: string;
  selectedPlan?: AgentSetupPlanReference;
  preview?: SetupPlanPreview;
  repair?: RepairSetupResult;
  existingManifest?: ExistingManifestAnalysis;
}

export interface AgentMessage {
  id: string;
  sessionId: string;
  role: AgentMessageRole;
  content: string;
  createdAt: string;
  runId?: string;
  context?: TuiAgentContext;
}

export type AgentThreadPrivacyMode = "standard" | "redacted_detail";

export type AgentThreadExportFormat = "json" | "markdown";

export interface AgentThreadPrivacy {
  mode: AgentThreadPrivacyMode;
  advancedRedactedDetailEnabled: boolean;
}

export interface AgentThreadSummary {
  generatedAt: string;
  messageCount: number;
  runCount: number;
  eventCount: number;
  pendingApprovalCount: number;
  recoveredApprovalCount: number;
  lastEventSequence?: number;
  lastUserMessage?: string;
  lastAssistantMessage?: string;
  lastDiagnosticCode?: string;
}

export interface AgentThreadContextPreview {
  sessionId: string;
  active: boolean;
  title?: string;
  summary: AgentThreadSummary;
  privacy: AgentThreadPrivacy;
  recentMessages: AgentMessage[];
  pendingApprovals: AgentApproval[];
  recallPolicy: {
    scope: "active_thread_only";
    includesRawSecrets: false;
    includesRawLogs: false;
    includesRawDiffs: false;
    extraModelCalls: false;
  };
}

export interface AgentThreadUpdateRequest {
  title?: string;
  context?: Partial<TuiAgentContext>;
  active?: boolean;
  privacy?: Partial<AgentThreadPrivacy>;
}

export interface AgentSession {
  id: string;
  title?: string;
  titleSource?: "auto" | "user" | "legacy";
  createdAt: string;
  updatedAt: string;
  lastActiveAt?: string;
  deletedAt?: string;
  deletedReason?: string;
  summary?: AgentThreadSummary;
  privacy?: AgentThreadPrivacy;
  recoveredApprovalCount?: number;
  context?: TuiAgentContext;
  setup?: AgentSetupContext;
  messages: AgentMessage[];
  runs: AgentRun[];
}

export interface AgentRun {
  id: string;
  sessionId: string;
  status: AgentRunStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  modelSlug?: string;
  provider: AgentProvider;
  diagnostic?: AgentDiagnostic;
  usage?: AgentUsage;
  events: AgentRunEvent[];
}

export type AgentRunEventType =
  | "run.started"
  | "model.request_started"
  | "model.delta"
  | "model.completed"
  | "answer"
  | "action_preview"
  | "approval_required"
  | "setup_plan_preview"
  | "file_write_preview"
  | "repair_choices"
  | "prove_result"
  | "action_result"
  | "clarification_needed"
  | "blocked"
  | "tool.call_requested"
  | "tool.approval_required"
  | "tool.approved"
  | "tool.rejected"
  | "tool.started"
  | "tool.completed"
  | "tool.failed"
  | "setup.plan_preview"
  | "setup.file_write_approval_required"
  | "setup.manifest_patch_approval_required"
  | "setup.repair_choices"
  | "setup.prove_result"
  | "tui.proposed_action"
  | "run.completed"
  | "run.failed"
  | "diagnostic";

export interface AgentRunEvent {
  id: string;
  sequence: number;
  sessionId: string;
  runId?: string;
  type: AgentRunEventType;
  at: string;
  data: unknown;
}

export interface AgentToolCall {
  id: string;
  runId: string;
  sessionId: string;
  name: string;
  arguments: Record<string, unknown>;
  risk: AgentToolRisk;
  approvalRequired: boolean;
  createdAt: string;
}

export interface AgentToolResult {
  id: string;
  toolCallId: string;
  status:
    | "succeeded"
    | "approval_required"
    | "clarification_needed"
    | "diagnostic"
    | "unavailable"
    | "failed"
    | "blocked";
  createdAt: string;
  output?: unknown;
  approval?: {
    required: boolean;
    action: string;
    risk: AgentToolRisk;
    expectedResult: string;
    arguments: unknown;
  };
  operationId?: string;
  exportId?: string;
  setupPlanId?: string;
  repairPlanId?: string;
  error?: RelaybaseError | AgentDiagnostic;
}

export interface AgentApprovalPreview {
  action: string;
  target?: string;
  currentStatus?: string;
  expectedResult: string;
  risk: AgentToolRisk;
  arguments: unknown;
  fileWrites?: unknown[];
  manifestFieldsChanged?: string[];
  envKeysChanged?: string[];
  runtimeId?: string;
  runtimeLabel?: string;
  runtimeConfidence?: string;
  selectedCommand?: {
    argv?: string[];
    preview?: string;
  };
  portStrategy?: string;
  portStrategyCandidates?: string[];
  setupQuestions?: string[];
  healthRoute?: string;
  mayIncludeSensitiveData: boolean;
  confirmationOptions: {
    approveEndpoint: string;
    rejectEndpoint: string;
    rejectOnEsc: boolean;
  };
}

export interface AgentFileWriteApproval {
  kind: "file_write";
  setupPlanId?: string;
  fileWritePlan: FileWritePlan;
  risk: AgentToolRisk;
}

export interface AgentManifestPatchApproval {
  kind: "manifest_patch";
  manifestPatchPlan: ManifestPatchPlan;
  risk: AgentToolRisk;
}

export interface AgentOpenRouteApproval {
  kind: "open_route";
  appId?: string;
  route: string;
  risk: AgentToolRisk;
}

export interface TuiProposedAction {
  kind: "focus_pane" | "pin_pane" | "unpin_pane" | "change_pane_color" | "show_route" | "copy_route" | "open_browser";
  target?: {
    paneId?: string;
    appId?: string;
    groupId?: string;
    componentRole?: AppComponentRole;
  };
  route?: string;
  color?: string;
  requiresApproval: boolean;
  unavailableReason?: string;
}

export interface TuiProposedActionEvent {
  action: TuiProposedAction;
  reason?: string;
}

export interface AgentApproval {
  id: string;
  sessionId: string;
  runId: string;
  toolCallId?: string;
  toolName?: string;
  status: AgentApprovalStatus;
  createdAt: string;
  resolvedAt?: string;
  action: string;
  target?: string;
  risk: AgentToolRisk;
  expectedResult: string;
  arguments: Record<string, unknown>;
  argumentsHash?: string;
  recoveryState?: "live" | "requires_reconfirm" | "raw_arguments_unavailable";
  rawArgumentsPersisted?: boolean;
  context?: TuiAgentContext;
  preview?: AgentApprovalPreview;
  fileWrite?: AgentFileWriteApproval;
  manifestPatch?: AgentManifestPatchApproval;
  openRoute?: AgentOpenRouteApproval;
  diagnostic?: AgentDiagnostic;
}

export interface AgentAuditEvent {
  id: string;
  at: string;
  sessionId?: string;
  runId?: string;
  type: string;
  provider?: AgentProvider;
  modelSlug?: string;
  data: unknown;
}

export interface AgentSessionExportResult {
  exportId: string;
  status: "succeeded";
  format: AgentThreadExportFormat;
  outputPath: string;
  sessionId: string;
  messageCount: number;
  auditEventCount: number;
  generatedAt: string;
  redactionReport: {
    totalReplacements: number;
    categories: Record<string, number>;
  };
}

export interface AgentConfigUpdate {
  enabled?: boolean;
  provider?: {
    modelSlug?: string;
    apiKeyEnvVar?: string;
    remoteModelEnabled?: boolean;
    httpRefererEnvVar?: string;
    titleEnvVar?: string;
  };
  toolAllowlist?: string[];
  approvalPolicy?: AgentConfig["approvalPolicy"];
  allowBrowserOpen?: boolean;
  allowCopyRoute?: boolean;
  budgets?: AgentConfig["budgets"];
}

export interface AgentMessageRequest {
  content: string;
  context?: Partial<TuiAgentContext>;
}

export interface AgentSessionCreateRequest {
  title?: string;
  context?: Partial<TuiAgentContext>;
}

export interface AgentSessionExportRequest {
  format?: AgentThreadExportFormat;
}

export interface AgentSetupEventPayloads {
  setupPlanPreview: SetupPlanPreview;
  fileWriteApproval: AgentFileWriteApproval;
  manifestPatchApproval: AgentManifestPatchApproval;
  repairChoices: RepairSetupResult;
  proveResult: ProveHealthResult;
  openResult: OpenProjectResult;
}
