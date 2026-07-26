import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { RelaybaseRuntime } from "../server.ts";
import type { Diagnostic } from "../apiTypes.ts";
import { buildApprovalPreview } from "./approvalPresenter.ts";
import { ApprovalStore } from "./approvalStore.ts";
import { AgentAuditStore } from "./auditStore.ts";
import { previewSetup } from "../setupApi.ts";
import {
  AgentRuntimeError,
  diagnosticFromRuntimeError,
  diagnosticsForAgentConfig,
  mergeRedactionReport,
  redactAgentText,
  sanitizeAgentPayload,
  sanitizeAgentPayloadWithReport
} from "./errors.ts";
import {
  DEFAULT_AGENT_EXECUTION_POLICY,
  invalidAgentExecutionPolicy,
  normalizeAgentExecutionPolicy
} from "./executionPolicy.ts";
import type { AgentRuntimeEvent } from "./events.ts";
import { evaluateToolPolicy, stableArgumentsHash, userMessageGuardrail } from "./policy.ts";
import { OperatorAgentRuntime } from "./runtime.ts";
import {
  activeRunForSession,
  idempotentMessageId,
  originalUserMessage,
  retryableRun,
  workflowContinuationForApprovedTool
} from "./runCoordinator.ts";
import { AgentSessionStore } from "./sessionStore.ts";
import { executeRelaybaseAgentTool, relaybaseAgentToolNames } from "./tools/index.ts";
import { authorizeAgentToolProjectScope, createCanonicalProjectRootGrant } from "./tools/projectSafety.ts";
import { createSetupPreviewBinding } from "./tools/setupPreviewBinding.ts";
import { bindAgentToolApprovalState } from "./tools/approvalStateBinding.ts";
import type {
  AgentApproval,
  AgentBlockedCandidate,
  AgentAuditEvent,
  AgentConfig,
  AgentConfigUpdate,
  AgentDiagnostic,
  AgentMessage,
  AgentMessageRequest,
  AgentModelSource,
  AgentProviderConfig,
  AgentProjectRootGrant,
  AgentRun,
  AgentRunEvent,
  AgentRunEventType,
  AgentSecurityRepairActionId,
  AgentSecurityRepairOperation,
  AgentSecurityRepairPreview,
  AgentSecurityStatus,
  AgentSession,
  AgentSessionCreateRequest,
  AgentSessionExportRequest,
  AgentSessionExportResult,
  AgentThreadContextPreview,
  AgentThreadUpdateRequest,
  AgentUsage,
  AgentUsageSnapshot,
  TuiAgentContext
} from "./types.ts";
import { activeThreadUsageSnapshot } from "./usageSummary.ts";
import { AgentActivityProjector } from "./activity.ts";
import {
  AgentConfigManager,
  AgentConfigResolutionError,
  type AgentConfigReloadResult,
  type ResolvedAgentRunConfig,
  type SafeProviderCredentialMetadata
} from "./configManager.ts";
import { AgentCredentialError, type CredentialStore } from "./credentialStore.ts";
import {
  OpenRouterConnectionError,
  OpenRouterConnectionManager,
  OpenRouterValidationUnavailableError,
  type OpenRouterConnectionAttemptState
} from "./openrouterConnection.ts";
import { withoutAgentCredentialEnvironment } from "./childEnvironment.ts";
import { openTrustedExternalUrl } from "../externalUrl.ts";
import type { LegacyCredentialRemovalPreview } from "./legacyCredentialRemoval.ts";
import { AgentSecurityDoctor } from "./securityDoctor.ts";
import { AgentSecurityRepairJournal } from "./securityRepairJournal.ts";
import { AgentSecurityRepairError, AgentSecurityRepairService } from "./securityRepairService.ts";

const DEFAULT_OPENROUTER_KEY_ENV = "OPENROUTER_API_KEY";
const AGENT_ENABLED_ENV = "RELAYBASE_AGENT_ENABLED";
const AGENT_REMOTE_MODEL_ENABLED_ENV = "RELAYBASE_AGENT_REMOTE_MODEL_ENABLED";
const AGENT_MODEL_ENV = "RELAYBASE_AGENT_MODEL";
const MAX_AUTHORIZED_PROJECT_ROOTS = 8;
const MAX_PROJECT_ROOT_LENGTH = 4_096;
const AGENT_CONFIG_FILE = "config.json";
const LEGACY_DEFAULT_TOOL_ALLOWLIST = [
  "list_apps",
  "get_app_state",
  "get_app_group",
  "get_diagnostics",
  "tail_logs",
  "search_logs",
  "project_list_files",
  "project_search_files",
  "project_read_file",
  "project_detect_start_commands",
  "project_inspect_package_scripts",
  "start_app",
  "stop_app",
  "restart_app",
  "export_logs",
  "detect_project",
  "plan_app_setup",
  "preview_setup_writes",
  "apply_setup_plan",
  "register_manifest",
  "inspect_manifest",
  "validate_manifest",
  "patch_manifest_fields",
  "set_health_route",
  "set_pinned_port",
  "set_component_metadata",
  "add_env_override_safe",
  "open_project_or_app",
  "setup_and_start_project",
  "prove_app_health",
  "repair_app_setup",
  "propose_tui_action"
];

export class AgentGatewayRequestError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly detail?: unknown;
  readonly userAction?: string;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    options: { retryable?: boolean; detail?: unknown; userAction?: string } = {}
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.retryable = options.retryable ?? statusCode >= 500;
    this.detail = options.detail;
    this.userAction = options.userAction;
  }
}

class AgentProjectRootGrantRequiredError extends AgentRuntimeError {
  readonly toolCallId?: string;
  readonly toolName: string;

  constructor(
    pending: { toolCallId?: string; toolName: string },
    authorization: { code: string; message: string; userAction: string; detail?: unknown }
  ) {
    super(authorization.code, authorization.message, {
      retryable: true,
      userAction: authorization.userAction,
      detail: authorization.detail
    });
    this.name = "AgentProjectRootGrantRequiredError";
    this.toolCallId = pending.toolCallId;
    this.toolName = pending.toolName;
  }
}

type AgentSubscriber = (event: AgentRunEvent) => void;

type AgentSubmissionRequest = AgentMessageRequest & {
  idempotencyKey?: string;
};

interface RunExecution {
  runId: string;
  controller: AbortController;
  kind: "queued_model" | "model" | "approved_tool";
}

interface QueuedRunInput {
  runtime: RelaybaseRuntime;
  sessionId: string;
  runId: string;
  messageId: string;
  context: TuiAgentContext;
  projectRootGrants: readonly AgentProjectRootGrant[];
  config: AgentConfig;
  resolvedConfig: ResolvedAgentRunConfig;
  knownSecrets: string[];
  retryOfRunId?: string;
}

export interface AgentGatewayServiceOptions {
  agentRuntime?: OperatorAgentRuntime;
  sessionStore?: AgentSessionStore;
  approvalStore?: ApprovalStore;
  auditStore?: AgentAuditStore;
  stateDir?: string;
  environment?: {
    modelSource?: AgentModelSource;
    envFilePath?: string;
    envFileFingerprint?: string;
    envFileAppliedKeys?: string[];
    envFileSkippedKeys?: string[];
    envFileSourceKind?: "explicit_env_file" | "cwd_env_file";
  };
  credentialStore?: CredentialStore;
  openExternalUrl?: (url: string, env: NodeJS.ProcessEnv) => boolean;
}

export class AgentGatewayService {
  #config: AgentConfig = defaultAgentConfig();
  #configManager: AgentConfigManager;
  #openRouterConnection: OpenRouterConnectionManager;
  #sessions: AgentSessionStore;
  #agentRuntime: OperatorAgentRuntime;
  #approvals: ApprovalStore;
  #audit: AgentAuditStore;
  #stateDir?: string;
  #configPath?: string;
  #subscribers = new Map<string, Set<AgentSubscriber>>();
  #sequence = 0;
  #budgetReservations = new Map<string, { sessionId: string; estimatedUsd: number; createdAt: string }>();
  #executions = new Map<string, RunExecution>();
  #activity = new AgentActivityProjector();
  #openExternalUrl: (url: string, env: NodeJS.ProcessEnv) => boolean;
  #credentialStore?: CredentialStore;
  #securityRepairJournal: AgentSecurityRepairJournal;
  #securityRepair: AgentSecurityRepairService;

  constructor(options: AgentGatewayServiceOptions = {}) {
    this.#openExternalUrl = options.openExternalUrl ?? openTrustedExternalUrl;
    this.#credentialStore = options.credentialStore;
    this.#stateDir = options.stateDir;
    this.#configPath = options.stateDir ? path.join(options.stateDir, "agent", AGENT_CONFIG_FILE) : undefined;
    const persisted = loadPersistedAgentConfig(
      defaultAgentConfig(process.env, options.environment?.modelSource),
      this.#configPath
    );
    this.#config = persisted.config;
    this.#configManager = new AgentConfigManager({
      initialConfig: this.#config,
      environment: options.environment,
      shellEnvironment: process.env,
      credentialStore: options.credentialStore,
      managedCredentialState: persisted.managedCredentialState,
      onActivated: (config) => {
        this.#config = config;
        this.#persistConfig();
      }
    });
    this.#sessions = options.sessionStore ?? new AgentSessionStore({ stateDir: options.stateDir });
    this.#agentRuntime = options.agentRuntime ?? new OperatorAgentRuntime();
    this.#audit = options.auditStore ?? new AgentAuditStore({ stateDir: options.stateDir });
    this.#openRouterConnection = new OpenRouterConnectionManager({
      configManager: this.#configManager,
      onStateChange: (state) => {
        if (!["connected", "connected_unverified", "cancelled", "expired", "failed"].includes(state.status)) {
          return;
        }
        const event =
          state.status === "connected" || state.status === "connected_unverified"
            ? state.mode === "replace"
              ? "agent.credential_replaced"
              : "agent.credential_connected"
            : "agent.credential_connection_failed";
        this.#auditEvent(event, {
          attemptId: state.attemptId,
          mode: state.mode,
          result: state.status,
          diagnosticCode: state.diagnostic?.code
        });
      }
    });
    this.#securityRepairJournal = new AgentSecurityRepairJournal({
      stateDir: options.stateDir,
      ...(options.credentialStore?.available() && options.credentialStore.restrictPathToCurrentUser
        ? { restrictPath: (target: string) => options.credentialStore!.restrictPathToCurrentUser!(target) }
        : {})
    });
    const securityDoctor = new AgentSecurityDoctor({
      getConfig: () => this.#safeConfig(),
      refreshManagedCredentialState: () => this.#configManager.refreshManagedCredentialState(),
      inspectCredentialProtection: async (credentialId) => {
        if (this.#credentialStore?.inspectProtection) {
          const credential = await this.#credentialStore.inspectProtection(credentialId);
          const journalAcl = this.#credentialStore.inspectPathProtection
            ? await this.#credentialStore.inspectPathProtection(this.#securityRepairJournal.dbPath)
            : "unknown";
          return {
            ...credential,
            acl: credential.acl === "weak" || journalAcl === "weak" ? "weak" : credential.acl
          };
        }
        const config = this.#safeConfig();
        return {
          available: Boolean(this.#credentialStore?.available()),
          credentialExists: Boolean(config.provider.apiKeySource.configured),
          acl: "unknown"
        };
      },
      providerAttempt: () => {
        const attempt = this.#openRouterConnection.status();
        return attempt ? { status: attempt.status, expiresAt: attempt.expiresAt } : null;
      },
      probeProviderCredential: async () => {
        await this.#configManager.probeManagedCredential((credential) =>
          this.#openRouterConnection.validateCredential(credential)
        );
      },
      windowsVerificationAvailability: () =>
        this.#credentialStore?.verificationAvailability?.() ?? {
          available: false,
          reason: "interactive_daemon_prompt_ownership_unproven"
        }
    });
    this.#securityRepair = new AgentSecurityRepairService({
      doctor: securityDoctor,
      journal: this.#securityRepairJournal,
      binding: () => this.#securityRepairBinding(),
      refreshManagedCredentialState: () => this.#configManager.refreshManagedCredentialState(),
      clearStaleProviderConnection: () => {
        this.#openRouterConnection.clearTerminalAttempts();
      },
      repairCredentialAcl: () => this.#repairCredentialAcl(),
      validateManagedCredential: async () => {
        await this.validateOpenRouterCredential();
      },
      migrateLegacyCredential: async () => {
        await this.migrateOpenRouterCredential();
      },
      removeLegacyExternalAssignment: async () => {
        const preview = await this.previewLegacyCredentialRemoval();
        await this.applyLegacyCredentialRemoval(preview.previewId);
      },
      disconnectLocalCredential: async () => {
        await this.disconnectOpenRouter();
      },
      openProviderKeyManagement: async () => {
        const opened = this.#openExternalUrl(
          "https://openrouter.ai/settings/keys",
          this.sanitizeChildEnvironment(process.env)
        );
        if (!opened) {
          throw new AgentGatewayRequestError(
            409,
            "AGENT_PROVIDER_KEY_MANAGEMENT_OPEN_FAILED",
            "Relaybase could not open OpenRouter key management.",
            {
              retryable: true,
              userAction: "Open https://openrouter.ai/settings/keys in a trusted browser."
            }
          );
        }
      },
      reloadSelectedAgentConfig: async () => {
        const result = await this.reloadConfig();
        if (result.status === "blocked") {
          throw new AgentGatewayRequestError(
            409,
            result.diagnostic?.code ?? "AGENT_CONFIG_RELOAD_INVALID",
            result.diagnostic?.message ?? "Agent configuration reload was blocked.",
            {
              retryable: false,
              userAction:
                result.diagnostic?.userAction ?? "Repair the selected source and create a fresh repair preview."
            }
          );
        }
      },
      audit: (type, data) => this.#auditEvent(type, data)
    });
    this.#approvals = options.approvalStore ?? new ApprovalStore({ threadStore: this.#sessions.threadStore() });
    this.#sequence = this.#sessions.maxEventSequence();
    const recoveredApprovals = this.#approvals.recoverPending();
    for (const approval of recoveredApprovals) {
      this.#auditEvent(
        "agent.approval_recovered",
        {
          approvalId: approval.id,
          sessionId: approval.sessionId,
          runId: approval.runId,
          recoveryState: approval.recoveryState,
          rawArgumentsPersisted: approval.rawArgumentsPersisted
        },
        { sessionId: approval.sessionId, runId: approval.runId }
      );
    }
    this.#reconcileInterruptedRuns(new Set(recoveredApprovals.map((approval) => approval.runId)));
  }

  async close(): Promise<void> {
    this.#openRouterConnection.close();
    for (const execution of this.#executions.values()) execution.controller.abort("Relaybase daemon is shutting down.");
    const deadline = Date.now() + 5_000;
    while (this.#executions.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (this.#executions.size > 0) {
      throw new Error("Operator Agent executions did not stop before the shutdown deadline.");
    }
    this.#audit.close();
    this.#sessions.close();
    this.#securityRepairJournal.close();
  }

  getConfig(): AgentConfig {
    return this.#safeConfig();
  }

  async getConfigStatus(): Promise<AgentConfig> {
    await this.#configManager.refreshManagedCredentialState();
    return this.#safeConfig();
  }

  updateConfig(raw: Record<string, unknown>): AgentConfig {
    if (containsRawApiKey(raw)) {
      throw new AgentGatewayRequestError(
        400,
        "AGENT_RAW_API_KEY_NOT_ALLOWED",
        "Agent config must reference an API key source, not include a raw key.",
        {
          retryable: false,
          userAction: "Use Agent Provider settings to connect OpenRouter or select a legacy environment key reference."
        }
      );
    }

    const previousConfig = structuredClone(this.#config);
    const requestUpdate =
      raw.update && typeof raw.update === "object" && !Array.isArray(raw.update)
        ? (raw.update as Record<string, unknown>)
        : raw;
    const expectedRevisionId =
      typeof raw.expectedRevisionId === "string" && raw.expectedRevisionId.trim()
        ? raw.expectedRevisionId.trim()
        : undefined;
    const update = requestUpdate as AgentConfigUpdate;
    const invalidExecution =
      update.execution === undefined
        ? undefined
        : invalidAgentExecutionPolicy(update.execution, this.#config.execution);
    if (invalidExecution) {
      throw new AgentGatewayRequestError(
        400,
        "AGENT_EXECUTION_POLICY_INVALID",
        `Agent execution policy is invalid: ${invalidExecution}`,
        {
          retryable: false,
          userAction: "Correct the bounded execution setting and retry."
        }
      );
    }
    const now = new Date().toISOString();
    const requestedToolMode =
      update.toolAllowlistMode === "all_registered" || update.toolAllowlistMode === "explicit_allowlist"
        ? update.toolAllowlistMode
        : Array.isArray(update.toolAllowlist)
          ? "explicit_allowlist"
          : this.#config.toolAllowlistMode;
    const requestedToolAllowlist =
      requestedToolMode === "all_registered"
        ? relaybaseAgentToolNames()
        : Array.isArray(update.toolAllowlist)
          ? normalizedToolNames(update.toolAllowlist)
          : this.#config.toolAllowlist;
    this.#config = {
      ...this.#config,
      ...(typeof update.enabled === "boolean" ? { enabled: update.enabled } : {}),
      ...(update.execution
        ? { execution: normalizeAgentExecutionPolicy(update.execution, this.#config.execution) }
        : {}),
      toolAllowlist: requestedToolAllowlist,
      toolAllowlistMode: requestedToolMode,
      ...(update.approvalPolicy ? { approvalPolicy: update.approvalPolicy } : {}),
      ...(typeof update.allowBrowserOpen === "boolean" ? { allowBrowserOpen: update.allowBrowserOpen } : {}),
      ...(typeof update.allowCopyRoute === "boolean" ? { allowCopyRoute: update.allowCopyRoute } : {}),
      ...(update.budgets ? { budgets: sanitizeAgentPayload(update.budgets) as AgentConfig["budgets"] } : {}),
      provider: {
        ...this.#config.provider,
        ...(update.provider?.modelSlug !== undefined
          ? {
              modelSlug: stringOrUndefined(update.provider.modelSlug),
              modelSource: update.provider.modelSlug.trim()
                ? ({ kind: "persisted_config", label: "saved Agent configuration" } as const)
                : ({ kind: "unconfigured", label: "not configured" } as const)
            }
          : {}),
        ...(update.provider?.apiKeyEnvVar !== undefined
          ? {
              apiKeySource: {
                type: "environment",
                envVar: nonEmptyString(update.provider.apiKeyEnvVar, DEFAULT_OPENROUTER_KEY_ENV),
                configured: false
              }
            }
          : {}),
        ...(typeof update.provider?.remoteModelEnabled === "boolean"
          ? { remoteModelEnabled: update.provider.remoteModelEnabled }
          : {}),
        ...(update.provider?.httpRefererEnvVar !== undefined
          ? { httpRefererEnvVar: stringOrUndefined(update.provider.httpRefererEnvVar) }
          : {}),
        ...(update.provider?.titleEnvVar !== undefined
          ? { titleEnvVar: stringOrUndefined(update.provider.titleEnvVar) }
          : {})
      },
      updatedAt: now
    };
    let safeConfig: AgentConfig;
    try {
      safeConfig = this.#configManager.activateManagedConfig(this.#config, expectedRevisionId);
    } catch (error) {
      if (error instanceof AgentConfigResolutionError) {
        this.#config = previousConfig;
        throw new AgentGatewayRequestError(409, error.diagnostic.code, error.diagnostic.message, {
          retryable: false,
          userAction: error.diagnostic.userAction
        });
      }
      throw error;
    }
    if (
      (previousConfig.enabled && !safeConfig.enabled) ||
      (previousConfig.provider.remoteModelEnabled && !safeConfig.provider.remoteModelEnabled)
    ) {
      this.#stopModelExecutionsForLiveSafety();
    }
    this.#auditEvent("agent.config_updated", {
      revisionId: safeConfig.revision?.id,
      generation: safeConfig.revision?.generation,
      changedFields: Object.keys(update)
    });
    return safeConfig;
  }

  async reloadConfig(): Promise<AgentConfigReloadResult> {
    const result = await this.#configManager.reload({ force: true });
    this.#auditEvent(result.status === "blocked" ? "agent.config_reload_failed" : "agent.config_reload_applied", {
      status: result.status,
      oldRevisionId: result.oldRevisionId,
      newRevisionId: result.newRevisionId,
      changedFields: result.changedFields,
      diagnosticCode: result.diagnostic?.code
    });
    return result;
  }

  async providerStatus(attemptId?: string): Promise<{
    config: AgentConfig;
    attempt: OpenRouterConnectionAttemptState | null;
  }> {
    await this.#configManager.refreshManagedCredentialState();
    return {
      config: this.#safeConfig(),
      attempt: this.#openRouterConnection.status(attemptId)
    };
  }

  async agentSecurityStatus(options: { online?: boolean } = {}): Promise<AgentSecurityStatus> {
    const status = await this.#securityControl(() => this.#securityRepair.diagnose(options));
    const lastSecurityEvent = this.#audit
      .list()
      .toReversed()
      .find((event) =>
        ["agent.security_", "agent.credential_", "agent.legacy_credential_", "agent.windows_verification_"].some(
          (prefix) => event.type.startsWith(prefix)
        )
      );
    return {
      ...status,
      ...(lastSecurityEvent ? { lastSecurityEvent: { at: lastSecurityEvent.at, type: lastSecurityEvent.type } } : {})
    };
  }

  async previewAgentSecurityRepair(input: {
    actionIds?: AgentSecurityRepairActionId[];
    issueCodes?: string[];
    safe?: boolean;
    online?: boolean;
  }): Promise<AgentSecurityRepairPreview> {
    return this.#securityControl(() => this.#securityRepair.preview(input));
  }

  async applyAgentSecurityRepair(input: {
    previewId: string;
    idempotencyKey: string;
    confirmation: string;
  }): Promise<AgentSecurityRepairOperation> {
    return this.#securityControl(() => this.#securityRepair.apply(input));
  }

  agentSecurityRepairPreview(previewId: string): AgentSecurityRepairPreview {
    return this.#securityControlSync(() => this.#securityRepair.storedPreview(previewId));
  }

  agentSecurityRepairOperation(operationId: string): AgentSecurityRepairOperation {
    return this.#securityControlSync(() => this.#securityRepair.operation(operationId));
  }

  latestAgentSecurityRepairOperation(): AgentSecurityRepairOperation | null {
    return this.#securityControlSync(() => this.#securityRepair.latestOperation());
  }

  cancelAgentSecurityRepair(operationId: string): AgentSecurityRepairOperation {
    return this.#securityControlSync(() => this.#securityRepair.cancel(operationId));
  }

  async connectOpenRouter(
    mode: "connect" | "replace" = "connect",
    options: { openBrowser?: boolean } = {}
  ): Promise<OpenRouterConnectionAttemptState & { browserOpen?: "opened" | "unavailable" }> {
    const attempt = await this.#openRouterConnection.start(mode);
    const browserOpen =
      options.openBrowser && attempt.authorizationUrl
        ? this.#openExternalUrl(attempt.authorizationUrl, this.sanitizeChildEnvironment(process.env))
          ? "opened"
          : "unavailable"
        : undefined;
    this.#auditEvent("agent.credential_connect_requested", {
      attemptId: attempt.attemptId,
      mode,
      expiresAt: attempt.expiresAt,
      browserOpen
    });
    return { ...attempt, ...(browserOpen ? { browserOpen } : {}) };
  }

  async disconnectOpenRouter(): Promise<{
    disconnected: boolean;
    remoteCredentialStillActive: true;
    config: AgentConfig;
  }> {
    this.#auditEvent("agent.credential_disconnect_requested", {
      credentialId: this.#safeConfig().credential?.credentialId
    });
    const disconnected = await this.#credentialControl(() => this.#configManager.disconnectManagedCredential());
    this.#stopModelExecutionsForLiveSafety();
    this.#auditEvent("agent.credential_disconnected", {
      disconnected,
      remoteCredentialStillActive: true,
      revisionId: this.#safeConfig().revision?.id
    });
    return { disconnected, remoteCredentialStillActive: true, config: this.#safeConfig() };
  }

  async migrateOpenRouterCredential(): Promise<{ migrated: true; config: AgentConfig }> {
    const descriptor = await this.#credentialControl(() =>
      this.#configManager.migrateLegacyCredential((credential) =>
        this.#openRouterConnection.validateCredential(credential)
      )
    );
    this.#auditEvent("agent.credential_connected", {
      credentialId: descriptor.credentialId,
      protection: descriptor.protection,
      result: "migrated"
    });
    return { migrated: true, config: this.#safeConfig() };
  }

  async validateOpenRouterCredential(): Promise<{ validated: true; config: AgentConfig }> {
    await this.#credentialControl(() =>
      this.#configManager.validateManagedCredential((credential) =>
        this.#openRouterConnection.validateCredential(credential)
      )
    );
    this.#auditEvent("agent.credential_connected", {
      credentialId: this.#safeConfig().credential?.credentialId,
      protection: this.#safeConfig().credential?.protection,
      result: "revalidated"
    });
    return { validated: true, config: this.#safeConfig() };
  }

  async previewLegacyCredentialRemoval(): Promise<LegacyCredentialRemovalPreview> {
    const preview = await this.#credentialControl(() => this.#configManager.previewLegacyCredentialRemoval());
    this.#auditEvent("agent.legacy_credential_removal_previewed", {
      previewId: preview.previewId,
      sourceLabel: preview.sourceLabel,
      keyName: preview.keyName,
      lineNumber: preview.lineNumber,
      expiresAt: preview.expiresAt
    });
    return preview;
  }

  async applyLegacyCredentialRemoval(previewId: string): Promise<{
    removed: true;
    sourceLabel: string;
    changedLineCount: 1;
    reload: AgentConfigReloadResult;
    config: AgentConfig;
  }> {
    const result = await this.#credentialControl(() => this.#configManager.applyLegacyCredentialRemoval(previewId));
    this.#auditEvent("agent.legacy_credential_removed", {
      previewId,
      sourceLabel: result.sourceLabel,
      changedLineCount: result.changedLineCount,
      revisionId: result.reload.newRevisionId
    });
    return { ...result, config: this.#safeConfig() };
  }

  previewOpenRouterRevocation(): {
    action: "remote_revoke";
    supported: false;
    requiresExternalAction: true;
    managementUrl: string;
    localCredentialPreserved: true;
  } {
    this.#auditEvent("agent.credential_revocation_requested", {
      mode: "preview",
      credentialId: this.#safeConfig().credential?.credentialId
    });
    return {
      action: "remote_revoke",
      supported: false,
      requiresExternalAction: true,
      managementUrl: "https://openrouter.ai/settings/keys",
      localCredentialPreserved: true
    };
  }

  recordOpenRouterRevocationUnconfirmed(): void {
    this.#auditEvent("agent.credential_revocation_unconfirmed", {
      credentialId: this.#safeConfig().credential?.credentialId,
      localCredentialPreserved: true
    });
  }

  setWindowsVerificationMode(mode: unknown): {
    highSecurityMode: "unavailable";
    selectedMode: "off";
  } {
    if (mode === "off") {
      return { highSecurityMode: "unavailable", selectedMode: "off" };
    }
    this.#auditEvent("agent.windows_verification_failed", {
      result: "unavailable",
      reason: "interactive_daemon_prompt_ownership_unproven"
    });
    throw new AgentGatewayRequestError(
      409,
      "AGENT_WINDOWS_VERIFICATION_UNAVAILABLE",
      "Require Windows verification is unavailable in this daemon launch mode.",
      {
        retryable: false,
        userAction: "Keep silent mode enabled. Relaybase will not silently downgrade a required verification policy."
      }
    );
  }

  sanitizeChildEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return withoutAgentCredentialEnvironment(source, [
      this.#config.provider.apiKeySource.type === "environment" ? (this.#config.provider.apiKeySource.envVar ?? "") : ""
    ]);
  }

  async #repairCredentialAcl(): Promise<void> {
    const credentialId = this.#safeConfig().credential?.credentialId;
    if (!credentialId || !this.#credentialStore?.repairProtection) {
      throw new AgentCredentialError(
        "AGENT_CREDENTIAL_DPAPI_PROTECT_FAILED",
        "Protected credential ACL repair is unavailable."
      );
    }
    await this.#credentialControl(() => this.#credentialStore!.repairProtection!(credentialId));
    this.#credentialStore.restrictPathToCurrentUser?.(this.#securityRepairJournal.dbPath);
    if (
      this.#credentialStore.inspectPathProtection &&
      (await this.#credentialStore.inspectPathProtection(this.#securityRepairJournal.dbPath)) === "weak"
    ) {
      throw new AgentCredentialError(
        "AGENT_CREDENTIAL_DPAPI_PROTECT_FAILED",
        "Relaybase could not verify the repaired security journal access policy."
      );
    }
  }

  #securityRepairBinding(): {
    configRevisionId: string;
    credentialIdentity: string;
    sourceFingerprint: string;
  } {
    const binding = this.#configManager.securityRepairBindingState();
    return {
      configRevisionId: binding.configRevisionId,
      credentialIdentity: createHash("sha256")
        .update(binding.credentialId ?? "none")
        .digest("hex"),
      sourceFingerprint: binding.sourceFingerprint
    };
  }

  async #securityControl<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof AgentSecurityRepairError) {
        throw new AgentGatewayRequestError(error.statusCode, error.code, error.message, {
          retryable: error.code === "AGENT_SECURITY_REPAIR_PREVIEW_STALE",
          userAction: error.userAction
        });
      }
      throw error;
    }
  }

  #securityControlSync<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof AgentSecurityRepairError) {
        throw new AgentGatewayRequestError(error.statusCode, error.code, error.message, {
          retryable: error.code === "AGENT_SECURITY_REPAIR_PREVIEW_STALE",
          userAction: error.userAction
        });
      }
      throw error;
    }
  }

  async #credentialControl<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof AgentCredentialError) {
        throw new AgentGatewayRequestError(409, error.code, error.message, {
          retryable: false,
          userAction:
            error.code === "AGENT_LEGACY_CREDENTIAL_REMOVAL_STALE"
              ? "Create a fresh removal preview and confirm it again."
              : "Review Agent Provider status and retry the protected credential operation."
        });
      }
      if (error instanceof OpenRouterValidationUnavailableError) {
        throw new AgentGatewayRequestError(
          503,
          "AGENT_PROVIDER_KEY_UNVERIFIED",
          "OpenRouter credential validation is temporarily unavailable.",
          {
            retryable: true,
            userAction: "Retry validation when provider connectivity is available."
          }
        );
      }
      if (error instanceof OpenRouterConnectionError) {
        throw new AgentGatewayRequestError(409, error.code, error.message, {
          retryable: false,
          userAction: "Replace or reconnect the OpenRouter credential."
        });
      }
      throw error;
    }
  }

  async diagnostics(runtime: RelaybaseRuntime): Promise<AgentDiagnostic[]> {
    const configDiagnostics = this.#configDiagnostics();
    return [
      ...configDiagnostics,
      ...(configDiagnostics.length === 0
        ? [
            {
              id: "agent.runtime.ready",
              severity: "info" as const,
              code: "AGENT_RUNTIME_READY",
              message: "Relaybase Operator Agent is enabled and configured for model requests.",
              checkedAt: new Date().toISOString()
            },
            {
              id: "agent.daemon.state",
              severity: "info" as const,
              code: "AGENT_DAEMON_READY",
              message: "Agent Gateway can read Relaybase daemon context.",
              checkedAt: new Date().toISOString(),
              detail: { stateDir: runtime.stateDir }
            }
          ]
        : []),
      ...this.#sessions.diagnostics().map((diagnostic) => ({
        id: `agent.storage.${diagnostic.code.toLowerCase()}`,
        severity: "warning" as const,
        code: diagnostic.code,
        message: diagnostic.message,
        checkedAt: diagnostic.at,
        detail: diagnostic.detail
      }))
    ];
  }

  async createSession(runtime: RelaybaseRuntime, raw: AgentSessionCreateRequest): Promise<AgentSession> {
    const session = this.#sessions.create(raw, await normalizeTuiContext(runtime, raw.context));
    this.#auditEvent("agent.session_created", { sessionId: session.id });
    return session;
  }

  listSessions(): AgentSession[] {
    return this.#sessions.list();
  }

  activeRuns(): AgentRun[] {
    return this.#sessions
      .list()
      .map((session) => activeRunForSession(session))
      .filter((run): run is AgentRun => Boolean(run));
  }

  getSession(sessionId: string): AgentSession {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      throw new AgentGatewayRequestError(404, "AGENT_SESSION_NOT_FOUND", "Agent session was not found.", {
        retryable: false,
        detail: { sessionId },
        userAction: "Create a new agent session or refresh the session list."
      });
    }
    return session;
  }

  getActiveSession(): AgentSession | undefined {
    return this.#sessions.getActive();
  }

  getActiveUsage(): AgentUsageSnapshot {
    return activeThreadUsageSnapshot(this.getActiveSession()?.id, this.#audit.list());
  }

  activateSession(sessionId: string): AgentSession {
    const session = this.#sessions.activate(sessionId);
    if (!session) {
      throw new AgentGatewayRequestError(404, "AGENT_SESSION_NOT_FOUND", "Agent session was not found.", {
        retryable: false,
        detail: { sessionId },
        userAction: "Create a new thread or refresh the thread list before activating it."
      });
    }
    this.#auditEvent("agent.session_activated", { sessionId }, { sessionId });
    return session;
  }

  async updateSession(
    runtime: RelaybaseRuntime,
    sessionId: string,
    raw: AgentThreadUpdateRequest
  ): Promise<AgentSession> {
    const context = raw.context ? await normalizeTuiContext(runtime, raw.context) : undefined;
    const session = this.#sessions.update(sessionId, sanitizeAgentPayload(raw) as AgentThreadUpdateRequest, context);
    if (!session) {
      throw new AgentGatewayRequestError(404, "AGENT_SESSION_NOT_FOUND", "Agent session was not found.", {
        retryable: false,
        detail: { sessionId },
        userAction: "Refresh the thread list before updating a thread."
      });
    }
    this.#auditEvent("agent.session_updated", { sessionId, titleChanged: raw.title !== undefined }, { sessionId });
    return session;
  }

  threadContextPreview(sessionId: string): AgentThreadContextPreview {
    const preview = this.#sessions.contextPreview(sessionId);
    if (!preview) {
      throw new AgentGatewayRequestError(404, "AGENT_SESSION_NOT_FOUND", "Agent session was not found.", {
        retryable: false,
        detail: { sessionId },
        userAction: "Refresh the thread list before reading the thread context preview."
      });
    }
    return sanitizeAgentPayload(preview);
  }

  clearSession(sessionId: string): { sessionId: string; cleared: true } {
    const activeRun = activeRunForSession(this.getSession(sessionId));
    if (activeRun) {
      throw new AgentGatewayRequestError(
        409,
        "AGENT_SESSION_RUN_ACTIVE",
        "Active agent runs must finish or be cancelled before clearing the session.",
        {
          retryable: true,
          detail: { sessionId, runId: activeRun.id, status: activeRun.status },
          userAction: "Cancel the active run or resolve its pending approval, then clear the session."
        }
      );
    }
    if (!this.#sessions.clear(sessionId)) {
      throw new AgentGatewayRequestError(404, "AGENT_SESSION_NOT_FOUND", "Agent session was not found.", {
        retryable: false,
        detail: { sessionId },
        userAction: "Refresh the session list before clearing a session."
      });
    }
    this.#auditEvent("agent.session_cleared", { sessionId }, { sessionId });
    return { sessionId, cleared: true };
  }

  exportSession(sessionId: string, raw: AgentSessionExportRequest = {}): AgentSessionExportResult {
    const session = this.getSession(sessionId);
    if (!this.#stateDir) {
      throw new AgentGatewayRequestError(
        503,
        "AGENT_SESSION_EXPORT_UNAVAILABLE",
        "Agent session export requires a daemon state directory.",
        {
          retryable: false,
          userAction: "Start Relaybase with a state directory before exporting chat/session history."
        }
      );
    }
    const format = raw.format === "markdown" ? "markdown" : "json";
    const auditEvents = this.#audit.list({ sessionId });
    const generatedAt = new Date().toISOString();
    const exportId = `agent_thread_${sessionId}_${Date.now()}`;
    const outputPath = path.join(
      this.#stateDir,
      "agent",
      "exports",
      `${exportId}.${format === "markdown" ? "md" : "json"}`
    );
    const sanitizedSession = sanitizeAgentPayloadWithReport(session);
    const sanitizedAuditEvents = sanitizeAgentPayloadWithReport(auditEvents);
    const report = mergeRedactionReport(sanitizedSession.report, sanitizedAuditEvents.report);
    const sanitized = {
      version: 1,
      generatedAt,
      session: sanitizedSession.value,
      auditEvents: sanitizedAuditEvents.value
    };
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(
      outputPath,
      format === "markdown"
        ? markdownThreadExport(
            sanitized as { session: AgentSession; auditEvents: AgentAuditEvent[]; generatedAt: string }
          )
        : JSON.stringify(sanitized, null, 2),
      "utf8"
    );
    const result: AgentSessionExportResult = {
      exportId,
      status: "succeeded",
      format,
      outputPath,
      sessionId,
      messageCount: session.messages.length,
      auditEventCount: auditEvents.length,
      generatedAt,
      redactionReport: report
    };
    this.#sessions.recordExport(result);
    this.#auditEvent("agent.session_exported", result, { sessionId });
    return sanitizeAgentPayload(result);
  }

  async addMessage(
    runtime: RelaybaseRuntime,
    sessionId: string,
    raw: AgentSubmissionRequest,
    options: { retryOfRunId?: string } = {}
  ): Promise<{ message: AgentMessage; run: AgentRun; diagnostics: AgentDiagnostic[]; reused?: boolean }> {
    let session = this.getSession(sessionId);
    const now = new Date().toISOString();
    const content = nonEmptyString(raw.content, "");
    if (!content) {
      throw new AgentGatewayRequestError(400, "AGENT_MESSAGE_REQUIRED", "Agent message content is required.", {
        retryable: false,
        userAction: "Send a non-empty message."
      });
    }
    const idempotencyKey = normalizeIdempotencyKey(raw.idempotencyKey);

    const context = await normalizeTuiContext(runtime, raw.context ?? session.context);
    const projectRootGrants = await canonicalProjectRootGrants(context);
    const messageId = idempotencyKey ? idempotentMessageId(sessionId, idempotencyKey) : randomUUID();
    const idempotencySafeContent = redactAgentText(content, [runtime.token]);
    session = this.getSession(sessionId);
    const existingMessage = session.messages.find((candidate) => candidate.id === messageId);
    if (existingMessage) {
      if (
        submissionFingerprint(existingMessage.content, existingMessage.context) !==
        submissionFingerprint(idempotencySafeContent, context)
      ) {
        throw new AgentGatewayRequestError(
          409,
          "AGENT_IDEMPOTENCY_KEY_REUSED",
          "The idempotency key was already used for a different Agent Gateway message.",
          {
            retryable: false,
            detail: { sessionId, messageId },
            userAction: "Reuse the key only for the same message and context, or submit with a new idempotency key."
          }
        );
      }
      const existingRun = existingMessage.runId
        ? session.runs.find((candidate) => candidate.id === existingMessage.runId)
        : undefined;
      if (!existingRun) {
        throw new AgentGatewayRequestError(
          409,
          "AGENT_IDEMPOTENT_RUN_MISSING",
          "The idempotent message exists, but its persisted run record is unavailable.",
          {
            retryable: false,
            detail: { sessionId, messageId, runId: existingMessage.runId },
            userAction: "Inspect the session store before retrying with a new idempotency key."
          }
        );
      }
      this.#auditEvent(
        "agent.run_submission_reused",
        { sessionId, runId: existingRun.id, messageId },
        { sessionId, runId: existingRun.id, modelSlug: existingRun.modelSlug, knownSecrets: [runtime.token] }
      );
      return {
        message: existingMessage,
        run: existingRun,
        diagnostics: existingRun.diagnostic ? [existingRun.diagnostic] : [],
        reused: true
      };
    }

    const activeRun = activeRunForSession(session);
    if (activeRun) {
      throw new AgentGatewayRequestError(
        409,
        "AGENT_SESSION_RUN_ACTIVE",
        "This agent session already has an active run.",
        {
          retryable: true,
          detail: { sessionId, runId: activeRun.id, status: activeRun.status },
          userAction: "Wait for the active run, resolve its approval, or cancel it before submitting another message."
        }
      );
    }

    let resolvedConfig: ResolvedAgentRunConfig | undefined;
    let resolutionDiagnostic: AgentDiagnostic | undefined;
    try {
      resolvedConfig = await this.#configManager.resolveForNewRun();
    } catch (error) {
      if (
        error instanceof AgentCredentialError &&
        this.#safeConfig().provider.apiKeySource.type === "managed_windows_dpapi"
      ) {
        this.#auditEvent("agent.credential_unprotect_failed", {
          credentialId: this.#safeConfig().credential?.credentialId,
          diagnosticCode: error.code
        });
      }
      resolutionDiagnostic =
        error instanceof AgentConfigResolutionError
          ? error.diagnostic
          : error instanceof AgentCredentialError
            ? diagnosticFromCredentialError(error)
            : diagnosticFromRuntimeError(error);
    }
    const config = resolvedConfig?.config ?? this.#safeConfig();
    const knownSecrets = [runtime.token, ...(resolvedConfig?.redactionSecrets ?? [])].filter(
      (secret) => secret.length > 0
    );
    const safeContent = redactAgentText(content, knownSecrets);
    const draftMessage: AgentMessage = {
      id: messageId,
      sessionId,
      role: "user",
      content: safeContent,
      createdAt: now,
      context
    };
    const draftRun: AgentRun = {
      id: randomUUID(),
      sessionId,
      status: "queued",
      provider: "openrouter",
      modelSlug: config.provider.modelSlug,
      configRevisionId: resolvedConfig?.revisionId ?? config.revision?.id,
      configGeneration: resolvedConfig?.generation ?? config.revision?.generation,
      createdAt: now,
      events: []
    };
    draftMessage.runId = draftRun.id;
    const message = this.#sessions.appendMessage(sessionId, draftMessage) ?? draftMessage;
    const run = this.#sessions.appendRun(sessionId, draftRun) ?? draftRun;
    this.#sessions.updateContext(sessionId, context);
    session = this.getSession(sessionId);
    this.#publishRunEvent(
      session,
      run,
      "message.user",
      { messageId: message.id, content: message.content },
      knownSecrets
    );

    const inputDiagnostic = userMessageGuardrail(content);
    if (inputDiagnostic) {
      resolvedConfig?.credentialLease.dispose();
      this.#finishBlockedRun(session, run, "agent.run_blocked", inputDiagnostic, content, knownSecrets);
      return { message, run, diagnostics: [inputDiagnostic] };
    }

    if (resolutionDiagnostic || !resolvedConfig) {
      const blockingDiagnostic =
        resolutionDiagnostic ??
        diagnosticFromRuntimeError(new Error("Agent configuration resolution ended without a snapshot."));
      this.#finishBlockedRun(session, run, "agent.run_blocked", blockingDiagnostic, content, knownSecrets);
      return { message, run, diagnostics: [blockingDiagnostic] };
    }

    const budgetDiagnostic = this.#reserveBudget(config, sessionId, run.id);
    if (budgetDiagnostic) {
      resolvedConfig.credentialLease.dispose();
      this.#finishBlockedRun(session, run, "agent.budget_blocked", budgetDiagnostic, content, knownSecrets);
      return { message, run, diagnostics: [budgetDiagnostic] };
    }

    const controller = new AbortController();
    this.#executions.set(sessionId, { runId: run.id, controller, kind: "queued_model" });
    this.#auditEvent(
      "agent.run_queued",
      {
        sessionId,
        runId: run.id,
        userIntentSummary: summarizeUserIntent(content),
        messageId,
        retryOfRunId: options.retryOfRunId ?? null
      },
      { sessionId, runId: run.id, modelSlug: config.provider.modelSlug, knownSecrets }
    );
    setImmediate(() => {
      void this.#executeQueuedRun({
        runtime,
        sessionId,
        runId: run.id,
        messageId: message.id,
        context,
        projectRootGrants,
        config,
        resolvedConfig,
        knownSecrets,
        retryOfRunId: options.retryOfRunId
      });
    });
    return { message, run, diagnostics: [] };
  }

  listRuns(sessionId: string): AgentRun[] {
    return this.getSession(sessionId).runs;
  }

  getRun(sessionId: string, runId: string): AgentRun {
    const run = this.getSession(sessionId).runs.find((candidate) => candidate.id === runId);
    if (!run) {
      throw new AgentGatewayRequestError(404, "AGENT_RUN_NOT_FOUND", "Agent run was not found in this session.", {
        retryable: false,
        detail: { sessionId, runId },
        userAction: "Refresh the session run list before inspecting, cancelling, or retrying a run."
      });
    }
    return run;
  }

  activeRun(sessionId: string): AgentRun | undefined {
    return activeRunForSession(this.getSession(sessionId));
  }

  cancelRun(sessionId: string, runId: string): AgentRun {
    const run = this.getRun(sessionId, runId);
    if (run.status === "cancelled") {
      return run;
    }
    if (run.status === "completed" || run.status === "failed") {
      throw new AgentGatewayRequestError(409, "AGENT_RUN_NOT_ACTIVE", "Only an active agent run can be cancelled.", {
        retryable: false,
        detail: { sessionId, runId, status: run.status },
        userAction:
          run.status === "failed" ? "Retry the failed run instead." : "Submit a new message if more work is needed."
      });
    }

    const execution = this.#executions.get(sessionId);
    if (execution?.runId === runId && execution.kind === "approved_tool") {
      throw new AgentGatewayRequestError(
        409,
        "AGENT_APPROVED_TOOL_IN_PROGRESS",
        "The approved daemon tool is already executing and cannot be cancelled safely through the agent run API.",
        {
          retryable: true,
          detail: { sessionId, runId },
          userAction: "Wait for the daemon tool result, then cancel any remaining agent workflow continuation."
        }
      );
    }

    execution?.controller.abort("user_cancelled");
    this.#rejectPendingApprovalsForRun(sessionId, runId, "run_cancelled");
    const session = this.getSession(sessionId);
    const persistedRun = session.runs.find((candidate) => candidate.id === runId) ?? run;
    const diagnostic = cancelledRunDiagnostic();
    persistedRun.status = "cancelled";
    persistedRun.completedAt = new Date().toISOString();
    persistedRun.diagnostic = diagnostic;
    this.#publishRunEvent(session, persistedRun, "diagnostic", diagnostic);
    this.#publishRunEvent(session, persistedRun, "run.failed", {
      diagnostic,
      cancelled: true,
      modelOutputProduced: false
    });
    this.#releaseBudget(runId);
    if (execution?.runId === runId) {
      this.#executions.delete(sessionId);
    }
    this.#auditEvent("agent.run_cancelled", { sessionId, runId }, { sessionId, runId, modelSlug: run.modelSlug });
    return this.getRun(sessionId, runId);
  }

  #stopModelExecutionsForLiveSafety(): void {
    for (const [sessionId, execution] of [...this.#executions.entries()]) {
      if (execution.kind === "approved_tool") {
        continue;
      }
      const session = this.#sessions.get(sessionId);
      const run = session?.runs.find((candidate) => candidate.id === execution.runId);
      if (!session || !run || !["queued", "running"].includes(run.status)) {
        continue;
      }
      execution.controller.abort("agent_live_safety_configuration_changed");
      this.#rejectPendingApprovalsForRun(sessionId, run.id, "agent_disabled");
      const diagnostic: AgentDiagnostic = {
        id: "agent.run.cancelled_by_live_safety",
        severity: "warning",
        code: "AGENT_RUN_CANCELLED",
        message: "Operator Agent model work stopped because live safety configuration was tightened.",
        checkedAt: new Date().toISOString(),
        userAction: "Review Agent settings before retrying the request."
      };
      this.#finishFailedRun(session, run, diagnostic, "", []);
      this.#releaseBudget(run.id);
      this.#executions.delete(sessionId);
      this.#auditEvent(
        "agent.run_stopped_by_live_safety",
        { sessionId, runId: run.id },
        { sessionId, runId: run.id, modelSlug: run.modelSlug }
      );
    }
  }

  async retryRun(
    runtime: RelaybaseRuntime,
    sessionId: string,
    runId: string,
    raw: { idempotencyKey?: unknown } = {}
  ): Promise<{ message: AgentMessage; run: AgentRun; diagnostics: AgentDiagnostic[]; reused?: boolean }> {
    const session = this.getSession(sessionId);
    const run = this.getRun(sessionId, runId);
    if (!retryableRun(run)) {
      throw new AgentGatewayRequestError(
        409,
        "AGENT_RUN_NOT_RETRYABLE",
        "Only failed or cancelled agent runs can be retried.",
        {
          retryable: false,
          detail: { sessionId, runId, status: run.status },
          userAction: "Wait for the active run or submit a new message after a completed run."
        }
      );
    }
    const message = originalUserMessage(session, runId);
    if (!message) {
      throw new AgentGatewayRequestError(
        409,
        "AGENT_RETRY_MESSAGE_UNAVAILABLE",
        "The original user message for this run is unavailable.",
        {
          retryable: false,
          detail: { sessionId, runId },
          userAction: "Submit a new message instead of retrying this run."
        }
      );
    }
    const result = await this.addMessage(
      runtime,
      sessionId,
      {
        content: message.content,
        context: message.context,
        ...(raw.idempotencyKey !== undefined ? { idempotencyKey: String(raw.idempotencyKey) } : {})
      },
      { retryOfRunId: runId }
    );
    this.#auditEvent(
      "agent.run_retry_queued",
      { sessionId, originalRunId: runId, retryRunId: result.run.id, reused: result.reused === true },
      { sessionId, runId: result.run.id, modelSlug: result.run.modelSlug }
    );
    return result;
  }

  async #executeQueuedRun(input: QueuedRunInput): Promise<void> {
    const execution = this.#executions.get(input.sessionId);
    if (!execution || execution.runId !== input.runId) {
      input.resolvedConfig.credentialLease.dispose();
      return;
    }

    let session = this.getSession(input.sessionId);
    let run = session.runs.find((candidate) => candidate.id === input.runId);
    const message = session.messages.find((candidate) => candidate.id === input.messageId);
    if (!run || !message || run.status !== "queued" || execution.controller.signal.aborted) {
      input.resolvedConfig.credentialLease.dispose();
      this.#releaseBudget(input.runId);
      if (this.#executions.get(input.sessionId)?.runId === input.runId) {
        this.#executions.delete(input.sessionId);
      }
      return;
    }

    execution.kind = "model";
    run.status = "running";
    run.startedAt = new Date().toISOString();
    this.#publishRunEvent(session, run, "run.started", {
      runId: run.id,
      provider: "openrouter",
      modelSlug: input.config.provider.modelSlug ?? null,
      messageId: message.id,
      retryOfRunId: input.retryOfRunId ?? null
    });
    this.#auditEvent(
      "agent.run_requested",
      {
        sessionId: input.sessionId,
        runId: run.id,
        userIntentSummary: summarizeUserIntent(message.content),
        retryOfRunId: input.retryOfRunId ?? null
      },
      {
        sessionId: input.sessionId,
        runId: run.id,
        modelSlug: input.config.provider.modelSlug,
        knownSecrets: input.knownSecrets
      }
    );

    let result: Awaited<ReturnType<OperatorAgentRuntime["execute"]>> | undefined;
    let unexpectedDiagnostic: AgentDiagnostic | undefined;
    try {
      const threadContext = this.threadContextPreview(input.sessionId);
      result = await this.#agentRuntime.execute({
        relaybase: input.runtime,
        config: input.config,
        session,
        message,
        run,
        context: input.context,
        projectRootGrants: input.projectRootGrants,
        threadContext,
        knownSecrets: input.knownSecrets,
        credential: input.resolvedConfig.credentialLease.value(),
        providerAttribution: input.resolvedConfig.provider,
        signal: execution.controller.signal,
        emit: (event: AgentRuntimeEvent) => {
          if (!execution.controller.signal.aborted) {
            this.#publishRunEvent(session, run as AgentRun, event.type, event.data, input.knownSecrets);
          }
        }
      });
    } catch (error) {
      unexpectedDiagnostic = diagnosticFromRuntimeError(error, input.config.provider.modelSlug);
    } finally {
      input.resolvedConfig.credentialLease.dispose();
      this.#releaseBudget(input.runId);
      if (this.#executions.get(input.sessionId)?.runId === input.runId) {
        this.#executions.delete(input.sessionId);
      }
    }

    const persistedRun = this.getRun(input.sessionId, input.runId);
    if (persistedRun.status === "cancelled" || execution.controller.signal.aborted) {
      return;
    }
    session = this.getSession(input.sessionId);
    run = session.runs.find((candidate) => candidate.id === input.runId) ?? persistedRun;

    if (!result || unexpectedDiagnostic) {
      const diagnostic = unexpectedDiagnostic ?? {
        id: "agent.runtime.unexpected_failure",
        severity: "error" as const,
        code: "AGENT_RUNTIME_UNEXPECTED_FAILURE",
        message: "Operator Agent runtime ended without a result.",
        checkedAt: new Date().toISOString(),
        userAction: "Retry the run after inspecting Agent Gateway diagnostics."
      };
      this.#finishFailedRun(session, run, diagnostic, message.content, input.knownSecrets);
      return;
    }

    if (result.status === "waiting_for_approval") {
      const approvals: AgentApproval[] = [];
      try {
        for (const pending of result.pendingApprovals ?? []) {
          approvals.push(
            await this.#createPendingApproval(input.runtime, session, run, pending, input.context, input.knownSecrets)
          );
        }
      } catch (error) {
        if (error instanceof AgentProjectRootGrantRequiredError) {
          this.#finishProjectRootGrantRequiredRun(session, run, error, message.content, input.knownSecrets);
          return;
        }
        this.#finishFailedRun(
          session,
          run,
          diagnosticFromRuntimeError(error, run.modelSlug),
          message.content,
          input.knownSecrets
        );
        return;
      }
      if (!approvals.length) {
        const diagnostic = {
          id: "agent.runtime.approval_missing",
          severity: "error" as const,
          code: "AGENT_APPROVAL_REQUEST_MISSING",
          message: "Operator Agent paused for approval without producing an approval request.",
          checkedAt: new Date().toISOString(),
          userAction: "Retry the run and inspect the model/tool interruption stream."
        };
        this.#finishFailedRun(session, run, diagnostic, message.content, input.knownSecrets);
        return;
      }
      run.status = "waiting_for_approval";
      this.#sessions.updateRun(session.id, run);
      this.#auditEvent(
        "agent.run_waiting_for_approval",
        {
          sessionId: input.sessionId,
          runId: run.id,
          userIntentSummary: summarizeUserIntent(message.content),
          approvals
        },
        {
          sessionId: input.sessionId,
          runId: run.id,
          modelSlug: input.config.provider.modelSlug,
          knownSecrets: input.knownSecrets
        }
      );
      return;
    }

    if (result.status === "completed") {
      run.status = "completed";
      run.completedAt = new Date().toISOString();
      run.usage = result.usage;
      if (result.assistantContent) {
        this.#sessions.appendMessage(input.sessionId, {
          id: randomUUID(),
          sessionId: input.sessionId,
          runId: run.id,
          role: "assistant",
          content: redactAgentText(result.assistantContent, input.knownSecrets),
          createdAt: run.completedAt
        });
      }
      if (result.usage) {
        this.#recordUsage(input.config, input.sessionId, run.id, result.usage, input.knownSecrets);
      }
      this.#publishRunEvent(
        session,
        run,
        "run.completed",
        { modelOutputProduced: true, toolNames: result.toolNames },
        input.knownSecrets
      );
      this.#publishRunEvent(
        session,
        run,
        "run.finalized",
        { outcome: "completed", assistantMessageDisposition: result.assistantContent ? "persisted" : "none" },
        input.knownSecrets
      );
      this.#auditEvent(
        "agent.run_completed",
        {
          sessionId: input.sessionId,
          runId: run.id,
          userIntentSummary: summarizeUserIntent(message.content),
          modelSlug: input.config.provider.modelSlug,
          toolNames: result.toolNames,
          usage: result.usage
        },
        {
          sessionId: input.sessionId,
          runId: run.id,
          modelSlug: input.config.provider.modelSlug,
          knownSecrets: input.knownSecrets
        }
      );
      return;
    }

    this.#finishFailedRun(
      session,
      run,
      result.diagnostics[0] ?? {
        id: "agent.runtime.failed",
        severity: "error",
        code: "AGENT_RUN_FAILED",
        message: "Operator Agent run failed without a structured diagnostic.",
        checkedAt: new Date().toISOString(),
        userAction: "Retry the run after inspecting Agent Gateway events."
      },
      message.content,
      input.knownSecrets,
      result.diagnostics,
      result.modelOutputProduced ?? false,
      result.blockedCandidate
    );
  }

  #finishBlockedRun(
    session: AgentSession,
    run: AgentRun,
    auditType: string,
    diagnostic: AgentDiagnostic,
    content: string,
    knownSecrets: string[]
  ): void {
    run.status = "failed";
    run.diagnostic = diagnostic;
    run.completedAt = new Date().toISOString();
    this.#publishRunEvent(session, run, "diagnostic", diagnostic, knownSecrets);
    this.#publishRunEvent(session, run, "blocked", { kind: "blocked", diagnostic }, knownSecrets);
    this.#publishRunEvent(session, run, "run.failed", { diagnostic, modelOutputProduced: false }, knownSecrets);
    this.#publishRunEvent(
      session,
      run,
      "run.finalized",
      { outcome: "blocked", assistantMessageDisposition: "none", diagnostic },
      knownSecrets
    );
    this.#auditEvent(
      auditType,
      {
        sessionId: session.id,
        runId: run.id,
        userIntentSummary: summarizeUserIntent(content),
        diagnostic
      },
      { sessionId: session.id, runId: run.id, modelSlug: run.modelSlug, knownSecrets }
    );
  }

  #finishFailedRun(
    session: AgentSession,
    run: AgentRun,
    diagnostic: AgentDiagnostic,
    content: string,
    knownSecrets: string[],
    diagnostics: AgentDiagnostic[] = [diagnostic],
    modelOutputProduced = false,
    blockedCandidate?: AgentBlockedCandidate
  ): void {
    run.status = diagnostic.code === "AGENT_RUN_CANCELLED" ? "cancelled" : "failed";
    run.completedAt = new Date().toISOString();
    run.diagnostic = diagnostic;
    const candidate = blockedCandidate
      ? {
          ...blockedCandidate,
          ...(session.privacy?.advancedRedactedDetailEnabled && blockedCandidate.inspectable
            ? { content: blockedCandidate.content }
            : { content: undefined })
        }
      : undefined;
    this.#publishRunEvent(
      session,
      run,
      "run.failed",
      {
        diagnostic,
        cancelled: run.status === "cancelled",
        modelOutputProduced,
        finalizationFollows: true,
        ...(candidate ? { candidate } : {})
      },
      knownSecrets
    );
    this.#publishRunEvent(
      session,
      run,
      "run.finalized",
      {
        outcome: run.status === "cancelled" ? "cancelled" : "failed",
        assistantMessageDisposition: blockedCandidate?.disposition ?? "none",
        diagnostic,
        ...(candidate ? { candidate } : {})
      },
      knownSecrets
    );
    if (blockedCandidate) {
      this.#auditEvent(
        "agent.blocked_candidate",
        { sessionId: session.id, runId: run.id, candidate: blockedCandidate },
        { sessionId: session.id, runId: run.id, modelSlug: run.modelSlug, knownSecrets }
      );
    }
    this.#auditEvent(
      run.status === "cancelled" ? "agent.run_cancelled" : "agent.run_failed",
      {
        sessionId: session.id,
        runId: run.id,
        userIntentSummary: summarizeUserIntent(content),
        diagnostics
      },
      { sessionId: session.id, runId: run.id, modelSlug: run.modelSlug, knownSecrets }
    );
  }

  #finishProjectRootGrantRequiredRun(
    session: AgentSession,
    run: AgentRun,
    error: AgentProjectRootGrantRequiredError,
    content: string,
    knownSecrets: string[]
  ): void {
    const diagnostic = diagnosticFromRuntimeError(error, run.modelSlug);
    const recoveryContent = diagnostic.userAction ?? diagnostic.message;
    this.#rejectPendingApprovalsForRun(session.id, run.id, "project_root_grant_required");
    this.#publishRunEvent(
      session,
      run,
      "tool.failed",
      {
        ...(error.toolCallId ? { toolCallId: error.toolCallId } : {}),
        toolName: error.toolName,
        diagnostic
      },
      knownSecrets
    );
    this.#publishRunEvent(session, run, "diagnostic", diagnostic, knownSecrets);
    this.#publishRunEvent(
      session,
      run,
      "clarification_needed",
      { kind: "clarification_needed", content: recoveryContent, diagnostic },
      knownSecrets
    );
    this.#auditEvent(
      "agent.project_root_grant_required",
      {
        sessionId: session.id,
        runId: run.id,
        toolName: error.toolName,
        ...(error.toolCallId ? { toolCallId: error.toolCallId } : {}),
        diagnostic
      },
      { sessionId: session.id, runId: run.id, modelSlug: run.modelSlug, knownSecrets }
    );
    this.#finishFailedRun(session, run, diagnostic, content, knownSecrets);
  }

  #rejectPendingApprovalsForRun(sessionId: string, runId: string, reason: string): void {
    const session = this.getSession(sessionId);
    const run = session.runs.find((candidate) => candidate.id === runId);
    for (const approval of this.#approvals.listPending().filter((candidate) => candidate.runId === runId)) {
      const resolved = this.#approvals.resolve(approval.id, "rejected");
      if (resolved && run) {
        this.#publishRunEvent(session, run, "tool.rejected", { approval: resolved, reason });
      }
    }
  }

  #reconcileInterruptedRuns(recoveredApprovalRunIds: Set<string>): void {
    for (const session of this.#sessions.list()) {
      for (const run of session.runs) {
        const interrupted = run.status === "queued" || run.status === "running";
        const missingApproval = run.status === "waiting_for_approval" && !recoveredApprovalRunIds.has(run.id);
        if (!interrupted && !missingApproval) {
          continue;
        }
        const previousStatus = run.status;
        const diagnostic = interruptedRunDiagnostic(run.status, missingApproval);
        run.status = "failed";
        run.completedAt = new Date().toISOString();
        run.diagnostic = diagnostic;
        this.#publishRunEvent(session, run, "diagnostic", diagnostic);
        this.#publishRunEvent(session, run, "run.failed", {
          diagnostic,
          interrupted: true,
          modelOutputProduced: false
        });
        this.#auditEvent(
          "agent.run_interrupted",
          { sessionId: session.id, runId: run.id, previousStatus },
          { sessionId: session.id, runId: run.id, modelSlug: run.modelSlug }
        );
      }
    }
  }

  getApproval(approvalId: string): AgentApproval {
    const approval = this.#approvals.get(approvalId);
    if (!approval) {
      throw new AgentGatewayRequestError(404, "AGENT_APPROVAL_NOT_FOUND", "Agent approval was not found.", {
        retryable: false,
        detail: { approvalId },
        userAction: "Refresh the session events before approving or rejecting."
      });
    }
    return approval;
  }

  async resolveApproval(
    runtime: RelaybaseRuntime,
    approvalId: string,
    status: "approved" | "rejected",
    raw: Record<string, unknown> = {}
  ): Promise<AgentApproval> {
    const approval = this.getApproval(approvalId);
    if (approval.status !== "pending" && approval.status !== "recovered_pending") {
      throw new AgentGatewayRequestError(
        409,
        "AGENT_APPROVAL_ALREADY_RESOLVED",
        "Agent approval is already resolved.",
        {
          retryable: false,
          detail: { approvalId, status: approval.status },
          userAction: "Refresh the pending approval state."
        }
      );
    }
    const config = this.#safeConfig();
    if (approval.status === "recovered_pending" && status === "approved") {
      const reconfirmed = raw.reconfirm === true || raw.resume === true;
      if (!reconfirmed) {
        throw new AgentGatewayRequestError(
          409,
          "AGENT_APPROVAL_RECONFIRM_REQUIRED",
          "Recovered approvals require explicit reconfirmation before Relaybase can resume execution.",
          {
            retryable: false,
            detail: { approvalId, recoveryState: approval.recoveryState },
            userAction: "Approve again with reconfirm=true after reviewing the recovered approval preview."
          }
        );
      }
      if (!approval.rawArgumentsPersisted || !this.#approvals.rawArguments(approval.id)) {
        throw new AgentGatewayRequestError(
          409,
          "AGENT_APPROVAL_RAW_ARGUMENTS_UNAVAILABLE",
          "Recovered approval execution arguments are unavailable, so Relaybase cannot safely resume it.",
          {
            retryable: false,
            detail: { approvalId, recoveryState: approval.recoveryState },
            userAction: "Create a fresh approval from the Operator Agent instead of resuming this recovered approval."
          }
        );
      }
    }
    if (status === "approved") {
      const savedArguments = this.#approvals.rawArguments(approval.id) ?? approval.arguments;
      const toolName = approval.toolName ?? approval.action;
      const decision = evaluateToolPolicy(toolName, savedArguments);
      const configDiagnostic = this.#toolConfigDiagnostic(config, toolName, decision);
      if (configDiagnostic) {
        throw new AgentGatewayRequestError(409, configDiagnostic.code, configDiagnostic.message, {
          retryable: false,
          detail: configDiagnostic.detail,
          userAction: configDiagnostic.userAction
        });
      }
      if (decision.status === "blocked" && decision.diagnostic) {
        throw new AgentGatewayRequestError(409, decision.diagnostic.code, decision.diagnostic.message, {
          retryable: false,
          detail: decision.diagnostic.detail,
          userAction: decision.diagnostic.userAction
        });
      }
      if (decision.status !== "approval_required") {
        throw new AgentGatewayRequestError(
          409,
          "AGENT_APPROVAL_POLICY_CHANGED",
          "The saved tool call is no longer approval-gated by the current Agent policy.",
          {
            retryable: false,
            detail: { approvalId, toolName, policyStatus: decision.status },
            userAction: "Refresh Agent configuration and create a new approval under the current policy."
          }
        );
      }
      await ensureApprovalTargetStillExists(runtime, approval, savedArguments);
      const proposedArguments = raw.arguments;
      if (proposedArguments !== undefined) {
        if (!proposedArguments || typeof proposedArguments !== "object" || Array.isArray(proposedArguments)) {
          throw new AgentGatewayRequestError(
            400,
            "AGENT_APPROVAL_ARGUMENTS_INVALID",
            "Approval arguments must be an object when provided.",
            {
              retryable: false,
              userAction:
                "Approve without arguments to use the exact saved call, or send the original arguments object."
            }
          );
        }
        const proposedHash = stableArgumentsHash(proposedArguments as Record<string, unknown>);
        if (approval.argumentsHash && proposedHash !== approval.argumentsHash) {
          throw new AgentGatewayRequestError(
            409,
            "AGENT_APPROVAL_ARGUMENTS_CHANGED",
            "Approval arguments changed after the approval preview was created.",
            {
              retryable: false,
              detail: { approvalId, expectedHash: approval.argumentsHash, receivedHash: proposedHash },
              userAction: "Create a new approval preview for the changed tool arguments."
            }
          );
        }
      }
    }

    const session = this.getSession(approval.sessionId);
    const run = session.runs.find((entry) => entry.id === approval.runId);
    if (!run) {
      throw new AgentGatewayRequestError(
        409,
        "AGENT_APPROVAL_RUN_MISSING",
        "The approval's agent run is unavailable.",
        {
          retryable: false,
          detail: { approvalId, sessionId: approval.sessionId, runId: approval.runId },
          userAction: "Inspect the persisted Agent Gateway session before creating a fresh approval."
        }
      );
    }
    if (run.status !== "waiting_for_approval") {
      throw new AgentGatewayRequestError(
        409,
        "AGENT_APPROVAL_RUN_NOT_WAITING",
        "The approval's agent run is no longer waiting for approval.",
        {
          retryable: false,
          detail: { approvalId, sessionId: approval.sessionId, runId: approval.runId, runStatus: run.status },
          userAction: "Refresh the run and pending approval state before resolving another approval."
        }
      );
    }
    const knownSecrets = [runtime.token];
    const existingExecution = this.#executions.get(session.id);
    if (status === "approved" && existingExecution) {
      throw new AgentGatewayRequestError(
        409,
        "AGENT_SESSION_RUN_ACTIVE",
        "The agent run already has active execution work.",
        {
          retryable: true,
          detail: { sessionId: session.id, runId: existingExecution.runId, kind: existingExecution.kind },
          userAction: "Wait for the current agent execution step before resolving another approval."
        }
      );
    }
    const resolved = this.#approvals.resolve(approvalId, status);
    if (!resolved) {
      throw new AgentGatewayRequestError(
        409,
        "AGENT_APPROVAL_ALREADY_RESOLVED",
        "Agent approval is already resolved.",
        {
          retryable: false,
          detail: { approvalId, status: approval.status },
          userAction: "Refresh the pending approval state."
        }
      );
    }
    if (run) {
      this.#publishRunEvent(
        session,
        run,
        status === "approved" ? "tool.approved" : "tool.rejected",
        {
          approval: resolved
        },
        knownSecrets
      );
    }

    if (status === "rejected") {
      const diagnostic = {
        id: `agent.approval.${approvalId}.rejected`,
        severity: "warning" as const,
        code: "AGENT_APPROVAL_REJECTED",
        message: "The user rejected the tool approval. The tool was not executed.",
        checkedAt: new Date().toISOString(),
        userAction: "Retry the run if the action is still desired."
      };
      this.#rejectPendingApprovalsForRun(session.id, run.id, "approval_rejected");
      run.status = "cancelled";
      run.completedAt = new Date().toISOString();
      run.diagnostic = diagnostic;
      this.#publishRunEvent(
        session,
        run,
        "action_result",
        { kind: "action_result", status: "rejected", approvalId, diagnostic },
        knownSecrets
      );
      this.#publishRunEvent(
        session,
        run,
        "run.failed",
        { diagnostic, cancelled: true, modelOutputProduced: false },
        knownSecrets
      );
      this.#auditEvent(
        "agent.approval_rejected",
        { approval: resolved, reason: raw.reason },
        { sessionId: session.id, runId: run?.id, modelSlug: run?.modelSlug, knownSecrets }
      );
      return resolved;
    }

    const controller = new AbortController();
    this.#executions.set(session.id, { runId: run.id, controller, kind: "approved_tool" });
    run.status = "running";
    this.#sessions.updateRun(session.id, run);
    try {
      await this.#executeApprovedTool(runtime, session, run, resolved, knownSecrets);
    } finally {
      if (this.#executions.get(session.id)?.runId === run.id) {
        this.#executions.delete(session.id);
      }
    }
    this.#auditEvent(
      "agent.approval_approved",
      { approval: resolved },
      {
        sessionId: session.id,
        runId: run?.id,
        modelSlug: run?.modelSlug,
        knownSecrets
      }
    );
    return resolved;
  }

  subscribeSession(sessionId: string, subscriber: AgentSubscriber): () => void {
    this.getSession(sessionId);
    const subscribers = this.#subscribers.get(sessionId) ?? new Set<AgentSubscriber>();
    subscribers.add(subscriber);
    this.#subscribers.set(sessionId, subscribers);
    return () => {
      subscribers.delete(subscriber);
      if (subscribers.size === 0) {
        this.#subscribers.delete(sessionId);
      }
    };
  }

  sessionEvents(sessionId: string, afterSequence = 0): AgentRunEvent[] {
    this.getSession(sessionId);
    return this.#sessions.sessionEvents(sessionId, afterSequence);
  }

  auditEvents(): AgentAuditEvent[] {
    return this.#audit.list();
  }

  async #createPendingApproval(
    runtime: RelaybaseRuntime,
    session: AgentSession,
    run: AgentRun,
    pending: {
      toolCallId?: string;
      toolName: string;
      arguments: Record<string, unknown>;
      expectedResult: string;
      risk: "low" | "medium" | "high";
      rawItem?: unknown;
    },
    context: TuiAgentContext,
    knownSecrets: string[]
  ): Promise<AgentApproval> {
    const projectRootGrants = await canonicalProjectRootGrants(context);
    const scopeAuthorization = await authorizeAgentToolProjectScope(
      pending.toolName,
      pending.arguments,
      context,
      projectRootGrants
    );
    if (!scopeAuthorization.ok) {
      throw new AgentProjectRootGrantRequiredError(pending, scopeAuthorization);
    }
    const preparedApproval = await prepareApprovalData(runtime, pending.toolName, pending.arguments, context);
    const approvalArguments = preparedApproval.arguments;
    const decision = evaluateToolPolicy(pending.toolName, approvalArguments);
    const configDiagnostic = this.#toolConfigDiagnostic(this.#safeConfig(), pending.toolName, decision);
    const blockingDiagnostic = configDiagnostic ?? (decision.status === "blocked" ? decision.diagnostic : undefined);
    if (blockingDiagnostic) {
      run.status = "failed";
      run.diagnostic = blockingDiagnostic;
      run.completedAt = new Date().toISOString();
      this.#publishRunEvent(session, run, "diagnostic", blockingDiagnostic, knownSecrets);
      this.#publishRunEvent(session, run, "blocked", { kind: "blocked", diagnostic: blockingDiagnostic }, knownSecrets);
      this.#publishRunEvent(
        session,
        run,
        "run.failed",
        {
          diagnostic: blockingDiagnostic,
          modelOutputProduced: false
        },
        knownSecrets
      );
      return this.#approvals.create({
        sessionId: session.id,
        runId: run.id,
        ...(pending.toolCallId ? { toolCallId: pending.toolCallId } : {}),
        toolName: pending.toolName,
        action: pending.toolName,
        risk: pending.risk,
        expectedResult: pending.expectedResult,
        arguments: sanitizeAgentPayload(approvalArguments, knownSecrets) as Record<string, unknown>,
        argumentsHash: stableArgumentsHash(approvalArguments),
        context,
        diagnostic: blockingDiagnostic
      });
    }

    const policy = decision.policy ?? {
      name: pending.toolName,
      approvalRequired: true,
      risk: pending.risk,
      expectedResult: pending.expectedResult,
      sensitiveData: false,
      category: "setup" as const
    };
    const approvalId = randomUUID();
    const previewData = preparedApproval.previewData;
    const preview = await buildApprovalPreview({
      runtime,
      policy,
      arguments: approvalArguments,
      tuiContext: context,
      approvalId,
      knownSecrets,
      previewData
    });
    const approval = this.#approvals.update(
      {
        id: approvalId,
        sessionId: session.id,
        runId: run.id,
        ...(pending.toolCallId ? { toolCallId: pending.toolCallId } : {}),
        toolName: pending.toolName,
        status: "pending",
        createdAt: new Date().toISOString(),
        action: pending.toolName,
        ...(preview.target ? { target: preview.target } : {}),
        risk: policy.risk,
        expectedResult: policy.expectedResult,
        arguments: sanitizeAgentPayload(approvalArguments, knownSecrets) as Record<string, unknown>,
        argumentsHash: stableArgumentsHash(approvalArguments),
        context,
        preview
      },
      approvalArguments
    );

    this.#publishRunEvent(
      session,
      run,
      "tool.call_requested",
      {
        approvalId: approval.id,
        toolCallId: approval.toolCallId,
        toolName: pending.toolName,
        arguments: approval.arguments,
        rawItem: sanitizeAgentPayload(pending.rawItem, knownSecrets)
      },
      knownSecrets
    );
    this.#publishRunEvent(session, run, "tool.approval_required", { approval }, knownSecrets);
    if (policy.category === "setup") {
      this.#publishRunEvent(session, run, "setup.file_write_approval_required", { approval }, knownSecrets);
    }
    if (policy.category === "manifest") {
      this.#publishRunEvent(session, run, "setup.manifest_patch_approval_required", { approval }, knownSecrets);
    }
    this.#auditEvent(
      "agent.approval_required",
      {
        approval,
        toolName: pending.toolName,
        category: policy.category,
        fileWritePreviewShown: policy.category === "setup",
        manifestPatchPreviewShown: policy.category === "manifest",
        runtime: approvalRuntimeAuditSummary(preview),
        selectedCommand: preview.selectedCommand,
        portStrategy: preview.portStrategy
      },
      { sessionId: session.id, runId: run.id, modelSlug: run.modelSlug, knownSecrets }
    );
    return approval;
  }

  async #executeApprovedTool(
    runtime: RelaybaseRuntime,
    session: AgentSession,
    run: AgentRun,
    approval: AgentApproval,
    knownSecrets: string[]
  ) {
    const toolName = approval.toolName ?? approval.action;
    const savedArguments = this.#approvals.rawArguments(approval.id) ?? approval.arguments;
    this.#publishRunEvent(
      session,
      run,
      "tool.started",
      {
        approvalId: approval.id,
        toolName,
        arguments: approval.arguments
      },
      knownSecrets
    );
    let result: Awaited<ReturnType<typeof executeRelaybaseAgentTool>>;
    try {
      const tuiContext = approval.context ?? session.context ?? { daemonHasZeroApps: false, diagnostics: [] };
      const projectRootGrants = await canonicalProjectRootGrants(tuiContext);
      result = await executeRelaybaseAgentTool(toolName, savedArguments, {
        runtime,
        tuiContext,
        projectRootGrants,
        config: this.#safeConfig(),
        approved: true,
        correlationId: approval.id,
        emit: (event) => this.#publishRunEvent(session, run, event.type, event.data, knownSecrets)
      });
    } catch (error) {
      const diagnostic = diagnosticFromRuntimeError(error, run.modelSlug);
      this.#publishRunEvent(
        session,
        run,
        "tool.failed",
        { approvalId: approval.id, toolName, diagnostic },
        knownSecrets
      );
      this.#finishFailedRun(
        session,
        run,
        diagnostic,
        originalUserMessage(session, run.id)?.content ?? "",
        knownSecrets
      );
      return;
    }
    this.#publishRunEvent(
      session,
      run,
      result.status === "succeeded" ? "tool.completed" : "tool.failed",
      {
        approvalId: approval.id,
        toolName,
        result
      },
      knownSecrets
    );
    this.#publishRunEvent(
      session,
      run,
      "action_result",
      {
        kind: "action_result",
        approvalId: approval.id,
        toolName,
        result
      },
      knownSecrets
    );
    if (result.diagnostic) {
      run.diagnostic = {
        id: `agent.tool.${approval.id}.${result.diagnostic.code.toLowerCase()}`,
        severity: result.diagnostic.severity,
        code: result.diagnostic.code,
        message: result.diagnostic.message,
        checkedAt: new Date().toISOString(),
        userAction: result.diagnostic.userAction,
        detail: result.diagnostic.detail
      };
    }
    this.#auditEvent(
      result.status === "succeeded" ? "agent.tool_completed" : "agent.tool_failed",
      {
        approvalId: approval.id,
        toolName,
        result: summarizeToolResult(result)
      },
      { sessionId: session.id, runId: run.id, modelSlug: run.modelSlug, knownSecrets }
    );

    if (result.status !== "succeeded") {
      const diagnostic =
        run.diagnostic ??
        ({
          id: `agent.tool.${approval.id}.failed`,
          severity: "error",
          code: "AGENT_APPROVED_TOOL_FAILED",
          message: `Approved Relaybase tool ${toolName} failed.`,
          checkedAt: new Date().toISOString(),
          userAction: "Inspect the tool result and retry the agent run when the underlying issue is resolved."
        } satisfies AgentDiagnostic);
      this.#finishFailedRun(
        session,
        run,
        diagnostic,
        originalUserMessage(session, run.id)?.content ?? "",
        knownSecrets
      );
      return;
    }

    const continuation = workflowContinuationForApprovedTool(toolName, result, approval);
    if (continuation) {
      const decision = evaluateToolPolicy(continuation.toolName, continuation.arguments);
      const configDiagnostic = this.#toolConfigDiagnostic(this.#safeConfig(), continuation.toolName, decision);
      if (configDiagnostic || decision.status !== "approval_required" || !decision.policy) {
        const diagnostic =
          configDiagnostic ??
          ({
            id: "agent.workflow.next_step_invalid",
            severity: "error",
            code: "AGENT_WORKFLOW_NEXT_STEP_INVALID",
            message: "The approved tool returned a continuation that is not an approval-gated Relaybase tool.",
            checkedAt: new Date().toISOString(),
            userAction: "Inspect the structured tool result before retrying the workflow."
          } satisfies AgentDiagnostic);
        this.#finishFailedRun(
          session,
          run,
          diagnostic,
          originalUserMessage(session, run.id)?.content ?? "",
          knownSecrets
        );
        return;
      }

      delete run.completedAt;
      delete run.diagnostic;
      let nextApproval: AgentApproval;
      try {
        nextApproval = await this.#createPendingApproval(
          runtime,
          session,
          run,
          {
            toolName: continuation.toolName,
            arguments: continuation.arguments,
            expectedResult: decision.policy.expectedResult,
            risk: decision.policy.risk
          },
          approval.context ?? session.context ?? { daemonHasZeroApps: false, diagnostics: [] },
          knownSecrets
        );
      } catch (error) {
        if (error instanceof AgentProjectRootGrantRequiredError) {
          this.#finishProjectRootGrantRequiredRun(
            session,
            run,
            error,
            originalUserMessage(session, run.id)?.content ?? "",
            knownSecrets
          );
          return;
        }
        throw error;
      }
      run.status = "waiting_for_approval";
      this.#sessions.updateRun(session.id, run);
      this.#auditEvent(
        "agent.workflow_continued",
        {
          sessionId: session.id,
          runId: run.id,
          completedToolName: toolName,
          nextToolName: continuation.toolName,
          nextApprovalId: nextApproval.id
        },
        { sessionId: session.id, runId: run.id, modelSlug: run.modelSlug, knownSecrets }
      );
      return;
    }

    const otherPendingApprovals = this.#approvals.listPending().filter((candidate) => candidate.runId === run.id);
    if (otherPendingApprovals.length) {
      run.status = "waiting_for_approval";
      this.#sessions.updateRun(session.id, run);
      return;
    }

    run.status = "completed";
    run.completedAt = new Date().toISOString();
    delete run.diagnostic;
    this.#publishRunEvent(
      session,
      run,
      "run.completed",
      { approvalId: approval.id, toolName, toolResultProduced: true, result },
      knownSecrets
    );
    this.#publishRunEvent(
      session,
      run,
      "run.finalized",
      { outcome: "completed", assistantMessageDisposition: "tool_result", approvalId: approval.id, toolName },
      knownSecrets
    );
  }

  #budgetDiagnostic(config: AgentConfig, sessionId: string): AgentDiagnostic | undefined {
    const budgets = config.budgets;
    if (!budgets) {
      return undefined;
    }
    const usage = this.#budgetUsage(sessionId);
    const exceeded =
      limitExceeded("session", usage.sessionUsd, budgets.sessionLimitUsd) ??
      limitExceeded("daily", usage.dailyUsd, budgets.dailyLimitUsd) ??
      limitExceeded("monthly", usage.monthlyUsd, budgets.monthlyLimitUsd);
    if (!exceeded) {
      return undefined;
    }
    return {
      id: `agent.budget.${exceeded.scope}.exceeded`,
      severity: "error",
      code: "AGENT_BUDGET_EXCEEDED",
      message: `Relaybase Operator Agent ${exceeded.scope} budget is exhausted.`,
      checkedAt: new Date().toISOString(),
      userAction: "Raise the configured budget limit or switch the Operator Agent back to deterministic mode.",
      detail: {
        scope: exceeded.scope,
        currentEstimatedUsd: exceeded.current,
        limitUsd: exceeded.limit
      }
    };
  }

  #reserveBudget(config: AgentConfig, sessionId: string, runId: string): AgentDiagnostic | undefined {
    const reservation = budgetReservationUsd(config.budgets);
    if (reservation > 0) {
      this.#budgetReservations.set(runId, {
        sessionId,
        estimatedUsd: reservation,
        createdAt: new Date().toISOString()
      });
    }

    const diagnostic = this.#budgetDiagnostic(config, sessionId);
    if (diagnostic) {
      this.#releaseBudget(runId);
    }
    return diagnostic;
  }

  #releaseBudget(runId: string): void {
    this.#budgetReservations.delete(runId);
  }

  #toolConfigDiagnostic(
    config: AgentConfig,
    toolName: string,
    decision: ReturnType<typeof evaluateToolPolicy>
  ): AgentDiagnostic | undefined {
    if (!config.enabled) {
      return {
        id: "agent.tool.agent_disabled",
        severity: "error",
        code: "AGENT_DISABLED",
        message: "The approved tool did not start because Operator Agent was disabled.",
        checkedAt: new Date().toISOString(),
        userAction: "Enable the Agent before approving or resuming this workflow."
      };
    }
    if (!config.toolAllowlist.includes(toolName)) {
      return {
        id: "agent.tool.disallowed_by_config",
        severity: "error",
        code: "AGENT_TOOL_NOT_ALLOWED_BY_CONFIG",
        message: `Tool ${toolName} is not in the configured agent tool allowlist.`,
        checkedAt: new Date().toISOString(),
        userAction: "Add the tool to toolAllowlist or choose a permitted tool."
      };
    }
    if (config.approvalPolicy === "read_only_only" && decision.policy?.approvalRequired) {
      return {
        id: "agent.tool.read_only_only_blocked",
        severity: "error",
        code: "AGENT_READ_ONLY_POLICY_BLOCKED",
        message: `Tool ${toolName} is blocked by read-only agent policy.`,
        checkedAt: new Date().toISOString(),
        userAction: "Switch approvalPolicy to always_for_mutations before using mutation tools."
      };
    }
    return undefined;
  }

  #budgetUsage(sessionId: string): { sessionUsd: number; dailyUsd: number; monthlyUsd: number } {
    const now = new Date();
    const startOfDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const startOfMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const usageEvents = this.#audit.list().filter((event) => event.type === "agent.usage_recorded");
    let sessionUsd = 0;
    let dailyUsd = 0;
    let monthlyUsd = 0;
    for (const event of usageEvents) {
      const at = Date.parse(event.at);
      const cost = usageCost(event.data);
      if (event.sessionId === sessionId) {
        sessionUsd += cost;
      }
      if (Number.isFinite(at) && at >= startOfDay) {
        dailyUsd += cost;
      }
      if (Number.isFinite(at) && at >= startOfMonth) {
        monthlyUsd += cost;
      }
    }
    for (const reservation of this.#budgetReservations.values()) {
      const at = Date.parse(reservation.createdAt);
      if (reservation.sessionId === sessionId) {
        sessionUsd += reservation.estimatedUsd;
      }
      if (Number.isFinite(at) && at >= startOfDay) {
        dailyUsd += reservation.estimatedUsd;
      }
      if (Number.isFinite(at) && at >= startOfMonth) {
        monthlyUsd += reservation.estimatedUsd;
      }
    }
    return { sessionUsd, dailyUsd, monthlyUsd };
  }

  #recordUsage(config: AgentConfig, sessionId: string, runId: string, usage: AgentUsage, knownSecrets: string[]): void {
    this.#auditEvent(
      "agent.usage_recorded",
      {
        usage,
        budget: config.budgets ?? null
      },
      { sessionId, runId, modelSlug: config.provider.modelSlug, knownSecrets }
    );
  }

  #safeConfig(): AgentConfig {
    const config = this.#configManager.getSafeState();
    const activeRunUsesOlderRevision = this.#sessions
      .list()
      .some((session) =>
        session.runs.some(
          (run) =>
            ["queued", "running", "waiting_for_approval"].includes(run.status) &&
            Boolean(run.configRevisionId) &&
            run.configRevisionId !== config.revision?.id
        )
      );
    return { ...config, activeRunUsesOlderRevision };
  }

  #configDiagnostics(): AgentDiagnostic[] {
    return diagnosticsForAgentConfig(this.#safeConfig());
  }

  #persistConfig(): void {
    if (!this.#configPath) {
      return;
    }
    const directory = path.dirname(this.#configPath);
    fs.mkdirSync(directory, { recursive: true });
    const persisted = {
      schemaVersion: 2,
      enabled: this.#config.enabled,
      provider: {
        modelSlug: this.#config.provider.modelSlug,
        apiKeySourceType: this.#config.provider.apiKeySource.type,
        apiKeyEnvVar: this.#config.provider.apiKeySource.envVar,
        credentialId: this.#config.provider.apiKeySource.credentialId,
        credentialState: this.#configManager.managedCredentialPersistenceState(),
        remoteModelEnabled: this.#config.provider.remoteModelEnabled,
        httpRefererEnvVar: this.#config.provider.httpRefererEnvVar,
        titleEnvVar: this.#config.provider.titleEnvVar
      },
      execution: this.#config.execution,
      toolAllowlist: this.#config.toolAllowlist,
      toolAllowlistMode: this.#config.toolAllowlistMode,
      approvalPolicy: this.#config.approvalPolicy,
      allowBrowserOpen: this.#config.allowBrowserOpen,
      allowCopyRoute: this.#config.allowCopyRoute,
      budgets: this.#config.budgets,
      updatedAt: this.#config.updatedAt
    };
    const temporaryPath = `${this.#configPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(persisted, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryPath, this.#configPath);
  }

  #publishRunEvent(
    session: AgentSession,
    run: AgentRun,
    type: AgentRunEventType,
    data: unknown,
    knownSecrets: string[] = []
  ): AgentRunEvent {
    const sequence = ++this.#sequence;
    const at = new Date().toISOString();
    const activity = this.#activity.project(type, data, run.id, at);
    const projectedData =
      activity && data && typeof data === "object" && !Array.isArray(data)
        ? { ...(data as Record<string, unknown>), activity }
        : activity
          ? { value: data, activity }
          : data;
    const event: AgentRunEvent = {
      id: String(sequence),
      sequence,
      sessionId: session.id,
      runId: run.id,
      type,
      at,
      data: sanitizeAgentPayload(projectedData, knownSecrets)
    };
    this.#sessions.updateRun(session.id, run);
    const persisted = this.#sessions.appendRunEvent(session.id, run.id, event);
    if (!persisted) {
      run.events.push(event);
      this.#sessions.persist(session.id);
    }
    this.#auditEvent(
      "agent.trace_event",
      {
        eventType: type,
        eventId: event.id,
        sequence: event.sequence,
        data: summarizeTraceData(type, event.data)
      },
      { sessionId: session.id, runId: run.id, modelSlug: run.modelSlug, knownSecrets }
    );
    const subscribers = this.#subscribers.get(session.id);
    if (subscribers) {
      for (const subscriber of subscribers) {
        subscriber(event);
      }
    }
    return event;
  }

  #auditEvent(
    type: string,
    data: unknown,
    options: { sessionId?: string; runId?: string; modelSlug?: string; knownSecrets?: string[] } = {}
  ): void {
    this.#audit.append({
      type,
      provider: "openrouter",
      modelSlug: options.modelSlug,
      sessionId: options.sessionId,
      runId: options.runId,
      data,
      knownSecrets: options.knownSecrets
    });
  }
}

async function prepareApprovalData(
  runtime: RelaybaseRuntime,
  toolName: string,
  args: Record<string, unknown>,
  context: TuiAgentContext
): Promise<{ arguments: Record<string, unknown>; previewData: unknown }> {
  let boundArguments: Record<string, unknown>;
  try {
    boundArguments = await bindAgentToolApprovalState(toolName, args, runtime, context);
  } catch (error) {
    throw new AgentRuntimeError(
      "AGENT_APPROVAL_STATE_UNAVAILABLE",
      "Relaybase could not bind the current manifest revision required for approval.",
      {
        retryable: true,
        userAction: "Inspect the manifest target, then request a fresh approval preview.",
        detail: error
      }
    );
  }
  if (toolName === "apply_setup_plan" || (toolName === "setup_and_start_project" && args.phase === "apply_setup")) {
    try {
      const preview = await previewSetup({
        ...boundArguments,
        cwd: boundArguments.cwd ?? boundArguments.currentDirectory ?? context.currentCwd
      });
      return {
        arguments: { ...boundArguments, previewBinding: createSetupPreviewBinding(preview) },
        previewData: preview
      };
    } catch (error) {
      throw new AgentRuntimeError(
        "AGENT_APPROVAL_PREVIEW_UNAVAILABLE",
        "Relaybase could not create the exact setup preview required for approval.",
        {
          retryable: true,
          userAction: "Resolve setup detection diagnostics, then request a fresh approval preview.",
          detail: error
        }
      );
    }
  }
  return {
    arguments: boundArguments,
    previewData: await previewDataForApproval(toolName, boundArguments, context)
  };
}

async function previewDataForApproval(
  toolName: string,
  args: Record<string, unknown>,
  context: TuiAgentContext
): Promise<unknown> {
  if (toolName !== "apply_setup_plan" && !(toolName === "setup_and_start_project" && args.phase === "apply_setup")) {
    return undefined;
  }
  try {
    return await previewSetup({
      ...args,
      cwd: args.cwd ?? args.currentDirectory ?? context.currentCwd
    });
  } catch (error) {
    return {
      diagnostics: [
        {
          code: "AGENT_APPROVAL_PREVIEW_UNAVAILABLE",
          severity: "warning",
          message: "Setup write preview could not be generated for the approval.",
          detail: sanitizeAgentPayload(error)
        }
      ]
    };
  }
}

async function ensureApprovalTargetStillExists(
  runtime: RelaybaseRuntime,
  approval: AgentApproval,
  args: Record<string, unknown>
): Promise<void> {
  if (
    !["start_app", "stop_app", "restart_app", "export_logs", "open_project_or_app", "prove_app_health"].includes(
      approval.toolName ?? approval.action
    )
  ) {
    return;
  }
  const appId = stringOrUndefined(args.appId ?? approval.target);
  if (!appId) {
    return;
  }
  const app = await runtime.registry.get(appId);
  if (app) {
    return;
  }
  throw new AgentGatewayRequestError(
    409,
    "AGENT_APPROVAL_TARGET_UNAVAILABLE",
    "The recovered approval target no longer exists.",
    {
      retryable: false,
      detail: { approvalId: approval.id, appId },
      userAction: "Refresh app state and ask the Operator Agent to create a new approval for the current target."
    }
  );
}

function markdownThreadExport(input: {
  session: AgentSession;
  auditEvents: AgentAuditEvent[];
  generatedAt: string;
}): string {
  const { session, auditEvents, generatedAt } = input;
  const lines = [
    `# Relaybase Operator Agent Thread`,
    "",
    `- Thread: ${session.id}`,
    `- Title: ${session.title ?? "(untitled)"}`,
    `- Generated: ${generatedAt}`,
    `- Messages: ${session.messages.length}`,
    `- Runs: ${session.runs.length}`,
    `- Audit events: ${auditEvents.length}`,
    "",
    "## Summary",
    "",
    "```json",
    JSON.stringify(session.summary ?? {}, null, 2),
    "```",
    "",
    "## Messages",
    ""
  ];
  for (const message of session.messages) {
    lines.push(`### ${message.role} ${message.createdAt}`, "", message.content || "(empty)", "");
  }
  lines.push("## Runs", "");
  for (const run of session.runs) {
    lines.push(`### ${run.id}`, "", `- Status: ${run.status}`, `- Model: ${run.modelSlug ?? "(none)"}`);
    if (run.diagnostic) {
      lines.push(`- Diagnostic: ${run.diagnostic.code}`);
    }
    lines.push("");
  }
  lines.push("## Audit Events", "");
  for (const event of auditEvents) {
    lines.push(`- ${event.at} ${event.type}${event.runId ? ` (${event.runId})` : ""}`);
  }
  lines.push("");
  return lines.join("\n");
}

function approvalRuntimeAuditSummary(preview: AgentApproval["preview"]): Record<string, unknown> | undefined {
  if (!preview?.runtimeId && !preview?.runtimeLabel && !preview?.runtimeConfidence) {
    return undefined;
  }
  return {
    runtimeId: preview.runtimeId,
    runtimeLabel: preview.runtimeLabel,
    runtimeConfidence: preview.runtimeConfidence,
    portStrategyCandidates: preview.portStrategyCandidates,
    setupQuestionCount: preview.setupQuestions?.length
  };
}

export async function normalizeTuiContext(
  runtime: RelaybaseRuntime,
  raw: Partial<TuiAgentContext> | undefined
): Promise<TuiAgentContext> {
  const apps = await runtime.registry.list();
  const diagnostics = (raw?.diagnostics ?? []).map((diagnostic) => sanitizeAgentPayload(diagnostic)) as Array<
    Diagnostic | AgentDiagnostic
  >;
  const authorizedProjectRoots = normalizeAuthorizedProjectRoots(raw?.authorizedProjectRoots);
  return {
    ...(raw?.selectedPaneId ? { selectedPaneId: String(raw.selectedPaneId) } : {}),
    ...(raw?.selectedAppId ? { selectedAppId: String(raw.selectedAppId) } : {}),
    ...(raw?.selectedGroupId ? { selectedGroupId: String(raw.selectedGroupId) } : {}),
    ...(raw?.selectedComponentRole ? { selectedComponentRole: raw.selectedComponentRole } : {}),
    ...(raw?.currentRoute ? { currentRoute: String(raw.currentRoute) } : {}),
    ...(Number.isInteger(raw?.currentPage) ? { currentPage: Number(raw?.currentPage) } : {}),
    ...(raw?.currentCwd ? { currentCwd: String(raw.currentCwd) } : {}),
    ...(authorizedProjectRoots.length ? { authorizedProjectRoots } : {}),
    daemonHasZeroApps: raw?.daemonHasZeroApps ?? apps.length === 0,
    ...(raw?.setupWizardState ? { setupWizardState: raw.setupWizardState } : {}),
    ...(raw?.currentSetupPlanId ? { currentSetupPlanId: String(raw.currentSetupPlanId) } : {}),
    diagnostics,
    ...(raw?.terminalCapabilities
      ? {
          terminalCapabilities: sanitizeAgentPayload(
            raw.terminalCapabilities
          ) as TuiAgentContext["terminalCapabilities"]
        }
      : {})
  };
}

export async function canonicalProjectRootGrants(
  context: Pick<TuiAgentContext, "currentCwd" | "authorizedProjectRoots">
): Promise<AgentProjectRootGrant[]> {
  const candidates = [
    ...(validProjectRoot(context.currentCwd) ? [{ root: context.currentCwd, source: "tui_current_cwd" as const }] : []),
    ...normalizeAuthorizedProjectRoots(context.authorizedProjectRoots).map((root) => ({
      root,
      source: "user_selected_folder" as const
    }))
  ];
  const grants: AgentProjectRootGrant[] = [];
  const canonicalRoots = new Set<string>();
  for (const candidate of candidates) {
    try {
      const grant = await createCanonicalProjectRootGrant(candidate.root, candidate.source);
      const identity = process.platform === "win32" ? grant.canonicalRoot.toLowerCase() : grant.canonicalRoot;
      if (!canonicalRoots.has(identity)) {
        canonicalRoots.add(identity);
        grants.push(grant);
      }
    } catch {
      // Missing, stale, or non-directory roots never become inspection grants.
    }
  }
  return grants;
}

function normalizeAuthorizedProjectRoots(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== "string") {
      continue;
    }
    const root = candidate.trim();
    if (!validProjectRoot(root) || seen.has(root)) {
      continue;
    }
    seen.add(root);
    roots.push(root);
    if (roots.length === MAX_AUTHORIZED_PROJECT_ROOTS) {
      break;
    }
  }
  return roots;
}

function validProjectRoot(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_PROJECT_ROOT_LENGTH;
}

function diagnosticFromCredentialError(error: AgentCredentialError): AgentDiagnostic {
  return {
    id: `agent.credential.${error.code.toLowerCase()}`,
    severity: "error",
    code: error.code,
    message: error.message,
    checkedAt: new Date().toISOString(),
    userAction:
      error.code === "AGENT_CREDENTIAL_MISSING"
        ? "Connect OpenRouter from Settings > Agent > Provider."
        : "Retry the credential operation. Reconnect OpenRouter if the protected credential cannot be recovered."
  };
}

export function defaultAgentConfig(env: NodeJS.ProcessEnv = process.env, modelSource?: AgentModelSource): AgentConfig {
  const now = new Date().toISOString();
  const enabled = envBoolean(env[AGENT_ENABLED_ENV]);
  return {
    enabled,
    provider: defaultProviderConfig(env, modelSource),
    execution: DEFAULT_AGENT_EXECUTION_POLICY,
    toolAllowlist: relaybaseAgentToolNames(),
    toolAllowlistMode: "all_registered",
    approvalPolicy: "always_for_mutations",
    setupFileWritePolicy: "approval_required",
    allowBrowserOpen: false,
    allowCopyRoute: false,
    updatedAt: now
  };
}

function loadPersistedAgentConfig(
  defaults: AgentConfig,
  configPath: string | undefined
): {
  config: AgentConfig;
  managedCredentialState?: {
    verified: boolean;
    lastValidatedAt?: string;
    metadata?: SafeProviderCredentialMetadata;
  };
} {
  if (!configPath || !fs.existsSync(configPath)) {
    return { config: defaults };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown;
  } catch {
    return { config: defaults };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { config: defaults };
  }

  const persisted = raw as Record<string, unknown>;
  const provider =
    persisted.provider && typeof persisted.provider === "object" && !Array.isArray(persisted.provider)
      ? (persisted.provider as Record<string, unknown>)
      : {};
  const persistedAllowlist = Array.isArray(persisted.toolAllowlist)
    ? normalizedToolNames(persisted.toolAllowlist)
    : undefined;
  const persistedToolMode = persistedToolAllowlistMode(persisted.toolAllowlistMode, persistedAllowlist);
  const persistedBudgets = normalizedPersistedBudgets(persisted.budgets);

  const merged: AgentConfig = {
    ...defaults,
    ...(typeof persisted.enabled === "boolean" ? { enabled: persisted.enabled } : {}),
    execution: normalizeAgentExecutionPolicy(persisted.execution, defaults.execution),
    toolAllowlist: persistedToolMode === "all_registered" ? relaybaseAgentToolNames() : (persistedAllowlist ?? []),
    toolAllowlistMode: persistedToolMode,
    ...(persisted.approvalPolicy === "always_for_mutations" || persisted.approvalPolicy === "read_only_only"
      ? { approvalPolicy: persisted.approvalPolicy }
      : {}),
    ...(typeof persisted.allowBrowserOpen === "boolean" ? { allowBrowserOpen: persisted.allowBrowserOpen } : {}),
    ...(typeof persisted.allowCopyRoute === "boolean" ? { allowCopyRoute: persisted.allowCopyRoute } : {}),
    ...(persistedBudgets ? { budgets: persistedBudgets } : {}),
    ...(typeof persisted.updatedAt === "string" && persisted.updatedAt.trim()
      ? { updatedAt: persisted.updatedAt }
      : {}),
    provider: {
      ...defaults.provider,
      ...(typeof provider.modelSlug === "string" && provider.modelSlug.trim()
        ? {
            modelSlug: provider.modelSlug.trim(),
            modelSource: { kind: "persisted_config", label: "saved Agent configuration" } as const
          }
        : {}),
      ...(typeof provider.remoteModelEnabled === "boolean" ? { remoteModelEnabled: provider.remoteModelEnabled } : {}),
      ...(typeof provider.httpRefererEnvVar === "string" && provider.httpRefererEnvVar.trim()
        ? { httpRefererEnvVar: provider.httpRefererEnvVar.trim() }
        : {}),
      ...(typeof provider.titleEnvVar === "string" && provider.titleEnvVar.trim()
        ? { titleEnvVar: provider.titleEnvVar.trim() }
        : {}),
      apiKeySource:
        provider.apiKeySourceType === "managed_windows_dpapi" &&
        typeof provider.credentialId === "string" &&
        provider.credentialId.trim()
          ? {
              type: "managed_windows_dpapi",
              credentialId: provider.credentialId.trim(),
              configured: true
            }
          : {
              type: "environment",
              envVar:
                typeof provider.apiKeyEnvVar === "string" && provider.apiKeyEnvVar.trim()
                  ? provider.apiKeyEnvVar.trim()
                  : (defaults.provider.apiKeySource.envVar ?? DEFAULT_OPENROUTER_KEY_ENV),
              configured: false
            }
    }
  };

  // Explicit shell or .env values are authoritative over the persisted control-plane defaults.
  if (Object.prototype.hasOwnProperty.call(process.env, AGENT_ENABLED_ENV)) {
    merged.enabled = defaults.enabled;
  }
  if (Object.prototype.hasOwnProperty.call(process.env, AGENT_REMOTE_MODEL_ENABLED_ENV)) {
    merged.provider.remoteModelEnabled = defaults.provider.remoteModelEnabled;
  }
  if (Object.prototype.hasOwnProperty.call(process.env, AGENT_MODEL_ENV)) {
    if (defaults.provider.modelSlug) {
      merged.provider.modelSlug = defaults.provider.modelSlug;
    } else {
      delete merged.provider.modelSlug;
    }
  }
  return {
    config: merged,
    ...(merged.provider.apiKeySource.type === "managed_windows_dpapi"
      ? { managedCredentialState: persistedManagedCredentialState(provider.credentialState) }
      : {})
  };
}

function persistedManagedCredentialState(value: unknown): {
  verified: boolean;
  lastValidatedAt?: string;
  metadata?: SafeProviderCredentialMetadata;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { verified: false };
  }
  const state = value as Record<string, unknown>;
  const metadataValue =
    state.metadata && typeof state.metadata === "object" && !Array.isArray(state.metadata)
      ? (state.metadata as Record<string, unknown>)
      : {};
  const metadata: SafeProviderCredentialMetadata = {};
  if (
    typeof metadataValue.keyLabel === "string" &&
    metadataValue.keyLabel.trim() &&
    !/sk-or-|bearer|authorization|api[_-]?key\s*[:=]/i.test(metadataValue.keyLabel)
  ) {
    metadata.keyLabel = metadataValue.keyLabel.trim().slice(0, 80);
  }
  if (typeof metadataValue.limitUsd === "number" && Number.isFinite(metadataValue.limitUsd)) {
    metadata.limitUsd = metadataValue.limitUsd;
  }
  if (typeof metadataValue.limitRemainingUsd === "number" && Number.isFinite(metadataValue.limitRemainingUsd)) {
    metadata.limitRemainingUsd = metadataValue.limitRemainingUsd;
  }
  if (
    metadataValue.limitReset === "daily" ||
    metadataValue.limitReset === "weekly" ||
    metadataValue.limitReset === "monthly" ||
    metadataValue.limitReset === null
  ) {
    metadata.limitReset = metadataValue.limitReset;
  }
  if (typeof metadataValue.expiresAt === "string" || metadataValue.expiresAt === null) {
    metadata.expiresAt = metadataValue.expiresAt;
  }
  return {
    verified: state.verified === true,
    ...(typeof state.lastValidatedAt === "string" && state.lastValidatedAt
      ? { lastValidatedAt: state.lastValidatedAt }
      : {}),
    ...(Object.keys(metadata).length ? { metadata } : {})
  };
}

function normalizedPersistedBudgets(value: unknown): AgentConfig["budgets"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const input = value as Record<string, unknown>;
  const output: NonNullable<AgentConfig["budgets"]> = {};
  for (const key of ["dailyLimitUsd", "monthlyLimitUsd", "sessionLimitUsd"] as const) {
    const amount = input[key];
    if (typeof amount === "number" && Number.isFinite(amount) && amount >= 0) {
      output[key] = amount;
    }
  }
  return Object.keys(output).length ? output : undefined;
}

function defaultProviderConfig(
  env: NodeJS.ProcessEnv = process.env,
  modelSource?: AgentModelSource
): AgentProviderConfig {
  const modelSlug = nonEmptyString(env[AGENT_MODEL_ENV], "");
  const remoteModelEnabled = envBoolean(env[AGENT_REMOTE_MODEL_ENABLED_ENV]);
  return {
    provider: "openrouter",
    ...(modelSlug ? { modelSlug } : {}),
    modelSource: modelSlug
      ? (modelSource ?? { kind: "shell_environment", label: "shell environment" })
      : { kind: "unconfigured", label: "not configured" },
    apiKeySource: {
      type: "environment",
      envVar: DEFAULT_OPENROUTER_KEY_ENV,
      configured: Boolean(env[DEFAULT_OPENROUTER_KEY_ENV])
    },
    httpRefererEnvVar: "OPENROUTER_HTTP_REFERER",
    titleEnvVar: "OPENROUTER_TITLE",
    remoteModelEnabled
  };
}

function normalizedToolNames(value: readonly unknown[]): string[] {
  return [
    ...new Set(
      value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean)
    )
  ];
}

function persistedToolAllowlistMode(value: unknown, allowlist: string[] | undefined): AgentConfig["toolAllowlistMode"] {
  if (value === "all_registered" || value === "explicit_allowlist") {
    return value;
  }
  if (
    !allowlist ||
    sameToolSet(allowlist, LEGACY_DEFAULT_TOOL_ALLOWLIST) ||
    sameToolSet(allowlist, relaybaseAgentToolNames())
  ) {
    return "all_registered";
  }
  return "explicit_allowlist";
}

function sameToolSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry) => right.includes(entry));
}

function envBoolean(value: string | undefined): boolean {
  switch (
    String(value ?? "")
      .trim()
      .toLowerCase()
  ) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    default:
      return false;
  }
}

function containsRawApiKey(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsRawApiKey(entry));
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (normalized === "apikey" || normalized === "openrouterapikey" || normalized === "rawkey") {
      return true;
    }
    if (containsRawApiKey(nested)) {
      return true;
    }
  }
  return false;
}

function normalizeIdempotencyKey(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new AgentGatewayRequestError(
      400,
      "AGENT_IDEMPOTENCY_KEY_INVALID",
      "Agent submission idempotency keys must be strings.",
      { retryable: false, userAction: "Send a stable string idempotency key no longer than 200 characters." }
    );
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > 200 || hasControlCharacter(normalized)) {
    throw new AgentGatewayRequestError(
      400,
      "AGENT_IDEMPOTENCY_KEY_INVALID",
      "Agent submission idempotency key is empty, too long, or contains control characters.",
      { retryable: false, userAction: "Send a stable printable idempotency key no longer than 200 characters." }
    );
  }
  return normalized;
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function submissionFingerprint(content: string, context: TuiAgentContext | undefined): string {
  return stableArgumentsHash({ content, context: sanitizeAgentPayload(context ?? {}) });
}

function cancelledRunDiagnostic(): AgentDiagnostic {
  return {
    id: "agent.run.cancelled",
    severity: "warning",
    code: "AGENT_RUN_CANCELLED",
    message: "Operator Agent run was cancelled before completion.",
    checkedAt: new Date().toISOString(),
    userAction: "Retry the run if the request is still needed."
  };
}

function interruptedRunDiagnostic(status: AgentRun["status"], missingApproval: boolean): AgentDiagnostic {
  return {
    id: `agent.run.interrupted.${status}`,
    severity: "error",
    code: missingApproval ? "AGENT_APPROVAL_STATE_MISSING" : "AGENT_RUN_INTERRUPTED",
    message: missingApproval
      ? "Agent run was waiting for approval, but no recoverable pending approval remains."
      : `Agent run was ${status} when the Agent Gateway restarted and cannot be resumed safely.`,
    checkedAt: new Date().toISOString(),
    userAction: "Retry the run to create a fresh provider request and approval state."
  };
}

function nonEmptyString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

function stringOrUndefined(value: unknown): string | undefined {
  const text = nonEmptyString(value, "");
  return text || undefined;
}

function summarizeUserIntent(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return redactAgentText(normalized.length > 160 ? `${normalized.slice(0, 160)}...` : normalized);
}

function limitExceeded(
  scope: "session" | "daily" | "monthly",
  current: number,
  limit: number | undefined
): { scope: "session" | "daily" | "monthly"; current: number; limit: number } | undefined {
  if (limit === undefined) {
    return undefined;
  }
  return current >= limit ? { scope, current, limit } : undefined;
}

function usageCost(data: unknown): number {
  const usage = data && typeof data === "object" ? (data as { usage?: unknown }).usage : undefined;
  const record = usage && typeof usage === "object" ? (usage as Record<string, unknown>) : {};
  for (const value of [record.costUsd, record.estimatedCostUsd]) {
    const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
    if (typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return 0;
}

function budgetReservationUsd(budgets: AgentConfig["budgets"]): number {
  if (!budgets) {
    return 0;
  }
  const limits = [budgets.sessionLimitUsd, budgets.dailyLimitUsd, budgets.monthlyLimitUsd].filter(
    (limit): limit is number => typeof limit === "number" && Number.isFinite(limit) && limit > 0
  );
  if (!limits.length) {
    return 0;
  }
  return Math.min(0.05, Math.min(...limits) / 2);
}

function summarizeTraceData(type: AgentRunEventType, data: unknown): unknown {
  if (type === "model.delta") {
    return { streamed: true };
  }
  if (type === "answer") {
    const content =
      data && typeof data === "object" && typeof (data as { content?: unknown }).content === "string"
        ? (data as { content: string }).content
        : "";
    return { kind: "answer", contentLength: content.length };
  }
  if (data && typeof data === "object" && "result" in data) {
    return { ...(data as Record<string, unknown>), result: summarizeToolResult((data as { result?: unknown }).result) };
  }
  return sanitizeAgentPayload(data);
}

function summarizeToolResult(result: unknown): unknown {
  if (!result || typeof result !== "object") {
    return sanitizeAgentPayload(result);
  }
  const record = result as Record<string, unknown>;
  const data = record.data && typeof record.data === "object" ? (record.data as Record<string, unknown>) : undefined;
  return sanitizeAgentPayload({
    tool: record.tool,
    status: record.status,
    operationId: record.operationId,
    setupPlanId: record.setupPlanId,
    repairPlanId: record.repairPlanId,
    next: record.next,
    diagnostic: record.diagnostic,
    dataSummary: data
      ? {
          keys: Object.keys(data),
          exportId: nestedText(data.export, "exportId"),
          selectedPlanId: nestedText(data.selectedPlan, "id"),
          manifestPath: nestedText(data.manifestPatchPlan, "manifestPath")
        }
      : undefined
  });
}

function nestedText(value: unknown, key: string): string | undefined {
  return value && typeof value === "object" && typeof (value as Record<string, unknown>)[key] === "string"
    ? String((value as Record<string, unknown>)[key])
    : undefined;
}
