import { randomUUID } from "node:crypto";
import { redactAgentText, sanitizeAgentPayload } from "./errors.ts";
import { sanitizeSessionPayload } from "./sessionSanitizer.ts";
import { ThreadStore, type ThreadStoreDiagnostic } from "./threadStore.ts";
import type {
  AgentMessage,
  AgentRun,
  AgentRunEvent,
  AgentSession,
  AgentSessionCreateRequest,
  AgentSessionExportResult,
  AgentThreadContextPreview,
  AgentThreadUpdateRequest,
  TuiAgentContext
} from "./types.ts";

const DEFAULT_RETENTION_DAYS = 30;

export interface AgentSessionStoreOptions {
  stateDir?: string;
  retentionDays?: number;
}

export class AgentSessionStore {
  #sessions = new Map<string, AgentSession>();
  #retentionMs: number;
  #threadStore?: ThreadStore;

  constructor(options: AgentSessionStoreOptions = {}) {
    this.#retentionMs = Math.max(1, options.retentionDays ?? DEFAULT_RETENTION_DAYS) * 24 * 60 * 60 * 1000;
    if (options.stateDir) {
      this.#threadStore = new ThreadStore({ stateDir: options.stateDir, retentionDays: options.retentionDays });
      return;
    }
  }

  create(raw: AgentSessionCreateRequest, context: TuiAgentContext): AgentSession {
    if (this.#threadStore) {
      return this.#threadStore.createSession(raw, context);
    }
    const now = new Date().toISOString();
    const session: AgentSession = {
      id: randomUUID(),
      ...(raw.title ? { title: redactAgentText(String(raw.title)) } : {}),
      createdAt: now,
      updatedAt: now,
      context: sanitizeAgentPayload(context),
      messages: [],
      runs: []
    };
    this.#sessions.set(session.id, session);
    this.#persistAll();
    return session;
  }

  list(): AgentSession[] {
    if (this.#threadStore) {
      return this.#threadStore.listSessions();
    }
    return [...this.#sessions.values()].map((session) => this.summary(session));
  }

  get(sessionId: string): AgentSession | undefined {
    if (this.#threadStore) {
      return this.#threadStore.getSession(sessionId);
    }
    return this.#sessions.get(sessionId);
  }

  getActive(): AgentSession | undefined {
    if (this.#threadStore) {
      return this.#threadStore.getActiveSession();
    }
    const [session] = [...this.#sessions.values()].sort(
      (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
    );
    return session;
  }

  activate(sessionId: string): AgentSession | undefined {
    if (this.#threadStore) {
      return this.#threadStore.activateSession(sessionId);
    }
    const session = this.#sessions.get(sessionId);
    if (!session) {
      return undefined;
    }
    session.updatedAt = new Date().toISOString();
    this.#persistAll();
    return session;
  }

  update(sessionId: string, raw: AgentThreadUpdateRequest, context?: TuiAgentContext): AgentSession | undefined {
    if (this.#threadStore) {
      return this.#threadStore.updateSession(sessionId, raw, context);
    }
    const session = this.#sessions.get(sessionId);
    if (!session) {
      return undefined;
    }
    if (raw.title !== undefined) {
      session.title = raw.title.trim() ? redactAgentText(raw.title.trim()) : undefined;
      session.titleSource = "user";
    }
    if (context) {
      session.context = sanitizeAgentPayload(context);
    }
    session.privacy = {
      mode: raw.privacy?.mode === "redacted_detail" ? "redacted_detail" : (session.privacy?.mode ?? "standard"),
      advancedRedactedDetailEnabled:
        typeof raw.privacy?.advancedRedactedDetailEnabled === "boolean"
          ? raw.privacy.advancedRedactedDetailEnabled
          : (session.privacy?.advancedRedactedDetailEnabled ?? false)
    };
    session.updatedAt = new Date().toISOString();
    session.lastActiveAt = session.updatedAt;
    this.#persistAll();
    return session;
  }

  appendMessage(sessionId: string, message: AgentMessage): AgentMessage | undefined {
    if (this.#threadStore) {
      return this.#threadStore.appendMessage(sessionId, message);
    }
    const session = this.#sessions.get(sessionId);
    if (!session) {
      return undefined;
    }
    const safeMessage = sanitizeSessionPayload(message);
    session.messages.push(safeMessage);
    session.updatedAt = new Date().toISOString();
    this.#persistAll();
    return safeMessage;
  }

  appendRun(sessionId: string, run: AgentRun): AgentRun | undefined {
    if (this.#threadStore) {
      return this.#threadStore.appendRun(sessionId, run);
    }
    const session = this.#sessions.get(sessionId);
    if (!session) {
      return undefined;
    }
    const safeRun = sanitizeSessionPayload(run);
    session.runs.push(safeRun);
    session.updatedAt = new Date().toISOString();
    this.#persistAll();
    return safeRun;
  }

  updateRun(sessionId: string, run: AgentRun): void {
    if (this.#threadStore) {
      this.#threadStore.updateRun(run);
      return;
    }
    const session = this.#sessions.get(sessionId);
    const existingRun = session?.runs.find((entry) => entry.id === run.id);
    if (!session || !existingRun) {
      return;
    }
    Object.assign(existingRun, sanitizeSessionPayload(run));
    session.updatedAt = new Date().toISOString();
    this.#persistAll();
  }

  appendRunEvent(sessionId: string, runId: string | undefined, event: AgentRunEvent): AgentRunEvent | undefined {
    if (this.#threadStore) {
      return this.#threadStore.appendRunEvent(sessionId, runId, event);
    }
    const session = this.#sessions.get(sessionId);
    const run = runId ? session?.runs.find((entry) => entry.id === runId) : undefined;
    if (!session || !run) {
      return undefined;
    }
    const safeEvent = sanitizeSessionPayload(event);
    run.events.push(safeEvent);
    session.updatedAt = new Date().toISOString();
    this.#persistAll();
    return safeEvent;
  }

  updateContext(sessionId: string, context: TuiAgentContext): void {
    if (this.#threadStore) {
      this.#threadStore.updateContext(sessionId, context);
      return;
    }
    const session = this.#sessions.get(sessionId);
    if (!session) {
      return;
    }
    session.context = sanitizeAgentPayload(context);
    session.updatedAt = new Date().toISOString();
    this.#persistAll();
  }

  clear(sessionId: string): boolean {
    if (this.#threadStore) {
      return this.#threadStore.clearSession(sessionId);
    }
    const deleted = this.#sessions.delete(sessionId);
    if (deleted) {
      this.#persistAll();
    }
    return deleted;
  }

  persist(sessionId: string): void {
    if (this.#threadStore) {
      this.#threadStore.persistSession(sessionId);
      return;
    }
    if (this.#sessions.has(sessionId)) {
      this.#persistAll();
    }
  }

  summary(session: AgentSession): AgentSession {
    if (this.#threadStore) {
      return this.#threadStore.summary(session);
    }
    return {
      ...session,
      messages: session.messages.slice(-5),
      runs: session.runs.slice(-5)
    };
  }

  maxEventSequence(): number {
    if (this.#threadStore) {
      return this.#threadStore.maxEventSequence();
    }
    let max = 0;
    for (const session of this.#sessions.values()) {
      for (const run of session.runs) {
        for (const event of run.events) {
          max = Math.max(max, event.sequence);
        }
      }
    }
    return max;
  }

  sessionEvents(sessionId: string, afterSequence = 0): AgentRunEvent[] {
    if (this.#threadStore) {
      return this.#threadStore.sessionEvents(sessionId, afterSequence);
    }
    return (
      this.#sessions
        .get(sessionId)
        ?.runs.flatMap((run) => run.events)
        .filter((event) => event.sequence > afterSequence) ?? []
    );
  }

  contextPreview(sessionId: string): AgentThreadContextPreview | undefined {
    if (this.#threadStore) {
      return this.#threadStore.contextPreview(sessionId);
    }
    const session = this.#sessions.get(sessionId);
    if (!session) {
      return undefined;
    }
    const events = session.runs.flatMap((run) => run.events);
    const pendingApprovals = events
      .filter((event) => event.type === "tool.approval_required")
      .flatMap((event) => {
        const approval =
          event.data && typeof event.data === "object" ? (event.data as { approval?: unknown }).approval : undefined;
        return approval && typeof approval === "object"
          ? [approval as AgentThreadContextPreview["pendingApprovals"][number]]
          : [];
      })
      .filter((approval) => approval.status === "pending" || approval.status === "recovered_pending");
    return {
      sessionId,
      active: this.getActive()?.id === sessionId,
      ...(session.title ? { title: session.title } : {}),
      summary: {
        generatedAt: new Date().toISOString(),
        messageCount: session.messages.length,
        runCount: session.runs.length,
        eventCount: events.length,
        pendingApprovalCount: pendingApprovals.length,
        recoveredApprovalCount: pendingApprovals.filter((approval) => approval.status === "recovered_pending").length,
        ...(events.at(-1) ? { lastEventSequence: events.at(-1)?.sequence } : {}),
        ...(session.messages.findLast((message) => message.role === "user")
          ? { lastUserMessage: session.messages.findLast((message) => message.role === "user")?.content }
          : {}),
        ...(session.messages.findLast((message) => message.role === "assistant")
          ? { lastAssistantMessage: session.messages.findLast((message) => message.role === "assistant")?.content }
          : {})
      },
      privacy: session.privacy ?? { mode: "standard", advancedRedactedDetailEnabled: false },
      recentMessages: session.messages.slice(-8),
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
    this.#threadStore?.recordExport(result);
  }

  diagnostics(): ThreadStoreDiagnostic[] {
    return this.#threadStore?.diagnostics() ?? [];
  }

  threadStore(): ThreadStore | undefined {
    return this.#threadStore;
  }

  close(): void {
    this.#threadStore?.close();
  }

  #pruneExpired(now = Date.now()): void {
    let changed = false;
    for (const [sessionId, session] of this.#sessions) {
      const updatedAt = Date.parse(session.updatedAt || session.createdAt);
      if (Number.isFinite(updatedAt) && now - updatedAt > this.#retentionMs) {
        this.#sessions.delete(sessionId);
        changed = true;
      }
    }
    if (changed) {
      this.#persistAll();
    }
  }

  #persistAll(): void {
    this.#pruneExpired();
  }
}

export { sanitizeSessionPayload } from "./sessionSanitizer.ts";
