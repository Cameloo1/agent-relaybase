import { randomUUID } from "node:crypto";
import type {
  AgentSecurityFinding,
  AgentSecurityRepairActionId,
  AgentSecurityRepairActionPreview,
  AgentSecurityRepairOperation,
  AgentSecurityRepairPreview,
  AgentSecurityStatus
} from "./types.ts";
import { AgentSecurityDoctor } from "./securityDoctor.ts";
import { AgentSecurityRepairJournal, type AgentSecurityRepairBinding } from "./securityRepairJournal.ts";

const PREVIEW_TTL_MS = 10 * 60 * 1000;

export class AgentSecurityRepairError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly userAction: string;

  constructor(statusCode: number, code: string, message: string, userAction: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.userAction = userAction;
  }
}

export interface AgentSecurityRepairDependencies {
  doctor: AgentSecurityDoctor;
  journal: AgentSecurityRepairJournal;
  binding(): AgentSecurityRepairBinding;
  refreshManagedCredentialState(): Promise<void>;
  clearStaleProviderConnection(): void;
  repairCredentialAcl(): Promise<void>;
  validateManagedCredential(): Promise<void>;
  migrateLegacyCredential(): Promise<void>;
  removeLegacyExternalAssignment(): Promise<void>;
  disconnectLocalCredential(): Promise<void>;
  openProviderKeyManagement(): Promise<void>;
  reloadSelectedAgentConfig(): Promise<void>;
  audit(
    type: string,
    data: {
      previewId?: string;
      operationId?: string;
      actionIds?: AgentSecurityRepairActionId[];
      outcome?: string;
      issueCodes?: string[];
    }
  ): void;
  now?: () => Date;
}

export class AgentSecurityRepairService {
  readonly #dependencies: AgentSecurityRepairDependencies;
  #applying = false;

  constructor(dependencies: AgentSecurityRepairDependencies) {
    this.#dependencies = dependencies;
  }

  diagnose(options: { online?: boolean } = {}): Promise<AgentSecurityStatus> {
    return this.#dependencies.doctor.diagnose(options);
  }

  async preview(input: {
    actionIds?: AgentSecurityRepairActionId[];
    issueCodes?: string[];
    safe?: boolean;
    online?: boolean;
  }): Promise<AgentSecurityRepairPreview> {
    const status = await this.diagnose({ online: input.online });
    const selectedFindings = input.issueCodes?.length
      ? status.findings.filter((finding) => input.issueCodes!.includes(finding.code))
      : status.findings.filter((finding) => finding.state !== "healthy");
    const requested = new Set<AgentSecurityRepairActionId>(input.actionIds ?? []);
    if (input.safe) {
      for (const finding of selectedFindings) {
        if (finding.recommendedActionId && actionDefinition(finding.recommendedActionId).riskClass === "safe_local") {
          requested.add(finding.recommendedActionId);
        }
      }
    }
    if (requested.size === 0 && selectedFindings.length === 1 && selectedFindings[0]?.recommendedActionId) {
      requested.add(selectedFindings[0].recommendedActionId);
    }
    if (requested.size === 0) {
      throw new AgentSecurityRepairError(
        409,
        "AGENT_SECURITY_REPAIR_ACTION_REQUIRED",
        "No applicable Agent security repair action was selected.",
        "Select one finding/action, or use the safe repair group when it is available."
      );
    }

    const applicable = new Set(
      status.findings.flatMap((finding) => [
        ...(finding.recommendedActionId ? [finding.recommendedActionId] : []),
        ...(finding.alternateActionIds ?? [])
      ])
    );
    for (const actionId of requested) {
      if (!applicable.has(actionId)) {
        throw new AgentSecurityRepairError(
          409,
          "AGENT_SECURITY_REPAIR_ACTION_NOT_APPLICABLE",
          `Agent security repair action ${actionId} is not applicable to the current state.`,
          "Run a fresh diagnosis and select one of the returned actions."
        );
      }
      if (input.safe && actionDefinition(actionId).riskClass !== "safe_local") {
        throw new AgentSecurityRepairError(
          400,
          "AGENT_SECURITY_REPAIR_SAFE_SCOPE_INVALID",
          "The safe repair group cannot include guarded, destructive, external, or manual actions.",
          "Preview the requested non-safe action explicitly."
        );
      }
    }

    const actions = [...requested].map(actionDefinition);
    const createdAtDate = this.#dependencies.now?.() ?? new Date();
    const createdAt = createdAtDate.toISOString();
    const expiresAt = new Date(createdAtDate.getTime() + PREVIEW_TTL_MS).toISOString();
    const preview: AgentSecurityRepairPreview = {
      previewId: randomUUID(),
      scope: "agent-security",
      createdAt,
      expiresAt,
      findings: status.findings.filter((finding) => findingMatchesAction(finding, requested)),
      actions,
      confirmation: confirmationFor(actions),
      expectedConfigRevision: status.configRevisionId
    };
    this.#dependencies.journal.savePreview(preview, this.#dependencies.binding());
    this.#dependencies.audit("agent.security_repair_previewed", {
      previewId: preview.previewId,
      actionIds: actions.map((action) => action.id),
      issueCodes: preview.findings.map((finding) => finding.code)
    });
    return preview;
  }

  async apply(input: {
    previewId: string;
    idempotencyKey: string;
    confirmation: string;
  }): Promise<AgentSecurityRepairOperation> {
    const existing = this.#dependencies.journal.operationForIdempotency(input.idempotencyKey);
    if (existing) {
      if (existing.previewId !== input.previewId) {
        throw new AgentSecurityRepairError(
          409,
          "AGENT_SECURITY_REPAIR_IDEMPOTENCY_CONFLICT",
          "The idempotency key is already bound to a different repair preview.",
          "Use a new idempotency key for a different preview."
        );
      }
      return existing;
    }
    if (this.#applying || this.#dependencies.journal.activeOperation()) {
      throw new AgentSecurityRepairError(
        409,
        "AGENT_SECURITY_REPAIR_CONFLICT",
        "Another Agent security repair is already applying.",
        "Wait for the active operation receipt before retrying."
      );
    }
    const stored = this.#dependencies.journal.getPreview(input.previewId);
    if (!stored) {
      throw stalePreview();
    }
    if (stored.preview.confirmation.value !== input.confirmation) {
      throw new AgentSecurityRepairError(
        400,
        "AGENT_SECURITY_REPAIR_CONFIRMATION_REQUIRED",
        "The Agent security repair confirmation does not match the bound preview.",
        "Review the preview and provide its exact confirmation value."
      );
    }
    if (!bindingMatches(stored.binding, this.#dependencies.binding())) {
      throw stalePreview();
    }
    if (!this.#dependencies.journal.consumePreview(input.previewId)) {
      throw stalePreview();
    }

    this.#applying = true;
    const operation = this.#dependencies.journal.beginOperation(input.previewId, input.idempotencyKey);
    const appliedActionIds: AgentSecurityRepairActionId[] = [];
    this.#dependencies.audit("agent.security_repair_started", {
      previewId: input.previewId,
      operationId: operation.operationId,
      actionIds: stored.preview.actions.map((action) => action.id)
    });

    try {
      let requiresExternalAction = false;
      for (const action of stored.preview.actions) {
        if (action.riskClass === "manual") {
          requiresExternalAction = true;
          continue;
        }
        if (action.id === "open_provider_key_management") {
          requiresExternalAction = true;
        }
        await this.#applyAction(action.id);
        appliedActionIds.push(action.id);
      }
      const verified = await this.diagnose();
      const remainingIssueCodes = unresolvedTargetCodes(stored.preview.findings, verified.findings);
      const outcome = requiresExternalAction
        ? appliedActionIds.length > 0
          ? "partial"
          : "blocked"
        : remainingIssueCodes.length === 0
          ? "verified"
          : appliedActionIds.length > 0
            ? "partial"
            : "failed";
      const receipt = this.#dependencies.journal.completeOperation(operation.operationId, {
        outcome,
        appliedActionIds,
        remainingIssueCodes,
        requiresRestart: stored.preview.actions.some((action) => action.requiresRestart),
        requiresExternalAction
      });
      this.#dependencies.audit(
        outcome === "verified"
          ? "agent.security_repair_completed"
          : outcome === "partial"
            ? "agent.security_repair_partial"
            : "agent.security_repair_blocked",
        {
          previewId: input.previewId,
          operationId: operation.operationId,
          actionIds: appliedActionIds,
          issueCodes: remainingIssueCodes,
          outcome
        }
      );
      return receipt;
    } catch (error) {
      const verified = await this.diagnose().catch(() => undefined);
      const remainingIssueCodes = verified
        ? unresolvedTargetCodes(stored.preview.findings, verified.findings)
        : stored.preview.findings.map((finding) => finding.code);
      const errorCode =
        error && typeof error === "object" && "code" in error && typeof error.code === "string"
          ? error.code
          : "AGENT_SECURITY_REPAIR_FAILED";
      const receipt = this.#dependencies.journal.completeOperation(operation.operationId, {
        outcome: appliedActionIds.length > 0 ? "partial" : "failed",
        appliedActionIds,
        remainingIssueCodes,
        requiresRestart: stored.preview.actions.some((action) => action.requiresRestart),
        requiresExternalAction: false,
        errorCode
      });
      this.#dependencies.audit("agent.security_repair_failed", {
        previewId: input.previewId,
        operationId: receipt.operationId,
        actionIds: appliedActionIds,
        issueCodes: remainingIssueCodes,
        outcome: receipt.outcome
      });
      throw new AgentSecurityRepairError(
        409,
        errorCode,
        "Agent security repair failed without a verified healthy result.",
        `Inspect repair operation ${receipt.operationId}, then run a fresh diagnosis.`
      );
    } finally {
      this.#applying = false;
    }
  }

  operation(operationId: string): AgentSecurityRepairOperation {
    const operation = this.#dependencies.journal.operation(operationId);
    if (!operation) {
      throw new AgentSecurityRepairError(
        404,
        "AGENT_SECURITY_REPAIR_OPERATION_NOT_FOUND",
        "Agent security repair operation was not found.",
        "Use an operation ID returned by the current daemon state directory."
      );
    }
    return operation;
  }

  latestOperation(): AgentSecurityRepairOperation | null {
    return this.#dependencies.journal.latestOperation() ?? null;
  }

  storedPreview(previewId: string): AgentSecurityRepairPreview {
    const stored = this.#dependencies.journal.getPreview(previewId);
    if (!stored || !bindingMatches(stored.binding, this.#dependencies.binding())) {
      throw stalePreview();
    }
    return stored.preview;
  }

  cancel(operationId: string): AgentSecurityRepairOperation {
    const operation = this.operation(operationId);
    if (operation.state === "running") {
      throw new AgentSecurityRepairError(
        409,
        "AGENT_SECURITY_REPAIR_NOT_CANCELLABLE",
        "The active Agent security repair is in an atomic non-cancellable step.",
        "Wait for the operation receipt, then inspect the verified result."
      );
    }
    return operation;
  }

  async #applyAction(actionId: AgentSecurityRepairActionId): Promise<void> {
    switch (actionId) {
      case "refresh_managed_credential_state":
        await this.#dependencies.refreshManagedCredentialState();
        return;
      case "clear_stale_provider_connection":
        this.#dependencies.clearStaleProviderConnection();
        return;
      case "repair_credential_acl":
        await this.#dependencies.repairCredentialAcl();
        return;
      case "validate_managed_credential":
        await this.#dependencies.validateManagedCredential();
        return;
      case "migrate_legacy_credential":
        await this.#dependencies.migrateLegacyCredential();
        return;
      case "remove_legacy_external_assignment":
        await this.#dependencies.removeLegacyExternalAssignment();
        return;
      case "disconnect_local_credential":
        await this.#dependencies.disconnectLocalCredential();
        return;
      case "reload_selected_agent_config":
        await this.#dependencies.reloadSelectedAgentConfig();
        return;
      case "open_provider_key_management":
        await this.#dependencies.openProviderKeyManagement();
        return;
      case "route_to_provider_connect":
      case "route_to_provider_replace":
      case "route_to_configuration":
      case "route_to_daemon_restart":
        return;
    }
  }
}

function actionDefinition(id: AgentSecurityRepairActionId): AgentSecurityRepairActionPreview {
  const definitions: Record<AgentSecurityRepairActionId, Omit<AgentSecurityRepairActionPreview, "id">> = {
    refresh_managed_credential_state: {
      title: "Refresh protected credential state",
      riskClass: "safe_local",
      changes: ["Refresh daemon-safe credential readability state."],
      preserves: ["Credential storage, provider state, configuration, and external sources."],
      requiresNetwork: false,
      requiresRestart: false,
      reversible: true
    },
    clear_stale_provider_connection: {
      title: "Clear expired provider connection",
      riskClass: "safe_local",
      changes: ["Close and remove the expired daemon-owned OAuth attempt."],
      preserves: ["Active credential and Agent configuration."],
      requiresNetwork: false,
      requiresRestart: false,
      reversible: true
    },
    repair_credential_acl: {
      title: "Restrict credential access",
      riskClass: "guarded_local",
      changes: ["Restrict the exact credential directory and envelope to the current Windows user and SYSTEM."],
      preserves: ["DPAPI ciphertext, credential identity, provider metadata, and configuration."],
      requiresNetwork: false,
      requiresRestart: false,
      reversible: false
    },
    validate_managed_credential: {
      title: "Validate protected credential",
      riskClass: "external",
      changes: ["Request safe OpenRouter credential metadata and persist verified status."],
      preserves: ["Protected credential and existing configuration when validation fails."],
      requiresNetwork: true,
      requiresRestart: false,
      reversible: true
    },
    migrate_legacy_credential: {
      title: "Move legacy credential to Windows DPAPI",
      riskClass: "guarded_local",
      changes: ["Validate, protect, durable-readback, and activate a managed credential."],
      preserves: ["The legacy source until protected migration is verified."],
      requiresNetwork: true,
      requiresRestart: false,
      reversible: true
    },
    remove_legacy_external_assignment: {
      title: "Remove exact legacy external assignment",
      riskClass: "destructive_local",
      changes: ["Remove one preview-bound OpenRouter key assignment without a plaintext backup."],
      preserves: ["Managed DPAPI credential and every other source line."],
      requiresNetwork: false,
      requiresRestart: false,
      reversible: false
    },
    disconnect_local_credential: {
      title: "Disconnect local credential",
      riskClass: "destructive_local",
      changes: ["Delete the exact local protected credential and clear its reference."],
      preserves: ["Remote OpenRouter key state; revocation remains unconfirmed."],
      requiresNetwork: false,
      requiresRestart: false,
      reversible: false
    },
    open_provider_key_management: {
      title: "Open OpenRouter key management",
      riskClass: "external",
      changes: ["Open the provider-owned key management surface."],
      preserves: ["Local credential until an explicit disconnect."],
      requiresNetwork: true,
      requiresRestart: false,
      reversible: true
    },
    reload_selected_agent_config: {
      title: "Reload selected Agent configuration",
      riskClass: "guarded_local",
      changes: ["Validate and atomically activate the selected source."],
      preserves: ["Last-known-good revision when validation fails."],
      requiresNetwork: false,
      requiresRestart: false,
      reversible: true
    },
    route_to_provider_connect: navigationAction("Open Provider connection"),
    route_to_provider_replace: navigationAction("Open Provider replacement"),
    route_to_configuration: navigationAction("Open Agent configuration"),
    route_to_daemon_restart: {
      ...navigationAction("Open safe daemon restart"),
      requiresRestart: true
    }
  };
  return { id, ...definitions[id] };
}

function navigationAction(title: string): Omit<AgentSecurityRepairActionPreview, "id"> {
  return {
    title,
    riskClass: "manual",
    changes: ["Navigate to the existing authoritative control."],
    preserves: ["All Agent security state until the user chooses another action."],
    requiresNetwork: false,
    requiresRestart: false,
    reversible: true
  };
}

function confirmationFor(actions: AgentSecurityRepairActionPreview[]): AgentSecurityRepairPreview["confirmation"] {
  const destructive = actions.find((action) => action.riskClass === "destructive_local");
  const phrase =
    destructive?.id === "disconnect_local_credential"
      ? "disconnect_local_credential"
      : destructive?.id === "remove_legacy_external_assignment"
        ? "remove_legacy_external_credential"
        : undefined;
  return {
    required: actions.some((action) => !["read_only", "manual"].includes(action.riskClass)),
    value: phrase ?? "apply_agent_security_repair",
    ...(phrase ? { phrase, warning: destructive?.changes.join(" ") } : {})
  };
}

function findingMatchesAction(finding: AgentSecurityFinding, actions: Set<AgentSecurityRepairActionId>): boolean {
  return Boolean(
    (finding.recommendedActionId && actions.has(finding.recommendedActionId)) ||
    finding.alternateActionIds?.some((actionId) => actions.has(actionId))
  );
}

function bindingMatches(left: AgentSecurityRepairBinding, right: AgentSecurityRepairBinding): boolean {
  return (
    left.configRevisionId === right.configRevisionId &&
    left.credentialIdentity === right.credentialIdentity &&
    left.sourceFingerprint === right.sourceFingerprint
  );
}

function unresolvedTargetCodes(before: AgentSecurityFinding[], after: AgentSecurityFinding[]): string[] {
  const targetCodes = new Set(before.filter((finding) => finding.state !== "healthy").map((finding) => finding.code));
  return after
    .filter((finding) => finding.state !== "healthy" && targetCodes.has(finding.code))
    .map((finding) => finding.code);
}

function stalePreview(): AgentSecurityRepairError {
  return new AgentSecurityRepairError(
    409,
    "AGENT_SECURITY_REPAIR_PREVIEW_STALE",
    "The Agent security repair preview is missing, expired, or no longer matches daemon state.",
    "Run a fresh diagnosis and create a new preview."
  );
}
