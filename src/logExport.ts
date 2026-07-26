import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createRelaybaseError } from "./apiErrors.ts";
import type {
  LogExportFormat,
  LogExportRequest,
  LogExportResult,
  LogExportScope,
  RedactionReport,
  RelaybaseError
} from "./apiTypes.ts";
import { getRelaybaseState } from "./appState.ts";
import type { DurableLogEvent, LogStoreQuery } from "./logStore.ts";
import { emptyRedactionReport, mergeRedactionReports, redactForExport, redactValueForExport } from "./redaction.ts";
import type { RelaybaseRuntime } from "./server.ts";
import type { AppComponentRole, AppRecord, AppState } from "./types.ts";
import { createStoredZip } from "./zip.ts";

export class LogExportRequestError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly detail?: unknown;
  readonly userAction?: string;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    options: { retryable?: boolean; detail?: unknown; userAction?: string } = {}
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.detail = options.detail;
    this.userAction = options.userAction;
  }
}

interface NormalizedLogExportRequest extends LogExportRequest {
  scope: LogExportScope;
  format: LogExportFormat;
  redact: true;
}

const EXPORT_MAX_EVENTS = 50_000;
const EXPORT_FORMATS = new Set<LogExportFormat>(["log", "jsonl", "zip"]);
const EXPORT_SCOPES = new Set<LogExportScope>(["pane", "app", "group", "page", "all"]);
const COMPONENT_ROLES = new Set<AppComponentRole>(["frontend", "backend", "worker", "database", "service", "other"]);

export class LogExportService {
  readonly rootDir: string;
  #runtime: RelaybaseRuntime;
  #exports = new Map<string, LogExportResult>();

  constructor(runtime: RelaybaseRuntime) {
    this.#runtime = runtime;
    this.rootDir = path.join(runtime.stateDir, "exports");
  }

  get(exportId: string): LogExportResult | undefined {
    const result = this.#exports.get(exportId);
    return result ? cloneExportResult(result) : undefined;
  }

  async create(input: unknown, correlationId: string): Promise<LogExportResult> {
    const request = await this.#normalizeAndValidate(input);
    const exportId = `exp_${randomUUID()}`;
    const startedAt = new Date().toISOString();
    const outputPath = await this.#outputPath(exportId, request);
    const result: LogExportResult = {
      exportId,
      status: "running",
      format: request.format,
      outputPath,
      includedApps: [],
      includedGroups: [],
      includedComponents: [],
      startedAt,
      redactionReport: emptyRedactionReport()
    };
    this.#exports.set(exportId, result);
    this.#publish("export.started", result, correlationId, { progress: 0, message: "Log export started." });

    try {
      const state = await getRelaybaseState(this.#runtime);
      const events = await this.#selectEvents(request);
      const redacted = this.#redactEvents(events);
      mergeRedactionReports(result.redactionReport, redacted.report);
      this.#publish("export.progress", result, correlationId, {
        progress: 40,
        message: `Selected ${redacted.events.length} log event(s).`
      });

      const bundle = await this.#buildBundle(request, redacted.events, state, result.redactionReport);
      const artifact = await this.#renderArtifact(request.format, bundle, result.redactionReport);
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, artifact);
      const stat = await fs.stat(outputPath);
      const included = includedTargets(request, redacted.events, state.apps);

      result.status = "succeeded";
      result.completedAt = new Date().toISOString();
      result.sizeBytes = stat.size;
      result.includedApps = included.apps;
      result.includedGroups = included.groups;
      result.includedComponents = included.components;
      this.#exports.set(exportId, result);
      this.#publish("export.progress", result, correlationId, {
        progress: 100,
        message: "Log export artifact written."
      });
      this.#publish("export.completed", result, correlationId);
      return cloneExportResult(result);
    } catch (error) {
      const relaybaseError = createRelaybaseError({
        code: "LOG_EXPORT_FAILED",
        message: error instanceof Error ? error.message : "Relaybase log export failed.",
        retryable: true,
        detail: { exportId, outputPath },
        userAction: "Inspect the export status and daemon log diagnostics before retrying.",
        correlationId
      });
      result.status = "failed";
      result.completedAt = new Date().toISOString();
      result.error = relaybaseError;
      this.#exports.set(exportId, result);
      this.#publish("export.failed", result, correlationId);
      return cloneExportResult(result);
    }
  }

  async #normalizeAndValidate(input: unknown): Promise<NormalizedLogExportRequest> {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new LogExportRequestError(400, "INVALID_LOG_EXPORT_REQUEST", "Log export request must be a JSON object.", {
        userAction: "Send a JSON body with scope, format, and optional filters."
      });
    }

    const raw = input as Record<string, unknown>;
    const scope = requireEnum(raw.scope, EXPORT_SCOPES, "scope", "INVALID_LOG_EXPORT_SCOPE");
    const format = requireEnum(raw.format, EXPORT_FORMATS, "format", "INVALID_LOG_EXPORT_FORMAT");
    const componentRole =
      raw.componentRole === undefined
        ? undefined
        : requireEnum(raw.componentRole, COMPONENT_ROLES, "componentRole", "INVALID_LOG_EXPORT_COMPONENT_ROLE");
    const appId = optionalString(raw.appId, "appId");
    const groupId = optionalString(raw.groupId, "groupId");
    const destination = optionalString(raw.destination, "destination");
    const startTime = optionalIsoTime(raw.startTime, "startTime");
    const endTime = optionalIsoTime(raw.endTime, "endTime");
    const limit = optionalPositiveInt(raw.limit, "limit");
    const paneIds = optionalStringArray(raw.paneIds, "paneIds");

    if (raw.redact === false) {
      throw new LogExportRequestError(
        400,
        "UNREDACTED_LOG_EXPORT_UNSUPPORTED",
        "Unredacted log export is not supported by this daemon.",
        {
          userAction: "Retry without redact:false. Relaybase exports are redacted by default."
        }
      );
    }

    if (raw.redact !== undefined && typeof raw.redact !== "boolean") {
      throw new LogExportRequestError(400, "INVALID_LOG_EXPORT_REDACT", "redact must be a boolean when provided.", {
        detail: { redact: raw.redact },
        userAction: "Use redact:true or omit the field for the default redacted export."
      });
    }

    if (startTime && endTime && Date.parse(startTime) > Date.parse(endTime)) {
      throw new LogExportRequestError(400, "INVALID_LOG_EXPORT_TIME_RANGE", "startTime must be before endTime.", {
        detail: { startTime, endTime },
        userAction: "Use an ISO startTime earlier than endTime."
      });
    }

    await this.#validateScope({ scope, appId, groupId, componentRole, paneIds });

    return {
      scope,
      format,
      ...(appId ? { appId } : {}),
      ...(groupId ? { groupId } : {}),
      ...(componentRole ? { componentRole } : {}),
      ...(paneIds ? { paneIds } : {}),
      ...(startTime ? { startTime } : {}),
      ...(endTime ? { endTime } : {}),
      ...(limit ? { limit } : {}),
      ...(destination ? { destination } : {}),
      redact: true
    };
  }

  async #validateScope(input: {
    scope: LogExportScope;
    appId?: string;
    groupId?: string;
    componentRole?: AppComponentRole;
    paneIds?: string[];
  }): Promise<void> {
    if (input.scope === "app") {
      if (!input.appId) {
        throw new LogExportRequestError(400, "LOG_EXPORT_APP_REQUIRED", "app scope requires appId.", {
          userAction: "Provide appId for app-scoped log exports."
        });
      }
      await this.#requireApp(input.appId);
    }

    if (input.scope === "group") {
      if (!input.groupId) {
        throw new LogExportRequestError(400, "LOG_EXPORT_GROUP_REQUIRED", "group scope requires groupId.", {
          userAction: "Provide groupId for group-scoped log exports."
        });
      }
      await this.#requireGroup(input.groupId);
    }

    if (input.scope === "pane") {
      if (input.paneIds?.length) {
        throw new LogExportRequestError(
          400,
          "LOG_EXPORT_PANE_IDS_UNSUPPORTED",
          "paneIds are reserved for a future native pane model.",
          {
            detail: { paneIds: input.paneIds },
            userAction: "Use componentRole for current pane-scoped exports."
          }
        );
      }
      if (!input.componentRole) {
        throw new LogExportRequestError(
          400,
          "LOG_EXPORT_PANE_ROLE_REQUIRED",
          "pane scope requires componentRole until native panes exist.",
          {
            userAction: "Provide componentRole such as frontend or backend."
          }
        );
      }
    }

    if (input.appId) {
      await this.#requireApp(input.appId);
    }
    if (input.groupId) {
      await this.#requireGroup(input.groupId);
    }
  }

  async #requireApp(appId: string): Promise<void> {
    if (await this.#runtime.registry.get(appId)) {
      return;
    }

    throw new LogExportRequestError(404, "LOG_EXPORT_APP_NOT_FOUND", "Cannot export logs for an unknown app.", {
      detail: { appId },
      userAction: "Refresh /__hub/api/state and choose a registered app."
    });
  }

  async #requireGroup(groupId: string): Promise<void> {
    const state = await getRelaybaseState(this.#runtime);
    if (state.groups.some((group) => group.groupId === groupId)) {
      return;
    }

    throw new LogExportRequestError(404, "LOG_EXPORT_GROUP_NOT_FOUND", "Cannot export logs for an unknown app group.", {
      detail: { groupId },
      userAction: "Refresh /__hub/api/state and choose an existing group."
    });
  }

  async #selectEvents(request: NormalizedLogExportRequest): Promise<DurableLogEvent[]> {
    const query: LogStoreQuery = {
      limit: request.limit ?? EXPORT_MAX_EVENTS
    };

    if (request.scope === "app" || request.scope === "page") {
      if (request.appId) {
        query.appId = request.appId;
      }
    }
    if (request.scope === "group" || request.scope === "page") {
      if (request.groupId) {
        query.groupId = request.groupId;
      }
    }
    if (request.scope === "pane" || request.scope === "page") {
      if (request.componentRole) {
        query.componentRole = request.componentRole;
      }
    }

    const result = await this.#runtime.logStore.query(query);
    return filterByTime(result.events, request.startTime, request.endTime);
  }

  #redactEvents(events: DurableLogEvent[]): { events: DurableLogEvent[]; report: RedactionReport } {
    const report = emptyRedactionReport();
    const redactedEvents = events.map((event) => {
      const redaction = redactForExport(event.message, { extraSecrets: [this.#runtime.token] });
      mergeRedactionReports(report, redaction.report);
      return {
        ...event,
        message: redaction.value,
        line: redaction.value,
        redacted: event.redacted || redaction.redacted
      };
    });

    return { events: redactedEvents, report };
  }

  async #buildBundle(
    request: NormalizedLogExportRequest,
    events: DurableLogEvent[],
    state: Awaited<ReturnType<typeof getRelaybaseState>>,
    report: RedactionReport
  ): Promise<ExportBundle> {
    const apps = await this.#runtime.registry.list();
    const selectedAppIds = new Set(includedTargets(request, events, state.apps).apps);
    const metadata = apps.filter((app) => selectedAppIds.has(app.id)).map(safeAppMetadata);
    const routeHealth = state.apps
      .filter((app) => selectedAppIds.has(app.id))
      .map((app) => ({
        appId: app.id,
        routeReachable: app.routeReachable,
        routeHealth: app.routeHealth,
        readiness: app.readiness
      }));
    const diagnostics = {
      stateDiagnostics: state.diagnostics ?? [],
      logStore: this.#runtime.logStore.health()
    };

    const bundle = {
      request: {
        scope: request.scope,
        format: request.format,
        appId: request.appId,
        groupId: request.groupId,
        componentRole: request.componentRole,
        startTime: request.startTime,
        endTime: request.endTime,
        limit: request.limit,
        redact: true
      },
      logs: events,
      appMetadata: metadata,
      stateSnapshot: state,
      routeHealth,
      diagnostics
    };
    const redactedBundle = redactValueForExport(bundle, { extraSecrets: [this.#runtime.token] });
    mergeRedactionReports(report, redactedBundle.report);
    return redactedBundle.value as ExportBundle;
  }

  async #renderArtifact(format: LogExportFormat, bundle: ExportBundle, report: RedactionReport): Promise<Buffer> {
    const redactionReport = `${JSON.stringify(report, null, 2)}\n`;
    if (format === "jsonl") {
      return Buffer.from(bundle.logs.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
    }

    const textLog = renderTextLog(bundle.logs);
    if (format === "log") {
      return Buffer.from(textLog, "utf8");
    }

    return createStoredZip([
      { name: "logs/export.log", data: textLog },
      { name: "logs/export.jsonl", data: bundle.logs.map((event) => JSON.stringify(event)).join("\n") + "\n" },
      { name: "metadata/apps.json", data: `${JSON.stringify(bundle.appMetadata, null, 2)}\n` },
      { name: "metadata/state.json", data: `${JSON.stringify(bundle.stateSnapshot, null, 2)}\n` },
      { name: "metadata/route-health.json", data: `${JSON.stringify(bundle.routeHealth, null, 2)}\n` },
      { name: "diagnostics/diagnostics.json", data: `${JSON.stringify(bundle.diagnostics, null, 2)}\n` },
      { name: "manifest.json", data: `${JSON.stringify(bundle.request, null, 2)}\n` },
      { name: "redaction_report.json", data: redactionReport }
    ]);
  }

  async #outputPath(exportId: string, request: NormalizedLogExportRequest): Promise<string> {
    const extension = request.format;
    const defaultPath = path.join(this.rootDir, exportId, `relaybase-logs-${exportId}.${extension}`);
    if (!request.destination) {
      return defaultPath;
    }

    const destination = path.resolve(request.destination);
    const allowedRoot = path.resolve(this.rootDir);
    const relative = path.relative(allowedRoot, destination);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new LogExportRequestError(
        400,
        "LOG_EXPORT_DESTINATION_OUTSIDE_EXPORTS",
        "Custom export destinations must stay inside the Relaybase exports directory.",
        {
          detail: { destination, exportsDir: allowedRoot },
          userAction: "Omit destination or choose a path under the daemon state exports directory."
        }
      );
    }

    await fs.mkdir(path.dirname(destination), { recursive: true });
    return destination;
  }

  #publish(
    type: "export.started" | "export.progress" | "export.completed" | "export.failed",
    result: LogExportResult,
    correlationId: string,
    progress?: { progress: number; message: string }
  ): void {
    this.#runtime.events.publish({
      type,
      operationId: result.exportId,
      correlationId,
      data: {
        export: cloneExportResult(result),
        ...(progress ? { progress } : {})
      }
    });
  }
}

interface ExportBundle {
  request: Record<string, unknown>;
  logs: DurableLogEvent[];
  appMetadata: ReturnType<typeof safeAppMetadata>[];
  stateSnapshot: Awaited<ReturnType<typeof getRelaybaseState>>;
  routeHealth: Array<{
    appId: string;
    routeReachable: boolean;
    routeHealth?: AppState["routeHealth"];
    readiness: AppState["readiness"];
  }>;
  diagnostics: Record<string, unknown>;
}

function requireEnum<T extends string>(value: unknown, allowed: Set<T>, field: string, code: string): T {
  if (typeof value === "string" && allowed.has(value as T)) {
    return value as T;
  }

  throw new LogExportRequestError(400, code, `${field} must be one of: ${[...allowed].join(", ")}.`, {
    detail: { field, value },
    userAction: "Use the documented log export request schema."
  });
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  throw new LogExportRequestError(400, "INVALID_LOG_EXPORT_FIELD", `${field} must be a non-empty string.`, {
    detail: { field, value },
    userAction: "Use the documented log export request schema."
  });
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim())) {
    return value.map((item) => item.trim());
  }
  throw new LogExportRequestError(400, "INVALID_LOG_EXPORT_FIELD", `${field} must be an array of strings.`, {
    detail: { field, value },
    userAction: "Use the documented log export request schema."
  });
}

function optionalIsoTime(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  throw new LogExportRequestError(400, "INVALID_LOG_EXPORT_TIME", `${field} must be an ISO timestamp.`, {
    detail: { field, value },
    userAction: "Use ISO timestamps for log export time ranges."
  });
}

function optionalPositiveInt(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return value;
  }
  throw new LogExportRequestError(400, "INVALID_LOG_EXPORT_LIMIT", `${field} must be a positive integer.`, {
    detail: { field, value },
    userAction: "Use a positive integer limit."
  });
}

function filterByTime(events: DurableLogEvent[], startTime?: string, endTime?: string): DurableLogEvent[] {
  const start = startTime ? Date.parse(startTime) : undefined;
  const end = endTime ? Date.parse(endTime) : undefined;
  return events
    .filter((event) => (start === undefined ? true : Date.parse(event.timestamp) >= start))
    .filter((event) => (end === undefined ? true : Date.parse(event.timestamp) <= end));
}

function includedTargets(
  request: NormalizedLogExportRequest,
  events: DurableLogEvent[],
  states: AppState[]
): { apps: string[]; groups: string[]; components: string[] } {
  const apps = new Set(events.map((event) => event.appId));
  const groups = new Set(events.map((event) => event.groupId));
  const components = new Set(events.map((event) => `${event.appId}:${event.componentRole}`));

  if (request.appId) {
    apps.add(request.appId);
  }
  if (request.groupId) {
    groups.add(request.groupId);
  }
  if (request.scope === "all") {
    for (const state of states) {
      apps.add(state.id);
    }
  }

  return {
    apps: [...apps].sort(),
    groups: [...groups].sort(),
    components: [...components].sort()
  };
}

function safeAppMetadata(app: AppRecord): Record<string, unknown> {
  return {
    id: app.id,
    name: app.name,
    protocol: app.protocol,
    cwd: app.cwd,
    healthUrl: app.healthUrl,
    upstreamPort: app.upstreamPort,
    manifestPath: app.manifestPath,
    createdAt: app.createdAt,
    updatedAt: app.updatedAt,
    envVarCount: Object.keys(app.env).length,
    mcpEnabled: app.mcp?.enabled === true,
    ...(app.relaybase ? { relaybase: app.relaybase } : {}),
    ...(app.manifestDiagnostics?.length ? { manifestDiagnostics: app.manifestDiagnostics } : {})
  };
}

function renderTextLog(events: DurableLogEvent[]): string {
  return events
    .map((event) =>
      [
        event.timestamp,
        event.appId,
        event.groupId,
        event.componentRole,
        event.stream,
        event.level,
        event.message.replace(/\r?\n/g, "\\n")
      ].join(" ")
    )
    .join("\n")
    .concat(events.length ? "\n" : "");
}

function cloneExportResult(result: LogExportResult): LogExportResult {
  return {
    ...result,
    includedApps: [...result.includedApps],
    includedGroups: [...result.includedGroups],
    includedComponents: [...result.includedComponents],
    redactionReport: {
      replacements: result.redactionReport.replacements,
      categories: { ...result.redactionReport.categories }
    },
    ...(result.error ? { error: cloneRelaybaseError(result.error) } : {})
  };
}

function cloneRelaybaseError(error: RelaybaseError): RelaybaseError {
  return {
    ...error,
    ...(error.detail === undefined ? {} : { detail: JSON.parse(JSON.stringify(error.detail)) as unknown })
  };
}
