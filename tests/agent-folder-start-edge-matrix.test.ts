import assert from "node:assert/strict";
import { promises as fs, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentAuditStore } from "../src/agent/auditStore.ts";
import { AgentSessionStore } from "../src/agent/sessionStore.ts";
import type { AgentToolExecutionContext } from "../src/agent/tools/index.ts";
import { executeRelaybaseAgentTool } from "../src/agent/tools/index.ts";
import type { TuiAgentContext } from "../src/agent/types.ts";
import { OperationStore } from "../src/operationStore.ts";
import type { RelaybaseRuntime } from "../src/server.ts";
import { detectProject, proposeSetupPlans } from "../src/setup.ts";
import { previewManifestPatch, previewSetup, repairSetup, SetupApiRequestError } from "../src/setupApi.ts";
import type { AppRecord, AppStatusView, RuntimeView } from "../src/types.ts";

test("AGENT-FOLDER-START-005 project fixture matrix detects, previews, and keeps dry-run read-only", async () => {
  const requiredFixtures = new Set([
    "js-npm-dev",
    "vite-app",
    "next-app",
    "astro-app",
    "plain-node-port",
    "app-ignoring-port",
    "package-no-dev-script",
    "missing-package-manager-tool",
    "empty-folder",
    "existing-valid-manifest",
    "path-with-spaces",
    "windows-absolute-path",
    "relative-path",
    "monorepo-frontend-backend"
  ]);
  const covered = new Set<string>();
  const expectedNpm = process.platform === "win32" ? /npm\.cmd run dev/ : /npm run dev/;
  const fixtures: Array<{
    id: string;
    files: Record<string, string>;
    projectName?: string;
    cwdVariant?: "absolute" | "relative";
    selectedPlanId?: string;
    expectText?: RegExp;
    expectManifestBefore?: boolean;
    assertProject?: (project: string) => Promise<void>;
  }> = [
    {
      id: "js-npm-dev",
      files: {
        "package.json": JSON.stringify({ name: "js-dev", scripts: { dev: "node server.js" } }, null, 2),
        "server.js": "require('node:http').createServer((_, res) => res.end('ok')).listen(process.env.PORT);\n"
      },
      expectText: expectedNpm
    },
    {
      id: "vite-app",
      files: {
        "package.json": JSON.stringify(
          { name: "vite-edge", scripts: { dev: "vite" }, devDependencies: { vite: "^6.0.0" } },
          null,
          2
        )
      },
      selectedPlanId: "framework-port-flag",
      expectText: /--port|generated_launch_wrapper|framework_port_flags/
    },
    {
      id: "next-app",
      files: {
        "package.json": JSON.stringify(
          { name: "next-edge", scripts: { dev: "next dev" }, dependencies: { next: "^16.0.0" } },
          null,
          2
        )
      },
      selectedPlanId: "framework-port-flag",
      expectText: /"-p"|framework_port_flags/
    },
    {
      id: "astro-app",
      files: {
        "package.json": JSON.stringify(
          { name: "astro-edge", scripts: { dev: "astro dev" }, devDependencies: { astro: "^5.0.0" } },
          null,
          2
        )
      },
      selectedPlanId: "framework-port-flag",
      expectText: /--port|framework_port_flags/
    },
    {
      id: "plain-node-port",
      files: {
        "package.json": JSON.stringify({ name: "plain-node", scripts: { dev: "node server.js" } }, null, 2),
        "server.js": "const port = process.env.PORT; console.log('listening', port);\n"
      },
      expectText: /managed_dynamic_port|env_port/
    },
    {
      id: "app-ignoring-port",
      files: {
        "package.json": JSON.stringify(
          { name: "ignores-port", scripts: { dev: "vite" }, devDependencies: { vite: "^6.0.0" } },
          null,
          2
        ),
        ".env": "VITE_PORT=5173\nOPENROUTER_API_KEY=sk-or-edge-fixture-secret\n"
      },
      selectedPlanId: "pinned-upstream",
      expectText: /fixed_upstream_port|5173/
    },
    {
      id: "package-no-dev-script",
      files: {
        "package.json": JSON.stringify(
          { name: "no-dev-script", scripts: { build: "vite build" }, devDependencies: { vite: "^6.0.0" } },
          null,
          2
        )
      },
      expectText: /node server\.js|selectedCommand/
    },
    {
      id: "missing-package-manager-tool",
      files: {
        "package.json": JSON.stringify(
          { name: "pnpm-project", packageManager: "pnpm@9.0.0", scripts: { dev: "vite" } },
          null,
          2
        )
      },
      expectText: process.platform === "win32" ? /corepack\.cmd pnpm run dev/ : /corepack pnpm run dev/
    },
    {
      id: "empty-folder",
      files: {},
      expectText: /manual_custom|external|SETUP_RUNTIME_UNSUPPORTED/
    },
    {
      id: "existing-valid-manifest",
      expectManifestBefore: true,
      files: {
        "relaybase.app.json": JSON.stringify(
          {
            schemaVersion: 1,
            id: "existing-edge",
            name: "Existing Edge",
            command: "npm.cmd run dev",
            cwd: ".",
            protocol: "http"
          },
          null,
          2
        )
      },
      expectText: /existing-edge|relaybase\.app\.json/
    },
    {
      id: "path-with-spaces",
      projectName: "Project With Spaces",
      files: {
        "package.json": JSON.stringify({ name: "spaces-app", scripts: { dev: "node server.js" } }, null, 2)
      },
      expectText: /spaces-app|Project With Spaces/
    },
    {
      id: "windows-absolute-path",
      files: {
        "package.json": JSON.stringify({ name: "absolute-app", scripts: { dev: "node server.js" } }, null, 2)
      },
      cwdVariant: "absolute",
      assertProject: async (project) => assert.equal(path.isAbsolute(project), true)
    },
    {
      id: "relative-path",
      files: {
        "package.json": JSON.stringify({ name: "relative-app", scripts: { dev: "node server.js" } }, null, 2)
      },
      cwdVariant: "relative"
    },
    {
      id: "monorepo-frontend-backend",
      files: {
        "package.json": JSON.stringify({ name: "edge-monorepo", workspaces: ["apps/*"] }, null, 2),
        "apps/frontend/package.json": JSON.stringify({ name: "edge-web", scripts: { dev: "vite" } }, null, 2),
        "apps/backend/package.json": JSON.stringify({ name: "edge-api", scripts: { dev: "node server.js" } }, null, 2)
      },
      expectText: /monorepo|workspaces|manual_custom|external/
    }
  ];

  for (const fixture of fixtures) {
    const project = await runtimeProject(`relaybase-folder-edge-${fixture.id}-`, fixture.files, fixture.projectName);
    covered.add(fixture.id);
    await fixture.assertProject?.(project);
    const cwd = fixture.cwdVariant === "relative" ? path.relative(process.cwd(), project) : project;
    const manifestPath = path.join(project, "relaybase.app.json");
    const manifestBefore = await exists(manifestPath);
    assert.equal(manifestBefore, fixture.expectManifestBefore ?? false, fixture.id);

    const detection = await detectProject(cwd);
    const plans = await proposeSetupPlans(detection);
    assert.ok(plans.length, fixture.id);
    assert.equal(await exists(path.join(project, ".relaybase", "setup-profile.json")), false, fixture.id);

    const preview = await previewSetup({
      cwd,
      ...(fixture.selectedPlanId ? { selectedPlanId: fixture.selectedPlanId } : {})
    });
    const serialized = JSON.stringify({ detection, plans, preview });
    assert.doesNotMatch(serialized, /sk-or-edge-fixture-secret/, fixture.id);
    if (fixture.expectText) {
      assert.match(serialized, fixture.expectText, fixture.id);
    }
    assert.equal(await exists(manifestPath), manifestBefore, fixture.id);
  }

  assert.deepEqual([...covered].sort(), [...requiredFixtures].sort());
});

test("AGENT-FOLDER-START-005 setup/start tool edge cases gate mutations and never fake success", async () => {
  const nonexistentProject = path.join(os.tmpdir(), `relaybase-missing-${Date.now()}`);
  const missingContext = fakeToolContext();
  const nonexistent = await executeRelaybaseAgentTool(
    "setup_and_start_project",
    { phase: "apply_setup", cwd: nonexistentProject },
    { ...missingContext, approved: true }
  );
  assert.equal(nonexistent.status, "diagnostic");
  assert.equal(nonexistent.diagnostic?.code, "PROJECT_ROOT_NOT_GRANTED");
  assert.equal(missingContext.calls.register, 0);
  assert.equal(missingContext.calls.start, 0);

  const invalidPackageProject = await runtimeProject("relaybase-folder-edge-invalid-package-", {
    "package.json": "{not json"
  });
  const invalidPackageContext = fakeToolContext({
    tuiContext: {
      currentCwd: invalidPackageProject,
      authorizedProjectRoots: [invalidPackageProject],
      daemonHasZeroApps: true,
      diagnostics: []
    }
  });
  const invalidPackage = await executeRelaybaseAgentTool(
    "setup_and_start_project",
    { phase: "apply_setup", cwd: invalidPackageProject },
    { ...invalidPackageContext, approved: true }
  );
  assert.equal(invalidPackage.status, "diagnostic");
  assert.equal(invalidPackage.diagnostic?.code, "AGENT_TOOL_FAILED");
  assert.equal(await exists(path.join(invalidPackageProject, "relaybase.app.json")), false);

  const corruptManifestProject = await runtimeProject("relaybase-folder-edge-corrupt-manifest-", {
    "relaybase.app.json": "{not json"
  });
  const corruptManifest = await executeRelaybaseAgentTool(
    "setup_and_start_project",
    { phase: "register_manifest", cwd: corruptManifestProject },
    fakeToolContext({
      tuiContext: {
        currentCwd: corruptManifestProject,
        authorizedProjectRoots: [corruptManifestProject],
        daemonHasZeroApps: true,
        diagnostics: []
      }
    })
  );
  assert.equal(corruptManifest.status, "diagnostic");
  assert.equal(corruptManifest.diagnostic?.code, "SETUP_AND_START_MANIFEST_INVALID");

  const unregisteredProject = await runtimeProject("relaybase-folder-edge-unregistered-", {
    "package.json": JSON.stringify({ name: "unregistered-edge", scripts: { dev: "node server.js" } }, null, 2)
  });
  const unregisteredManifest = path.join(unregisteredProject, "relaybase.app.json");
  await writeManifest(unregisteredManifest, {
    id: "unregistered-edge",
    name: "Unregistered Edge",
    cwd: unregisteredProject,
    healthUrl: "/"
  });
  const unregisteredContext = fakeToolContext({
    tuiContext: {
      currentCwd: unregisteredProject,
      authorizedProjectRoots: [unregisteredProject],
      daemonHasZeroApps: true,
      diagnostics: []
    }
  });
  const startBeforeRegister = await executeRelaybaseAgentTool(
    "setup_and_start_project",
    { phase: "start_registered", cwd: unregisteredProject },
    { ...unregisteredContext, approved: true }
  );
  assert.equal(startBeforeRegister.status, "diagnostic");
  assert.equal(startBeforeRegister.diagnostic?.code, "SETUP_AND_START_REGISTRATION_REQUIRED");
  assert.equal(unregisteredContext.calls.start, 0);

  const registerPreview = await executeRelaybaseAgentTool(
    "setup_and_start_project",
    { phase: "register_manifest", cwd: unregisteredProject, manifestPath: unregisteredManifest },
    unregisteredContext
  );
  assert.equal(registerPreview.status, "approval_required");
  assert.equal(unregisteredContext.calls.register, 0);
  const registerArguments = registerPreview.approval?.arguments as Record<string, unknown>;

  const registered = await executeRelaybaseAgentTool("setup_and_start_project", registerArguments, {
    ...unregisteredContext,
    approved: true
  });
  assert.equal(registered.status, "succeeded");
  assert.equal(unregisteredContext.calls.register, 1);

  const spacesProject = await runtimeProject(
    "relaybase-folder-edge-registered-spaces-",
    {
      "package.json": JSON.stringify({ name: "registered-spaces", scripts: { dev: "node server.js" } }, null, 2)
    },
    "Registered Project With Spaces"
  );
  const spacesManifest = path.join(spacesProject, "relaybase.app.json");
  await writeManifest(spacesManifest, {
    id: "registered-spaces",
    name: "Registered Spaces",
    cwd: spacesProject,
    healthUrl: "/"
  });
  const registeredApp = appStatus("registered-spaces", "Registered Spaces", "frontend", "spaces", "frontend");
  registeredApp.cwd = spacesProject;
  registeredApp.manifestPath = spacesManifest;
  const registeredContext = fakeToolContext({
    apps: [registeredApp],
    logs: [
      {
        appId: "registered-spaces",
        message: "ready token=folder-start-secret OPENROUTER_API_KEY=sk-or-folder-start-secret"
      }
    ],
    tuiContext: {
      currentCwd: spacesProject,
      authorizedProjectRoots: [spacesProject],
      daemonHasZeroApps: false,
      diagnostics: []
    }
  });
  const startPreview = await executeRelaybaseAgentTool(
    "setup_and_start_project",
    { phase: "start_registered", cwd: spacesProject },
    registeredContext
  );
  assert.equal(startPreview.status, "approval_required");
  assert.equal(registeredContext.calls.start, 0);
  const started = await executeRelaybaseAgentTool(
    "setup_and_start_project",
    { phase: "start_registered", cwd: spacesProject },
    { ...registeredContext, approved: true }
  );
  assert.equal(started.status, "succeeded");
  assert.equal(registeredContext.calls.start, 1);
  assert.match(JSON.stringify(started.data), /http:\/\/registered-spaces\.localhost/);
  assert.doesNotMatch(JSON.stringify(started), /folder-start-secret|sk-or-folder-start-secret/);

  const staleProject = await runtimeProject("relaybase-folder-edge-stale-", {
    "package.json": JSON.stringify({ name: "stale-edge", scripts: { dev: "node server.js" } }, null, 2)
  });
  const staleApp = appStatus("stale-edge", "Stale Edge", "frontend", "stale", "frontend");
  staleApp.cwd = staleProject;
  const staleContext = fakeToolContext({
    apps: [staleApp],
    startRuntime: {
      status: "errored",
      health: "unhealthy",
      phase: "errored",
      lastError: "Project cwd disappeared before start.",
      logLines: 0
    },
    tuiContext: { currentCwd: staleProject, daemonHasZeroApps: false, diagnostics: [] }
  });
  await fs.rm(staleProject, { recursive: true, force: true });
  const staleResult = await executeRelaybaseAgentTool(
    "setup_and_start_project",
    { phase: "start_registered", appId: "stale-edge" },
    { ...staleContext, approved: true }
  );
  assert.equal(staleResult.status, "failed");
  assert.equal(staleResult.diagnostic?.code, "SETUP_AND_START_START_FAILED");
  assert.doesNotMatch(JSON.stringify(staleResult), /status":"succeeded/);

  const duplicateNameContext = fakeToolContext({
    apps: [
      appStatus("notes-web-a", "Notes", "frontend", "notes-a", "frontend"),
      appStatus("notes-web-b", "Notes", "frontend", "notes-b", "frontend")
    ],
    tuiContext: { daemonHasZeroApps: false, diagnostics: [] }
  });
  const ambiguousStart = await executeRelaybaseAgentTool(
    "start_app",
    { target: "Notes" },
    { ...duplicateNameContext, approved: true }
  );
  assert.equal(ambiguousStart.status, "clarification_needed");
  assert.equal(ambiguousStart.diagnostic?.code, "AGENT_TARGET_AMBIGUOUS");
  assert.equal(duplicateNameContext.calls.start, 0);
});

test("AGENT-FOLDER-START-005 setup repair matrix returns diagnostics without applying writes", async () => {
  const project = await runtimeProject("relaybase-folder-edge-repair-", {
    "package.json": JSON.stringify(
      { name: "repair-edge", scripts: { dev: "vite" }, devDependencies: { vite: "^6.0.0" } },
      null,
      2
    ),
    ".env": "VITE_PORT=5173\n"
  });
  const reasons = [
    "app ignored PORT and backend port is not open",
    "health route returned 404 not found",
    "EADDRINUSE fixed port conflict",
    "cannot find package vite missing dependency",
    "command exits immediately with code 1"
  ];

  for (const reason of reasons) {
    const repair = await repairSetup({ cwd: project, reason });
    const serialized = JSON.stringify(repair);
    assert.ok(repair.plan.choices.length, reason);
    assert.match(
      serialized,
      /framework_port_flags|generated_launch_wrapper|fixed_upstream_port|managed_dynamic_port/,
      reason
    );
    assert.equal(await exists(path.join(project, ".relaybase", "setup-profile.json")), false, reason);
  }
});

test("AGENT-FOLDER-START-005 setup path traversal and manifest patch previews remain blocked", async () => {
  const project = await runtimeProject("relaybase-folder-edge-path-safety-", {
    "relaybase.app.json": JSON.stringify(
      {
        schemaVersion: 1,
        id: "path-safety",
        name: "Path Safety",
        command: "npm.cmd run dev",
        cwd: ".",
        protocol: "http"
      },
      null,
      2
    )
  });
  await assert.rejects(
    previewManifestPatch({
      cwd: project,
      manifestPath: path.join(project, "..", "outside.app.json"),
      patch: { healthUrl: "/health" }
    }),
    (error: unknown) => error instanceof SetupApiRequestError && error.code === "SETUP_PATH_OUTSIDE_PROJECT"
  );
});

test("AGENT-FOLDER-START-005 folder-start session and audit summaries persist redacted after reload", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-folder-edge-session-"));
  const sessionStore = new AgentSessionStore({ stateDir });
  const auditStore = new AgentAuditStore({ stateDir });
  const session = sessionStore.create(
    { title: "start folder token=folder-title-secret" },
    {
      currentCwd: "C:\\Temp\\Folder App",
      daemonHasZeroApps: true,
      diagnostics: []
    }
  );
  const run = sessionStore.appendRun(session.id, {
    id: "run-folder-start",
    sessionId: session.id,
    status: "running",
    provider: "openrouter",
    modelSlug: "google/gemini-3.1-flash-lite",
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    events: []
  });
  sessionStore.appendRunEvent(session.id, run?.id, {
    id: "event-folder-start",
    sequence: 1,
    sessionId: session.id,
    runId: run?.id,
    type: "action_result",
    at: new Date().toISOString(),
    data: {
      toolName: "setup_and_start_project",
      result: {
        data: {
          phase: "started",
          route: "http://folder.localhost:7777",
          logs: ["OPENROUTER_API_KEY=sk-or-folder-session-secret", "token=folder-log-secret"]
        }
      }
    }
  });
  auditStore.append({
    type: "agent.folder_start.edge",
    sessionId: session.id,
    runId: run?.id,
    provider: "openrouter",
    modelSlug: "google/gemini-3.1-flash-lite",
    data: {
      tool: "setup_and_start_project",
      cwd: "C:\\Temp\\Folder App",
      log: "Authorization: Bearer folder-audit-secret"
    }
  });

  const reloadedSession = new AgentSessionStore({ stateDir }).get(session.id);
  const reloadedAudit = new AgentAuditStore({ stateDir }).list({ sessionId: session.id });
  const serialized = JSON.stringify({ reloadedSession, reloadedAudit });
  assert.match(serialized, /setup_and_start_project|folder\.localhost/);
  assert.doesNotMatch(
    serialized,
    /folder-title-secret|sk-or-folder-session-secret|folder-log-secret|folder-audit-secret/
  );
});

async function runtimeProject(prefix: string, files: Record<string, string>, projectName?: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const project = projectName ? path.join(root, projectName) : root;
  await fs.mkdir(project, { recursive: true });
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(project, relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  }
  return project;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeManifest(
  manifestPath: string,
  input: {
    id: string;
    name: string;
    cwd: string;
    healthUrl?: string;
    upstreamPort?: number;
    relaybase?: Record<string, unknown>;
  }
): Promise<void> {
  await fs.writeFile(
    manifestPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        id: input.id,
        name: input.name,
        command: "npm.cmd run dev",
        protocol: "http",
        cwd: input.cwd,
        ...(input.healthUrl ? { healthUrl: input.healthUrl } : {}),
        ...(input.upstreamPort ? { upstreamPort: input.upstreamPort } : {}),
        ...(input.relaybase ? { relaybase: input.relaybase } : {})
      },
      null,
      2
    ),
    "utf8"
  );
}

interface FakeToolContext extends AgentToolExecutionContext {
  calls: {
    start: number;
    stop: number;
    restart: number;
    export: number;
    register: number;
  };
}

function fakeToolContext(
  options: {
    apps?: AppStatusView[];
    logs?: Array<Record<string, unknown>>;
    diagnostics?: Array<Record<string, unknown>>;
    tuiContext?: TuiAgentContext;
    emit?: AgentToolExecutionContext["emit"];
    startRuntime?: RuntimeView;
  } = {}
): FakeToolContext {
  const apps = options.apps ?? [];
  const logs = options.logs ?? [];
  const calls = { start: 0, stop: 0, restart: 0, export: 0, register: 0 };
  const runtime: RelaybaseRuntime = {
    host: "127.0.0.1",
    port: 38383,
    stateDir: path.join(os.tmpdir(), "relaybase-folder-start-edge-runtime"),
    token: "relaybase-folder-edge-token-secret",
    registry: {
      list: async () => apps.map(stripRuntime),
      get: async (id: string) => stripRuntime(apps.find((app) => app.id === id)),
      upsertManifest: async (manifest: AppRecord) => {
        calls.register += 1;
        const record = {
          ...manifest,
          env: manifest.env ?? {},
          createdAt: manifest.createdAt ?? new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        const existing = apps.find((app) => app.id === record.id);
        if (existing) {
          Object.assign(existing, record);
        } else {
          apps.push({ ...record, runtime: stoppedRuntime() });
        }
        return record;
      }
    } as RelaybaseRuntime["registry"],
    processes: {
      listStatuses: async () => apps,
      logs: async (id: string) =>
        logs.filter((log) => log.appId === id).map((log) => redactText(String(log.message ?? ""))),
      start: async (id: string) => {
        calls.start += 1;
        return setRuntime(apps, id, options.startRuntime ?? runningRuntime());
      },
      stop: async (id: string) => {
        calls.stop += 1;
        return setRuntime(apps, id, stoppedRuntime());
      },
      restart: async (id: string) => {
        calls.restart += 1;
        return setRuntime(apps, id, options.startRuntime ?? runningRuntime());
      }
    } as unknown as RelaybaseRuntime["processes"],
    logStore: {
      query: async () => ({
        events: logs.map((event, index) => ({
          sequence: Number(event.sequence ?? index + 1),
          timestamp: String(event.timestamp ?? new Date().toISOString()),
          appId: String(event.appId ?? "app"),
          stream: event.stream === "stderr" ? "stderr" : "stdout",
          message: redactText(String(event.message ?? "")),
          redacted: true
        })),
        page: { limit: logs.length, hasMoreBefore: false, hasMoreAfter: false },
        diagnostics: []
      })
    } as RelaybaseRuntime["logStore"],
    exports: {
      create: async () => {
        calls.export += 1;
        return {
          exportId: "exp_folder_edge",
          status: "succeeded",
          format: "zip",
          outputPath: path.join(os.tmpdir(), "relaybase-folder-edge-export.zip"),
          includedApps: [],
          includedGroups: [],
          includedComponents: [],
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          sizeBytes: 0,
          redactionReport: { totalReplacements: 0, patterns: {}, fields: {} }
        };
      }
    } as RelaybaseRuntime["exports"],
    agentGateway: {
      diagnostics: async () => options.diagnostics ?? []
    } as unknown as RelaybaseRuntime["agentGateway"],
    operations: new OperationStore(),
    events: {
      publish: () => undefined,
      subscribe: () => () => undefined
    } as unknown as RelaybaseRuntime["events"],
    mcp: {} as RelaybaseRuntime["mcp"]
  };

  return {
    runtime,
    tuiContext: options.tuiContext ?? {
      daemonHasZeroApps: apps.length === 0,
      diagnostics: options.diagnostics ?? []
    },
    projectRootGrants: options.tuiContext?.authorizedProjectRoots?.map((root, index) => ({
      grantId: `edge_fixture_${index}`,
      canonicalRoot: realpathSync.native(path.resolve(root)),
      source: "user_selected_folder" as const
    })),
    emit: options.emit,
    calls
  };
}

function appStatus(
  id: string,
  name: string,
  paneLabel: string,
  groupId: string,
  componentRole: "frontend" | "backend" | "worker" | "database" | "service" | "other",
  runtime: RuntimeView = stoppedRuntime()
): AppStatusView {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id,
    name,
    command: "npm.cmd run dev",
    cwd: "C:\\project",
    protocol: "http",
    healthUrl: "/",
    env: {},
    relaybase: {
      groupId,
      componentRole,
      displayName: name,
      paneLabel,
      paneOrder: componentRole === "frontend" ? 10 : 20
    },
    createdAt: now,
    updatedAt: now,
    runtime
  };
}

function runningRuntime(): RuntimeView {
  return {
    status: "running",
    health: "healthy",
    phase: "running",
    assignedPort: 45678,
    pid: 1234,
    logLines: 1
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

function setRuntime(apps: AppStatusView[], id: string, runtime: RuntimeView): RuntimeView {
  const app = apps.find((entry) => entry.id === id);
  if (app) {
    app.runtime = runtime;
  }
  return runtime;
}

function stripRuntime(app: AppStatusView | undefined): AppRecord | undefined {
  if (!app) {
    return undefined;
  }
  const { runtime: _runtime, ...record } = app;
  return record;
}

function redactText(value: string): string {
  return value
    .replace(/OPENROUTER_API_KEY=[^\s]+/gi, "OPENROUTER_API_KEY=[redacted]")
    .replace(/token=[^\s]+/gi, "token=[redacted]")
    .replace(/Authorization:\s*Bearer\s+[^\s]+/gi, "Authorization: Bearer [redacted]");
}
