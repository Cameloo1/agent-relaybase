import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AgentSecurityRepairActionId,
  AgentSecurityRepairOperation,
  AgentSecurityRepairOutcome,
  AgentSecurityRepairPreview
} from "./types.ts";

const SCHEMA_VERSION = 1;

type SqlRow = Record<string, unknown>;

export interface AgentSecurityRepairBinding {
  configRevisionId: string;
  credentialIdentity: string;
  sourceFingerprint: string;
}

export class AgentSecurityRepairJournal {
  readonly dbPath: string;
  readonly #db: DatabaseSync;

  constructor(options: { stateDir?: string; restrictPath?: (target: string) => void } = {}) {
    const directory = options.stateDir ? path.join(options.stateDir, "agent") : undefined;
    if (directory) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.chmodSync(directory, 0o700);
      options.restrictPath?.(directory);
    }
    this.dbPath = directory ? path.join(directory, "repair.sqlite") : ":memory:";
    this.#db = new DatabaseSync(this.dbPath);
    this.#db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
    this.#initialize();
    if (this.dbPath !== ":memory:") {
      options.restrictPath?.(this.dbPath);
    }
    this.#db
      .prepare(
        "UPDATE repair_operations SET state = 'completed', outcome = 'interrupted', completed_at = ? WHERE state = 'running'"
      )
      .run(new Date().toISOString());
    this.expirePreviews();
  }

  close(): void {
    this.#db.close();
  }

  savePreview(preview: AgentSecurityRepairPreview, binding: AgentSecurityRepairBinding): void {
    this.expirePreviews();
    this.#db
      .prepare(
        `INSERT INTO repair_previews (
          preview_id, created_at, expires_at, expected_config_revision,
          expected_credential_identity, expected_source_fingerprint, preview_json, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`
      )
      .run(
        preview.previewId,
        preview.createdAt,
        preview.expiresAt,
        binding.configRevisionId,
        binding.credentialIdentity,
        binding.sourceFingerprint,
        JSON.stringify(preview)
      );
  }

  getPreview(
    previewId: string
  ): { preview: AgentSecurityRepairPreview; binding: AgentSecurityRepairBinding } | undefined {
    this.expirePreviews();
    const row = this.#db
      .prepare("SELECT * FROM repair_previews WHERE preview_id = ? AND status = 'active'")
      .get(previewId) as SqlRow | undefined;
    if (!row) {
      return undefined;
    }
    return {
      preview: JSON.parse(String(row.preview_json)) as AgentSecurityRepairPreview,
      binding: {
        configRevisionId: String(row.expected_config_revision),
        credentialIdentity: String(row.expected_credential_identity),
        sourceFingerprint: String(row.expected_source_fingerprint)
      }
    };
  }

  consumePreview(previewId: string): boolean {
    return (
      Number(
        this.#db
          .prepare("UPDATE repair_previews SET status = 'consumed' WHERE preview_id = ? AND status = 'active'")
          .run(previewId).changes
      ) === 1
    );
  }

  operationForIdempotency(idempotencyKey: string): AgentSecurityRepairOperation | undefined {
    const row = this.#db.prepare("SELECT * FROM repair_operations WHERE idempotency_key = ?").get(idempotencyKey) as
      | SqlRow
      | undefined;
    return row ? operationFromRow(row) : undefined;
  }

  beginOperation(previewId: string, idempotencyKey: string): AgentSecurityRepairOperation {
    const operation: AgentSecurityRepairOperation = {
      operationId: randomUUID(),
      previewId,
      state: "running",
      outcome: "interrupted",
      startedAt: new Date().toISOString(),
      appliedActionIds: [],
      remainingIssueCodes: [],
      requiresRestart: false,
      requiresExternalAction: false
    };
    this.#db
      .prepare(
        `INSERT INTO repair_operations (
          operation_id, preview_id, idempotency_key, started_at, state, outcome,
          applied_action_ids_json, remaining_issue_codes_json, requires_restart, requires_external_action
        ) VALUES (?, ?, ?, ?, 'running', 'interrupted', '[]', '[]', 0, 0)`
      )
      .run(operation.operationId, previewId, idempotencyKey, operation.startedAt);
    return operation;
  }

  completeOperation(
    operationId: string,
    input: {
      outcome: AgentSecurityRepairOutcome;
      appliedActionIds: AgentSecurityRepairActionId[];
      remainingIssueCodes: string[];
      requiresRestart: boolean;
      requiresExternalAction: boolean;
      errorCode?: string;
    }
  ): AgentSecurityRepairOperation {
    const completedAt = new Date().toISOString();
    this.#db
      .prepare(
        `UPDATE repair_operations SET
          state = 'completed', outcome = ?, completed_at = ?, applied_action_ids_json = ?,
          remaining_issue_codes_json = ?, requires_restart = ?, requires_external_action = ?, error_code = ?
        WHERE operation_id = ?`
      )
      .run(
        input.outcome,
        completedAt,
        JSON.stringify(input.appliedActionIds),
        JSON.stringify(input.remainingIssueCodes),
        input.requiresRestart ? 1 : 0,
        input.requiresExternalAction ? 1 : 0,
        input.errorCode ?? null,
        operationId
      );
    const operation = this.operation(operationId);
    if (!operation) {
      throw new Error("Agent security repair operation receipt was not persisted.");
    }
    return operation;
  }

  operation(operationId: string): AgentSecurityRepairOperation | undefined {
    const row = this.#db.prepare("SELECT * FROM repair_operations WHERE operation_id = ?").get(operationId) as
      | SqlRow
      | undefined;
    return row ? operationFromRow(row) : undefined;
  }

  latestOperation(): AgentSecurityRepairOperation | undefined {
    const row = this.#db
      .prepare("SELECT * FROM repair_operations ORDER BY started_at DESC, operation_id DESC LIMIT 1")
      .get() as SqlRow | undefined;
    return row ? operationFromRow(row) : undefined;
  }

  activeOperation(): AgentSecurityRepairOperation | undefined {
    const row = this.#db
      .prepare("SELECT * FROM repair_operations WHERE state = 'running' ORDER BY started_at DESC LIMIT 1")
      .get() as SqlRow | undefined;
    return row ? operationFromRow(row) : undefined;
  }

  expirePreviews(now = new Date().toISOString()): void {
    this.#db
      .prepare("UPDATE repair_previews SET status = 'expired' WHERE status = 'active' AND expires_at <= ?")
      .run(now);
  }

  #initialize(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS repair_previews (
        preview_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        expected_config_revision TEXT NOT NULL,
        expected_credential_identity TEXT NOT NULL,
        expected_source_fingerprint TEXT NOT NULL,
        preview_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'consumed', 'expired'))
      );
      CREATE TABLE IF NOT EXISTS repair_operations (
        operation_id TEXT PRIMARY KEY,
        preview_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        state TEXT NOT NULL CHECK (state IN ('running', 'completed')),
        outcome TEXT NOT NULL CHECK (outcome IN ('verified', 'partial', 'blocked', 'failed', 'interrupted')),
        applied_action_ids_json TEXT NOT NULL,
        remaining_issue_codes_json TEXT NOT NULL,
        requires_restart INTEGER NOT NULL,
        requires_external_action INTEGER NOT NULL,
        error_code TEXT
      );
    `);
    const version = this.#db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as
      | SqlRow
      | undefined;
    if (!version) {
      this.#db.prepare("INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
      return;
    }
    if (Number(version.value) !== SCHEMA_VERSION) {
      throw new Error("Agent security repair journal schema is unsupported.");
    }
  }
}

function operationFromRow(row: SqlRow): AgentSecurityRepairOperation {
  return {
    operationId: String(row.operation_id),
    previewId: String(row.preview_id),
    state: row.state === "running" ? "running" : "completed",
    outcome: String(row.outcome) as AgentSecurityRepairOutcome,
    startedAt: String(row.started_at),
    ...(row.completed_at ? { completedAt: String(row.completed_at) } : {}),
    appliedActionIds: JSON.parse(String(row.applied_action_ids_json)) as AgentSecurityRepairActionId[],
    remainingIssueCodes: JSON.parse(String(row.remaining_issue_codes_json)) as string[],
    requiresRestart: Number(row.requires_restart) === 1,
    requiresExternalAction: Number(row.requires_external_action) === 1,
    ...(row.error_code ? { errorCode: String(row.error_code) } : {})
  };
}
