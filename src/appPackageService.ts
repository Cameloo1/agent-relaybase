import { createHash, randomUUID } from "node:crypto";
import type { DaemonEventType, LifecycleOperation } from "./apiTypes.ts";
import {
  AppPackageStore,
  isTerminalRunStatus,
  type AppPackageDefinition,
  type AppPackageRun,
  type AppPackageRunMember
} from "./appPackageStore.ts";
import type { Registry } from "./registry.ts";
import type { AppRecord, AppStatusView } from "./types.ts";

const MAX_PACKAGE_MEMBERS = 100;
const PACKAGE_LAUNCH_CONCURRENCY = 4;
const PACKAGE_CHANGE_PREVIEW_TTL_MS = 5 * 60 * 1000;
const MAX_PACKAGE_CHANGE_BINDINGS = 128;
const RESERVED_PACKAGE_NAMES = new Set([
  "add",
  "--confirm",
  "--dry-run",
  "confirm=true",
  "--dryrun",
  "dryrun=true",
  "dry-run=true",
  "cancel",
  "component",
  "configure",
  "confirm",
  "create-package",
  "daemon",
  "delete-package",
  "health",
  "help",
  "launch",
  "launch-package",
  "logs",
  "list",
  "manage",
  "manifest",
  "open",
  "package-run",
  "packages",
  "page",
  "pane",
  "pin",
  "port",
  "prove",
  "register",
  "repair",
  "restart",
  "stop",
  "theme",
  "thread",
  "unpin"
]);

export type EnqueuePackageMemberLifecycle = (input: { appId: string; correlationId: string }) => {
  operationId: string;
  operation: LifecycleOperation;
  done: Promise<LifecycleOperation>;
  deduplicated: boolean;
};

export type AppPackageChangeKind = "add-member" | "rename" | "replace-members";

export interface AppPackageDefinitionChangePreview {
  previewId?: string;
  expiresAt?: string;
  noop: boolean;
  canApply: boolean;
  change: { kind: AppPackageChangeKind };
  package: {
    id: string;
    currentName: string;
    proposedName: string;
    currentRevision: number;
    proposedRevision: number;
    currentMemberAppIds: string[];
    proposedMemberAppIds: string[];
  };
  activeRun?: { id: string; status: string };
  blockers: Array<{ code: "PACKAGE_RUN_ACTIVE"; message: string }>;
  preserved: {
    stablePackageId: string;
    appLifecycle: true;
    routes: true;
    historicalRuns: true;
  };
}

export interface AppPackageDefinitionChangeResult {
  updated: true;
  changeKind: AppPackageChangeKind;
  package: AppPackageDefinition;
}

export interface AppPackageDeletePreview {
  previewId?: string;
  expiresAt?: string;
  canDelete: boolean;
  package: Pick<AppPackageDefinition, "id" | "name" | "revision" | "memberAppIds">;
  activeRun?: { id: string; status: string };
  historicalRunCount: number;
  blockers: Array<{ code: "PACKAGE_RUN_ACTIVE"; message: string }>;
  preserved: { apps: true; projectFiles: true; manifests: true; historicalRuns: true };
}

export interface AppPackageDeleteResult {
  deleted: true;
  package: AppPackageDefinition;
  preserved: AppPackageDeletePreview["preserved"];
}

type PublishPackageEvent = (input: {
  type: Extract<DaemonEventType, "package.created" | "package.updated" | "package.deleted">;
  correlationId?: string;
  data: Record<string, unknown>;
}) => void;

export interface AppPackageServiceOptions {
  stateDir: string;
  registry: Registry;
  listAppStatuses: () => Promise<AppStatusView[]>;
  enqueueLifecycle: EnqueuePackageMemberLifecycle;
  publishEvent?: PublishPackageEvent;
  concurrency?: number;
}

interface PackageChangeBinding {
  previewId: string;
  packageId: string;
  expectedRevision: number;
  kind: AppPackageChangeKind;
  proposedName: string;
  proposedNormalizedName: string;
  proposedMemberAppIds: string[];
  proposedHash: string;
  createdAt: number;
  expiresAt: number;
}

interface PackageDeleteBinding {
  previewId: string;
  packageId: string;
  expectedRevision: number;
  createdAt: number;
  expiresAt: number;
}

export class AppPackageServiceError extends Error {
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
    this.retryable = options.retryable ?? false;
    this.detail = options.detail;
    this.userAction = options.userAction;
  }
}

export class AppPackageService {
  readonly store: AppPackageStore;
  #registry: Registry;
  #listAppStatuses: () => Promise<AppStatusView[]>;
  #enqueueLifecycle: EnqueuePackageMemberLifecycle;
  #publishEvent?: PublishPackageEvent;
  #concurrency: number;
  #executions = new Map<string, Promise<void>>();
  #changeBindings = new Map<string, PackageChangeBinding>();
  #deleteBindings = new Map<string, PackageDeleteBinding>();
  #definitionGates = new Map<string, Promise<void>>();
  #accepting = true;

  constructor(options: AppPackageServiceOptions) {
    this.store = new AppPackageStore(options.stateDir);
    this.#registry = options.registry;
    this.#listAppStatuses = options.listAppStatuses;
    this.#enqueueLifecycle = options.enqueueLifecycle;
    this.#publishEvent = options.publishEvent;
    this.#concurrency = Math.min(
      Math.max(options.concurrency ?? PACKAGE_LAUNCH_CONCURRENCY, 1),
      PACKAGE_LAUNCH_CONCURRENCY
    );
  }

  listDefinitions(): AppPackageDefinition[] {
    return this.store.listDefinitions();
  }

  activeRuns(): AppPackageRun[] {
    return this.store
      .listDefinitions()
      .flatMap((definition) => this.store.listRunsForPackage(definition.id))
      .filter((run) => !isTerminalRunStatus(run.status));
  }

  getDefinition(id: string): AppPackageDefinition {
    const definition = this.store.getDefinition(id);
    if (!definition) {
      throw packageNotFound(id);
    }
    return definition;
  }

  async createDefinition(raw: { name?: unknown; members?: unknown }): Promise<AppPackageDefinition> {
    this.#assertAccepting();
    const name = packageName(raw.name);
    const normalizedName = normalizeName(name);
    if (RESERVED_PACKAGE_NAMES.has(normalizedName)) {
      throw new AppPackageServiceError(400, "PACKAGE_NAME_RESERVED", "Package name conflicts with a slash command.", {
        userAction: "Choose a package name that is not a Relaybase slash command."
      });
    }
    if (this.store.getDefinitionByNormalizedName(normalizedName)) {
      throw new AppPackageServiceError(409, "PACKAGE_NAME_CONFLICT", `Package name ${name} is already in use.`, {
        userAction: "Choose a unique package name or delete the existing package first."
      });
    }

    const references = packageMemberReferences(raw.members);
    const apps = await this.#registry.list();
    const resolved = references.map((reference) => resolveMemberReference(reference, apps));
    const duplicates = duplicateValues(resolved.map((app) => app.id));
    if (duplicates.length > 0) {
      throw new AppPackageServiceError(
        400,
        "PACKAGE_MEMBER_DUPLICATE",
        "Package members must resolve to unique apps.",
        {
          detail: { appIds: duplicates },
          userAction: "Remove duplicate member references and retry."
        }
      );
    }

    try {
      const definition = this.store.createDefinition(
        name,
        normalizedName,
        resolved.map((app) => app.id)
      );
      this.#publishEvent?.({
        type: "package.created",
        data: {
          packageId: definition.id,
          name: definition.name,
          revision: definition.revision,
          memberCount: definition.memberAppIds.length
        }
      });
      return definition;
    } catch (error) {
      if (/UNIQUE constraint failed/i.test(error instanceof Error ? error.message : String(error))) {
        throw new AppPackageServiceError(409, "PACKAGE_NAME_CONFLICT", `Package name ${name} is already in use.`, {
          userAction: "Refresh the package list and choose a unique name."
        });
      }
      throw error;
    }
  }

  deleteDefinition(id: string): AppPackageDefinition {
    this.#assertAccepting();
    const definition = this.getDefinition(id);
    const active = this.store.listRunsForPackage(id).find((run) => !isTerminalRunStatus(run.status));
    if (active) {
      throw new AppPackageServiceError(409, "PACKAGE_RUN_ACTIVE", "Package cannot be deleted while a run is active.", {
        retryable: true,
        detail: { runId: active.id },
        userAction: "Abort or wait for the active package run, then retry deletion."
      });
    }
    this.store.deleteDefinition(id);
    this.#publishEvent?.({
      type: "package.deleted",
      data: {
        packageId: definition.id,
        name: definition.name,
        revision: definition.revision,
        memberCount: definition.memberAppIds.length
      }
    });
    return definition;
  }

  async previewDefinitionChange(
    id: string,
    raw: { expectedRevision?: unknown; change?: unknown }
  ): Promise<AppPackageDefinitionChangePreview> {
    this.#assertAccepting();
    this.#pruneBindings();
    const definition = this.getDefinition(id);
    const expectedRevision = packageRevision(raw.expectedRevision);
    if (definition.revision !== expectedRevision) {
      throw stalePackagePreview("Package revision changed before the update preview was created.");
    }
    const change = packageDefinitionChange(raw.change);
    const apps = await this.#registry.list();
    let proposedName = definition.name;
    let proposedNormalizedName = definition.normalizedName;
    let proposedMemberAppIds = [...definition.memberAppIds];

    switch (change.kind) {
      case "add-member": {
        const appId = exactRegisteredAppId(change.appId, apps);
        if (!proposedMemberAppIds.includes(appId)) {
          if (proposedMemberAppIds.length >= MAX_PACKAGE_MEMBERS) {
            throw new AppPackageServiceError(
              409,
              "PACKAGE_MEMBERS_FULL",
              "Package already has the maximum number of members.",
              {
                userAction: "Remove another app from the package before adding this app."
              }
            );
          }
          proposedMemberAppIds.push(appId);
        }
        break;
      }
      case "rename":
        proposedName = packageName(change.name);
        proposedNormalizedName = normalizeName(proposedName);
        assertPackageNameAvailable(this.store, definition.id, proposedName, proposedNormalizedName);
        break;
      case "replace-members":
        proposedMemberAppIds = exactRegisteredAppIds(change.memberAppIds, apps);
        break;
    }

    const noop = proposedName === definition.name && equalStrings(proposedMemberAppIds, definition.memberAppIds);
    const active = this.#activeRun(id);
    const blockers = active
      ? [
          {
            code: "PACKAGE_RUN_ACTIVE" as const,
            message: "Package definition cannot change while a package run is active."
          }
        ]
      : [];
    const preview: AppPackageDefinitionChangePreview = {
      noop,
      canApply: !noop && blockers.length === 0,
      change: { kind: change.kind },
      package: {
        id: definition.id,
        currentName: definition.name,
        proposedName,
        currentRevision: definition.revision,
        proposedRevision: definition.revision + (noop ? 0 : 1),
        currentMemberAppIds: [...definition.memberAppIds],
        proposedMemberAppIds: [...proposedMemberAppIds]
      },
      ...(active ? { activeRun: { id: active.id, status: active.status } } : {}),
      blockers,
      preserved: { stablePackageId: definition.id, appLifecycle: true, routes: true, historicalRuns: true }
    };
    if (!preview.canApply) {
      return preview;
    }

    const now = Date.now();
    const previewId = `pkg_preview_${randomUUID()}`;
    const binding: PackageChangeBinding = {
      previewId,
      packageId: definition.id,
      expectedRevision: definition.revision,
      kind: change.kind,
      proposedName,
      proposedNormalizedName,
      proposedMemberAppIds: [...proposedMemberAppIds],
      proposedHash: packageDefinitionHash(proposedName, proposedMemberAppIds),
      createdAt: now,
      expiresAt: now + PACKAGE_CHANGE_PREVIEW_TTL_MS
    };
    this.#changeBindings.set(previewId, binding);
    preview.previewId = previewId;
    preview.expiresAt = new Date(binding.expiresAt).toISOString();
    return preview;
  }

  async applyDefinitionChange(
    id: string,
    previewId: string,
    correlationId?: string
  ): Promise<AppPackageDefinitionChangeResult> {
    this.#assertAccepting();
    return this.#withDefinitionGate(id, async () => {
      this.#pruneBindings();
      const binding = this.#changeBindings.get(previewId);
      if (!binding || binding.packageId !== id) {
        throw stalePackagePreview("Package update preview is missing, expired, or belongs to another package.");
      }
      const definition = this.getDefinition(id);
      if (definition.revision !== binding.expectedRevision) {
        throw stalePackagePreview("Package revision changed after the update preview was created.");
      }
      assertNoActivePackageRun(this.store, id);
      const apps = await this.#registry.list();
      exactRegisteredAppIds(binding.proposedMemberAppIds, apps);
      const current = this.getDefinition(id);
      if (current.revision !== binding.expectedRevision) {
        throw stalePackagePreview("Package revision changed while the update was being revalidated.");
      }
      assertNoActivePackageRun(this.store, id);
      assertPackageNameAvailable(this.store, id, binding.proposedName, binding.proposedNormalizedName);
      if (packageDefinitionHash(binding.proposedName, binding.proposedMemberAppIds) !== binding.proposedHash) {
        throw stalePackagePreview("Package update preview integrity check failed.");
      }
      let updated: AppPackageDefinition | undefined;
      try {
        updated = this.store.updateDefinition(id, binding.expectedRevision, {
          name: binding.proposedName,
          normalizedName: binding.proposedNormalizedName,
          memberAppIds: binding.proposedMemberAppIds
        });
      } catch (error) {
        if (/UNIQUE constraint failed/i.test(error instanceof Error ? error.message : String(error))) {
          throw new AppPackageServiceError(409, "PACKAGE_NAME_CONFLICT", "Package name is already in use.", {
            userAction: "Refresh packages and choose a unique package name."
          });
        }
        throw error;
      }
      if (!updated) {
        throw stalePackagePreview("Package revision changed before the update could be committed.");
      }
      this.#changeBindings.delete(previewId);
      this.#publishEvent?.({
        type: "package.updated",
        ...(correlationId ? { correlationId } : {}),
        data: {
          packageId: updated.id,
          name: updated.name,
          revision: updated.revision,
          memberCount: updated.memberAppIds.length,
          changeKind: binding.kind
        }
      });
      return { updated: true, changeKind: binding.kind, package: updated };
    });
  }

  previewDeleteDefinition(id: string, rawExpectedRevision: unknown): AppPackageDeletePreview {
    this.#assertAccepting();
    this.#pruneBindings();
    const definition = this.getDefinition(id);
    const expectedRevision = packageRevision(rawExpectedRevision);
    if (definition.revision !== expectedRevision) {
      throw stalePackagePreview("Package revision changed before the delete preview was created.");
    }
    const runs = this.store.listRunsForPackage(id);
    const active = runs.find((run) => !isTerminalRunStatus(run.status));
    const blockers = active
      ? [{ code: "PACKAGE_RUN_ACTIVE" as const, message: "Package cannot be deleted while a run is active." }]
      : [];
    const preview: AppPackageDeletePreview = {
      canDelete: blockers.length === 0,
      package: {
        id: definition.id,
        name: definition.name,
        revision: definition.revision,
        memberAppIds: [...definition.memberAppIds]
      },
      ...(active ? { activeRun: { id: active.id, status: active.status } } : {}),
      historicalRunCount: runs.filter((run) => isTerminalRunStatus(run.status)).length,
      blockers,
      preserved: { apps: true, projectFiles: true, manifests: true, historicalRuns: true }
    };
    if (!preview.canDelete) {
      return preview;
    }
    const now = Date.now();
    const previewId = `pkg_delete_${randomUUID()}`;
    const binding: PackageDeleteBinding = {
      previewId,
      packageId: definition.id,
      expectedRevision: definition.revision,
      createdAt: now,
      expiresAt: now + PACKAGE_CHANGE_PREVIEW_TTL_MS
    };
    this.#deleteBindings.set(previewId, binding);
    preview.previewId = previewId;
    preview.expiresAt = new Date(binding.expiresAt).toISOString();
    return preview;
  }

  async applyDeleteDefinition(id: string, previewId: string, correlationId?: string): Promise<AppPackageDeleteResult> {
    this.#assertAccepting();
    return this.#withDefinitionGate(id, async () => {
      this.#pruneBindings();
      const binding = this.#deleteBindings.get(previewId);
      if (!binding || binding.packageId !== id) {
        throw stalePackagePreview("Package delete preview is missing, expired, or belongs to another package.");
      }
      const definition = this.getDefinition(id);
      if (definition.revision !== binding.expectedRevision) {
        throw stalePackagePreview("Package revision changed after the delete preview was created.");
      }
      assertNoActivePackageRun(this.store, id);
      if (!this.store.deleteDefinitionAtRevision(id, binding.expectedRevision)) {
        throw stalePackagePreview("Package revision changed before deletion could be committed.");
      }
      this.#deleteBindings.delete(previewId);
      const preserved = {
        apps: true as const,
        projectFiles: true as const,
        manifests: true as const,
        historicalRuns: true as const
      };
      this.#publishEvent?.({
        type: "package.deleted",
        ...(correlationId ? { correlationId } : {}),
        data: {
          packageId: definition.id,
          name: definition.name,
          revision: definition.revision,
          memberCount: definition.memberAppIds.length
        }
      });
      return { deleted: true, package: definition, preserved };
    });
  }

  launch(id: string, correlationId: string): AppPackageRun {
    this.#assertAccepting();
    const definition = this.getDefinition(id);
    const active = this.store.listRunsForPackage(id).find((run) => !isTerminalRunStatus(run.status));
    if (active) {
      throw new AppPackageServiceError(409, "PACKAGE_RUN_ACTIVE", "A package run is already active.", {
        retryable: true,
        detail: { runId: active.id },
        userAction: "Inspect, abort, or wait for the active run before launching again."
      });
    }
    const run = this.store.createRun(
      definition,
      definition.memberAppIds.map((appId, ordinal) => ({ ordinal, appId }))
    );
    this.#startExecution(run.id, correlationId);
    return run;
  }

  getRun(id: string): AppPackageRun {
    const run = this.store.getRun(id);
    if (!run) {
      throw runNotFound(id);
    }
    return run;
  }

  retryRun(id: string, correlationId: string): AppPackageRun {
    this.#assertAccepting();
    const previous = this.getRun(id);
    if (!isTerminalRunStatus(previous.status) || previous.status === "succeeded") {
      throw new AppPackageServiceError(
        409,
        "PACKAGE_RUN_NOT_RETRYABLE",
        "Only terminal unsuccessful package runs can be retried.",
        {
          userAction: "Wait for the run to finish or launch the package again after a successful run."
        }
      );
    }
    const definition = this.getDefinition(previous.packageId);
    const active = this.store.listRunsForPackage(definition.id).find((run) => !isTerminalRunStatus(run.status));
    if (active) {
      throw new AppPackageServiceError(409, "PACKAGE_RUN_ACTIVE", "A package run is already active.", {
        retryable: true,
        detail: { runId: active.id },
        userAction: "Inspect, abort, or wait for the active run before retrying another package run."
      });
    }
    const retryMembers = previous.members.filter(memberIsRetryable).map((member) => ({
      ordinal: member.ordinal,
      appId: member.appId
    }));
    if (retryMembers.length === 0) {
      throw new AppPackageServiceError(
        409,
        "PACKAGE_RUN_NO_RETRYABLE_MEMBERS",
        "Package run has no failed or skipped members to retry.",
        {
          userAction: "Launch the current package definition to create a new full run."
        }
      );
    }
    const run = this.store.createRun(definition, retryMembers, { retryOfRunId: previous.id });
    this.#startExecution(run.id, correlationId);
    return run;
  }

  abortRun(id: string): AppPackageRun {
    const run = this.getRun(id);
    if (isTerminalRunStatus(run.status)) {
      return run;
    }
    return this.store.requestAbort(id);
  }

  async waitForRun(id: string): Promise<AppPackageRun> {
    await this.#executions.get(id);
    return this.getRun(id);
  }

  async shutdown(): Promise<void> {
    this.requestAbortAll();
    await Promise.allSettled(this.#executions.values());
    this.#changeBindings.clear();
    this.#deleteBindings.clear();
    this.store.close();
  }

  requestAbortAll(): void {
    this.#accepting = false;
    for (const runId of this.#executions.keys()) {
      this.store.requestAbort(runId);
    }
  }

  #startExecution(runId: string, correlationId: string): void {
    const execution = Promise.resolve()
      .then(() => this.#executeRun(runId, correlationId))
      .catch((error) => this.#failUnexpectedRun(runId, error))
      .finally(() => this.#executions.delete(runId));
    this.#executions.set(runId, execution);
  }

  async #executeRun(runId: string, correlationId: string): Promise<void> {
    this.store.updateRunStatus(runId, "running");
    const initial = this.getRun(runId);
    const apps = await this.#registry.list();
    const registered = new Set(apps.map((app) => app.id));
    const missing = initial.members.filter((member) => !registered.has(member.appId));
    if (missing.length > 0) {
      const now = new Date().toISOString();
      const missingIds = new Set(missing.map((member) => member.appId));
      for (const member of initial.members) {
        this.store.updateRunMember(runId, member.ordinal, {
          state: missingIds.has(member.appId) ? "failed" : "skipped_preflight",
          errorCode: "PACKAGE_MEMBER_NOT_REGISTERED",
          errorMessage: missingIds.has(member.appId)
            ? "Package member is no longer registered."
            : "Package launch was skipped because preflight found an unregistered member.",
          retryable: true,
          finishedAt: now
        });
      }
      this.store.updateRunStatus(runId, "failed");
      return;
    }

    const statuses = await this.#listAppStatuses();
    const statusById = new Map(statuses.map((status) => [status.id, status]));
    for (const member of initial.members) {
      const status = statusById.get(member.appId);
      if (status?.runtime.status === "running" && status.runtime.health === "healthy") {
        const now = new Date().toISOString();
        this.store.updateRunMember(runId, member.ordinal, {
          state: "skipped_already_running",
          retryable: false,
          startedAt: now,
          finishedAt: now
        });
      }
    }

    let cursor = 0;
    const eligible = this.getRun(runId).members.filter((member) => member.state === "pending");
    const worker = async (): Promise<void> => {
      while (true) {
        const currentRun = this.getRun(runId);
        if (currentRun.abortRequested) {
          return;
        }
        const index = cursor++;
        const member = eligible[index];
        if (!member) {
          return;
        }
        await this.#startMember(runId, member, correlationId);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.#concurrency, eligible.length) }, () => worker()));

    let completed = this.getRun(runId);
    if (completed.abortRequested) {
      const now = new Date().toISOString();
      for (const member of completed.members.filter((candidate) => candidate.state === "pending")) {
        this.store.updateRunMember(runId, member.ordinal, {
          state: "skipped_aborted",
          errorCode: "PACKAGE_RUN_ABORTED",
          errorMessage: "Package run was aborted before this member was enqueued.",
          retryable: true,
          finishedAt: now
        });
      }
      this.store.updateRunStatus(runId, "aborted");
      return;
    }

    completed = this.getRun(runId);
    const succeeded = completed.members.filter(memberSucceeded).length;
    const failed = completed.members.filter((member) => member.state === "failed").length;
    this.store.updateRunStatus(runId, failed === 0 ? "succeeded" : succeeded > 0 ? "partial" : "failed");
  }

  async #startMember(runId: string, member: AppPackageRunMember, correlationId: string): Promise<void> {
    const startedAt = new Date().toISOString();
    this.store.updateRunMember(runId, member.ordinal, { state: "starting", startedAt });
    try {
      const handle = this.#enqueueLifecycle({
        appId: member.appId,
        correlationId: `${correlationId}:package:${runId}:${member.ordinal}`
      });
      this.store.updateRunMember(runId, member.ordinal, { lifecycleOperationId: handle.operationId });
      const operation = await handle.done;
      const finishedAt = new Date().toISOString();
      if (operation.status === "succeeded") {
        this.store.updateRunMember(runId, member.ordinal, {
          state: "started",
          retryable: false,
          finishedAt
        });
        return;
      }
      this.store.updateRunMember(runId, member.ordinal, {
        state: "failed",
        errorCode: operation.error?.code ?? "PACKAGE_MEMBER_START_FAILED",
        errorMessage: "App lifecycle start did not succeed; inspect the linked lifecycle operation.",
        retryable: operation.error?.retryable ?? true,
        finishedAt
      });
    } catch (error) {
      this.store.updateRunMember(runId, member.ordinal, {
        state: "failed",
        errorCode: packageMemberErrorCode(error),
        errorMessage: safeMemberErrorMessage(error),
        retryable: true,
        finishedAt: new Date().toISOString()
      });
    }
  }

  #failUnexpectedRun(runId: string, error: unknown): void {
    const run = this.store.getRun(runId);
    if (!run || isTerminalRunStatus(run.status)) {
      return;
    }
    const now = new Date().toISOString();
    for (const member of run.members.filter(
      (candidate) => candidate.state === "pending" || candidate.state === "starting"
    )) {
      this.store.updateRunMember(runId, member.ordinal, {
        state: "failed",
        errorCode: "PACKAGE_RUN_FAILED",
        errorMessage: safeMemberErrorMessage(error),
        retryable: true,
        finishedAt: now
      });
    }
    this.store.updateRunStatus(runId, "failed");
  }

  #assertAccepting(): void {
    if (!this.#accepting) {
      throw new AppPackageServiceError(503, "PACKAGE_SERVICE_SHUTTING_DOWN", "App package service is shutting down.", {
        retryable: true,
        userAction: "Wait for the Relaybase daemon to restart before retrying."
      });
    }
  }

  #activeRun(packageId: string): AppPackageRun | undefined {
    return this.store.listRunsForPackage(packageId).find((run) => !isTerminalRunStatus(run.status));
  }

  #pruneBindings(): void {
    const now = Date.now();
    for (const [id, binding] of this.#changeBindings) {
      if (binding.expiresAt <= now) this.#changeBindings.delete(id);
    }
    for (const [id, binding] of this.#deleteBindings) {
      if (binding.expiresAt <= now) this.#deleteBindings.delete(id);
    }
    trimOldestBindings(this.#changeBindings, MAX_PACKAGE_CHANGE_BINDINGS);
    trimOldestBindings(this.#deleteBindings, MAX_PACKAGE_CHANGE_BINDINGS);
  }

  async #withDefinitionGate<T>(packageId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#definitionGates.get(packageId) ?? Promise.resolve();
    let release = (): void => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => hold);
    this.#definitionGates.set(packageId, tail);
    await previous.catch(() => undefined);
    try {
      return await work();
    } finally {
      release();
      if (this.#definitionGates.get(packageId) === tail) {
        this.#definitionGates.delete(packageId);
      }
    }
  }
}

type ParsedPackageDefinitionChange =
  | { kind: "add-member"; appId: unknown }
  | { kind: "rename"; name: unknown }
  | { kind: "replace-members"; memberAppIds: unknown };

function packageDefinitionChange(value: unknown): ParsedPackageDefinitionChange {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw invalidPackageChange();
  }
  switch (value.kind) {
    case "add-member":
      return { kind: value.kind, appId: value.appId };
    case "rename":
      return { kind: value.kind, name: value.name };
    case "replace-members":
      return { kind: value.kind, memberAppIds: value.memberAppIds };
    default:
      throw invalidPackageChange();
  }
}

function packageRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new AppPackageServiceError(400, "PACKAGE_REVISION_INVALID", "Package revision must be a positive integer.", {
      userAction: "Refresh packages and submit the exact current revision."
    });
  }
  return value;
}

function exactRegisteredAppId(value: unknown, apps: AppRecord[]): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 200) {
    throw new AppPackageServiceError(400, "PACKAGE_MEMBER_INVALID", "Package member app id is invalid.", {
      userAction: "Use an exact current registered app id."
    });
  }
  const appId = value.normalize("NFKC").trim();
  if (!apps.some((app) => app.id === appId)) {
    throw new AppPackageServiceError(404, "PACKAGE_MEMBER_NOT_FOUND", `Registered app ${appId} was not found.`, {
      detail: { appId },
      userAction: "Refresh registered apps and use an exact current app id."
    });
  }
  return appId;
}

function exactRegisteredAppIds(value: unknown, apps: AppRecord[]): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PACKAGE_MEMBERS) {
    throw new AppPackageServiceError(
      400,
      "PACKAGE_MEMBERS_INVALID",
      `Package must contain 1 through ${MAX_PACKAGE_MEMBERS} members.`,
      { userAction: "Choose an ordered non-empty list of registered apps." }
    );
  }
  const appIds = value.map((member) => exactRegisteredAppId(member, apps));
  const duplicates = duplicateValues(appIds);
  if (duplicates.length > 0) {
    throw new AppPackageServiceError(400, "PACKAGE_MEMBER_DUPLICATE", "Package members must be unique.", {
      detail: { appIds: duplicates },
      userAction: "Remove duplicate apps and retry."
    });
  }
  return appIds;
}

function assertPackageNameAvailable(
  store: AppPackageStore,
  packageId: string,
  name: string,
  normalizedName: string
): void {
  if (RESERVED_PACKAGE_NAMES.has(normalizedName)) {
    throw new AppPackageServiceError(400, "PACKAGE_NAME_RESERVED", "Package name conflicts with a slash command.", {
      userAction: "Choose a package name that is not a Relaybase slash command."
    });
  }
  const existing = store.getDefinitionByNormalizedName(normalizedName);
  if (existing && existing.id !== packageId) {
    throw new AppPackageServiceError(409, "PACKAGE_NAME_CONFLICT", `Package name ${name} is already in use.`, {
      userAction: "Choose a unique package name."
    });
  }
}

function assertNoActivePackageRun(store: AppPackageStore, packageId: string): void {
  const active = store.listRunsForPackage(packageId).find((run) => !isTerminalRunStatus(run.status));
  if (active) {
    throw new AppPackageServiceError(
      409,
      "PACKAGE_RUN_ACTIVE",
      "Package definition cannot change while a run is active.",
      {
        retryable: true,
        detail: { runId: active.id },
        userAction: "Abort or wait for the active package run, then request a new preview."
      }
    );
  }
}

function invalidPackageChange(): AppPackageServiceError {
  return new AppPackageServiceError(400, "PACKAGE_CHANGE_INVALID", "Package change request is invalid.", {
    userAction: "Use add-member, rename, or replace-members with the documented fields."
  });
}

function stalePackagePreview(message: string): AppPackageServiceError {
  return new AppPackageServiceError(409, "PACKAGE_PREVIEW_STALE", message, {
    retryable: true,
    userAction: "Refresh packages, request a new preview, and confirm that exact preview."
  });
}

function packageDefinitionHash(name: string, memberAppIds: string[]): string {
  return createHash("sha256").update(JSON.stringify({ name, memberAppIds })).digest("hex");
}

function equalStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function trimOldestBindings<T extends { createdAt: number }>(bindings: Map<string, T>, limit: number): void {
  while (bindings.size > limit) {
    const oldest = [...bindings.entries()].sort((left, right) => left[1].createdAt - right[1].createdAt)[0];
    if (!oldest) return;
    bindings.delete(oldest[0]);
  }
}

function packageName(value: unknown): string {
  if (typeof value !== "string") {
    throw invalidPackageName();
  }
  const name = value.normalize("NFKC").trim();
  if (name.length < 1 || name.length > 64 || hasControlCharacter(name)) {
    throw invalidPackageName();
  }
  return name;
}

function hasControlCharacter(value: string): boolean {
  return /[\p{Cc}\p{Cf}]/u.test(value);
}

function invalidPackageName(): AppPackageServiceError {
  return new AppPackageServiceError(
    400,
    "PACKAGE_NAME_INVALID",
    "Package name must contain 1 through 64 visible characters.",
    {
      userAction: "Provide a short visible package name without control characters."
    }
  );
}

function packageMemberReferences(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PACKAGE_MEMBERS) {
    throw new AppPackageServiceError(
      400,
      "PACKAGE_MEMBERS_INVALID",
      `Package must contain 1 through ${MAX_PACKAGE_MEMBERS} members.`,
      {
        userAction: "Provide an ordered array of registered app display names or ids."
      }
    );
  }
  return value.map((member) => {
    if (typeof member !== "string" || member.trim() === "" || member.length > 200) {
      throw new AppPackageServiceError(400, "PACKAGE_MEMBER_INVALID", "Package member reference is invalid.", {
        userAction: "Use a non-empty registered app display name or exact app id."
      });
    }
    return member.normalize("NFKC").trim();
  });
}

function resolveMemberReference(reference: string, apps: AppRecord): never;
function resolveMemberReference(reference: string, apps: AppRecord[]): AppRecord;
function resolveMemberReference(reference: string, apps: AppRecord | AppRecord[]): AppRecord {
  const candidates = Array.isArray(apps) ? apps : [apps];
  const exactId = candidates.filter((app) => app.id === reference);
  if (exactId.length === 1) {
    return exactId[0] as AppRecord;
  }
  const normalized = normalizeName(reference);
  const displayMatches = candidates.filter((app) => normalizeName(app.name) === normalized);
  if (displayMatches.length === 1) {
    return displayMatches[0] as AppRecord;
  }
  if (displayMatches.length > 1) {
    throw new AppPackageServiceError(409, "PACKAGE_MEMBER_AMBIGUOUS", `Package member ${reference} is ambiguous.`, {
      detail: { candidateAppIds: displayMatches.map((app) => app.id).sort() },
      userAction: "Use an exact registered app id for this member."
    });
  }
  throw new AppPackageServiceError(404, "PACKAGE_MEMBER_NOT_FOUND", `Package member ${reference} was not found.`, {
    detail: { reference },
    userAction: "Refresh registered apps and use an exact display name or app id."
  });
}

function normalizeName(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function duplicateValues(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }
  return [...duplicates].sort();
}

function memberSucceeded(member: AppPackageRunMember): boolean {
  return member.state === "started" || member.state === "skipped_already_running";
}

function memberIsRetryable(member: AppPackageRunMember): boolean {
  return (
    member.state === "failed" ||
    member.state === "skipped_preflight" ||
    member.state === "skipped_aborted" ||
    member.state === "skipped_interrupted" ||
    member.state === "interrupted"
  );
}

function packageNotFound(id: string): AppPackageServiceError {
  return new AppPackageServiceError(404, "PACKAGE_NOT_FOUND", "App package was not found.", {
    detail: { packageId: id },
    userAction: "Refresh the package list and use a current package id."
  });
}

function runNotFound(id: string): AppPackageServiceError {
  return new AppPackageServiceError(404, "PACKAGE_RUN_NOT_FOUND", "App package run was not found.", {
    detail: { runId: id },
    userAction: "Refresh the package run status and use a current run id."
  });
}

function packageMemberErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "PACKAGE_MEMBER_START_FAILED";
}

function safeMemberErrorMessage(error: unknown): string {
  void error;
  return "App lifecycle start failed.";
}
