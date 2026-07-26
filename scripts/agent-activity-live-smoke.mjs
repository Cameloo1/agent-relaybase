import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadRelaybaseEnvFile } from "../src/envFile.ts";
import { OperatorAgentRuntime } from "../src/agent/runtime.ts";
import { resolveOpenRouterProviderOptions } from "../src/agent/openrouterProvider.ts";
import { createRelaybaseServer } from "../src/server.ts";

const MAX_PHASE_COST_USD = 0.08;
const MAX_OUTPUT_TOKENS = 256;

loadRelaybaseEnvFile();
const provider = resolveOpenRouterProviderOptions();

if (process.argv.includes("--preflight")) {
  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: "preflight",
        provider: "openrouter",
        model: provider.modelSlug,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        maxPhaseCostUsd: MAX_PHASE_COST_USD,
        apiKeyConfigured: Boolean(provider.apiKey)
      },
      null,
      2
    )
  );
  process.exit(0);
}

if (!provider.apiKey) throw new Error("OPENROUTER_API_KEY is not configured.");

const usageBefore = await openRouterUsage(provider.apiKey);
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-agent-activity-"));
const stateDir = path.join(workspace, "state");
const server = await createRelaybaseServer({
  host: "127.0.0.1",
  port: 0,
  stateDir,
  agentRuntime: new OperatorAgentRuntime({ maxOutputTokens: MAX_OUTPUT_TOKENS })
});

try {
  await server.listen();
  await server.runtime.registry.upsertManifest({
    id: "activity-smoke-app",
    name: "Activity Smoke App",
    command: "node --version",
    cwd: workspace,
    protocol: "http",
    healthUrl: "/"
  });
  server.runtime.agentGateway.updateConfig({
    enabled: true,
    provider: {
      modelSlug: provider.modelSlug,
      apiKeyEnvVar: provider.apiKeyEnvVar,
      remoteModelEnabled: true,
      httpRefererEnvVar: provider.httpRefererEnvVar,
      titleEnvVar: provider.titleEnvVar
    },
    budgets: { sessionLimitUsd: MAX_PHASE_COST_USD }
  });

  const session = await server.runtime.agentGateway.createSession(server.runtime, {
    title: "Agent activity live smoke",
    context: { daemonHasZeroApps: false, diagnostics: [], currentCwd: workspace }
  });
  const streamed = [];
  const unsubscribe = server.runtime.agentGateway.subscribeSession(session.id, (event) => streamed.push(event));
  try {
    const accepted = await server.runtime.agentGateway.addMessage(server.runtime, session.id, {
      content:
        "Use list_apps once. Then use get_app_state once for appId activity-smoke-app. Reply only with the registered app name and status.",
      context: { daemonHasZeroApps: false, diagnostics: [], currentCwd: workspace }
    });
    const run = await waitForTerminalRun(server.runtime.agentGateway, session.id, accepted.run.id);
    if (run.status !== "completed") throw new Error(`Live activity run ended ${run.status}.`);

    const started = streamed.filter((event) => event.type === "tool.started").map((event) => event.data?.activity);
    const completed = streamed.filter((event) => event.type === "tool.completed").map((event) => event.data?.activity);
    const runStarted = streamed.find((event) => event.type === "run.started")?.data?.activity;
    const runFinalized = streamed.find((event) => event.type === "run.finalized")?.data?.activity;
    const expectedTools = [
      { active: "Listing registered apps", completed: "Listed registered apps" },
      { active: "Inspecting app state", completed: "Inspected app state" }
    ];
    if (started.length !== expectedTools.length || completed.length !== expectedTools.length) {
      throw new Error(`Live activity expected two read-only tools; received ${started.length}/${completed.length}.`);
    }
    for (const [index, expectedTool] of expectedTools.entries()) {
      if (started[index]?.label !== expectedTool.active || started[index]?.state !== "active") {
        throw new Error(`Live tool-start activity ${index + 1} was missing or incorrect.`);
      }
      if (
        completed[index]?.id !== started[index].id ||
        completed[index]?.label !== expectedTool.completed ||
        completed[index]?.state !== "completed" ||
        typeof completed[index]?.output !== "string" ||
        completed[index].output.length === 0
      ) {
        throw new Error(`Live tool-completion activity ${index + 1} did not retain a stable sanitized result.`);
      }
    }
    if (runStarted?.label !== "Analyzing request…" || runFinalized?.state !== "completed") {
      throw new Error("Live run activity projection was missing its start or terminal state.");
    }
    const finalSession = server.runtime.agentGateway.getSession(session.id);
    const answer = finalSession.messages.findLast((message) => message.role === "assistant")?.content ?? "";
    if (!answer.includes("Activity Smoke App")) {
      throw new Error("Live Agent answer did not reflect the actual list_apps result.");
    }
    const costUsd = Number(run.usage?.costUsd ?? run.usage?.estimatedCostUsd ?? 0);
    if (Number.isFinite(costUsd) && costUsd > MAX_PHASE_COST_USD) {
      throw new Error(`Live run cost ${costUsd} exceeded ${MAX_PHASE_COST_USD}.`);
    }
    const serialized = JSON.stringify(streamed);
    if (serialized.includes(provider.apiKey)) throw new Error("Live activity events leaked the provider key.");

    const usageAfter = await openRouterUsage(provider.apiKey);
    const accountDeltaUsd = usageBefore !== null && usageAfter !== null ? Math.max(0, usageAfter - usageBefore) : null;
    if (accountDeltaUsd !== null && accountDeltaUsd > MAX_PHASE_COST_USD) {
      throw new Error(`OpenRouter usage delta ${accountDeltaUsd} exceeded ${MAX_PHASE_COST_USD}.`);
    }
    console.log(
      JSON.stringify(
        {
          ok: true,
          model: provider.modelSlug,
          promptCount: 1,
          readOnlyToolCalls: completed.length,
          eventCount: streamed.length,
          stableToolActivityIds: completed.map((activity) => activity.id),
          runCostUsd: Number.isFinite(costUsd) ? costUsd : null,
          accountUsageDeltaUsd: accountDeltaUsd,
          maxPhaseCostUsd: MAX_PHASE_COST_USD,
          secretScan: "passed"
        },
        null,
        2
      )
    );
  } finally {
    unsubscribe();
  }
} finally {
  await server.close();
  await removeWorkspaceWithRetry(workspace);
}

async function waitForTerminalRun(gateway, sessionId, runId) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const run = gateway.getRun(sessionId, runId);
    if (["completed", "failed", "cancelled", "waiting_for_approval"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Live activity run timed out.");
}

async function openRouterUsage(apiKey) {
  const response = await fetch("https://openrouter.ai/api/v1/auth/key", {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  if (!response.ok) return null;
  const payload = await response.json();
  const value = payload?.data?.usage;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function removeWorkspaceWithRetry(workspace) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await fs.rm(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return;
    } catch (error) {
      if (attempt === 5 || !["EBUSY", "EPERM", "ENOTEMPTY"].includes(error?.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 100));
    }
  }
}
