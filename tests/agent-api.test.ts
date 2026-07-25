import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentFileWriteApproval, AgentManifestPatchApproval, TuiAgentContext } from "../src/apiTypes.ts";
import { coalesceAgentReplayEvents } from "../src/agent/api.ts";
import type { AgentRunEvent } from "../src/agent/types.ts";
import { createRelaybaseServer } from "../src/server.ts";
import { loadRelaybaseEnvFile, relaybaseModelSource } from "../src/envFile.ts";
import { relaybaseAgentToolNames } from "../src/agent/tools/index.ts";

const AGENT_ENV_NAMES = [
  "OPENROUTER_API_KEY",
  "RELAYBASE_AGENT_MODEL",
  "RELAYBASE_AGENT_ENABLED",
  "RELAYBASE_AGENT_REMOTE_MODEL_ENABLED"
];

test("Agent event replay coalesces model deltas without losing text, ordering, or the latest sequence", () => {
  const deltas = Array.from({ length: 1_000 }, (_, index) => `token-${index};`);
  const events: AgentRunEvent[] = deltas.map((delta, index) => ({
    id: `event-${index + 1}`,
    sequence: index + 1,
    sessionId: "session-1",
    runId: "run-1",
    type: "model.delta",
    at: "2026-07-14T00:00:00.000Z",
    data: { delta }
  }));
  events.push({
    id: "event-1001",
    sequence: 1001,
    sessionId: "session-1",
    runId: "run-1",
    type: "run.completed",
    at: "2026-07-14T00:00:01.000Z",
    data: {}
  });

  const replay = coalesceAgentReplayEvents(events);
  const replayDeltas = replay.filter((event) => event.type === "model.delta");

  assert.ok(replayDeltas.length < 10, `expected fewer than 10 replay chunks, got ${replayDeltas.length}`);
  assert.equal(replayDeltas.map((event) => (event.data as { delta: string }).delta).join(""), deltas.join(""));
  assert.equal(replay.at(-1)?.type, "run.completed");
  assert.equal(replayDeltas.at(-1)?.sequence, 1000);
});

test("Agent Gateway config GET/PUT is token gated and never serializes raw OpenRouter key", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-agent-config-"));
  const previous = saveEnv(AGENT_ENV_NAMES);
  process.env.OPENROUTER_API_KEY = "sk-test-secret-value";
  delete process.env.RELAYBASE_AGENT_MODEL;
  delete process.env.RELAYBASE_AGENT_ENABLED;
  delete process.env.RELAYBASE_AGENT_REMOTE_MODEL_ENABLED;
  const hub = await createRelaybaseServer({ port: 0, stateDir });

  try {
    await hub.listen();
    const port = hub.address().port;
    const unauthorized = await apiRequest(port, "GET", "/__hub/api/agent/config");
    assert.equal(unauthorized.statusCode, 401);
    assert.equal(unauthorized.json.code, "UNAUTHORIZED_AGENT_GATEWAY");

    const config = await apiRequest(port, "GET", "/__hub/api/agent/config", undefined, tokenHeaders(hub.runtime.token));
    assert.equal(config.statusCode, 200);
    assert.equal(config.json.agent.config.provider.provider, "openrouter");
    assert.equal(config.json.agent.config.enabled, false);
    assert.equal(config.json.agent.config.provider.apiKeySource.configured, true);
    assert.equal(config.json.agent.config.provider.modelSlug, undefined);
    assert.equal(config.json.agent.config.provider.modelSource.kind, "unconfigured");
    assert.equal(config.json.agent.config.toolAllowlistMode, "all_registered");
    assert.doesNotMatch(config.body, /sk-test-secret-value/);

    const diagnostics = await apiRequest(
      port,
      "GET",
      "/__hub/api/agent/diagnostics",
      undefined,
      tokenHeaders(hub.runtime.token)
    );
    assert.equal(diagnostics.statusCode, 200);
    assert.deepEqual(
      diagnostics.json.agent.diagnostics.map((diagnostic: { code: string }) => diagnostic.code),
      ["AGENT_DISABLED", "AGENT_REMOTE_MODEL_DISABLED", "AGENT_MODEL_MISSING"]
    );

    const updated = await apiRequest(
      port,
      "PUT",
      "/__hub/api/agent/config",
      {
        enabled: true,
        provider: {
          modelSlug: "openrouter/test-model",
          remoteModelEnabled: true,
          apiKeyEnvVar: "RELAYBASE_TEST_OPENROUTER_KEY_MISSING"
        },
        execution: {
          segmentMaxTurns: 10,
          totalMaxTurns: 40,
          inactivityTimeoutMs: 180000,
          hardRunTimeoutMs: 1200000,
          maxOutputTokens: 8192,
          reasoningEffort: "high",
          noProgressRepeatLimit: 4
        },
        allowBrowserOpen: false,
        allowCopyRoute: false
      },
      tokenHeaders(hub.runtime.token)
    );
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json.agent.config.enabled, true);
    assert.equal(updated.json.agent.config.provider.modelSlug, "openrouter/test-model");
    assert.equal(updated.json.agent.config.provider.modelSource.kind, "persisted_config");
    assert.equal(updated.json.agent.config.provider.apiKeySource.configured, false);
    assert.deepEqual(updated.json.agent.config.execution, {
      segmentMaxTurns: 10,
      totalMaxTurns: 40,
      inactivityTimeoutMs: 180000,
      hardRunTimeoutMs: 1200000,
      maxOutputTokens: 8192,
      reasoningEffort: "high",
      noProgressRepeatLimit: 4
    });

    const revisionConflict = await apiRequest(
      port,
      "PUT",
      "/__hub/api/agent/config",
      {
        expectedRevisionId: config.json.agent.config.revision.id,
        update: { enabled: false }
      },
      tokenHeaders(hub.runtime.token)
    );
    assert.equal(revisionConflict.statusCode, 409);
    assert.equal(revisionConflict.json.code, "AGENT_CONFIG_REVISION_CONFLICT");
    const afterConflict = await apiRequest(
      port,
      "GET",
      "/__hub/api/agent/config",
      undefined,
      tokenHeaders(hub.runtime.token)
    );
    assert.equal(afterConflict.json.agent.config.enabled, true);
    assert.equal(afterConflict.json.agent.config.revision.id, updated.json.agent.config.revision.id);

    const invalidExecution = await apiRequest(
      port,
      "PUT",
      "/__hub/api/agent/config",
      { execution: { segmentMaxTurns: 20, totalMaxTurns: 10 } },
      tokenHeaders(hub.runtime.token)
    );
    assert.equal(invalidExecution.statusCode, 400);
    assert.equal(invalidExecution.json.code, "AGENT_EXECUTION_POLICY_INVALID");

    const rawKey = await apiRequest(
      port,
      "PUT",
      "/__hub/api/agent/config",
      { provider: { apiKey: "sk-should-not-be-accepted" } },
      tokenHeaders(hub.runtime.token)
    );
    assert.equal(rawKey.statusCode, 400);
    assert.equal(rawKey.json.code, "AGENT_RAW_API_KEY_NOT_ALLOWED");
    assert.doesNotMatch(rawKey.body, /sk-should-not-be-accepted/);

    const providerConnect = await apiRequest(
      port,
      "POST",
      "/__hub/api/agent/provider/openrouter/connect",
      { openBrowser: false },
      tokenHeaders(hub.runtime.token)
    );
    assert.equal(providerConnect.statusCode, 202);
    assert.equal(providerConnect.json.agent.provider.attempt.status, "waiting_for_browser");
    assert.match(providerConnect.headers["cache-control"] ?? "", /no-store/);
    assert.doesNotMatch(providerConnect.body, /sk-test-secret-value/);

    const providerStatus = await apiRequest(
      port,
      "GET",
      `/__hub/api/agent/provider/openrouter/status?attemptId=${providerConnect.json.agent.provider.attempt.attemptId}`,
      undefined,
      tokenHeaders(hub.runtime.token)
    );
    assert.equal(providerStatus.statusCode, 200);
    assert.equal(providerStatus.json.agent.provider.attempt.status, "waiting_for_browser");
    assert.doesNotMatch(providerStatus.body, /sk-test-secret-value/);

    const verificationOff = await apiRequest(
      port,
      "PUT",
      "/__hub/api/agent/provider/openrouter/security-mode",
      { mode: "off" },
      tokenHeaders(hub.runtime.token)
    );
    assert.equal(verificationOff.statusCode, 200);
    assert.equal(verificationOff.json.agent.provider.selectedMode, "off");
    assert.equal(verificationOff.json.agent.provider.highSecurityMode, "unavailable");

    const verificationRequired = await apiRequest(
      port,
      "PUT",
      "/__hub/api/agent/provider/openrouter/security-mode",
      { mode: "required" },
      tokenHeaders(hub.runtime.token)
    );
    assert.equal(verificationRequired.statusCode, 409);
    assert.equal(verificationRequired.json.code, "AGENT_WINDOWS_VERIFICATION_UNAVAILABLE");

    const unconfirmedDisconnect = await apiRequest(
      port,
      "POST",
      "/__hub/api/agent/provider/openrouter/disconnect",
      {},
      tokenHeaders(hub.runtime.token)
    );
    assert.equal(unconfirmedDisconnect.statusCode, 400);
    assert.equal(unconfirmedDisconnect.json.code, "AGENT_PROVIDER_CONFIRMATION_REQUIRED");

    const revokePreview = await apiRequest(
      port,
      "POST",
      "/__hub/api/agent/provider/openrouter/revoke/preview",
      {},
      tokenHeaders(hub.runtime.token)
    );
    assert.equal(revokePreview.statusCode, 200);
    assert.equal(revokePreview.json.agent.provider.supported, false);
    assert.equal(revokePreview.json.agent.provider.localCredentialPreserved, true);
  } finally {
    restoreEnvValues(previous);
    await hub.close();
  }
});

test("Agent Gateway daemon config starts ready from explicit env opt-in flags", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-agent-env-config-"));
  const previous = saveEnv([
    "OPENROUTER_API_KEY",
    "RELAYBASE_AGENT_MODEL",
    "RELAYBASE_AGENT_ENABLED",
    "RELAYBASE_AGENT_REMOTE_MODEL_ENABLED"
  ]);
  process.env.OPENROUTER_API_KEY = "sk-or-daemon-env-secret";
  process.env.RELAYBASE_AGENT_MODEL = "google/gemini-3.1-flash-lite";
  process.env.RELAYBASE_AGENT_ENABLED = "1";
  process.env.RELAYBASE_AGENT_REMOTE_MODEL_ENABLED = "1";
  const hub = await createRelaybaseServer({ port: 0, stateDir });

  try {
    await hub.listen();
    const config = await apiRequest(
      hub.address().port,
      "GET",
      "/__hub/api/agent/config",
      undefined,
      tokenHeaders(hub.runtime.token)
    );

    assert.equal(config.statusCode, 200);
    assert.equal(config.json.agent.config.enabled, true);
    assert.equal(config.json.agent.config.provider.remoteModelEnabled, true);
    assert.equal(config.json.agent.config.provider.modelSlug, "google/gemini-3.1-flash-lite");
    assert.equal(config.json.agent.config.provider.modelSource.kind, "shell_environment");
    assert.equal(config.json.agent.config.provider.apiKeySource.configured, true);
    assert.doesNotMatch(config.body, /sk-or-daemon-env-secret/);

    const diagnostics = await apiRequest(
      hub.address().port,
      "GET",
      "/__hub/api/agent/diagnostics",
      undefined,
      tokenHeaders(hub.runtime.token)
    );
    assert.deepEqual(
      diagnostics.json.agent.diagnostics.map((diagnostic: { code: string }) => diagnostic.code),
      ["AGENT_RUNTIME_READY", "AGENT_DAEMON_READY"]
    );
    assert.match(diagnostics.body, /enabled and configured for model requests/);
  } finally {
    await hub.close();
    restoreEnvValues(previous);
  }
});

test("Agent Gateway reports env-file model provenance and reloadable drift without exposing values", async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-agent-env-source-"));
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-agent-env-source-state-"));
  const envPath = path.join(project, ".env");
  await fs.writeFile(
    envPath,
    "RELAYBASE_AGENT_MODEL=openrouter/source-model\nRELAYBASE_AGENT_ENABLED=1\nRELAYBASE_AGENT_REMOTE_MODEL_ENABLED=1\n",
    "utf8"
  );
  const previous = saveEnv(AGENT_ENV_NAMES);
  const loadedEnv: NodeJS.ProcessEnv = { OPENROUTER_API_KEY: "sk-or-source-secret" };
  const loaded = loadRelaybaseEnvFile({ cwd: project, env: loadedEnv });
  Object.assign(process.env, loadedEnv);
  const hub = await createRelaybaseServer({
    port: 0,
    stateDir,
    agentEnvironment: {
      modelSource: relaybaseModelSource(loaded, loadedEnv),
      envFilePath: loaded.path,
      envFileFingerprint: loaded.fingerprint,
      envFileAppliedKeys: loaded.appliedKeys,
      envFileSkippedKeys: loaded.skippedKeys,
      envFileSourceKind: loaded.sourceKind
    }
  });
  try {
    await hub.listen();
    const initial = await apiRequest(
      hub.address().port,
      "GET",
      "/__hub/api/agent/config",
      undefined,
      tokenHeaders(hub.runtime.token)
    );
    assert.equal(initial.json.agent.config.provider.modelSlug, "openrouter/source-model");
    assert.deepEqual(initial.json.agent.config.provider.modelSource, { kind: "cwd_env_file", label: ".env" });
    assert.equal(initial.json.agent.config.provider.restartRequired, false);
    assert.doesNotMatch(initial.body, /sk-or-source-secret/);

    await fs.appendFile(envPath, "OPENROUTER_TITLE=Changed\n", "utf8");
    const drifted = await apiRequest(
      hub.address().port,
      "GET",
      "/__hub/api/agent/config",
      undefined,
      tokenHeaders(hub.runtime.token)
    );
    assert.equal(drifted.json.agent.config.provider.modelSlug, "openrouter/source-model");
    assert.equal(drifted.json.agent.config.provider.restartRequired, false);
    assert.equal(drifted.json.agent.config.source.health, "changed");
  } finally {
    await hub.close();
    restoreEnvValues(previous);
  }
});

test("Agent Gateway migrates historical defaults to all-registered while preserving custom subsets", async () => {
  const newTools = new Set([
    "get_current_context",
    "get_agent_capabilities",
    "explain_app_problem",
    "get_operation_status",
    "list_operations",
    "discover_project_roots"
  ]);
  const legacyDefaults = relaybaseAgentToolNames().filter((name) => !newTools.has(name));
  const legacyState = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-agent-legacy-tools-"));
  await fs.mkdir(path.join(legacyState, "agent"), { recursive: true });
  await fs.writeFile(
    path.join(legacyState, "agent", "config.json"),
    JSON.stringify({ schemaVersion: 1, toolAllowlist: legacyDefaults }),
    "utf8"
  );
  const legacyHub = await createRelaybaseServer({ port: 0, stateDir: legacyState });
  try {
    assert.equal(legacyHub.runtime.agentGateway.getConfig().toolAllowlistMode, "all_registered");
    assert.deepEqual(legacyHub.runtime.agentGateway.getConfig().toolAllowlist, relaybaseAgentToolNames());
  } finally {
    await legacyHub.close();
  }

  const customState = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-agent-custom-tools-"));
  await fs.mkdir(path.join(customState, "agent"), { recursive: true });
  await fs.writeFile(
    path.join(customState, "agent", "config.json"),
    JSON.stringify({ schemaVersion: 1, toolAllowlist: ["list_apps", "tail_logs"] }),
    "utf8"
  );
  const customHub = await createRelaybaseServer({ port: 0, stateDir: customState });
  try {
    assert.equal(customHub.runtime.agentGateway.getConfig().toolAllowlistMode, "explicit_allowlist");
    assert.deepEqual(customHub.runtime.agentGateway.getConfig().toolAllowlist, ["list_apps", "tail_logs"]);
  } finally {
    await customHub.close();
  }
});

test("Agent Gateway persists non-secret config across restart while explicit env remains authoritative", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-agent-persisted-config-"));
  const previous = saveEnv(AGENT_ENV_NAMES);
  for (const name of AGENT_ENV_NAMES) {
    delete process.env[name];
  }

  let hub = await createRelaybaseServer({ port: 0, stateDir });
  try {
    await hub.listen();
    const updated = await apiRequest(
      hub.address().port,
      "PUT",
      "/__hub/api/agent/config",
      {
        enabled: true,
        provider: {
          modelSlug: "openai/gpt-5.6-luna",
          remoteModelEnabled: true,
          apiKeyEnvVar: "RELAYBASE_PERSISTED_TEST_KEY"
        },
        approvalPolicy: "read_only_only",
        budgets: { sessionLimitUsd: 0.25 }
      },
      tokenHeaders(hub.runtime.token)
    );
    assert.equal(updated.json.agent.config.enabled, true);
    await hub.close();

    hub = await createRelaybaseServer({ port: 0, stateDir });
    await hub.listen();
    const persisted = await apiRequest(
      hub.address().port,
      "GET",
      "/__hub/api/agent/config",
      undefined,
      tokenHeaders(hub.runtime.token)
    );
    assert.equal(persisted.json.agent.config.enabled, true);
    assert.equal(persisted.json.agent.config.provider.modelSlug, "openai/gpt-5.6-luna");
    assert.equal(persisted.json.agent.config.provider.remoteModelEnabled, true);
    assert.equal(persisted.json.agent.config.provider.apiKeySource.envVar, "RELAYBASE_PERSISTED_TEST_KEY");
    assert.equal(persisted.json.agent.config.provider.apiKeySource.configured, false);
    assert.equal(persisted.json.agent.config.approvalPolicy, "read_only_only");
    assert.equal(persisted.json.agent.config.budgets.sessionLimitUsd, 0.25);

    const persistedDocument = JSON.parse(await fs.readFile(path.join(stateDir, "agent", "config.json"), "utf8")) as {
      provider?: Record<string, unknown>;
    };
    assert.equal(persistedDocument.provider?.apiKey, undefined);
    assert.equal(persistedDocument.provider?.configured, undefined);
    await hub.close();

    process.env.RELAYBASE_AGENT_ENABLED = "0";
    hub = await createRelaybaseServer({ port: 0, stateDir });
    await hub.listen();
    const envOverridden = await apiRequest(
      hub.address().port,
      "GET",
      "/__hub/api/agent/config",
      undefined,
      tokenHeaders(hub.runtime.token)
    );
    assert.equal(envOverridden.json.agent.config.enabled, false);
  } finally {
    await hub.close().catch(() => undefined);
    restoreEnvValues(previous);
  }
});

test("Agent Gateway creates, lists, and reads sessions with TUI context", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-agent-session-"));
  const hub = await createRelaybaseServer({ port: 0, stateDir });

  try {
    await hub.listen();
    const context: Partial<TuiAgentContext> = {
      selectedPaneId: "notes:notes-web:frontend:frontend",
      selectedAppId: "notes-web",
      selectedGroupId: "notes",
      selectedComponentRole: "frontend",
      currentRoute: "http://notes-web.localhost:7777",
      currentPage: 1,
      currentCwd: "C:\\Users\\wamin\\Desktop\\development\\expiremental\\ratemygithub",
      setupWizardState: "no_apps",
      currentSetupPlanId: "managed-web",
      terminalCapabilities: {
        clipboard: "unknown",
        browserOpen: "unavailable",
        colorDepth: "truecolor"
      }
    };
    const created = await apiRequest(
      hub.address().port,
      "POST",
      "/__hub/api/agent/sessions",
      { title: "TUI session", context },
      tokenHeaders(hub.runtime.token)
    );
    assert.equal(created.statusCode, 201);
    assert.equal(created.json.agent.session.context.currentCwd, context.currentCwd);
    assert.equal(created.json.agent.session.context.selectedPaneId, context.selectedPaneId);
    assert.equal(created.json.agent.session.context.daemonHasZeroApps, true);

    const sessionId = created.json.agent.session.id;
    const listed = await apiRequest(
      hub.address().port,
      "GET",
      "/__hub/api/agent/sessions",
      undefined,
      tokenHeaders(hub.runtime.token)
    );
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json.agent.sessions.length, 1);

    const read = await apiRequest(
      hub.address().port,
      "GET",
      `/__hub/api/agent/sessions/${sessionId}`,
      undefined,
      tokenHeaders(hub.runtime.token)
    );
    assert.equal(read.statusCode, 200);
    assert.equal(read.json.agent.session.id, sessionId);
  } finally {
    await hub.close();
  }
});

test("OA-THREADS-002 Agent Gateway exposes active thread, patch, context preview, replay, and markdown export", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-agent-thread-api-"));
  const hub = await createRelaybaseServer({ port: 0, stateDir });

  try {
    await hub.listen();
    const port = hub.address().port;
    const first = await apiRequest(
      port,
      "POST",
      "/__hub/api/agent/sessions",
      { title: "First" },
      tokenHeaders(hub.runtime.token)
    );
    const second = await apiRequest(
      port,
      "POST",
      "/__hub/api/agent/sessions",
      { title: "Second", context: { currentCwd: process.cwd() } },
      tokenHeaders(hub.runtime.token)
    );
    const firstId = first.json.agent.session.id;
    const secondId = second.json.agent.session.id;

    const active = await apiRequest(
      port,
      "GET",
      "/__hub/api/agent/sessions/active",
      undefined,
      tokenHeaders(hub.runtime.token)
    );
    assert.equal(active.json.agent.session.id, secondId);

    const patched = await apiRequest(
      port,
      "PATCH",
      `/__hub/api/agent/sessions/${secondId}`,
      { title: "Renamed thread", privacy: { mode: "redacted_detail", advancedRedactedDetailEnabled: true } },
      tokenHeaders(hub.runtime.token)
    );
    assert.equal(patched.statusCode, 200);
    assert.equal(patched.json.agent.session.title, "Renamed thread");
    assert.equal(patched.json.agent.session.privacy.mode, "redacted_detail");

    await apiRequest(
      port,
      "POST",
      `/__hub/api/agent/sessions/${firstId}/activate`,
      {},
      tokenHeaders(hub.runtime.token)
    );
    const activated = await apiRequest(
      port,
      "GET",
      "/__hub/api/agent/sessions/active",
      undefined,
      tokenHeaders(hub.runtime.token)
    );
    assert.equal(activated.json.agent.session.id, firstId);

    await apiRequest(
      port,
      "POST",
      `/__hub/api/agent/sessions/${firstId}/messages`,
      { content: "what is broken?" },
      tokenHeaders(hub.runtime.token)
    );
    const preview = await apiRequest(
      port,
      "GET",
      `/__hub/api/agent/sessions/${firstId}/context-preview`,
      undefined,
      tokenHeaders(hub.runtime.token)
    );
    assert.equal(preview.statusCode, 200);
    assert.equal(preview.json.agent.contextPreview.recallPolicy.scope, "active_thread_only");
    assert.equal(preview.json.agent.contextPreview.summary.messageCount, 1);

    const replay = await readFirstSseChunk(
      port,
      `/__hub/api/agent/sessions/${firstId}/events?afterSequence=1`,
      tokenHeaders(hub.runtime.token)
    );
    assert.match(replay, /afterSequence/);
    assert.doesNotMatch(replay, /"sequence":1/);

    const exported = await apiRequest(
      port,
      "GET",
      `/__hub/api/agent/sessions/${firstId}/export?format=markdown`,
      undefined,
      tokenHeaders(hub.runtime.token)
    );
    assert.equal(exported.statusCode, 200);
    assert.equal(exported.json.agent.export.format, "markdown");
    const artifact = await fs.readFile(exported.json.agent.export.outputPath, "utf8");
    assert.match(artifact, /Relaybase Operator Agent Thread/);
  } finally {
    await hub.close();
  }
});

test("Agent Gateway message returns diagnostics for disabled and missing-config agent without fake output", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-agent-message-"));
  const previous = saveEnv(AGENT_ENV_NAMES);
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.RELAYBASE_AGENT_MODEL;
  delete process.env.RELAYBASE_AGENT_ENABLED;
  delete process.env.RELAYBASE_AGENT_REMOTE_MODEL_ENABLED;
  const hub = await createRelaybaseServer({ port: 0, stateDir });

  try {
    await hub.listen();
    const session = await apiRequest(
      hub.address().port,
      "POST",
      "/__hub/api/agent/sessions",
      { context: { currentCwd: process.cwd() } },
      tokenHeaders(hub.runtime.token)
    );
    const sessionId = session.json.agent.session.id;

    const idempotentHeaders = {
      ...tokenHeaders(hub.runtime.token),
      "Idempotency-Key": "disabled-message-1"
    };
    const disabled = await apiRequest(
      hub.address().port,
      "POST",
      `/__hub/api/agent/sessions/${sessionId}/messages`,
      { content: "start notes", context: { selectedAppId: "notes" } },
      idempotentHeaders
    );
    assert.equal(disabled.statusCode, 202);
    assert.equal(disabled.json.agent.run.status, "failed");
    assert.equal(disabled.json.agent.diagnostics[0].code, "AGENT_DISABLED");
    assert.doesNotMatch(disabled.body, /model\.delta/);

    const duplicate = await apiRequest(
      hub.address().port,
      "POST",
      `/__hub/api/agent/sessions/${sessionId}/messages`,
      { content: "start notes", context: { selectedAppId: "notes" } },
      idempotentHeaders
    );
    assert.equal(duplicate.statusCode, 202);
    assert.equal(duplicate.json.agent.run.id, disabled.json.agent.run.id);
    assert.equal(duplicate.json.agent.reused, true);

    const runs = await apiRequest(
      hub.address().port,
      "GET",
      `/__hub/api/agent/sessions/${sessionId}/runs`,
      undefined,
      tokenHeaders(hub.runtime.token)
    );
    assert.equal(runs.statusCode, 200);
    assert.deepEqual(
      runs.json.agent.runs.map((run: { id: string }) => run.id),
      [disabled.json.agent.run.id]
    );
    const run = await apiRequest(
      hub.address().port,
      "GET",
      `/__hub/api/agent/sessions/${sessionId}/runs/${disabled.json.agent.run.id}`,
      undefined,
      tokenHeaders(hub.runtime.token)
    );
    assert.equal(run.statusCode, 200);
    assert.equal(run.json.agent.run.status, "failed");
    const active = await apiRequest(
      hub.address().port,
      "GET",
      `/__hub/api/agent/sessions/${sessionId}/runs/active`,
      undefined,
      tokenHeaders(hub.runtime.token)
    );
    assert.equal(active.statusCode, 200);
    assert.equal(active.json.agent.run, null);

    const retryHeaders = {
      ...tokenHeaders(hub.runtime.token),
      "Idempotency-Key": "disabled-message-retry-1"
    };
    const retried = await apiRequest(
      hub.address().port,
      "POST",
      `/__hub/api/agent/sessions/${sessionId}/runs/${disabled.json.agent.run.id}/retry`,
      {},
      retryHeaders
    );
    assert.equal(retried.statusCode, 202);
    assert.notEqual(retried.json.agent.run.id, disabled.json.agent.run.id);
    assert.equal(retried.json.agent.run.status, "failed");
    const duplicateRetry = await apiRequest(
      hub.address().port,
      "POST",
      `/__hub/api/agent/sessions/${sessionId}/runs/${disabled.json.agent.run.id}/retry`,
      {},
      retryHeaders
    );
    assert.equal(duplicateRetry.json.agent.run.id, retried.json.agent.run.id);
    assert.equal(duplicateRetry.json.agent.reused, true);

    await apiRequest(
      hub.address().port,
      "PUT",
      "/__hub/api/agent/config",
      {
        enabled: true,
        provider: {
          modelSlug: "openrouter/test-model",
          remoteModelEnabled: true,
          apiKeyEnvVar: "RELAYBASE_TEST_OPENROUTER_KEY_MISSING"
        }
      },
      tokenHeaders(hub.runtime.token)
    );
    const missingKey = await apiRequest(
      hub.address().port,
      "POST",
      `/__hub/api/agent/sessions/${sessionId}/messages`,
      { content: "configure current folder", context: { currentCwd: process.cwd() } },
      tokenHeaders(hub.runtime.token)
    );
    assert.equal(missingKey.statusCode, 202);
    assert.equal(missingKey.json.agent.diagnostics[0].code, "AGENT_CREDENTIAL_MISSING");
    assert.doesNotMatch(missingKey.body, /fake|pretend/i);
  } finally {
    restoreEnvValues(previous);
    await hub.close();
  }
});

test("Agent Gateway session event stream connects and replays run events", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-agent-events-"));
  const hub = await createRelaybaseServer({ port: 0, stateDir });

  try {
    await hub.listen();
    const session = await apiRequest(
      hub.address().port,
      "POST",
      "/__hub/api/agent/sessions",
      {},
      tokenHeaders(hub.runtime.token)
    );
    const sessionId = session.json.agent.session.id;
    await apiRequest(
      hub.address().port,
      "POST",
      `/__hub/api/agent/sessions/${sessionId}/messages`,
      { content: "what is broken?" },
      tokenHeaders(hub.runtime.token)
    );

    const stream = await readFirstSseChunk(
      hub.address().port,
      `/__hub/api/agent/sessions/${sessionId}/events`,
      tokenHeaders(hub.runtime.token)
    );
    assert.match(stream, /event: diagnostic/);
    assert.match(stream, /"requiresSessionRefresh":false/);
  } finally {
    await hub.close();
  }
});

test("Relaybase server close releases the Agent SQLite store", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-agent-close-"));
  const hub = await createRelaybaseServer({ port: 0, stateDir });
  await hub.listen();
  await hub.close();
  await fs.rm(stateDir, { recursive: true, force: true });
  await assert.rejects(fs.access(stateDir));
});

test("Agent Gateway approval endpoints validate missing IDs", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-agent-approvals-"));
  const hub = await createRelaybaseServer({ port: 0, stateDir });

  try {
    await hub.listen();
    const approved = await apiRequest(
      hub.address().port,
      "POST",
      "/__hub/api/agent/approvals/missing/approve",
      {},
      tokenHeaders(hub.runtime.token)
    );
    assert.equal(approved.statusCode, 404);
    assert.equal(approved.json.code, "AGENT_APPROVAL_NOT_FOUND");

    const rejected = await apiRequest(
      hub.address().port,
      "POST",
      "/__hub/api/agent/approvals/missing/reject",
      {},
      tokenHeaders(hub.runtime.token)
    );
    assert.equal(rejected.statusCode, 404);
    assert.equal(rejected.json.code, "AGENT_APPROVAL_NOT_FOUND");
  } finally {
    await hub.close();
  }
});

test("Agent setup approval payload shapes serialize without secret values", () => {
  const fileWriteApproval: AgentFileWriteApproval = {
    kind: "file_write",
    setupPlanId: "managed-web",
    risk: "high",
    fileWritePlan: {
      root: "C:\\project",
      writes: [
        {
          path: "relaybase.app.json",
          action: "create",
          reason: "Register app",
          preview: '{"env":{"API_KEY":"[redacted]"}}',
          diff: {
            path: "relaybase.app.json",
            beforeExists: false,
            afterExists: true,
            changed: true,
            hunks: ["+ API_KEY=[redacted]"]
          }
        }
      ],
      approvalRequired: true,
      risks: [
        {
          code: "FILE_WRITE",
          severity: "warning",
          message: "Writes setup manifest",
          requiresApproval: true
        }
      ]
    }
  };
  const manifestPatchApproval: AgentManifestPatchApproval = {
    kind: "manifest_patch",
    risk: "medium",
    manifestPatchPlan: {
      cwd: "C:\\project",
      manifestPath: "relaybase.app.json",
      manifest: {
        id: "notes",
        name: "Notes",
        command: "npm.cmd run dev"
      },
      patchedManifest: {
        id: "notes",
        name: "Notes",
        command: "npm.cmd run dev",
        healthUrl: "/api/health"
      },
      fileWritePlan: fileWriteApproval.fileWritePlan,
      diagnostics: []
    }
  };
  const serialized = JSON.stringify({ fileWriteApproval, manifestPatchApproval });
  assert.match(serialized, /file_write/);
  assert.match(serialized, /manifest_patch/);
  assert.doesNotMatch(serialized, /super-secret|sk-/);
});

function tokenHeaders(token: string): Record<string, string> {
  return { "x-relaybase-token": token };
}

function apiRequest(
  port: number,
  method: string,
  pathName: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<{ statusCode: number; body: string; json: Record<string, any>; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathName,
        method,
        headers: {
          host: "localhost",
          ...(payload
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload).toString() }
            : {}),
          ...headers
        }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on("end", () => {
          const bodyText = Buffer.concat(chunks).toString("utf8");
          resolve({
            statusCode: response.statusCode ?? 0,
            body: bodyText,
            json: bodyText ? JSON.parse(bodyText) : {},
            headers: response.headers
          });
        });
      }
    );
    request.once("error", reject);
    if (payload) {
      request.write(payload);
    }
    request.end();
  });
}

function readFirstSseChunk(port: number, pathName: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathName,
        method: "GET",
        headers: {
          host: "localhost",
          ...headers
        }
      },
      (response) => {
        response.setEncoding("utf8");
        let buffer = "";
        response.on("data", (chunk) => {
          buffer += String(chunk);
          if (buffer.includes("event: diagnostic")) {
            request.destroy();
            resolve(buffer);
          }
        });
      }
    );
    request.once("error", (error) => {
      if (request.destroyed) {
        return;
      }
      reject(error);
    });
    request.end();
  });
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
