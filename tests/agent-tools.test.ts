import assert from "node:assert/strict";
import { promises as fs, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { z } from "zod";
import { OperationStore } from "../src/operationStore.ts";
import type { RelaybaseRuntime } from "../src/server.ts";
import type { AgentToolExecutionContext } from "../src/agent/tools/index.ts";
import {
  executeRelaybaseAgentTool,
  relaybaseAgentMutatingToolNames,
  relaybaseAgentReadOnlyToolNames,
  relaybaseAgentToolDefinitions,
  relaybaseAgentToolNames
} from "../src/agent/tools/index.ts";
import type { LogExportResult } from "../src/apiTypes.ts";
import type { AppRecord, AppStatusView, RuntimeView } from "../src/types.ts";
import {
  groupedFrontendBackendFixture,
  sampleExistingManifest,
  sampleLogs,
  samplePackageJsonFixtures
} from "./fixtures/agent-non-live.ts";

test("RA007 registry exposes read and gated mutation tools", () => {
  const names = relaybaseAgentToolNames();

  assert.deepEqual(names, [
    "list_apps",
    "get_app_state",
    "get_app_group",
    "get_diagnostics",
    "tail_logs",
    "search_logs",
    "project_list_files",
    "project_search_files",
    "project_read_file",
    "project_detect_start_commands",
    "project_inspect_package_scripts",
    "start_app",
    "stop_app",
    "restart_app",
    "export_logs",
    "detect_project",
    "plan_app_setup",
    "preview_setup_writes",
    "apply_setup_plan",
    "register_manifest",
    "inspect_manifest",
    "validate_manifest",
    "patch_manifest_fields",
    "set_health_route",
    "set_pinned_port",
    "set_component_metadata",
    "add_env_override_safe",
    "open_project_or_app",
    "setup_and_start_project",
    "prove_app_health",
    "repair_app_setup",
    "propose_tui_action"
  ]);

  assert.deepEqual(relaybaseAgentReadOnlyToolNames(), [
    "list_apps",
    "get_app_state",
    "get_app_group",
    "get_diagnostics",
    "tail_logs",
    "search_logs",
    "project_list_files",
    "project_search_files",
    "project_read_file",
    "project_detect_start_commands",
    "project_inspect_package_scripts",
    "detect_project",
    "plan_app_setup",
    "preview_setup_writes",
    "inspect_manifest",
    "validate_manifest",
    "repair_app_setup",
    "propose_tui_action"
  ]);
  assert.deepEqual(relaybaseAgentMutatingToolNames(), [
    "start_app",
    "stop_app",
    "restart_app",
    "export_logs",
    "apply_setup_plan",
    "register_manifest",
    "patch_manifest_fields",
    "set_health_route",
    "set_pinned_port",
    "set_component_metadata",
    "add_env_override_safe",
    "open_project_or_app",
    "setup_and_start_project",
    "prove_app_health"
  ]);
  assert.equal(
    relaybaseAgentToolDefinitions().every((definition) =>
      relaybaseAgentMutatingToolNames().includes(definition.name) ? definition.approvalRequired : true
    ),
    true
  );
});

test("Agent tool schemas stay inside the OpenAI function-calling JSON Schema subset", () => {
  const unsupportedKeywords = new Set(["propertyNames", "patternProperties", "unevaluatedProperties", "prefixItems"]);
  const failures: string[] = [];

  const visit = (value: unknown, path: string): void => {
    if (!value || typeof value !== "object") {
      return;
    }
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (unsupportedKeywords.has(key)) {
        failures.push(`${path}/${key}`);
      }
      visit(nested, `${path}/${key}`);
    }
  };

  for (const definition of relaybaseAgentToolDefinitions()) {
    visit(z.toJSONSchema(definition.parameters), definition.name);
  }

  assert.deepEqual(failures, []);
});

test("AGENT-TUI-MATRIX-004 read-only tool matrix runs without approval or daemon mutation", async () => {
  const project = await runtimeProject("relaybase-agent-readonly-matrix-", {
    "package.json": JSON.stringify({ scripts: { dev: "vite --host 127.0.0.1" }, dependencies: { vite: "latest" } })
  });
  const manifestPath = path.join(project, "relaybase.app.json");
  await writeManifest(manifestPath, {
    id: "notes-web",
    name: "Notes Web",
    cwd: project,
    healthUrl: "/healthz",
    relaybase: { groupId: "notes", componentRole: "frontend", paneLabel: "frontend" }
  });
  const notesWeb = appStatus("notes-web", "Notes", "frontend", "notes", "frontend", runningRuntime());
  notesWeb.manifestPath = manifestPath;
  const context = fakeToolContext({
    apps: [notesWeb, appStatus("notes-api", "Notes", "backend", "notes", "backend", stoppedRuntime())],
    diagnostics: [{ code: "TEST_DIAGNOSTIC", severity: "warning", message: "fixture diagnostic" }],
    logs: [
      {
        sequence: 1,
        timestamp: new Date().toISOString(),
        appId: "notes-web",
        groupId: "notes",
        componentRole: "frontend",
        stream: "stdout",
        message: "ready with Authorization: Bearer readonly-secret-token",
        redacted: false
      }
    ],
    tuiContext: {
      selectedPaneId: "notes:notes-web:frontend:frontend",
      selectedAppId: "notes-web",
      selectedGroupId: "notes",
      selectedComponentRole: "frontend",
      currentRoute: "http://notes.localhost:38383",
      currentCwd: project,
      daemonHasZeroApps: false,
      diagnostics: [],
      terminalCapabilities: { clipboard: "unavailable", browserOpen: "unavailable" }
    }
  });
  const cases: Array<{ name: string; input: Record<string, unknown> }> = [
    { name: "list_apps", input: {} },
    { name: "get_app_state", input: { appId: "notes-web" } },
    { name: "get_app_group", input: { groupId: "notes" } },
    { name: "get_diagnostics", input: { includeLogStore: true } },
    { name: "tail_logs", input: { appId: "notes-web", limit: 10 } },
    { name: "search_logs", input: { appId: "notes-web", query: "ready", limit: 10 } },
    { name: "project_list_files", input: { projectRoot: project } },
    { name: "project_search_files", input: { projectRoot: project, query: "vite", maxResults: 10 } },
    { name: "project_read_file", input: { projectRoot: project, path: "package.json" } },
    { name: "project_detect_start_commands", input: { projectRoot: project } },
    { name: "project_inspect_package_scripts", input: { projectRoot: project } },
    { name: "detect_project", input: { cwd: project } },
    { name: "plan_app_setup", input: { cwd: project } },
    { name: "preview_setup_writes", input: { cwd: project, commandHint: "npm.cmd run dev" } },
    { name: "inspect_manifest", input: { manifestPath, cwd: project } },
    { name: "validate_manifest", input: { manifestPath, cwd: project } },
    { name: "repair_app_setup", input: { cwd: project, reason: "ignored PORT" } },
    { name: "propose_tui_action", input: { kind: "show_route" } }
  ];

  assert.deepEqual(
    cases.map((entry) => entry.name),
    relaybaseAgentReadOnlyToolNames()
  );

  for (const entry of cases) {
    const beforeCalls = { ...context.calls };
    const result = await executeRelaybaseAgentTool(entry.name, entry.input, context);
    assert.notEqual(result.status, "approval_required", entry.name);
    assert.notEqual(result.status, "failed", entry.name);
    assert.deepEqual(context.calls, beforeCalls, entry.name);
    assert.doesNotMatch(JSON.stringify(result), /readonly-secret-token|Bearer readonly-secret-token/, entry.name);
  }
});

test("agent-managed project inspection tools are scoped, bounded, and redacted", async () => {
  const project = await runtimeProject("relaybase-agent-project-inspect-", {
    "package.json": JSON.stringify({
      scripts: {
        dev: "vite --host 127.0.0.1",
        leak: "node server.js --token=package-secret"
      },
      dependencies: { vite: "latest" }
    }),
    "src/server.ts": "console.log('ready');\nconst token = 'server-secret-token';\n",
    "src/config.txt":
      "DATABASE_URL=postgres://relay:database-password@localhost/relaybase\n" +
      'PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nprivate-key-material\n-----END PRIVATE KEY-----"\n',
    "src/settings.json": JSON.stringify({ apiKey: "rk_custom_unrecognized", clientSecret: "custom-json-secret" }),
    "src/settings.yaml": "privateKey: custom-yaml-private\naccessKey: custom-yaml-access\n",
    "src/settings.toml": 'databaseUrl = "custom-toml-uri"\nsessionToken = "custom-toml-session"\n',
    ".env": "OPENROUTER_API_KEY=sk-project-secret\n",
    "node_modules/ignored/index.js": "console.log('ignored');"
  });
  const outside = path.join(os.tmpdir(), `relaybase-outside-${Date.now()}.txt`);
  await fs.writeFile(outside, "outside", "utf8");
  const context = fakeToolContext({ tuiContext: { currentCwd: project, daemonHasZeroApps: true, diagnostics: [] } });

  const listed = await executeRelaybaseAgentTool("project_list_files", { projectRoot: project }, context);
  const listedJson = JSON.stringify(listed);
  assert.equal(listed.status, "succeeded");
  assert.match(listedJson, /package\.json/);
  assert.doesNotMatch(listedJson, /node_modules\/ignored/);
  assert.doesNotMatch(listedJson, /\.env/);
  assert.match(listedJson, /"environment":1/);

  const searched = await executeRelaybaseAgentTool(
    "project_search_files",
    { projectRoot: project, query: "secret", maxResults: 10 },
    context
  );
  const searchedJson = JSON.stringify(searched);
  assert.equal(searched.status, "succeeded");
  assert.doesNotMatch(searchedJson, /server-secret-token|sk-project-secret|package-secret/);
  assert.match(searchedJson, /\[redacted\]/);

  const read = await executeRelaybaseAgentTool(
    "project_read_file",
    { projectRoot: project, path: "src/server.ts" },
    context
  );
  assert.equal(read.status, "succeeded");
  assert.doesNotMatch(JSON.stringify(read), /server-secret-token/);

  const sensitiveRead = await executeRelaybaseAgentTool(
    "project_read_file",
    { projectRoot: project, path: ".env" },
    context
  );
  assert.equal(sensitiveRead.status, "diagnostic");
  assert.equal(sensitiveRead.diagnostic?.code, "PROJECT_SENSITIVE_FILE_DENIED");
  assert.deepEqual(sensitiveRead.diagnostic?.detail, { policy: "deny", category: "environment" });
  assert.doesNotMatch(JSON.stringify(sensitiveRead), /OPENROUTER_API_KEY|sk-project-secret|\.env/);

  const configRead = await executeRelaybaseAgentTool(
    "project_read_file",
    { projectRoot: project, path: "src/config.txt" },
    context
  );
  const configJson = JSON.stringify(configRead);
  assert.equal(configRead.status, "succeeded");
  assert.match(configJson, /\[redacted(?: private key)?\]/);
  assert.doesNotMatch(configJson, /database-password|private-key-material/);

  for (const [file, forbidden] of [
    ["src/settings.json", /rk_custom_unrecognized|custom-json-secret/],
    ["src/settings.yaml", /custom-yaml-private|custom-yaml-access/],
    ["src/settings.toml", /custom-toml-uri|custom-toml-session/]
  ] as const) {
    const structuredConfig = await executeRelaybaseAgentTool(
      "project_read_file",
      { projectRoot: project, path: file },
      context
    );
    assert.equal(structuredConfig.status, "succeeded", file);
    assert.match(JSON.stringify(structuredConfig), /\[redacted\]/, file);
    assert.doesNotMatch(JSON.stringify(structuredConfig), forbidden, file);
  }

  const traversal = await executeRelaybaseAgentTool(
    "project_read_file",
    { projectRoot: project, path: outside },
    context
  );
  assert.equal(traversal.status, "diagnostic");
  assert.equal(traversal.diagnostic?.code, "PROJECT_PATH_OUTSIDE_ROOT");

  const unauthorizedRoot = await executeRelaybaseAgentTool(
    "project_list_files",
    { projectRoot: path.dirname(outside) },
    context
  );
  assert.equal(unauthorizedRoot.status, "diagnostic");
  assert.equal(unauthorizedRoot.diagnostic?.code, "PROJECT_ROOT_NOT_GRANTED");

  const unauthorizedLegacyRead = await executeRelaybaseAgentTool(
    "detect_project",
    { cwd: path.dirname(outside) },
    context
  );
  assert.equal(unauthorizedLegacyRead.status, "diagnostic");
  assert.equal(unauthorizedLegacyRead.diagnostic?.code, "PROJECT_ROOT_NOT_GRANTED");

  const unauthorizedLegacyMutation = await executeRelaybaseAgentTool(
    "apply_setup_plan",
    { cwd: path.dirname(outside), commandHint: "npm.cmd run dev" },
    context
  );
  assert.equal(unauthorizedLegacyMutation.status, "diagnostic");
  assert.equal(unauthorizedLegacyMutation.diagnostic?.code, "PROJECT_ROOT_NOT_GRANTED");

  const missingGrant = await executeRelaybaseAgentTool(
    "project_list_files",
    { projectRoot: project },
    { ...context, projectRootGrants: undefined }
  );
  assert.equal(missingGrant.status, "diagnostic");
  assert.equal(missingGrant.diagnostic?.code, "PROJECT_ROOT_NOT_GRANTED");

  const unsafeRegex = await executeRelaybaseAgentTool(
    "project_search_files",
    { projectRoot: project, query: "(a+)+$", regex: true },
    context
  );
  assert.equal(unsafeRegex.status, "diagnostic");
  assert.equal(unsafeRegex.diagnostic?.code, "PROJECT_SEARCH_REGEX_UNSAFE");

  const scripts = await executeRelaybaseAgentTool("project_inspect_package_scripts", { projectRoot: project }, context);
  assert.equal(scripts.status, "succeeded");
  assert.doesNotMatch(JSON.stringify(scripts), /package-secret/);

  const commands = await executeRelaybaseAgentTool("project_detect_start_commands", { projectRoot: project }, context);
  assert.equal(commands.status, "succeeded");
  assert.match(JSON.stringify(commands), /vite|dev/);
});

test("project search enforces aggregate byte budgets on large input", async () => {
  const files = Object.fromEntries(
    Array.from({ length: 20 }, (_, index) => [`src/large-${String(index).padStart(2, "0")}.txt`, "a".repeat(65_536)])
  );
  const project = await runtimeProject("relaybase-agent-project-budget-", files);
  const context = fakeToolContext({
    tuiContext: { currentCwd: project, daemonHasZeroApps: true, diagnostics: [] }
  });

  const result = await executeRelaybaseAgentTool(
    "project_search_files",
    { projectRoot: project, query: "not-present", maxFiles: 100 },
    context
  );
  assert.equal(result.status, "succeeded");
  const data = result.data as {
    truncated: boolean;
    limits: { maxAggregateBytes: number; readBytes: number; stopReason?: string; scannedFiles: number };
  };
  assert.equal(data.truncated, true);
  assert.equal(data.limits.stopReason, "aggregate_bytes");
  assert.equal(data.limits.readBytes <= data.limits.maxAggregateBytes, true);
  assert.equal(data.limits.scannedFiles < 20, true);
});

test("AGENT-TUI-MATRIX-004 mutating tool matrix requires approval before any daemon-owned mutation", async () => {
  const project = await runtimeProject("relaybase-agent-mutation-matrix-", {
    "package.json": JSON.stringify({ scripts: { dev: "vite --host 127.0.0.1" }, dependencies: { vite: "latest" } })
  });
  const manifestPath = path.join(project, "relaybase.app.json");
  await writeManifest(manifestPath, {
    id: "notes-web",
    name: "Notes Web",
    cwd: project,
    healthUrl: "/",
    upstreamPort: 3000,
    relaybase: { groupId: "notes", componentRole: "frontend", paneLabel: "frontend" }
  });
  const notesWeb = appStatus("notes-web", "Notes", "frontend", "notes", "frontend", stoppedRuntime());
  notesWeb.manifestPath = manifestPath;
  const context = fakeToolContext({
    apps: [notesWeb],
    tuiContext: {
      selectedPaneId: "notes:notes-web:frontend:frontend",
      selectedAppId: "notes-web",
      selectedGroupId: "notes",
      selectedComponentRole: "frontend",
      currentCwd: project,
      daemonHasZeroApps: false,
      diagnostics: []
    }
  });
  const beforeManifest = await fs.readFile(manifestPath, "utf8");
  const cases = mutatingToolCases(project, manifestPath);

  assert.deepEqual(
    cases.map((entry) => entry.name),
    relaybaseAgentMutatingToolNames()
  );

  for (const entry of cases) {
    const beforeCalls = { ...context.calls };
    const result = await executeRelaybaseAgentTool(entry.name, entry.input, context);
    assert.equal(result.status, "approval_required", entry.name);
    assert.equal(result.approval?.required, true, entry.name);
    assert.deepEqual(context.calls, beforeCalls, entry.name);
    assert.equal(await fs.readFile(manifestPath, "utf8"), beforeManifest, entry.name);
    assert.doesNotMatch(JSON.stringify(result), /relaybase-test-token-secret|sk-or-|Bearer /, entry.name);
  }
});

test("AGENT-TUI-MATRIX-004 approved mutating tools execute through daemon/setup primitives", async () => {
  const project = await runtimeProject("relaybase-agent-approved-matrix-", {
    "package.json": JSON.stringify({ scripts: { dev: "vite --host 127.0.0.1" }, dependencies: { vite: "latest" } })
  });
  const manifestPath = path.join(project, "relaybase.app.json");
  await writeManifest(manifestPath, {
    id: "notes-web",
    name: "Notes Web",
    cwd: project,
    healthUrl: "/",
    relaybase: { groupId: "notes", componentRole: "frontend", paneLabel: "frontend" }
  });
  const notesWeb = appStatus("notes-web", "Notes", "frontend", "notes", "frontend", stoppedRuntime());
  notesWeb.manifestPath = manifestPath;
  const context = fakeToolContext({
    apps: [notesWeb],
    tuiContext: {
      selectedPaneId: "notes:notes-web:frontend:frontend",
      selectedAppId: "notes-web",
      selectedGroupId: "notes",
      selectedComponentRole: "frontend",
      currentCwd: project,
      daemonHasZeroApps: false,
      diagnostics: []
    }
  });

  const directCases = mutatingToolCases(project, manifestPath);
  for (const entry of directCases) {
    const previewed = await executeRelaybaseAgentTool(entry.name, entry.input, context);
    assert.equal(previewed.status, "approval_required", entry.name);
    const approvedInput = previewed.approval?.arguments as Record<string, unknown>;
    const result = await executeRelaybaseAgentTool(entry.name, approvedInput, { ...context, approved: true });
    assert.notEqual(result.status, "approval_required", entry.name);
    assert.doesNotMatch(JSON.stringify(result), /relaybase-test-token-secret|sk-or-|Bearer /, entry.name);
    if (result.operationId) {
      await waitForOperationDone(context, String(result.operationId));
    }
  }
  await waitFor(() => context.calls.start >= 1);
  await waitFor(() => context.calls.stop >= 1);
  await waitFor(() => context.calls.restart >= 1);
  assert.equal(context.calls.start >= 1, true);
  assert.equal(context.calls.stop >= 1, true);
  assert.equal(context.calls.restart >= 1, true);
  assert.equal(context.calls.export >= 1, true);
  assert.equal(context.calls.register >= 2, true);

  const openApp = appStatus("notes-web", "Notes", "frontend", "notes", "frontend", stoppedRuntime());
  openApp.manifestPath = manifestPath;
  const openContext = fakeToolContext({
    apps: [openApp],
    tuiContext: {
      selectedAppId: "notes-web",
      currentCwd: project,
      daemonHasZeroApps: false,
      diagnostics: []
    }
  });
  const opened = await executeRelaybaseAgentTool(
    "open_project_or_app",
    { appId: "notes-web", noBrowser: true },
    { ...openContext, approved: true }
  );
  assert.equal(opened.status, "succeeded");
  await waitFor(() => openContext.calls.start === 1);

  const updated = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
    healthUrl?: string;
    upstreamPort?: number;
    env?: Record<string, string>;
    relaybase?: { groupId?: string; componentRole?: string; paneLabel?: string };
  };
  assert.equal(updated.healthUrl, "/readyz");
  assert.equal(updated.upstreamPort, 43210);
  assert.equal(updated.env?.API_KEY, "env:API_KEY");
  assert.equal(updated.relaybase?.groupId, "notes");
  assert.equal(updated.relaybase?.componentRole, "frontend");
  assert.equal(updated.relaybase?.paneLabel, "web");
});

test("read tools return daemon state, grouped components, diagnostics, and redacted log pages", async () => {
  const context = fakeToolContext({
    apps: [
      appStatus("notes-web", "Notes", "frontend", "notes", "frontend", runningRuntime()),
      appStatus("notes-api", "Notes", "backend", "notes", "backend", stoppedRuntime())
    ],
    diagnostics: [{ code: "TEST_DIAGNOSTIC", severity: "warning", message: "fixture diagnostic" }],
    logs: [
      {
        sequence: 1,
        timestamp: new Date().toISOString(),
        appId: "notes-api",
        groupId: "notes",
        componentRole: "backend",
        stream: "stdout",
        message: "started with token=super-secret",
        redacted: false
      }
    ]
  });

  const list = await executeRelaybaseAgentTool("list_apps", {}, context);
  assert.equal(list.status, "succeeded");
  assert.equal((list.data as { apps: unknown[] }).apps.length, 2);
  assert.equal((list.data as { groups: unknown[] }).groups.length, 1);

  const group = await executeRelaybaseAgentTool("get_app_group", { groupId: "notes" }, context);
  assert.equal(group.status, "succeeded");
  assert.equal((group.data as { group: { components: unknown[] } }).group.components.length, 2);

  const diagnostics = await executeRelaybaseAgentTool("get_diagnostics", {}, context);
  assert.equal(diagnostics.status, "succeeded");
  assert.match(JSON.stringify(diagnostics.data), /TEST_DIAGNOSTIC/);

  const logs = await executeRelaybaseAgentTool("tail_logs", { appId: "notes-api", limit: 10 }, context);
  assert.equal(logs.status, "succeeded");
  assert.equal((logs.data as { events: Array<{ redacted: boolean }> }).events[0]?.redacted, true);
  assert.doesNotMatch(JSON.stringify(logs), /super-secret/);

  const search = await executeRelaybaseAgentTool("search_logs", { query: "started", appId: "notes-api" }, context);
  assert.equal(search.status, "succeeded");
  assert.equal((search.data as { events: unknown[] }).events.length, 1);
});

test("target resolution asks clarification for ambiguous app names", async () => {
  const context = fakeToolContext({
    apps: [
      appStatus("api-one", "API", "frontend", "one", "frontend", stoppedRuntime()),
      appStatus("api-two", "API", "backend", "two", "backend", stoppedRuntime())
    ]
  });

  const result = await executeRelaybaseAgentTool("get_app_state", { target: "API" }, context);

  assert.equal(result.status, "clarification_needed");
  assert.equal(result.diagnostic?.code, "AGENT_TARGET_AMBIGUOUS");
});

test("RA012 non-live tool fixtures resolve app, group, role, selected context, cwd, manifest path, logs, and unknown targets", async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-agent-ra012-"));
  const manifestPath = path.join(project, "relaybase.app.json");
  await fs.writeFile(path.join(project, "package.json"), JSON.stringify(samplePackageJsonFixtures.next), "utf8");
  await fs.writeFile(
    manifestPath,
    JSON.stringify({ ...sampleExistingManifest, cwd: project, manifestPath }, null, 2),
    "utf8"
  );

  const apps = [
    appStatus(
      groupedFrontendBackendFixture.frontend.appId,
      groupedFrontendBackendFixture.frontend.name,
      groupedFrontendBackendFixture.frontend.paneLabel,
      groupedFrontendBackendFixture.groupId,
      groupedFrontendBackendFixture.frontend.role,
      runningRuntime()
    ),
    appStatus(
      groupedFrontendBackendFixture.backend.appId,
      groupedFrontendBackendFixture.backend.name,
      groupedFrontendBackendFixture.backend.paneLabel,
      groupedFrontendBackendFixture.groupId,
      groupedFrontendBackendFixture.backend.role,
      stoppedRuntime()
    ),
    appStatus("shop-api", "Shop API", "backend", "shop", "backend", stoppedRuntime())
  ];
  for (const app of apps.filter((entry) => entry.relaybase?.groupId === groupedFrontendBackendFixture.groupId)) {
    app.relaybase = { ...app.relaybase, displayName: groupedFrontendBackendFixture.displayName };
  }
  const context = fakeToolContext({
    apps,
    logs: [...sampleLogs],
    tuiContext: {
      selectedPaneId: "notes:notes-api:backend:backend",
      selectedAppId: groupedFrontendBackendFixture.backend.appId,
      selectedGroupId: groupedFrontendBackendFixture.groupId,
      selectedComponentRole: groupedFrontendBackendFixture.backend.role,
      currentRoute: "http://notes.localhost:38383",
      currentPage: 0,
      currentCwd: project,
      daemonHasZeroApps: false,
      diagnostics: [],
      terminalCapabilities: { clipboard: "unavailable", browserOpen: "unavailable" }
    }
  });

  const exactApp = await executeRelaybaseAgentTool(
    "get_app_state",
    { appId: groupedFrontendBackendFixture.frontend.appId },
    context
  );
  assert.equal(exactApp.status, "succeeded");
  assert.equal((exactApp.data as { app: { id: string } }).app.id, groupedFrontendBackendFixture.frontend.appId);

  const displayName = await executeRelaybaseAgentTool(
    "get_app_state",
    { appName: groupedFrontendBackendFixture.backend.name },
    context
  );
  assert.equal(displayName.status, "succeeded");
  assert.equal((displayName.data as { app: { id: string } }).app.id, groupedFrontendBackendFixture.backend.appId);

  const group = await executeRelaybaseAgentTool(
    "get_app_group",
    { groupName: groupedFrontendBackendFixture.displayName },
    context
  );
  assert.equal(group.status, "succeeded");
  assert.equal((group.data as { group: { groupId: string } }).group.groupId, groupedFrontendBackendFixture.groupId);

  const roleInGroup = await executeRelaybaseAgentTool(
    "get_app_state",
    { groupId: groupedFrontendBackendFixture.groupId, componentRole: groupedFrontendBackendFixture.backend.role },
    context
  );
  assert.equal(roleInGroup.status, "succeeded");
  assert.equal((roleInGroup.data as { app: { id: string } }).app.id, groupedFrontendBackendFixture.backend.appId);

  const selectedPane = await executeRelaybaseAgentTool("get_app_state", {}, context);
  assert.equal(selectedPane.status, "succeeded");
  assert.equal((selectedPane.data as { app: { id: string } }).app.id, groupedFrontendBackendFixture.backend.appId);

  const setupPlan = await executeRelaybaseAgentTool("plan_app_setup", {}, context);
  assert.equal(setupPlan.status, "succeeded");
  assert.equal((setupPlan.data as { cwd?: string }).cwd, project);

  const manifest = await executeRelaybaseAgentTool("inspect_manifest", { cwd: project, manifestPath }, context);
  assert.equal(manifest.status, "succeeded");
  assert.match(JSON.stringify(manifest.data), /notes-api/);

  const logs = await executeRelaybaseAgentTool(
    "tail_logs",
    { appId: groupedFrontendBackendFixture.frontend.appId, limit: 10 },
    context
  );
  assert.equal(logs.status, "succeeded");
  assert.doesNotMatch(JSON.stringify(logs), /fixture-secret/);
  assert.match(JSON.stringify(logs), /token=\[redacted\]/);

  const unknown = await executeRelaybaseAgentTool("get_app_state", { target: "missing-app" }, context);
  assert.equal(unknown.status, "diagnostic");
  assert.equal(unknown.diagnostic?.code, "AGENT_TARGET_NOT_FOUND");
});

test("lifecycle tools require approval before daemon operation enqueue and route through process manager after approval", async () => {
  const context = fakeToolContext({ apps: [appStatus("notes-web", "Notes", "frontend", "notes", "frontend")] });

  const blocked = await executeRelaybaseAgentTool("start_app", { appId: "notes-web" }, context);
  assert.equal(blocked.status, "approval_required");
  assert.equal(context.calls.start, 0);
  assert.equal(context.runtime.operations.get(String(blocked.operationId ?? "")), undefined);

  const approved = await executeRelaybaseAgentTool("start_app", { appId: "notes-web" }, { ...context, approved: true });
  assert.equal(approved.status, "succeeded");
  assert.match(String(approved.operationId), /^op_/);
  await waitFor(() => context.calls.start === 1);

  const operation = context.runtime.operations.get(String(approved.operationId));
  assert.equal(operation?.operationType, "start");
  await waitFor(() => context.runtime.operations.get(String(approved.operationId))?.status === "succeeded");
});

test("log export tool requires approval and calls daemon export service only after approval", async () => {
  const context = fakeToolContext({ apps: [appStatus("notes-api", "Notes", "backend", "notes", "backend")] });

  const blocked = await executeRelaybaseAgentTool("export_logs", { scope: "app", appId: "notes-api" }, context);
  assert.equal(blocked.status, "approval_required");
  assert.equal(context.calls.export, 0);

  const approved = await executeRelaybaseAgentTool(
    "export_logs",
    { scope: "app", appId: "notes-api", format: "jsonl" },
    { ...context, approved: true }
  );
  assert.equal(approved.status, "succeeded");
  assert.equal(context.calls.export, 1);
  assert.equal((approved.data as { export: LogExportResult }).export.redactionReport.totalReplacements, 1);
});

test("setup tools preview file writes and require approval before applying or patching manifests", async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-agent-tools-"));
  const manifestPath = path.join(project, "relaybase.app.json");
  await fs.writeFile(
    path.join(project, "package.json"),
    JSON.stringify({ scripts: { dev: "vite --host 127.0.0.1" }, dependencies: { vite: "latest" } }),
    "utf8"
  );
  await fs.writeFile(
    manifestPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        id: "notes-web",
        name: "Notes",
        command: "npm.cmd run dev",
        protocol: "http",
        cwd: project
      },
      null,
      2
    ),
    "utf8"
  );
  const notesApp = appStatus("notes-web", "Notes", "frontend", "notes", "frontend");
  notesApp.manifestPath = manifestPath;
  const context = fakeToolContext({
    apps: [notesApp],
    tuiContext: { currentCwd: project, daemonHasZeroApps: false, diagnostics: [] }
  });

  const detect = await executeRelaybaseAgentTool("detect_project", { cwd: project }, context);
  assert.equal(detect.status, "succeeded");

  const plan = await executeRelaybaseAgentTool("plan_app_setup", { cwd: project }, context);
  assert.equal(plan.status, "succeeded");

  const preview = await executeRelaybaseAgentTool(
    "preview_setup_writes",
    { cwd: project, command: "npm.cmd run dev" },
    context
  );
  assert.equal(preview.status, "succeeded");
  assert.match(JSON.stringify(preview.data), /relaybase\.app\.json/);

  const applyBlocked = await executeRelaybaseAgentTool("apply_setup_plan", { cwd: project }, context);
  assert.equal(applyBlocked.status, "approval_required");

  const patchBlocked = await executeRelaybaseAgentTool(
    "patch_manifest_fields",
    { manifestPath, cwd: project, patch: { healthUrl: "/healthz" } },
    context
  );
  assert.equal(patchBlocked.status, "approval_required");
  assert.match(JSON.stringify(patchBlocked.data), /healthz/);

  const healthBlocked = await executeRelaybaseAgentTool(
    "set_health_route",
    { manifestPath, cwd: project, healthUrl: "/healthz" },
    context
  );
  assert.equal(healthBlocked.status, "approval_required");
  const patchApproved = await executeRelaybaseAgentTool(
    "set_health_route",
    healthBlocked.approval?.arguments as Record<string, unknown>,
    { ...context, approved: true }
  );
  assert.equal(patchApproved.status, "succeeded");
  const updated = JSON.parse(await fs.readFile(manifestPath, "utf8")) as { healthUrl?: string };
  assert.equal(updated.healthUrl, "/healthz");

  const metadataInput = {
    appId: "notes-web",
    manifestPath: "relaybase.json",
    cwd: project,
    groupId: "notes",
    componentRole: "frontend",
    paneLabel: "frontend",
    paneOrder: 10
  };
  const metadataBlocked = await executeRelaybaseAgentTool("set_component_metadata", metadataInput, context);
  assert.equal(metadataBlocked.status, "approval_required");
  const metadataApproved = await executeRelaybaseAgentTool(
    "set_component_metadata",
    metadataBlocked.approval?.arguments as Record<string, unknown>,
    { ...context, approved: true }
  );
  assert.equal(metadataApproved.status, "succeeded");
  const metadataUpdated = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
    relaybase?: { groupId?: string; componentRole?: string; paneLabel?: string; paneOrder?: number };
  };
  assert.equal(metadataUpdated.relaybase?.groupId, "notes");
  assert.equal(metadataUpdated.relaybase?.componentRole, "frontend");
  assert.equal(metadataUpdated.relaybase?.paneLabel, "frontend");
  assert.equal(metadataUpdated.relaybase?.paneOrder, 10);
});

test("RA012C setup tools expose runtime matrix fields and accept runtime hints", async () => {
  const project = await runtimeProject("relaybase-agent-python-", {
    "pyproject.toml": '[project]\ndependencies = ["fastapi", "uvicorn"]\n',
    "main.py": "from fastapi import FastAPI\napp = FastAPI()\n"
  });
  const context = fakeToolContext({
    tuiContext: { currentCwd: project, daemonHasZeroApps: true, diagnostics: [] }
  });

  const detect = await executeRelaybaseAgentTool("detect_project", { cwd: project }, context);
  assert.equal(detect.status, "succeeded");
  assert.match(JSON.stringify(detect.data), /"runtime":"python"/);
  assert.match(JSON.stringify(detect.data), /"runtimeMatrix"/);

  const plan = await executeRelaybaseAgentTool(
    "plan_app_setup",
    {
      cwd: project,
      runtimePreference: "python",
      commandHint: "python -m uvicorn main:app --host HOST --port PORT",
      portStrategyHint: "explicit_host_port_flags"
    },
    context
  );
  assert.equal(plan.status, "succeeded");
  const planText = JSON.stringify(plan.data);
  assert.match(planText, /"runtimeId":"python"/);
  assert.match(planText, /runtimeStartCommandCandidates/);
  assert.match(planText, /runtimePortStrategies/);

  const preview = await executeRelaybaseAgentTool(
    "preview_setup_writes",
    {
      cwd: project,
      runtimePreference: "python",
      commandHint: "python -m uvicorn main:app --host HOST --port PORT",
      portStrategyHint: "explicit_host_port_flags"
    },
    context
  );
  assert.equal(preview.status, "succeeded");
  assert.match(JSON.stringify(preview.data), /runtimeStartCommandCandidates/);
});

test("AGENT-FOLDER-START-002 setup tools preserve selected command through approved apply", async () => {
  const project = await runtimeProject("relaybase-agent-selection-", {
    "package.json": JSON.stringify(
      {
        name: "agent-selection",
        scripts: {
          dev: "vite --host 127.0.0.1"
        },
        devDependencies: {
          vite: "^6.0.0"
        }
      },
      null,
      2
    )
  });
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-agent-selection-state-"));
  const context = fakeToolContext({
    tuiContext: { currentCwd: project, daemonHasZeroApps: true, diagnostics: [] }
  });
  context.runtime.stateDir = stateDir;
  const expectedCommand = process.platform === "win32" ? "npm.cmd run dev" : "npm run dev";
  const componentMetadata = {
    appId: "agent-selection-web",
    groupId: "agent-selection",
    componentRole: "frontend",
    paneLabel: "frontend",
    paneOrder: 10
  };

  const preview = await executeRelaybaseAgentTool(
    "preview_setup_writes",
    {
      cwd: project,
      commandHint: "npm run dev",
      selectedPlanId: "framework-port-flag",
      portStrategyHint: "generated_launch_wrapper",
      componentMetadata
    },
    context
  );
  assert.equal(preview.status, "succeeded");
  assert.match(JSON.stringify(preview.data), new RegExp(expectedCommand.replace(".", "\\.")));
  assert.equal(await exists(path.join(project, "relaybase.app.json")), false);

  const blocked = await executeRelaybaseAgentTool(
    "apply_setup_plan",
    {
      cwd: project,
      commandHint: "npm run dev",
      selectedPlanId: "framework-port-flag",
      portStrategyHint: "generated_launch_wrapper",
      componentMetadata
    },
    context
  );
  assert.equal(blocked.status, "approval_required");
  assert.equal(await exists(path.join(project, "relaybase.app.json")), false);

  const applied = await executeRelaybaseAgentTool(
    "apply_setup_plan",
    blocked.approval?.arguments as Record<string, unknown>,
    { ...context, approved: true }
  );
  assert.equal(applied.status, "succeeded");
  assert.match(JSON.stringify(applied.data), new RegExp(expectedCommand.replace(".", "\\.")));
  const manifest = JSON.parse(await fs.readFile(path.join(project, "relaybase.app.json"), "utf8"));
  assert.equal(manifest.command, "node .relaybase/launch.cjs");
  assert.equal(manifest.id, "agent-selection-web");
  assert.equal(manifest.relaybase.componentRole, "frontend");
  const profile = JSON.parse(await fs.readFile(path.join(project, ".relaybase", "setup-profile.json"), "utf8"));
  assert.equal(profile.selectedCommand, expectedCommand);
  assert.equal(profile.portStrategy, "generated_launch_wrapper");
});

test("AGENT-FOLDER-START-003 registered folder starts through confirmed daemon lifecycle result", async () => {
  const project = await runtimeProject("relaybase-folder-start-registered-", {
    "package.json": JSON.stringify({ scripts: { dev: "vite --host 127.0.0.1" }, dependencies: { vite: "latest" } })
  });
  const manifestPath = path.join(project, "relaybase.app.json");
  await writeManifest(manifestPath, {
    id: "folder-start-web",
    name: "Folder Start Web",
    cwd: project,
    healthUrl: "/"
  });
  const app = appStatus("folder-start-web", "Folder Start Web", "web", "folder-start", "frontend", stoppedRuntime());
  app.cwd = project;
  app.manifestPath = manifestPath;
  const context = fakeToolContext({
    apps: [app],
    logs: [{ appId: "folder-start-web", message: "ready on daemon assigned port" }],
    tuiContext: {
      currentCwd: project,
      daemonHasZeroApps: false,
      diagnostics: []
    }
  });

  const blocked = await executeRelaybaseAgentTool(
    "setup_and_start_project",
    { phase: "start_registered", cwd: project },
    context
  );
  assert.equal(blocked.status, "approval_required");
  assert.equal(context.calls.start, 0);

  const started = await executeRelaybaseAgentTool(
    "setup_and_start_project",
    { phase: "start_registered", cwd: project },
    { ...context, approved: true }
  );
  assert.equal(started.status, "succeeded");
  assert.equal(context.calls.start, 1);
  assert.equal(started.operationId !== undefined, true);
  assert.match(JSON.stringify(started.data), /folder-start-web/);
  assert.match(JSON.stringify(started.data), /http:\/\/folder-start-web\.localhost/);
  assert.match(JSON.stringify(started.data), /ready on daemon assigned port/);
});

test("AGENT-FOLDER-START-003 existing manifest registers before separately approved start", async () => {
  const project = await runtimeProject("relaybase-folder-start-manifest-", {
    "package.json": JSON.stringify({ scripts: { dev: "vite" }, dependencies: { vite: "latest" } })
  });
  const manifestPath = path.join(project, "relaybase.app.json");
  await writeManifest(manifestPath, {
    id: "manifest-only-web",
    name: "Manifest Only Web",
    cwd: project,
    healthUrl: "/"
  });
  const context = fakeToolContext({
    apps: [],
    tuiContext: { currentCwd: project, daemonHasZeroApps: true, diagnostics: [] }
  });

  const startBlockedByRegistration = await executeRelaybaseAgentTool(
    "setup_and_start_project",
    { phase: "start_registered", cwd: project },
    { ...context, approved: true }
  );
  assert.equal(startBlockedByRegistration.status, "diagnostic");
  assert.equal(startBlockedByRegistration.diagnostic?.code, "SETUP_AND_START_REGISTRATION_REQUIRED");
  assert.equal(context.calls.start, 0);

  const registerBlocked = await executeRelaybaseAgentTool(
    "setup_and_start_project",
    { phase: "register_manifest", cwd: project, manifestPath },
    context
  );
  assert.equal(registerBlocked.status, "approval_required");
  assert.equal(context.calls.register, 0);

  const registered = await executeRelaybaseAgentTool(
    "setup_and_start_project",
    registerBlocked.approval?.arguments as Record<string, unknown>,
    { ...context, approved: true }
  );
  assert.equal(registered.status, "succeeded");
  assert.equal(context.calls.register, 1);
  assert.match(JSON.stringify(registered.data), /start_registered/);

  const startRejected = await executeRelaybaseAgentTool(
    "setup_and_start_project",
    { phase: "start_registered", cwd: project, appId: "manifest-only-web" },
    context
  );
  assert.equal(startRejected.status, "approval_required");
  assert.equal(context.calls.start, 0);

  const started = await executeRelaybaseAgentTool(
    "setup_and_start_project",
    { phase: "start_registered", cwd: project, appId: "manifest-only-web" },
    { ...context, approved: true }
  );
  assert.equal(started.status, "succeeded");
  assert.equal(context.calls.start, 1);
});

test("AGENT-FOLDER-START-003 missing manifest previews setup, applies after approval, then starts after approval", async () => {
  const project = await runtimeProject("relaybase-folder-start-setup-", {
    "package.json": JSON.stringify(
      {
        name: "folder-start-setup",
        scripts: { dev: "vite --host 127.0.0.1" },
        devDependencies: { vite: "^6.0.0" }
      },
      null,
      2
    )
  });
  const events: Array<{ type: string; data: unknown }> = [];
  const context = fakeToolContext({
    apps: [],
    tuiContext: { currentCwd: project, daemonHasZeroApps: true, diagnostics: [] },
    emit: (event) => events.push(event)
  });
  const manifestPath = path.join(project, "relaybase.app.json");

  const setupBlocked = await executeRelaybaseAgentTool(
    "setup_and_start_project",
    {
      phase: "apply_setup",
      cwd: project,
      commandHint: "npm run dev",
      selectedPlanId: "framework-port-flag",
      portStrategyHint: "generated_launch_wrapper",
      componentMetadata: {
        appId: "setup-start-web",
        groupId: "setup-start",
        componentRole: "frontend",
        paneLabel: "frontend"
      }
    },
    context
  );
  assert.equal(setupBlocked.status, "approval_required");
  assert.equal(
    events.some((event) => event.type === "setup.plan_preview"),
    true
  );
  assert.equal(await exists(manifestPath), false);
  assert.equal(context.calls.register, 0);
  assert.equal(context.calls.start, 0);
  const approvedSetupInput = setupBlocked.approval?.arguments as Record<string, unknown>;
  assert.equal(typeof (approvedSetupInput.previewBinding as { digest?: unknown })?.digest, "string");
  assert.equal(typeof (approvedSetupInput.previewBinding as { revision?: unknown })?.revision, "string");

  const setupApplied = await executeRelaybaseAgentTool("setup_and_start_project", approvedSetupInput, {
    ...context,
    approved: true
  });
  assert.equal(setupApplied.status, "succeeded");
  assert.equal(await exists(manifestPath), true);
  assert.equal(context.calls.register, 1);
  assert.equal(context.calls.start, 0);
  assert.match(JSON.stringify(setupApplied.data), /start_registered/);

  const startApproved = await executeRelaybaseAgentTool(
    "setup_and_start_project",
    { phase: "start_registered", cwd: project, appId: "setup-start-web" },
    { ...context, approved: true }
  );
  assert.equal(startApproved.status, "succeeded");
  assert.equal(context.calls.start, 1);
});

test("setup apply fails closed on missing or stale preview bindings with zero mutation", async () => {
  const project = await runtimeProject("relaybase-folder-start-preview-binding-", {
    "package.json": JSON.stringify({
      name: "preview-binding-app",
      scripts: { dev: "vite --host 127.0.0.1" },
      devDependencies: { vite: "^6.0.0" }
    })
  });
  const context = fakeToolContext({
    apps: [],
    tuiContext: { currentCwd: project, daemonHasZeroApps: true, diagnostics: [] }
  });
  const manifestPath = path.join(project, "relaybase.app.json");
  const setupInput = {
    phase: "apply_setup",
    cwd: project,
    commandHint: "npm run dev",
    selectedPlanId: "framework-port-flag",
    portStrategyHint: "generated_launch_wrapper",
    componentMetadata: {
      appId: "preview-binding-web",
      groupId: "preview-binding",
      componentRole: "frontend",
      paneLabel: "frontend"
    }
  };

  const preview = await executeRelaybaseAgentTool("setup_and_start_project", setupInput, context);
  assert.equal(preview.status, "approval_required");
  const boundInput = preview.approval?.arguments as Record<string, unknown>;
  assert.equal(typeof (boundInput.previewBinding as { digest?: unknown })?.digest, "string");

  const missingBinding = await executeRelaybaseAgentTool("setup_and_start_project", setupInput, {
    ...context,
    approved: true
  });
  assert.equal(missingBinding.status, "diagnostic");
  assert.equal(missingBinding.diagnostic?.code, "SETUP_PREVIEW_BINDING_REQUIRED");
  assert.equal(await exists(manifestPath), false);
  assert.equal(context.calls.register, 0);
  assert.equal(context.calls.start, 0);

  await writeManifest(manifestPath, {
    id: "manual-drift",
    name: "Manual Drift",
    cwd: project,
    healthUrl: "/manual-health"
  });
  const driftedManifest = await fs.readFile(manifestPath, "utf8");
  const stalePreview = await executeRelaybaseAgentTool("setup_and_start_project", boundInput, {
    ...context,
    approved: true
  });
  assert.equal(stalePreview.status, "diagnostic");
  assert.equal(stalePreview.diagnostic?.code, "SETUP_PREVIEW_STALE");
  assert.equal((stalePreview.diagnostic?.detail as { mutationPerformed?: boolean }).mutationPerformed, false);
  assert.equal(await fs.readFile(manifestPath, "utf8"), driftedManifest);
  assert.equal(context.calls.register, 0);
  assert.equal(context.calls.start, 0);
});

test("legacy setup and manifest approvals fail closed on filesystem drift", async () => {
  const project = await runtimeProject("relaybase-agent-legacy-binding-", {
    "package.json": JSON.stringify({
      name: "legacy-binding",
      scripts: { dev: "vite --host 127.0.0.1" },
      devDependencies: { vite: "^6.0.0" }
    })
  });
  const context = fakeToolContext({
    tuiContext: { currentCwd: project, daemonHasZeroApps: true, diagnostics: [] }
  });
  const manifestPath = path.join(project, "relaybase.app.json");

  const setupPreview = await executeRelaybaseAgentTool(
    "apply_setup_plan",
    { cwd: project, selectedPlanId: "framework-port-flag", commandHint: "npm run dev" },
    context
  );
  assert.equal(setupPreview.status, "approval_required");
  const setupArguments = setupPreview.approval?.arguments as Record<string, unknown>;
  assert.equal(typeof (setupArguments.previewBinding as { digest?: unknown })?.digest, "string");
  await fs.writeFile(
    path.join(project, "package.json"),
    JSON.stringify({ scripts: { dev: "vite --host 0.0.0.0" } }),
    "utf8"
  );
  const staleSetup = await executeRelaybaseAgentTool("apply_setup_plan", setupArguments, {
    ...context,
    approved: true
  });
  assert.equal(staleSetup.status, "diagnostic");
  assert.equal(staleSetup.diagnostic?.code, "SETUP_PREVIEW_STALE");
  assert.equal(await exists(manifestPath), false);

  await writeManifest(manifestPath, {
    id: "legacy-binding",
    name: "Legacy Binding",
    cwd: project,
    healthUrl: "/"
  });
  const manifestPreview = await executeRelaybaseAgentTool(
    "set_health_route",
    { manifestPath, cwd: project, healthUrl: "/readyz" },
    context
  );
  assert.equal(manifestPreview.status, "approval_required");
  const manifestArguments = manifestPreview.approval?.arguments as Record<string, unknown>;
  assert.equal((manifestArguments.approvalStateBinding as { kind?: unknown })?.kind, "manifest_revision");
  const changedManifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Record<string, unknown>;
  changedManifest.name = "Changed After Preview";
  await fs.writeFile(manifestPath, JSON.stringify(changedManifest, null, 2) + "\n", "utf8");
  const staleManifest = await executeRelaybaseAgentTool("set_health_route", manifestArguments, {
    ...context,
    approved: true
  });
  assert.equal(staleManifest.status, "diagnostic");
  assert.equal(staleManifest.diagnostic?.code, "AGENT_APPROVAL_STATE_STALE");
  const after = JSON.parse(await fs.readFile(manifestPath, "utf8")) as { healthUrl?: string };
  assert.equal(after.healthUrl, "/");
});

test("AGENT-FOLDER-START-003 failed folder start returns logs and repair choices without guessing", async () => {
  const project = await runtimeProject("relaybase-folder-start-fail-", {
    "package.json": JSON.stringify({ scripts: { dev: "vite" }, dependencies: { vite: "latest" } })
  });
  const manifestPath = path.join(project, "relaybase.app.json");
  await writeManifest(manifestPath, {
    id: "ignored-port-web",
    name: "Ignored Port Web",
    cwd: project,
    healthUrl: "/wrong-health"
  });
  const failedApp = appStatus(
    "ignored-port-web",
    "Ignored Port Web",
    "web",
    "ignored-port",
    "frontend",
    stoppedRuntime()
  );
  failedApp.cwd = project;
  failedApp.manifestPath = manifestPath;
  const context = fakeToolContext({
    apps: [failedApp],
    logs: [{ appId: "ignored-port-web", message: "server ignored PORT and kept listening on 5173" }],
    startRuntime: {
      status: "errored",
      health: "unhealthy",
      phase: "errored",
      lastError: "App ignored Relaybase PORT and health route /wrong-health failed.",
      logLines: 1
    },
    tuiContext: { currentCwd: project, daemonHasZeroApps: false, diagnostics: [] }
  });

  const result = await executeRelaybaseAgentTool(
    "setup_and_start_project",
    { phase: "start_registered", cwd: project, appId: "ignored-port-web" },
    { ...context, approved: true }
  );
  assert.equal(result.status, "failed");
  assert.equal(result.diagnostic?.code, "SETUP_AND_START_START_FAILED");
  const resultText = JSON.stringify(result);
  assert.match(resultText, /server ignored PORT/);
  assert.match(resultText, /generated_launch_wrapper|pinned-upstream|fixed_upstream_port/);
  assert.match(resultText, /runtimeHealthCandidates|healthRouteCandidates/);
  assert.equal(context.calls.start, 1);
});

test("RA012C language setup phrases map to corresponding daemon adapters and ambiguity questions", async () => {
  const fixtures: Array<{ label: string; runtime: string; files: Record<string, string> }> = [
    {
      label: "add this Go server",
      runtime: "go",
      files: {
        "go.mod": "module example.com/agent-go\n\ngo 1.23\n",
        "main.go": 'package main\nimport "net/http"\nfunc main(){ _ = http.ListenAndServe(":8080", nil) }\n'
      }
    },
    {
      label: "add this Docker Compose service",
      runtime: "docker-compose",
      files: {
        "compose.yaml":
          'services:\n  web:\n    image: nginx\n    ports:\n      - "8080:80"\n  worker:\n    image: busybox\n'
      }
    }
  ];

  for (const fixture of fixtures) {
    const project = await runtimeProject(`relaybase-agent-${fixture.runtime}-`, fixture.files);
    const context = fakeToolContext({
      tuiContext: { currentCwd: project, daemonHasZeroApps: true, diagnostics: [] }
    });
    const detect = await executeRelaybaseAgentTool("detect_project", { cwd: project }, context);
    assert.equal(detect.status, "succeeded", fixture.label);
    assert.match(JSON.stringify(detect.data), new RegExp(`"runtime":"${fixture.runtime}"`), fixture.label);
  }

  const procfileProject = await runtimeProject("relaybase-agent-procfile-", {
    Procfile: "web: npm run dev\nweb-api: npm run api\n"
  });
  const procfileContext = fakeToolContext({
    tuiContext: { currentCwd: procfileProject, daemonHasZeroApps: true, diagnostics: [] }
  });
  const procfileDetect = await executeRelaybaseAgentTool("detect_project", { cwd: procfileProject }, procfileContext);
  assert.equal(procfileDetect.status, "succeeded");
  assert.match(JSON.stringify(procfileDetect.data), /procfile\.process/);
});

test("manifest env override rejects raw secret-like values and accepts safe references through approval flow", async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-agent-env-"));
  const manifestPath = path.join(project, "relaybase.app.json");
  await fs.writeFile(
    manifestPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        id: "secret-safe",
        name: "Secret Safe",
        command: "npm.cmd run dev",
        protocol: "http",
        cwd: project
      },
      null,
      2
    ),
    "utf8"
  );
  const context = fakeToolContext({
    tuiContext: { currentCwd: project, daemonHasZeroApps: true, diagnostics: [] }
  });

  const rejected = await executeRelaybaseAgentTool(
    "add_env_override_safe",
    { manifestPath, cwd: project, key: "API_KEY", value: "sk-raw-secret-value" },
    context
  );
  assert.equal(rejected.status, "diagnostic");
  assert.equal(rejected.diagnostic?.code, "AGENT_ENV_SECRET_VALUE_REJECTED");
  assert.doesNotMatch(JSON.stringify(rejected), /sk-raw-secret-value/);

  const acceptedPreview = await executeRelaybaseAgentTool(
    "add_env_override_safe",
    { manifestPath, cwd: project, key: "API_KEY", valueReference: "env:API_KEY" },
    context
  );
  assert.equal(acceptedPreview.status, "approval_required");
  const accepted = await executeRelaybaseAgentTool(
    "add_env_override_safe",
    acceptedPreview.approval?.arguments as Record<string, unknown>,
    { ...context, approved: true }
  );
  assert.equal(accepted.status, "succeeded");
  const updated = JSON.parse(await fs.readFile(manifestPath, "utf8")) as { env?: Record<string, string> };
  assert.equal(updated.env?.API_KEY, "env:API_KEY");
});

test("TUI-only proposals never mutate daemon state and report unsupported clipboard/browser capabilities", async () => {
  const emitted: unknown[] = [];
  const context = fakeToolContext({
    tuiContext: {
      selectedPaneId: "notes:notes-web:frontend:frontend",
      selectedAppId: "notes-web",
      selectedGroupId: "notes",
      selectedComponentRole: "frontend",
      currentRoute: "http://notes.localhost:7331",
      daemonHasZeroApps: false,
      diagnostics: [],
      terminalCapabilities: { clipboard: "unavailable", browserOpen: "unavailable" }
    },
    emit: (event) => emitted.push(event)
  });

  const pin = await executeRelaybaseAgentTool("propose_tui_action", { kind: "pin_pane" }, context);
  assert.equal(pin.status, "succeeded");
  assert.equal(emitted.length, 1);
  assert.equal(context.calls.start + context.calls.stop + context.calls.restart + context.calls.export, 0);

  const copy = await executeRelaybaseAgentTool("propose_tui_action", { kind: "copy_route" }, context);
  assert.equal(copy.status, "unavailable");
  assert.equal(copy.diagnostic?.code, "AGENT_TUI_CLIPBOARD_UNAVAILABLE");

  const browser = await executeRelaybaseAgentTool("propose_tui_action", { kind: "open_browser" }, context);
  assert.equal(browser.status, "unavailable");
  assert.equal(browser.diagnostic?.code, "AGENT_TUI_BROWSER_OPEN_UNAVAILABLE");
});

async function runtimeProject(prefix: string, files: Record<string, string>): Promise<string> {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
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

function mutatingToolCases(
  project: string,
  manifestPath: string
): Array<{ name: string; input: Record<string, unknown> }> {
  return [
    { name: "start_app", input: { appId: "notes-web" } },
    { name: "stop_app", input: { appId: "notes-web" } },
    { name: "restart_app", input: { appId: "notes-web" } },
    { name: "export_logs", input: { scope: "app", appId: "notes-web", format: "jsonl" } },
    { name: "apply_setup_plan", input: { cwd: project, commandHint: "npm.cmd run dev" } },
    { name: "register_manifest", input: { manifestPath, cwd: project } },
    { name: "patch_manifest_fields", input: { manifestPath, cwd: project, patch: { healthUrl: "/patched" } } },
    { name: "set_health_route", input: { manifestPath, cwd: project, healthUrl: "/readyz" } },
    { name: "set_pinned_port", input: { manifestPath, cwd: project, upstreamPort: 43210 } },
    {
      name: "set_component_metadata",
      input: {
        manifestPath,
        cwd: project,
        groupId: "notes",
        componentRole: "frontend",
        paneLabel: "web"
      }
    },
    {
      name: "add_env_override_safe",
      input: { manifestPath, cwd: project, key: "API_KEY", valueReference: "env:API_KEY" }
    },
    { name: "open_project_or_app", input: { appId: "notes-web", noBrowser: true } },
    { name: "setup_and_start_project", input: { phase: "start_registered", appId: "notes-web", cwd: project } },
    { name: "prove_app_health", input: { cwd: project, appId: "notes-web", lifecycleProof: false } }
  ];
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
    tuiContext?: AgentToolExecutionContext["tuiContext"];
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
    stateDir: path.join(os.tmpdir(), "relaybase-agent-tool-runtime"),
    token: "relaybase-test-token-secret",
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
      logs: async (id: string) => logs.filter((log) => log.appId === id).map((log) => String(log.message ?? "")),
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
        return setRuntime(apps, id, runningRuntime());
      }
    } as unknown as RelaybaseRuntime["processes"],
    logStore: {
      query: async () => ({
        events: logs.map((event, index) => ({
          sequence: Number(event.sequence ?? index + 1),
          timestamp: String(event.timestamp ?? new Date().toISOString()),
          appId: String(event.appId ?? "app"),
          groupId: event.groupId === undefined ? undefined : String(event.groupId),
          componentRole: event.componentRole === undefined ? undefined : String(event.componentRole),
          stream: event.stream === "stderr" ? "stderr" : "stdout",
          level: event.level === undefined ? undefined : String(event.level),
          message: String(event.message ?? "").replace(/token=[^\s]+/gi, "token=[redacted]"),
          redacted: true
        })),
        page: { limit: logs.length, hasMoreBefore: false, hasMoreAfter: false },
        diagnostics: []
      })
    } as RelaybaseRuntime["logStore"],
    exports: {
      create: async (input: unknown) => {
        calls.export += 1;
        const request = input as { format?: "log" | "jsonl" | "zip" };
        return {
          exportId: "exp_test",
          status: "succeeded",
          format: request.format ?? "zip",
          outputPath: path.join(os.tmpdir(), "relaybase-agent-tool-export.zip"),
          includedApps: ["notes-api"],
          includedGroups: ["notes"],
          includedComponents: ["notes-api"],
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          sizeBytes: 12,
          redactionReport: {
            totalReplacements: 1,
            patterns: { token: 1 },
            fields: {}
          }
        } satisfies LogExportResult;
      }
    } as RelaybaseRuntime["exports"],
    agentGateway: {
      diagnostics: async () => options.diagnostics ?? []
    } as unknown as RelaybaseRuntime["agentGateway"],
    operations: new OperationStore(),
    events: {
      publish: () => undefined
    } as RelaybaseRuntime["events"],
    mcp: {} as RelaybaseRuntime["mcp"]
  };

  return {
    runtime,
    tuiContext: options.tuiContext ?? {
      daemonHasZeroApps: apps.length === 0,
      diagnostics: options.diagnostics ?? []
    },
    ...(options.tuiContext?.currentCwd
      ? {
          projectRootGrants: [
            {
              grantId: "test_current_project",
              canonicalRoot: realpathSync.native(path.resolve(options.tuiContext.currentCwd)),
              source: "tui_current_cwd" as const
            }
          ]
        }
      : {}),
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
    protocol: "tcp",
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

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(condition(), true);
}

async function waitForOperationDone(context: FakeToolContext, operationId: string): Promise<void> {
  await waitFor(() => {
    const operation = context.runtime.operations.get(operationId);
    return Boolean(operation && operation.status !== "queued" && operation.status !== "running");
  });
}
