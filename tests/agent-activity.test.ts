import assert from "node:assert/strict";
import test from "node:test";
import { AgentActivityProjector } from "../src/agent/activity.ts";

test("activity projection updates a tool row in place with semantic labels and duration", () => {
  const projector = new AgentActivityProjector();
  const started = projector.project(
    "tool.started",
    { toolCallId: "call-1", toolName: "project_read_file", arguments: { path: "C:\\secret\\src\\server.ts" } },
    "run-1",
    "2026-07-17T10:00:00.000Z"
  );
  const completed = projector.project(
    "tool.completed",
    { toolCallId: "call-1", toolName: "project_read_file", result: { status: "succeeded" } },
    "run-1",
    "2026-07-17T10:00:01.250Z"
  );
  assert.deepEqual(started, {
    id: "tool:call-1",
    kind: "tool",
    state: "active",
    label: "Reading project file",
    startedAt: "2026-07-17T10:00:00.000Z",
    detail: "server.ts"
  });
  assert.equal(completed?.id, started?.id);
  assert.equal(completed?.state, "completed");
  assert.equal(completed?.label, "Read project file");
  assert.equal(completed?.durationMs, 1250);
  assert.ok(!JSON.stringify(started).includes("C:\\secret"));
});

test("activity projection represents approval and terminal run state without reasoning", () => {
  const projector = new AgentActivityProjector();
  const analyzing = projector.project("run.started", {}, "run-2", "2026-07-17T10:00:00.000Z");
  const waiting = projector.project(
    "tool.approval_required",
    { approval: { id: "approval-1", toolName: "restart_app", arguments: { appId: "notes" } } },
    "run-2",
    "2026-07-17T10:00:00.500Z"
  );
  const finished = projector.project("run.finalized", { outcome: "completed" }, "run-2", "2026-07-17T10:00:02.000Z");
  assert.equal(analyzing?.label, "Analyzing request…");
  assert.equal(waiting?.state, "waiting_approval");
  assert.match(waiting?.label ?? "", /Approval required: Restarting app/);
  assert.equal(finished?.state, "completed");
  assert.equal(finished?.durationMs, 2000);
});

test("activity projection preserves bounded deterministic tool output for transcript expansion", () => {
  const projector = new AgentActivityProjector();
  projector.project(
    "tool.started",
    { toolCallId: "call-output", toolName: "list_apps", arguments: {} },
    "run-output",
    "2026-07-17T00:00:00.000Z"
  );
  const completed = projector.project(
    "tool.completed",
    {
      toolCallId: "call-output",
      toolName: "list_apps",
      result: { status: "succeeded", data: { zeta: 2, alpha: ["one", "two"] } }
    },
    "run-output",
    "2026-07-17T00:00:01.000Z"
  );
  assert.equal(completed?.state, "completed");
  assert.match(completed?.output ?? "", /^\{\n {2}"alpha":/);
  assert.equal(completed?.outputLineCount, 7);
  assert.equal(completed?.outputTruncated, undefined);
});

test("activity output strips terminal controls and bounds very large results", () => {
  const projector = new AgentActivityProjector();
  const lines = Array.from({ length: 240 }, (_, index) => `line-${index + 1}`);
  const completed = projector.project(
    "tool.completed",
    { toolCallId: "call-large", toolName: "project_read_file", result: `\u001b]52;c;secret\u0007${lines.join("\n")}` },
    "run-large",
    "2026-07-17T00:00:01.000Z"
  );
  assert.equal(completed?.outputLineCount, 240);
  assert.equal(completed?.outputTruncated, true);
  assert.equal(completed?.output?.split("\n").length, 200);
  assert.equal(completed?.output?.includes("\u001b"), false);
  assert.equal(completed?.output?.includes("52;c"), false);
});
