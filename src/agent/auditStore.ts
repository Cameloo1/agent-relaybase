import { randomUUID } from "node:crypto";
import { sanitizeAgentPayload } from "./errors.ts";
import { ThreadStore } from "./threadStore.ts";
import type { AgentAuditEvent } from "./types.ts";

const DEFAULT_MAX_EVENTS = 2000;

export interface AgentAuditStoreOptions {
  stateDir?: string;
  maxEvents?: number;
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

export class AgentAuditStore {
  #events: AgentAuditEvent[] = [];
  #maxEvents: number;
  #threadStore?: ThreadStore;

  constructor(options: AgentAuditStoreOptions = {}) {
    this.#maxEvents = Math.max(1, options.maxEvents ?? DEFAULT_MAX_EVENTS);
    if (options.stateDir) {
      this.#threadStore = new ThreadStore({ stateDir: options.stateDir, maxAuditEvents: options.maxEvents });
      return;
    }
  }

  append(input: AgentAuditAppendInput): AgentAuditEvent {
    if (this.#threadStore) {
      return this.#threadStore.appendAudit(input);
    }
    const event: AgentAuditEvent = sanitizeAgentPayload(
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
    );
    this.#events.push(event);
    if (this.#events.length > this.#maxEvents) {
      this.#events.splice(0, this.#events.length - this.#maxEvents);
    }
    return structuredClone(event);
  }

  list(filter: { sessionId?: string } = {}): AgentAuditEvent[] {
    if (this.#threadStore) {
      return this.#threadStore.listAudit(filter);
    }
    const events = filter.sessionId
      ? this.#events.filter((event) => event.sessionId === filter.sessionId)
      : this.#events;
    return events.map((event) => structuredClone(event));
  }

  close(): void {
    this.#threadStore?.close();
  }
}
