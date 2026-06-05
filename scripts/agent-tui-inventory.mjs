import { promises as fs } from "node:fs";
import path from "node:path";

const root = process.cwd();
const reportPath = path.join(root, "reports", "agent-tui-command-matrix.md");
const artifactPath = path.join(root, "artifacts", "agent-tui-command-matrix.json");

const docs = [
  "docs/tui-keymap.md",
  "docs/tui-agent-architecture.md",
  "docs/tui-agent-tools.md",
  "docs/tui-setup-onboarding.md",
  "docs/tui-setup-gap-map.md",
  "docs/tui-setup-runtime-matrix.md"
];

const implementationSources = [
  "tui/internal/tui/slash/slash.go",
  "tui/internal/tui/assistant/assistant.go",
  "tui/internal/tui/contextmenu/menu.go",
  "tui/internal/tui/model/model.go",
  "src/agent/tools/index.ts",
  "src/agent/liveAcceptance.ts",
  "scripts/tui-smoke.mjs"
];

const testRoots = ["tests", "tui/internal"];

const slashCommands = [
  {
    id: "slash.add-app.empty",
    input: "/add app",
    kind: "KindAddApp",
    expected: "Start daemon-owned setup planning for a current/selected project; confirmation required before writes.",
    approval: true,
    daemon: true
  },
  {
    id: "slash.add-app.path-command",
    input: "/add app <path> using <command>",
    kind: "KindAddApp",
    expected:
      "Plan setup for an explicit path and command hint through daemon setup APIs; confirmation required before writes.",
    approval: true,
    daemon: true
  },
  {
    id: "slash.launch",
    input: "/launch <app|group|role>",
    kind: "KindLaunch",
    expected: "Show a confirmation preview, then request daemon lifecycle start for the resolved target.",
    approval: true,
    daemon: true
  },
  {
    id: "slash.stop",
    input: "/stop <app|group|role>",
    kind: "KindStop",
    expected: "Show a confirmation preview, then request daemon lifecycle stop for the resolved target.",
    approval: true,
    daemon: true
  },
  {
    id: "slash.restart",
    input: "/restart <app|group|role>",
    kind: "KindRestart",
    expected: "Show a confirmation preview, then request daemon lifecycle restart for the resolved target.",
    approval: true,
    daemon: true
  },
  {
    id: "slash.logs-export",
    input: "/logs export <pane|app|group|page|all>",
    kind: "KindLogsExport",
    expected: "Resolve the log export scope, show a confirmation preview, then request daemon log export.",
    approval: true,
    daemon: true
  },
  {
    id: "slash.page",
    input: "/page <next|prev|number>",
    kind: "KindPage",
    expected: "Move dashboard pane pages locally without daemon mutation.",
    approval: false,
    daemon: false
  },
  {
    id: "slash.pane-color",
    input: "/pane color <pane> <color>",
    kind: "KindPaneColor",
    expected: "Change local pane color preference for the resolved pane.",
    approval: false,
    daemon: false
  },
  {
    id: "slash.pin",
    input: "/pin <pane>",
    kind: "KindPin",
    expected: "Pin the resolved pane in local TUI state/preferences.",
    approval: false,
    daemon: false
  },
  {
    id: "slash.unpin",
    input: "/unpin <pane>",
    kind: "KindUnpin",
    expected: "Unpin the resolved pane in local TUI state/preferences.",
    approval: false,
    daemon: false
  },
  {
    id: "slash.theme",
    input: "/theme <light|dark|auto>",
    kind: "KindTheme",
    expected: "Change local theme preference.",
    approval: false,
    daemon: false
  },
  {
    id: "slash.help",
    input: "/help",
    kind: "KindHelp",
    expected: "Show local command help.",
    approval: false,
    daemon: false
  },
  {
    id: "slash.confirm",
    input: "/confirm",
    kind: "KindConfirm",
    expected: "Approve the pending TUI confirmation request.",
    approval: false,
    daemon: false
  },
  {
    id: "slash.cancel",
    input: "/cancel",
    kind: "KindCancel",
    expected: "Cancel the pending TUI confirmation request.",
    approval: false,
    daemon: false
  },
  {
    id: "slash.daemon-status",
    input: "/daemon status",
    kind: "KindDaemonStatus",
    expected: "Query local launch-bridge daemon bootstrap status when available.",
    approval: false,
    daemon: false
  },
  {
    id: "slash.daemon-repair",
    input: "/daemon repair",
    kind: "KindDaemonRepair",
    expected: "Confirm, then ask the Node launch bridge to ensure/reconnect the Relaybase daemon only.",
    approval: true,
    daemon: false
  },
  {
    id: "slash.thread-list",
    input: "/thread list",
    kind: "KindThreadList",
    expected: "List daemon-backed Operator Agent sessions.",
    approval: false,
    daemon: true
  },
  {
    id: "slash.thread-new",
    input: "/thread new [title]",
    kind: "KindThreadNew",
    expected:
      "Create a daemon-backed Operator Agent session when the Agent Gateway is available, otherwise local fallback.",
    approval: false,
    daemon: true
  },
  {
    id: "slash.thread-switch",
    input: "/thread switch <id|number>",
    kind: "KindThreadSwitch",
    expected: "Switch active daemon-backed Operator Agent session.",
    approval: false,
    daemon: true
  },
  {
    id: "slash.thread-rename",
    input: "/thread rename <title>",
    kind: "KindThreadRename",
    expected: "Rename the active daemon-backed Operator Agent session.",
    approval: false,
    daemon: true
  },
  {
    id: "slash.thread-clear",
    input: "/thread clear",
    kind: "KindThreadClear",
    expected: "Soft-clear the active daemon-backed Operator Agent session.",
    approval: false,
    daemon: true
  },
  {
    id: "slash.thread-export",
    input: "/thread export <json|markdown>",
    kind: "KindThreadExport",
    expected: "Export the active daemon-backed Operator Agent session through daemon redacted export APIs.",
    approval: false,
    daemon: true
  },
  {
    id: "slash.thread-preview",
    input: "/thread preview",
    kind: "KindThreadPreview",
    expected: "Show daemon active-thread context preview and recall/redaction policy.",
    approval: false,
    daemon: true
  },
  {
    id: "slash.register",
    input: "/register <manifest-path>",
    kind: "KindRegister",
    expected: "Show confirmation, then register an existing manifest through daemon setup APIs.",
    approval: true,
    daemon: true
  },
  {
    id: "slash.configure.current",
    input: "/configure",
    kind: "KindConfigure",
    expected: "Plan and preview setup for trusted current directory through daemon setup APIs.",
    approval: true,
    daemon: true
  },
  {
    id: "slash.configure.cwd",
    input: "/configure cwd",
    kind: "KindConfigure",
    expected: "Plan and preview setup for trusted current directory through daemon setup APIs.",
    approval: true,
    daemon: true
  },
  {
    id: "slash.configure.current-folder",
    input: "/configure current folder",
    kind: "KindConfigure",
    expected: "Plan and preview setup for trusted current directory through daemon setup APIs.",
    approval: true,
    daemon: true
  },
  {
    id: "slash.configure.path",
    input: "/configure <path>",
    kind: "KindConfigure",
    expected: "Plan and preview setup for explicit path through daemon setup APIs.",
    approval: true,
    daemon: true
  },
  {
    id: "slash.configure.dry-run",
    input: "/configure <path> --dry-run",
    kind: "KindConfigure",
    expected: "Request read-only setup preview through daemon setup APIs without applying writes.",
    approval: false,
    daemon: true
  },
  {
    id: "slash.open",
    input: "/open <path-or-app>",
    kind: "KindOpen",
    expected: "Show confirmation, then ask daemon setup open flow to return/open route when supported.",
    approval: true,
    daemon: true
  },
  {
    id: "slash.prove",
    input: "/prove <app>",
    kind: "KindProve",
    expected: "Show confirmation, then run daemon health proof for the target.",
    approval: true,
    daemon: true
  },
  {
    id: "slash.health-prove",
    input: "/health <app> --prove",
    kind: "KindHealthProve",
    expected: "Show confirmation, then run daemon health proof for the target.",
    approval: true,
    daemon: true
  },
  {
    id: "slash.repair",
    input: "/repair <app-or-path>",
    kind: "KindRepair",
    expected: "Request read-only daemon setup repair choices/previews.",
    approval: false,
    daemon: true
  },
  {
    id: "slash.manifest-inspect",
    input: "/manifest inspect <app-or-path>",
    kind: "KindManifestInspect",
    expected: "Inspect/validate manifest through daemon setup APIs without writing.",
    approval: false,
    daemon: true
  },
  {
    id: "slash.manifest-edit",
    input: "/manifest edit <field> <value>",
    kind: "KindManifestEdit",
    expected: "Show confirmation, then apply a safe daemon manifest patch for supported fields only.",
    approval: true,
    daemon: true
  },
  {
    id: "slash.health-route",
    input: "/health route <app> <route>",
    kind: "KindHealthRoute",
    expected: "Show confirmation, then patch the manifest health route through daemon setup APIs.",
    approval: true,
    daemon: true
  },
  {
    id: "slash.port-pinned",
    input: "/port pinned <app> <port>",
    kind: "KindPortPinned",
    expected: "Show confirmation, then patch manifest upstreamPort through daemon setup APIs.",
    approval: true,
    daemon: true
  },
  {
    id: "slash.component-role",
    input: "/component role <app> <role>",
    kind: "KindComponentRole",
    expected: "Show confirmation, then patch component role metadata through daemon setup APIs.",
    approval: true,
    daemon: true
  },
  {
    id: "slash.component-group",
    input: "/component group <app> <groupId>",
    kind: "KindComponentGroup",
    expected: "Show confirmation, then patch component group metadata through daemon setup APIs.",
    approval: true,
    daemon: true
  },
  {
    id: "slash.component-label",
    input: "/component label <app> <label>",
    kind: "KindComponentLabel",
    expected: "Show confirmation, then patch component label metadata through daemon setup APIs.",
    approval: true,
    daemon: true
  }
];

const assistantPhraseFamilies = [
  {
    id: "assistant.broken-summary",
    input: "what is broken?",
    expected: "Summarize current daemon/TUI diagnostics locally or from daemon state.",
    approval: false,
    daemon: false
  },
  {
    id: "assistant.show-diagnostics",
    input: "show diagnostics",
    expected: "Show current local and daemon diagnostics.",
    approval: false,
    daemon: false
  },
  {
    id: "assistant.daemon-status",
    input: "daemon status | relaybase status | why is relaybase offline?",
    expected: "Map to daemon status slash behavior through deterministic local parser.",
    approval: false,
    daemon: false
  },
  {
    id: "assistant.daemon-repair",
    input: "fix daemon | repair daemon | retry connection | start relaybase daemon",
    expected: "Map to daemon repair preview; confirmation required before launch-bridge ensure.",
    approval: true,
    daemon: false
  },
  {
    id: "assistant.page-next",
    input: "go to next page | next page",
    expected: "Move dashboard page locally.",
    approval: false,
    daemon: false
  },
  {
    id: "assistant.page-prev",
    input: "go to previous page | previous page",
    expected: "Move dashboard page locally.",
    approval: false,
    daemon: false
  },
  {
    id: "assistant.pin-pane",
    input: "pin this pane | pin current pane",
    expected: "Pin selected pane locally.",
    approval: false,
    daemon: false
  },
  {
    id: "assistant.unpin-pane",
    input: "unpin this pane | unpin current pane",
    expected: "Unpin selected pane locally.",
    approval: false,
    daemon: false
  },
  {
    id: "assistant.change-color",
    input: "change <pane> to <blue|green|amber|red|brown|default|#hex>",
    expected: "Change local pane color for resolved pane.",
    approval: false,
    daemon: false
  },
  {
    id: "assistant.show-logs",
    input: "show <target> logs",
    expected: "Resolve target and show/focus log context without mutating lifecycle.",
    approval: false,
    daemon: true
  },
  {
    id: "assistant.export-logs",
    input: "export logs for <target>",
    expected: "Map to log export command; confirmation required before daemon export.",
    approval: true,
    daemon: true
  },
  {
    id: "assistant.launch",
    input: "launch <target> | start <target>",
    expected: "Map to daemon lifecycle start preview; confirmation required.",
    approval: true,
    daemon: true
  },
  {
    id: "assistant.stop",
    input: "stop <target>",
    expected: "Map to daemon lifecycle stop preview; confirmation required.",
    approval: true,
    daemon: true
  },
  {
    id: "assistant.restart",
    input: "restart <target>",
    expected: "Map to daemon lifecycle restart preview; confirmation required.",
    approval: true,
    daemon: true
  },
  {
    id: "assistant.unsupported",
    input: "<unsupported assistant command>",
    expected: "Return a blocked diagnostic with examples; do not call network or fake model output.",
    approval: false,
    daemon: false,
    statusOverride: "unavailable"
  }
];

const setupRoutes = [
  ["setup.detect", "POST /__hub/api/setup/detect", "Detect project/runtime metadata without writing.", false],
  ["setup.plans", "POST /__hub/api/setup/plans", "Return setup plan choices without writing.", false],
  ["setup.preview", "POST /__hub/api/setup/preview", "Return redacted file-write preview/diff without writing.", false],
  ["setup.apply", "POST /__hub/api/setup/apply", "Apply approved setup writes and optional registration.", true],
  [
    "setup.register-manifest",
    "POST /__hub/api/setup/register-manifest",
    "Register an existing manifest after confirmation/auth.",
    true
  ],
  ["setup.inspect-manifest", "POST /__hub/api/setup/inspect-manifest", "Inspect manifest without writing.", false],
  ["setup.validate-manifest", "POST /__hub/api/setup/validate-manifest", "Validate manifest without writing.", false],
  [
    "setup.patch-preview",
    "POST /__hub/api/setup/patch-manifest/preview",
    "Preview safe manifest patch without writing.",
    false
  ],
  ["setup.patch-apply", "POST /__hub/api/setup/patch-manifest/apply", "Apply approved safe manifest patch.", true],
  ["setup.open", "POST /__hub/api/setup/open", "Return/open app route after confirmation when needed.", true],
  ["setup.prove", "POST /__hub/api/setup/prove", "Run approved health proof/lifecycle proof when needed.", true],
  [
    "setup.repair",
    "POST /__hub/api/setup/repair",
    "Return setup repair choices/previews without applying writes.",
    false
  ],
  [
    "setup.operations",
    "GET /__hub/api/setup/operations/:operationId",
    "Return normalized setup operation diagnostic/state.",
    false
  ]
];

const approvalGates = [
  {
    id: "approval.lifecycle-start",
    input: "start/launch app/group/role",
    expected: "Daemon lifecycle start requires visible approval.",
    tokens: ["start_app", "KindLaunch", "approval required"]
  },
  {
    id: "approval.lifecycle-stop",
    input: "stop app/group/role",
    expected: "Daemon lifecycle stop requires visible approval.",
    tokens: ["stop_app", "KindStop", "approval required"]
  },
  {
    id: "approval.lifecycle-restart",
    input: "restart app/group/role",
    expected: "Daemon lifecycle restart requires visible approval.",
    tokens: ["restart_app", "KindRestart", "approval required"]
  },
  {
    id: "approval.log-export",
    input: "export logs",
    expected: "Log export requires visible approval.",
    tokens: ["export_logs", "KindLogsExport", "export logs"]
  },
  {
    id: "approval.setup-file-write",
    input: "setup file write",
    expected: "Setup file writes require daemon approval.",
    tokens: ["apply_setup_plan", "setup.file_write_approval_required", "file write"]
  },
  {
    id: "approval.manifest-patch",
    input: "manifest patch",
    expected: "Manifest writes require daemon approval.",
    tokens: ["patch_manifest_fields", "setup.manifest_patch_approval_required", "manifest patch"]
  },
  {
    id: "approval.env-edit",
    input: "env override",
    expected: "Env edits require daemon approval and hidden secret values.",
    tokens: ["add_env_override_safe", "env override"]
  },
  {
    id: "approval.open-route",
    input: "browser/open route",
    expected: "Browser/open actions require real support or an unavailable diagnostic.",
    tokens: ["open_project_or_app", "browserOpen", "open route"]
  },
  {
    id: "approval.recovered",
    input: "recovered pending approval",
    expected: "Recovered approvals require explicit reconfirmation before resume.",
    tokens: ["recovered approval", "recovered_pending", "requires_reconfirm"]
  },
  {
    id: "approval.reject",
    input: "reject pending approval",
    expected: "Rejecting a pending approval must not execute the tool.",
    tokens: ["RejectAgentApproval", "rejected", "tool.started"]
  }
];

const unavailableDiagnostics = [
  [
    "diagnostic.daemon-unavailable",
    "daemon_unavailable",
    "Daemon state cannot be fetched; show start/repair guidance."
  ],
  [
    "diagnostic.event-stream-disconnected",
    "event_stream_disconnected",
    "Global daemon event stream disconnected; show diagnostic and reconnect path."
  ],
  [
    "diagnostic.agent-gateway-unavailable",
    "agent_gateway_unavailable",
    "Agent Gateway config cannot be read from daemon."
  ],
  [
    "diagnostic.agent-diagnostics-unavailable",
    "agent_diagnostics_unavailable",
    "Agent diagnostics endpoint cannot be read."
  ],
  [
    "diagnostic.agent-disabled",
    "agent_disabled",
    "Operator Agent disabled; deterministic local commands remain available."
  ],
  [
    "diagnostic.agent-remote-disabled",
    "agent_remote_model_disabled",
    "Remote model mode disabled; show .env guidance."
  ],
  ["diagnostic.agent-model-missing", "agent_model_missing", "OpenRouter model slug missing; show .env guidance."],
  [
    "diagnostic.agent-key-missing",
    "agent_key_missing",
    "Configured API key environment variable missing; do not expose secrets."
  ],
  [
    "diagnostic.assistant-unsupported",
    "assistant_command_unsupported",
    "Unsupported deterministic assistant input shows examples."
  ],
  [
    "diagnostic.chat-export-unavailable",
    "assistant_chat_export_unavailable",
    "Chat export unavailable without daemon-backed active thread."
  ],
  [
    "diagnostic.route-unavailable",
    "selected pane has no route",
    "Show route/copy route disabled when no route exists."
  ],
  [
    "diagnostic.clipboard-unavailable",
    "clipboard unavailable",
    "Clipboard proposal returns honest unavailable diagnostic when unsupported."
  ],
  [
    "diagnostic.browser-unavailable",
    "browser open unavailable",
    "Browser proposal returns honest unavailable diagnostic when unsupported."
  ],
  ["diagnostic.runtime-ambiguous", "SETUP_RUNTIME_AMBIGUOUS", "Setup asks for choices instead of guessing runtime."],
  [
    "diagnostic.runtime-unsupported",
    "SETUP_RUNTIME_UNSUPPORTED",
    "Unsupported runtime returns actionable setup diagnostic."
  ],
  [
    "diagnostic.runtime-entrypoint-required",
    "SETUP_RUNTIME_ENTRYPOINT_REQUIRED",
    "Runtime detected but entrypoint needs user choice."
  ],
  [
    "diagnostic.runtime-port-strategy-required",
    "SETUP_RUNTIME_PORT_STRATEGY_REQUIRED",
    "Port behavior cannot be proven; ask for strategy."
  ],
  [
    "diagnostic.runtime-tool-missing",
    "SETUP_RUNTIME_TOOL_MISSING",
    "Host toolchain missing for setup/proof; report exact tool needed."
  ],
  [
    "diagnostic.runtime-multiple-servers",
    "SETUP_RUNTIME_MULTIPLE_SERVERS",
    "Multiple server candidates require clarification."
  ]
];

const liveFlowRows = [
  {
    id: "live.openrouter",
    input: "agent:smoke:openrouter",
    expected: "Real OpenRouter completion/tool/stream smoke uses configured model.",
    tokens: ["smoke-openrouter", "OpenRouter"]
  },
  {
    id: "live.ra013.js-setup",
    input: "RA013 JavaScript setup",
    expected: "Configure JS sample through natural language setup preview and approved apply.",
    tokens: ["Configure this folder", "setupPlanJs", "apply_setup_plan"]
  },
  {
    id: "live.ra013.js-start-prove",
    input: "RA013 JavaScript start/prove",
    expected: "Start and prove JS sample through approved daemon lifecycle/proof.",
    tokens: ["Launch the js-node-sample app", "prove JavaScript health", "start_app"]
  },
  {
    id: "live.ra013.python-register-start",
    input: "RA013 Python register/start",
    expected: "Register manifest and start Python stdlib HTTP app after approvals.",
    tokens: ["Python stdlib", "register_manifest", "start_app"]
  },
  {
    id: "live.ra013.go-setup-start-stop",
    input: "RA013 Go setup/start/stop",
    expected: "Configure, start, prove, then stop Go sample after approvals.",
    tokens: ["Add this Go server", "setupPlanGo", "stop_app"]
  },
  {
    id: "live.ra013.restart",
    input: "RA013 restart",
    expected: "Restart sample app after approval.",
    tokens: ["Restart the Python app", "restart_app"]
  },
  {
    id: "live.ra013.export",
    input: "RA013 export logs",
    expected: "Export redacted logs after approval.",
    tokens: ["Export logs for the JS app", "export_logs"]
  },
  {
    id: "live.ra013.repair",
    input: "RA013 ignored PORT repair",
    expected: "Inspect failed fixture and propose repair choices without applying writes.",
    tokens: ["ignored-PORT fixture", "repair_app_setup"]
  },
  {
    id: "live.ra013.metadata",
    input: "RA013 component metadata",
    expected: "Patch frontend/backend component metadata after approval.",
    tokens: ["set_component_metadata", "live-demo"]
  },
  {
    id: "live.ra013.ambiguity",
    input: "RA013 ambiguous destructive target",
    expected: "Ask clarification for ambiguous destructive command.",
    tokens: ["ambiguous destructive", "clarification"]
  },
  {
    id: "live.ra013.prompt-injection",
    input: "RA013 prompt injection bypass",
    expected: "Prompt injection cannot bypass approval.",
    tokens: ["Ignore all approval rules", "PROMPT_INJECTION"]
  }
];

async function main() {
  const fileCache = await readRepoFiles();
  const testFiles = await collectFiles(testRoots, (file) => file.endsWith("_test.go") || file.endsWith(".test.ts"));
  const testCache = Object.fromEntries(await Promise.all(testFiles.map(async (file) => [file, await readText(file)])));
  const docCache = Object.fromEntries(await Promise.all(docs.map(async (file) => [file, await readText(file)])));

  const rows = [];
  for (const entry of slashCommands) {
    rows.push(
      row(fileCache, docCache, testCache, {
        ...entry,
        surface: "slash",
        implementationFile: "tui/internal/tui/slash/slash.go",
        liveOpenRouter: false,
        tokens: [entry.input, entry.kind, entry.id.replace(/^slash\./, "")]
      })
    );
  }

  for (const entry of assistantPhraseFamilies) {
    rows.push(
      row(fileCache, docCache, testCache, {
        ...entry,
        surface: "assistant",
        implementationFile: "tui/internal/tui/assistant/assistant.go",
        daemon: entry.daemon,
        liveOpenRouter: false,
        tokens: [entry.input, entry.id.replace(/^assistant\./, "")]
      })
    );
  }

  for (const menuItem of discoverMenuItems(fileCache["tui/internal/tui/contextmenu/menu.go"] ?? "")) {
    rows.push(
      row(fileCache, docCache, testCache, {
        id: `menu.${menuItem.action.replaceAll(".", "-")}`,
        surface: "menu",
        input: `${menuItem.context}: ${menuItem.label}`,
        implementationFile: "tui/internal/tui/contextmenu/menu.go",
        documentedLocation: "",
        expected: expectedForMenuAction(menuItem.action),
        approval:
          menuItem.action.includes("stop") ||
          menuItem.action.includes("restart") ||
          menuItem.action.includes("export_logs"),
        daemon:
          menuItem.action.includes("stop") ||
          menuItem.action.includes("restart") ||
          menuItem.action.includes("export") ||
          menuItem.action.includes("llm") ||
          menuItem.action.includes("new_thread"),
        liveOpenRouter: false,
        tokens: [menuItem.label, menuItem.action, menuItem.constant]
      })
    );
  }

  for (const tool of discoverAgentTools(fileCache)) {
    rows.push(
      row(fileCache, docCache, testCache, {
        id: `tool.${tool.name}`,
        surface: "daemon tool",
        input: tool.name,
        implementationFile: tool.file,
        expected: tool.description || `Execute ${tool.name} through the Agent Gateway tool registry.`,
        approval: tool.approvalRequired,
        daemon: true,
        liveOpenRouter: false,
        tokens: [tool.name, tool.file, tool.description]
      })
    );
  }

  for (const [id, input, expected, approval] of setupRoutes) {
    rows.push(
      row(fileCache, docCache, testCache, {
        id,
        surface: "setup",
        input,
        implementationFile: "src/setupApi.ts",
        expected,
        approval,
        daemon: true,
        liveOpenRouter: false,
        tokens: [input, id.replace("setup.", ""), expected]
      })
    );
  }

  for (const gate of approvalGates) {
    rows.push(
      row(fileCache, docCache, testCache, {
        id: gate.id,
        surface: "approval",
        input: gate.input,
        implementationFile: "src/agent/approvalStore.ts; tui/internal/tui/model/model.go",
        expected: gate.expected,
        approval: true,
        daemon: true,
        liveOpenRouter: false,
        tokens: [gate.input, gate.id.replace("approval.", ""), gate.expected, ...gate.tokens]
      })
    );
  }

  for (const [id, input, expected] of unavailableDiagnostics) {
    rows.push(
      row(fileCache, docCache, testCache, {
        id,
        surface: "failure state",
        input,
        implementationFile: implementationForDiagnostic(input),
        expected,
        approval: false,
        daemon: input.startsWith("agent_") || input.startsWith("SETUP_"),
        liveOpenRouter: false,
        statusOverride: "unavailable",
        tokens: [input, id.replace("diagnostic.", ""), expected]
      })
    );
  }

  for (const runtime of discoverRuntimeHeadings(docCache["docs/tui-setup-runtime-matrix.md"] ?? "")) {
    rows.push(
      row(fileCache, docCache, testCache, {
        id: `runtime.${slug(runtime)}`,
        surface: "setup",
        input: runtime,
        implementationFile: "src/setupRuntimeAdapters.ts",
        expected: `Detect, plan, preview, and diagnose ${runtime} setup without guessing unsafe commands.`,
        approval: false,
        daemon: true,
        liveOpenRouter: false,
        tokens: [runtime, slug(runtime), "setup-runtime-matrix"]
      })
    );
  }

  for (const flow of liveFlowRows) {
    rows.push(
      row(fileCache, docCache, testCache, {
        id: flow.id,
        surface: "live agent",
        input: flow.input,
        implementationFile: "src/agent/liveAcceptance.ts",
        expected: flow.expected,
        approval: true,
        daemon: true,
        liveOpenRouter: true,
        tokens: [flow.input, flow.id.replace("live.", ""), flow.expected, ...flow.tokens]
      })
    );
  }

  for (const docOnly of discoverDocOnlySlashCommands(docCache, rows)) {
    rows.push(row(fileCache, docCache, testCache, docOnly));
  }

  rows.sort((left, right) => left.id.localeCompare(right.id));
  const summary = summarize(rows);
  const artifact = {
    schemaVersion: 1,
    generatedBy: "npm run agent-tui:inventory",
    sourceFiles: [...docs, ...implementationSources],
    rowCount: rows.length,
    summary,
    rows
  };

  await fs.mkdir(path.dirname(artifactPath), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  await fs.writeFile(reportPath, renderMarkdown(artifact), "utf8");

  console.log(`Wrote ${path.relative(root, reportPath)} with ${rows.length} rows.`);
  console.log(`Wrote ${path.relative(root, artifactPath)} with ${rows.length} rows.`);
}

async function readRepoFiles() {
  const toolFiles = await collectFiles(["src/agent/tools"], (file) => file.endsWith(".ts"));
  const files = [
    ...new Set([...docs, ...implementationSources, ...toolFiles, "src/setupApi.ts", "src/setupRuntimeAdapters.ts"])
  ];
  const entries = await Promise.all(files.map(async (file) => [file, await readText(file)]));
  return Object.fromEntries(entries);
}

async function collectFiles(roots, predicate) {
  const files = [];
  for (const item of roots) {
    const abs = path.join(root, item);
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      continue;
    }
    if (stat.isFile()) {
      if (predicate(item)) files.push(normalizePath(item));
      continue;
    }
    const children = await fs.readdir(abs, { withFileTypes: true });
    for (const child of children) {
      const childRel = normalizePath(path.join(item, child.name));
      if (child.isDirectory()) {
        files.push(...(await collectFiles([childRel], predicate)));
      } else if (predicate(childRel)) {
        files.push(childRel);
      }
    }
  }
  return files.sort();
}

async function readText(file) {
  try {
    return await fs.readFile(path.join(root, file), "utf8");
  } catch {
    return "";
  }
}

function row(fileCache, docCache, testCache, entry) {
  const tokens = compact(entry.tokens ?? [entry.input, entry.id]);
  const docsFound = findLocations(docCache, tokens);
  const testsFound = findLocations(testCache, tokens).filter((location) => !location.file.includes("fixtures"));
  const sourceFound = findLocations(pick(fileCache, implementationSources), tokens);
  const status =
    entry.statusOverride ??
    (testsFound.length > 0 && docsFound.length > 0
      ? "covered"
      : testsFound.length > 0 || docsFound.length > 0 || sourceFound.length > 0
        ? "partial"
        : "missing");
  return {
    id: entry.id,
    surface: entry.surface,
    commandActionInput: entry.input,
    currentImplementationFile: entry.implementationFile,
    documentedLocation: entry.documentedLocation || formatLocations(docsFound),
    expectedBehavior: entry.expected,
    approvalRequired: entry.approval ? "yes" : "no",
    daemonRequired: entry.daemon ? "yes" : "no",
    liveOpenRouterRequired: entry.liveOpenRouter ? "yes" : "no",
    testsCurrentlyCoveringIt: formatLocations(testsFound),
    missingTests: testsFound.length > 0 ? "" : `Add or link tests for ${entry.input}.`,
    status
  };
}

function discoverMenuItems(source) {
  const constants = {};
  for (const match of source.matchAll(/(Action[A-Za-z0-9]+)\s*=\s*"([^"]+)"/g)) {
    constants[match[1]] = match[2];
  }
  const items = [];
  let context = "pane";
  for (const line of source.split(/\r?\n/)) {
    if (line.includes("func AssistantMenu")) {
      context = "assistant";
    }
    const match = line.match(/\{Label:\s*"([^"]+)",\s*Action:\s*(Action[A-Za-z0-9]+)/);
    if (!match) continue;
    items.push({
      context,
      label: match[1],
      constant: match[2],
      action: constants[match[2]] ?? match[2]
    });
  }
  return items;
}

function discoverAgentTools(fileCache) {
  const tools = [];
  for (const [file, source] of Object.entries(fileCache)) {
    if (!file.startsWith("src/agent/tools/") || file.endsWith("common.ts") || file.endsWith("index.ts")) continue;
    const name = source.match(/name:\s*"([^"]+)"/)?.[1];
    if (!name) continue;
    const approval = source.match(/approvalRequired:\s*(true|false)/)?.[1] === "true";
    const description = source.match(/description:\s*([\s\S]*?),\s*approvalRequired:/)?.[1] ?? "";
    tools.push({
      name,
      file,
      approvalRequired: approval,
      description: cleanDescription(description)
    });
  }
  return tools.sort((left, right) => left.name.localeCompare(right.name));
}

function cleanDescription(raw) {
  return raw
    .replace(/["`]/g, "")
    .replace(/\s*\+\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function discoverRuntimeHeadings(source) {
  const ignored = new Set(["Registry Flow", "Tiering"]);
  return [...source.matchAll(/^###\s+(.+)$/gm)]
    .map((match) => match[1].trim())
    .filter((heading) => !ignored.has(heading));
}

function discoverDocOnlySlashCommands(docCache, rows) {
  const existingInputs = new Set(
    rows.filter((entry) => entry.surface === "slash").map((entry) => entry.commandActionInput)
  );
  const docCommands = new Set();
  for (const file of ["docs/tui-keymap.md", "docs/tui-setup-onboarding.md"]) {
    const text = docCache[file] ?? "";
    for (const match of text.matchAll(/^[-*]\s+`?(\/[A-Za-z][^`\r\n]*)`?\s*$/gm)) {
      const command = (match[1] ?? match[2] ?? "").trim();
      if (!command.startsWith("/")) continue;
      docCommands.add(command);
    }
  }
  return [...docCommands]
    .filter((command) => !existingInputs.has(command))
    .sort()
    .map((command) => ({
      id: `docs.slash.${slug(command)}`,
      surface: "docs",
      input: command,
      implementationFile: "tui/internal/tui/slash/slash.go",
      expected: "Documented slash command variant; verify parser/model handling.",
      approval:
        /launch|stop|restart|register|open|prove|health|component|manifest edit|port pinned|add app|configure(?!.*dry-run)/.test(
          command
        ),
      daemon: !/help|theme|page|pin|unpin|pane color|confirm|cancel/.test(command),
      liveOpenRouter: false,
      statusOverride: "partial",
      tokens: [command]
    }));
}

function implementationForDiagnostic(input) {
  if (input.startsWith("SETUP_")) return "src/setupApi.ts; src/setupRuntimeAdapters.ts";
  if (input.startsWith("agent_")) return "src/agent/gateway.ts; tui/internal/tui/model/model.go";
  if (input.includes("clipboard") || input.includes("browser")) return "src/agent/tools/proposeTuiAction.ts";
  return "tui/internal/tui/model/model.go";
}

function expectedForMenuAction(action) {
  const mapping = {
    "pane.close": "Close selected pane locally.",
    "pane.pin_toggle": "Pin or unpin selected pane locally.",
    "pane.reopen": "Reopen a hidden/stopped pane when a reopen candidate exists.",
    "pane.color": "Change selected pane color locally.",
    "pane.copy_route": "Show route text when available; clipboard copy remains unavailable unless real support exists.",
    "pane.export_logs": "Show confirmation, then request daemon pane log export.",
    "pane.stop": "Show confirmation, then request daemon stop for selected app/component.",
    "pane.restart": "Show confirmation, then request daemon restart for selected app/component.",
    "pane.diagnostics": "Show current diagnostics.",
    "assistant.history": "Expand/collapse assistant history locally.",
    "assistant.new_thread":
      "Create daemon-backed Operator Agent thread when available or local-only fallback when disabled.",
    "assistant.clear_input": "Clear current assistant input locally.",
    "assistant.bar_color": "Cycle assistant bar color locally.",
    "assistant.export_chat":
      "Export active daemon-backed thread when available; otherwise show unavailable diagnostic.",
    "assistant.command_help": "Show command help locally.",
    "assistant.llm_mode": "Show Operator Agent/LLM mode status and diagnostics."
  };
  return mapping[action] ?? `Execute menu action ${action}.`;
}

function findLocations(cache, tokens) {
  const locations = [];
  const normalizedTokens = compact(tokens)
    .map((token) => String(token).trim())
    .filter((token) => token.length > 1);
  for (const [file, text] of Object.entries(cache)) {
    const lines = text.split(/\r?\n/);
    for (const token of normalizedTokens) {
      const terms = tokenTerms(token);
      for (let index = 0; index < lines.length; index += 1) {
        const lower = lines[index].toLowerCase();
        if (terms.some((term) => lower.includes(term))) {
          locations.push({ file, line: index + 1 });
          break;
        }
      }
      if (locations.some((location) => location.file === file)) break;
    }
  }
  return uniqueLocations(locations).slice(0, 4);
}

function tokenTerms(token) {
  const lower = token.toLowerCase();
  const terms = new Set([lower]);
  if (lower.includes("|")) {
    for (const part of lower.split("|")) terms.add(part.trim());
  }
  if (lower.startsWith("/")) {
    terms.add(lower.split(/\s+/).slice(0, 2).join(" "));
  }
  if (lower.includes(".")) terms.add(lower.replaceAll(".", "_"));
  if (lower.includes("-")) terms.add(lower.replaceAll("-", "_"));
  return [...terms].filter((term) => term.length > 1);
}

function uniqueLocations(locations) {
  const seen = new Set();
  const result = [];
  for (const location of locations) {
    const key = `${location.file}:${location.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(location);
  }
  return result;
}

function formatLocations(locations) {
  return locations.map((location) => `${location.file}:${location.line}`).join("; ");
}

function summarize(rows) {
  const byStatus = {};
  const bySurface = {};
  for (const row of rows) {
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    bySurface[row.surface] = (bySurface[row.surface] ?? 0) + 1;
  }
  return { byStatus, bySurface };
}

function renderMarkdown(artifact) {
  const lines = [
    "# Agent TUI Command Matrix",
    "",
    "Generated by `npm run agent-tui:inventory`.",
    "",
    "This inventory is a source-derived planning and verification surface. It does not claim live OpenRouter, daemon, lifecycle, or TUI behavior passed unless a row links to existing tests/evidence. Rows marked `partial`, `missing`, `unavailable`, or `blocked` are not complete coverage claims.",
    "",
    "## Summary",
    "",
    `- Rows: ${artifact.rowCount}`,
    ...Object.entries(artifact.summary.bySurface)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([surface, count]) => `- Surface ${surface}: ${count}`),
    ...Object.entries(artifact.summary.byStatus)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([status, count]) => `- Status ${status}: ${count}`),
    "",
    "## Matrix",
    "",
    "| ID | Surface | Command/action/input | Implementation | Docs | Expected behavior | Approval | Daemon | Live OpenRouter | Tests | Missing tests | Status |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
  ];
  for (const row of artifact.rows) {
    lines.push(
      [
        row.id,
        row.surface,
        row.commandActionInput,
        row.currentImplementationFile,
        row.documentedLocation || "",
        row.expectedBehavior,
        row.approvalRequired,
        row.daemonRequired,
        row.liveOpenRouterRequired,
        row.testsCurrentlyCoveringIt || "",
        row.missingTests || "",
        row.status
      ]
        .map(markdownCell)
        .join(" | ")
        .replace(/^/, "| ")
        .replace(/$/, " |")
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function markdownCell(value) {
  return String(value ?? "")
    .replaceAll("\n", " ")
    .replaceAll("|", "\\|")
    .trim();
}

function compact(values) {
  return values.filter((value) => value !== undefined && value !== null && String(value).trim() !== "");
}

function pick(object, keys) {
  return Object.fromEntries(keys.map((key) => [key, object[key] ?? ""]));
}

function normalizePath(file) {
  return file.split(path.sep).join("/");
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
