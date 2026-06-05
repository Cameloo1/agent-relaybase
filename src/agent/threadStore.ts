import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sanitizeAgentPayload } from "./errors.ts";
import { sanitizeSessionPayload, sanitizeSessionPayloadWithReport } from "./sessionSanitizer.ts";
import type {
  AgentAuditEvent,
  AgentApproval,
  AgentMessage,
  AgentRun,
  AgentRunEvent,
  AgentSession,
  AgentSessionCreateRequest,
  AgentSessionExportResult,
  AgentThreadContextPreview,
  AgentThreadPrivacy,
  AgentThreadSummary,
  AgentThreadUpdateRequest,
  TuiAgentContext
} from "./types.ts";

const THREAD_SCHEMA_VERSION = 1;
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_MAX_AUDIT_EVENTS = 2000;

export interface ThreadStoreOptions {
  stateDir: string;
  retentionDays?: number;
  maxAuditEvents?: number;
}

export interface ThreadStoreDiagnostic {
  code: string;
  message: string;
  detail?: unknown;
  at: string;
}

export interface AgentAuditAppendInput {
  type: string;
  provider?: AgentAuditEvent["provider"];
  modelSlug?: string;
  sessionId?: string;
  runId?: string;
  data: unknown;
  knownSecrets?: string[];
}

type SqlRow = Record<string, unknown>;

export class ThreadStore {
  readonly dbPath: string;
  #db: DatabaseSync;
  #diagnostics: ThreadStoreDiagnostic[] = [];
  #retentionMs: number;
  #maxAuditEvents: number;

  constructor(options: ThreadStoreOptions) {
    this.dbPath = path.join(options.stateDir, "agent", "agent.sqlite");
    this.#retentionMs = Math.max(1, options.retentionDays ?? DEFAULT_RETENTION_DAYS) * 24 * 60 * 60 * 1000;
    this.#maxAuditEvents = Math.max(1, options.maxAuditEvents ?? DEFAULT_MAX_AUDIT_EVENTS);
    this.#db = this.#openWithRecovery();
    this.#pruneExpired();
  }

  diagnostics(): ThreadStoreDiagnostic[] {
    return structuredClone(this.#diagnostics);
  }

  createSession(raw: AgentSessionCreateRequest, context: TuiAgentContext): AgentSession {
    const now = new Date().toISOString();
    const session: AgentSession = {
      id: randomUUID(),
      ...(raw.title ? { title: sanitizeSessionPayload(String(raw.title)) } : {}),
      createdAt: now,
      updatedAt: now,
      context: sanitizeSessionPayload(context),
      messages: [],
      runs: []
    };
    this.#transaction(() => {
      this.#insertThread(session, {
        titleSource: raw.title ? "user" : "auto",
        lastActiveAt: now
      });
      this.setActiveThread(session.id);
    });
    return this.getSession(session.id) ?? session;
  }

  listSessions(): AgentSession[] {
    const rows = this.#db
      .prepare("SELECT id FROM threads WHERE deleted_at IS NULL ORDER BY last_active_at DESC, updated_at DESC")
      .all();
    return rows
      .map((row) => this.getSession(String(row.id)))
      .filter((session): session is AgentSession => Boolean(session))
      .map((session) => this.summary(session));
  }

  getSession(sessionId: string): AgentSession | undefined {
    const row = this.#db.prepare("SELECT * FROM threads WHERE id = ? AND deleted_at IS NULL").get(sessionId) as
      | SqlRow
      | undefined;
    if (!row) {
      return undefined;
    }
    return this.#hydrateSession(row);
  }

  getActiveSession(): AgentSession | undefined {
    const activeId = this.getActiveThread();
    return activeId ? this.getSession(activeId) : undefined;
  }

  activateSession(sessionId: string): AgentSession | undefined {
    if (!this.#threadExists(sessionId)) {
      return undefined;
    }
    this.#touchThread(sessionId, new Date().toISOString());
    return this.getSession(sessionId);
  }

  updateSession(sessionId: string, raw: AgentThreadUpdateRequest, context?: TuiAgentContext): AgentSession | undefined {
    if (!this.#threadExists(sessionId)) {
      return undefined;
    }
    const session = this.getSession(sessionId);
    if (!session) {
      return undefined;
    }
    const now = new Date().toISOString();
    const title =
      raw.title === undefined ? session.title : String(sanitizeSessionPayload(raw.title)).trim() || undefined;
    const privacy = normalizePrivacy(raw.privacy, session.privacy);
    const nextContext = context ?? session.context;
    this.#transaction(() => {
      this.#db
        .prepare(
          `UPDATE threads SET
            title = ?,
            title_source = ?,
            context_json = ?,
            privacy_mode = ?,
            advanced_redacted_detail_enabled = ?,
            updated_at = ?,
            last_active_at = ?
          WHERE id = ? AND deleted_at IS NULL`
        )
        .run(
          title ?? null,
          raw.title !== undefined ? "user" : (session.titleSource ?? "auto"),
          json(nextContext),
          privacy.mode,
          privacy.advancedRedactedDetailEnabled ? 1 : 0,
          now,
          now,
          sessionId
        );
      if (raw.active !== false) {
        this.setActiveThread(sessionId);
      }
      this.#refreshThreadSummary(sessionId);
    });
    return this.getSession(sessionId);
  }

  appendMessage(sessionId: string, message: AgentMessage): AgentMessage | undefined {
    if (!this.#threadExists(sessionId)) {
      return undefined;
    }
    const sanitized = sanitizeSessionPayloadWithReport(message);
    const safeMessage = sanitized.value;
    this.#transaction(() => {
      this.#insertMessage(safeMessage, sanitized.redactionReport);
      this.#touchThread(sessionId, safeMessage.createdAt);
      this.#refreshThreadSummary(sessionId);
    });
    return safeMessage;
  }

  appendRun(sessionId: string, run: AgentRun): AgentRun | undefined {
    if (!this.#threadExists(sessionId)) {
      return undefined;
    }
    const safeRun = sanitizeSessionPayload(run);
    this.#transaction(() => {
      this.#upsertRun(safeRun);
      this.#touchThread(sessionId, safeRun.createdAt);
      this.#refreshThreadSummary(sessionId);
    });
    return safeRun;
  }

  updateRun(run: AgentRun): void {
    if (!this.#threadExists(run.sessionId)) {
      return;
    }
    const safeRun = sanitizeSessionPayload(run);
    this.#transaction(() => {
      this.#upsertRun(safeRun);
      this.#touchThread(safeRun.sessionId, safeRun.completedAt ?? safeRun.startedAt ?? safeRun.createdAt);
      this.#refreshThreadSummary(safeRun.sessionId);
    });
  }

  appendRunEvent(sessionId: string, runId: string | undefined, event: AgentRunEvent): AgentRunEvent | undefined {
    if (!runId || !this.#threadExists(sessionId) || !this.#runExists(runId)) {
      return undefined;
    }
    const sanitized = sanitizeSessionPayloadWithReport(event);
    const safeEvent = sanitized.value;
    this.#transaction(() => {
      this.#insertEvent(safeEvent, sanitized.redactionReport);
      this.#touchThread(sessionId, safeEvent.at);
      this.#refreshThreadSummary(sessionId);
    });
    return safeEvent;
  }

  updateContext(sessionId: string, context: TuiAgentContext): void {
    if (!this.#threadExists(sessionId)) {
      return;
    }
    const now = new Date().toISOString();
    const safeContext = sanitizeSessionPayload(context);
    this.#transaction(() => {
      this.#db
        .prepare("UPDATE threads SET context_json = ?, updated_at = ?, last_active_at = ? WHERE id = ?")
        .run(json(safeContext), now, now, sessionId);
      this.setActiveThread(sessionId);
      this.#refreshThreadSummary(sessionId);
    });
  }

  clearSession(sessionId: string, reason = "user_cleared"): boolean {
    const session = this.getSession(sessionId);
    if (!session) {
      return false;
    }
    const now = new Date().toISOString();
    this.#db
      .prepare("UPDATE threads SET deleted_at = ?, deleted_reason = ?, updated_at = ? WHERE id = ?")
      .run(now, reason, now, sessionId);
    if (this.getActiveThread() === sessionId) {
      this.#deleteMeta("active_thread_id");
    }
    return true;
  }

  persistSession(sessionId: string): void {
    if (this.#threadExists(sessionId)) {
      this.#touchThread(sessionId, new Date().toISOString());
    }
  }

  summary(session: AgentSession): AgentSession {
    return {
      ...session,
      messages: session.messages.slice(-5),
      runs: session.runs.slice(-5)
    };
  }

  maxEventSequence(): number {
    const row = this.#db.prepare("SELECT MAX(sequence) AS sequence FROM events").get() as SqlRow | undefined;
    return numberFromRow(row?.sequence) ?? 0;
  }

  setActiveThread(threadId: string): void {
    this.#setMeta("active_thread_id", threadId);
  }

  getActiveThread(): string | undefined {
    const active = this.#getMeta("active_thread_id");
    return active || undefined;
  }

  appendAudit(input: AgentAuditAppendInput): AgentAuditEvent {
    const event = sanitizeAgentPayload(
      {
        id: randomUUID(),
        at: new Date().toISOString(),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.runId ? { runId: input.runId } : {}),
        type: input.type,
        ...(input.provider ? { provider: input.provider } : {}),
        ...(input.modelSlug ? { modelSlug: input.modelSlug } : {}),
        data: input.data
      },
      input.knownSecrets ?? []
    ) as AgentAuditEvent;
    this.#transaction(() => {
      this.#insertAuditEvent(event);
      this.#pruneAuditEvents();
    });
    return structuredClone(event);
  }

  listAudit(filter: { sessionId?: string } = {}): AgentAuditEvent[] {
    const rows = filter.sessionId
      ? this.#db
          .prepare("SELECT * FROM audit_events WHERE thread_id = ? ORDER BY at ASC, rowid ASC")
          .all(filter.sessionId)
      : this.#db.prepare("SELECT * FROM audit_events ORDER BY at ASC, rowid ASC").all();
    return rows.map((row) => this.#auditFromRow(row));
  }

  sessionEvents(sessionId: string, afterSequence = 0): AgentRunEvent[] {
    if (!this.#threadExists(sessionId)) {
      return [];
    }
    return this.#db
      .prepare("SELECT * FROM events WHERE thread_id = ? AND sequence > ? ORDER BY sequence ASC, at ASC, rowid ASC")
      .all(sessionId, afterSequence)
      .map((row) => eventFromRow(row));
  }

  contextPreview(sessionId: string): AgentThreadContextPreview | undefined {
    const session = this.getSession(sessionId);
    if (!session) {
      return undefined;
    }
    const pendingApprovals = this.listPendingApprovals(sessionId);
    return {
      sessionId,
      active: this.getActiveThread() === sessionId,
      ...(session.title ? { title: session.title } : {}),
      summary: session.summary ?? this.#buildThreadSummary(sessionId),
      privacy: session.privacy ?? normalizePrivacy(),
      recentMessages: session.messages.filter((message) => message.role !== "tool").slice(-8),
      pendingApprovals,
      recallPolicy: {
        scope: "active_thread_only",
        includesRawSecrets: false,
        includesRawLogs: false,
        includesRawDiffs: false,
        extraModelCalls: false
      }
    };
  }

  recordExport(result: AgentSessionExportResult): void {
    this.#db
      .prepare(
        `INSERT INTO thread_exports (
          id, thread_id, format, output_path, generated_at, status, redaction_report_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        result.exportId,
        result.sessionId,
        result.format,
        result.outputPath,
        result.generatedAt,
        result.status,
        json(result.redactionReport)
      );
  }

  upsertApproval(approval: AgentApproval, rawArguments?: Record<string, unknown>): AgentApproval {
    if (!this.#threadExists(approval.sessionId)) {
      return structuredClone(approval);
    }
    const safeApproval = sanitizeSessionPayload(approval);
    const rawPersistence = persistableApprovalArguments(rawArguments);
    const recoveryState = safeApproval.recoveryState ?? "live";
    this.#transaction(() => {
      this.#insertApproval(
        {
          ...safeApproval,
          recoveryState,
          rawArgumentsPersisted: rawPersistence.persisted
        },
        rawPersistence.value
      );
      this.#refreshThreadSummary(approval.sessionId);
    });
    return this.getApproval(approval.id) ?? safeApproval;
  }

  getApproval(approvalId: string): AgentApproval | undefined {
    const row = this.#db.prepare("SELECT * FROM approvals WHERE id = ?").get(approvalId) as SqlRow | undefined;
    return row ? this.#approvalFromRow(row) : undefined;
  }

  rawApprovalArguments(approvalId: string): Record<string, unknown> | undefined {
    const row = this.#db.prepare("SELECT raw_arguments_json FROM approvals WHERE id = ?").get(approvalId) as
      | SqlRow
      | undefined;
    return row?.raw_arguments_json ? (parseJson(row.raw_arguments_json) as Record<string, unknown>) : undefined;
  }

  resolveApproval(approvalId: string, status: "approved" | "rejected"): AgentApproval | undefined {
    const approval = this.getApproval(approvalId);
    if (!approval) {
      return undefined;
    }
    const resolvedAt = new Date().toISOString();
    this.#transaction(() => {
      this.#db
        .prepare("UPDATE approvals SET status = ?, resolved_at = ?, recovery_state = ? WHERE id = ?")
        .run(status, resolvedAt, "live", approvalId);
      this.#refreshThreadSummary(approval.sessionId);
    });
    return this.getApproval(approvalId);
  }

  listPendingApprovals(sessionId?: string): AgentApproval[] {
    const sql = sessionId
      ? "SELECT * FROM approvals WHERE thread_id = ? AND status IN ('pending', 'recovered_pending') ORDER BY created_at ASC, rowid ASC"
      : "SELECT * FROM approvals WHERE status IN ('pending', 'recovered_pending') ORDER BY created_at ASC, rowid ASC";
    const rows = sessionId ? this.#db.prepare(sql).all(sessionId) : this.#db.prepare(sql).all();
    return rows.map((row) => this.#approvalFromRow(row));
  }

  recoverPendingApprovals(): AgentApproval[] {
    const pendingRows = this.#db
      .prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at ASC, rowid ASC")
      .all();
    const approvals = pendingRows.map((row) => this.#approvalFromRow(row));
    if (!approvals.length) {
      return [];
    }
    this.#transaction(() => {
      for (const approval of approvals) {
        this.#db
          .prepare("UPDATE approvals SET status = ?, recovery_state = ? WHERE id = ?")
          .run(
            "recovered_pending",
            approval.rawArgumentsPersisted ? "requires_reconfirm" : "raw_arguments_unavailable",
            approval.id
          );
        this.#refreshThreadSummary(approval.sessionId);
      }
    });
    return approvals
      .map((approval) => this.getApproval(approval.id))
      .filter((approval): approval is AgentApproval => Boolean(approval));
  }

  #openWithRecovery(): DatabaseSync {
    try {
      return this.#openAndInitialize();
    } catch (error) {
      this.#diagnostics.push({
        code: "AGENT_SQLITE_QUARANTINED",
        message: "Agent SQLite store was corrupt or unusable and was moved aside.",
        detail: sanitizeAgentPayload({ error, dbPath: this.dbPath }),
        at: new Date().toISOString()
      });
      this.#quarantineSqliteFiles();
      return this.#openAndInitialize();
    }
  }

  #openAndInitialize(): DatabaseSync {
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    const db = new DatabaseSync(this.dbPath);
    try {
      db.exec("PRAGMA foreign_keys = ON");
      db.exec("PRAGMA journal_mode = WAL");
      const integrity = db.prepare("PRAGMA integrity_check").get() as SqlRow | undefined;
      if (integrity && String(integrity.integrity_check) !== "ok") {
        throw new Error(`SQLite integrity_check failed: ${String(integrity.integrity_check)}`);
      }
      this.#withDb(db, () => {
        this.#migrate();
        this.#importLegacyStores();
      });
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  #withDb<T>(db: DatabaseSync, callback: () => T): T {
    const previous = this.#db;
    this.#db = db;
    try {
      return callback();
    } finally {
      this.#db = previous;
    }
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        title TEXT,
        title_source TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_active_at TEXT NOT NULL,
        deleted_at TEXT,
        deleted_reason TEXT,
        context_json TEXT,
        setup_json TEXT,
        summary_json TEXT,
        summary_updated_at TEXT,
        privacy_mode TEXT NOT NULL DEFAULT 'standard',
        advanced_redacted_detail_enabled INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        run_id TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        context_json TEXT,
        redaction_report_json TEXT,
        FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        status TEXT NOT NULL,
        provider TEXT NOT NULL,
        model_slug TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        diagnostic_json TEXT,
        usage_json TEXT,
        FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        run_id TEXT,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        at TEXT NOT NULL,
        data_json TEXT,
        visible INTEGER NOT NULL DEFAULT 1,
        redaction_report_json TEXT,
        FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE,
        FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        run_id TEXT,
        tool_call_id TEXT,
        tool_name TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        action TEXT NOT NULL,
        target TEXT,
        risk TEXT NOT NULL,
        expected_result TEXT NOT NULL,
        arguments_json TEXT,
        arguments_hash TEXT,
        context_json TEXT,
        preview_json TEXT,
        diagnostic_json TEXT,
        raw_arguments_json TEXT,
        raw_arguments_persisted INTEGER NOT NULL DEFAULT 0,
        recovery_state TEXT,
        FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        at TEXT NOT NULL,
        thread_id TEXT,
        run_id TEXT,
        type TEXT NOT NULL,
        provider TEXT,
        model_slug TEXT,
        data_json TEXT
      );

      CREATE TABLE IF NOT EXISTS thread_exports (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        format TEXT NOT NULL,
        output_path TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        status TEXT NOT NULL,
        redaction_report_json TEXT,
        FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_threads_active ON threads(deleted_at, last_active_at);
      CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_runs_thread ON runs(thread_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_events_thread ON events(thread_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_audit_thread ON audit_events(thread_id, at);
    `);
    this.#ensureColumn("approvals", "raw_arguments_json", "TEXT");
    this.#ensureColumn("approvals", "raw_arguments_persisted", "INTEGER NOT NULL DEFAULT 0");
    this.#setMeta("schema_version", String(THREAD_SCHEMA_VERSION));
  }

  #ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.#db.prepare(`PRAGMA table_info(${table})`).all() as SqlRow[];
    if (columns.some((row) => row.name === column)) {
      return;
    }
    this.#db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  #importLegacyStores(): void {
    this.#importLegacySessions();
    this.#importLegacyAudit();
  }

  #importLegacySessions(): void {
    if (this.#getMeta("legacy.sessions.imported_at")) {
      return;
    }
    const filePath = path.join(path.dirname(this.dbPath), "sessions.json");
    const metadata = this.#legacyFileMetadata(filePath);
    let importedCount = 0;
    try {
      if (fs.existsSync(filePath)) {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as { sessions?: unknown[] };
        const sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
        this.#transaction(() => {
          for (const entry of sessions) {
            if (isAgentSession(entry)) {
              this.#importSession(entry);
              importedCount += 1;
            }
          }
        });
      }
    } catch (error) {
      importedCount = 0;
      this.#diagnostics.push({
        code: "AGENT_LEGACY_SESSIONS_IMPORT_FAILED",
        message: "Legacy agent sessions.json could not be imported; Relaybase continued with an empty import.",
        detail: sanitizeAgentPayload({ error }),
        at: new Date().toISOString()
      });
    } finally {
      this.#setMeta(
        "legacy.sessions.imported_at",
        JSON.stringify({ ...metadata, importedCount, importedAt: new Date().toISOString() })
      );
    }
  }

  #importLegacyAudit(): void {
    if (this.#getMeta("legacy.audit.imported_at")) {
      return;
    }
    const filePath = path.join(path.dirname(this.dbPath), "audit.jsonl");
    const metadata = this.#legacyFileMetadata(filePath);
    let importedCount = 0;
    let failedCount = 0;
    try {
      if (fs.existsSync(filePath)) {
        const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
        this.#transaction(() => {
          for (const line of lines) {
            try {
              const parsed = JSON.parse(line) as unknown;
              if (isAgentAuditEvent(parsed)) {
                this.#insertAuditEvent(sanitizeAgentPayload(parsed) as AgentAuditEvent);
                importedCount += 1;
              }
            } catch {
              failedCount += 1;
            }
          }
        });
      }
      if (failedCount > 0) {
        this.#diagnostics.push({
          code: "AGENT_LEGACY_AUDIT_IMPORT_PARTIAL",
          message: "Some legacy agent audit.jsonl lines could not be imported.",
          detail: { failedCount },
          at: new Date().toISOString()
        });
      }
    } catch (error) {
      importedCount = 0;
      this.#diagnostics.push({
        code: "AGENT_LEGACY_AUDIT_IMPORT_FAILED",
        message: "Legacy agent audit.jsonl could not be imported; Relaybase continued with an empty import.",
        detail: sanitizeAgentPayload({ error }),
        at: new Date().toISOString()
      });
    } finally {
      this.#setMeta(
        "legacy.audit.imported_at",
        JSON.stringify({ ...metadata, importedCount, failedCount, importedAt: new Date().toISOString() })
      );
      this.#pruneAuditEvents();
    }
  }

  #importSession(session: AgentSession): void {
    const safeSession = sanitizeSessionPayload(session);
    this.#insertThread(safeSession, { titleSource: safeSession.title ? "legacy" : "auto" });
    for (const message of safeSession.messages) {
      this.#insertMessage(message, undefined);
    }
    for (const run of safeSession.runs) {
      this.#upsertRun(run);
      for (const event of run.events) {
        this.#insertEvent(event, undefined);
      }
    }
  }

  #legacyFileMetadata(filePath: string): Record<string, unknown> {
    if (!fs.existsSync(filePath)) {
      return { exists: false };
    }
    const stat = fs.statSync(filePath);
    return {
      exists: true,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs
    };
  }

  #insertThread(session: AgentSession, options: { titleSource?: string; lastActiveAt?: string } = {}): void {
    this.#db
      .prepare(
        `INSERT INTO threads (
          id, title, title_source, created_at, updated_at, last_active_at, context_json, setup_json,
          summary_json, summary_updated_at, privacy_mode, advanced_redacted_detail_enabled
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          title_source = excluded.title_source,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          last_active_at = excluded.last_active_at,
          context_json = excluded.context_json,
          setup_json = excluded.setup_json,
          summary_json = excluded.summary_json,
          summary_updated_at = excluded.summary_updated_at,
          privacy_mode = excluded.privacy_mode,
          advanced_redacted_detail_enabled = excluded.advanced_redacted_detail_enabled`
      )
      .run(
        session.id,
        session.title ?? null,
        options.titleSource ?? null,
        session.createdAt,
        session.updatedAt,
        options.lastActiveAt ?? session.updatedAt,
        json(session.context),
        json(session.setup),
        null,
        null,
        "standard",
        0
      );
  }

  #insertMessage(message: AgentMessage, report: unknown): void {
    this.#db
      .prepare(
        `INSERT INTO messages (
          id, thread_id, run_id, role, content, created_at, context_json, redaction_report_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          thread_id = excluded.thread_id,
          run_id = excluded.run_id,
          role = excluded.role,
          content = excluded.content,
          created_at = excluded.created_at,
          context_json = excluded.context_json,
          redaction_report_json = excluded.redaction_report_json`
      )
      .run(
        message.id,
        message.sessionId,
        message.runId ?? null,
        message.role,
        message.content,
        message.createdAt,
        json(message.context),
        json(report)
      );
  }

  #upsertRun(run: AgentRun): void {
    this.#db
      .prepare(
        `INSERT INTO runs (
          id, thread_id, status, provider, model_slug, created_at, started_at, completed_at, diagnostic_json, usage_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          thread_id = excluded.thread_id,
          status = excluded.status,
          provider = excluded.provider,
          model_slug = excluded.model_slug,
          created_at = excluded.created_at,
          started_at = excluded.started_at,
          completed_at = excluded.completed_at,
          diagnostic_json = excluded.diagnostic_json,
          usage_json = excluded.usage_json`
      )
      .run(
        run.id,
        run.sessionId,
        run.status,
        run.provider,
        run.modelSlug ?? null,
        run.createdAt,
        run.startedAt ?? null,
        run.completedAt ?? null,
        json(run.diagnostic),
        json(run.usage)
      );
  }

  #insertEvent(event: AgentRunEvent, report: unknown): void {
    this.#db
      .prepare(
        `INSERT INTO events (
          id, thread_id, run_id, sequence, type, at, data_json, visible, redaction_report_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          thread_id = excluded.thread_id,
          run_id = excluded.run_id,
          sequence = excluded.sequence,
          type = excluded.type,
          at = excluded.at,
          data_json = excluded.data_json,
          visible = excluded.visible,
          redaction_report_json = excluded.redaction_report_json`
      )
      .run(
        event.id,
        event.sessionId,
        event.runId ?? null,
        event.sequence,
        event.type,
        event.at,
        json(event.data),
        1,
        json(report)
      );
  }

  #insertAuditEvent(event: AgentAuditEvent): void {
    this.#db
      .prepare(
        `INSERT INTO audit_events (
          id, at, thread_id, run_id, type, provider, model_slug, data_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          at = excluded.at,
          thread_id = excluded.thread_id,
          run_id = excluded.run_id,
          type = excluded.type,
          provider = excluded.provider,
          model_slug = excluded.model_slug,
          data_json = excluded.data_json`
      )
      .run(
        event.id,
        event.at,
        event.sessionId ?? null,
        event.runId ?? null,
        event.type,
        event.provider ?? null,
        event.modelSlug ?? null,
        json(event.data)
      );
  }

  #insertApproval(approval: AgentApproval, rawArguments?: Record<string, unknown>): void {
    this.#db
      .prepare(
        `INSERT INTO approvals (
          id, thread_id, run_id, tool_call_id, tool_name, status, created_at, resolved_at, action, target,
          risk, expected_result, arguments_json, arguments_hash, context_json, preview_json, diagnostic_json,
          raw_arguments_json, raw_arguments_persisted, recovery_state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          thread_id = excluded.thread_id,
          run_id = excluded.run_id,
          tool_call_id = excluded.tool_call_id,
          tool_name = excluded.tool_name,
          status = excluded.status,
          created_at = excluded.created_at,
          resolved_at = excluded.resolved_at,
          action = excluded.action,
          target = excluded.target,
          risk = excluded.risk,
          expected_result = excluded.expected_result,
          arguments_json = excluded.arguments_json,
          arguments_hash = excluded.arguments_hash,
          context_json = excluded.context_json,
          preview_json = excluded.preview_json,
          diagnostic_json = excluded.diagnostic_json,
          raw_arguments_json = excluded.raw_arguments_json,
          raw_arguments_persisted = excluded.raw_arguments_persisted,
          recovery_state = excluded.recovery_state`
      )
      .run(
        approval.id,
        approval.sessionId,
        approval.runId,
        approval.toolCallId ?? null,
        approval.toolName ?? null,
        approval.status,
        approval.createdAt,
        approval.resolvedAt ?? null,
        approval.action,
        approval.target ?? null,
        approval.risk,
        approval.expectedResult,
        json(approval.arguments),
        approval.argumentsHash ?? null,
        json(approval.context),
        json(approval.preview),
        json(approval.diagnostic),
        json(rawArguments),
        rawArguments ? 1 : 0,
        approval.recoveryState ?? "live"
      );
  }

  #hydrateSession(row: SqlRow): AgentSession {
    const sessionId = String(row.id);
    const messages = this.#db
      .prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC")
      .all(sessionId)
      .map((messageRow) => messageFromRow(messageRow));
    const runs = this.#db
      .prepare("SELECT * FROM runs WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC")
      .all(sessionId)
      .map((runRow) => this.#runFromRow(runRow));
    return {
      id: sessionId,
      ...(typeof row.title === "string" ? { title: row.title } : {}),
      ...(typeof row.title_source === "string" ? { titleSource: row.title_source as AgentSession["titleSource"] } : {}),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      ...(typeof row.last_active_at === "string" ? { lastActiveAt: row.last_active_at } : {}),
      ...(typeof row.deleted_at === "string" ? { deletedAt: row.deleted_at } : {}),
      ...(typeof row.deleted_reason === "string" ? { deletedReason: row.deleted_reason } : {}),
      summary: row.summary_json
        ? (parseJson(row.summary_json) as AgentThreadSummary)
        : this.#buildThreadSummary(sessionId),
      privacy: {
        mode: row.privacy_mode === "redacted_detail" ? "redacted_detail" : "standard",
        advancedRedactedDetailEnabled: row.advanced_redacted_detail_enabled === 1
      },
      recoveredApprovalCount: countRows(
        this.#db
          .prepare("SELECT COUNT(*) AS count FROM approvals WHERE thread_id = ? AND status = 'recovered_pending'")
          .get(sessionId)
      ),
      ...(row.context_json ? { context: parseJson(row.context_json) as TuiAgentContext } : {}),
      ...(row.setup_json ? { setup: parseJson(row.setup_json) as AgentSession["setup"] } : {}),
      messages,
      runs
    };
  }

  #runFromRow(row: SqlRow): AgentRun {
    const runId = String(row.id);
    const events = this.#db
      .prepare("SELECT * FROM events WHERE run_id = ? ORDER BY sequence ASC, at ASC, rowid ASC")
      .all(runId)
      .map((eventRow) => eventFromRow(eventRow));
    return {
      id: runId,
      sessionId: String(row.thread_id),
      status: row.status as AgentRun["status"],
      provider: row.provider as AgentRun["provider"],
      ...(typeof row.model_slug === "string" ? { modelSlug: row.model_slug } : {}),
      createdAt: String(row.created_at),
      ...(typeof row.started_at === "string" ? { startedAt: row.started_at } : {}),
      ...(typeof row.completed_at === "string" ? { completedAt: row.completed_at } : {}),
      ...(row.diagnostic_json ? { diagnostic: parseJson(row.diagnostic_json) as AgentRun["diagnostic"] } : {}),
      ...(row.usage_json ? { usage: parseJson(row.usage_json) as AgentRun["usage"] } : {}),
      events
    };
  }

  #auditFromRow(row: SqlRow): AgentAuditEvent {
    return {
      id: String(row.id),
      at: String(row.at),
      ...(typeof row.thread_id === "string" ? { sessionId: row.thread_id } : {}),
      ...(typeof row.run_id === "string" ? { runId: row.run_id } : {}),
      type: String(row.type),
      ...(typeof row.provider === "string" ? { provider: row.provider as AgentAuditEvent["provider"] } : {}),
      ...(typeof row.model_slug === "string" ? { modelSlug: row.model_slug } : {}),
      data: row.data_json ? parseJson(row.data_json) : undefined
    };
  }

  #approvalFromRow(row: SqlRow): AgentApproval {
    return {
      id: String(row.id),
      sessionId: String(row.thread_id),
      runId: String(row.run_id),
      ...(typeof row.tool_call_id === "string" ? { toolCallId: row.tool_call_id } : {}),
      ...(typeof row.tool_name === "string" ? { toolName: row.tool_name } : {}),
      status: row.status as AgentApproval["status"],
      createdAt: String(row.created_at),
      ...(typeof row.resolved_at === "string" ? { resolvedAt: row.resolved_at } : {}),
      action: String(row.action),
      ...(typeof row.target === "string" ? { target: row.target } : {}),
      risk: row.risk as AgentApproval["risk"],
      expectedResult: String(row.expected_result),
      arguments: row.arguments_json ? (parseJson(row.arguments_json) as Record<string, unknown>) : {},
      ...(typeof row.arguments_hash === "string" ? { argumentsHash: row.arguments_hash } : {}),
      ...(typeof row.recovery_state === "string"
        ? { recoveryState: row.recovery_state as AgentApproval["recoveryState"] }
        : {}),
      rawArgumentsPersisted: row.raw_arguments_persisted === 1,
      ...(row.context_json ? { context: parseJson(row.context_json) as TuiAgentContext } : {}),
      ...(row.preview_json ? { preview: parseJson(row.preview_json) as AgentApproval["preview"] } : {}),
      ...(row.diagnostic_json ? { diagnostic: parseJson(row.diagnostic_json) as AgentApproval["diagnostic"] } : {})
    };
  }

  #refreshThreadSummary(sessionId: string): void {
    if (!this.#threadExists(sessionId)) {
      return;
    }
    const summary = this.#buildThreadSummary(sessionId);
    const now = new Date().toISOString();
    this.#db
      .prepare("UPDATE threads SET summary_json = ?, summary_updated_at = ?, updated_at = ? WHERE id = ?")
      .run(json(summary), now, now, sessionId);
  }

  #buildThreadSummary(sessionId: string): AgentThreadSummary {
    const messageCount = countRows(
      this.#db.prepare("SELECT COUNT(*) AS count FROM messages WHERE thread_id = ?").get(sessionId)
    );
    const runCount = countRows(
      this.#db.prepare("SELECT COUNT(*) AS count FROM runs WHERE thread_id = ?").get(sessionId)
    );
    const eventCount = countRows(
      this.#db.prepare("SELECT COUNT(*) AS count FROM events WHERE thread_id = ?").get(sessionId)
    );
    const pendingApprovalCount = countRows(
      this.#db
        .prepare(
          "SELECT COUNT(*) AS count FROM approvals WHERE thread_id = ? AND status IN ('pending', 'recovered_pending')"
        )
        .get(sessionId)
    );
    const recoveredApprovalCount = countRows(
      this.#db
        .prepare("SELECT COUNT(*) AS count FROM approvals WHERE thread_id = ? AND status = 'recovered_pending'")
        .get(sessionId)
    );
    const lastEvent = this.#db
      .prepare("SELECT sequence, data_json FROM events WHERE thread_id = ? ORDER BY sequence DESC LIMIT 1")
      .get(sessionId) as SqlRow | undefined;
    const lastUser = this.#lastMessageContent(sessionId, "user");
    const lastAssistant = this.#lastMessageContent(sessionId, "assistant");
    const lastDiagnosticCode = diagnosticCodeFromEvent(lastEvent?.data_json);

    return {
      generatedAt: new Date().toISOString(),
      messageCount,
      runCount,
      eventCount,
      pendingApprovalCount,
      recoveredApprovalCount,
      ...(numberFromRow(lastEvent?.sequence) !== undefined
        ? { lastEventSequence: numberFromRow(lastEvent?.sequence) }
        : {}),
      ...(lastUser ? { lastUserMessage: summarizeText(lastUser) } : {}),
      ...(lastAssistant ? { lastAssistantMessage: summarizeText(lastAssistant) } : {}),
      ...(lastDiagnosticCode ? { lastDiagnosticCode } : {})
    };
  }

  #lastMessageContent(sessionId: string, role: AgentMessage["role"]): string | undefined {
    const row = this.#db
      .prepare(
        "SELECT content FROM messages WHERE thread_id = ? AND role = ? ORDER BY created_at DESC, rowid DESC LIMIT 1"
      )
      .get(sessionId, role) as SqlRow | undefined;
    return typeof row?.content === "string" ? row.content : undefined;
  }

  #threadExists(sessionId: string): boolean {
    return Boolean(
      this.#db.prepare("SELECT 1 FROM threads WHERE id = ? AND deleted_at IS NULL").get(sessionId) as SqlRow | undefined
    );
  }

  #runExists(runId: string): boolean {
    return Boolean(this.#db.prepare("SELECT 1 FROM runs WHERE id = ?").get(runId) as SqlRow | undefined);
  }

  #touchThread(sessionId: string, timestamp: string): void {
    this.#db
      .prepare("UPDATE threads SET updated_at = ?, last_active_at = ? WHERE id = ? AND deleted_at IS NULL")
      .run(timestamp, timestamp, sessionId);
    this.setActiveThread(sessionId);
  }

  #pruneExpired(now = Date.now()): void {
    const cutoff = new Date(now - this.#retentionMs).toISOString();
    this.#db
      .prepare(
        "UPDATE threads SET deleted_at = COALESCE(deleted_at, ?), deleted_reason = COALESCE(deleted_reason, ?) WHERE deleted_at IS NULL AND updated_at < ?"
      )
      .run(new Date().toISOString(), "retention_expired", cutoff);
  }

  #pruneAuditEvents(): void {
    this.#db
      .prepare(
        "DELETE FROM audit_events WHERE id IN (SELECT id FROM audit_events ORDER BY at DESC, rowid DESC LIMIT -1 OFFSET ?)"
      )
      .run(this.#maxAuditEvents);
  }

  #setMeta(key: string, value: string): void {
    this.#db
      .prepare(
        `INSERT INTO schema_meta (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, value, new Date().toISOString());
  }

  #getMeta(key: string): string | undefined {
    const row = this.#db.prepare("SELECT value FROM schema_meta WHERE key = ?").get(key) as SqlRow | undefined;
    return typeof row?.value === "string" ? row.value : undefined;
  }

  #deleteMeta(key: string): void {
    this.#db.prepare("DELETE FROM schema_meta WHERE key = ?").run(key);
  }

  #transaction<T>(callback: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #quarantineSqliteFiles(): void {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    for (const suffix of ["", "-wal", "-shm"]) {
      const source = `${this.dbPath}${suffix}`;
      if (!fs.existsSync(source)) {
        continue;
      }
      fs.renameSync(source, `${this.dbPath}.broken.${stamp}${suffix}`);
    }
  }
}

function messageFromRow(row: SqlRow): AgentMessage {
  return {
    id: String(row.id),
    sessionId: String(row.thread_id),
    role: row.role as AgentMessage["role"],
    content: String(row.content),
    createdAt: String(row.created_at),
    ...(typeof row.run_id === "string" ? { runId: row.run_id } : {}),
    ...(row.context_json ? { context: parseJson(row.context_json) as TuiAgentContext } : {})
  };
}

function eventFromRow(row: SqlRow): AgentRunEvent {
  return {
    id: String(row.id),
    sessionId: String(row.thread_id),
    ...(typeof row.run_id === "string" ? { runId: row.run_id } : {}),
    sequence: numberFromRow(row.sequence) ?? 0,
    type: row.type as AgentRunEvent["type"],
    at: String(row.at),
    data: row.data_json ? parseJson(row.data_json) : undefined
  };
}

function json(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return undefined;
  }
  return JSON.parse(value);
}

function numberFromRow(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function countRows(row: unknown): number {
  const count = row && typeof row === "object" ? (row as { count?: unknown }).count : undefined;
  return typeof count === "number" && Number.isFinite(count) ? count : 0;
}

function normalizePrivacy(
  raw: AgentThreadUpdateRequest["privacy"] = {},
  fallback: AgentThreadPrivacy = { mode: "standard", advancedRedactedDetailEnabled: false }
): AgentThreadPrivacy {
  return {
    mode: raw.mode === "redacted_detail" ? "redacted_detail" : fallback.mode,
    advancedRedactedDetailEnabled:
      typeof raw.advancedRedactedDetailEnabled === "boolean"
        ? raw.advancedRedactedDetailEnabled
        : fallback.advancedRedactedDetailEnabled
  };
}

function persistableApprovalArguments(rawArguments: Record<string, unknown> | undefined): {
  persisted: boolean;
  value?: Record<string, unknown>;
} {
  if (!rawArguments) {
    return { persisted: false };
  }
  const serialized = JSON.stringify(rawArguments);
  if (
    serialized.length > 8000 ||
    /"?(diff|hunks|logs|recentLogs|env|content|secret|token|password|apiKey)"?\s*:/i.test(serialized)
  ) {
    return { persisted: false };
  }
  const sanitized = sanitizeSessionPayloadWithReport(rawArguments);
  if (sanitized.redactionReport.totalReplacements > 0) {
    return { persisted: false };
  }
  return { persisted: true, value: structuredClone(rawArguments) };
}

function diagnosticCodeFromEvent(rawJson: unknown): string | undefined {
  if (!rawJson) {
    return undefined;
  }
  const data = parseJson(rawJson);
  if (data && typeof data === "object" && typeof (data as { code?: unknown }).code === "string") {
    return (data as { code: string }).code;
  }
  const diagnostic = data && typeof data === "object" ? (data as { diagnostic?: unknown }).diagnostic : undefined;
  return diagnostic && typeof diagnostic === "object" && typeof (diagnostic as { code?: unknown }).code === "string"
    ? (diagnostic as { code: string }).code
    : undefined;
}

function summarizeText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= 220 ? normalized : `${normalized.slice(0, 220)}...[truncated]`;
}

function isAgentSession(value: unknown): value is AgentSession {
  return Boolean(
    value &&
    typeof value === "object" &&
    "id" in value &&
    typeof (value as { id?: unknown }).id === "string" &&
    Array.isArray((value as { messages?: unknown }).messages) &&
    Array.isArray((value as { runs?: unknown }).runs)
  );
}

function isAgentAuditEvent(value: unknown): value is AgentAuditEvent {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { at?: unknown }).at === "string" &&
    typeof (value as { type?: unknown }).type === "string"
  );
}
