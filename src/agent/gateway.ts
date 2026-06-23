import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { RelaybaseRuntime } from "../server.ts";
import type { Diagnostic } from "../apiTypes.ts";
import { buildApprovalPreview } from "./approvalPresenter.ts";
import { ApprovalStore } from "./approvalStore.ts";
import { AgentAuditStore } from "./auditStore.ts";
import { previewSetup } from "../setupApi.ts";
import {
  diagnosticsForAgentConfig,
  mergeRedactionReport,
  redactAgentText,
  sanitizeAgentPayload,
  sanitizeAgentPayloadWithReport
} from "./errors.ts";
import type { AgentRuntimeEvent } from "./events.ts";
import { evaluateToolPolicy, stableArgumentsHash, userMessageGuardrail } from "./policy.ts";
import { OperatorAgentRuntime } from "./runtime.ts";
import { AgentSessionStore } from "./sessionStore.ts";
import { executeRelaybaseAgentTool } from "./tools/index.ts";
import type {
  AgentApproval,
  AgentAuditEvent,
  AgentConfig,
  AgentConfigUpdate,
  AgentDiagnostic,
  AgentMessage,
  AgentMessageRequest,
  AgentProviderConfig,
  AgentRun,
  AgentRunEvent,
  AgentRunEventType,
  AgentSession,
  AgentSessionCreateRequest,
  AgentSessionExportRequest,
  AgentSessionExportResult,
  AgentThreadContextPreview,
  AgentThreadUpdateRequest,
  AgentUsage,
  TuiAgentContext
} from "./types.ts";

const DEFAULT_OPENROUTER_KEY_ENV = "OPENROUTER_API_KEY";
const AGENT_ENABLED_ENV = "RELAYBASE_AGENT_ENABLED";
const AGENT_REMOTE_MODEL_ENABLED_ENV = "RELAYBASE_AGENT_REMOTE_MODEL_ENABLED";
const AGENT_MODEL_ENV = "RELAYBASE_AGENT_MODEL";
const DEFAULT_TOOL_ALLOWLIST = [
  "list_apps",
  "get_app_state",
  "get_app_group",
  "get_diagnostics",
  "tail_logs",
  "search_logs",
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

type AgentSubscriber = (event: AgentRunEvent) => void;

export interface AgentGatewayServiceOptions {
  agentRuntime?: OperatorAgentRuntime;
  sessionStore?: AgentSessionStore;
  approvalStore?: ApprovalStore;
  auditStore?: AgentAuditStore;
  stateDir?: string;
}

export class AgentGatewayService {
  #config: AgentConfig = defaultAgentConfig();
  #sessions: AgentSessionStore;
  #agentRuntime: OperatorAgentRuntime;
  #approvals: ApprovalStore;
  #audit: AgentAuditStore;
  #stateDir?: string;
  #subscribers = new Map<string, Set<AgentSubscriber>>();
  #sequence = 0;
  #budgetReservations = new Map<string, { sessionId: string; estimatedUsd: number; createdAt: string }>();

  constructor(options: AgentGatewayServiceOptions = {}) {
    this.#stateDir = options.stateDir;
    this.#sessions = options.sessionStore ?? new AgentSessionStore({ stateDir: options.stateDir });
    this.#agentRuntime = options.agentRuntime ?? new OperatorAgentRuntime();
    this.#audit = options.auditStore ?? new AgentAuditStore({ stateDir: options.stateDir });
    this.#approvals = options.approvalStore ?? new ApprovalStore({ threadStore: this.#sessions.threadStore() });
    this.#sequence = this.#sessions.maxEventSequence();
    for (const approval of this.#approvals.recoverPending()) {
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
  }

  getConfig(): AgentConfig {
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
          userAction: "Set OPENROUTER_API_KEY in the daemon environment and reference that env var in config."
        }
      );
    }

    const update = raw as AgentConfigUpdate;
    const now = new Date().toISOString();
    this.#config = {
      ...this.#config,
      ...(typeof update.enabled === "boolean" ? { enabled: update.enabled } : {}),
      ...(Array.isArray(update.toolAllowlist) ? { toolAllowlist: update.toolAllowlist.map(String) } : {}),
      ...(update.approvalPolicy ? { approvalPolicy: update.approvalPolicy } : {}),
      ...(typeof update.allowBrowserOpen === "boolean" ? { allowBrowserOpen: update.allowBrowserOpen } : {}),
      ...(typeof update.allowCopyRoute === "boolean" ? { allowCopyRoute: update.allowCopyRoute } : {}),
      ...(update.budgets ? { budgets: sanitizeAgentPayload(update.budgets) as AgentConfig["budgets"] } : {}),
      provider: {
        ...this.#config.provider,
        ...(update.provider?.modelSlug !== undefined
          ? { modelSlug: stringOrUndefined(update.provider.modelSlug) }
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
    this.#auditEvent("agent.config_updated", { config: this.#safeConfig() });
    return this.#safeConfig();
  }

  async diagnostics(runtime: RelaybaseRuntime): Promise<AgentDiagnostic[]> {
    return [
      ...this.#configDiagnostics(),
      {
        id: "agent.runtime.ready",
        severity: "info",
        code: "AGENT_RUNTIME_READY",
        message: "Relaybase Operator Agent runtime is available when OpenRouter config is enabled.",
        checkedAt: new Date().toISOString(),
        userAction:
          "Enable the agent, configure an OpenRouter model slug, and set the configured API key environment variable before sending model requests."
      },
      {
        id: "agent.daemon.state",
        severity: "info",
        code: "AGENT_DAEMON_READY",
        message: "Agent Gateway can read Relaybase daemon context.",
        checkedAt: new Date().toISOString(),
        detail: { stateDir: runtime.stateDir }
      },
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
    raw: AgentMessageRequest
  ): Promise<{ message: AgentMessage; run: AgentRun; diagnostics: AgentDiagnostic[] }> {
    const session = this.getSession(sessionId);
    const now = new Date().toISOString();
    const content = nonEmptyString(raw.content, "");
    if (!content) {
      throw new AgentGatewayRequestError(400, "AGENT_MESSAGE_REQUIRED", "Agent message content is required.", {
        retryable: false,
        userAction: "Send a non-empty message."
      });
    }

    const context = await normalizeTuiContext(runtime, raw.context ?? session.context);
    const config = this.#safeConfig();
    const knownSecrets = [process.env[config.provider.apiKeySource.envVar] ?? "", runtime.token].filter(
      (secret) => secret.length > 0
    );
    const draftMessage: AgentMessage = {
      id: randomUUID(),
      sessionId,
      role: "user",
      content: redactAgentText(content, knownSecrets),
      createdAt: now,
      context
    };
    const draftRun: AgentRun = {
      id: randomUUID(),
      sessionId,
      status: "running",
      provider: "openrouter",
      modelSlug: config.provider.modelSlug,
      createdAt: now,
      startedAt: now,
      events: []
    };
    draftMessage.runId = draftRun.id;
    const message = this.#sessions.appendMessage(sessionId, draftMessage) ?? draftMessage;
    const run = this.#sessions.appendRun(sessionId, draftRun) ?? draftRun;
    this.#sessions.updateContext(sessionId, context);
    const threadContext = this.threadContextPreview(sessionId);

    this.#publishRunEvent(session, run, "run.started", {
      runId: run.id,
      provider: "openrouter",
      modelSlug: config.provider.modelSlug ?? null
    });

    const inputDiagnostic = userMessageGuardrail(content);
    if (inputDiagnostic) {
      run.status = "failed";
      run.diagnostic = inputDiagnostic;
      run.completedAt = new Date().toISOString();
      this.#publishRunEvent(session, run, "diagnostic", inputDiagnostic, knownSecrets);
      this.#publishRunEvent(session, run, "blocked", { kind: "blocked", diagnostic: inputDiagnostic }, knownSecrets);
      this.#publishRunEvent(
        session,
        run,
        "run.failed",
        {
          diagnostic: inputDiagnostic,
          modelOutputProduced: false
        },
        knownSecrets
      );
      this.#auditEvent(
        "agent.run_blocked",
        {
          sessionId,
          runId: run.id,
          userIntentSummary: summarizeUserIntent(content),
          diagnostic: inputDiagnostic
        },
        { sessionId, runId: run.id, modelSlug: config.provider.modelSlug, knownSecrets }
      );
      return { message, run, diagnostics: [inputDiagnostic] };
    }

    const diagnostics = this.#configDiagnostics();
    const blockingDiagnostic = diagnostics.find((diagnostic) => diagnostic.severity === "error");
    if (blockingDiagnostic) {
      run.status = "failed";
      run.diagnostic = blockingDiagnostic;
      run.completedAt = new Date().toISOString();
      this.#publishRunEvent(session, run, "diagnostic", blockingDiagnostic, knownSecrets);
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
      this.#auditEvent(
        "agent.run_blocked",
        {
          sessionId,
          runId: run.id,
          userIntentSummary: summarizeUserIntent(content),
          diagnostic: blockingDiagnostic
        },
        { sessionId, runId: run.id, modelSlug: config.provider.modelSlug, knownSecrets }
      );

      return { message, run, diagnostics: [blockingDiagnostic] };
    }

    const budgetDiagnostic = this.#reserveBudget(config, sessionId, run.id);
    if (budgetDiagnostic) {
      run.status = "failed";
      run.diagnostic = budgetDiagnostic;
      run.completedAt = new Date().toISOString();
      this.#publishRunEvent(session, run, "diagnostic", budgetDiagnostic, knownSecrets);
      this.#publishRunEvent(session, run, "blocked", { kind: "blocked", diagnostic: budgetDiagnostic }, knownSecrets);
      this.#publishRunEvent(
        session,
        run,
        "run.failed",
        {
          diagnostic: budgetDiagnostic,
          modelOutputProduced: false
        },
        knownSecrets
      );
      this.#auditEvent(
        "agent.budget_blocked",
        {
          sessionId,
          runId: run.id,
          userIntentSummary: summarizeUserIntent(content),
          diagnostic: budgetDiagnostic
        },
        { sessionId, runId: run.id, modelSlug: config.provider.modelSlug, knownSecrets }
      );
      return { message, run, diagnostics: [budgetDiagnostic] };
    }

    let result: Awaited<ReturnType<OperatorAgentRuntime["execute"]>>;
    try {
      this.#auditEvent(
        "agent.run_requested",
        {
          sessionId,
          runId: run.id,
          userIntentSummary: summarizeUserIntent(content)
        },
        { sessionId, runId: run.id, modelSlug: config.provider.modelSlug, knownSecrets }
      );

      result = await this.#agentRuntime.execute({
        relaybase: runtime,
        config,
        session,
        message,
        run,
        context,
        threadContext,
        knownSecrets,
        emit: (event: AgentRuntimeEvent) => {
          this.#publishRunEvent(session, run, event.type, event.data, knownSecrets);
        }
      });
    } finally {
      this.#releaseBudget(run.id);
    }

    if (result.status === "waiting_for_approval") {
      run.status = "waiting_for_approval";
      const approvals: AgentApproval[] = [];
      for (const pending of result.pendingApprovals ?? []) {
        const approval = await this.#createPendingApproval(runtime, session, run, pending, context, knownSecrets);
        approvals.push(approval);
      }
      this.#auditEvent(
        "agent.run_waiting_for_approval",
        {
          sessionId,
          runId: run.id,
          userIntentSummary: summarizeUserIntent(content),
          approvals
        },
        { sessionId, runId: run.id, modelSlug: config.provider.modelSlug, knownSecrets }
      );
      return { message, run, diagnostics: result.diagnostics };
    }

    if (result.status === "completed") {
      run.status = "completed";
      run.completedAt = new Date().toISOString();
      run.usage = result.usage;
      if (result.assistantContent) {
        this.#sessions.appendMessage(sessionId, {
          id: randomUUID(),
          sessionId,
          runId: run.id,
          role: "assistant",
          content: redactAgentText(result.assistantContent, knownSecrets),
          createdAt: run.completedAt
        });
      }
      if (result.usage) {
        this.#recordUsage(config, sessionId, run.id, result.usage, knownSecrets);
      }
      this.#publishRunEvent(
        session,
        run,
        "run.completed",
        {
          modelOutputProduced: true,
          toolNames: result.toolNames
        },
        knownSecrets
      );
      this.#auditEvent(
        "agent.run_completed",
        {
          sessionId,
          runId: run.id,
          userIntentSummary: summarizeUserIntent(content),
          modelSlug: config.provider.modelSlug,
          toolNames: result.toolNames,
          usage: result.usage
        },
        { sessionId, runId: run.id, modelSlug: config.provider.modelSlug, knownSecrets }
      );
      return { message, run, diagnostics: result.diagnostics };
    }

    const diagnostic = result.diagnostics[0];
    run.status = "failed";
    run.completedAt = new Date().toISOString();
    if (diagnostic) {
      run.diagnostic = diagnostic;
    }
    this.#publishRunEvent(
      session,
      run,
      "run.failed",
      {
        diagnostic: diagnostic ?? null,
        modelOutputProduced: false
      },
      knownSecrets
    );
    this.#auditEvent(
      "agent.run_failed",
      {
        sessionId,
        runId: run.id,
        userIntentSummary: summarizeUserIntent(content),
        diagnostics: result.diagnostics
      },
      { sessionId, runId: run.id, modelSlug: config.provider.modelSlug, knownSecrets }
    );
    return { message, run, diagnostics: result.diagnostics };
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
      const savedArguments = this.#approvals.rawArguments(approval.id) ?? approval.arguments;
      const decision = evaluateToolPolicy(approval.toolName ?? approval.action, savedArguments);
      const configDiagnostic = this.#toolConfigDiagnostic(config, approval.toolName ?? approval.action, decision);
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
      await ensureApprovalTargetStillExists(runtime, approval, savedArguments);
    }
    if (status === "approved") {
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
    const knownSecrets = [process.env[config.provider.apiKeySource.envVar] ?? "", runtime.token].filter(
      (secret) => secret.length > 0
    );
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
      if (run) {
        const diagnostic = {
          id: `agent.approval.${approvalId}.rejected`,
          severity: "warning" as const,
          code: "AGENT_APPROVAL_REJECTED",
          message: "The user rejected the tool approval. The tool was not executed.",
          checkedAt: new Date().toISOString(),
          userAction: "Ask for a new approval if the action is still desired."
        };
        run.status = "cancelled";
        run.completedAt = new Date().toISOString();
        run.diagnostic = diagnostic;
        this.#publishRunEvent(
          session,
          run,
          "action_result",
          {
            kind: "action_result",
            status: "rejected",
            approvalId,
            diagnostic
          },
          knownSecrets
        );
        this.#publishRunEvent(
          session,
          run,
          "run.failed",
          {
            diagnostic,
            modelOutputProduced: false
          },
          knownSecrets
        );
      }
      this.#auditEvent(
        "agent.approval_rejected",
        { approval: resolved, reason: raw.reason },
        { sessionId: session.id, runId: run?.id, modelSlug: run?.modelSlug, knownSecrets }
      );
      return resolved;
    }

    if (run) {
      await this.#executeApprovedTool(runtime, session, run, resolved, knownSecrets);
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
    const decision = evaluateToolPolicy(pending.toolName, pending.arguments);
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
        arguments: sanitizeAgentPayload(pending.arguments, knownSecrets) as Record<string, unknown>,
        argumentsHash: stableArgumentsHash(pending.arguments),
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
    const previewData = await previewDataForApproval(pending.toolName, pending.arguments, context);
    const preview = await buildApprovalPreview({
      runtime,
      policy,
      arguments: pending.arguments,
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
        arguments: sanitizeAgentPayload(pending.arguments, knownSecrets) as Record<string, unknown>,
        argumentsHash: stableArgumentsHash(pending.arguments),
        context,
        preview
      },
      pending.arguments
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
    const result = await executeRelaybaseAgentTool(toolName, savedArguments, {
      runtime,
      tuiContext: approval.context ?? session.context ?? { daemonHasZeroApps: false, diagnostics: [] },
      config: this.#safeConfig(),
      approved: true,
      correlationId: approval.id,
      emit: (event) => this.#publishRunEvent(session, run, event.type, event.data, knownSecrets)
    });
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
    run.status = result.status === "succeeded" ? "completed" : "failed";
    run.completedAt = new Date().toISOString();
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
    this.#publishRunEvent(
      session,
      run,
      result.status === "succeeded" ? "run.completed" : "run.failed",
      {
        approvalId: approval.id,
        toolName,
        toolResultProduced: true,
        result
      },
      knownSecrets
    );
    this.#auditEvent(
      result.status === "succeeded" ? "agent.tool_completed" : "agent.tool_failed",
      {
        approvalId: approval.id,
        toolName,
        result: summarizeToolResult(result)
      },
      { sessionId: session.id, runId: run.id, modelSlug: run.modelSlug, knownSecrets }
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
    const configured = Boolean(process.env[this.#config.provider.apiKeySource.envVar]);
    return {
      ...this.#config,
      provider: {
        ...this.#config.provider,
        apiKeySource: {
          ...this.#config.provider.apiKeySource,
          configured
        }
      }
    };
  }

  #configDiagnostics(): AgentDiagnostic[] {
    return diagnosticsForAgentConfig(this.#safeConfig());
  }

  #publishRunEvent(
    session: AgentSession,
    run: AgentRun,
    type: AgentRunEventType,
    data: unknown,
    knownSecrets: string[] = []
  ): AgentRunEvent {
    const event: AgentRunEvent = {
      id: randomUUID(),
      sequence: ++this.#sequence,
      sessionId: session.id,
      runId: run.id,
      type,
      at: new Date().toISOString(),
      data: sanitizeAgentPayload(data, knownSecrets)
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
  return {
    ...(raw?.selectedPaneId ? { selectedPaneId: String(raw.selectedPaneId) } : {}),
    ...(raw?.selectedAppId ? { selectedAppId: String(raw.selectedAppId) } : {}),
    ...(raw?.selectedGroupId ? { selectedGroupId: String(raw.selectedGroupId) } : {}),
    ...(raw?.selectedComponentRole ? { selectedComponentRole: raw.selectedComponentRole } : {}),
    ...(raw?.currentRoute ? { currentRoute: String(raw.currentRoute) } : {}),
    ...(Number.isInteger(raw?.currentPage) ? { currentPage: Number(raw?.currentPage) } : {}),
    ...(raw?.currentCwd ? { currentCwd: String(raw.currentCwd) } : {}),
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

export function defaultAgentConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const now = new Date().toISOString();
  return {
    enabled: envBoolean(env[AGENT_ENABLED_ENV]),
    provider: defaultProviderConfig(env),
    toolAllowlist: [...DEFAULT_TOOL_ALLOWLIST],
    approvalPolicy: "always_for_mutations",
    setupFileWritePolicy: "approval_required",
    allowBrowserOpen: false,
    allowCopyRoute: false,
    updatedAt: now
  };
}

function defaultProviderConfig(env: NodeJS.ProcessEnv = process.env): AgentProviderConfig {
  const modelSlug = nonEmptyString(env[AGENT_MODEL_ENV], "");
  return {
    provider: "openrouter",
    ...(modelSlug ? { modelSlug } : {}),
    apiKeySource: {
      type: "environment",
      envVar: DEFAULT_OPENROUTER_KEY_ENV,
      configured: Boolean(env[DEFAULT_OPENROUTER_KEY_ENV])
    },
    httpRefererEnvVar: "OPENROUTER_HTTP_REFERER",
    titleEnvVar: "OPENROUTER_TITLE",
    remoteModelEnabled: envBoolean(env[AGENT_REMOTE_MODEL_ENABLED_ENV])
  };
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
  const value = record.estimatedCostUsd;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
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
