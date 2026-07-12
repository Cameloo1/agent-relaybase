import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OperationStore } from "../src/operationStore.ts";
import { AgentAuditStore } from "../src/agent/auditStore.ts";
import { sanitizeAgentPayloadWithReport } from "../src/agent/errors.ts";
import { AgentGatewayService } from "../src/agent/gateway.ts";
import { AgentSessionStore } from "../src/agent/sessionStore.ts";
import { ThreadStore } from "../src/agent/threadStore.ts";
import { OperatorAgentRuntime, type OperatorAgentRunner } from "../src/agent/runtime.ts";
import type { AgentRunEvent, TuiAgentContext } from "../src/agent/types.ts";
import type { RelaybaseRuntime } from "../src/server.ts";
import { createRelaybaseServer } from "../src/server.ts";
import type { AppRecord, AppStatusView, RuntimeView } from "../src/types.ts";

test("RA009 session store persists, redacts, clears, and summarizes unsafe memory", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-agent-session-store-"));
  const store = new AgentSessionStore({ stateDir });
  const session = store.create({ title: "OPENROUTER_API_KEY=sk-or-session-title" }, minimalContext());
  const run = store.appendRun(session.id, {
    id: "run-1",
    sessionId: session.id,
    status: "running",
    provider: "openrouter",
    modelSlug: "openrouter/test-model",
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    events: []
  });

  store.appendMessage(session.id, {
    id: "message-1",
    sessionId: session.id,
    runId: "run-1",
    role: "user",
    content: "Bearer abc.def token=secret-value",
    createdAt: new Date().toISOString()
  });
  store.appendRunEvent(session.id, run?.id, {
    id: "event-1",
    sequence: 1,
    sessionId: session.id,
    runId: "run-1",
    type: "file_write_preview",
    at: new Date().toISOString(),
    data: {
      diff: {
        path: "relaybase.app.json",
        beforeExists: false,
        afterExists: true,
        changed: true,
        hunks: ["+ OPENROUTER_API_KEY=sk-or-file-diff-secret"]
      },
      recentLogs: ["token=raw-log-secret"]
    }
  });

  const reloaded = new AgentSessionStore({ stateDir });
  const saved = reloaded.get(session.id);
  assert.ok(saved);
  const serialized = JSON.stringify(saved);
  assert.doesNotMatch(serialized, /sk-or-session-title|abc\.def|secret-value|sk-or-file-diff-secret|raw-log-secret/);
  assert.match(serialized, /relaybase\.app\.json/);
  assert.doesNotMatch(serialized, /hunks/);
  assert.match(serialized, /omittedLogLineCount/);

  assert.equal(reloaded.clear(session.id), true);
  assert.deepEqual(new AgentSessionStore({ stateDir }).list(), []);
});

test("OA-THREADS-001 SQLite ThreadStore is the state-dir session and audit source of truth", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-agent-threadstore-"));
  const sessionStore = new AgentSessionStore({ stateDir });
  const auditStore = new AgentAuditStore({ stateDir });
  const session = sessionStore.create({ title: "thread token=title-secret" }, minimalContext());
  const run = sessionStore.appendRun(session.id, {
    id: "run-sqlite-1",
    sessionId: session.id,
    status: "running",
    provider: "openrouter",
    modelSlug: "openrouter/test-model",
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    events: []
  });

  sessionStore.appendMessage(session.id, {
    id: "message-sqlite-1",
    sessionId: session.id,
    runId: run?.id,
    role: "user",
    content: "OPENROUTER_API_KEY=sk-or-sqlite-message-secret",
    createdAt: new Date().toISOString()
  });
  if (run) {
    run.status = "completed";
    run.completedAt = new Date().toISOString();
    sessionStore.updateRun(session.id, run);
  }
  auditStore.append({
    type: "agent.sqlite.audit",
    sessionId: session.id,
    runId: run?.id,
    provider: "openrouter",
    modelSlug: "openrouter/test-model",
    data: { bearer: "Bearer sqlite-audit-secret" }
  });

  const dbPath = path.join(stateDir, "agent", "agent.sqlite");
  assert.equal(await exists(dbPath), true);
  assert.equal(await exists(path.join(stateDir, "agent", "sessions.json")), false);
  assert.equal(await exists(path.join(stateDir, "agent", "audit.jsonl")), false);

  const reloadedSession = new AgentSessionStore({ stateDir }).get(session.id);
  const reloadedAudit = new AgentAuditStore({ stateDir }).list({ sessionId: session.id });
  const serializedSession = JSON.stringify(reloadedSession);
  const serializedAudit = JSON.stringify(reloadedAudit);
  const rawDatabaseBytes = await fs.readFile(dbPath, "utf8");

  assert.equal(reloadedSession?.runs[0]?.status, "completed");
  assert.equal(reloadedAudit.length, 1);
  assert.doesNotMatch(serializedSession, /title-secret|sk-or-sqlite-message-secret/);
  assert.doesNotMatch(serializedAudit, /sqlite-audit-secret/);
  assert.doesNotMatch(rawDatabaseBytes, /title-secret|sk-or-sqlite-message-secret|sqlite-audit-secret/);
});

test("OA-THREADS-001 imports legacy sessions and audit exactly once without deleting backups", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-agent-legacy-import-"));
  const agentDir = path.join(stateDir, "agent");
  await fs.mkdir(agentDir, { recursive: true });
  const legacySession = {
    id: "legacy-session-1",
    title: "Legacy",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    context: minimalContext(),
    messages: [
      {
        id: "legacy-message-1",
        sessionId: "legacy-session-1",
        role: "user",
        content: "token=legacy-message-secret",
        createdAt: new Date().toISOString()
      }
    ],
    runs: [
      {
        id: "legacy-run-1",
        sessionId: "legacy-session-1",
        status: "completed",
        provider: "openrouter",
        modelSlug: "openrouter/test-model",
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        events: [
          {
            id: "legacy-event-1",
            sequence: 7,
            sessionId: "legacy-session-1",
            runId: "legacy-run-1",
            type: "answer",
            at: new Date().toISOString(),
            data: { content: "OPENROUTER_API_KEY=sk-or-legacy-event-secret" }
          }
        ]
      }
    ]
  };
  await fs.writeFile(path.join(agentDir, "sessions.json"), JSON.stringify({ version: 1, sessions: [legacySession] }));
  await fs.writeFile(
    path.join(agentDir, "audit.jsonl"),
    `${JSON.stringify({
      id: "legacy-audit-1",
      at: new Date().toISOString(),
      sessionId: "legacy-session-1",
      runId: "legacy-run-1",
      type: "agent.legacy",
      provider: "openrouter",
      modelSlug: "openrouter/test-model",
      data: { secret: "Bearer legacy-audit-secret" }
    })}\n`
  );

  const imported = new AgentSessionStore({ stateDir });
  assert.equal(imported.get("legacy-session-1")?.id, "legacy-session-1");
  assert.equal(imported.maxEventSequence(), 7);
  assert.equal(new AgentAuditStore({ stateDir }).list({ sessionId: "legacy-session-1" }).length, 1);

  const reloaded = new AgentSessionStore({ stateDir });
  assert.equal(reloaded.get("legacy-session-1")?.messages.length, 1);
  assert.equal(new AgentAuditStore({ stateDir }).list({ sessionId: "legacy-session-1" }).length, 1);
  assert.equal(await exists(path.join(agentDir, "sessions.json")), true);
  assert.equal(await exists(path.join(agentDir, "audit.jsonl")), true);
  assert.doesNotMatch(JSON.stringify(reloaded.get("legacy-session-1")), /legacy-message-secret|legacy-event-secret/);
  assert.doesNotMatch(JSON.stringify(new AgentAuditStore({ stateDir }).list()), /legacy-audit-secret/);
});

test("OA-THREADS-001 corrupt legacy files produce diagnostics without crashing", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-agent-corrupt-legacy-"));
  const agentDir = path.join(stateDir, "agent");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(path.join(agentDir, "sessions.json"), "{ not valid json", "utf8");
  await fs.writeFile(path.join(agentDir, "audit.jsonl"), "{ not valid jsonl\n", "utf8");

  const store = new AgentSessionStore({ stateDir });

  assert.deepEqual(store.list(), []);
  assert.ok(store.diagnostics().some((diagnostic) => diagnostic.code === "AGENT_LEGACY_SESSIONS_IMPORT_FAILED"));
  assert.ok(store.diagnostics().some((diagnostic) => diagnostic.code === "AGENT_LEGACY_AUDIT_IMPORT_PARTIAL"));
});

test("OA-THREADS-001 corrupt SQLite database is quarantined and recreated", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-agent-corrupt-sqlite-"));
  const agentDir = path.join(stateDir, "agent");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(path.join(agentDir, "agent.sqlite"), "this is not sqlite", "utf8");

  const store = new AgentSessionStore({ stateDir });
  const session = store.create({}, minimalContext());
  const files = await fs.readdir(agentDir);

  assert.ok(store.get(session.id));
  assert.ok(files.some((file) => file.startsWith("agent.sqlite.broken.")));
  assert.ok(store.diagnostics().some((diagnostic) => diagnostic.code === "AGENT_SQLITE_QUARANTINED"));
});

test("OA-THREADS-001 ThreadStore active-thread metadata lives in SQLite schema_meta", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-agent-thread-meta-"));
  const store = new ThreadStore({ stateDir });
  const session = store.createSession({ title: "Active thread" }, minimalContext());

  assert.equal(store.getActiveThread(), session.id);
  assert.equal(store.clearSession(session.id), true);
  assert.equal(store.getActiveThread(), undefined);
});

test("RA009 daemon session and audit files survive restart without storing secrets", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-agent-restart-"));
  const previous = saveEnv([
    "OPENROUTER_API_KEY",
    "RELAYBASE_AGENT_MODEL",
    "RELAYBASE_AGENT_ENABLED",
    "RELAYBASE_AGENT_REMOTE_MODEL_ENABLED"
  ]);
  process.env.OPENROUTER_API_KEY = "sk-or-daemon-restart-secret";
  delete process.env.RELAYBASE_AGENT_MODEL;
  delete process.env.RELAYBASE_AGENT_ENABLED;
  delete process.env.RELAYBASE_AGENT_REMOTE_MODEL_ENABLED;
  const first = await createRelaybaseServer({ port: 0, stateDir });

  try {
    const session = await first.runtime.agentGateway.createSession(first.runtime, {});
    await first.runtime.agentGateway.addMessage(first.runtime, session.id, {
      content: "status with OPENROUTER_API_KEY=sk-or-message-secret"
    });
    assert.ok(first.runtime.agentGateway.auditEvents().some((event) => event.type === "agent.trace_event"));
  } finally {
    await first.close();
  }

  const second = await createRelaybaseServer({ port: 0, stateDir });
  try {
    const sessions = second.runtime.agentGateway.listSessions();
    assert.equal(sessions.length, 1);
    const serializedSession = JSON.stringify(second.runtime.agentGateway.getSession(sessions[0]!.id));
    const serializedAudit = JSON.stringify(second.runtime.agentGateway.auditEvents());
    assert.doesNotMatch(serializedSession, /sk-or-daemon-restart-secret|sk-or-message-secret/);
    assert.doesNotMatch(serializedAudit, /sk-or-daemon-restart-secret|sk-or-message-secret/);
    assert.ok(second.runtime.agentGateway.auditEvents().some((event) => event.type === "agent.run_blocked"));
  } finally {
    await second.close();
    restoreEnvValues(previous);
  }
});

test("Agent run idempotency survives gateway restart and interrupted queued work fails closed", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-agent-run-restart-"));
  const runtime = fakeRelaybaseRuntime();
  const firstGateway = new AgentGatewayService({ stateDir });
  const session = await firstGateway.createSession(runtime, {});
  const first = await firstGateway.addMessage(runtime, session.id, {
    content: "inspect the app",
    idempotencyKey: "restart-safe-message-1"
  });
  assert.equal(first.run.status, "failed");

  const restartedGateway = new AgentGatewayService({ stateDir });
  const duplicate = await restartedGateway.addMessage(runtime, session.id, {
    content: "inspect the app",
    idempotencyKey: "restart-safe-message-1"
  });
  assert.equal(duplicate.reused, true);
  assert.equal(duplicate.message.id, first.message.id);
  assert.equal(duplicate.run.id, first.run.id);

  const interruptedStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-agent-run-interrupted-"));
  const store = new AgentSessionStore({ stateDir: interruptedStateDir });
  const interruptedSession = store.create({}, minimalContext());
  const createdAt = new Date().toISOString();
  store.appendMessage(interruptedSession.id, {
    id: "message-interrupted-1",
    sessionId: interruptedSession.id,
    runId: "run-interrupted-1",
    role: "user",
    content: "start the app",
    createdAt
  });
  store.appendRun(interruptedSession.id, {
    id: "run-interrupted-1",
    sessionId: interruptedSession.id,
    status: "queued",
    provider: "openrouter",
    modelSlug: "openrouter/test-model",
    createdAt,
    events: []
  });

  const reconciledGateway = new AgentGatewayService({ stateDir: interruptedStateDir });
  const reconciledRun = reconciledGateway.getRun(interruptedSession.id, "run-interrupted-1");
  assert.equal(reconciledRun.status, "failed");
  assert.equal(reconciledRun.diagnostic?.code, "AGENT_RUN_INTERRUPTED");
  assert.match(reconciledRun.diagnostic?.userAction ?? "", /retry/i);
  const failedEvent = reconciledGateway
    .sessionEvents(interruptedSession.id)
    .find((event) => event.runId === reconciledRun.id && event.type === "run.failed");
  assert.ok(failedEvent);
  assert.equal(failedEvent.id, String(failedEvent.sequence));
  assert.match(failedEvent.id, /^\d+$/);
});

test("RA009 budget limit blocks before model spend and audits the block", async () => {
  await withEnvAsync("RELAYBASE_TEST_OPENROUTER_KEY", "sk-or-budget-secret", async () => {
    let modelCalled = false;
    const gateway = new AgentGatewayService({
      agentRuntime: new OperatorAgentRuntime({
        runnerFactory: () => ({
          async run() {
            modelCalled = true;
            return { finalOutput: "should not run", completed: Promise.resolve(), usage: { estimatedCostUsd: 0.01 } };
          }
        })
      })
    });
    gateway.updateConfig({
      enabled: true,
      provider: {
        modelSlug: "openrouter/test-model",
        remoteModelEnabled: true,
        apiKeyEnvVar: "RELAYBASE_TEST_OPENROUTER_KEY"
      },
      budgets: {
        sessionLimitUsd: 0
      }
    });
    const runtime = fakeRelaybaseRuntime();
    const session = await gateway.createSession(runtime, {});
    const result = await gateway.addMessage(runtime, session.id, { content: "what is broken?" });

    assert.equal(modelCalled, false);
    assert.equal(result.run.status, "failed");
    assert.equal(result.diagnostics[0]?.code, "AGENT_BUDGET_EXCEEDED");
    assert.ok(gateway.auditEvents().some((event) => event.type === "agent.budget_blocked"));
  });
});

test("RA009 audit records approval, tool, setup, manifest, prove, repair, and usage lifecycle", async () => {
  await withEnvAsync("RELAYBASE_TEST_OPENROUTER_KEY", "sk-or-audit-secret", async () => {
    const fixture = fakeApprovalRelaybaseRuntime();
    const gateway = gatewayWithApprovalRunner("start_app", { appId: "notes-web" });
    const session = await gateway.createSession(fixture.runtime, {});
    const result = await gateway.addMessage(fixture.runtime, session.id, { content: "start notes" });
    await waitFor(() => gateway.getRun(session.id, result.run.id).status === "waiting_for_approval");
    const approval = approvalFromEvents(gateway.sessionEvents(session.id));
    await gateway.resolveApproval(fixture.runtime, approval.id, "approved");

    const directAudit = new AgentAuditStore();
    directAudit.append({
      type: "agent.setup_plan_previewed",
      provider: "openrouter",
      sessionId: session.id,
      runId: result.run.id,
      data: { setupPlanId: "managed-web", env: "OPENROUTER_API_KEY=sk-or-plan-secret" }
    });
    directAudit.append({
      type: "agent.manifest_patched",
      provider: "openrouter",
      sessionId: session.id,
      runId: result.run.id,
      data: { manifestPath: "relaybase.app.json", fields: ["healthUrl"] }
    });
    directAudit.append({
      type: "agent.prove_result",
      provider: "openrouter",
      sessionId: session.id,
      runId: result.run.id,
      data: { status: "succeeded" }
    });
    directAudit.append({
      type: "agent.repair_attempt",
      provider: "openrouter",
      sessionId: session.id,
      runId: result.run.id,
      data: { repairPlanId: "repair-1" }
    });

    const auditTypes = new Set([...gateway.auditEvents(), ...directAudit.list()].map((event) => event.type));
    assert.ok(auditTypes.has("agent.run_requested"));
    assert.ok(auditTypes.has("agent.approval_required"));
    assert.ok(auditTypes.has("agent.approval_approved"));
    assert.ok(auditTypes.has("agent.tool_completed"));
    assert.ok(auditTypes.has("agent.trace_event"));
    assert.ok(auditTypes.has("agent.setup_plan_previewed"));
    assert.ok(auditTypes.has("agent.manifest_patched"));
    assert.ok(auditTypes.has("agent.prove_result"));
    assert.ok(auditTypes.has("agent.repair_attempt"));
    assert.doesNotMatch(
      JSON.stringify([...gateway.auditEvents(), ...directAudit.list()]),
      /sk-or-audit-secret|sk-or-plan-secret/
    );
  });
});

test("OA-THREADS-002 persisted approvals recover pending and require reconfirmation before execution", async () => {
  await withEnvAsync("RELAYBASE_TEST_OPENROUTER_KEY", "sk-or-recovered-approval-secret", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-agent-approval-recovery-"));
    const fixture = fakeApprovalRelaybaseRuntime();
    const gateway = gatewayWithApprovalRunner("start_app", { appId: "notes-web" }, stateDir);
    const session = await gateway.createSession(fixture.runtime, {});
    const submitted = await gateway.addMessage(fixture.runtime, session.id, { content: "start notes" });
    await waitFor(() => gateway.getRun(session.id, submitted.run.id).status === "waiting_for_approval");
    const approval = approvalFromEvents(gateway.sessionEvents(session.id));

    const restarted = new AgentGatewayService({ stateDir });
    const recovered = restarted.getApproval(approval.id);
    assert.equal(recovered.status, "recovered_pending");
    assert.equal(recovered.rawArgumentsPersisted, true);

    await assert.rejects(
      () => restarted.resolveApproval(fixture.runtime, approval.id, "approved"),
      (error: unknown) =>
        Boolean(
          error &&
          typeof error === "object" &&
          "code" in error &&
          (error as { code?: string }).code === "AGENT_APPROVAL_RECONFIRM_REQUIRED"
        )
    );
    assert.equal(fixture.calls.start, 0);

    const approved = await restarted.resolveApproval(fixture.runtime, approval.id, "approved", { reconfirm: true });
    assert.equal(approved.status, "approved");
    await waitFor(() => fixture.calls.start === 1);
  });
});

test("RA009 session export writes a redacted chat/audit artifact", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-agent-export-"));
  const gateway = new AgentGatewayService({ stateDir });
  const runtime = fakeRelaybaseRuntime();
  const session = await gateway.createSession(runtime, { title: "session token=export-secret" });
  gateway.updateConfig({ budgets: { sessionLimitUsd: 10 } });
  await gateway.addMessage(runtime, session.id, { content: "Bearer export-secret-token" });

  const exported = gateway.exportSession(session.id);
  const artifact = await fs.readFile(exported.outputPath, "utf8");

  assert.equal(exported.status, "succeeded");
  assert.equal(exported.format, "json");
  assert.ok(exported.auditEventCount > 0);
  assert.ok(exported.redactionReport.totalReplacements >= 0);
  assert.doesNotMatch(artifact, /export-secret|export-secret-token/);
});

test("AGENT-TUI-MATRIX-004 redaction covers config, session, audit, prompt, and TUI stream payloads", async () => {
  await withEnvAsync("RELAYBASE_TEST_OPENROUTER_KEY", "sk-or-stream-redaction-secret", async () => {
    const rawPayload = {
      prompt: [
        "OPENROUTER_API_KEY=sk-or-inline-openrouter-secret",
        "Relaybase token relaybase-token-secret",
        "Authorization: Bearer bearer-redaction-secret",
        "Cookie=sessionid-redaction-secret",
        "session=raw-session-secret",
        "//registry.npmjs.org/:_authToken=npm-private-redaction-secret",
        "password=hunter2",
        "api_key=plain-api-key-secret"
      ].join(" "),
      diff: {
        path: ".env",
        hunks: ["+ API_KEY=sk-file-diff-secret", "+ SESSION_SECRET=session-file-secret"]
      }
    };
    const sanitized = sanitizeAgentPayloadWithReport(rawPayload, ["relaybase-token-secret"]);
    const serializedSanitized = JSON.stringify(sanitized);

    assert.equal(sanitized.report.totalReplacements >= 8, true);
    assert.doesNotMatch(
      serializedSanitized,
      /sk-or-inline-openrouter-secret|relaybase-token-secret|bearer-redaction-secret|raw-session-secret|npm-private-redaction-secret|hunter2|plain-api-key-secret|sk-file-diff-secret|session-file-secret/
    );

    const gateway = new AgentGatewayService({
      agentRuntime: new OperatorAgentRuntime({
        runnerFactory: () => new SecretEchoRunner()
      })
    });
    gateway.updateConfig({
      enabled: true,
      provider: {
        modelSlug: "openrouter/test-model",
        remoteModelEnabled: true,
        apiKeyEnvVar: "RELAYBASE_TEST_OPENROUTER_KEY"
      }
    });
    const runtime = fakeRelaybaseRuntime();
    const session = await gateway.createSession(runtime, {});
    const streamed: AgentRunEvent[] = [];
    const unsubscribe = gateway.subscribeSession(session.id, (event) => streamed.push(event));

    try {
      const submitted = await gateway.addMessage(runtime, session.id, {
        content:
          "Please summarize OPENROUTER_API_KEY=sk-or-user-message-secret Authorization: Bearer user-bearer-secret"
      });
      await waitFor(() => gateway.getRun(session.id, submitted.run.id).status === "completed");
    } finally {
      unsubscribe();
    }

    const combined = JSON.stringify({
      config: gateway.getConfig(),
      session: gateway.getSession(session.id),
      audit: gateway.auditEvents(),
      stream: streamed
    });
    assert.doesNotMatch(
      combined,
      /sk-or-stream-redaction-secret|sk-or-user-message-secret|user-bearer-secret|model-delta-secret|model-answer-secret|relaybase-token-secret|session-cookie-secret/
    );
    assert.match(combined, /\[redacted\]/);
    assert.ok(streamed.some((event) => event.type === "model.delta"));
    assert.ok(streamed.some((event) => event.type === "answer"));
  });
});

class SecretEchoRunner implements OperatorAgentRunner {
  async run(): Promise<any> {
    return {
      finalOutput:
        "Answer contains OPENROUTER_API_KEY=sk-or-model-answer-secret Cookie=session-cookie-secret relaybase-token-secret",
      usage: { inputTokens: 10, outputTokens: 4, estimatedCostUsd: 0.001 },
      completed: Promise.resolve(),
      async *[Symbol.asyncIterator]() {
        yield { data: { delta: "delta Authorization: Bearer model-delta-secret relaybase-token-secret" } };
      }
    };
  }
}

class ApprovalInterruptionRunner implements OperatorAgentRunner {
  private readonly toolName: string;
  private readonly args: Record<string, unknown>;

  constructor(toolName: string, args: Record<string, unknown>) {
    this.toolName = toolName;
    this.args = args;
  }

  async run(): Promise<any> {
    const serialized = JSON.stringify(this.args);
    return {
      finalOutput: "",
      usage: { inputTokens: 20, outputTokens: 2, estimatedCostUsd: 0.001 },
      interruptions: [
        {
          name: this.toolName,
          arguments: serialized,
          rawItem: {
            id: "tool_call_approval_1",
            name: this.toolName,
            arguments: serialized
          }
        }
      ],
      completed: Promise.resolve()
    };
  }
}

function gatewayWithApprovalRunner(
  toolName: string,
  args: Record<string, unknown>,
  stateDir?: string
): AgentGatewayService {
  const gateway = new AgentGatewayService({
    stateDir,
    agentRuntime: new OperatorAgentRuntime({
      runnerFactory: () => new ApprovalInterruptionRunner(toolName, args)
    })
  });
  gateway.updateConfig({
    enabled: true,
    provider: {
      modelSlug: "openrouter/test-model",
      remoteModelEnabled: true,
      apiKeyEnvVar: "RELAYBASE_TEST_OPENROUTER_KEY"
    }
  });
  return gateway;
}

function approvalFromEvents(events: AgentRunEvent[]) {
  const event = events.find((entry) => entry.type === "tool.approval_required");
  const approval = (event?.data as { approval?: { id: string } } | undefined)?.approval;
  if (!approval) {
    throw new Error("Expected approval payload.");
  }
  return approval;
}

function fakeRelaybaseRuntime(): RelaybaseRuntime {
  return {
    host: "127.0.0.1",
    port: 37373,
    stateDir: "C:\\relaybase-test-state",
    token: "relaybase-token-secret",
    registry: {
      list: async () => []
    } as RelaybaseRuntime["registry"],
    processes: {
      listStatuses: async () => [],
      logs: async () => []
    } as unknown as RelaybaseRuntime["processes"],
    logStore: {} as RelaybaseRuntime["logStore"],
    exports: {} as RelaybaseRuntime["exports"],
    agentGateway: {} as RelaybaseRuntime["agentGateway"],
    operations: new OperationStore(),
    events: {
      publish: () => undefined
    } as RelaybaseRuntime["events"],
    mcp: {} as RelaybaseRuntime["mcp"]
  };
}

function fakeApprovalRelaybaseRuntime(): {
  runtime: RelaybaseRuntime;
  calls: { start: number };
} {
  const calls = { start: 0 };
  const app = approvalAppStatus();
  const runtime: RelaybaseRuntime = {
    ...fakeRelaybaseRuntime(),
    registry: {
      list: async () => [stripRuntime(app)],
      get: async (id: string) => (id === app.id ? stripRuntime(app) : undefined)
    } as RelaybaseRuntime["registry"],
    processes: {
      listStatuses: async () => [app],
      logs: async () => [],
      start: async () => {
        calls.start += 1;
        app.runtime = runningRuntime();
        return app.runtime;
      }
    } as unknown as RelaybaseRuntime["processes"],
    operations: new OperationStore()
  };
  return { runtime, calls };
}

function approvalAppStatus(): AppStatusView {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: "notes-web",
    name: "Notes Web",
    command: "npm.cmd run dev",
    cwd: "C:\\project",
    protocol: "tcp",
    env: {},
    createdAt: now,
    updatedAt: now,
    runtime: stoppedRuntime()
  };
}

function stripRuntime(app: AppStatusView): AppRecord {
  const { runtime: _runtime, ...record } = app;
  return record;
}

function runningRuntime(): RuntimeView {
  return {
    status: "running",
    health: "healthy",
    phase: "running",
    assignedPort: 45678,
    pid: 1234,
    logLines: 0
  };
}

function stoppedRuntime(): RuntimeView {
  return {
    status: "stopped",
    health: "unknown",
    phase: "stopped",
    logLines: 0
  };
}

function minimalContext(overrides: Partial<TuiAgentContext> = {}): TuiAgentContext {
  return {
    daemonHasZeroApps: true,
    diagnostics: [],
    ...overrides
  };
}

async function withEnvAsync(name: string, value: string, callback: () => Promise<void>): Promise<void> {
  const previous = process.env[name];
  process.env[name] = value;
  try {
    await callback();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
}

function saveEnv(names: string[]): Map<string, string | undefined> {
  return new Map(names.map((name) => [name, process.env[name]]));
}

function restoreEnvValues(values: Map<string, string | undefined>): void {
  for (const [name, value] of values.entries()) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (condition()) {
      return;
    }
    await delay(5);
  }
  assert.equal(condition(), true);
}
