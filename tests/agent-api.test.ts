import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentFileWriteApproval, AgentManifestPatchApproval, TuiAgentContext } from "../src/apiTypes.ts";
import { createRelaybaseServer } from "../src/server.ts";

const AGENT_ENV_NAMES = [
  "OPENROUTER_API_KEY",
  "RELAYBASE_AGENT_MODEL",
  "RELAYBASE_AGENT_ENABLED",
  "RELAYBASE_AGENT_REMOTE_MODEL_ENABLED"
];

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
    assert.equal(config.json.agent.config.provider.apiKeySource.configured, false);
    assert.equal(config.json.agent.config.provider.modelSlug, undefined);
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
      ["AGENT_DISABLED"]
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
        allowBrowserOpen: false,
        allowCopyRoute: false
      },
      tokenHeaders(hub.runtime.token)
    );
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json.agent.config.enabled, true);
    assert.equal(updated.json.agent.config.provider.modelSlug, "openrouter/test-model");
    assert.equal(updated.json.agent.config.provider.apiKeySource.configured, false);

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
          modelSlug: "openai/gpt-5.4",
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
    assert.equal(persisted.json.agent.config.provider.modelSlug, "openai/gpt-5.4");
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
    assert.equal(missingKey.json.agent.diagnostics[0].code, "OPENROUTER_API_KEY_MISSING");
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
