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

export type AgentModelSourceKind =
  | "shell_environment"
  | "explicit_env_file"
  | "cwd_env_file"
  | "persisted_config"
  | "managed_config"
  | "unconfigured";

export interface AgentModelSource {
  kind: AgentModelSourceKind;
  label: string;
}

export type AgentConfigSourceMode = "managed" | "external_file" | "shell_environment" | "legacy_mixed";
export type AgentConfigSourceHealth = "healthy" | "changed" | "reloading" | "invalid" | "unavailable" | "legacy_mixed";
export type AgentReadiness = "disabled" | "needs_configuration" | "ready";
export type AgentCredentialConnectionState =
  | "disconnected"
  | "connecting"
  | "connected_unverified"
  | "connected"
  | "verification_required"
  | "verification_unavailable"
  | "replace_pending"
  | "revocation_pending"
  | "revocation_unconfirmed"
  | "invalid"
  | "expired";

export interface AgentConfigRevision {
  id: string;
  generation: number;
  loadedAt: string;
}

export interface AgentConfigSourceState {
  mode: AgentConfigSourceMode;
  health: AgentConfigSourceHealth;
  label: string;
  lastCheckedAt?: string;
  lastAppliedAt?: string;
  lastError?: AgentDiagnostic;
}

export interface AgentCredentialState {
  provider: AgentProvider;
  connection: AgentCredentialConnectionState;
  source: "environment" | "external_file" | "windows_dpapi";
  protection: "none" | "windows-dpapi-current-user";
  credentialId?: string;
  lastValidatedAt?: string;
  keyLabel?: string;
  limitUsd?: number;
  limitRemainingUsd?: number;
  limitReset?: "daily" | "weekly" | "monthly" | null;
  expiresAt?: string | null;
  highSecurityMode: "off" | "required" | "unavailable";
}

export type AgentRunStatus = "queued" | "running" | "waiting_for_approval" | "completed" | "failed" | "cancelled";

export type AgentMessageRole = "user" | "assistant" | "system" | "tool" | "diagnostic";

export type AgentApprovalStatus = "pending" | "recovered_pending" | "approved" | "rejected" | "expired";

export type AgentToolRisk = "low" | "medium" | "high";

export interface AgentProviderConfig {
  provider: AgentProvider;
  modelSlug?: string;
  modelSource: AgentModelSource;
  restartRequired?: boolean;
  apiKeySource: {
    type: "environment" | "managed_windows_dpapi";
    envVar?: string;
    credentialId?: string;
    configured: boolean;
  };
  httpRefererEnvVar?: string;
  titleEnvVar?: string;
  remoteModelEnabled: boolean;
}

export type AgentReasoningEffort = "low" | "medium" | "high";

export interface AgentExecutionPolicy {
  segmentMaxTurns: number;
  totalMaxTurns: number;
  inactivityTimeoutMs: number;
  hardRunTimeoutMs: number;
  maxOutputTokens: number;
  reasoningEffort: AgentReasoningEffort;
  noProgressRepeatLimit: number;
}

export interface AgentConfig {
  enabled: boolean;
  provider: AgentProviderConfig;
  execution: AgentExecutionPolicy;
  toolAllowlist: string[];
  toolAllowlistMode: "all_registered" | "explicit_allowlist";
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
  revision?: AgentConfigRevision;
  source?: AgentConfigSourceState;
  readiness?: AgentReadiness;
  credential?: AgentCredentialState;
  activeRunUsesOlderRevision?: boolean;
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  costUsd?: string;
  costSource?: "provider_reported" | "estimated" | "unavailable";
}

export interface AgentUsageSnapshot {
  scope: "active-thread";
  sessionId: string | null;
  lastRequest: {
    runId: string;
    modelSlug: string;
    provider: AgentProvider;
    completedAt: string;
    tokens: {
      input: number;
      output: number;
      total: number;
      totalSource: "provider_reported" | "derived";
    };
    cost: { usd: string | null; source: "provider_reported" | "estimated" | "unavailable" };
  } | null;
  threadTotals: {
    requestCount: number;
    tokens: { input: number; output: number; total: number };
    cost: {
      knownUsd: string;
      knownRequestCount: number;
      unavailableRequestCount: number;
      sources: Array<"provider_reported" | "estimated">;
    };
  };
  updatedAt: string | null;
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

export type AgentSecurityFindingState = "healthy" | "attention" | "blocked";
export type AgentSecurityRepairability = "none" | "automatic" | "confirmation" | "external" | "manual";
export type AgentSecurityRepairRisk =
  | "read_only"
  | "safe_local"
  | "guarded_local"
  | "destructive_local"
  | "external"
  | "manual";
export type AgentSecurityRepairOutcome = "verified" | "partial" | "blocked" | "failed" | "interrupted";
export type AgentSecurityRepairActionId =
  | "refresh_managed_credential_state"
  | "clear_stale_provider_connection"
  | "repair_credential_acl"
  | "validate_managed_credential"
  | "migrate_legacy_credential"
  | "remove_legacy_external_assignment"
  | "disconnect_local_credential"
  | "open_provider_key_management"
  | "reload_selected_agent_config"
  | "route_to_provider_connect"
  | "route_to_provider_replace"
  | "route_to_configuration"
  | "route_to_daemon_restart";

export interface AgentSecurityFinding {
  id: string;
  code: string;
  severity: AgentDiagnostic["severity"];
  state: AgentSecurityFindingState;
  title: string;
  message: string;
  checkedAt: string;
  evidence: Record<string, boolean | number | string | null>;
  repairability: AgentSecurityRepairability;
  recommendedActionId?: AgentSecurityRepairActionId;
  alternateActionIds?: AgentSecurityRepairActionId[];
  requiresNetwork: boolean;
  requiresRestart: boolean;
  reversible: boolean;
  userAction?: string;
}

export interface AgentSecurityStatus {
  scope: "agent-security";
  state: AgentSecurityFindingState;
  healthy: boolean;
  checkedAt: string;
  online: boolean;
  configRevisionId: string;
  findings: AgentSecurityFinding[];
  lastSecurityEvent?: {
    at: string;
    type: string;
  };
}

export interface AgentSecurityRepairActionPreview {
  id: AgentSecurityRepairActionId;
  title: string;
  riskClass: AgentSecurityRepairRisk;
  changes: string[];
  preserves: string[];
  requiresNetwork: boolean;
  requiresRestart: boolean;
  reversible: boolean;
}

export interface AgentSecurityRepairPreview {
  previewId: string;
  scope: "agent-security";
  createdAt: string;
  expiresAt: string;
  findings: AgentSecurityFinding[];
  actions: AgentSecurityRepairActionPreview[];
  confirmation: {
    required: boolean;
    value: string;
    phrase?: string;
    warning?: string;
  };
  expectedConfigRevision: string;
}

export interface AgentSecurityRepairOperation {
  operationId: string;
  previewId: string;
  state: "running" | "completed";
  outcome: AgentSecurityRepairOutcome;
  startedAt: string;
  completedAt?: string;
  appliedActionIds: AgentSecurityRepairActionId[];
  remainingIssueCodes: string[];
  requiresRestart: boolean;
  requiresExternalAction: boolean;
  errorCode?: string;
}

export interface TuiAgentContext {
  capturedAt?: string;
  selectedPaneId?: string;
  selectedAppId?: string;
  selectedGroupId?: string;
  selectedComponentRole?: AppComponentRole;
  currentRoute?: string;
  currentPage?: number;
  currentCwd?: string;
  authorizedProjectRoots?: string[];
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

export type AgentProjectRootGrantSource = "tui_current_cwd" | "user_selected_folder" | "approved_setup";

export interface AgentProjectRootGrant {
  grantId: string;
  canonicalRoot: string;
  source: AgentProjectRootGrantSource;
}

export interface AgentSetupPreviewBinding {
  schemaVersion: 1;
  algorithm: "sha256";
  digest: string;
  revision: string;
  setupPlanId: string;
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
  configRevisionId?: string;
  configGeneration?: number;
  diagnostic?: AgentDiagnostic;
  usage?: AgentUsage;
  events: AgentRunEvent[];
}

export type AgentRunEventType =
  | "message.user"
  | "run.started"
  | "run.continuing"
  | "model.request_started"
  | "model.processing_started"
  | "model.processing_completed"
  | "model.processing_failed"
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
  | "tool.search_started"
  | "tool.search_completed"
  | "agent.handoff_started"
  | "agent.handoff_completed"
  | "setup.plan_preview"
  | "setup.file_write_approval_required"
  | "setup.manifest_patch_approval_required"
  | "setup.repair_choices"
  | "setup.prove_result"
  | "tui.proposed_action"
  | "run.completed"
  | "run.failed"
  | "run.finalized"
  | "diagnostic";

export interface AgentBlockedCandidate {
  disposition: "retained_redacted" | "discarded_security";
  inspectable: boolean;
  sha256: string;
  byteCount: number;
  diagnosticCode: string;
  content?: string;
}

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
  phase: "approval";
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
  whyApproval: string;
  willChange: string[];
  willPreserve: string[];
  willRun: string[];
  proof: string[];
  revision?: string;
  expiresAt?: string;
  blockedReasons?: string[];
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
  execution?: Partial<AgentExecutionPolicy>;
  toolAllowlist?: string[];
  toolAllowlistMode?: AgentConfig["toolAllowlistMode"];
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
