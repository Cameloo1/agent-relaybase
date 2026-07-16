import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { LifecycleOperation } from "./apiTypes.ts";
import type { RelaybaseRuntime } from "./server.ts";
import type { AppManifestInput, AppRecord } from "./types.ts";
import { normalizeManifest } from "./validation.ts";

const RENAME_PREVIEW_TTL_MS = 5 * 60 * 1000;
const MAX_RENAME_BINDINGS = 128;
const RENAME_RECOVERY_FILE = "app-rename-recovery.json";
const ALLOWED_RUNTIME_STATES = new Set(["stopped", "running", "errored", "conflict", "failed", "degraded"]);

export type AppRenameBlockerCode =
  | "APP_RENAME_RUNTIME_UNCERTAIN"
  | "APP_RENAME_TRANSITION_ACTIVE"
  | "APP_RENAME_OPERATION_ACTIVE"
  | "APP_RENAME_MANIFEST_MISSING"
  | "APP_RENAME_MANIFEST_INVALID"
  | "APP_RENAME_MANIFEST_MISMATCH"
  | "APP_RENAME_NAME_COLLISION";

export interface AppRenameBlocker {
  code: AppRenameBlockerCode;
  message: string;
}

export type AppRenameDisplayNameBehavior = "inherited" | "updated" | "preserved";

export interface AppRenamePreview {
  previewId?: string;
  expiresAt?: string;
  noop: boolean;
  canRename: boolean;
  app: {
    id: string;
    currentName: string;
    proposedName: string;
  };
  runtimeStatus: string;
  activeOperation?: Pick<LifecycleOperation, "operationId" | "operationType" | "status">;
  manifest: {
    path?: string;
    sourceRevision?: string;
    changes: Array<{ field: "name" | "relaybase.displayName"; before: string; after: string }>;
    displayNameBehavior: AppRenameDisplayNameBehavior;
    displayName?: string;
  };
  blockers: AppRenameBlocker[];
  preserved: {
    stableAppId: string;
    route: string;
    runningProcess: boolean;
    packages: true;
    logs: true;
    operationHistory: true;
    automation: true;
  };
  recoveryGuidance: string;
}

export interface AppRenameResult {
  renamed: true;
  app: { id: string; oldName: string; newName: string };
  manifestPath: string;
  runtimeStatus: string;
  preserved: AppRenamePreview["preserved"];
}

interface RenameBinding {
  previewId: string;
  stateDir: string;
  appId: string;
  oldName: string;
  newName: string;
  manifestPath: string;
  manifestHash: string;
  registryHash: string;
  sourceRevision: string;
  displayNameBehavior: AppRenameDisplayNameBehavior;
  createdAt: number;
  expiresAt: number;
}

type RenameRecoveryPhase = "prepared" | "manifest_written" | "registry_written";

interface RenameRecoveryRecord {
  appId: string;
  manifestPath: string;
  oldName: string;
  newName: string;
  beforeManifestHash: string;
  afterManifestHash: string;
  beforeRegistryHash: string;
  afterRegistryHash: string;
  phase: RenameRecoveryPhase;
  updatedAt: string;
}

interface RenameRecoveryFile {
  version: 1;
  records: RenameRecoveryRecord[];
}

interface ManifestRenamePlan {
  manifest: AppManifestInput;
  content: string;
  displayNameBehavior: AppRenameDisplayNameBehavior;
  displayName?: string;
  changes: AppRenamePreview["manifest"]["changes"];
}

const renameBindings = new Map<string, RenameBinding>();
const recoveryFileGates = new Map<string, Promise<void>>();

export class AppRenameError extends Error {
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

export function normalizeAppRenameName(value: unknown): string {
  if (typeof value !== "string") {
    throw invalidRenameName("App name must be a string.");
  }
  const name = value.trim();
  const length = Array.from(name).length;
  if (length < 1 || length > 80) {
    throw invalidRenameName("App name must contain 1 through 80 visible Unicode characters.");
  }
  if (/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(name) || Array.from(name).some(isExplicitInvisibleRenameCharacter)) {
    throw invalidRenameName("App name cannot contain terminal controls, newlines, or invisible formatting characters.");
  }
  return name;
}

export async function previewAppRename(
  runtime: RelaybaseRuntime,
  appId: string,
  requestedName: unknown
): Promise<AppRenamePreview> {
  pruneRenameBindings();
  const app = await runtime.registry.get(appId);
  if (!app) {
    throw new AppRenameError(404, "APP_NOT_REGISTERED", `Registered app ${appId} was not found.`, {
      retryable: false,
      detail: { appId },
      userAction: "Refresh /manage and choose an existing stable app id."
    });
  }

  const proposedName = normalizeAppRenameName(requestedName);
  const statuses = await runtime.processes.listStatuses();
  const status = statuses.find((candidate) => candidate.id === appId);
  const runtimeStatus = status?.runtime.status ?? "unknown";
  const activeOperation = runtime.operations.activeForTarget(appId);
  const blockers: AppRenameBlocker[] = [];
  const collision = await findRenameCollision(runtime, appId, proposedName);
  if (collision) {
    blockers.push({
      code: "APP_RENAME_NAME_COLLISION",
      message: `Name ${JSON.stringify(proposedName)} conflicts with registered app ${collision.id} (${collision.name}).`
    });
  }
  if (runtimeStatus === "starting" || runtimeStatus === "stopping") {
    blockers.push({
      code: "APP_RENAME_TRANSITION_ACTIVE",
      message: `App ${appId} is ${runtimeStatus}; wait for the lifecycle transition to finish.`
    });
  } else if (!ALLOWED_RUNTIME_STATES.has(runtimeStatus)) {
    blockers.push({
      code: "APP_RENAME_RUNTIME_UNCERTAIN",
      message: `App ${appId} runtime state is ${runtimeStatus}; rename requires current daemon-backed state.`
    });
  }
  if (activeOperation) {
    blockers.push({
      code: "APP_RENAME_OPERATION_ACTIVE",
      message: `Lifecycle operation ${activeOperation.operationId} is active for app ${appId}.`
    });
  }

  let manifestPath: string | undefined;
  let manifestHash: string | undefined;
  let registryHash: string | undefined;
  let sourceRevision: string | undefined;
  let plan: ManifestRenamePlan = {
    manifest: {},
    content: "",
    displayNameBehavior: "inherited",
    changes: [{ field: "name", before: app.name, after: proposedName }]
  };
  if (!app.manifestPath) {
    blockers.push({
      code: "APP_RENAME_MANIFEST_MISSING",
      message: "Rename requires a registered manifest-backed app."
    });
  } else {
    manifestPath = safeManifestPath(app.manifestPath);
    try {
      const raw = await fs.readFile(manifestPath, "utf8");
      const manifest = JSON.parse(raw) as AppManifestInput;
      const normalized = normalizeManifest(manifest, { manifestPath });
      if (normalized.id !== app.id || normalized.name !== app.name) {
        blockers.push({
          code: "APP_RENAME_MANIFEST_MISMATCH",
          message: "The registered manifest id or current name no longer matches daemon registry state."
        });
      } else {
        plan = buildManifestRenamePlan(manifest, app.name, proposedName, manifestPath);
        manifestHash = hashText(raw);
        registryHash = hashRegistryRecord(app);
        sourceRevision = hashText(`${manifestHash}:${registryHash}`);
      }
    } catch (error) {
      if (error instanceof AppRenameError) {
        throw error;
      }
      blockers.push({
        code: "APP_RENAME_MANIFEST_INVALID",
        message: `The registered manifest cannot be safely read and validated: ${safeErrorMessage(error)}`
      });
    }
  }

  const noop = proposedName === app.name;
  const canRename = blockers.length === 0;
  const previewId = canRename && !noop ? `rename_${randomUUID()}` : undefined;
  const expiresAt = previewId ? Date.now() + RENAME_PREVIEW_TTL_MS : undefined;
  if (previewId && expiresAt && manifestPath && manifestHash && registryHash && sourceRevision) {
    renameBindings.set(previewId, {
      previewId,
      stateDir: runtime.stateDir,
      appId,
      oldName: app.name,
      newName: proposedName,
      manifestPath,
      manifestHash,
      registryHash,
      sourceRevision,
      displayNameBehavior: plan.displayNameBehavior,
      createdAt: Date.now(),
      expiresAt
    });
    pruneRenameBindings();
  }

  return {
    ...(previewId ? { previewId } : {}),
    ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
    noop,
    canRename,
    app: { id: app.id, currentName: app.name, proposedName },
    runtimeStatus,
    ...(activeOperation
      ? {
          activeOperation: {
            operationId: activeOperation.operationId,
            operationType: activeOperation.operationType,
            status: activeOperation.status
          }
        }
      : {}),
    manifest: {
      ...(manifestPath ? { path: manifestPath } : {}),
      ...(sourceRevision ? { sourceRevision } : {}),
      changes: plan.changes,
      displayNameBehavior: plan.displayNameBehavior,
      ...(plan.displayName ? { displayName: plan.displayName } : {})
    },
    blockers,
    preserved: preservedRenameData(runtime, app, runtimeStatus),
    recoveryGuidance:
      blockers.length > 0
        ? "Resolve every blocker, refresh daemon state, and request a new rename preview."
        : noop
          ? "The requested name is already current; no mutation is required."
          : "Confirm this exact preview before it expires; request a new preview after any manifest or registry change."
  };
}

export async function applyAppRename(
  runtime: RelaybaseRuntime,
  appId: string,
  previewId: unknown
): Promise<AppRenameResult> {
  if (typeof previewId !== "string" || !previewId.trim()) {
    throw new AppRenameError(400, "APP_RENAME_PREVIEW_REQUIRED", "Rename apply requires a preview id.", {
      retryable: false,
      userAction: "Request a new rename preview from /manage and confirm that exact preview."
    });
  }
  const binding = renameBindings.get(previewId);
  if (!binding || binding.stateDir !== runtime.stateDir || binding.appId !== appId) {
    throw staleRenamePreview("Rename preview was not found or does not belong to this app.");
  }
  if (binding.expiresAt <= Date.now()) {
    renameBindings.delete(previewId);
    throw staleRenamePreview("Rename preview expired.");
  }

  try {
    return await runtime.operations.withTargetGate(appId, "app rename", async () => {
      const app = await runtime.registry.get(appId);
      if (!app || !app.manifestPath) {
        throw staleRenamePreview("The registered manifest binding is no longer available.");
      }
      if (app.name !== binding.oldName || hashRegistryRecord(app) !== binding.registryHash) {
        throw staleRenamePreview("Daemon registry state changed after the rename preview.");
      }
      const collision = await findRenameCollision(runtime, appId, binding.newName);
      if (collision) {
        throw new AppRenameError(
          409,
          "APP_RENAME_NAME_COLLISION",
          "The proposed app name now conflicts with another app.",
          {
            retryable: true,
            detail: { appId, conflictingAppId: collision.id },
            userAction: "Choose a unique app name and request a new preview."
          }
        );
      }
      const statuses = await runtime.processes.listStatuses();
      const runtimeStatus = statuses.find((candidate) => candidate.id === appId)?.runtime.status ?? "unknown";
      if (runtimeStatus === "starting" || runtimeStatus === "stopping" || !ALLOWED_RUNTIME_STATES.has(runtimeStatus)) {
        throw new AppRenameError(409, "APP_RENAME_RUNTIME_CHANGED", `App ${appId} is ${runtimeStatus}.`, {
          retryable: true,
          userAction: "Wait for current daemon state to settle, then request a new rename preview."
        });
      }
      const manifestPath = safeManifestPath(app.manifestPath);
      if (manifestPath !== binding.manifestPath) {
        throw staleRenamePreview("The registered manifest path changed after preview.");
      }
      const beforeContent = await fs.readFile(manifestPath, "utf8");
      if (hashText(beforeContent) !== binding.manifestHash) {
        throw staleRenamePreview("The manifest changed after the rename preview.");
      }
      const manifest = JSON.parse(beforeContent) as AppManifestInput;
      const normalized = normalizeManifest(manifest, { manifestPath });
      if (normalized.id !== appId || normalized.name !== binding.oldName) {
        throw staleRenamePreview("The manifest id or current name no longer matches the preview.");
      }
      const plan = buildManifestRenamePlan(manifest, binding.oldName, binding.newName, manifestPath);
      if (plan.displayNameBehavior !== binding.displayNameBehavior) {
        throw staleRenamePreview("Component display-name behavior changed after preview.");
      }
      const nextNormalized = normalizeManifest(plan.manifest, { manifestPath });
      const beforeManifestHash = hashText(beforeContent);
      const afterManifestHash = hashText(plan.content);
      const beforeRegistryHash = hashRegistryRecord(app);
      const afterRegistryHash = hashRegistryRecord(nextNormalized);
      const recovery: RenameRecoveryRecord = {
        appId,
        manifestPath,
        oldName: binding.oldName,
        newName: binding.newName,
        beforeManifestHash,
        afterManifestHash,
        beforeRegistryHash,
        afterRegistryHash,
        phase: "prepared",
        updatedAt: new Date().toISOString()
      };
      await putRecoveryRecord(runtime.stateDir, recovery);
      await writeTextAtomic(manifestPath, plan.content);
      await putRecoveryRecord(runtime.stateDir, {
        ...recovery,
        phase: "manifest_written",
        updatedAt: new Date().toISOString()
      });

      try {
        const renamed = await runtime.registry.upsertManifestAtomic(plan.manifest, { manifestPath });
        if (
          renamed.id !== appId ||
          renamed.name !== binding.newName ||
          hashRegistryRecord(renamed) !== afterRegistryHash
        ) {
          throw new Error("Registry persistence did not produce the previewed rename state.");
        }
      } catch (error) {
        try {
          await writeTextAtomic(manifestPath, beforeContent);
          await removeRecoveryRecord(runtime.stateDir, appId);
        } catch (rollbackError) {
          throw new AppRenameError(
            500,
            "APP_RENAME_RECOVERY_REQUIRED",
            "Manifest rename was written but registry synchronization and rollback both failed.",
            {
              retryable: false,
              detail: {
                appId,
                manifestPath,
                error: safeErrorMessage(error),
                rollbackError: safeErrorMessage(rollbackError)
              },
              userAction:
                "Restart Relaybase to run rename recovery. If recovery fails, restore manifest and registry names to the same value before retrying."
            }
          );
        }
        throw new AppRenameError(
          500,
          "APP_RENAME_REGISTRY_WRITE_FAILED",
          "Registry synchronization failed; the manifest was rolled back.",
          {
            retryable: true,
            detail: { appId, error: safeErrorMessage(error) },
            userAction: "Resolve state-directory write access, refresh /manage, and request a new rename preview."
          }
        );
      }

      await putRecoveryRecord(runtime.stateDir, {
        ...recovery,
        phase: "registry_written",
        updatedAt: new Date().toISOString()
      });
      await removeRecoveryRecord(runtime.stateDir, appId);
      renameBindings.delete(previewId);
      return {
        renamed: true,
        app: { id: appId, oldName: binding.oldName, newName: binding.newName },
        manifestPath,
        runtimeStatus,
        preserved: preservedRenameData(runtime, app, runtimeStatus)
      };
    });
  } catch (error) {
    if (error instanceof AppRenameError) {
      renameBindings.delete(previewId);
    }
    throw error;
  }
}

export async function recoverAppRenames(runtime: RelaybaseRuntime): Promise<void> {
  const recovery = await readRecoveryFile(runtime.stateDir);
  for (const record of recovery.records) {
    const app = await runtime.registry.get(record.appId);
    const manifestContent = await fs.readFile(record.manifestPath, "utf8").catch(() => undefined);
    const manifestHash = manifestContent === undefined ? "missing" : hashText(manifestContent);
    const registryHash = app ? hashRegistryRecord(app) : "missing";
    if (manifestHash === record.afterManifestHash && registryHash === record.afterRegistryHash) {
      await removeRecoveryRecord(runtime.stateDir, record.appId);
      continue;
    }
    if (manifestHash === record.beforeManifestHash && registryHash === record.beforeRegistryHash) {
      await removeRecoveryRecord(runtime.stateDir, record.appId);
      continue;
    }
    if (
      manifestContent !== undefined &&
      manifestHash === record.afterManifestHash &&
      registryHash === record.beforeRegistryHash
    ) {
      const manifest = JSON.parse(manifestContent) as AppManifestInput;
      const normalized = normalizeManifest(manifest, { manifestPath: record.manifestPath });
      if (normalized.id === record.appId && normalized.name === record.newName) {
        const persisted = await runtime.registry.upsertManifestAtomic(manifest, { manifestPath: record.manifestPath });
        if (hashRegistryRecord(persisted) === record.afterRegistryHash) {
          await removeRecoveryRecord(runtime.stateDir, record.appId);
          continue;
        }
      }
    }
    throw new AppRenameError(
      500,
      "APP_RENAME_RECOVERY_AMBIGUOUS",
      `Rename recovery is ambiguous for app ${record.appId}.`,
      {
        retryable: false,
        detail: { appId: record.appId, phase: record.phase, manifestPath: record.manifestPath },
        userAction: "Restore the manifest and registry to the same app name, then restart Relaybase."
      }
    );
  }
}

function buildManifestRenamePlan(
  manifest: AppManifestInput,
  oldName: string,
  newName: string,
  manifestPath: string
): ManifestRenamePlan {
  const next = structuredClone(manifest) as Record<string, unknown>;
  next.name = newName;
  let displayNameBehavior: AppRenameDisplayNameBehavior = "inherited";
  let displayName: string | undefined;
  const relaybase = next.relaybase;
  if (relaybase !== undefined) {
    if (!relaybase || typeof relaybase !== "object" || Array.isArray(relaybase)) {
      throw new Error("Manifest field relaybase must be an object before app rename.");
    }
    const metadata = relaybase as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(metadata, "displayName")) {
      if (typeof metadata.displayName !== "string" || !metadata.displayName.trim()) {
        throw new Error("Manifest field relaybase.displayName must be a non-empty string before app rename.");
      }
      displayName = metadata.displayName.trim();
      if (displayName === oldName) {
        metadata.displayName = newName;
        displayName = newName;
        displayNameBehavior = "updated";
      } else {
        displayNameBehavior = "preserved";
      }
    }
  }
  const renamedManifest = next as AppManifestInput;
  const normalized = normalizeManifest(renamedManifest, { manifestPath });
  if (normalized.name !== newName) {
    throw new Error("Renamed manifest did not normalize to the requested app name.");
  }
  const changes: ManifestRenamePlan["changes"] = [{ field: "name", before: oldName, after: newName }];
  if (displayNameBehavior === "updated") {
    changes.push({ field: "relaybase.displayName", before: oldName, after: newName });
  }
  return {
    manifest: renamedManifest,
    content: `${JSON.stringify(renamedManifest, null, 2)}\n`,
    displayNameBehavior,
    ...(displayName ? { displayName } : {}),
    changes
  };
}

async function findRenameCollision(
  runtime: RelaybaseRuntime,
  selectedAppId: string,
  proposedName: string
): Promise<AppRecord | undefined> {
  const candidate = collisionKey(proposedName);
  return (await runtime.registry.list()).find(
    (app) => app.id !== selectedAppId && (collisionKey(app.name) === candidate || collisionKey(app.id) === candidate)
  );
}

function collisionKey(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function isExplicitInvisibleRenameCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? -1;
  return (
    codePoint === 0x034f ||
    codePoint === 0x115f ||
    codePoint === 0x1160 ||
    (codePoint >= 0x17b4 && codePoint <= 0x17b5) ||
    (codePoint >= 0x180b && codePoint <= 0x180f) ||
    (codePoint >= 0xfff9 && codePoint <= 0xfffb)
  );
}

function safeManifestPath(manifestPath: string): string {
  if (!path.isAbsolute(manifestPath) || path.resolve(manifestPath) !== path.normalize(manifestPath)) {
    throw new AppRenameError(409, "APP_RENAME_MANIFEST_PATH_INVALID", "Registered manifest path is not canonical.", {
      retryable: false,
      detail: { manifestPath },
      userAction: "Re-register the app from its canonical manifest path before renaming it."
    });
  }
  return manifestPath;
}

function preservedRenameData(
  runtime: RelaybaseRuntime,
  app: AppRecord,
  runtimeStatus: string
): AppRenamePreview["preserved"] {
  return {
    stableAppId: app.id,
    route: app.protocol === "tcp" ? "" : `http://${app.id}.localhost:${runtime.port}`,
    runningProcess: runtimeStatus === "running",
    packages: true,
    logs: true,
    operationHistory: true,
    automation: true
  };
}

function invalidRenameName(message: string): AppRenameError {
  return new AppRenameError(400, "APP_RENAME_NAME_INVALID", message, {
    retryable: false,
    userAction: "Choose a 1-80 character visible app name without terminal controls, newlines, or invisible formatting."
  });
}

function staleRenamePreview(message: string): AppRenameError {
  return new AppRenameError(409, "APP_RENAME_PREVIEW_STALE", message, {
    retryable: true,
    userAction: "Refresh /manage, request a new rename preview, and confirm that exact preview."
  });
}

function pruneRenameBindings(): void {
  const now = Date.now();
  for (const [id, binding] of renameBindings) {
    if (binding.expiresAt <= now) renameBindings.delete(id);
  }
  while (renameBindings.size > MAX_RENAME_BINDINGS) {
    const oldest = [...renameBindings.values()].sort((left, right) => left.createdAt - right.createdAt)[0];
    if (!oldest) break;
    renameBindings.delete(oldest.previewId);
  }
}

function hashRegistryRecord(app: AppRecord): string {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...durable } = app;
  return hashText(stableJson(durable));
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function recoveryPath(stateDir: string): string {
  return path.join(stateDir, RENAME_RECOVERY_FILE);
}

async function readRecoveryFile(stateDir: string): Promise<RenameRecoveryFile> {
  try {
    const parsed = JSON.parse(await fs.readFile(recoveryPath(stateDir), "utf8")) as RenameRecoveryFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.records)) throw new Error("Unsupported rename recovery format.");
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, records: [] };
    throw error;
  }
}

async function putRecoveryRecord(stateDir: string, record: RenameRecoveryRecord): Promise<void> {
  await mutateRecoveryFile(stateDir, (file) => ({
    version: 1,
    records: [...file.records.filter((candidate) => candidate.appId !== record.appId), record]
  }));
}

async function removeRecoveryRecord(stateDir: string, appId: string): Promise<void> {
  await mutateRecoveryFile(stateDir, (file) => ({
    version: 1,
    records: file.records.filter((candidate) => candidate.appId !== appId)
  }));
}

async function mutateRecoveryFile(
  stateDir: string,
  mutate: (file: RenameRecoveryFile) => RenameRecoveryFile
): Promise<void> {
  const key = path.resolve(stateDir);
  const previous = recoveryFileGates.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const file = await readRecoveryFile(stateDir);
      const updated = mutate(file);
      const filePath = recoveryPath(stateDir);
      if (updated.records.length === 0) {
        await fs.unlink(filePath).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
        return;
      }
      await writeTextAtomic(filePath, `${JSON.stringify(updated, null, 2)}\n`);
    });
  recoveryFileGates.set(key, next);
  try {
    await next;
  } finally {
    if (recoveryFileGates.get(key) === next) recoveryFileGates.delete(key);
  }
}

async function writeTextAtomic(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempPath, content, "utf8");
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return Array.from(message)
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? -1;
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ? " " : character;
    })
    .join("")
    .slice(0, 240);
}
