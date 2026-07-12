import type { LifecycleOperation } from "./apiTypes.ts";
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

export interface AppPackageServiceOptions {
  stateDir: string;
  registry: Registry;
  listAppStatuses: () => Promise<AppStatusView[]>;
  enqueueLifecycle: EnqueuePackageMemberLifecycle;
  concurrency?: number;
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
  #concurrency: number;
  #executions = new Map<string, Promise<void>>();
  #accepting = true;

  constructor(options: AppPackageServiceOptions) {
    this.store = new AppPackageStore(options.stateDir);
    this.#registry = options.registry;
    this.#listAppStatuses = options.listAppStatuses;
    this.#enqueueLifecycle = options.enqueueLifecycle;
    this.#concurrency = Math.min(
      Math.max(options.concurrency ?? PACKAGE_LAUNCH_CONCURRENCY, 1),
      PACKAGE_LAUNCH_CONCURRENCY
    );
  }

  listDefinitions(): AppPackageDefinition[] {
    return this.store.listDefinitions();
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
      return this.store.createDefinition(
        name,
        normalizedName,
        resolved.map((app) => app.id)
      );
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
    return definition;
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
