import type {
  AgentConfig,
  AgentCredentialState,
  AgentSecurityFinding,
  AgentSecurityFindingState,
  AgentSecurityStatus
} from "./types.ts";

export interface AgentCredentialProtectionInspection {
  available: boolean;
  credentialExists: boolean;
  acl: "restricted" | "weak" | "unknown";
  errorCode?: string;
}

export interface AgentSecurityDoctorDependencies {
  getConfig(): AgentConfig;
  refreshManagedCredentialState(): Promise<void>;
  inspectCredentialProtection(credentialId?: string): Promise<AgentCredentialProtectionInspection>;
  providerAttempt(): {
    status: string;
    expiresAt?: string;
  } | null;
  probeProviderCredential?(): Promise<void>;
  windowsVerificationAvailability(): { available: boolean; reason?: string };
  now?: () => Date;
}

export class AgentSecurityDoctor {
  readonly #dependencies: AgentSecurityDoctorDependencies;

  constructor(dependencies: AgentSecurityDoctorDependencies) {
    this.#dependencies = dependencies;
  }

  async diagnose(options: { online?: boolean } = {}): Promise<AgentSecurityStatus> {
    await this.#dependencies.refreshManagedCredentialState();
    const config = this.#dependencies.getConfig();
    const checkedAt = (this.#dependencies.now?.() ?? new Date()).toISOString();
    const findings: AgentSecurityFinding[] = [];
    const credential = config.credential;

    findings.push(...(await this.#credentialFindings(config, credential, checkedAt)));
    findings.push(...this.#sourceFindings(config, checkedAt));
    findings.push(...this.#providerAttemptFindings(checkedAt));
    findings.push(this.#windowsVerificationFinding(credential, checkedAt));
    if (
      options.online === true &&
      credential?.protection === "windows-dpapi-current-user" &&
      this.#dependencies.probeProviderCredential
    ) {
      try {
        await this.#dependencies.probeProviderCredential();
        findings.push(
          healthyFinding(
            "AGENT_PROVIDER_KEY_VALIDATED_ONLINE",
            "Online provider check",
            "OpenRouter accepted the protected credential during this explicit online check.",
            checkedAt,
            { online: true, accepted: true }
          )
        );
      } catch {
        findings.push(
          finding({
            code: "AGENT_PROVIDER_METADATA_STALE",
            severity: "warning",
            state: "attention",
            title: "Online provider check did not complete",
            message: "OpenRouter could not confirm the protected credential; prior safe metadata was preserved.",
            checkedAt,
            evidence: { online: true, accepted: false, priorMetadataPreserved: true },
            repairability: "external",
            recommendedActionId: "validate_managed_credential",
            requiresNetwork: true,
            reversible: true,
            userAction: "Check provider connectivity, then retry the explicit online validation."
          })
        );
      }
    }

    const state = aggregateState(findings);
    return {
      scope: "agent-security",
      state,
      healthy: state === "healthy",
      checkedAt,
      online: options.online === true,
      configRevisionId: config.revision?.id ?? "",
      findings
    };
  }

  async #credentialFindings(
    config: AgentConfig,
    credential: AgentCredentialState | undefined,
    checkedAt: string
  ): Promise<AgentSecurityFinding[]> {
    if (!credential || !config.provider.apiKeySource.configured) {
      return [
        finding({
          code: "AGENT_CREDENTIAL_MISSING",
          severity: "error",
          state: "blocked",
          title: "OpenRouter credential is not connected",
          message: "Relaybase has no usable OpenRouter credential.",
          checkedAt,
          evidence: { connected: false, provider: "openrouter" },
          repairability: "manual",
          recommendedActionId: "route_to_provider_connect",
          reversible: true,
          userAction: "Connect OpenRouter in Settings > Agent > Provider."
        })
      ];
    }

    const findings: AgentSecurityFinding[] = [];
    const managed = credential.protection === "windows-dpapi-current-user";
    if (!managed) {
      findings.push(
        finding({
          code:
            credential.source === "environment"
              ? "AGENT_CREDENTIAL_SOURCE_SHELL_OWNED"
              : "AGENT_LEGACY_CREDENTIAL_PRESENT",
          severity: "warning",
          state: "attention",
          title:
            credential.source === "environment"
              ? "Credential is owned by the daemon shell"
              : "Credential is stored in a legacy external source",
          message:
            credential.source === "environment"
              ? "Relaybase cannot remove a credential from its parent shell. Migrate it, clear the parent source, then restart safely."
              : "Move the credential to current-user Windows DPAPI before removing the external assignment.",
          checkedAt,
          evidence: {
            connected: true,
            source: credential.source,
            protected: false
          },
          repairability: "confirmation",
          recommendedActionId: "migrate_legacy_credential",
          alternateActionIds:
            credential.source === "environment" ? ["route_to_daemon_restart"] : ["remove_legacy_external_assignment"],
          requiresRestart: credential.source === "environment",
          reversible: true
        })
      );
    } else {
      const inspection = await this.#dependencies.inspectCredentialProtection(credential.credentialId);
      if (!inspection.available || !inspection.credentialExists) {
        findings.push(
          finding({
            code: inspection.errorCode ?? "AGENT_CREDENTIAL_MISSING",
            severity: "error",
            state: "blocked",
            title: "Protected credential is unavailable",
            message: "The protected OpenRouter credential cannot be read from the current Windows profile.",
            checkedAt,
            evidence: {
              storageAvailable: inspection.available,
              credentialExists: inspection.credentialExists,
              protection: credential.protection
            },
            repairability: "manual",
            recommendedActionId: "route_to_provider_connect",
            alternateActionIds: ["disconnect_local_credential"],
            reversible: false
          })
        );
      } else if (inspection.acl === "weak") {
        findings.push(
          finding({
            code: "AGENT_CREDENTIAL_ACL_WEAK",
            severity: "error",
            state: "blocked",
            title: "Protected credential access is too broad",
            message: "The credential path is not restricted to the current Windows user and SYSTEM.",
            checkedAt,
            evidence: { protection: credential.protection, acl: inspection.acl },
            repairability: "confirmation",
            recommendedActionId: "repair_credential_acl",
            reversible: false
          })
        );
      } else {
        findings.push(
          healthyFinding(
            "AGENT_CREDENTIAL_PROTECTED",
            "Credential protection",
            inspection.acl === "restricted"
              ? "The credential is protected by current-user Windows DPAPI and a restricted ACL."
              : "The credential is protected by current-user Windows DPAPI.",
            checkedAt,
            {
              protection: credential.protection,
              readable: true,
              acl: inspection.acl
            }
          )
        );
      }
    }

    if (credential.connection === "connected_unverified") {
      findings.push(
        finding({
          code: "AGENT_PROVIDER_KEY_UNVERIFIED",
          severity: "error",
          state: "blocked",
          title: "Credential validation is incomplete",
          message: "Remote Agent runs remain blocked until OpenRouter validates the protected credential.",
          checkedAt,
          evidence: { connected: true, verified: false },
          repairability: "external",
          recommendedActionId: "validate_managed_credential",
          requiresNetwork: true,
          reversible: true
        })
      );
    } else if (credential.lastValidatedAt) {
      findings.push(
        healthyFinding(
          "AGENT_PROVIDER_KEY_VALIDATED",
          "Provider validation",
          "OpenRouter validation is complete.",
          checkedAt,
          {
            verified: true,
            lastValidatedAt: credential.lastValidatedAt
          }
        )
      );
    }

    if (credential.expiresAt && Date.parse(credential.expiresAt) <= Date.parse(checkedAt)) {
      findings.push(
        finding({
          code: "AGENT_CREDENTIAL_EXPIRED",
          severity: "error",
          state: "blocked",
          title: "OpenRouter credential is expired",
          message: "Replace the credential before starting another remote Agent run.",
          checkedAt,
          evidence: { expired: true, expiresAt: credential.expiresAt },
          repairability: "manual",
          recommendedActionId: "route_to_provider_replace",
          reversible: true
        })
      );
    }

    if (credential.limitUsd === undefined || credential.expiresAt === undefined || credential.expiresAt === null) {
      findings.push(
        finding({
          code: "AGENT_PROVIDER_KEY_GUARDRAILS_UNREPORTED",
          severity: "info",
          state: "healthy",
          title: "Dedicated-key guardrails",
          message: "Use a Relaybase-only OpenRouter key with a conservative spending limit and expiration.",
          checkedAt,
          evidence: {
            spendingLimitReported: credential.limitUsd !== undefined,
            expirationReported: credential.expiresAt !== undefined && credential.expiresAt !== null
          },
          repairability: "external",
          recommendedActionId: "open_provider_key_management",
          requiresNetwork: true,
          reversible: true
        })
      );
    }
    return findings;
  }

  #sourceFindings(config: AgentConfig, checkedAt: string): AgentSecurityFinding[] {
    const source = config.source;
    if (!source || ["healthy", "legacy_mixed"].includes(source.health)) {
      return [];
    }
    return [
      finding({
        code: source.lastError?.code ?? "AGENT_CONFIG_SOURCE_UNAVAILABLE",
        severity: "error",
        state: "blocked",
        title: "Agent configuration source needs attention",
        message: source.lastError?.message ?? "The selected Agent configuration source is unavailable.",
        checkedAt,
        evidence: { sourceMode: source.mode, sourceHealth: source.health },
        repairability: "confirmation",
        recommendedActionId: "reload_selected_agent_config",
        reversible: true,
        userAction: source.lastError?.userAction
      })
    ];
  }

  #providerAttemptFindings(checkedAt: string): AgentSecurityFinding[] {
    const attempt = this.#dependencies.providerAttempt();
    if (!attempt || !["expired", "cancelled", "failed"].includes(attempt.status)) {
      return [];
    }
    return [
      finding({
        code: "AGENT_PROVIDER_CONNECTION_STALE",
        severity: "warning",
        state: "attention",
        title: "Expired provider connection attempt",
        message: "Clear the completed authorization attempt before starting a new connection.",
        checkedAt,
        evidence: { status: attempt.status, expired: attempt.status === "expired" },
        repairability: "automatic",
        recommendedActionId: "clear_stale_provider_connection",
        reversible: true
      })
    ];
  }

  #windowsVerificationFinding(credential: AgentCredentialState | undefined, checkedAt: string): AgentSecurityFinding {
    const availability = this.#dependencies.windowsVerificationAvailability();
    if (credential?.highSecurityMode === "required" && !availability.available) {
      return finding({
        code: "AGENT_WINDOWS_VERIFICATION_UNAVAILABLE",
        severity: "error",
        state: "blocked",
        title: "Required Windows verification is unavailable",
        message: "Relaybase will not silently downgrade a required verification policy.",
        checkedAt,
        evidence: { required: true, available: false },
        repairability: "manual",
        reversible: true,
        userAction: "Disable the requested mode or use an installation with proven interactive verification support."
      });
    }
    return healthyFinding(
      "AGENT_WINDOWS_VERIFICATION_STATUS",
      "Windows verification",
      availability.available
        ? "Optional Windows verification is available and remains off by default."
        : "Silent current-user DPAPI is active; optional Windows verification is unavailable.",
      checkedAt,
      { required: false, available: availability.available }
    );
  }
}

function healthyFinding(
  code: string,
  title: string,
  message: string,
  checkedAt: string,
  evidence: Record<string, boolean | number | string | null>
): AgentSecurityFinding {
  return finding({
    code,
    severity: "info",
    state: "healthy",
    title,
    message,
    checkedAt,
    evidence,
    repairability: "none",
    reversible: true
  });
}

function finding(
  input: Omit<AgentSecurityFinding, "id" | "requiresNetwork" | "requiresRestart"> & {
    requiresNetwork?: boolean;
    requiresRestart?: boolean;
  }
): AgentSecurityFinding {
  return {
    id: `agent.security.${input.code.toLowerCase()}`,
    requiresNetwork: input.requiresNetwork ?? false,
    requiresRestart: input.requiresRestart ?? false,
    ...input
  };
}

function aggregateState(findings: AgentSecurityFinding[]): AgentSecurityFindingState {
  if (findings.some((item) => item.state === "blocked")) {
    return "blocked";
  }
  if (findings.some((item) => item.state === "attention")) {
    return "attention";
  }
  return "healthy";
}
