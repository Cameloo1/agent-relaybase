import type { AgentRun } from "./types.ts";

const TERMINAL_RUN_STATUSES = new Set<AgentRun["status"]>(["waiting_for_approval", "completed", "failed", "cancelled"]);

export async function waitForAgentRunTerminal(
  readRun: () => Promise<AgentRun>,
  options: { label: string; timeoutMs?: number; pollIntervalMs?: number }
): Promise<AgentRun> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const startedAt = Date.now();
  let lastRun: AgentRun | undefined;

  while (Date.now() - startedAt < timeoutMs) {
    lastRun = await readRun();
    if (TERMINAL_RUN_STATUSES.has(lastRun.status)) {
      return lastRun;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(
    `AGENT_LIVE_RUN_TIMEOUT: timed out waiting for ${options.label}; last status ${lastRun?.status ?? "unknown"}.`
  );
}

export async function waitForAgentRunCompletion(
  readRun: () => Promise<AgentRun>,
  options: { label: string; timeoutMs?: number; pollIntervalMs?: number }
): Promise<AgentRun> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const startedAt = Date.now();
  let lastRun: AgentRun | undefined;

  while (Date.now() - startedAt < timeoutMs) {
    lastRun = await readRun();
    if (["completed", "failed", "cancelled"].includes(lastRun.status)) {
      return lastRun;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(
    `AGENT_LIVE_RUN_COMPLETION_TIMEOUT: timed out waiting for ${options.label}; last status ${lastRun?.status ?? "unknown"}.`
  );
}
