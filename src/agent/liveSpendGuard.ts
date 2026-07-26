import type { AgentUsage } from "./types.ts";

export interface SpendCheckpoint {
  label: string;
  localKnownUsd: number;
  accountDeltaUsd: number | null;
  ceilingUsd: number;
}

export class LiveSpendCapacityError extends Error {
  readonly checkpoint: SpendCheckpoint;

  constructor(message: string, checkpoint: SpendCheckpoint) {
    super(message);
    this.name = "LiveSpendCapacityError";
    this.checkpoint = checkpoint;
  }
}

export class LiveSpendGuard {
  readonly #apiKey: string;
  readonly #ceilingUsd: number;
  readonly #fetch: typeof fetch;
  #accountBefore: number | null = null;
  #localCosts = new Map<string, number>();

  constructor(apiKey: string, ceilingUsd: number, fetchImplementation: typeof fetch = fetch) {
    if (!apiKey) throw new Error("LIVE_SPEND_GUARD_KEY_MISSING");
    if (!Number.isFinite(ceilingUsd) || ceilingUsd <= 0) throw new Error("LIVE_SPEND_GUARD_CEILING_INVALID");
    this.#apiKey = apiKey;
    this.#ceilingUsd = ceilingUsd;
    this.#fetch = fetchImplementation;
  }

  async begin(): Promise<SpendCheckpoint> {
    this.#accountBefore = await this.#readAccountUsage();
    return this.#snapshot("before-live-evaluation", this.#accountBefore);
  }

  recordRun(runId: string, usage: AgentUsage | undefined): void {
    if (!usage || this.#localCosts.has(runId)) return;
    const cost = usageCost(usage);
    if (cost !== null) this.#localCosts.set(runId, cost);
    this.#assertInsideCeiling(this.localKnownUsd(), "local run accounting");
  }

  async checkpoint(label: string): Promise<SpendCheckpoint> {
    const current = await this.#readAccountUsage();
    const checkpoint = this.#snapshot(label, current);
    const effective = Math.max(checkpoint.localKnownUsd, checkpoint.accountDeltaUsd ?? 0);
    this.#assertInsideCeiling(effective, label);
    return checkpoint;
  }

  async assertRequestCapacity(label: string, reserveUsd: number): Promise<SpendCheckpoint> {
    if (!Number.isFinite(reserveUsd) || reserveUsd <= 0) {
      throw new Error("LIVE_SPEND_GUARD_RESERVE_INVALID");
    }
    const current = await this.#readAccountUsage();
    const checkpoint = this.#snapshot(`before:${label}`, current);
    const effective = Math.max(checkpoint.localKnownUsd, checkpoint.accountDeltaUsd ?? 0);
    if (effective + reserveUsd > this.#ceilingUsd + Number.EPSILON) {
      throw new LiveSpendCapacityError(
        `AGENT_LIVE_SPEND_CAPACITY_EXHAUSTED: ${label} requires $${reserveUsd.toFixed(3)} reserve with $${effective.toFixed(6)} already measured against $${this.#ceilingUsd.toFixed(2)}.`,
        checkpoint
      );
    }
    return checkpoint;
  }

  localKnownUsd(): number {
    return [...this.#localCosts.values()].reduce((total, cost) => total + cost, 0);
  }

  #snapshot(label: string, current: number | null): SpendCheckpoint {
    const accountDeltaUsd =
      this.#accountBefore === null || current === null ? null : Math.max(0, current - this.#accountBefore);
    return {
      label,
      localKnownUsd: this.localKnownUsd(),
      accountDeltaUsd,
      ceilingUsd: this.#ceilingUsd
    };
  }

  #assertInsideCeiling(value: number, label: string): void {
    if (value > this.#ceilingUsd + Number.EPSILON) {
      throw new Error(
        `AGENT_LIVE_SPEND_LIMIT_EXCEEDED: ${label} measured $${value.toFixed(6)} above $${this.#ceilingUsd.toFixed(2)}.`
      );
    }
  }

  async #readAccountUsage(): Promise<number | null> {
    const response = await this.#fetch("https://openrouter.ai/api/v1/auth/key", {
      headers: { Authorization: `Bearer ${this.#apiKey}` }
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { data?: { usage?: unknown } };
    const usage = payload.data?.usage;
    return typeof usage === "number" && Number.isFinite(usage) ? usage : null;
  }
}

function usageCost(usage: AgentUsage): number | null {
  if (usage.costUsd !== undefined) {
    const parsed = Number(usage.costUsd);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return Number.isFinite(usage.estimatedCostUsd) && usage.estimatedCostUsd >= 0 ? usage.estimatedCostUsd : null;
}
