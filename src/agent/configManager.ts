import { randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import { AgentConfigSourceError, readStableAgentEnvironment, type StableAgentEnvironment } from "./configSource.ts";
import {
  AgentCredentialError,
  CredentialLease,
  type CredentialDescriptor,
  type CredentialStore
} from "./credentialStore.ts";
import type {
  AgentConfig,
  AgentConfigRevision,
  AgentConfigSourceState,
  AgentCredentialState,
  AgentDiagnostic,
  AgentReadiness
} from "./types.ts";
import { LegacyCredentialRemovalManager, type LegacyCredentialRemovalPreview } from "./legacyCredentialRemoval.ts";

const ENV_ENABLED = "RELAYBASE_AGENT_ENABLED";
const ENV_REMOTE_ENABLED = "RELAYBASE_AGENT_REMOTE_MODEL_ENABLED";
const ENV_MODEL = "RELAYBASE_AGENT_MODEL";
const ENV_KEY = "OPENROUTER_API_KEY";
const ENV_HTTP_REFERER = "OPENROUTER_HTTP_REFERER";
const ENV_TITLE = "OPENROUTER_TITLE";
const RELEVANT_ENV_KEYS = [ENV_ENABLED, ENV_REMOTE_ENABLED, ENV_MODEL, ENV_KEY, ENV_HTTP_REFERER, ENV_TITLE] as const;

export interface AgentConfigManagerOptions {
  initialConfig: AgentConfig;
  environment?: {
    envFilePath?: string;
    envFileFingerprint?: string;
    envFileAppliedKeys?: string[];
    envFileSkippedKeys?: string[];
    envFileSourceKind?: "explicit_env_file" | "cwd_env_file";
  };
  shellEnvironment?: NodeJS.ProcessEnv;
  credentialStore?: CredentialStore;
  managedCredentialState?: {
    verified: boolean;
    lastValidatedAt?: string;
    metadata?: SafeProviderCredentialMetadata;
  };
  onActivated?: (config: AgentConfig) => void;
}

export interface ResolvedAgentRunConfig {
  revisionId: string;
  generation: number;
  config: AgentConfig;
  credentialLease: CredentialLease;
  redactionSecrets: string[];
  loadedAt: string;
  provider: {
    httpReferer?: string;
    title?: string;
  };
}

export interface AgentConfigReloadResult {
  status: "unchanged" | "applied" | "blocked";
  oldRevisionId: string;
  newRevisionId: string;
  changedFields: string[];
  diagnostic?: AgentDiagnostic;
}

export interface SafeProviderCredentialMetadata {
  keyLabel?: string;
  limitUsd?: number;
  limitRemainingUsd?: number;
  limitReset?: "daily" | "weekly" | "monthly" | null;
  expiresAt?: string | null;
}

export class AgentConfigResolutionError extends Error {
  readonly diagnostic: AgentDiagnostic;

  constructor(diagnostic: AgentDiagnostic) {
    super(diagnostic.message);
    this.diagnostic = diagnostic;
  }
}

export class AgentConfigManager {
  #config: AgentConfig;
  #revision: AgentConfigRevision;
  #source: AgentConfigSourceState;
  #startupEnvironment: Readonly<Record<string, string>>;
  #shellValues: Readonly<Record<string, string>>;
  #externalPath?: string;
  #externalFingerprint?: string;
  #externalValues: Readonly<Record<string, string>> = Object.freeze({});
  #externalOwnedKeys?: ReadonlySet<string>;
  #externalSkippedKeys = new Set<string>();
  #externalModelSource: AgentConfig["provider"]["modelSource"];
  #externalMetadata?: { size: number; modifiedMs: number };
  #credentialStore?: CredentialStore;
  #reloadFlight?: Promise<AgentConfigReloadResult>;
  #managedCredentialReadable = true;
  #managedCredentialNeedsRecoveryCheck = false;
  #credentialVerified = true;
  #credentialValidatedAt?: string;
  #credentialMetadata?: SafeProviderCredentialMetadata;
  #onActivated?: (config: AgentConfig) => void;
  #legacyCredentialRemoval: LegacyCredentialRemovalManager;

  constructor(options: AgentConfigManagerOptions) {
    this.#config = cloneConfig(options.initialConfig);
    this.#revision = newRevision(1);
    this.#startupEnvironment = snapshotEnvironment(options.shellEnvironment ?? process.env);
    this.#shellValues = captureEnvironment(this.#startupEnvironment);
    this.#externalModelSource =
      options.environment?.envFileSourceKind === "explicit_env_file"
        ? { kind: "explicit_env_file", label: "RELAYBASE_ENV_FILE" }
        : { kind: "cwd_env_file", label: ".env" };
    this.#externalPath = options.environment?.envFilePath;
    this.#externalFingerprint = options.environment?.envFileFingerprint;
    this.#externalOwnedKeys = options.environment?.envFileAppliedKeys
      ? new Set(options.environment.envFileAppliedKeys)
      : undefined;
    this.#externalSkippedKeys = new Set(options.environment?.envFileSkippedKeys ?? []);
    if (this.#externalOwnedKeys) {
      this.#externalValues = Object.freeze(
        Object.fromEntries(Object.entries(this.#shellValues).filter(([key]) => this.#externalOwnedKeys?.has(key)))
      );
      this.#shellValues = Object.freeze(
        Object.fromEntries(Object.entries(this.#shellValues).filter(([key]) => !this.#externalOwnedKeys?.has(key)))
      );
    }
    this.#credentialStore = options.credentialStore;
    this.#legacyCredentialRemoval = new LegacyCredentialRemovalManager({
      filePath: this.#externalPath,
      sourceLabel: this.#externalModelSource.label,
      ...(options.credentialStore?.restrictPathToCurrentUser
        ? {
            restrictPath: (target) => options.credentialStore?.restrictPathToCurrentUser?.(target)
          }
        : {})
    });
    this.#onActivated = options.onActivated;
    const managedCredentialId =
      this.#config.provider.apiKeySource.type === "managed_windows_dpapi"
        ? this.#config.provider.apiKeySource.credentialId
        : undefined;
    this.#managedCredentialReadable = !managedCredentialId;
    this.#managedCredentialNeedsRecoveryCheck = Boolean(managedCredentialId);
    this.#credentialVerified = !managedCredentialId || options.managedCredentialState?.verified === true;
    this.#credentialValidatedAt = options.managedCredentialState?.lastValidatedAt;
    this.#credentialMetadata = options.managedCredentialState?.metadata;
    this.#source = this.#externalPath
      ? {
          mode: this.#shellValues[ENV_KEY] ? "legacy_mixed" : "external_file",
          health: this.#shellValues[ENV_KEY] ? "legacy_mixed" : "healthy",
          label: this.#externalModelSource.label,
          lastAppliedAt: this.#revision.loadedAt
        }
      : managedCredentialId || this.#config.provider.modelSource.kind === "persisted_config"
        ? {
            mode: "managed",
            health: "healthy",
            label: "Relaybase managed configuration",
            lastAppliedAt: this.#revision.loadedAt
          }
        : {
            mode: "shell_environment",
            health: "healthy",
            label: "Shell environment",
            lastAppliedAt: this.#revision.loadedAt
          };
    if (this.#externalPath) {
      try {
        const stat = fs.statSync(this.#externalPath);
        this.#externalMetadata = { size: stat.size, modifiedMs: stat.mtimeMs };
      } catch {
        this.#source.health = "unavailable";
      }
    }
  }

  getSafeState(): AgentConfig {
    this.#markExternalChangeHint();
    const credentialConfigured = this.#credentialConfigured();
    const credentialUsable =
      credentialConfigured &&
      (this.#config.provider.apiKeySource.type !== "managed_windows_dpapi" || this.#credentialVerified);
    const readiness = readinessFor(this.#config, credentialUsable, this.#source.health);
    const credential = this.#credentialState(credentialConfigured);
    return cloneConfig({
      ...this.#config,
      revision: { ...this.#revision },
      source: {
        ...this.#source,
        ...(this.#source.lastError ? { lastError: { ...this.#source.lastError } } : {})
      },
      readiness,
      credential,
      provider: {
        ...this.#config.provider,
        restartRequired: false,
        apiKeySource: {
          ...this.#config.provider.apiKeySource,
          configured: credentialConfigured
        }
      }
    });
  }

  activeConfig(): AgentConfig {
    return cloneConfig(this.#config);
  }

  managedCredentialPersistenceState():
    | {
        verified: boolean;
        lastValidatedAt?: string;
        metadata?: SafeProviderCredentialMetadata;
      }
    | undefined {
    if (this.#config.provider.apiKeySource.type !== "managed_windows_dpapi") {
      return undefined;
    }
    return {
      verified: this.#credentialVerified,
      ...(this.#credentialValidatedAt ? { lastValidatedAt: this.#credentialValidatedAt } : {}),
      ...(this.#credentialMetadata ? { metadata: { ...this.#credentialMetadata } } : {})
    };
  }

  securityRepairBindingState(): {
    configRevisionId: string;
    credentialId?: string;
    sourceFingerprint: string;
  } {
    return {
      configRevisionId: this.#revision.id,
      ...(this.#config.provider.apiKeySource.credentialId
        ? { credentialId: this.#config.provider.apiKeySource.credentialId }
        : {}),
      sourceFingerprint: this.#externalFingerprint ?? this.#source.mode
    };
  }

  activateManagedConfig(config: AgentConfig, expectedRevisionId?: string): AgentConfig {
    if (expectedRevisionId && expectedRevisionId !== this.#revision.id) {
      throw new AgentConfigResolutionError(
        diagnostic(
          "AGENT_CONFIG_REVISION_CONFLICT",
          "Agent configuration changed after this settings draft was opened.",
          "Refresh the Agent settings draft and reapply the intended changes."
        )
      );
    }
    const requestedEnvVar = config.provider.apiKeySource.envVar;
    if (
      config.provider.apiKeySource.type === "environment" &&
      requestedEnvVar &&
      !Object.prototype.hasOwnProperty.call(this.#shellValues, requestedEnvVar) &&
      typeof this.#startupEnvironment[requestedEnvVar] === "string"
    ) {
      this.#shellValues = Object.freeze({
        ...this.#shellValues,
        [requestedEnvVar]: this.#startupEnvironment[requestedEnvVar] ?? ""
      });
    }
    this.#activate(config);
    return this.getSafeState();
  }

  async resolveForNewRun(): Promise<ResolvedAgentRunConfig> {
    if (this.#externalPath) {
      const reload = await this.reload();
      if (reload.status === "blocked" && reload.diagnostic) {
        throw new AgentConfigResolutionError(reload.diagnostic);
      }
    }
    if (this.#config.provider.apiKeySource.type === "managed_windows_dpapi") {
      await this.refreshManagedCredentialState();
    }

    const safeConfig = this.getSafeState();
    const configDiagnostic = readinessDiagnostic(safeConfig);
    if (configDiagnostic) {
      throw new AgentConfigResolutionError(configDiagnostic);
    }

    const lease = await this.#acquireCredential();
    const secret = lease.value();
    const runtimeValues = this.#effectiveEnvironment();
    return {
      revisionId: this.#revision.id,
      generation: this.#revision.generation,
      config: cloneConfig(safeConfig),
      credentialLease: lease,
      redactionSecrets: [secret],
      loadedAt: this.#revision.loadedAt,
      provider: {
        ...(runtimeValues[ENV_HTTP_REFERER] ? { httpReferer: runtimeValues[ENV_HTTP_REFERER] } : {}),
        ...(runtimeValues[ENV_TITLE] ? { title: runtimeValues[ENV_TITLE] } : {})
      }
    };
  }

  reload(options: { force?: boolean } = {}): Promise<AgentConfigReloadResult> {
    if (this.#reloadFlight) {
      return this.#reloadFlight;
    }
    this.#reloadFlight = this.#reloadExternal(options).finally(() => {
      this.#reloadFlight = undefined;
    });
    return this.#reloadFlight;
  }

  async storeManagedCredential(
    secret: Buffer,
    options: { verified?: boolean; metadata?: SafeProviderCredentialMetadata } = {}
  ): Promise<CredentialDescriptor> {
    if (!this.#credentialStore?.available()) {
      throw new AgentCredentialError(
        "AGENT_CREDENTIAL_DPAPI_PROTECT_FAILED",
        "Protected Windows credential storage is unavailable."
      );
    }
    const descriptor = await this.#credentialStore.put("openrouter", secret);
    let readback: Awaited<ReturnType<CredentialStore["get"]>> | undefined;
    try {
      readback = await this.#credentialStore.get(descriptor.credentialId);
      if (readback.secret.byteLength !== secret.byteLength || !timingSafeEqual(readback.secret, secret)) {
        throw new AgentCredentialError(
          "AGENT_CREDENTIAL_CORRUPT",
          "The protected credential did not pass durable readback verification."
        );
      }
    } catch (error) {
      await this.#credentialStore.delete(descriptor.credentialId).catch(() => false);
      throw error;
    } finally {
      readback?.secret.fill(0);
    }
    const previousCredentialId = this.#config.provider.apiKeySource.credentialId;
    this.#managedCredentialReadable = true;
    this.#managedCredentialNeedsRecoveryCheck = false;
    this.#credentialVerified = options.verified ?? true;
    this.#credentialValidatedAt = this.#credentialVerified ? new Date().toISOString() : undefined;
    this.#credentialMetadata = options.metadata;
    this.#config = {
      ...this.#config,
      provider: {
        ...this.#config.provider,
        apiKeySource: {
          type: "managed_windows_dpapi",
          credentialId: descriptor.credentialId,
          configured: true
        }
      }
    };
    if (!this.#externalPath) {
      this.#source = {
        mode: "managed",
        health: "healthy",
        label: "Relaybase managed configuration",
        lastCheckedAt: new Date().toISOString(),
        lastAppliedAt: new Date().toISOString()
      };
    }
    this.#activate(this.#config);
    if (previousCredentialId && previousCredentialId !== descriptor.credentialId) {
      await this.#credentialStore.delete(previousCredentialId).catch(() => false);
    }
    return descriptor;
  }

  markManagedCredentialValidated(metadata: SafeProviderCredentialMetadata): void {
    this.#credentialVerified = true;
    this.#credentialValidatedAt = new Date().toISOString();
    this.#credentialMetadata = metadata;
    this.#activate(this.#config);
  }

  async validateManagedCredential(
    validator: (credential: string) => Promise<SafeProviderCredentialMetadata>
  ): Promise<SafeProviderCredentialMetadata> {
    if (this.#config.provider.apiKeySource.type !== "managed_windows_dpapi") {
      throw new AgentCredentialError(
        "AGENT_CREDENTIAL_MISSING",
        "A managed OpenRouter credential is required for validation."
      );
    }
    const lease = await this.#acquireCredential();
    try {
      const metadata = await validator(lease.value());
      this.markManagedCredentialValidated(metadata);
      return metadata;
    } finally {
      lease.dispose();
    }
  }

  async probeManagedCredential(
    validator: (credential: string) => Promise<SafeProviderCredentialMetadata>
  ): Promise<SafeProviderCredentialMetadata> {
    if (this.#config.provider.apiKeySource.type !== "managed_windows_dpapi") {
      throw new AgentCredentialError(
        "AGENT_CREDENTIAL_MISSING",
        "A managed OpenRouter credential is required for validation."
      );
    }
    const lease = await this.#acquireCredential();
    try {
      return await validator(lease.value());
    } finally {
      lease.dispose();
    }
  }

  async refreshManagedCredentialState(): Promise<void> {
    const credentialId = this.#config.provider.apiKeySource.credentialId;
    if (
      this.#config.provider.apiKeySource.type !== "managed_windows_dpapi" ||
      !credentialId ||
      !this.#credentialStore
    ) {
      this.#managedCredentialReadable = false;
      return;
    }
    if (this.#managedCredentialReadable && !this.#managedCredentialNeedsRecoveryCheck) {
      return;
    }
    try {
      const stored = await this.#credentialStore.get(credentialId);
      stored.secret.fill(0);
      this.#managedCredentialReadable = true;
      this.#managedCredentialNeedsRecoveryCheck = false;
    } catch {
      this.#managedCredentialReadable = false;
      this.#credentialVerified = false;
      this.#managedCredentialNeedsRecoveryCheck = false;
    }
  }

  async migrateLegacyCredential(
    validator?: (credential: string) => Promise<SafeProviderCredentialMetadata>
  ): Promise<CredentialDescriptor> {
    const lease = await this.#acquireCredential();
    try {
      const value = lease.value();
      const metadata = validator ? await validator(value) : undefined;
      return await this.storeManagedCredential(Buffer.from(value, "utf8"), {
        verified: Boolean(validator),
        ...(metadata ? { metadata } : {})
      });
    } finally {
      lease.dispose();
    }
  }

  async previewLegacyCredentialRemoval(): Promise<LegacyCredentialRemovalPreview> {
    if (this.#config.provider.apiKeySource.type !== "managed_windows_dpapi") {
      throw new AgentCredentialError(
        "AGENT_LEGACY_CREDENTIAL_REMOVAL_UNAVAILABLE",
        "Move the legacy credential into protected storage before removing its external assignment."
      );
    }
    if (!this.#externalValues[ENV_KEY]) {
      throw new AgentCredentialError(
        "AGENT_LEGACY_CREDENTIAL_REMOVAL_UNAVAILABLE",
        this.#shellValues[ENV_KEY]
          ? "The old credential is owned by the daemon shell environment and must be cleared from that shell manually."
          : "No removable legacy OpenRouter credential assignment is active in the selected external source."
      );
    }
    return this.#legacyCredentialRemoval.preview();
  }

  async applyLegacyCredentialRemoval(previewId: string): Promise<{
    removed: true;
    sourceLabel: string;
    changedLineCount: 1;
    reload: AgentConfigReloadResult;
  }> {
    if (this.#config.provider.apiKeySource.type !== "managed_windows_dpapi") {
      throw new AgentCredentialError(
        "AGENT_LEGACY_CREDENTIAL_REMOVAL_UNAVAILABLE",
        "Protected managed mode must remain active while removing the legacy assignment."
      );
    }
    const result = await this.#legacyCredentialRemoval.apply(previewId);
    const reload = await this.reload({ force: true });
    if (reload.status === "blocked") {
      throw new AgentCredentialError(
        "AGENT_LEGACY_CREDENTIAL_REMOVAL_FAILED",
        "The assignment was removed, but the updated external configuration did not reload cleanly."
      );
    }
    return { ...result, reload };
  }

  async disconnectManagedCredential(): Promise<boolean> {
    const credentialId = this.#config.provider.apiKeySource.credentialId;
    if (!credentialId || !this.#credentialStore) {
      return false;
    }
    const removed = await this.#credentialStore.delete(credentialId);
    this.#managedCredentialReadable = false;
    this.#managedCredentialNeedsRecoveryCheck = false;
    this.#credentialMetadata = undefined;
    this.#credentialValidatedAt = undefined;
    this.#config = {
      ...this.#config,
      provider: {
        ...this.#config.provider,
        apiKeySource: {
          type: "managed_windows_dpapi",
          configured: false
        }
      }
    };
    this.#activate(this.#config);
    return removed;
  }

  async #reloadExternal(options: { force?: boolean }): Promise<AgentConfigReloadResult> {
    const oldRevisionId = this.#revision.id;
    if (!this.#externalPath) {
      return { status: "unchanged", oldRevisionId, newRevisionId: oldRevisionId, changedFields: [] };
    }
    this.#source = { ...this.#source, health: "reloading", lastCheckedAt: new Date().toISOString() };
    let snapshot: StableAgentEnvironment;
    try {
      snapshot = await readStableAgentEnvironment(this.#externalPath);
    } catch (error) {
      const sourceError =
        error instanceof AgentConfigSourceError
          ? error
          : new AgentConfigSourceError(
              "AGENT_CONFIG_SOURCE_UNAVAILABLE",
              "The selected Agent configuration source could not be read."
            );
      const sourceDiagnostic = diagnostic(
        sourceError.code,
        sourceError.message,
        "Repair or restore the selected Agent configuration source, then reload."
      );
      this.#source = {
        ...this.#source,
        health: sourceError.code === "AGENT_CONFIG_RELOAD_INVALID" ? "invalid" : "unavailable",
        lastCheckedAt: new Date().toISOString(),
        lastError: sourceDiagnostic
      };
      return {
        status: "blocked",
        oldRevisionId,
        newRevisionId: oldRevisionId,
        changedFields: [],
        diagnostic: sourceDiagnostic
      };
    }

    this.#externalMetadata = { size: snapshot.size, modifiedMs: snapshot.modifiedMs };
    if (!options.force && snapshot.fingerprint === this.#externalFingerprint) {
      this.#externalValues = this.#ownedExternalValues(snapshot.values);
      this.#source = {
        ...this.#source,
        health: this.#source.mode === "legacy_mixed" ? "legacy_mixed" : "healthy",
        lastCheckedAt: new Date().toISOString()
      };
      delete this.#source.lastError;
      return { status: "unchanged", oldRevisionId, newRevisionId: oldRevisionId, changedFields: [] };
    }

    const nextValues = this.#ownedExternalValues(snapshot.values);
    for (const key of Object.keys(nextValues)) {
      this.#externalOwnedKeys = new Set([...(this.#externalOwnedKeys ?? []), key]);
    }
    const candidate = applyExternalValues(
      this.#config,
      Object.freeze({ ...this.#shellValues, ...nextValues }),
      this.#externalOwnedKeys ?? new Set(),
      this.#externalModelSource
    );
    const changedFields = changedFieldNames(this.#config, candidate, this.#externalValues, nextValues);
    this.#externalValues = nextValues;
    this.#externalFingerprint = snapshot.fingerprint;
    this.#source = {
      ...this.#source,
      health: this.#source.mode === "legacy_mixed" ? "legacy_mixed" : "healthy",
      lastCheckedAt: new Date().toISOString(),
      lastAppliedAt: new Date().toISOString()
    };
    delete this.#source.lastError;
    if (changedFields.length === 0) {
      return { status: "unchanged", oldRevisionId, newRevisionId: oldRevisionId, changedFields: [] };
    }
    this.#activate(candidate);
    return {
      status: "applied",
      oldRevisionId,
      newRevisionId: this.#revision.id,
      changedFields
    };
  }

  #ownedExternalValues(values: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
    return Object.freeze(
      Object.fromEntries(Object.entries(values).filter(([key]) => !this.#externalSkippedKeys.has(key)))
    );
  }

  async #acquireCredential(): Promise<CredentialLease> {
    if (this.#config.provider.apiKeySource.type === "managed_windows_dpapi") {
      const credentialId = this.#config.provider.apiKeySource.credentialId;
      if (!credentialId || !this.#credentialStore) {
        throw new AgentCredentialError("AGENT_CREDENTIAL_MISSING", "The managed OpenRouter credential is missing.");
      }
      let stored: Awaited<ReturnType<CredentialStore["get"]>>;
      try {
        stored = await this.#credentialStore.get(credentialId);
      } catch (error) {
        this.#managedCredentialReadable = false;
        this.#credentialVerified = false;
        throw error instanceof AgentCredentialError
          ? error
          : new AgentCredentialError("AGENT_CREDENTIAL_MISSING", "The managed OpenRouter credential is unavailable.");
      }
      const lease = new CredentialLease(stored.secret, {
        credentialId: stored.credentialId,
        protection: stored.protection
      });
      stored.secret.fill(0);
      return lease;
    }
    const envVar = this.#config.provider.apiKeySource.envVar ?? ENV_KEY;
    const value = this.#effectiveEnvironment()[envVar];
    if (!value) {
      throw new AgentCredentialError("AGENT_CREDENTIAL_MISSING", "The OpenRouter credential is missing.");
    }
    return new CredentialLease(Buffer.from(value, "utf8"), {
      credentialId: `legacy-${envVar}`,
      protection: "none"
    });
  }

  #credentialConfigured(): boolean {
    if (this.#config.provider.apiKeySource.type === "managed_windows_dpapi") {
      return Boolean(this.#config.provider.apiKeySource.credentialId) && this.#managedCredentialReadable;
    }
    const envVar = this.#config.provider.apiKeySource.envVar ?? ENV_KEY;
    return Boolean(this.#effectiveEnvironment()[envVar]);
  }

  #credentialState(configured: boolean): AgentCredentialState {
    const managed = this.#config.provider.apiKeySource.type === "managed_windows_dpapi";
    return {
      provider: "openrouter",
      connection: configured ? "connected" : "disconnected",
      source: managed ? "windows_dpapi" : this.#externalValues[ENV_KEY] ? "external_file" : "environment",
      protection: managed ? "windows-dpapi-current-user" : "none",
      ...(this.#config.provider.apiKeySource.credentialId
        ? { credentialId: this.#config.provider.apiKeySource.credentialId }
        : {}),
      ...(this.#credentialValidatedAt ? { lastValidatedAt: this.#credentialValidatedAt } : {}),
      ...(managed && configured && !this.#credentialVerified ? { connection: "connected_unverified" as const } : {}),
      ...(this.#credentialMetadata ?? {}),
      highSecurityMode: "unavailable"
    };
  }

  #effectiveEnvironment(): Readonly<Record<string, string>> {
    return Object.freeze({ ...this.#shellValues, ...this.#externalValues });
  }

  #activate(config: AgentConfig): void {
    this.#config = cloneConfig(stripPublicState(config));
    this.#revision = newRevision(this.#revision.generation + 1);
    this.#onActivated?.(cloneConfig(this.#config));
  }

  #markExternalChangeHint(): void {
    if (!this.#externalPath || !["healthy", "legacy_mixed", "changed"].includes(this.#source.health)) {
      return;
    }
    try {
      const stat = fs.statSync(this.#externalPath);
      if (
        this.#externalMetadata &&
        (stat.size !== this.#externalMetadata.size || stat.mtimeMs !== this.#externalMetadata.modifiedMs)
      ) {
        this.#source = { ...this.#source, health: "changed", lastCheckedAt: new Date().toISOString() };
      }
    } catch {
      this.#source = { ...this.#source, health: "unavailable", lastCheckedAt: new Date().toISOString() };
    }
  }
}

function captureEnvironment(env: NodeJS.ProcessEnv): Readonly<Record<string, string>> {
  const captured: Record<string, string> = {};
  for (const key of RELEVANT_ENV_KEYS) {
    if (typeof env[key] === "string") {
      captured[key] = env[key] ?? "";
    }
  }
  return Object.freeze(captured);
}

function snapshotEnvironment(env: NodeJS.ProcessEnv): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
  );
}

function applyExternalValues(
  config: AgentConfig,
  values: Readonly<Record<string, string>>,
  controlledKeys: ReadonlySet<string>,
  modelSource: AgentConfig["provider"]["modelSource"]
): AgentConfig {
  const next = cloneConfig(config);
  if (controlledKeys.has(ENV_ENABLED)) {
    next.enabled = Object.prototype.hasOwnProperty.call(values, ENV_ENABLED) ? envBoolean(values[ENV_ENABLED]) : false;
  }
  if (controlledKeys.has(ENV_REMOTE_ENABLED)) {
    next.provider.remoteModelEnabled = Object.prototype.hasOwnProperty.call(values, ENV_REMOTE_ENABLED)
      ? envBoolean(values[ENV_REMOTE_ENABLED])
      : false;
  }
  if (controlledKeys.has(ENV_MODEL)) {
    const modelSlug = values[ENV_MODEL]?.trim();
    if (modelSlug) {
      next.provider.modelSlug = modelSlug;
      next.provider.modelSource = { ...modelSource };
    } else {
      delete next.provider.modelSlug;
      next.provider.modelSource = { kind: "unconfigured", label: "not configured" };
    }
  }
  next.updatedAt = new Date().toISOString();
  return next;
}

function changedFieldNames(
  previous: AgentConfig,
  next: AgentConfig,
  previousValues: Readonly<Record<string, string>>,
  nextValues: Readonly<Record<string, string>>
): string[] {
  const changed: string[] = [];
  if (previous.enabled !== next.enabled) changed.push("enabled");
  if (previous.provider.remoteModelEnabled !== next.provider.remoteModelEnabled) changed.push("remoteModelEnabled");
  if (previous.provider.modelSlug !== next.provider.modelSlug) changed.push("modelSlug");
  if (previousValues[ENV_HTTP_REFERER] !== nextValues[ENV_HTTP_REFERER]) changed.push("httpReferer");
  if (previousValues[ENV_TITLE] !== nextValues[ENV_TITLE]) changed.push("title");
  if (previousValues[ENV_KEY] !== nextValues[ENV_KEY]) changed.push("credential");
  return changed;
}

function readinessFor(
  config: AgentConfig,
  credentialConfigured: boolean,
  sourceHealth: AgentConfigSourceState["health"]
): AgentReadiness {
  if (!config.enabled) {
    return "disabled";
  }
  return config.provider.remoteModelEnabled &&
    Boolean(config.provider.modelSlug) &&
    credentialConfigured &&
    (sourceHealth === "healthy" || sourceHealth === "legacy_mixed")
    ? "ready"
    : "needs_configuration";
}

function readinessDiagnostic(config: AgentConfig): AgentDiagnostic | undefined {
  if (!config.enabled) {
    return diagnostic("AGENT_DISABLED", "Relaybase Operator Agent is disabled.", "Enable the Agent in settings.");
  }
  if (!config.provider.remoteModelEnabled) {
    return diagnostic(
      "AGENT_REMOTE_MODEL_DISABLED",
      "Relaybase Operator Agent remote model mode is disabled.",
      "Enable remote model access in Agent settings."
    );
  }
  if (!config.provider.modelSlug) {
    return diagnostic("AGENT_MODEL_MISSING", "No OpenRouter model slug is configured.", "Choose an Agent model.");
  }
  if (!config.provider.apiKeySource.configured) {
    return diagnostic(
      "AGENT_CREDENTIAL_MISSING",
      "No OpenRouter credential is connected.",
      "Connect OpenRouter from Settings > Agent > Provider."
    );
  }
  if (config.credential?.connection === "connected_unverified") {
    return diagnostic(
      "AGENT_PROVIDER_KEY_UNVERIFIED",
      "The connected OpenRouter credential has not been validated.",
      "Retry provider validation before starting a remote Agent run."
    );
  }
  if (config.source && !["healthy", "legacy_mixed"].includes(config.source.health)) {
    return (
      config.source.lastError ??
      diagnostic(
        "AGENT_CONFIG_SOURCE_UNAVAILABLE",
        "The Agent configuration source is not ready.",
        "Repair the configuration source and reload."
      )
    );
  }
  return undefined;
}

function diagnostic(code: string, message: string, userAction: string): AgentDiagnostic {
  return {
    id: `agent.config.${code.toLowerCase()}`,
    severity: "error",
    code,
    message,
    checkedAt: new Date().toISOString(),
    userAction
  };
}

function envBoolean(value: unknown): boolean {
  return ["1", "true", "yes", "on"].includes(
    String(value ?? "")
      .trim()
      .toLowerCase()
  );
}

function newRevision(generation: number): AgentConfigRevision {
  return { id: randomUUID(), generation, loadedAt: new Date().toISOString() };
}

function stripPublicState(config: AgentConfig): AgentConfig {
  const clone = cloneConfig(config);
  delete clone.revision;
  delete clone.source;
  delete clone.readiness;
  delete clone.credential;
  delete clone.activeRunUsesOlderRevision;
  return clone;
}

function cloneConfig<T extends AgentConfig>(config: T): T {
  return structuredClone(config);
}
