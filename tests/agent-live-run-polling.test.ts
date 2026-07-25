import assert from "node:assert/strict";
import test from "node:test";
import { waitForAgentRunCompletion, waitForAgentRunTerminal } from "../src/agent/liveRunPolling.ts";
import type { AgentRun, AgentRunStatus } from "../src/agent/types.ts";

test("live runner waits through asynchronous queued and running states", async () => {
  const statuses: AgentRunStatus[] = ["queued", "running", "completed"];
  let reads = 0;
  const run = await waitForAgentRunTerminal(async () => makeRun(statuses[Math.min(reads++, statuses.length - 1)]), {
    label: "test run",
    timeoutMs: 100,
    pollIntervalMs: 0
  });

  assert.equal(run.status, "completed");
  assert.equal(reads, 3);
});

test("live runner treats approval as a stable terminal handoff", async () => {
  const run = await waitForAgentRunTerminal(async () => makeRun("waiting_for_approval"), {
    label: "approval run",
    timeoutMs: 100,
    pollIntervalMs: 0
  });

  assert.equal(run.status, "waiting_for_approval");
});

test("live runner reports the last observed state on timeout", async () => {
  await assert.rejects(
    waitForAgentRunTerminal(async () => makeRun("running"), {
      label: "stuck run",
      timeoutMs: 1,
      pollIntervalMs: 0
    }),
    /AGENT_LIVE_RUN_TIMEOUT:.*last status running/
  );
});

test("live approval continuation waits past approval state until completion", async () => {
  const statuses: AgentRunStatus[] = ["waiting_for_approval", "running", "completed"];
  let reads = 0;
  const run = await waitForAgentRunCompletion(async () => makeRun(statuses[Math.min(reads++, statuses.length - 1)]), {
    label: "approved run",
    timeoutMs: 100,
    pollIntervalMs: 0
  });

  assert.equal(run.status, "completed");
  assert.equal(reads, 3);
});

function makeRun(status: AgentRunStatus): AgentRun {
  return {
    id: "run-test",
    sessionId: "session-test",
    status,
    createdAt: "2026-07-17T00:00:00.000Z",
    provider: "openrouter",
    events: []
  };
}
