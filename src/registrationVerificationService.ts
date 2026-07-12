import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { compileLaunchPlan } from "./launchPlan.ts";
import { canBindPort } from "./ports.ts";
import { redactSecretLikeValues } from "./redaction.ts";
import type {
  RegistrationProofIdentity,
  RegistrationRepairOption,
  RegistrationVerificationFailure,
  RegistrationVerificationFailureCode,
  RegistrationVerificationPolicy,
  RegistrationVerificationRequest,
  RegistrationVerificationResult
} from "./registrationVerificationTypes.ts";
import type { RelaybaseRuntime } from "./server.ts";
import type { AppRecord, CompiledLaunchPlan, RuntimeView } from "./types.ts";

const ORDINARY_MAX_BUDGET_MS = 30_000;
const MAX_ATTEMPTS_PER_APP = 5;

export interface RegistrationVerificationRecord {
  schemaVersion: 1;
  kind: "registration_verification";
  correlationId: string;
  registrationPreviewId: string;
  appId: string;
  proof: RegistrationProofIdentity;
  selectedRepairId?: string;
  result: RegistrationVerificationResult;
  recordedAt: string;
  redactionCount: number;
}

export class RegistrationVerificationService {
  readonly runtime: RelaybaseRuntime;
  #attempts = new Map<string, RegistrationVerificationRecord[]>();
  #failedPlanDigests = new Map<string, Set<string>>();
  #active = new Map<string, AbortController>();

  constructor(runtime: RelaybaseRuntime) {
    this.runtime = runtime;
  }

  attempts(appId: string): RegistrationVerificationRecord[] {
    return [...(this.#attempts.get(appId) ?? [])];
  }

  repairOption(appId: string, repairId: string): RegistrationRepairOption | undefined {
    return this.#attempts
      .get(appId)
      ?.at(-1)
      ?.result.repairs.find((repair) => repair.id === repairId);
  }

  cleanupResolved(appId: string): boolean {
    return this.#attempts.get(appId)?.at(-1)?.result.status !== "cleanup_failed";
  }

  cancel(appId: string, reason = "user_cancelled"): boolean {
    const controller = this.#active.get(appId);
    if (!controller || controller.signal.aborted) return false;
    controller.abort(reason);
    return true;
  }

  async verify(request: RegistrationVerificationRequest): Promise<RegistrationVerificationResult> {
    if (request.policy.mode === "none") {
      return { attempted: false, status: "not_requested", repairs: [] };
    }
    if (this.#active.has(request.app.id)) {
      return failureResult(
        "REGISTER_VERIFY_UNSUPPORTED",
        "preflight",
        "A registration verification attempt is already active for this app.",
        "Wait for or cancel the active attempt before retrying.",
        false,
        null,
        []
      );
    }
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(request.signal?.reason ?? "caller_cancelled");
    request.signal?.addEventListener("abort", forwardAbort, { once: true });
    this.#active.set(request.app.id, controller);
    try {
      return await this.#verifyAttempt({ ...request, signal: controller.signal });
    } finally {
      request.signal?.removeEventListener("abort", forwardAbort);
      this.#active.delete(request.app.id);
    }
  }

  async #verifyAttempt(request: RegistrationVerificationRequest): Promise<RegistrationVerificationResult> {
    const started = Date.now();
    const policy = normalizePolicy(request.policy);
    const correlationId = `register_verify_${randomUUID()}`;
    const launchPlan = compileLaunchPlan(request.app, {
      host: this.runtime.host,
      port: request.app.upstreamPort ?? 17_000,
      hubPort: this.runtime.port
    });
    const proof = proofIdentity(request, launchPlan, policy);
    const previous = this.#attempts.get(request.app.id)?.at(-1);
    if (previous?.result.status === "verified" && JSON.stringify(previous.proof) === JSON.stringify(proof)) {
      const reused = { ...previous.result, attempted: false, reused: true, durationMs: 0 };
      this.#record(request, correlationId, proof, reused, 0);
      return reused;
    }
    const failedDigests = this.#failedPlanDigests.get(request.app.id) ?? new Set<string>();
    if (failedDigests.has(proof.launchPlanDigest)) {
      const result = failureResult(
        "REGISTER_VERIFY_UNSUPPORTED",
        "preflight",
        "This exact launch plan already failed verification and will not be repeated.",
        "Preview a different deterministic repair before retrying.",
        false,
        null,
        []
      );
      this.#record(request, correlationId, proof, result, 0);
      return result;
    }

    const preflight = await preflightApp(request.app, launchPlan, this.runtime.host);
    if (preflight) {
      const result = { ...preflight, durationMs: Date.now() - started };
      this.#record(request, correlationId, proof, result, 0);
      return result;
    }

    const lifecycleOptions = {
      signal: request.signal,
      verification: {
        registrationPreviewId: request.previewId,
        policyDigest: proof.policyDigest,
        startupBudgetMs: policy.startupBudgetMs,
        probeTimeoutMs: policy.probeTimeoutMs,
        stopBudgetMs: policy.stopBudgetMs,
        closureBudgetMs: policy.closureBudgetMs,
        candidateHealthTargets: request.healthCandidates,
        candidateHealthProbeLimit: policy.candidateHealthProbeLimit
      }
    };

    let startView: RuntimeView;
    try {
      startView = await this.runtime.processes.start(request.app.id, lifecycleOptions);
    } catch (error) {
      const logs = await this.#safeLogs(request.app.id);
      const result = classifyThrownStart(error, logs, Date.now() - started);
      failedDigests.add(proof.launchPlanDigest);
      this.#failedPlanDigests.set(request.app.id, failedDigests);
      this.#record(request, correlationId, proof, result, redactionCount(logs));
      return result;
    }

    const assignedPort = startView.assignedPort ?? startView.lastStartAttempt?.assignedPort;
    const startAttempt = startView.lastStartAttempt;
    const healthy = startView.status === "running" && startView.health === "healthy";
    let stopView: RuntimeView;
    try {
      stopView = await this.runtime.processes.stop(request.app.id, lifecycleOptions);
    } catch (error) {
      const logs = await this.#safeLogs(request.app.id);
      const result = failureResult(
        "REGISTER_VERIFY_STOP_FAILED",
        "stop",
        safeError(error),
        "Retry stop and inspect the remaining process before another verification attempt.",
        true,
        assignedPort ? true : null,
        logs,
        { assignedPort, startedAt: startView.startedAt, durationMs: Date.now() - started }
      );
      this.#record(request, correlationId, proof, result, redactionCount(logs));
      return result;
    }

    const stop =
      stopView.stopVerification?.portClosureVerified || !startView.stopVerification
        ? stopView.stopVerification
        : startView.stopVerification;
    const cleanupOk = Boolean(stop?.ok && (stop.portClosureVerified || launchPlan.port.ownership === "external"));
    const logs = healthy && cleanupOk ? [] : await this.#safeLogs(request.app.id);
    let result: RegistrationVerificationResult;
    if (!cleanupOk) {
      const code = stop?.backendPortOpen ? "REGISTER_VERIFY_PORT_STILL_OPEN" : "REGISTER_VERIFY_STOP_FAILED";
      result = failureResult(
        code,
        stop?.backendPortOpen ? "closure" : "stop",
        stop?.failureReason ?? "Relaybase could not prove that verification cleanup completed.",
        stop?.backendPortOpen
          ? "Identify and stop the remaining port owner before retrying."
          : "Retry stop or inspect the configured cleanup hooks.",
        stopView.status === "running",
        stop?.backendPortOpen ?? null,
        logs,
        {
          assignedPort,
          startedAt: startView.startedAt,
          stoppedAt: stopView.stoppedAt,
          durationMs: Date.now() - started,
          stop: stopSummary(stop)
        }
      );
    } else if (healthy) {
      const declaredTarget = request.app.healthUrl;
      result = {
        attempted: true,
        status: "verified",
        attemptId: startAttempt?.id,
        ...(assignedPort ? { assignedPort } : {}),
        ...(startView.startedAt ? { startedAt: startView.startedAt } : {}),
        healthyAt: startAttempt?.endedAt ?? new Date().toISOString(),
        ...(stopView.stoppedAt ? { stoppedAt: stopView.stoppedAt } : {}),
        durationMs: Date.now() - started,
        health: {
          ...(declaredTarget ? { declaredTarget, successfulTarget: declaredTarget } : {})
        },
        stop: stopSummary(stop),
        repairs: []
      };
    } else {
      result = classifyStartView(request.app, startView, stopView, stop, logs, Date.now() - started);
      failedDigests.add(proof.launchPlanDigest);
      this.#failedPlanDigests.set(request.app.id, failedDigests);
    }

    this.#record(request, correlationId, proof, result, redactionCount(logs));
    return result;
  }

  async #safeLogs(appId: string): Promise<string[]> {
    const lines = await this.runtime.processes.logs(appId, { limit: 20 });
    const app = await this.runtime.registry.get(appId);
    return lines
      .slice(-20)
      .map((line) => redactSecretLikeValues(line).value)
      .map((line) => redactProjectPaths(line, app));
  }

  #record(
    request: RegistrationVerificationRequest,
    correlationId: string,
    proof: RegistrationProofIdentity,
    result: RegistrationVerificationResult,
    redactions: number
  ): void {
    const record: RegistrationVerificationRecord = {
      schemaVersion: 1,
      kind: "registration_verification",
      correlationId,
      registrationPreviewId: request.previewId,
      appId: request.app.id,
      proof,
      ...(request.selectedRepairId ? { selectedRepairId: request.selectedRepairId } : {}),
      result,
      recordedAt: new Date().toISOString(),
      redactionCount: redactions
    };
    const next = [...(this.#attempts.get(request.app.id) ?? []), record].slice(-MAX_ATTEMPTS_PER_APP);
    this.#attempts.set(request.app.id, next);
    this.runtime.operations.recordEvidence({
      kind: "registration_verification",
      targetId: request.app.id,
      correlationId,
      status: result.status === "verified" ? "succeeded" : result.status === "not_requested" ? "skipped" : "failed",
      retryable: result.failure?.retryable === true,
      result: record
    });
  }
}

function normalizePolicy(policy: RegistrationVerificationPolicy): RegistrationVerificationPolicy {
  const bounded = (value: number, fallback: number) =>
    Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), ORDINARY_MAX_BUDGET_MS) : fallback;
  return {
    mode: policy.mode,
    startupBudgetMs: bounded(policy.startupBudgetMs, 8000),
    probeTimeoutMs: bounded(policy.probeTimeoutMs, 1000),
    stopBudgetMs: bounded(policy.stopBudgetMs, 5000),
    closureBudgetMs: bounded(policy.closureBudgetMs, 3000),
    candidateHealthProbeLimit: Math.min(Math.max(Math.floor(policy.candidateHealthProbeLimit), 0), 3)
  };
}

async function preflightApp(
  app: AppRecord,
  launchPlan: CompiledLaunchPlan,
  host: string
): Promise<RegistrationVerificationResult | undefined> {
  const cwd = await fs.stat(app.cwd).catch(() => undefined);
  if (!cwd?.isDirectory()) {
    return failureResult(
      "REGISTER_VERIFY_CWD_MISSING",
      "preflight",
      "The registered working directory is unavailable.",
      "Select or restore the project folder, then preview registration again.",
      false,
      null,
      []
    );
  }
  if (
    launchPlan.port.ownership !== "external" &&
    !(await executableResolvable(launchPlan.executable, launchPlan.cwd))
  ) {
    return failureResult(
      "REGISTER_VERIFY_COMMAND_NOT_FOUND",
      "preflight",
      `The configured executable '${path.basename(launchPlan.executable)}' is unavailable.`,
      "Install the runtime or preview another detected launch command.",
      false,
      null,
      []
    );
  }
  if (launchPlan.port.ownership === "fixed" && launchPlan.port.requestedPort) {
    if (!(await canBindPort(launchPlan.port.requestedPort, host))) {
      return failureResult(
        "REGISTER_VERIFY_PORT_CONFLICT",
        "preflight",
        "The configured fixed upstream port is already occupied.",
        "Use a managed dynamic port or choose another fixed port.",
        false,
        true,
        []
      );
    }
  }
  return undefined;
}

async function executableResolvable(executable: string, cwd: string): Promise<boolean> {
  const candidates: string[] = [];
  if (path.isAbsolute(executable) || executable.includes("/") || executable.includes("\\")) {
    candidates.push(path.isAbsolute(executable) ? executable : path.resolve(cwd, executable));
  } else {
    const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
    for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
      candidates.push(path.join(directory, executable));
      if (process.platform === "win32" && !path.extname(executable)) {
        candidates.push(...extensions.map((extension) => path.join(directory, `${executable}${extension}`)));
      }
    }
  }
  for (const candidate of candidates) {
    if (
      await fs
        .access(candidate, fsConstants.X_OK)
        .then(() => true)
        .catch(() => false)
    )
      return true;
  }
  return false;
}

function proofIdentity(
  request: RegistrationVerificationRequest,
  launchPlan: CompiledLaunchPlan,
  policy: RegistrationVerificationPolicy
): RegistrationProofIdentity {
  return {
    manifestRevision: request.manifestRevision,
    launchPlanDigest: digest({
      executable: launchPlan.executable,
      args: launchPlan.args,
      cwd: launchPlan.cwd,
      environmentNames: Object.keys(launchPlan.environment).sort(),
      port: launchPlan.port,
      health: launchPlan.health
    }),
    policyDigest: digest(policy),
    adapterId: launchPlan.adapterId,
    adapterVersion: launchPlan.adapterVersion,
    relaybaseVersion: process.env.npm_package_version ?? "0.1.0"
  };
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function classifyStartView(
  app: AppRecord,
  start: RuntimeView,
  stopped: RuntimeView,
  stopVerification: RuntimeView["stopVerification"],
  logs: string[],
  durationMs: number
): RegistrationVerificationResult {
  const attempt = start.lastStartAttempt;
  const alternate = attempt?.verification?.successfulTarget;
  const dependencyMissing = logs.some((line) =>
    /cannot find module|module not found|module_not_found|no module named|could not find package|missing dependency/i.test(
      line
    )
  );
  let code: RegistrationVerificationFailureCode;
  let boundary: RegistrationVerificationFailure["boundary"] = "start";
  let action: string;
  if (dependencyMissing) {
    code = "REGISTER_VERIFY_DEPENDENCY_MISSING";
    action = "Run the app's documented dependency setup, then retry the exact registration proof.";
  } else if (alternate || attempt?.verification?.assignedPortOpen) {
    code = "REGISTER_VERIFY_HEALTH_ROUTE";
    boundary = "health";
    action = alternate
      ? `Preview healthUrl '${alternate}' and retry verification.`
      : "Inspect the declared health route or provide an exact localhost health route.";
  } else if (start.status === "conflict") {
    code = "REGISTER_VERIFY_PORT_CONFLICT";
    boundary = "preflight";
    action = "Use a managed dynamic port or choose another fixed port.";
  } else if (start.lastError?.includes("exited before")) {
    code = "REGISTER_VERIFY_EARLY_EXIT";
    action = "Inspect the redacted logs and preview a deterministic launch repair.";
  } else if (start.lastError?.toLowerCase().includes("permission") || start.lastError?.includes("EACCES")) {
    code = "REGISTER_VERIFY_PERMISSION";
    action = "Use a safe platform launcher or correct executable permissions.";
  } else if (attempt?.verification?.assignedPortOpen === false) {
    code = "REGISTER_VERIFY_PORT_IGNORED";
    boundary = "health";
    action = "Preview explicit host and port binding for this runtime.";
  } else {
    code = "REGISTER_VERIFY_TIMEOUT";
    action = "Use an extended proof only when the runtime adapter justifies it.";
  }
  const repairs = repairOptions(app, start, alternate);
  return failureResult(
    code,
    boundary,
    start.lastError ?? "The process did not become ready on Relaybase's assigned port.",
    action,
    false,
    stopVerification?.backendPortOpen ?? null,
    logs,
    {
      attemptId: attempt?.id,
      assignedPort: start.assignedPort ?? attempt?.assignedPort,
      startedAt: start.startedAt,
      stoppedAt: stopped.stoppedAt,
      durationMs,
      health: {
        ...(app.healthUrl ? { declaredTarget: app.healthUrl } : {}),
        ...(alternate ? { successfulTarget: alternate, statusCode: attempt?.verification?.statusCode } : {})
      },
      stop: stopSummary(stopVerification),
      repairs
    }
  );
}

function classifyThrownStart(error: unknown, logs: string[], durationMs: number): RegistrationVerificationResult {
  const message = safeError(error);
  const lower = message.toLowerCase();
  const code: RegistrationVerificationFailureCode =
    lower.includes("enoent") || lower.includes("not found")
      ? "REGISTER_VERIFY_COMMAND_NOT_FOUND"
      : lower.includes("permission") || lower.includes("eacces") || lower.includes("eperm")
        ? "REGISTER_VERIFY_PERMISSION"
        : "REGISTER_VERIFY_EARLY_EXIT";
  return failureResult(
    code,
    "start",
    code === "REGISTER_VERIFY_COMMAND_NOT_FOUND"
      ? "The configured runtime or executable could not be started."
      : "The configured process failed before readiness could be proven.",
    code === "REGISTER_VERIFY_COMMAND_NOT_FOUND"
      ? "Install the runtime or choose another detected command."
      : "Inspect the redacted logs and preview a safe launch repair.",
    false,
    null,
    logs,
    { durationMs }
  );
}

function repairOptions(app: AppRecord, start: RuntimeView, alternate?: string): RegistrationRepairOption[] {
  const repairs: RegistrationRepairOption[] = [];
  if (alternate) {
    repairs.push({
      id: `health-route:${alternate}`,
      kind: "health_route",
      label: `Use health route ${alternate}`,
      recommended: true,
      previewOnly: true,
      approvalRequired: true,
      patch: { healthUrl: alternate },
      reason: "The already-started process returned 2xx at this bounded localhost candidate."
    });
  }
  if (!app.launch && app.command && app.command !== "external") {
    repairs.push({
      id: "dynamic-binding",
      kind: "dynamic_binding",
      label: "Use explicit managed host and port binding",
      recommended: repairs.length === 0,
      previewOnly: true,
      approvalRequired: true,
      structuredInputRequired: ["executable", "arguments", "portBinding", "healthRoute"],
      reason: "The legacy command did not become ready on the assigned port; preview a structured runtime binding."
    });
  }
  if (app.upstreamPort || start.assignedPort) {
    const pinnedPort = app.upstreamPort ?? start.assignedPort;
    repairs.push({
      id: "pinned-upstream",
      kind: "pinned_port",
      label: "Use a pinned upstream port",
      recommended: false,
      previewOnly: true,
      approvalRequired: true,
      patch: {
        upstreamPort: pinnedPort,
        ...(app.launch ? { launch: { ...app.launch, portBinding: "fixed" } } : {})
      },
      reason: "Pinned ports are an explicit fallback for runtimes that cannot accept dynamic binding."
    });
  }
  if (repairs.length === 0) {
    repairs.push({
      id: "manual-structured-launch",
      kind: "manual_launch",
      label: "Provide an exact structured launch contract",
      recommended: true,
      previewOnly: true,
      approvalRequired: true,
      structuredInputRequired: ["executable", "arguments", "portBinding", "healthRoute"],
      reason: "No deterministic adapter repair was supported by the available evidence."
    });
  }
  return repairs.slice(0, 3);
}

function failureResult(
  code: RegistrationVerificationFailureCode,
  boundary: RegistrationVerificationFailure["boundary"],
  message: string,
  recommendedAction: string,
  processRunning: boolean,
  backendPortOpen: boolean | null,
  logs: string[],
  extra: Partial<RegistrationVerificationResult> = {}
): RegistrationVerificationResult {
  const failure: RegistrationVerificationFailure = {
    code,
    boundary,
    message,
    recommendedAction,
    processRunning,
    backendPortOpen,
    retryable: !["REGISTER_VERIFY_STOP_FAILED", "REGISTER_VERIFY_PORT_STILL_OPEN"].includes(code),
    logExcerpt: logs.slice(-20)
  };
  return {
    attempted: true,
    status:
      code === "REGISTER_VERIFY_STOP_FAILED" || code === "REGISTER_VERIFY_PORT_STILL_OPEN"
        ? "cleanup_failed"
        : boundary === "preflight"
          ? "preflight_failed"
          : "failed",
    repairs: extra.repairs ?? [],
    ...extra,
    failure
  };
}

function stopSummary(
  input: RuntimeView | RuntimeView["stopVerification"]
): NonNullable<RegistrationVerificationResult["stop"]> {
  const stop = input && "status" in input ? input.stopVerification : input;
  return {
    ok: Boolean(stop?.ok),
    portClosureVerified: Boolean(stop?.portClosureVerified),
    backendPortOpen: stop?.backendPortOpen ?? null
  };
}

function safeError(error: unknown): string {
  return redactSecretLikeValues(error instanceof Error ? error.message : String(error)).value;
}

function redactionCount(lines: string[]): number {
  return lines.reduce((count, line) => count + redactSecretLikeValues(line).report.replacements, 0);
}

function redactProjectPaths(line: string, app: AppRecord | undefined): string {
  if (!app) return line;
  let redacted = line;
  for (const value of [app.manifestPath, app.cwd].filter((item): item is string => Boolean(item))) {
    redacted = redacted.split(value).join("<project>");
    redacted = redacted.split(value.replaceAll("\\", "\\\\")).join("<project>");
  }
  return redacted;
}
