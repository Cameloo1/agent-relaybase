import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type AppPackageRunStatus = "queued" | "running" | "succeeded" | "partial" | "failed" | "aborted" | "interrupted";

export type AppPackageMemberState =
  | "pending"
  | "starting"
  | "started"
  | "skipped_already_running"
  | "failed"
  | "skipped_preflight"
  | "skipped_aborted"
  | "skipped_interrupted"
  | "interrupted";

export interface AppPackageDefinition {
  id: string;
  name: string;
  normalizedName: string;
  memberAppIds: string[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface AppPackageRunMember {
  ordinal: number;
  appId: string;
  state: AppPackageMemberState;
  lifecycleOperationId?: string;
  errorCode?: string;
  errorMessage?: string;
  retryable?: boolean;
  startedAt?: string;
  finishedAt?: string;
}

export interface AppPackageRun {
  id: string;
  packageId: string;
  packageName: string;
  packageRevision: number;
  status: AppPackageRunStatus;
  abortRequested: boolean;
  retryOfRunId?: string;
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
  finishedAt?: string;
  members: AppPackageRunMember[];
}

interface PackageRow {
  package_id: string;
  name: string;
  normalized_name: string;
  member_ids_json: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  run_id: string;
  package_id: string;
  package_name: string;
  package_revision: number;
  status: AppPackageRunStatus;
  abort_requested: number;
  retry_of_run_id: string | null;
  created_at: string;
  started_at: string | null;
  updated_at: string;
  finished_at: string | null;
}

interface MemberRow {
  ordinal: number;
  app_id: string;
  state: AppPackageMemberState;
  lifecycle_operation_id: string | null;
  error_code: string | null;
  error_message: string | null;
  retryable: number | null;
  started_at: string | null;
  finished_at: string | null;
}

export class AppPackageStore {
  readonly dbPath: string;
  #db: DatabaseSync;
  #closed = false;

  constructor(stateDir: string) {
    const packageDir = path.join(stateDir, "packages");
    fs.mkdirSync(packageDir, { recursive: true });
    this.dbPath = path.join(packageDir, "packages.sqlite");
    this.#db = new DatabaseSync(this.dbPath);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS app_packages (
        package_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        normalized_name TEXT NOT NULL UNIQUE,
        member_ids_json TEXT NOT NULL,
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_package_runs (
        run_id TEXT PRIMARY KEY,
        package_id TEXT NOT NULL,
        package_name TEXT NOT NULL,
        package_revision INTEGER NOT NULL,
        status TEXT NOT NULL,
        abort_requested INTEGER NOT NULL DEFAULT 0,
        retry_of_run_id TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        updated_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS app_package_runs_package_idx
        ON app_package_runs(package_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS app_package_run_members (
        run_id TEXT NOT NULL REFERENCES app_package_runs(run_id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        app_id TEXT NOT NULL,
        state TEXT NOT NULL,
        lifecycle_operation_id TEXT,
        error_code TEXT,
        error_message TEXT,
        retryable INTEGER,
        started_at TEXT,
        finished_at TEXT,
        PRIMARY KEY (run_id, ordinal)
      );
    `);
    this.#reconcileInterruptedRuns();
  }

  listDefinitions(): AppPackageDefinition[] {
    this.#assertOpen();
    const rows = this.#db
      .prepare("SELECT * FROM app_packages ORDER BY normalized_name ASC, package_id ASC")
      .all() as unknown as PackageRow[];
    return rows.map(definitionFromRow);
  }

  getDefinition(id: string): AppPackageDefinition | undefined {
    this.#assertOpen();
    const row = this.#db.prepare("SELECT * FROM app_packages WHERE package_id = ?").get(id) as PackageRow | undefined;
    return row ? definitionFromRow(row) : undefined;
  }

  getDefinitionByNormalizedName(normalizedName: string): AppPackageDefinition | undefined {
    this.#assertOpen();
    const row = this.#db.prepare("SELECT * FROM app_packages WHERE normalized_name = ?").get(normalizedName) as
      | PackageRow
      | undefined;
    return row ? definitionFromRow(row) : undefined;
  }

  createDefinition(name: string, normalizedName: string, memberAppIds: string[]): AppPackageDefinition {
    this.#assertOpen();
    const now = new Date().toISOString();
    const definition: AppPackageDefinition = {
      id: `pkg_${randomUUID()}`,
      name,
      normalizedName,
      memberAppIds: [...memberAppIds],
      revision: 1,
      createdAt: now,
      updatedAt: now
    };
    this.#db
      .prepare(
        `INSERT INTO app_packages
          (package_id, name, normalized_name, member_ids_json, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        definition.id,
        definition.name,
        definition.normalizedName,
        JSON.stringify(definition.memberAppIds),
        definition.revision,
        definition.createdAt,
        definition.updatedAt
      );
    return snapshotDefinition(definition);
  }

  deleteDefinition(id: string): boolean {
    this.#assertOpen();
    return Number(this.#db.prepare("DELETE FROM app_packages WHERE package_id = ?").run(id).changes) > 0;
  }

  createRun(
    definition: AppPackageDefinition,
    members: Array<{ ordinal: number; appId: string }>,
    options: { retryOfRunId?: string } = {}
  ): AppPackageRun {
    this.#assertOpen();
    const now = new Date().toISOString();
    const run: AppPackageRun = {
      id: `pkg_run_${randomUUID()}`,
      packageId: definition.id,
      packageName: definition.name,
      packageRevision: definition.revision,
      status: "queued",
      abortRequested: false,
      ...(options.retryOfRunId ? { retryOfRunId: options.retryOfRunId } : {}),
      createdAt: now,
      updatedAt: now,
      members: members.map((member) => ({ ...member, state: "pending" }))
    };
    this.#transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO app_package_runs
            (run_id, package_id, package_name, package_revision, status, abort_requested,
             retry_of_run_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`
        )
        .run(
          run.id,
          run.packageId,
          run.packageName,
          run.packageRevision,
          run.status,
          run.retryOfRunId ?? null,
          run.createdAt,
          run.updatedAt
        );
      const insert = this.#db.prepare(
        `INSERT INTO app_package_run_members (run_id, ordinal, app_id, state) VALUES (?, ?, ?, ?)`
      );
      for (const member of run.members) {
        insert.run(run.id, member.ordinal, member.appId, member.state);
      }
    });
    return this.getRun(run.id) as AppPackageRun;
  }

  getRun(id: string): AppPackageRun | undefined {
    this.#assertOpen();
    const row = this.#db.prepare("SELECT * FROM app_package_runs WHERE run_id = ?").get(id) as RunRow | undefined;
    if (!row) {
      return undefined;
    }
    const members = this.#db
      .prepare("SELECT * FROM app_package_run_members WHERE run_id = ? ORDER BY ordinal ASC")
      .all(id) as unknown as MemberRow[];
    return runFromRows(row, members);
  }

  listRunsForPackage(packageId: string): AppPackageRun[] {
    this.#assertOpen();
    const rows = this.#db
      .prepare("SELECT run_id FROM app_package_runs WHERE package_id = ? ORDER BY created_at DESC")
      .all(packageId) as unknown as Array<{ run_id: string }>;
    return rows.map((row) => this.getRun(row.run_id)).filter((run): run is AppPackageRun => Boolean(run));
  }

  updateRunStatus(id: string, status: AppPackageRunStatus): AppPackageRun {
    this.#assertOpen();
    const now = new Date().toISOString();
    const terminal = isTerminalRunStatus(status);
    this.#db
      .prepare(
        `UPDATE app_package_runs SET status = ?,
          started_at = CASE WHEN ? = 'running' AND started_at IS NULL THEN ? ELSE started_at END,
          updated_at = ?, finished_at = CASE WHEN ? THEN ? ELSE finished_at END
         WHERE run_id = ?`
      )
      .run(status, status, now, now, terminal ? 1 : 0, now, id);
    return this.#requiredRun(id);
  }

  updateRunMember(id: string, ordinal: number, update: Partial<AppPackageRunMember>): AppPackageRun {
    this.#assertOpen();
    const current = this.#db
      .prepare("SELECT * FROM app_package_run_members WHERE run_id = ? AND ordinal = ?")
      .get(id, ordinal) as MemberRow | undefined;
    if (!current) {
      throw new Error(`Package run member ${id}/${ordinal} was not found.`);
    }
    const member = memberFromRow(current);
    const next = { ...member, ...update };
    this.#transaction(() => {
      this.#db
        .prepare(
          `UPDATE app_package_run_members SET state = ?, lifecycle_operation_id = ?, error_code = ?,
             error_message = ?, retryable = ?, started_at = ?, finished_at = ?
           WHERE run_id = ? AND ordinal = ?`
        )
        .run(
          next.state,
          next.lifecycleOperationId ?? null,
          next.errorCode ?? null,
          next.errorMessage ?? null,
          next.retryable === undefined ? null : next.retryable ? 1 : 0,
          next.startedAt ?? null,
          next.finishedAt ?? null,
          id,
          ordinal
        );
      this.#db.prepare("UPDATE app_package_runs SET updated_at = ? WHERE run_id = ?").run(new Date().toISOString(), id);
    });
    return this.#requiredRun(id);
  }

  requestAbort(id: string): AppPackageRun {
    this.#assertOpen();
    this.#db
      .prepare("UPDATE app_package_runs SET abort_requested = 1, updated_at = ? WHERE run_id = ?")
      .run(new Date().toISOString(), id);
    return this.#requiredRun(id);
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#db.close();
  }

  #requiredRun(id: string): AppPackageRun {
    const run = this.getRun(id);
    if (!run) {
      throw new Error(`Package run ${id} was not found.`);
    }
    return run;
  }

  #reconcileInterruptedRuns(): void {
    const now = new Date().toISOString();
    this.#transaction(() => {
      const runs = this.#db
        .prepare("SELECT run_id FROM app_package_runs WHERE status IN ('queued', 'running')")
        .all() as unknown as Array<{ run_id: string }>;
      for (const run of runs) {
        this.#db
          .prepare(
            `UPDATE app_package_run_members SET
               state = CASE WHEN state = 'starting' THEN 'interrupted' ELSE 'skipped_interrupted' END,
               error_code = 'PACKAGE_RUN_INTERRUPTED',
               error_message = 'Daemon restart interrupted this package member before completion was confirmed.',
               retryable = 1,
               finished_at = ?
             WHERE run_id = ? AND state IN ('pending', 'starting')`
          )
          .run(now, run.run_id);
        this.#db
          .prepare(
            `UPDATE app_package_runs SET status = 'interrupted', updated_at = ?, finished_at = ? WHERE run_id = ?`
          )
          .run(now, now, run.run_id);
      }
    });
  }

  #transaction<T>(work: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("App package store is closed.");
    }
  }
}

function definitionFromRow(row: PackageRow): AppPackageDefinition {
  const memberAppIds = JSON.parse(String(row.member_ids_json)) as unknown;
  if (!Array.isArray(memberAppIds) || memberAppIds.some((member) => typeof member !== "string")) {
    throw new Error(`App package ${row.package_id} has invalid member data.`);
  }
  return {
    id: String(row.package_id),
    name: String(row.name),
    normalizedName: String(row.normalized_name),
    memberAppIds: [...memberAppIds],
    revision: Number(row.revision),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function runFromRows(row: RunRow, members: MemberRow[]): AppPackageRun {
  return {
    id: String(row.run_id),
    packageId: String(row.package_id),
    packageName: String(row.package_name),
    packageRevision: Number(row.package_revision),
    status: row.status,
    abortRequested: Boolean(row.abort_requested),
    ...(row.retry_of_run_id ? { retryOfRunId: String(row.retry_of_run_id) } : {}),
    createdAt: String(row.created_at),
    ...(row.started_at ? { startedAt: String(row.started_at) } : {}),
    updatedAt: String(row.updated_at),
    ...(row.finished_at ? { finishedAt: String(row.finished_at) } : {}),
    members: members.map(memberFromRow)
  };
}

function memberFromRow(row: MemberRow): AppPackageRunMember {
  return {
    ordinal: Number(row.ordinal),
    appId: String(row.app_id),
    state: row.state,
    ...(row.lifecycle_operation_id ? { lifecycleOperationId: String(row.lifecycle_operation_id) } : {}),
    ...(row.error_code ? { errorCode: String(row.error_code) } : {}),
    ...(row.error_message ? { errorMessage: String(row.error_message) } : {}),
    ...(row.retryable === null ? {} : { retryable: Boolean(row.retryable) }),
    ...(row.started_at ? { startedAt: String(row.started_at) } : {}),
    ...(row.finished_at ? { finishedAt: String(row.finished_at) } : {})
  };
}

function snapshotDefinition(definition: AppPackageDefinition): AppPackageDefinition {
  return { ...definition, memberAppIds: [...definition.memberAppIds] };
}

export function isTerminalRunStatus(status: AppPackageRunStatus): boolean {
  return status !== "queued" && status !== "running";
}
