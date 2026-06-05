import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { redactSecretLikeValues } from "./redaction.ts";
import type { AppComponentRole, LifecycleHookName } from "./types.ts";

export type LogStream = "stdout" | "stderr" | "system";
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogSegmentRef {
  id: string;
  date: string;
  path: string;
}

export interface DurableLogEvent {
  sequence: number;
  timestamp: string;
  at: string;
  appId: string;
  groupId: string;
  componentRole: AppComponentRole;
  stream: LogStream;
  source: "system" | LifecycleHookName;
  level: LogLevel;
  message: string;
  line: string;
  redacted: boolean;
  segment?: LogSegmentRef;
}

export interface LogStoreAppendInput {
  sequence?: number;
  timestamp?: string;
  at?: string;
  appId: string;
  groupId?: string;
  componentRole?: AppComponentRole;
  stream: LogStream;
  source?: "system" | LifecycleHookName;
  level?: LogLevel;
  message?: string;
  line?: string;
  redacted?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface LogStoreQuery {
  appId?: string;
  groupId?: string;
  componentRole?: AppComponentRole;
  limit?: number;
  before?: number;
  after?: number;
}

export interface LogStorePage {
  limit: number;
  before?: number;
  after?: number;
  oldestSequence?: number;
  newestSequence?: number;
  nextBefore?: number;
  hasMore: boolean;
}

export interface LogStoreQueryResult {
  events: DurableLogEvent[];
  page: LogStorePage;
  diagnostics: LogStoreDiagnostic[];
}

export interface LogStoreDiagnostic {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  checkedAt: string;
  path?: string;
  detail?: unknown;
}

export interface LogStoreHealth {
  status: "healthy" | "degraded";
  rootDir: string;
  pendingWrites: number;
  lastSequence: number;
  retentionDays: number;
  maxEventsPerSegment: number;
  maxPendingWrites: number;
  diagnostics: LogStoreDiagnostic[];
}

interface LogStoreIndex {
  version: 1;
  lastSequence: number;
  currentSegments: Record<string, CurrentSegment>;
  updatedAt: string;
}

interface CurrentSegment {
  id: string;
  date: string;
  relativePath: string;
  eventCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface LogStoreOptions {
  retentionDays?: number;
  maxEventsPerSegment?: number;
  maxPendingWrites?: number;
}

const DEFAULT_RETENTION_DAYS = 14;
const DEFAULT_MAX_EVENTS_PER_SEGMENT = 1000;
const DEFAULT_MAX_PENDING_WRITES = 5000;
const MAX_QUERY_LIMIT = 5000;

export class LogStore {
  readonly rootDir: string;
  readonly segmentsDir: string;
  readonly indexPath: string;
  readonly retentionDays: number;
  readonly maxEventsPerSegment: number;
  readonly maxPendingWrites: number;
  #index: LogStoreIndex;
  #writeTail: Promise<void> = Promise.resolve();
  #pendingWrites = 0;
  #diagnostics: LogStoreDiagnostic[] = [];
  #closed = false;
  #available = true;

  private constructor(rootDir: string, options: LogStoreOptions = {}) {
    this.rootDir = rootDir;
    this.segmentsDir = path.join(rootDir, "segments");
    this.indexPath = path.join(rootDir, "index.json");
    this.retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
    this.maxEventsPerSegment = options.maxEventsPerSegment ?? DEFAULT_MAX_EVENTS_PER_SEGMENT;
    this.maxPendingWrites = options.maxPendingWrites ?? DEFAULT_MAX_PENDING_WRITES;
    this.#index = {
      version: 1,
      lastSequence: 0,
      currentSegments: {},
      updatedAt: new Date().toISOString()
    };
  }

  static async open(stateDir: string, options: LogStoreOptions = {}): Promise<LogStore> {
    const store = new LogStore(path.join(stateDir, "logs"), options);
    await store.#open();
    return store;
  }

  get lastSequence(): number {
    return this.#index.lastSequence;
  }

  allocateSequence(): number {
    this.#index.lastSequence += 1;
    this.#index.updatedAt = new Date().toISOString();
    return this.#index.lastSequence;
  }

  async append(input: LogStoreAppendInput): Promise<DurableLogEvent> {
    if (this.#closed) {
      throw new Error("LogStore is closed.");
    }

    if (!this.#available) {
      const message = "Durable log store is unavailable; retaining live in-memory logs only.";
      this.#addDiagnostic("LOG_STORE_UNAVAILABLE", "error", message, this.rootDir);
      throw new Error(message);
    }

    if (this.#pendingWrites >= this.maxPendingWrites) {
      const message = `Durable log write queue is full at ${this.#pendingWrites} pending writes.`;
      this.#addDiagnostic("LOG_STORE_BACKPRESSURE", "error", message);
      throw new Error(message);
    }

    const event = this.#normalizeAppend(input);
    this.#pendingWrites += 1;
    const write = this.#writeTail
      .then(() => this.#appendNow(event))
      .catch((error: unknown) => {
        this.#addDiagnostic("LOG_STORE_APPEND_FAILED", "error", errorMessage(error), undefined, {
          appId: event.appId,
          sequence: event.sequence
        });
        throw error;
      })
      .finally(() => {
        this.#pendingWrites -= 1;
      });
    this.#writeTail = write.catch(() => undefined);
    await write;
    return event;
  }

  async query(query: LogStoreQuery = {}): Promise<LogStoreQueryResult> {
    await this.flush();
    const limit = normalizeLimit(query.limit);
    if (!this.#available) {
      return {
        events: [],
        page: {
          limit,
          ...(query.before !== undefined ? { before: query.before } : {}),
          ...(query.after !== undefined ? { after: query.after } : {}),
          hasMore: false
        },
        diagnostics: this.diagnostics()
      };
    }

    const events = (await this.#readEvents(query))
      .filter((event) => (query.before === undefined ? true : event.sequence < query.before))
      .filter((event) => (query.after === undefined ? true : event.sequence > query.after))
      .sort((left, right) => left.sequence - right.sequence);
    const limited = events.slice(-limit).map((event) => this.#present(event));
    const oldestSequence = limited[0]?.sequence;
    const newestSequence = limited.at(-1)?.sequence;

    return {
      events: limited,
      page: {
        limit,
        ...(query.before !== undefined ? { before: query.before } : {}),
        ...(query.after !== undefined ? { after: query.after } : {}),
        ...(oldestSequence !== undefined ? { oldestSequence } : {}),
        ...(newestSequence !== undefined ? { newestSequence } : {}),
        ...(events.length > limited.length && oldestSequence !== undefined ? { nextBefore: oldestSequence } : {}),
        hasMore: events.length > limited.length
      },
      diagnostics: this.diagnostics()
    };
  }

  async getBySequence(sequence: number): Promise<DurableLogEvent | undefined> {
    await this.flush();
    for (const event of await this.#readEvents({})) {
      if (event.sequence === sequence) {
        return this.#present(event);
      }
    }
    return undefined;
  }

  async rotate(appId?: string): Promise<void> {
    await this.flush();
    if (!this.#available) {
      return;
    }

    if (appId) {
      delete this.#index.currentSegments[appId];
    } else {
      this.#index.currentSegments = {};
    }
    this.#index.updatedAt = new Date().toISOString();
    await this.#saveIndex();
  }

  async cleanupRetention(now = new Date()): Promise<void> {
    await this.flush();
    if (!this.#available) {
      return;
    }

    if (this.retentionDays < 0) {
      return;
    }

    const cutoff = now.getTime() - this.retentionDays * 24 * 60 * 60 * 1000;
    const files = await this.#segmentFiles();
    const removed = new Set<string>();
    for (const filePath of files) {
      try {
        const stat = await fs.stat(filePath);
        if (stat.mtimeMs >= cutoff) {
          continue;
        }
        await fs.unlink(filePath);
        removed.add(path.relative(this.rootDir, filePath));
      } catch (error) {
        this.#addDiagnostic("LOG_RETENTION_CLEANUP_FAILED", "warning", errorMessage(error), filePath);
      }
    }

    for (const [appId, segment] of Object.entries(this.#index.currentSegments)) {
      if (removed.has(segment.relativePath)) {
        delete this.#index.currentSegments[appId];
      }
    }
    this.#index.updatedAt = new Date().toISOString();
    await this.#saveIndex();
  }

  health(): LogStoreHealth {
    return {
      status: this.#diagnostics.length ? "degraded" : "healthy",
      rootDir: this.rootDir,
      pendingWrites: this.#pendingWrites,
      lastSequence: this.#index.lastSequence,
      retentionDays: this.retentionDays,
      maxEventsPerSegment: this.maxEventsPerSegment,
      maxPendingWrites: this.maxPendingWrites,
      diagnostics: this.diagnostics()
    };
  }

  diagnostics(): LogStoreDiagnostic[] {
    return this.#diagnostics.map((diagnostic) => ({ ...diagnostic }));
  }

  async flush(): Promise<void> {
    await this.#writeTail;
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.flush();
    if (!this.#available) {
      return;
    }
    await this.#saveIndex();
  }

  async #open(): Promise<void> {
    try {
      await fs.mkdir(this.segmentsDir, { recursive: true });
      await this.#loadIndex();
      await this.cleanupRetention();
    } catch (error) {
      this.#available = false;
      this.#addDiagnostic(
        "LOG_STORE_UNAVAILABLE",
        "error",
        "Durable log store could not be opened; live in-memory logs remain available.",
        this.rootDir,
        { error: errorMessage(error) }
      );
    }
  }

  async #loadIndex(): Promise<void> {
    try {
      const raw = await fs.readFile(this.indexPath, "utf8");
      const parsed = JSON.parse(raw) as LogStoreIndex;
      if (parsed.version !== 1 || typeof parsed.lastSequence !== "number" || !parsed.currentSegments) {
        throw new Error("Unsupported Relaybase log index format.");
      }
      this.#index = parsed;
    } catch (error) {
      if (!isNodeErrno(error, "ENOENT")) {
        this.#addDiagnostic(
          "LOG_INDEX_CORRUPT",
          "warning",
          "Log index could not be read; rebuilt from segments.",
          this.indexPath,
          {
            error: errorMessage(error)
          }
        );
      }
      const lastSequence = await this.#scanLastSequence();
      this.#index = {
        version: 1,
        lastSequence,
        currentSegments: {},
        updatedAt: new Date().toISOString()
      };
      await this.#saveIndex();
    }
  }

  #normalizeAppend(input: LogStoreAppendInput): DurableLogEvent {
    const timestamp = input.timestamp ?? input.at ?? new Date().toISOString();
    const sequence = input.sequence ?? this.allocateSequence();
    if (sequence > this.#index.lastSequence) {
      this.#index.lastSequence = sequence;
    }
    const rawMessage = input.message ?? input.line ?? "";
    const redaction = redactSecretLikeValues(rawMessage, input.env);
    const message = redaction.value;
    return {
      sequence,
      timestamp,
      at: timestamp,
      appId: input.appId,
      groupId: input.groupId ?? input.appId,
      componentRole: input.componentRole ?? "other",
      stream: input.stream,
      source: input.source ?? "system",
      level: input.level ?? detectLogLevel(message, input.stream),
      message,
      line: message,
      redacted: input.redacted === true || redaction.redacted
    };
  }

  async #appendNow(event: DurableLogEvent): Promise<void> {
    const segment = await this.#segmentFor(event);
    const filePath = path.join(this.rootDir, segment.relativePath);
    event.segment = {
      id: segment.id,
      date: segment.date,
      path: segment.relativePath
    };
    await fs.appendFile(filePath, `${JSON.stringify(event)}\n`, "utf8");
    segment.eventCount += 1;
    segment.updatedAt = new Date().toISOString();
    this.#index.currentSegments[event.appId] = segment;
    this.#index.updatedAt = segment.updatedAt;
    await this.#saveIndex();
  }

  async #segmentFor(event: DurableLogEvent): Promise<CurrentSegment> {
    const date = event.timestamp.slice(0, 10);
    const existing = this.#index.currentSegments[event.appId];
    if (existing && existing.date === date && existing.eventCount < this.maxEventsPerSegment) {
      await fs.mkdir(path.dirname(path.join(this.rootDir, existing.relativePath)), { recursive: true });
      return existing;
    }

    const segment: CurrentSegment = {
      id: `${date}-${randomUUID()}`,
      date,
      relativePath: path.join("segments", event.appId, date, `${randomUUID()}.jsonl`),
      eventCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await fs.mkdir(path.dirname(path.join(this.rootDir, segment.relativePath)), { recursive: true });
    return segment;
  }

  async #saveIndex(): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
    const tempPath = `${this.indexPath}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(this.#index, null, 2)}\n`, "utf8");
    await fs.rename(tempPath, this.indexPath);
  }

  async #readEvents(query: LogStoreQuery): Promise<DurableLogEvent[]> {
    const events: DurableLogEvent[] = [];
    const files = await this.#segmentFiles(query.appId);
    for (const filePath of files) {
      let raw: string;
      try {
        raw = await fs.readFile(filePath, "utf8");
      } catch (error) {
        this.#addDiagnostic("LOG_SEGMENT_READ_FAILED", "warning", errorMessage(error), filePath);
        continue;
      }

      const lines = raw.split(/\r?\n/).filter(Boolean);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        try {
          const event = normalizeStoredEvent(JSON.parse(line) as Partial<DurableLogEvent>);
          if (!event) {
            throw new Error("Log segment line is missing required fields.");
          }
          if (query.groupId && event.groupId !== query.groupId) {
            continue;
          }
          if (query.componentRole && event.componentRole !== query.componentRole) {
            continue;
          }
          events.push(event);
        } catch (error) {
          this.#addDiagnostic(
            "LOG_SEGMENT_CORRUPT",
            "warning",
            "Log segment contains an unreadable JSONL entry.",
            filePath,
            {
              line: index + 1,
              error: errorMessage(error)
            }
          );
        }
      }
    }
    return events;
  }

  async #segmentFiles(appId?: string): Promise<string[]> {
    const root = appId ? path.join(this.segmentsDir, appId) : this.segmentsDir;
    return collectJsonlFiles(root);
  }

  async #scanLastSequence(): Promise<number> {
    let lastSequence = 0;
    for (const event of await this.#readEvents({})) {
      lastSequence = Math.max(lastSequence, event.sequence);
    }
    return lastSequence;
  }

  #present(event: DurableLogEvent): DurableLogEvent {
    const redaction = redactSecretLikeValues(event.message);
    const message = redaction.value;
    return {
      ...event,
      message,
      line: message,
      redacted: event.redacted || redaction.redacted
    };
  }

  #addDiagnostic(
    code: string,
    severity: LogStoreDiagnostic["severity"],
    message: string,
    filePath?: string,
    detail?: unknown
  ): void {
    this.#diagnostics.push({
      code,
      severity,
      message,
      checkedAt: new Date().toISOString(),
      ...(filePath ? { path: path.relative(this.rootDir, filePath) } : {}),
      ...(detail ? { detail } : {})
    });
    if (this.#diagnostics.length > 100) {
      this.#diagnostics.splice(0, this.#diagnostics.length - 100);
    }
  }
}

function normalizeStoredEvent(input: Partial<DurableLogEvent>): DurableLogEvent | undefined {
  if (
    typeof input.sequence !== "number" ||
    typeof input.appId !== "string" ||
    typeof input.stream !== "string" ||
    typeof input.message !== "string"
  ) {
    return undefined;
  }

  const timestamp = typeof input.timestamp === "string" ? input.timestamp : (input.at ?? new Date().toISOString());
  const componentRole =
    input.componentRole === "frontend" ||
    input.componentRole === "backend" ||
    input.componentRole === "worker" ||
    input.componentRole === "database" ||
    input.componentRole === "service" ||
    input.componentRole === "other"
      ? input.componentRole
      : "other";
  const stream =
    input.stream === "stdout" || input.stream === "stderr" || input.stream === "system" ? input.stream : "system";
  const source = isLifecycleLogSource(input.source) ? input.source : "system";
  const level =
    input.level === "debug" || input.level === "info" || input.level === "warn" || input.level === "error"
      ? input.level
      : detectLogLevel(input.message, stream);

  return {
    sequence: input.sequence,
    timestamp,
    at: timestamp,
    appId: input.appId,
    groupId: typeof input.groupId === "string" ? input.groupId : input.appId,
    componentRole,
    stream,
    source,
    level,
    message: input.message,
    line: typeof input.line === "string" ? input.line : input.message,
    redacted: input.redacted === true,
    ...(input.segment ? { segment: input.segment } : {})
  };
}

function detectLogLevel(message: string, stream: LogStream): LogLevel {
  if (stream === "stderr" || /\b(error|fatal|panic)\b/i.test(message)) {
    return "error";
  }
  if (/\b(warn|warning)\b/i.test(message)) {
    return "warn";
  }
  if (/\b(debug|trace)\b/i.test(message)) {
    return "debug";
  }
  return "info";
}

function isLifecycleLogSource(value: unknown): value is DurableLogEvent["source"] {
  return (
    value === "system" || value === "preStart" || value === "start" || value === "stop" || value === "verifyStopped"
  );
}

async function collectJsonlFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await collectJsonlFiles(fullPath)));
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(fullPath);
      }
    }
  } catch (error) {
    if (!isNodeErrno(error, "ENOENT")) {
      throw error;
    }
  }
  return files.sort();
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return 500;
  }
  return Math.max(1, Math.min(MAX_QUERY_LIMIT, Math.trunc(limit)));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}
