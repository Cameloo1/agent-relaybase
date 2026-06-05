import type { AgentToolRisk } from "./types.ts";

export interface ToolPolicy {
  name: string;
  approvalRequired: boolean;
  risk: AgentToolRisk;
  expectedResult: string;
  sensitiveData: boolean;
  category: "read" | "lifecycle" | "export" | "setup" | "manifest" | "tui";
}

const POLICIES: ToolPolicy[] = [
  read("list_apps"),
  read("get_app_state"),
  read("get_app_group"),
  read("get_diagnostics"),
  read("tail_logs", { sensitiveData: true }),
  read("search_logs", { sensitiveData: true }),
  lifecycle("start_app", "Start a daemon-owned lifecycle operation and return an operationId."),
  lifecycle("stop_app", "Stop through a daemon-owned lifecycle operation and return an operationId."),
  lifecycle("restart_app", "Restart through a daemon-owned lifecycle operation and return an operationId."),
  gated("export_logs", "export", "high", "Create a redacted daemon-owned log export artifact.", true),
  read("detect_project", { category: "setup" }),
  read("plan_app_setup", { category: "setup" }),
  read("preview_setup_writes", { category: "setup", sensitiveData: true }),
  gated("apply_setup_plan", "setup", "high", "Apply approved setup writes and registration through daemon setup APIs."),
  gated("register_manifest", "manifest", "high", "Register or update the manifest through daemon registry APIs."),
  read("inspect_manifest", { category: "manifest", sensitiveData: true }),
  read("validate_manifest", { category: "manifest", sensitiveData: true }),
  gated("patch_manifest_fields", "manifest", "high", "Apply an approved safe manifest patch."),
  gated("set_health_route", "manifest", "medium", "Apply an approved manifest healthUrl change."),
  gated("set_pinned_port", "manifest", "medium", "Apply an approved manifest upstreamPort change."),
  gated("set_component_metadata", "manifest", "medium", "Apply approved Relaybase component metadata."),
  gated("add_env_override_safe", "manifest", "high", "Apply an approved safe env reference patch."),
  gated(
    "open_project_or_app",
    "setup",
    "high",
    "Open/register/start only through approved daemon setup/lifecycle APIs."
  ),
  gated(
    "setup_and_start_project",
    "setup",
    "high",
    "Run the approved setup/register/start phase through daemon-owned primitives only."
  ),
  gated("prove_app_health", "setup", "high", "Run approved daemon proof and write proof artifacts."),
  read("repair_app_setup", { category: "setup", sensitiveData: true }),
  read("propose_tui_action", { category: "tui" })
];

export function toolPolicy(name: string): ToolPolicy | undefined {
  return POLICIES.find((policy) => policy.name === name);
}

export function allToolPolicies(): ToolPolicy[] {
  return [...POLICIES];
}

export function approvalRequiredToolNames(): string[] {
  return POLICIES.filter((policy) => policy.approvalRequired).map((policy) => policy.name);
}

function read(name: string, options: { category?: ToolPolicy["category"]; sensitiveData?: boolean } = {}): ToolPolicy {
  return {
    name,
    approvalRequired: false,
    risk: options.sensitiveData ? "medium" : "low",
    expectedResult: "Return read-only daemon data without mutating user state.",
    sensitiveData: options.sensitiveData ?? false,
    category: options.category ?? "read"
  };
}

function lifecycle(name: string, expectedResult: string): ToolPolicy {
  return gated(name, "lifecycle", "high", expectedResult);
}

function gated(
  name: string,
  category: ToolPolicy["category"],
  risk: AgentToolRisk,
  expectedResult: string,
  sensitiveData = false
): ToolPolicy {
  return {
    name,
    approvalRequired: true,
    risk,
    expectedResult,
    sensitiveData,
    category
  };
}
