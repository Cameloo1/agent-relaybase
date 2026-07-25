import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertCorrectnessScore,
  captureFileTree,
  diffFileTrees,
  normalizeRuntimeEvidence,
  scoreAgentScenario,
  verifyAllowedFileChanges
} from "../src/agent/correctnessOracle.ts";
import type { AgentRunEvent } from "../src/agent/types.ts";

test("correctness oracle fingerprints exact changes and enforces the approved boundary", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-correctness-files-"));
  await fs.writeFile(path.join(root, "keep.txt"), "stable", "utf8");
  await fs.mkdir(path.join(root, ".relaybase"));
  const before = await captureFileTree(root);

  await fs.writeFile(path.join(root, ".relaybase", "setup-profile.json"), "{}", "utf8");
  const approved = await captureFileTree(root);
  assert.deepEqual(diffFileTrees(before, approved), [{ path: ".relaybase/setup-profile.json", kind: "added" }]);
  assert.equal(verifyAllowedFileChanges(before, approved, [/^\.relaybase\//]).passed, true);

  await fs.writeFile(path.join(root, "keep.txt"), "mutated", "utf8");
  const escaped = await captureFileTree(root);
  const check = verifyAllowedFileChanges(before, escaped, [/^\.relaybase\//]);
  assert.equal(check.passed, false);
  assert.match(check.evidence, /modified:keep\.txt/);
});

test("correctness oracle normalizes daemon evidence without trusting Agent prose", () => {
  const evidence = normalizeRuntimeEvidence({
    apps: [
      {
        id: "notes",
        runtime: { status: "running", health: "healthy", pid: 42, assignedPort: 45000 },
        agentUrl: "http://notes.localhost:7777"
      }
    ],
    operations: [{ id: "op-1", status: "succeeded", action: "start", appId: "notes" }],
    packages: [{ id: "pkg-1", revision: 3, appIds: ["worker", "notes"] }]
  });

  assert.deepEqual(evidence.apps[0], {
    id: "notes",
    status: "running",
    health: "healthy",
    pid: 42,
    port: 45000,
    route: "http://notes.localhost:7777"
  });
  assert.deepEqual(evidence.operations[0], {
    id: "op-1",
    status: "succeeded",
    action: "start",
    targetId: "notes"
  });
  assert.deepEqual(evidence.packages[0]?.appIds, ["notes", "worker"]);
});

test("correctness scoring checks tool choice, exact arguments, answer truth, and pending-state claims", () => {
  const events = [
    event("tool.call_requested", { toolName: "list_apps", arguments: {} }),
    event("tool.approval_required", {
      approval: { toolName: "start_app", arguments: { appId: "notes" } }
    })
  ];
  const passed = scoreAgentScenario({
    expectation: {
      label: "inventory and start",
      expectedTools: ["list_apps", "start_app"],
      exactToolArguments: { start_app: { appId: "notes" } },
      answerMustInclude: ["approval"],
      allowSuccessClaim: false
    },
    events,
    answer: "Starting Notes requires approval.",
    runStatus: "waiting_for_approval"
  });
  assert.equal(passed.status, "passed");
  assert.doesNotThrow(() => assertCorrectnessScore(passed));

  const failed = scoreAgentScenario({
    expectation: { label: "premature completion", allowSuccessClaim: false },
    events: [],
    answer: "The app started successfully.",
    runStatus: "waiting_for_approval"
  });
  assert.equal(failed.status, "failed");
  assert.throws(() => assertCorrectnessScore(failed), /claim-state-consistency/);
});

function event(type: AgentRunEvent["type"], data: unknown): AgentRunEvent {
  return {
    id: `evt-${type}`,
    sessionId: "session-1",
    runId: "run-1",
    sequence: 1,
    type,
    createdAt: new Date(0).toISOString(),
    data
  };
}
