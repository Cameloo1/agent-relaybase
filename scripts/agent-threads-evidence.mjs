#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRelaybaseServer } from "../src/server.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generatedAt = new Date().toISOString();
const runId = generatedAt.replace(/[:.]/g, "-");
const artifactRoot = path.join(root, "artifacts", "agent-threads", runId);

const commandLog = [];
const checks = [];

await fs.mkdir(artifactRoot, { recursive: true });

try {
  const main = await runMainThreadSmoke();
  const legacy = await runLegacyImportSmoke();
  const summary = {
    generatedAt,
    status: "passed",
    artifactRoot,
    stateDir: main.stateDir,
    dbPath: path.join(main.stateDir, "agent", "agent.sqlite"),
    legacyStateDir: legacy.stateDir,
    legacyDbPath: path.join(legacy.stateDir, "agent", "agent.sqlite"),
    checks,
    artifacts: main.artifacts,
    legacyArtifacts: legacy.artifacts,
    commandLog
  };

  await writeJson("summary.json", summary);
  console.log(`Operator Agent thread evidence: PASS`);
  console.log(`Artifact root: ${artifactRoot}`);
  console.log(`SQLite DB: ${summary.dbPath}`);
} catch (error) {
  await writeJson("summary.json", {
    generatedAt,
    status: "failed",
    artifactRoot,
    checks,
    commandLog,
    error: error instanceof Error ? error.message : String(error)
  });
  console.error("Operator Agent thread evidence: FAIL");
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
}

async function runMainThreadSmoke() {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-agent-threads-"));
  const hub = await createRelaybaseServer({ port: 0, stateDir });
  const artifacts = {};
  let firstId;
  let secondId;

  try {
    await hub.listen();
    const port = hub.address().port;
    const headers = tokenHeaders(hub.runtime.token);

    const first = await requestJson(
      port,
      "POST",
      "/__hub/api/agent/sessions",
      {
        title: "Evidence thread one",
        context: {
          selectedPaneId: "pane-notes-frontend",
          selectedAppId: "notes-web",
          selectedGroupId: "notes",
          selectedComponentRole: "frontend",
          currentRoute: "http://notes.localhost:7777",
          currentPage: 0,
          currentCwd: root,
          daemonHasZeroApps: true,
          setupWizardState: "no_apps",
          diagnostics: [],
          terminalCapabilities: {
            clipboard: "unavailable",
            browserOpen: "unavailable",
            colorDepth: "truecolor"
          }
        }
      },
      headers
    );
    assertStatus(first, 201, "create first thread");
    firstId = first.json.agent.session.id;
    recordCheck("active thread creation", Boolean(firstId), { firstId });

    const second = await requestJson(
      port,
      "POST",
      "/__hub/api/agent/sessions",
      { title: "Evidence thread two" },
      headers
    );
    assertStatus(second, 201, "create second thread");
    secondId = second.json.agent.session.id;

    const list = await requestJson(port, "GET", "/__hub/api/agent/sessions", undefined, headers);
    assertStatus(list, 200, "list threads");
    recordCheck("thread list includes two sessions", list.json.agent.sessions.length === 2, {
      count: list.json.agent.sessions.length
    });
    artifacts.initialList = await writeJson("initial-list.json", redactForArtifact(list.json));

    const active = await requestJson(port, "GET", "/__hub/api/agent/sessions/active", undefined, headers);
    assertStatus(active, 200, "read active thread");
    recordCheck("newest session is active", active.json.agent.session.id === secondId, {
      activeId: active.json.agent.session.id,
      expected: secondId
    });
    artifacts.activeInitial = await writeJson("active-initial.json", redactForArtifact(active.json));

    const renamed = await requestJson(
      port,
      "PATCH",
      `/__hub/api/agent/sessions/${secondId}`,
      {
        title: "Renamed evidence thread",
        privacy: { mode: "redacted_detail", advancedRedactedDetailEnabled: true }
      },
      headers
    );
    assertStatus(renamed, 200, "rename thread");
    recordCheck("thread rename and privacy patch", renamed.json.agent.session.title === "Renamed evidence thread", {
      title: renamed.json.agent.session.title,
      privacy: renamed.json.agent.session.privacy
    });
    artifacts.renamed = await writeJson("renamed-thread.json", redactForArtifact(renamed.json));

    const activated = await requestJson(port, "POST", `/__hub/api/agent/sessions/${firstId}/activate`, {}, headers);
    assertStatus(activated, 200, "activate first thread");
    recordCheck("activate/switch thread", activated.json.agent.session.id === firstId, {
      activeId: activated.json.agent.session.id
    });

    const message = await requestJson(
      port,
      "POST",
      `/__hub/api/agent/sessions/${firstId}/messages`,
      {
        content: "What is broken? password=evidence-thread-secret OPENROUTER_API_KEY=fake-evidence-secret",
        context: { selectedAppId: "notes-web", currentCwd: root }
      },
      headers
    );
    assertStatus(message, 202, "append message");
    const messageText = JSON.stringify(message.json);
    recordCheck(
      "message append redacts secret-like content",
      !/evidence-thread-secret|sk-or-evidence/.test(messageText),
      {
        diagnostics: message.json.agent.diagnostics?.map((diagnostic) => diagnostic.code) ?? []
      }
    );
    artifacts.messageAppend = await writeJson("message-append.json", redactForArtifact(message.json));

    const preview = await requestJson(
      port,
      "GET",
      `/__hub/api/agent/sessions/${firstId}/context-preview`,
      undefined,
      headers
    );
    assertStatus(preview, 200, "context preview");
    recordCheck(
      "context preview is active-thread-only",
      preview.json.agent.contextPreview.recallPolicy.scope === "active_thread_only",
      {
        messageCount: preview.json.agent.contextPreview.summary.messageCount,
        recoveredApprovals: preview.json.agent.contextPreview.summary.recoveredApprovalCount
      }
    );
    artifacts.contextPreview = await writeJson("context-preview.json", redactForArtifact(preview.json));

    const replay = await readSseWindow(port, `/__hub/api/agent/sessions/${firstId}/events?afterSequence=1`, headers);
    recordCheck("session event stream exposes snapshot-only replay metadata", /snapshot_only/.test(replay), {
      bytes: replay.length
    });
    artifacts.sseReplay = await writeText("sse-replay.txt", redactText(replay));

    const jsonExport = await requestJson(
      port,
      "GET",
      `/__hub/api/agent/sessions/${firstId}/export?format=json`,
      undefined,
      headers
    );
    assertStatus(jsonExport, 200, "export json");
    recordCheck("JSON thread export succeeded", jsonExport.json.agent.export.format === "json", {
      outputPath: jsonExport.json.agent.export.outputPath,
      redactions: jsonExport.json.agent.export.redactionReport?.replacements ?? 0
    });
    artifacts.jsonExportResult = await writeJson("json-export-result.json", redactForArtifact(jsonExport.json));
    artifacts.jsonExport = await copyArtifact(jsonExport.json.agent.export.outputPath, "thread-export.json");

    const markdownExport = await requestJson(
      port,
      "GET",
      `/__hub/api/agent/sessions/${firstId}/export?format=markdown`,
      undefined,
      headers
    );
    assertStatus(markdownExport, 200, "export markdown");
    const markdownText = await fs.readFile(markdownExport.json.agent.export.outputPath, "utf8");
    recordCheck("Markdown thread export succeeded", /Relaybase Operator Agent Thread/.test(markdownText), {
      outputPath: markdownExport.json.agent.export.outputPath
    });
    artifacts.markdownExportResult = await writeJson(
      "markdown-export-result.json",
      redactForArtifact(markdownExport.json)
    );
    artifacts.markdownExport = await copyArtifact(markdownExport.json.agent.export.outputPath, "thread-export.md");

    const beforeRestart = await requestJson(port, "GET", `/__hub/api/agent/sessions/${firstId}`, undefined, headers);
    artifacts.sessionBeforeRestart = await writeJson(
      "session-before-restart.json",
      redactForArtifact(beforeRestart.json)
    );
  } finally {
    await hub.close();
  }

  const restarted = await createRelaybaseServer({ port: 0, stateDir });
  try {
    await restarted.listen();
    const port = restarted.address().port;
    const headers = tokenHeaders(restarted.runtime.token);

    const activeAfterRestart = await requestJson(port, "GET", "/__hub/api/agent/sessions/active", undefined, headers);
    assertStatus(activeAfterRestart, 200, "read active after restart");
    recordCheck("active thread persisted across daemon restart", activeAfterRestart.json.agent.session.id === firstId, {
      activeId: activeAfterRestart.json.agent.session.id,
      expected: firstId
    });
    artifacts.activeAfterRestart = await writeJson(
      "active-after-restart.json",
      redactForArtifact(activeAfterRestart.json)
    );

    const sessionAfterRestart = await requestJson(
      port,
      "GET",
      `/__hub/api/agent/sessions/${firstId}`,
      undefined,
      headers
    );
    assertStatus(sessionAfterRestart, 200, "read session after restart");
    recordCheck(
      "message persisted across daemon restart",
      sessionAfterRestart.json.agent.session.summary.messageCount >= 1,
      {
        messageCount: sessionAfterRestart.json.agent.session.summary.messageCount
      }
    );
    artifacts.sessionAfterRestart = await writeJson(
      "session-after-restart.json",
      redactForArtifact(sessionAfterRestart.json)
    );

    const clear = await requestJson(port, "POST", `/__hub/api/agent/sessions/${secondId}/clear`, {}, headers);
    assertStatus(clear, 200, "soft clear thread");
    recordCheck("soft clear returned cleared marker", clear.json.agent.session.cleared === true, {
      sessionId: clear.json.agent.session.sessionId
    });
    artifacts.clearResult = await writeJson("clear-result.json", redactForArtifact(clear.json));

    const finalList = await requestJson(port, "GET", "/__hub/api/agent/sessions", undefined, headers);
    assertStatus(finalList, 200, "final list");
    recordCheck(
      "cleared thread is omitted from session list",
      !finalList.json.agent.sessions.some((session) => session.id === secondId),
      {
        remaining: finalList.json.agent.sessions.map((session) => session.id)
      }
    );
    artifacts.finalList = await writeJson("final-list.json", redactForArtifact(finalList.json));
  } finally {
    await restarted.close();
  }

  return { stateDir, artifacts };
}

async function runLegacyImportSmoke() {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-agent-legacy-"));
  const agentDir = path.join(stateDir, "agent");
  await fs.mkdir(agentDir, { recursive: true });
  const now = new Date().toISOString();
  await fs.writeFile(
    path.join(agentDir, "sessions.json"),
    JSON.stringify({
      version: 1,
      sessions: [
        {
          id: "legacy-evidence-session",
          title: "Legacy evidence",
          createdAt: now,
          updatedAt: now,
          messages: [
            {
              id: "legacy-evidence-message",
              sessionId: "legacy-evidence-session",
              role: "user",
              content: "token=legacy-evidence-secret",
              createdAt: now
            }
          ],
          runs: []
        }
      ]
    }),
    "utf8"
  );
  await fs.writeFile(
    path.join(agentDir, "audit.jsonl"),
    `${JSON.stringify({
      id: "legacy-evidence-audit",
      at: now,
      sessionId: "legacy-evidence-session",
      type: "agent.legacy_evidence",
      provider: "openrouter",
      data: { bearer: "Bearer fake" }
    })}\n`,
    "utf8"
  );

  const hub = await createRelaybaseServer({ port: 0, stateDir });
  const artifacts = {};
  try {
    await hub.listen();
    const port = hub.address().port;
    const headers = tokenHeaders(hub.runtime.token);
    const list = await requestJson(port, "GET", "/__hub/api/agent/sessions", undefined, headers);
    assertStatus(list, 200, "legacy list");
    const imported = list.json.agent.sessions.find((session) => session.id === "legacy-evidence-session");
    recordCheck("legacy sessions imported once into SQLite", Boolean(imported), {
      imported: Boolean(imported)
    });
    const sessionText = JSON.stringify(imported ?? {});
    recordCheck("legacy import redacts secret-like values", !/legacy-evidence-secret/.test(sessionText), {});
    const sessionsBackup = await exists(path.join(agentDir, "sessions.json"));
    const auditBackup = await exists(path.join(agentDir, "audit.jsonl"));
    recordCheck("legacy JSON/JSONL backups remain in place", sessionsBackup && auditBackup, {
      sessionsBackup,
      auditBackup
    });
    artifacts.legacyMigration = await writeJson("legacy-migration.json", {
      imported: Boolean(imported),
      sessionsBackup,
      auditBackup,
      dbPath: path.join(stateDir, "agent", "agent.sqlite")
    });
  } finally {
    await hub.close();
  }
  return { stateDir, artifacts };
}

function tokenHeaders(token) {
  return { "x-relaybase-token": token };
}

function assertStatus(response, statusCode, label) {
  commandLog.push({ label, method: response.method, path: response.path, statusCode: response.statusCode });
  assert.equal(response.statusCode, statusCode, `${label} returned ${response.statusCode}: ${response.body}`);
}

function requestJson(port, method, pathName, body, headers = {}) {
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
            ? {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(payload).toString()
              }
            : {}),
          ...headers
        }
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on("end", () => {
          const bodyText = Buffer.concat(chunks).toString("utf8");
          resolve({
            method,
            path: pathName,
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

function readSseWindow(port, pathName, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathName,
        method: "GET",
        headers: { host: "localhost", ...headers }
      },
      (response) => {
        response.setEncoding("utf8");
        let buffer = "";
        const timer = setTimeout(() => {
          request.destroy();
          resolve(buffer);
        }, 600);
        response.on("data", (chunk) => {
          buffer += String(chunk);
          if (buffer.length > 4096) {
            clearTimeout(timer);
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

function recordCheck(id, passed, detail) {
  checks.push({ id, status: passed ? "passed" : "failed", detail: redactForArtifact(detail) });
  assert.equal(passed, true, `${id} failed: ${JSON.stringify(detail)}`);
}

async function writeJson(name, value) {
  const outputPath = path.join(artifactRoot, name);
  await fs.writeFile(outputPath, `${JSON.stringify(redactForArtifact(value), null, 2)}\n`, "utf8");
  return outputPath;
}

async function writeText(name, value) {
  const outputPath = path.join(artifactRoot, name);
  await fs.writeFile(outputPath, redactText(value), "utf8");
  return outputPath;
}

async function copyArtifact(sourcePath, name) {
  const outputPath = path.join(artifactRoot, name);
  const content = await fs.readFile(sourcePath, "utf8");
  await fs.writeFile(outputPath, redactText(content), "utf8");
  return outputPath;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function redactForArtifact(value) {
  return JSON.parse(redactText(JSON.stringify(value)));
}

function redactText(value) {
  return String(value)
    .replace(/OPENROUTER_API_KEY\s*=\s*[^\s"']+/gi, "OPENROUTER_API_KEY=[redacted]")
    .replace(/RELAYBASE_TOKEN\s*=\s*[^\s"']+/gi, "RELAYBASE_TOKEN=[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/g, "Bearer [redacted]")
    .replace(/\b(password|secret|token|api[_-]?key)\s*=\s*[^,\s"']+/gi, "$1=[redacted]")
    .replace(/sk-or-[A-Za-z0-9._-]+/g, "sk-or-[redacted]");
}
