import path from "node:path";
import type { AgentRunEventType } from "./types.ts";

export type AgentActivityState = "active" | "waiting_approval" | "completed" | "failed" | "cancelled" | "info";

export interface AgentActivityProjection {
  id: string;
  kind: "run" | "processing" | "tool" | "approval" | "handoff" | "search";
  state: AgentActivityState;
  label: string;
  detail?: string;
  output?: string;
  outputLineCount?: number;
  outputTruncated?: boolean;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
}

type ToolLabels = { active: string; completed: string };

const TOOL_LABELS: Record<string, ToolLabels> = {
  list_apps: labels("Listing registered apps", "Listed registered apps"),
  get_app_state: labels("Inspecting app state", "Inspected app state"),
  get_app_group: labels("Inspecting app group", "Inspected app group"),
  get_current_context: labels("Reading current TUI context", "Read current TUI context"),
  get_agent_capabilities: labels("Inspecting Agent capabilities", "Inspected Agent capabilities"),
  explain_app_problem: labels("Explaining app problem", "Explained app problem"),
  get_diagnostics: labels("Reading diagnostics", "Read diagnostics"),
  get_operation_status: labels("Checking operation status", "Checked operation status"),
  list_operations: labels("Listing operations", "Listed operations"),
  tail_logs: labels("Reading recent logs", "Read recent logs"),
  search_logs: labels("Searching logs", "Searched logs"),
  project_list_files: labels("Listing project files", "Listed project files"),
  project_search_files: labels("Searching project files", "Searched project files"),
  project_read_file: labels("Reading project file", "Read project file"),
  project_detect_start_commands: labels("Detecting start commands", "Detected start commands"),
  project_inspect_package_scripts: labels("Inspecting package scripts", "Inspected package scripts"),
  discover_project_roots: labels("Discovering project roots", "Discovered project roots"),
  start_app: labels("Starting app", "Started app"),
  stop_app: labels("Stopping app", "Stopped app"),
  restart_app: labels("Restarting app", "Restarted app"),
  export_logs: labels("Exporting app logs", "Exported app logs"),
  detect_project: labels("Inspecting project", "Inspected project"),
  plan_app_setup: labels("Building setup plan", "Built setup plan"),
  preview_setup_writes: labels("Previewing setup changes", "Previewed setup changes"),
  apply_setup_plan: labels("Applying setup plan", "Applied setup plan"),
  register_manifest: labels("Registering app manifest", "Registered app manifest"),
  inspect_manifest: labels("Inspecting app manifest", "Inspected app manifest"),
  validate_manifest: labels("Validating app manifest", "Validated app manifest"),
  patch_manifest_fields: labels("Updating app manifest", "Updated app manifest"),
  set_health_route: labels("Updating health route", "Updated health route"),
  set_pinned_port: labels("Updating pinned port", "Updated pinned port"),
  set_component_metadata: labels("Updating component metadata", "Updated component metadata"),
  add_env_override_safe: labels("Adding safe environment override", "Added safe environment override"),
  open_project_or_app: labels("Opening project or app", "Opened project or app"),
  setup_and_start_project: labels("Setting up and starting project", "Set up and started project"),
  prove_app_health: labels("Proving app health", "Proved app health"),
  repair_app_setup: labels("Repairing app setup", "Repaired app setup"),
  propose_tui_action: labels("Preparing TUI action", "Prepared TUI action")
};

const MAX_ACTIVITY_OUTPUT_CHARS = 32_000;
const MAX_ACTIVITY_OUTPUT_LINES = 200;

export class AgentActivityProjector {
  readonly #started = new Map<string, string>();
  readonly #finished = new Map<string, AgentActivityProjection>();

  project(type: AgentRunEventType, data: unknown, runId: string, at: string): AgentActivityProjection | undefined {
    const record = objectRecord(data);
    if (type === "run.started") {
      return this.#active(`run:${runId}`, "run", "Analyzing request…", at);
    }
    if (type === "run.completed" || type === "run.finalized") {
      const failed = type === "run.finalized" && text(record.outcome) !== "completed";
      return this.#finish(
        `run:${runId}`,
        "run",
        failed ? "Request failed" : "Request completed",
        failed ? "failed" : "completed",
        at
      );
    }
    if (type === "run.failed") {
      return this.#finish(`run:${runId}`, "run", "Request failed", "failed", at);
    }
    if (
      type === "model.processing_started" ||
      type === "model.processing_completed" ||
      type === "model.processing_failed"
    ) {
      const id = `processing:${runId}:${safeToken(record.turnId ?? record.responseId ?? "turn")}`;
      const activeLabel = text(record.label) || "Thinking";
      const completedLabel =
        text(record.completedLabel) || (activeLabel === "Reviewing tool result" ? "Reviewed tool result" : "Thought");
      if (type === "model.processing_started") {
        return this.#active(id, "processing", activeLabel, at);
      }
      return this.#finish(
        id,
        "processing",
        type === "model.processing_failed" ? `${activeLabel} interrupted` : completedLabel,
        type === "model.processing_failed" ? "failed" : "completed",
        at
      );
    }
    if (type === "agent.handoff_started" || type === "agent.handoff_completed") {
      const id = `handoff:${runId}:${safeToken(record.handoffId ?? record.targetAgent ?? "agent")}`;
      return type.endsWith("started")
        ? this.#active(id, "handoff", "Handing off to another agent", at)
        : this.#finish(id, "handoff", "Agent handoff completed", "completed", at);
    }
    if (type === "tool.search_started" || type === "tool.search_completed") {
      const id = `search:${runId}:${safeToken(record.searchId ?? "tools")}`;
      return type.endsWith("started")
        ? this.#active(id, "search", "Searching available tools", at)
        : this.#finish(id, "search", "Searched available tools", "completed", at);
    }

    const approval = objectRecord(record.approval);
    const toolName = text(record.toolName ?? record.tool ?? approval.toolName ?? approval.action);
    const approvalId = text(record.approvalId ?? approval.id);
    const callId = text(record.toolCallId ?? approval.toolCallId);
    const toolId = `tool:${callId || approvalId || `${runId}:${safeToken(toolName || "tool")}`}`;
    const toolLabels = labelsForTool(toolName);
    const detail = safeActivityDetail(objectRecord(record.arguments ?? approval.arguments), record.result);
    const output =
      type === "tool.completed" || type === "tool.failed"
        ? safeActivityOutput(toolName, record.result ?? record.error ?? record.diagnostic)
        : undefined;

    if (type === "tool.started") {
      return { ...this.#active(toolId, "tool", toolLabels.active, at), ...(detail ? { detail } : {}) };
    }
    if (type === "tool.completed") {
      return {
        ...this.#finish(toolId, "tool", toolLabels.completed, "completed", at),
        ...(detail ? { detail } : {}),
        ...output
      };
    }
    if (type === "tool.failed") {
      return {
        ...this.#finish(toolId, "tool", `${toolLabels.active} failed`, "failed", at),
        ...(detail ? { detail } : {}),
        ...output
      };
    }
    if (type === "tool.approval_required" || type === "approval_required") {
      return {
        ...this.#finish(toolId, "tool", `Approval required: ${toolLabels.active}`, "waiting_approval", at),
        ...(detail ? { detail } : {})
      };
    }
    if (type === "tool.approved") {
      return this.#active(toolId, "tool", `Resuming: ${toolLabels.active}`, at);
    }
    if (type === "tool.rejected") {
      return this.#finish(toolId, "tool", `Approval rejected: ${toolLabels.active}`, "cancelled", at);
    }
    return undefined;
  }

  #active(id: string, kind: AgentActivityProjection["kind"], label: string, at: string): AgentActivityProjection {
    this.#finished.delete(id);
    if (!this.#started.has(id)) this.#started.set(id, at);
    return { id, kind, state: "active", label, startedAt: this.#started.get(id) };
  }

  #finish(
    id: string,
    kind: AgentActivityProjection["kind"],
    label: string,
    state: AgentActivityState,
    at: string
  ): AgentActivityProjection {
    const startedAt = this.#started.get(id);
    const previous = this.#finished.get(id);
    if (state !== "waiting_approval") this.#started.delete(id);
    const durationMs = startedAt ? Math.max(0, Date.parse(at) - Date.parse(startedAt)) : undefined;
    const projection: AgentActivityProjection = {
      id,
      kind,
      state,
      label,
      ...(startedAt ? { startedAt } : {}),
      completedAt: at,
      ...(Number.isFinite(durationMs)
        ? { durationMs }
        : previous?.durationMs !== undefined
          ? { durationMs: previous.durationMs }
          : {})
    };
    if (state !== "waiting_approval") this.#finished.set(id, projection);
    return projection;
  }
}

function safeActivityOutput(
  toolName: string,
  result: unknown
): Pick<AgentActivityProjection, "output" | "outputLineCount" | "outputTruncated"> {
  const record = objectRecord(result);
  const displayValue = record.output ?? record.data ?? result;
  let rendered = renderActivityValue(displayValue);
  rendered = stripTerminalControls(rendered).trim();
  if (!rendered) rendered = "(no output)";

  let lines = rendered.split("\n");
  const outputLineCount = lines.length;
  let outputTruncated = false;
  if (lines.length > MAX_ACTIVITY_OUTPUT_LINES) {
    lines = lines.slice(
      toolName === "tail_logs" || toolName === "search_logs" ? -MAX_ACTIVITY_OUTPUT_LINES : 0,
      toolName === "tail_logs" || toolName === "search_logs" ? undefined : MAX_ACTIVITY_OUTPUT_LINES
    );
    outputTruncated = true;
  }
  rendered = lines.join("\n");
  if (rendered.length > MAX_ACTIVITY_OUTPUT_CHARS) {
    rendered = rendered.slice(0, MAX_ACTIVITY_OUTPUT_CHARS);
    outputTruncated = true;
  }
  return { output: rendered, outputLineCount, ...(outputTruncated ? { outputTruncated: true } : {}) };
}

function renderActivityValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  try {
    return JSON.stringify(sortActivityValue(value, 0), null, 2);
  } catch {
    return String(value);
  }
}

function sortActivityValue(value: unknown, depth: number): unknown {
  if (depth > 12) return "[bounded-depth]";
  if (Array.isArray(value)) return value.map((item) => sortActivityValue(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortActivityValue(nested, depth + 1)])
  );
}

function stripTerminalControls(value: string): string {
  const escape = String.fromCharCode(27);
  const bell = String.fromCharCode(7);
  const terminalSequence = new RegExp(
    `${escape}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${bell}]*(?:${bell}|${escape}\\\\)?|P[^${escape}]*(?:${escape}\\\\)?|[_^][^${escape}]*(?:${escape}\\\\)?)`,
    "g"
  );
  return Array.from(value.replace(terminalSequence, "").replace(/\r\n?/g, "\n"))
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code === 10 || (code >= 32 && !(code >= 127 && code <= 159));
    })
    .join("");
}

function labels(active: string, completed: string): ToolLabels {
  return { active, completed };
}
function labelsForTool(name: string): ToolLabels {
  return TOOL_LABELS[name] ?? labels(`Running ${humanize(name || "tool")}`, `Completed ${humanize(name || "tool")}`);
}
function humanize(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}
function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
function safeToken(value: unknown): string {
  return (
    text(value)
      .replace(/[^a-zA-Z0-9_.-]/g, "_")
      .slice(0, 80) || "unknown"
  );
}

function safeActivityDetail(args: Record<string, unknown>, result: unknown): string | undefined {
  const pathValue = text(args.path ?? args.filePath ?? args.cwd ?? args.projectRoot ?? args.manifestPath);
  if (pathValue) return path.basename(path.win32.basename(pathValue)).slice(0, 80);
  const app = text(args.appId ?? args.id ?? args.target);
  if (app) return app.slice(0, 80);
  const data = objectRecord(objectRecord(result).data ?? result);
  for (const key of ["count", "fileCount", "matchCount", "appCount"]) {
    if (typeof data[key] === "number" && Number.isFinite(data[key]))
      return `${data[key]} ${key.replace(/Count$/, "").toLowerCase()}${data[key] === 1 ? "" : "s"}`;
  }
  return undefined;
}
