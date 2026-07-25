import { createHash } from "node:crypto";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRelaybaseServer, type RelaybaseServer } from "../server.ts";
import { sanitizeAgentPayload, sanitizeAgentPayloadWithReport } from "./errors.ts";
import {
  formatOpenRouterProviderError,
  OpenRouterProviderError,
  resolveOpenRouterProviderOptions
} from "./openrouterProvider.ts";
import type { AgentRunEvent, AgentSession } from "./types.ts";
import { waitForAgentRunTerminal } from "./liveRunPolling.ts";

const ARTIFACT_DIR = path.join(process.cwd(), "artifacts", "agent-live-smoke");
const REPORT_PATH = path.join(process.cwd(), "reports", "agent", "RA012D-openrouter-live-smoke.md");
const REASONING_EFFORT = "medium";

export interface OpenRouterLiveSmokeResult {
  ok: true;
  provider: "openrouter";
  modelSlug: string;
  reasoning: {
    enabled: true;
    effort: typeof REASONING_EFFORT;
  };
  daemon: {
    baseUrl: string;
    stateDir: string;
  };
  sampleProject: string;
  artifacts: Record<string, string>;
  checks: Record<string, OpenRouterLiveSmokeCheck>;
  forkRequired: false;
}

export interface OpenRouterLiveSmokeCheck {
  status: "passed";
  evidence: string;
}

interface CapturedSseEvent {
  id?: string;
  event?: string;
  data?: unknown;
}

interface SmokePromptResult {
  label: string;
  runId?: string;
  events: AgentRunEvent[];
  session: AgentSession;
}

export async function runOpenRouterLiveSmoke(): Promise<OpenRouterLiveSmokeResult> {
  process.env.OPENAI_AGENTS_DISABLE_TRACING ??= "1";
  process.env.OPENAI_AGENTS_DONT_LOG_MODEL_DATA ??= "1";
  process.env.OPENAI_AGENTS_DONT_LOG_TOOL_DATA ??= "1";

  const provider = resolveOpenRouterProviderOptions();
  const knownSecrets = [provider.apiKey].filter(Boolean);
  const artifacts = artifactPaths();
  const daemonLog: string[] = [];
  const capturedEvents: CapturedSseEvent[] = [];
  let server: RelaybaseServer | undefined;
  let stateDir: string | undefined;
  let finalResult: OpenRouterLiveSmokeResult | undefined;
  let failure: unknown;

  await resetArtifactDir(ARTIFACT_DIR);

  try {
    const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "relaybase-agent-live-smoke-"));
    stateDir = path.join(workspace, "state");
    const sampleProject = path.join(workspace, "sample-app");
    await createSampleProject(sampleProject);
    const beforeFiles = await snapshotFiles(sampleProject);
    const outboundPreview = outboundContextPreview(workspace, [sampleProject]);

    server = await createRelaybaseServer({ host: "127.0.0.1", port: 0, stateDir });
    await server.listen();
    const address = server.address();
    const baseUrl = `http://${address.host}:${address.port}`;
    daemonLog.push(`started daemon ${baseUrl}`);
    daemonLog.push(`stateDir ${stateDir}`);
    daemonLog.push(`sampleProject ${sampleProject}`);

    const manifestPath = path.join(sampleProject, "relaybase.app.json");
    await server.runtime.registry.upsertManifest(
      {
        id: "agent-smoke-sample",
        name: "Agent Smoke Sample",
        command: "node server.js",
        cwd: sampleProject,
        protocol: "http",
        healthUrl: "/",
        relaybase: {
          groupId: "agent-smoke",
          componentRole: "service",
          displayName: "Agent Smoke",
          paneLabel: "sample",
          paneOrder: 10
        }
      },
      { manifestPath }
    );
    daemonLog.push("registered sample app through daemon registry");

    const token = server.runtime.token;
    await writeJsonRedacted(
      artifacts.request,
      {
        provider: "openrouter",
        modelSlug: provider.modelSlug,
        baseURL: provider.baseURL,
        reasoning: { enabled: true, effort: REASONING_EFFORT },
        apiKeySource: { type: "environment", envVar: provider.apiKeyEnvVar, configured: true },
        outboundContextPreview: outboundPreview,
        prompts: {
          readOnly: "What apps are currently registered? Use tools if needed.",
          forcedTool: "Use the list_apps tool and summarize the registered apps.",
          setupPlanning:
            "Inspect this folder and propose how to configure it, but do not write files. Use detect_project, plan_app_setup, and preview_setup_writes.",
          approval: "Start the sample app."
        }
      },
      knownSecrets
    );
    await writeJsonRedacted(artifacts.outboundContextPreview, outboundPreview, knownSecrets);

    await apiRequest(baseUrl, token, "PUT", "/__hub/api/agent/config", {
      enabled: true,
      provider: {
        modelSlug: provider.modelSlug,
        apiKeyEnvVar: provider.apiKeyEnvVar,
        remoteModelEnabled: true,
        httpRefererEnvVar: provider.httpRefererEnvVar,
        titleEnvVar: provider.titleEnvVar
      }
    });
    daemonLog.push(`configured Agent Gateway for model ${provider.modelSlug}`);

    const sessionResponse = await apiRequest<{ agent: { session: AgentSession } }>(
      baseUrl,
      token,
      "POST",
      "/__hub/api/agent/sessions",
      {
        title: "RA012D live smoke",
        context: smokeContext(sampleProject)
      }
    );
    const sessionId = sessionResponse.agent.session.id;
    daemonLog.push(`created agent session ${sessionId}`);

    const controller = new AbortController();
    const ssePromise = collectSessionEvents({
      baseUrl,
      token,
      sessionId,
      signal: controller.signal,
      events: capturedEvents
    }).catch((error) => {
      if (!controller.signal.aborted) {
        daemonLog.push(`agent SSE failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    await waitFor(() => capturedEvents.some((event) => event.event === "diagnostic"), 3000);

    const readOnly = await sendAgentPrompt(baseUrl, token, sessionId, {
      label: "read-only app inventory",
      content: "What apps are currently registered? Use tools if needed.",
      context: smokeContext(sampleProject)
    });
    assertCompleted(readOnly, "read-only app inventory");

    const forcedTool = await sendAgentPrompt(baseUrl, token, sessionId, {
      label: "forced list_apps tool",
      content: "Use the list_apps tool and summarize the registered apps.",
      context: smokeContext(sampleProject)
    });
    assertCompleted(forcedTool, "forced list_apps tool");
    assertToolLifecycle(forcedTool.events, "list_apps");
    assertAnswerMentions(forcedTool.session, "Agent Smoke", "forced list_apps tool");

    const setupPlanning = await sendAgentPrompt(baseUrl, token, sessionId, {
      label: "setup planning",
      content:
        "Inspect this folder and propose how to configure it, but do not write files. Use detect_project, plan_app_setup, and preview_setup_writes.",
      context: smokeContext(sampleProject)
    });
    assertCompleted(setupPlanning, "setup planning");
    assertToolLifecycle(setupPlanning.events, "detect_project");
    assertToolLifecycle(setupPlanning.events, "plan_app_setup");
    assertToolLifecycle(setupPlanning.events, "preview_setup_writes");
    assertSetupRuntimeAppears(setupPlanning.session);
    const afterFiles = await snapshotFiles(sampleProject);
    if (JSON.stringify(beforeFiles) !== JSON.stringify(afterFiles)) {
      throw new Error("RA012D_SETUP_PLANNING_WROTE_FILES: setup planning changed sample project files.");
    }
    await writeJsonRedacted(artifacts.setupPlan, setupPlanFromEvents(setupPlanning.events), knownSecrets);

    const approval = await sendAgentPrompt(baseUrl, token, sessionId, {
      label: "approval gate",
      content: "Start the sample app.",
      context: smokeContext(sampleProject, { selectedAppId: "agent-smoke-sample" })
    });
    const approvalEvent = approval.events.find((event) => event.type === "tool.approval_required");
    if (!approvalEvent) {
      throw new Error("RA012D_APPROVAL_REQUIRED_MISSING: start prompt did not create a pending approval.");
    }
    const approvalPayload = approvalEvent.data as { approval?: { id?: string; toolName?: string } };
    const approvalId = approvalPayload.approval?.id;
    const approvalTool = approvalPayload.approval?.toolName;
    if (!approvalId || !["start_app", "open_project_or_app"].includes(String(approvalTool))) {
      throw new Error("RA012D_APPROVAL_TOOL_UNEXPECTED: start prompt did not request start/open approval.");
    }
    if (
      approval.events.some((event) => {
        if (event.type !== "tool.started") {
          return false;
        }
        const data = event.data as { toolName?: string; approvalId?: string } | undefined;
        return data?.approvalId === approvalId || data?.toolName === approvalTool;
      })
    ) {
      throw new Error("RA012D_APPROVAL_EXECUTED_EARLY: approval-gated tool started before approval.");
    }
    await apiRequest(baseUrl, token, "POST", `/__hub/api/agent/approvals/${approvalId}/reject`, {
      reason: "RA012D smoke verifies rejection path."
    });
    const postRejectSession = await getSession(baseUrl, token, sessionId);
    const rejected = postRejectSession.runs
      .flatMap((run) => run.events)
      .some((event) => event.type === "tool.rejected");
    if (!rejected) {
      throw new Error("RA012D_APPROVAL_REJECTION_EVENT_MISSING: rejection did not produce tool.rejected.");
    }
    const appState = await apiRequest<{ apps: Array<{ id: string; runtime: { status: string } }> }>(
      baseUrl,
      token,
      "GET",
      "/__hub/api/state"
    );
    const sampleState = appState.apps.find((app) => app.id === "agent-smoke-sample");
    if (sampleState?.runtime.status !== "stopped") {
      throw new Error("RA012D_APPROVAL_REJECTION_STARTED_APP: sample app was not stopped after rejection.");
    }

    controller.abort();
    await ssePromise;

    const finalSession = await getSession(baseUrl, token, sessionId);
    await writeJsonRedacted(artifacts.session, finalSession, knownSecrets);
    await copyIfExists(path.join(stateDir, "agent", "audit.jsonl"), artifacts.audit, knownSecrets);
    await writeEvents(capturedEvents, artifacts.events, knownSecrets);

    const checks = {
      gatewayRuntime: passed("created token-gated Agent Gateway session and runs through daemon HTTP API"),
      liveModel: passed(`real model response received from ${provider.modelSlug}`),
      reasoning: passed(`reasoning provider data enabled with ${REASONING_EFFORT} effort`),
      readOnlyTool: passed("list_apps emitted tool.call_requested, tool.started, and tool.completed"),
      streaming: passed(`session SSE captured ${capturedEvents.length} events`),
      setupPlanning: passed("detect_project, plan_app_setup, and preview_setup_writes ran without file changes"),
      approvalGate: passed(`${approvalTool} required approval, was rejected, and did not start the app`),
      sessionAudit: passed("session and audit artifacts were written under disposable state"),
      secretScan: passed("artifact secret scan completed without leaks")
    };

    finalResult = {
      ok: true,
      provider: "openrouter",
      modelSlug: provider.modelSlug,
      reasoning: {
        enabled: true,
        effort: REASONING_EFFORT
      },
      daemon: {
        baseUrl,
        stateDir
      },
      sampleProject,
      artifacts,
      checks,
      forkRequired: false
    };
    await writeJsonRedacted(artifacts.response, finalResult, knownSecrets);
    await writeReport({ result: finalResult, daemonLog, failure: undefined });
    await fsp.writeFile(artifacts.daemonLog, `${daemonLog.join("\n")}\n`, "utf8");
    await secretScan([ARTIFACT_DIR, REPORT_PATH], knownSecrets, artifacts.secretScan);
    return finalResult;
  } catch (error) {
    failure = sanitizeAgentPayload(error, knownSecrets);
    await writeJsonRedacted(
      artifacts.response,
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        modelSlug: provider.modelSlug,
        reasoning: { enabled: true, effort: REASONING_EFFORT }
      },
      knownSecrets
    );
    await fsp.writeFile(artifacts.daemonLog, `${daemonLog.join("\n")}\n`, "utf8").catch(() => undefined);
    await writeEvents(capturedEvents, artifacts.events, knownSecrets).catch(() => undefined);
    if (stateDir) {
      await copyIfExists(path.join(stateDir, "agent", "audit.jsonl"), artifacts.audit, knownSecrets).catch(
        () => undefined
      );
      await copyIfExists(path.join(stateDir, "agent", "sessions.json"), artifacts.session, knownSecrets).catch(
        () => undefined
      );
    }
    await writeReport({ result: undefined, daemonLog, failure });
    await secretScan([ARTIFACT_DIR, REPORT_PATH], knownSecrets, artifacts.secretScan).catch(() => undefined);
    throw error;
  } finally {
    await server?.close().catch(() => undefined);
  }
}

export function printOpenRouterLiveSmokeResult(result: OpenRouterLiveSmokeResult): void {
  console.log("Relaybase OpenRouter Operator Agent live smoke");
  console.log(`provider: ${result.provider}`);
  console.log(`model: ${result.modelSlug}`);
  console.log(`reasoning: enabled (${result.reasoning.effort})`);
  console.log(`daemon: ${result.daemon.baseUrl}`);
  console.log(`fork required: ${result.forkRequired ? "yes" : "no"}`);
  for (const [name, check] of Object.entries(result.checks)) {
    console.log(`${name}: ${check.status} - ${check.evidence}`);
  }
  console.log(`report: ${REPORT_PATH}`);
  console.log(`artifacts: ${ARTIFACT_DIR}`);
}

export function formatOpenRouterLiveSmokeError(error: unknown): string {
  if (error instanceof OpenRouterProviderError) {
    return formatOpenRouterProviderError(error);
  }
  const sanitized = sanitizeAgentPayload(error);
  const message =
    sanitized && typeof sanitized === "object" && "message" in sanitized
      ? String((sanitized as { message: unknown }).message)
      : String(sanitized);
  return `OPENROUTER_AGENT_LIVE_SMOKE_FAILED: ${message}`;
}

async function sendAgentPrompt(
  baseUrl: string,
  token: string,
  sessionId: string,
  input: { label: string; content: string; context: Record<string, unknown> }
): Promise<SmokePromptResult> {
  const before = await getSession(baseUrl, token, sessionId);
  const beforeSequences = new Set(before.runs.flatMap((run) => run.events.map((event) => event.sequence)));
  const response = await apiRequest<{ agent: { run: { id?: string } } }>(
    baseUrl,
    token,
    "POST",
    `/__hub/api/agent/sessions/${sessionId}/messages`,
    {
      content: input.content,
      context: input.context
    }
  );
  const runId = response.agent.run.id;
  if (!runId) {
    throw new Error(`RA012D_${input.label.replace(/\W+/g, "_").toUpperCase()}_RUN_ID_MISSING`);
  }
  await waitForAgentRunTerminal(
    async () => {
      const result = await apiRequest<{ agent: { run: AgentSession["runs"][number] } }>(
        baseUrl,
        token,
        "GET",
        `/__hub/api/agent/sessions/${sessionId}/runs/${runId}`
      );
      return result.agent.run;
    },
    { label: input.label }
  );
  const session = await getSession(baseUrl, token, sessionId);
  const events = session.runs.flatMap((run) => run.events).filter((event) => !beforeSequences.has(event.sequence));
  return {
    label: input.label,
    runId,
    events,
    session
  };
}

async function getSession(baseUrl: string, token: string, sessionId: string): Promise<AgentSession> {
  const response = await apiRequest<{ agent: { session: AgentSession } }>(
    baseUrl,
    token,
    "GET",
    `/__hub/api/agent/sessions/${sessionId}`
  );
  return response.agent.session;
}

async function apiRequest<T>(
  baseUrl: string,
  token: string,
  method: string,
  pathname: string,
  body?: unknown
): Promise<T> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      "x-relaybase-token": token,
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const text = await response.text();
  const parsed = text ? (JSON.parse(text) as unknown) : {};
  if (!response.ok) {
    throw new Error(`HTTP_${response.status}_${method}_${pathname}: ${JSON.stringify(parsed)}`);
  }
  return parsed as T;
}

async function collectSessionEvents(input: {
  baseUrl: string;
  token: string;
  sessionId: string;
  signal: AbortSignal;
  events: CapturedSseEvent[];
}): Promise<void> {
  const response = await fetch(`${input.baseUrl}/__hub/api/agent/sessions/${input.sessionId}/events`, {
    headers: { "x-relaybase-token": input.token },
    signal: input.signal
  });
  if (!response.ok || !response.body) {
    throw new Error(`Agent session SSE failed: HTTP ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const read = await reader.read();
      if (read.done) {
        break;
      }
      buffer += decoder.decode(read.value, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const event = parseSseEvent(part);
        if (event) {
          input.events.push(event);
        }
      }
    }
  } catch (error) {
    if (!input.signal.aborted) {
      throw error;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSseEvent(block: string): CapturedSseEvent | undefined {
  const event: CapturedSseEvent = {};
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) {
      continue;
    }
    const separator = line.indexOf(":");
    const key = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? "" : line.slice(separator + 1).trimStart();
    if (key === "id") {
      event.id = value;
    } else if (key === "event") {
      event.event = value;
    } else if (key === "data") {
      dataLines.push(value);
    }
  }
  if (!event.id && !event.event && dataLines.length === 0) {
    return undefined;
  }
  if (dataLines.length) {
    const dataText = dataLines.join("\n");
    try {
      event.data = JSON.parse(dataText) as unknown;
    } catch {
      event.data = dataText;
    }
  }
  return event;
}

function smokeContext(sampleProject: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    currentCwd: sampleProject,
    daemonHasZeroApps: false,
    diagnostics: [],
    terminalCapabilities: {
      clipboard: "unavailable",
      browserOpen: "unavailable",
      colorDepth: "truecolor"
    },
    ...overrides
  };
}

async function createSampleProject(project: string): Promise<void> {
  await fsp.mkdir(project, { recursive: true });
  await fsp.writeFile(
    path.join(project, "package.json"),
    JSON.stringify(
      {
        name: "relaybase-agent-smoke-sample",
        private: true,
        scripts: {
          dev: "node server.js"
        },
        dependencies: {}
      },
      null,
      2
    ),
    "utf8"
  );
  await fsp.writeFile(
    path.join(project, "server.js"),
    [
      "import http from 'node:http';",
      "const port = Number(process.env.PORT || 0);",
      "const server = http.createServer((_req, res) => res.end('relaybase agent smoke ok'));",
      "server.listen(port, '127.0.0.1');",
      "process.on('SIGTERM', () => server.close(() => process.exit(0)));",
      ""
    ].join("\n"),
    "utf8"
  );
  await fsp.writeFile(
    path.join(project, "relaybase.app.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        id: "agent-smoke-sample",
        name: "Agent Smoke Sample",
        command: "node server.js",
        cwd: project,
        protocol: "http",
        healthUrl: "/"
      },
      null,
      2
    ),
    "utf8"
  );
}

async function snapshotFiles(root: string): Promise<Array<{ path: string; sha256: string }>> {
  const files: Array<{ path: string; sha256: string }> = [];
  async function walk(directory: string): Promise<void> {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const buffer = await fsp.readFile(full);
        files.push({
          path: path.relative(root, full).replace(/\\/g, "/"),
          sha256: createHash("sha256").update(buffer).digest("hex")
        });
      }
    }
  }
  await walk(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function assertCompleted(result: SmokePromptResult, label: string): void {
  const run = result.session.runs.find((entry) => entry.id === result.runId) ?? result.session.runs.at(-1);
  if (run?.status !== "completed") {
    throw new Error(`RA012D_${label.replace(/\W+/g, "_").toUpperCase()}_FAILED: run status ${run?.status}`);
  }
  if (!result.events.some((event) => event.type === "model.completed")) {
    throw new Error(`RA012D_${label.replace(/\W+/g, "_").toUpperCase()}_NO_MODEL_COMPLETED_EVENT`);
  }
}

function assertToolLifecycle(events: AgentRunEvent[], toolName: string): void {
  const eventNames = events
    .filter((event) => {
      const data = event.data as { toolName?: string } | undefined;
      return data?.toolName === toolName;
    })
    .map((event) => event.type);
  for (const required of ["tool.call_requested", "tool.started", "tool.completed"]) {
    if (!eventNames.includes(required as AgentRunEvent["type"])) {
      throw new Error(`RA012D_TOOL_EVENT_MISSING: ${toolName} did not emit ${required}.`);
    }
  }
}

function assertAnswerMentions(session: AgentSession, text: string, label: string): void {
  const answer = session.messages.filter((message) => message.role === "assistant").at(-1)?.content ?? "";
  if (!answer.includes(text)) {
    throw new Error(`RA012D_${label.replace(/\W+/g, "_").toUpperCase()}_ANSWER_MISSING_TOOL_RESULT`);
  }
}

function assertSetupRuntimeAppears(session: AgentSession): void {
  const serialized = JSON.stringify(session);
  if (!/javascript|typescript|node|package/i.test(serialized)) {
    throw new Error("RA012D_SETUP_RUNTIME_MISSING: setup output did not include runtime/language evidence.");
  }
}

function setupPlanFromEvents(events: AgentRunEvent[]): unknown {
  const setupEvent = events.find((event) => event.type === "setup.plan_preview");
  if (setupEvent) {
    return setupEvent.data;
  }
  const previewTool = events.find((event) => {
    const data = event.data as { toolName?: string } | undefined;
    return event.type === "tool.completed" && data?.toolName === "preview_setup_writes";
  });
  return previewTool?.data ?? { unavailable: true };
}

function passed(evidence: string): OpenRouterLiveSmokeCheck {
  return { status: "passed", evidence };
}

function artifactPaths(): Record<string, string> {
  return {
    request: path.join(ARTIFACT_DIR, "openrouter-request-redacted.json"),
    response: path.join(ARTIFACT_DIR, "openrouter-response-redacted.json"),
    events: path.join(ARTIFACT_DIR, "agent-events.jsonl"),
    audit: path.join(ARTIFACT_DIR, "agent-audit.jsonl"),
    session: path.join(ARTIFACT_DIR, "session-redacted.json"),
    daemonLog: path.join(ARTIFACT_DIR, "daemon.log"),
    setupPlan: path.join(ARTIFACT_DIR, "setup-plan.json"),
    outboundContextPreview: path.join(ARTIFACT_DIR, "outbound-context-preview.json"),
    secretScan: path.join(ARTIFACT_DIR, "secret-scan.txt")
  };
}

function outboundContextPreview(workspace: string, samplePaths: string[]): Record<string, unknown> {
  const repoRoot = process.cwd();
  const normalizedWorkspace = path.resolve(workspace);
  const home = os.homedir();
  const entries = samplePaths.map((samplePath) => {
    const resolved = path.resolve(samplePath);
    return {
      ref: path.basename(resolved),
      disposableTempPath: resolved.startsWith(normalizedWorkspace),
      underRepoRoot: isSubpath(resolved, repoRoot),
      underUserHome: isSubpath(resolved, home),
      sentToProviderAsCwd: true
    };
  });
  const unsafe = entries.filter((entry) => entry.underRepoRoot || !entry.disposableTempPath);
  if (unsafe.length > 0) {
    throw new Error(
      `BLOCKED_LIVE_OUTBOUND_CONTEXT_UNSAFE: live smoke would send a non-disposable local path to OpenRouter. detail=${JSON.stringify(
        entries
      )}`
    );
  }
  return {
    status: "allowed_disposable_context",
    policy:
      "Live prompts use disposable temp sample projects only. Real repo roots and non-disposable current folders are blocked before provider calls.",
    entries
  };
}

function isSubpath(candidate: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resetArtifactDir(directory: string): Promise<void> {
  await fsp.rm(directory, { recursive: true, force: true });
  await fsp.mkdir(directory, { recursive: true });
}

async function writeJsonRedacted(file: string, value: unknown, knownSecrets: string[]): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(sanitizeAgentPayload(value, knownSecrets), null, 2), "utf8");
}

async function writeEvents(events: CapturedSseEvent[], file: string, knownSecrets: string[]): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const lines = events.map((event) => JSON.stringify(sanitizeAgentPayload(event, knownSecrets)));
  await fsp.writeFile(file, `${lines.join("\n")}${lines.length ? "\n" : ""}`, "utf8");
}

async function copyIfExists(source: string, target: string, knownSecrets: string[]): Promise<void> {
  if (!fs.existsSync(source)) {
    await fsp.writeFile(target, "", "utf8");
    return;
  }
  const raw = await fsp.readFile(source, "utf8");
  const redacted = sanitizeAgentPayloadWithReport(raw, knownSecrets).value;
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, String(redacted), "utf8");
}

async function secretScan(pathsToScan: string[], knownSecrets: string[], outputPath: string): Promise<void> {
  const findings: Array<{ file: string; category: string }> = [];
  for (const target of pathsToScan) {
    if (!fs.existsSync(target)) {
      continue;
    }
    const stat = await fsp.stat(target);
    const files = stat.isDirectory() ? await listFiles(target) : [target];
    for (const file of files) {
      const text = await fsp.readFile(file, "utf8").catch(() => "");
      for (const secret of knownSecrets) {
        if (secret && text.includes(secret)) {
          findings.push({ file, category: "known_secret" });
        }
      }
      if (/\bsk-or-[A-Za-z0-9._-]+/g.test(text)) {
        findings.push({ file, category: "openrouter_api_key_pattern" });
      }
      if (/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi.test(text)) {
        findings.push({ file, category: "bearer_token_pattern" });
      }
    }
  }
  const content = findings.length
    ? `FAIL secret scan\n${findings.map((finding) => `${finding.category} ${finding.file}`).join("\n")}\n`
    : "PASS secret scan: no OpenRouter key, Relaybase token, bearer token, or sk-or pattern found in promoted artifacts.\n";
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  await fsp.writeFile(outputPath, content, "utf8");
  if (findings.length) {
    throw new Error("RA012D_SECRET_SCAN_FAILED: promoted artifacts contain secret-like values.");
  }
}

async function listFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  }
  await walk(directory);
  return files;
}

async function writeReport(input: {
  result: OpenRouterLiveSmokeResult | undefined;
  daemonLog: string[];
  failure: unknown;
}): Promise<void> {
  await fsp.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  const status = input.result ? "PASS" : "FAIL";
  const lines = [
    "# RA012D OpenRouter Live Smoke",
    "",
    `Status: ${status}`,
    "",
    "## Scope",
    "",
    "This smoke uses the actual Relaybase Agent Gateway, daemon Operator Agent runtime, OpenAI Agents SDK TypeScript path, and OpenRouter provider. It does not use mocked model responses or a fake OpenRouter server.",
    "",
    "## Result",
    "",
    input.result
      ? `- Model: ${input.result.modelSlug}\n- Reasoning: enabled (${input.result.reasoning.effort})\n- Fork required: ${input.result.forkRequired ? "yes" : "no"}`
      : `- Failure: ${input.failure instanceof Error ? input.failure.message : String(input.failure)}`,
    "",
    "## Checks",
    "",
    ...(input.result
      ? Object.entries(input.result.checks).map(([name, check]) => `- ${name}: ${check.status} - ${check.evidence}`)
      : ["- Live smoke did not reach acceptance. See artifacts for redacted diagnostics."]),
    "",
    "## Artifacts",
    "",
    ...Object.entries(artifactPaths()).map(([name, file]) => `- ${name}: ${file}`),
    "",
    "## Daemon Log Summary",
    "",
    ...input.daemonLog.map((line) => `- ${line}`),
    ""
  ];
  await fsp.writeFile(REPORT_PATH, lines.join("\n"), "utf8");
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
