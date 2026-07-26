import type http from "node:http";
import { createHash } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import type { DaemonEventType } from "./apiTypes.ts";
import { sanitizeErrorDetail } from "./apiErrors.ts";
import { appRecordEventData } from "./daemonEvents.ts";
import { readManifestFile } from "./registry.ts";
import { sendJson } from "./responses.ts";
import type { RelaybaseRuntime } from "./server.ts";
import {
  configureProject,
  detectProject,
  healthProject,
  openProject,
  proposeSetupPlans,
  SetupSelectionError,
  type EnvStrategy,
  type ProjectDetection,
  type SetupArchitecture,
  type SetupPlan as EngineSetupPlan
} from "./setupEngine.ts";
import type {
  ComponentSetupMetadata,
  ExistingManifestAnalysis,
  ExistingSetupArtifactAnalysis,
  FileDiff,
  FileWritePreview,
  FrameworkKind,
  ManifestPatchPlan,
  ManifestPatchRequest,
  ManifestPatchResult,
  OpenProjectPlan,
  OpenProjectRequest,
  OpenProjectResult,
  PackageManagerKind,
  PortStrategy,
  ProveHealthRequest,
  ProveHealthResult,
  RegisterManifestRequest,
  RegisterManifestResult,
  RegistrationApplyRequest,
  RegistrationPreviewRequest,
  RegistrationRepairApplyRequest,
  RegistrationRepairPreviewRequest,
  RegistrationRepairPreviewResult,
  RegistrationSetupResult,
  RepairSetupRequest,
  RepairSetupResult,
  SetupApplyRequest,
  SetupApplyResult,
  SetupApprovalRisk,
  SetupDetectRequest,
  SetupDetectResult,
  SetupDiagnostic,
  SetupPlan,
  SetupPlanChoice,
  SetupPlanPreview,
  SetupPlanRequest
} from "./setupApiTypes.ts";
import type { AppManifestInput, AppRecord } from "./types.ts";
import { normalizeManifest } from "./validation.ts";
import { compileLaunchPlan } from "./launchPlan.ts";
import {
  DEFAULT_REGISTRATION_VERIFICATION_POLICY,
  type RegistrationVerificationPolicy
} from "./registrationVerificationTypes.ts";

const MANIFEST_FILE = "relaybase.app.json";
const SETUP_DIR = ".relaybase";
const LAUNCH_PROFILE_FILE = "launch-profile.json";
const SETUP_PROFILE_FILE = "setup-profile.json";
const SETUP_ANSWERS_FILE = "setup.answers.json";
const SETUP_REPORT_FILE = "setup-report.json";
const SAFE_MANIFEST_FIELDS = new Set([
  "id",
  "name",
  "command",
  "launch",
  "cwd",
  "protocol",
  "healthUrl",
  "upstreamPort",
  "env",
  "relaybase"
]);
const SAFE_RELAYBASE_FIELDS = new Set(["groupId", "componentRole", "displayName", "paneLabel", "paneOrder"]);
const MAX_JSON_BODY_BYTES = 1024 * 1024;

interface RegistrationBinding {
  preview: RegistrationSetupResult;
  request: RegistrationPreviewRequest;
  manifestRevision: string;
  createdAt: number;
  verificationPolicy: RegistrationVerificationPolicy;
  healthCandidates: string[];
}

const registrationBindings = new Map<string, RegistrationBinding>();
interface RegistrationRepairBinding {
  preview: RegistrationRepairPreviewResult;
  manifestPath: string;
  writePaths: string[];
  revision: string;
  healthCandidates: string[];
  createdAt: number;
}
const registrationRepairBindings = new Map<string, RegistrationRepairBinding>();

export class SetupApiRequestError extends Error {
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
    this.retryable = options.retryable ?? statusCode >= 500;
    this.detail = options.detail;
    this.userAction = options.userAction;
  }
}

type RequireToken = (options?: { code?: string; message?: string; userAction?: string }) => void;

export async function handleSetupApiRequest(input: {
  runtime: RelaybaseRuntime;
  request: http.IncomingMessage;
  response: http.ServerResponse;
  url: URL;
  parts: string[];
  correlationId: string;
  requireToken: RequireToken;
}): Promise<boolean> {
  const { runtime, request, response, parts, correlationId, requireToken } = input;
  if (parts[0] !== "__hub" || parts[1] !== "api" || parts[2] !== "setup") {
    return false;
  }

  if (request.method === "GET" && parts.length === 5 && parts[3] === "operations") {
    throw new SetupApiRequestError(404, "SETUP_OPERATION_NOT_FOUND", "Relaybase setup operation was not found.", {
      retryable: false,
      detail: { operationId: parts[4], asyncSetupOperations: "not_implemented" },
      userAction: "Setup endpoints currently complete synchronously. Start a new setup request if needed."
    });
  }

  if (request.method !== "POST") {
    throw new SetupApiRequestError(405, "SETUP_METHOD_NOT_ALLOWED", "Relaybase setup API expects POST.", {
      retryable: false,
      detail: { method: request.method, path: input.url.pathname },
      userAction: "Use one of the documented POST /__hub/api/setup routes."
    });
  }

  const body = await readJsonBody(request);
  const route = parts.slice(3).join("/");

  if (route === "detect") {
    const setup = await detectSetup(body);
    publishSetupEvent(runtime, "setup.detected", correlationId, setupEventSummary(setup));
    sendJson(response, 200, { setup });
    return true;
  }

  if (route === "plans") {
    const setup = await planSetup(body);
    publishSetupEvent(runtime, "setup.plan_created", correlationId, setupEventSummary(setup));
    sendJson(response, 200, { setup });
    return true;
  }

  if (route === "preview") {
    const setup = await previewSetup(body);
    publishSetupEvent(runtime, "setup.preview_created", correlationId, setupEventSummary(setup));
    sendJson(response, 200, { setup });
    return true;
  }

  if (route === "apply") {
    requireToken({
      code: "UNAUTHORIZED_SETUP_APPLY",
      message: "Unauthorized Relaybase setup apply.",
      userAction: "Use the session token from this daemon state directory before applying setup writes."
    });
    requireConfirmation(
      body,
      "SETUP_APPLY_CONFIRMATION_REQUIRED",
      "Applying a setup plan writes files and registers a manifest."
    );
    publishSetupEvent(runtime, "setup.apply_started", correlationId, { request: setupRequestSummary(body) });
    try {
      const setup = await applySetup(runtime, body, correlationId);
      publishSetupEvent(runtime, "setup.apply_completed", correlationId, setupEventSummary(setup));
      if (isRepairApply(body)) {
        publishSetupEvent(runtime, "setup.repair_applied", correlationId, setupEventSummary(setup));
      }
      sendJson(response, 202, { setup });
    } catch (error) {
      publishSetupEvent(runtime, "setup.apply_failed", correlationId, setupFailureData(error, body));
      throw error;
    }
    return true;
  }

  if (route === "register/preview" || route === "register/inspect") {
    const setup = await previewRegistration(runtime, body);
    publishSetupEvent(runtime, "setup.preview_created", correlationId, setupEventSummary(setup));
    sendJson(response, 200, { setup });
    return true;
  }

  if (route === "register/apply") {
    requireToken({
      code: "UNAUTHORIZED_SETUP_REGISTER",
      message: "Unauthorized Relaybase registration apply.",
      userAction: "Use the session token from this daemon state directory before applying registration."
    });
    requireConfirmation(
      body,
      "REGISTER_CONFIRMATION_REQUIRED",
      "Registration writes approved setup files or updates daemon registry state."
    );
    const setup = await applyRegistration(runtime, body, correlationId);
    publishSetupEvent(runtime, "setup.registered", correlationId, setupEventSummary(setup));
    sendJson(response, 202, { setup });
    return true;
  }

  if (route === "register/repair/preview") {
    const setup = await previewRegistrationRepair(runtime, body);
    publishSetupEvent(runtime, "setup.repair_plan_created", correlationId, setupEventSummary(setup));
    sendJson(response, 200, { setup });
    return true;
  }

  if (route === "register/repair/apply") {
    requireToken({
      code: "UNAUTHORIZED_SETUP_REGISTER_REPAIR",
      message: "Unauthorized Relaybase registration repair apply.",
      userAction: "Use the session token before applying a registration repair."
    });
    requireConfirmation(
      body,
      "REGISTER_REPAIR_CONFIRMATION_REQUIRED",
      "Applying a registration repair writes the exact previewed manifest patch and runs one new quick proof."
    );
    const setup = await applyRegistrationRepair(runtime, body, correlationId);
    publishSetupEvent(runtime, "setup.repair_applied", correlationId, setupEventSummary(setup));
    sendJson(response, 202, { setup });
    return true;
  }

  if (route === "register/verification/cancel") {
    requireToken({
      code: "UNAUTHORIZED_SETUP_REGISTER_CANCEL",
      message: "Unauthorized registration verification cancellation.",
      userAction: "Use the session token before cancelling an active verification attempt."
    });
    const appId = String(body.appId ?? "").trim();
    const cancelled = runtime.registrationVerification.cancel(appId);
    sendJson(response, cancelled ? 202 : 409, {
      setup: {
        appId,
        cancelled,
        status: cancelled ? "cancelled" : "not_active",
        message: cancelled
          ? "Cancellation requested; Relaybase will stop and finalize the active verification attempt."
          : "No active registration verification attempt was found."
      }
    });
    return true;
  }

  if (route === "register-manifest") {
    requireToken({
      code: "UNAUTHORIZED_SETUP_REGISTER",
      message: "Unauthorized Relaybase manifest registration.",
      userAction: "Use the session token from this daemon state directory before registering a manifest."
    });
    const setup = await registerManifest(runtime, body, correlationId);
    publishSetupEvent(runtime, "setup.registered", correlationId, setupEventSummary(setup));
    sendJson(response, 201, { setup });
    return true;
  }

  if (route === "inspect-manifest") {
    sendJson(response, 200, { setup: await inspectManifest(body) });
    return true;
  }

  if (route === "validate-manifest") {
    sendJson(response, 200, { setup: await validateManifest(body) });
    return true;
  }

  if (route === "patch-manifest/preview") {
    sendJson(response, 200, { setup: await previewManifestPatch(body) });
    return true;
  }

  if (route === "patch-manifest/apply") {
    requireToken({
      code: "UNAUTHORIZED_SETUP_MANIFEST_PATCH",
      message: "Unauthorized Relaybase manifest patch.",
      userAction: "Use the session token from this daemon state directory before applying manifest edits."
    });
    requireConfirmation(
      body,
      "SETUP_MANIFEST_PATCH_CONFIRMATION_REQUIRED",
      "Applying a manifest patch writes relaybase.app.json."
    );
    sendJson(response, 200, { setup: await applyManifestPatch(body) });
    return true;
  }

  if (route === "open") {
    requireToken({
      code: "UNAUTHORIZED_SETUP_OPEN",
      message: "Unauthorized Relaybase setup open.",
      userAction: "Use the session token from this daemon state directory before opening a project or app."
    });
    requireConfirmation(
      body,
      "SETUP_OPEN_CONFIRMATION_REQUIRED",
      "Opening a project may register a manifest, start an app, and open a route."
    );
    sendJson(response, 202, { setup: await openSetupProject(runtime, body) });
    return true;
  }

  if (route === "prove") {
    requireToken({
      code: "UNAUTHORIZED_SETUP_PROVE",
      message: "Unauthorized Relaybase setup proof.",
      userAction: "Use the session token from this daemon state directory before writing proof artifacts."
    });
    requireConfirmation(
      body,
      "SETUP_PROVE_CONFIRMATION_REQUIRED",
      "Proving setup writes proof artifacts and may run lifecycle checks when requested."
    );
    publishSetupEvent(runtime, "setup.prove_started", correlationId, { request: setupRequestSummary(body) });
    const setup = await proveSetup(runtime, body);
    publishSetupEvent(runtime, "setup.prove_completed", correlationId, setupEventSummary(setup));
    sendJson(response, 202, { setup });
    return true;
  }

  if (route === "repair") {
    const setup = await repairSetup(body);
    publishSetupEvent(runtime, "setup.repair_plan_created", correlationId, setupEventSummary(setup));
    sendJson(response, 200, { setup });
    return true;
  }

  throw new SetupApiRequestError(404, "SETUP_ROUTE_NOT_FOUND", "Relaybase setup API route was not found.", {
    retryable: false,
    detail: { route },
    userAction: "Use one of the documented /__hub/api/setup routes."
  });
}

export async function detectSetup(raw: Record<string, unknown>): Promise<SetupDetectResult> {
  const request = raw as SetupDetectRequest;
  const cwd = await resolveProjectDirectory(request.cwd ?? request.currentDirectory);
  return detectResultFromProject(await detectProject(cwd));
}

export async function planSetup(
  raw: Record<string, unknown>
): Promise<{ cwd: string; choices: SetupPlanChoice[]; diagnostics: SetupDiagnostic[] }> {
  const context = await setupContext(raw as SetupPlanRequest);
  return {
    cwd: context.detection.root,
    choices: context.plans.map((plan) => planChoice(plan, context.detection)),
    diagnostics: diagnosticsForDetection(context.detection)
  };
}

export async function previewSetup(raw: Record<string, unknown>): Promise<SetupPlanPreview> {
  const context = await setupContext(raw as SetupPlanRequest);
  const selectedPlan = selectSetupPlan(context.plans, context.request);
  return setupPreview(context.detection, context.plans, selectedPlan, context.request);
}

export async function applySetup(
  runtime: RelaybaseRuntime,
  raw: Record<string, unknown>,
  correlationId: string
): Promise<SetupApplyResult> {
  const request = raw as SetupApplyRequest;
  const cwd = await resolveProjectDirectory(request.cwd ?? request.currentDirectory);
  const context = await setupContext(request);
  selectSetupPlan(context.plans, request);
  const result = await setupSelectionGuard(() =>
    configureProject({
      cwd,
      host: runtime.host,
      port: runtime.port,
      stateDir: runtime.stateDir,
      yes: true,
      noStart: true,
      repair: Boolean(request.repair),
      profile: request.profile,
      selectedPlanId: request.selectedPlanId,
      commandHint: request.commandHint,
      portStrategyHint: request.portStrategyHint,
      envStrategy: request.envStrategy,
      componentMetadata: request.componentMetadata,
      mcpInstall: Boolean(request.mcpInstall),
      docker: request.docker as never
    })
  );
  const choice = planChoice(result.selectedPlan, result.detection);
  let registeredApp = result.registryApp;
  if (result.registryApp) {
    if (result.registryApp.manifestPath) {
      const writtenManifest = await readManifestFile(result.registryApp.manifestPath);
      registeredApp = await runtime.registry.upsertManifest(writtenManifest, {
        manifestPath: result.registryApp.manifestPath
      });
    } else {
      registeredApp = await runtime.registry.upsertRecord(result.registryApp);
    }
    runtime.events.publish({
      type: "app.registered",
      appId: registeredApp.id,
      correlationId,
      data: appRecordEventData(registeredApp)
    });
  }

  return sanitizeSetupValue({
    cwd: result.detection.root,
    selectedPlan: choice,
    appliedFiles: result.appliedFiles,
    ...(registeredApp ? { registeredApp } : {}),
    verification: result.verification,
    ...(result.reportPath ? { reportPath: result.reportPath } : {}),
    ...(result.eventsPath ? { eventsPath: result.eventsPath } : {}),
    diagnostics: diagnosticsForDetection(result.detection)
  }) as SetupApplyResult;
}

export async function registerManifest(
  runtime: RelaybaseRuntime,
  raw: Record<string, unknown>,
  correlationId: string
): Promise<RegisterManifestResult> {
  const request = raw as unknown as RegisterManifestRequest;
  const manifestPath = await resolveManifestPath(request.manifestPath, request.cwd);
  const manifest = await readManifestFile(manifestPath);
  const app = await runtime.registry.upsertManifest(manifest, { manifestPath });
  runtime.events.publish({
    type: "app.registered",
    appId: app.id,
    correlationId,
    data: appRecordEventData(app)
  });
  return sanitizeSetupValue({ app, manifestPath }) as RegisterManifestResult;
}

export async function previewRegistration(
  runtime: RelaybaseRuntime,
  raw: Record<string, unknown>
): Promise<RegistrationSetupResult> {
  pruneRegistrationBindings();
  const request = raw as unknown as RegistrationPreviewRequest;
  const verificationPolicy = registrationVerificationPolicy(request);
  const suppliedPath = String(
    request.path ?? request.manifestPath ?? request.cwd ?? request.currentDirectory ?? ""
  ).trim();
  if (!suppliedPath) {
    throw new SetupApiRequestError(
      400,
      "REGISTER_INPUT_REQUIRED",
      "Registration requires a project folder or relaybase.app.json path.",
      {
        retryable: false,
        userAction: "Provide /register <project-folder> or an exact relaybase.app.json path."
      }
    );
  }
  const mode = request.mode ?? (path.basename(suppliedPath).toLowerCase() === MANIFEST_FILE ? "manifest" : "folder");
  const projectRoot =
    mode === "manifest"
      ? await resolveProjectDirectory(request.cwd ?? path.dirname(path.resolve(suppliedPath)))
      : await resolveProjectDirectory(suppliedPath);
  const manifestPath =
    mode === "manifest" ? await resolveManifestPath(suppliedPath, projectRoot) : path.join(projectRoot, MANIFEST_FILE);
  ensureInside(projectRoot, manifestPath, "manifestPath");

  const manifestText = await readText(manifestPath);
  if (manifestText === undefined && mode === "manifest") {
    return registrationTerminal({
      status: "failed",
      code: "REGISTER_MANIFEST_NOT_FOUND",
      message: "The explicitly supplied relaybase.app.json was not found.",
      projectRoot,
      manifestPath,
      manifestState: "missing",
      retrySafe: true,
      actions: ["Correct the manifest path", "Use the project folder to preview setup", "Cancel"],
      diagnostics: [
        {
          code: "REGISTER_MANIFEST_NOT_FOUND",
          severity: "error",
          message: "Explicit manifest-file registration is strict and does not search other folders.",
          userAction: "Correct the path or register the containing project folder."
        }
      ]
    });
  }

  let app: AppRecord | undefined;
  let invalidMessage: string | undefined;
  if (manifestText !== undefined) {
    try {
      app = normalizeManifest(JSON.parse(manifestText) as AppManifestInput, { manifestPath });
    } catch (error) {
      invalidMessage = errorMessage(error);
    }
  }
  if (invalidMessage) {
    return registrationTerminal({
      status: "manifest_invalid",
      code: "REGISTER_MANIFEST_INVALID",
      message: `Manifest requires setup adaptation: ${invalidMessage}`,
      projectRoot,
      manifestPath,
      manifestState: "invalid",
      retrySafe: true,
      actions:
        mode === "manifest"
          ? ["Preview recommended repair", "Inspect manifest", "Cancel"]
          : ["Preview project repair", "Inspect manifest", "Cancel"],
      diagnostics: [
        {
          code: "REGISTER_MANIFEST_INVALID",
          severity: "error",
          message: invalidMessage,
          userAction: "Preview a repair; Relaybase will not modify the manifest without approval."
        }
      ]
    });
  }

  if (app) {
    const existing = await runtime.registry.get(app.id);
    if (
      existing &&
      registrationAppIdentity(existing) === registrationAppIdentity(app) &&
      verificationPolicy.mode === "none"
    ) {
      return registrationTerminal({
        status: "registered_unverified",
        code: "REGISTER_ALREADY_CURRENT",
        message: `${app.name} is already registered and the manifest revision is unchanged.`,
        projectRoot,
        manifestPath,
        manifestState: "valid",
        app,
        retrySafe: true,
        registered: true,
        actions: ["Start", "Re-register", "Inspect", "Cancel"],
        diagnostics: []
      });
    }
    const healthCandidates = registrationHealthCandidates(app);
    return await bindRegistrationPreview(
      request,
      {
        schemaVersion: 1,
        status: "approval_required",
        message:
          verificationPolicy.mode === "quick"
            ? `Ready to register ${app.name}. Confirmation will briefly start it, check health, stop it, and verify backend-port closure.`
            : `Ready to register ${app.name} without launch verification.`,
        projectRoot,
        manifestPath,
        manifestState: "valid",
        app,
        launchPlan: compileLaunchPlan(app, {
          host: runtime.host,
          port: app.upstreamPort ?? 17_000,
          hubPort: runtime.port
        }),
        verificationIntent: verificationIntent(verificationPolicy, healthCandidates),
        questions: [],
        risks: [
          {
            code: "registry_update",
            severity: "warning",
            message: "Confirmation updates daemon registry state.",
            requiresApproval: true
          },
          ...(verificationPolicy.mode === "quick"
            ? [
                {
                  code: "registration_quick_verification",
                  severity: "warning" as const,
                  message: "Confirmation performs one bounded start, health, stop, and port-closure proof.",
                  requiresApproval: true
                }
              ]
            : [])
        ],
        approval: { required: true },
        registered: false,
        started: false,
        filesWritten: false,
        retrySafe: true,
        actions:
          verificationPolicy.mode === "quick"
            ? ["Confirm and verify", "Register without verification", "Inspect", "Cancel"]
            : ["Confirm without verification", "Inspect", "Cancel"],
        diagnostics: diagnosticsForApp(app)
      },
      manifestText ?? "<missing>",
      [],
      verificationPolicy,
      healthCandidates
    );
  }

  let setup: SetupPlanPreview;
  try {
    setup = await previewSetup({
      cwd: projectRoot,
      ...(request.selectedPlanId ? { selectedPlanId: request.selectedPlanId } : {}),
      ...(request.commandHint ? { commandHint: request.commandHint } : {}),
      ...(request.portStrategyHint ? { portStrategyHint: request.portStrategyHint } : {}),
      ...(request.componentMetadata ? { componentMetadata: request.componentMetadata } : {})
    });
  } catch (error) {
    if (error instanceof SetupSelectionError) {
      const plans = await planSetup({ cwd: projectRoot });
      return registrationTerminal({
        status: "needs_input",
        code: "REGISTER_INPUT_REQUIRED",
        message: error.message,
        projectRoot,
        manifestPath,
        manifestState: "missing",
        retrySafe: true,
        actions: ["Choose a launch plan", "Provide the missing information", "Cancel"],
        diagnostics: plans.diagnostics
      });
    }
    throw error;
  }
  const selectedApp = normalizeManifest(setup.selectedPlan.manifest, { manifestPath });
  const healthCandidates = registrationHealthCandidates(
    selectedApp,
    setup.selectedPlan.choice.runtimeHealthCandidates?.map((candidate) => candidate.path)
  );
  return await bindRegistrationPreview(
    request,
    {
      schemaVersion: 1,
      status: "approval_required",
      code: "REGISTER_SETUP_REQUIRED",
      message:
        "No relaybase.app.json was found. Relaybase inspected the project and prepared an approval-bound setup preview.",
      projectRoot,
      manifestPath,
      manifestState: "missing",
      app: selectedApp,
      selectedPlan: setup.selectedPlan,
      fileWritePlan: setup.fileWritePlan,
      launchPlan: compileLaunchPlan(selectedApp, { host: runtime.host, port: 17_000, hubPort: runtime.port }),
      verificationIntent: verificationIntent(verificationPolicy, healthCandidates),
      questions: setup.selectedPlan.choice.setupQuestions ?? [],
      risks: [
        ...setup.fileWritePlan.risks,
        ...(verificationPolicy.mode === "quick"
          ? [
              {
                code: "registration_quick_verification",
                severity: "warning" as const,
                message: "Confirmation performs one bounded start, health, stop, and port-closure proof.",
                requiresApproval: true
              }
            ]
          : [])
      ],
      approval: { required: true },
      registered: false,
      started: false,
      filesWritten: false,
      retrySafe: true,
      actions:
        verificationPolicy.mode === "quick"
          ? ["Review manifest", "Confirm and verify", "Register without verification", "Cancel"]
          : ["Review manifest", "Confirm without verification", "Choose another plan", "Cancel"],
      diagnostics: setup.diagnostics
    },
    "<missing>",
    setup.fileWritePlan.writes.map((write) => write.path),
    verificationPolicy,
    healthCandidates
  );
}

export async function applyRegistration(
  runtime: RelaybaseRuntime,
  raw: Record<string, unknown>,
  correlationId: string
): Promise<RegistrationSetupResult> {
  pruneRegistrationBindings();
  const request = raw as unknown as RegistrationApplyRequest;
  const binding = registrationBindings.get(String(request.previewId ?? ""));
  if (!binding) {
    throw new SetupApiRequestError(409, "REGISTER_PREVIEW_REQUIRED", "Registration requires a current preview.", {
      retryable: true,
      userAction: "Generate a new registration preview and confirm that exact preview."
    });
  }
  const writePaths = binding.preview.fileWritePlan?.writes.map((write) => write.path) ?? [];
  const revision = await registrationRevision(binding.preview.manifestPath, writePaths);
  if (revision !== binding.manifestRevision) {
    registrationBindings.delete(request.previewId);
    throw new SetupApiRequestError(
      409,
      "REGISTER_PREVIEW_STALE",
      "Registration preview is stale because a bound file changed.",
      {
        retryable: true,
        detail: { filesWritten: false, registered: false, started: false },
        userAction: "Generate a new preview. No files or registry state were changed."
      }
    );
  }

  let app: AppRecord;
  let filesWritten = false;
  if (binding.preview.manifestState === "missing") {
    const setup = await applySetup(
      runtime,
      {
        cwd: binding.preview.projectRoot,
        selectedPlanId: binding.preview.selectedPlan?.id,
        commandHint: binding.request.commandHint,
        portStrategyHint: binding.request.portStrategyHint,
        componentMetadata: binding.request.componentMetadata,
        confirm: true,
        confirmation: { confirmed: true, reason: "Approved registration preview" }
      },
      correlationId
    );
    if (!setup.registeredApp) {
      throw new SetupApiRequestError(
        500,
        "REGISTER_REGISTRY_FAILED",
        "Setup completed without a confirmed registry record.",
        {
          retryable: true,
          userAction: "Inspect setup files and retry registration. The app was not started."
        }
      );
    }
    app = setup.registeredApp;
    filesWritten = setup.appliedFiles.some((file) => file.action === "created" || file.action === "updated");
  } else {
    const manifest = await readManifestFile(binding.preview.manifestPath);
    app = await runtime.registry.upsertManifest(manifest, { manifestPath: binding.preview.manifestPath });
    runtime.events.publish({ type: "app.registered", appId: app.id, correlationId, data: appRecordEventData(app) });
  }
  registrationBindings.delete(request.previewId);
  const verification = await runtime.registrationVerification.verify({
    app,
    previewId: request.previewId,
    manifestRevision: binding.manifestRevision,
    policy: binding.verificationPolicy,
    healthCandidates: binding.healthCandidates,
    ...(request.selectedRepairId ? { selectedRepairId: request.selectedRepairId } : {})
  });
  const status =
    verification.status === "verified"
      ? "registered_verified"
      : verification.status === "cleanup_failed"
        ? "registered_cleanup_failed"
        : verification.status === "not_requested"
          ? "registered_unverified"
          : "registered_verification_failed";
  const actions =
    status === "registered_verified"
      ? [`Start ${app.id}`, "Inspect", "Done"]
      : status === "registered_cleanup_failed"
        ? ["View logs", "Retry stop", "Inspect cleanup"]
        : status === "registered_verification_failed"
          ? ["Preview repair", "View logs", "Keep registered without verification", "Cancel"]
          : [`Start ${app.id}`, "Verify", "Inspect", "Done"];
  return {
    ...binding.preview,
    status,
    code: undefined,
    message:
      status === "registered_verified"
        ? `${app.name} is registered and verified. The verification process was stopped and its backend port closed.`
        : status === "registered_cleanup_failed"
          ? `${app.name} is registered, but verification cleanup failed. Resolve the remaining process or port before retrying.`
          : status === "registered_verification_failed"
            ? `${app.name} is registered, but launch verification failed. Review the evidence and preview a safe repair.`
            : `${app.name} is registered without launch verification.`,
    app,
    verification,
    approval: { required: false },
    registered: true,
    started: false,
    filesWritten,
    retrySafe: status !== "registered_cleanup_failed",
    actions
  };
}

export async function previewRegistrationRepair(
  runtime: RelaybaseRuntime,
  raw: Record<string, unknown>
): Promise<RegistrationRepairPreviewResult> {
  pruneRegistrationBindings();
  const request = raw as unknown as RegistrationRepairPreviewRequest;
  const appId = String(request.appId ?? "").trim();
  const repairId = String(request.repairId ?? "").trim();
  const app = await runtime.registry.get(appId);
  if (!app?.manifestPath) {
    throw new SetupApiRequestError(
      404,
      "REGISTER_REPAIR_APP_NOT_FOUND",
      "Repair requires a registered manifest-backed app.",
      {
        retryable: false,
        userAction: "Choose a registered app with an inspectable relaybase.app.json."
      }
    );
  }
  if (!(await registrationCleanupResolved(runtime, appId))) {
    throw new SetupApiRequestError(
      409,
      "REGISTER_REPAIR_CLEANUP_UNRESOLVED",
      "A registration repair cannot start while verification cleanup remains unresolved.",
      { retryable: true, userAction: "Resolve the remaining process or open port, then request a new repair preview." }
    );
  }
  const repair = runtime.registrationVerification.repairOption(appId, repairId);
  if (!repair) {
    throw new SetupApiRequestError(
      404,
      "REGISTER_REPAIR_NOT_FOUND",
      "The requested repair is not available for the latest attempt.",
      {
        retryable: true,
        userAction: "Inspect the latest verification result and choose one of its repair ids."
      }
    );
  }
  if (!repair.patch && !(repair.kind === "setup_plan" && repair.setupPlanId)) {
    throw new SetupApiRequestError(
      409,
      "REGISTER_REPAIR_INPUT_REQUIRED",
      "This repair requires explicit structured launch input before Relaybase can compile a safe patch.",
      {
        retryable: true,
        detail: { structuredInputRequired: repair.structuredInputRequired },
        userAction: "Provide executable, arguments, port binding, and health route values."
      }
    );
  }
  let fileWritePlan: RegistrationRepairPreviewResult["fileWritePlan"];
  let resultingApp: AppRecord;
  let selectedPlan: SetupPlan | undefined;
  if (repair.kind === "setup_plan" && repair.setupPlanId) {
    const setup = await previewSetup({ cwd: app.cwd, selectedPlanId: repair.setupPlanId });
    const plannedManifestPath = path.join(setup.cwd, MANIFEST_FILE);
    if (path.resolve(plannedManifestPath) !== path.resolve(app.manifestPath)) {
      throw new SetupApiRequestError(
        409,
        "REGISTER_REPAIR_MANIFEST_MISMATCH",
        "The detected setup repair does not target the registered manifest.",
        { retryable: true, userAction: "Generate a new registration preview for the project root." }
      );
    }
    resultingApp = normalizeManifest(setup.selectedPlan.manifest, { manifestPath: app.manifestPath });
    fileWritePlan = setup.fileWritePlan;
    selectedPlan = setup.selectedPlan;
  } else {
    const patchPlan = await buildManifestPatchPlan({
      cwd: app.cwd,
      manifestPath: app.manifestPath,
      patch: repair.patch ?? {}
    });
    resultingApp = normalizeManifest(patchPlan.patchedManifest, { manifestPath: app.manifestPath });
    fileWritePlan = patchPlan.fileWritePlan;
  }
  const writePaths = fileWritePlan.writes.map((write) => write.path);
  const revision = await registrationRevision(app.manifestPath, writePaths);
  const previewId = `repair_${createHash("sha256")
    .update(JSON.stringify({ appId, repairId, repair, revision, fileWritePlan }))
    .digest("hex")
    .slice(0, 24)}`;
  const policy = { ...DEFAULT_REGISTRATION_VERIFICATION_POLICY };
  const healthCandidates = registrationHealthCandidates(resultingApp, [
    String(repair.patch?.healthUrl ?? ""),
    ...(selectedPlan?.choice.runtimeHealthCandidates?.map((candidate) => candidate.path) ?? [])
  ]);
  const preview: RegistrationRepairPreviewResult = {
    previewId,
    appId,
    repairId,
    repair,
    ...(selectedPlan ? { selectedPlan } : {}),
    fileWritePlan,
    launchCommand: registrationLaunchCommand(resultingApp),
    approval: { required: true, previewId },
    verificationIntent: verificationIntent(policy, healthCandidates),
    actions: ["Confirm repair and verify", "Review manifest diff", "View logs", "Cancel"]
  };
  registrationRepairBindings.set(previewId, {
    preview,
    manifestPath: app.manifestPath,
    writePaths,
    revision,
    healthCandidates,
    createdAt: Date.now()
  });
  return preview;
}

export async function applyRegistrationRepair(
  runtime: RelaybaseRuntime,
  raw: Record<string, unknown>,
  correlationId: string
): Promise<RegistrationSetupResult> {
  pruneRegistrationBindings();
  const request = raw as unknown as RegistrationRepairApplyRequest;
  const binding = registrationRepairBindings.get(String(request.previewId ?? ""));
  if (!binding) {
    throw new SetupApiRequestError(
      409,
      "REGISTER_REPAIR_PREVIEW_REQUIRED",
      "Repair requires a current exact preview.",
      {
        retryable: true,
        userAction: "Generate and confirm a new repair preview."
      }
    );
  }
  const currentRevision = await registrationRevision(binding.manifestPath, binding.writePaths);
  if (currentRevision !== binding.revision) {
    registrationRepairBindings.delete(request.previewId);
    throw new SetupApiRequestError(409, "REGISTER_REPAIR_PREVIEW_STALE", "Repair preview is stale.", {
      retryable: true,
      detail: { filesWritten: false, registered: false, started: false },
      userAction: "Generate a new repair preview. No repair write or process start occurred."
    });
  }
  if (!(await registrationCleanupResolved(runtime, binding.preview.appId))) {
    throw new SetupApiRequestError(
      409,
      "REGISTER_REPAIR_CLEANUP_UNRESOLVED",
      "Repair apply is blocked while verification cleanup remains unresolved.",
      { retryable: true, userAction: "Resolve the remaining process or port before retrying." }
    );
  }
  const appliedFiles = await applyRegistrationRepairFilePlan(binding.preview.fileWritePlan);
  const app = await runtime.registry.upsertManifest(await readManifestFile(binding.manifestPath), {
    manifestPath: binding.manifestPath
  });
  runtime.events.publish({ type: "app.registered", appId: app.id, correlationId, data: appRecordEventData(app) });
  const revision = await registrationRevision(binding.manifestPath, binding.writePaths);
  const policy = { ...DEFAULT_REGISTRATION_VERIFICATION_POLICY };
  const verification = await runtime.registrationVerification.verify({
    app,
    previewId: request.previewId,
    manifestRevision: revision,
    policy,
    healthCandidates: binding.healthCandidates,
    selectedRepairId: binding.preview.repairId
  });
  registrationRepairBindings.delete(request.previewId);
  const status =
    verification.status === "verified"
      ? "registered_verified"
      : verification.status === "cleanup_failed"
        ? "registered_cleanup_failed"
        : "registered_verification_failed";
  return {
    schemaVersion: 1,
    status,
    message:
      status === "registered_verified"
        ? `${app.name} repair was applied and the new launch proof passed; the app is stopped.`
        : status === "registered_cleanup_failed"
          ? `${app.name} repair was applied, but cleanup remains unresolved.`
          : `${app.name} repair was applied, but the new launch proof failed.`,
    projectRoot: app.cwd,
    manifestPath: binding.manifestPath,
    manifestState: "valid",
    app,
    verificationIntent: verificationIntent(policy, registrationHealthCandidates(app)),
    verification,
    questions: [],
    risks: [],
    approval: { required: false },
    registered: true,
    started: false,
    filesWritten: appliedFiles.some((file) => file.action === "created" || file.action === "updated"),
    retrySafe: status !== "registered_cleanup_failed",
    actions:
      status === "registered_verified"
        ? [`Start ${app.id}`, "Inspect", "Done"]
        : status === "registered_cleanup_failed"
          ? ["View logs", "Retry stop", "Inspect cleanup"]
          : ["Preview another repair", "View logs", "Keep registered without verification", "Cancel"],
    diagnostics: diagnosticsForApp(app)
  };
}

async function applyRegistrationRepairFilePlan(
  plan: RegistrationRepairPreviewResult["fileWritePlan"]
): Promise<Array<{ path: string; action: "created" | "updated" | "unchanged" | "skipped" }>> {
  const snapshots: Array<{ path: string; content?: string }> = [];
  const applied: Array<{ path: string; action: "created" | "updated" | "unchanged" | "skipped" }> = [];
  try {
    for (const write of plan.writes) {
      ensureInside(plan.root, write.path, "repair write");
      if (write.action === "skip") {
        applied.push({ path: write.path, action: "skipped" });
        continue;
      }
      const before = await readText(write.path);
      snapshots.push({ path: write.path, ...(before === undefined ? {} : { content: before }) });
      if (before === write.preview) {
        applied.push({ path: write.path, action: "unchanged" });
        continue;
      }
      await writeTextAtomic(write.path, write.preview);
      applied.push({ path: write.path, action: before === undefined ? "created" : "updated" });
    }
    return applied;
  } catch (error) {
    for (const snapshot of snapshots.reverse()) {
      if (snapshot.content === undefined) {
        await fs.rm(snapshot.path, { force: true }).catch(() => undefined);
      } else {
        await writeTextAtomic(snapshot.path, snapshot.content).catch(() => undefined);
      }
    }
    throw error;
  }
}

function registrationLaunchCommand(app: AppRecord): string {
  return String(app.command ?? app.launch?.executable ?? "external");
}

function registrationTerminal(
  input: Omit<
    RegistrationSetupResult,
    | "schemaVersion"
    | "questions"
    | "risks"
    | "approval"
    | "registered"
    | "started"
    | "filesWritten"
    | "verificationIntent"
  > &
    Partial<
      Pick<
        RegistrationSetupResult,
        "questions" | "risks" | "approval" | "registered" | "filesWritten" | "verificationIntent"
      >
    >
): RegistrationSetupResult {
  return {
    ...input,
    schemaVersion: 1,
    questions: input.questions ?? [],
    risks: input.risks ?? [],
    approval: input.approval ?? { required: false },
    registered: input.registered ?? false,
    started: false,
    filesWritten: input.filesWritten ?? false,
    verificationIntent:
      input.verificationIntent ?? verificationIntent({ ...DEFAULT_REGISTRATION_VERIFICATION_POLICY, mode: "none" }, [])
  };
}

async function bindRegistrationPreview(
  request: RegistrationPreviewRequest,
  preview: RegistrationSetupResult,
  manifestRevision: string,
  writePaths: string[],
  verificationPolicy: RegistrationVerificationPolicy,
  healthCandidates: string[]
): Promise<RegistrationSetupResult> {
  const revision = await registrationRevision(preview.manifestPath, writePaths);
  const stable = JSON.stringify({ request, preview, manifestRevision, revision, writePaths: [...writePaths].sort() });
  const digest = createHash("sha256").update(stable).digest("hex");
  const previewId = `preview_${digest.slice(0, 24)}`;
  const bound = { ...preview, previewId, approval: { required: true, previewId } };
  registrationBindings.set(previewId, {
    preview: bound,
    request,
    manifestRevision: revision,
    createdAt: Date.now(),
    verificationPolicy,
    healthCandidates
  });
  return bound;
}

function pruneRegistrationBindings(): void {
  const cutoff = Date.now() - 15 * 60_000;
  for (const [previewId, binding] of registrationBindings) {
    if (binding.createdAt < cutoff) registrationBindings.delete(previewId);
  }
  while (registrationBindings.size > 128) {
    const oldest = registrationBindings.keys().next().value as string | undefined;
    if (!oldest) break;
    registrationBindings.delete(oldest);
  }
  for (const [previewId, binding] of registrationRepairBindings) {
    if (binding.createdAt < cutoff) registrationRepairBindings.delete(previewId);
  }
  while (registrationRepairBindings.size > 128) {
    const oldest = registrationRepairBindings.keys().next().value as string | undefined;
    if (!oldest) break;
    registrationRepairBindings.delete(oldest);
  }
}

async function registrationRevision(manifestPath: string, writePaths: string[]): Promise<string> {
  const paths = [...new Set([manifestPath, ...writePaths])].sort();
  const snapshots = await Promise.all(
    paths.map(async (filePath) => [filePath, (await readText(filePath)) ?? "<missing>"])
  );
  return createHash("sha256").update(JSON.stringify(snapshots)).digest("hex");
}

function registrationAppIdentity(app: AppRecord): string {
  return JSON.stringify({
    id: app.id,
    name: app.name,
    command: app.command,
    launch: app.launch,
    cwd: app.cwd,
    protocol: app.protocol,
    healthUrl: app.healthUrl,
    env: app.env,
    upstreamPort: app.upstreamPort,
    manifestPath: app.manifestPath
  });
}

async function registrationCleanupResolved(runtime: RelaybaseRuntime, appId: string): Promise<boolean> {
  if (runtime.registrationVerification.cleanupResolved(appId)) return true;
  const status = (await runtime.processes.listStatuses()).find((candidate) => candidate.id === appId)?.runtime;
  return Boolean(status?.status === "stopped" && status.stopVerification?.ok);
}

function registrationVerificationPolicy(request: RegistrationPreviewRequest): RegistrationVerificationPolicy {
  const mode = request.verificationMode;
  if (mode !== "quick" && mode !== "none") {
    throw new SetupApiRequestError(
      400,
      "REGISTER_VERIFICATION_MODE_INVALID",
      "Registration verificationMode must be 'quick' or 'none'.",
      { retryable: false, userAction: "Choose quick verification or explicitly register without verification." }
    );
  }
  const overrides = request.verificationPolicy ?? {};
  const budget = (name: keyof typeof overrides, fallback: number): number => {
    const value = overrides[name];
    if (value === undefined) return fallback;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 30_000) {
      throw new SetupApiRequestError(
        400,
        "REGISTER_VERIFICATION_POLICY_INVALID",
        `Registration verification policy ${name} must be a positive number no greater than 30000.`,
        { retryable: false, userAction: "Use the documented quick verification budgets." }
      );
    }
    return Math.floor(value);
  };
  const candidateLimit = overrides.candidateHealthProbeLimit ?? 3;
  if (!Number.isInteger(candidateLimit) || candidateLimit < 0 || candidateLimit > 3) {
    throw new SetupApiRequestError(
      400,
      "REGISTER_VERIFICATION_POLICY_INVALID",
      "candidateHealthProbeLimit must be an integer from 0 through 3.",
      { retryable: false, userAction: "Use no more than three bounded candidate probes." }
    );
  }
  const policy = {
    mode,
    startupBudgetMs: budget("startupBudgetMs", DEFAULT_REGISTRATION_VERIFICATION_POLICY.startupBudgetMs),
    probeTimeoutMs: budget("probeTimeoutMs", DEFAULT_REGISTRATION_VERIFICATION_POLICY.probeTimeoutMs),
    stopBudgetMs: budget("stopBudgetMs", DEFAULT_REGISTRATION_VERIFICATION_POLICY.stopBudgetMs),
    closureBudgetMs: budget("closureBudgetMs", DEFAULT_REGISTRATION_VERIFICATION_POLICY.closureBudgetMs),
    candidateHealthProbeLimit: candidateLimit
  };
  const total =
    policy.startupBudgetMs +
    policy.stopBudgetMs +
    policy.closureBudgetMs +
    policy.probeTimeoutMs * policy.candidateHealthProbeLimit;
  if (mode === "quick" && total > 30_000) {
    throw new SetupApiRequestError(
      400,
      "REGISTER_VERIFICATION_POLICY_INVALID",
      "Ordinary registration verification has a hard total budget of 30000ms.",
      {
        retryable: false,
        detail: { requestedTotalMs: total },
        userAction: "Use the documented quick policy or an explicit slow-adapter workflow."
      }
    );
  }
  return policy;
}

function registrationHealthCandidates(app: AppRecord, detected: string[] = []): string[] {
  return [...new Set([...(app.healthUrl ? [app.healthUrl] : []), ...detected, "/api/ping", "/health", "/"])]
    .filter((candidate) => candidate.startsWith("/"))
    .slice(0, 8);
}

function verificationIntent(policy: RegistrationVerificationPolicy, healthCandidates: string[]) {
  return {
    mode: policy.mode,
    willStart: policy.mode === "quick",
    willStop: policy.mode === "quick",
    expectedMaximumMs:
      policy.mode === "quick"
        ? policy.startupBudgetMs +
          policy.stopBudgetMs +
          policy.closureBudgetMs +
          policy.probeTimeoutMs * policy.candidateHealthProbeLimit
        : 0,
    healthCandidates: healthCandidates.slice(0, policy.candidateHealthProbeLimit + 1)
  };
}

export async function inspectManifest(raw: Record<string, unknown>): Promise<ExistingManifestAnalysis> {
  const manifestPath = await resolveManifestPath(String(raw.manifestPath ?? ""), stringOrUndefined(raw.cwd));
  return inspectManifestPath(manifestPath);
}

export async function validateManifest(raw: Record<string, unknown>): Promise<ExistingManifestAnalysis> {
  if (raw.manifest && typeof raw.manifest === "object") {
    try {
      const app = normalizeManifest(raw.manifest as AppManifestInput);
      return sanitizeSetupValue({
        path: "",
        exists: true,
        valid: true,
        app,
        manifest: raw.manifest,
        diagnostics: diagnosticsForApp(app)
      }) as ExistingManifestAnalysis;
    } catch (error) {
      return {
        path: "",
        exists: true,
        valid: false,
        diagnostics: [
          {
            code: "SETUP_MANIFEST_INVALID",
            severity: "error",
            message: errorMessage(error),
            userAction: "Fix the manifest fields before registering or applying setup."
          }
        ],
        error: errorMessage(error)
      };
    }
  }

  return inspectManifest(raw);
}

export async function previewManifestPatch(raw: Record<string, unknown>): Promise<ManifestPatchPlan> {
  return sanitizeSetupValue(await buildManifestPatchPlan(raw)) as ManifestPatchPlan;
}

async function buildManifestPatchPlan(raw: Record<string, unknown>): Promise<ManifestPatchPlan> {
  const request = raw as unknown as ManifestPatchRequest;
  const manifestPath = await resolveManifestPath(request.manifestPath ?? "", request.cwd);
  const cwd = await resolveProjectDirectory(request.cwd ?? path.dirname(manifestPath));
  ensureInside(cwd, manifestPath, "manifestPath");
  const manifest = await readManifestFile(manifestPath);
  const patchedManifest = patchManifest(manifest, request.patch);
  const preview = await fileWritePreview(
    manifestPath,
    JSON.stringify(patchedManifest, null, 2) + "\n",
    "Approved manifest field patch."
  );
  const diagnostics = manifestPatchDiagnostics(patchedManifest, manifestPath);

  return {
    cwd,
    manifestPath,
    manifest,
    patchedManifest,
    fileWritePlan: {
      root: cwd,
      writes: [preview],
      approvalRequired: true,
      risks: [
        {
          code: "manifest_write",
          severity: "warning",
          message: "Applying this patch writes relaybase.app.json.",
          requiresApproval: true
        }
      ]
    },
    diagnostics
  } as ManifestPatchPlan;
}

export async function applyManifestPatch(raw: Record<string, unknown>): Promise<ManifestPatchResult> {
  const plan = await buildManifestPatchPlan(raw);
  const content = JSON.stringify(plan.patchedManifest, null, 2) + "\n";
  const before = await readText(plan.manifestPath);
  await writeTextAtomic(plan.manifestPath, content);
  const app = normalizeManifest(plan.patchedManifest, { manifestPath: plan.manifestPath });

  return sanitizeSetupValue({
    cwd: plan.cwd,
    manifestPath: plan.manifestPath,
    app,
    file: {
      path: plan.manifestPath,
      action: before === content ? "unchanged" : before === undefined ? "created" : "updated"
    },
    diagnostics: diagnosticsForApp(app)
  }) as ManifestPatchResult;
}

export async function openSetupProject(
  runtime: RelaybaseRuntime,
  raw: Record<string, unknown>
): Promise<OpenProjectResult> {
  const request = raw as OpenProjectRequest;
  const cwd = await resolveProjectDirectory(request.cwd ?? request.currentDirectory);
  const plan: OpenProjectPlan = {
    cwd,
    approvalRequired: true,
    risks: [
      {
        code: "open_may_start_app",
        severity: "warning",
        message: "Opening a project may register a manifest, start an app, and expose a route.",
        requiresApproval: true
      }
    ]
  };
  const result = await openProject({
    cwd,
    host: runtime.host,
    port: runtime.port,
    stateDir: runtime.stateDir,
    noBrowser: request.noBrowser ?? true,
    sanitizeEnvironment: (environment) => runtime.agentGateway.sanitizeChildEnvironment(environment)
  });
  return sanitizeSetupValue({ plan, result }) as OpenProjectResult;
}

export async function proveSetup(runtime: RelaybaseRuntime, raw: Record<string, unknown>): Promise<ProveHealthResult> {
  const request = raw as ProveHealthRequest;
  const cwd = await resolveProjectDirectory(request.cwd ?? request.currentDirectory);
  const result = await healthProject({
    cwd,
    host: runtime.host,
    port: runtime.port,
    stateDir: runtime.stateDir,
    appId: request.appId,
    prove: true,
    lifecycleProof: Boolean(request.lifecycleProof),
    startDaemon: false
  });
  return sanitizeSetupValue({ cwd, result }) as ProveHealthResult;
}

export async function repairSetup(raw: Record<string, unknown>): Promise<RepairSetupResult> {
  const request = raw as RepairSetupRequest;
  const context = await setupContext({ ...request, profile: undefined, selectedPlanId: undefined });
  const previews = await Promise.all(
    context.plans.slice(0, 4).map((plan) => setupPreview(context.detection, context.plans, plan, context.request))
  );

  return {
    plan: {
      cwd: context.detection.root,
      choices: context.plans.map((plan) => planChoice(plan, context.detection)),
      previews,
      runtimeMatrix: context.detection.runtimeMatrix,
      repairCandidates: context.detection.runtimeMatrix.runtimes.flatMap((runtime) => runtime.repairCandidates),
      diagnostics: [
        ...diagnosticsForDetection(context.detection),
        {
          code: "SETUP_REPAIR_PREVIEW_ONLY",
          severity: "info",
          message:
            "Repair returns choices and previews only; applying repair writes requires /setup/apply confirmation."
        },
        ...(request.reason
          ? [
              {
                code: "SETUP_REPAIR_REASON",
                severity: "info" as const,
                message: request.reason
              }
            ]
          : [])
      ]
    }
  };
}

async function setupContext(request: SetupPlanRequest): Promise<{
  request: SetupPlanRequest;
  detection: ProjectDetection;
  plans: EngineSetupPlan[];
}> {
  const cwd = await resolveProjectDirectory(request.cwd ?? request.currentDirectory);
  const detection = await detectProject(cwd);
  const rawPlans = await setupSelectionGuard(() =>
    proposeSetupPlans(detection, {
      envStrategy: request.envStrategy as EnvStrategy | undefined,
      mcpInstall: request.mcpInstall,
      docker: request.docker as never,
      commandHint: request.commandHint ?? request.componentMetadata?.command,
      portStrategyHint: request.portStrategyHint
    })
  );
  const plans = applyComponentMetadataToPlans(rawPlans, request);
  if (!plans.length) {
    throw new SetupApiRequestError(422, "SETUP_NO_PLANS", "Relaybase could not generate setup plans.", {
      retryable: false,
      detail: { cwd },
      userAction: "Provide a command, manifest, or supported project structure."
    });
  }
  return { request, detection, plans };
}

async function setupSelectionGuard<T>(callback: () => Promise<T>): Promise<T> {
  try {
    return await callback();
  } catch (error) {
    if (error instanceof SetupSelectionError) {
      throw new SetupApiRequestError(
        error.code === "SETUP_PORT_STRATEGY_UNAVAILABLE" || error.code === "SETUP_PORT_STRATEGY_MISMATCH" ? 409 : 400,
        error.code,
        error.message,
        {
          retryable: false,
          detail: error.detail,
          userAction: error.userAction
        }
      );
    }
    throw error;
  }
}

function setupPreview(
  detection: ProjectDetection,
  plans: EngineSetupPlan[],
  selectedPlan: EngineSetupPlan,
  request: SetupPlanRequest
): SetupPlanPreview {
  const writes = selectedPlan.writes.map((write) => write).sort((left, right) => left.path.localeCompare(right.path));
  const previews = writes.map((write) => fileWritePreviewSync(write.path, write.preview, write.reason, write.action));
  previews.push(...metadataFilePreviews(detection.root, selectedPlan));
  const choice = planChoice(selectedPlan, detection);

  return sanitizeSetupValue({
    cwd: detection.root,
    selectedPlan: {
      id: selectedPlan.id,
      label: selectedPlan.label,
      architecture: selectedPlan.architecture,
      score: selectedPlan.score,
      manifest: selectedPlan.manifest,
      choice,
      writes: previews
    },
    ...componentPlanPreviews(detection, selectedPlan, request),
    choices: plans.map((plan) => planChoice(plan, detection)),
    fileWritePlan: {
      root: detection.root,
      writes: previews,
      approvalRequired: previews.some((write) => write.action !== "skip"),
      risks: writeRisks(previews)
    },
    diagnostics: diagnosticsForDetection(detection)
  }) as SetupPlanPreview;
}

function applyComponentMetadataToPlans(plans: EngineSetupPlan[], request: SetupPlanRequest): EngineSetupPlan[] {
  const metadata = request.componentMetadata;
  if (!metadata) {
    return plans;
  }
  return plans.map((plan) => withComponentMetadata(plan, metadata));
}

function componentPlanPreviews(
  detection: ProjectDetection,
  selectedPlan: EngineSetupPlan,
  request: SetupPlanRequest
): { componentPlans?: SetupPlan[] } {
  const requestedComponents = (request.components ?? []).filter(isComponentMetadata);
  if (requestedComponents.length) {
    return {
      componentPlans: requestedComponents.map((metadata, index) =>
        componentSetupPlan(detection, selectedPlan, metadata, index)
      )
    };
  }

  if (!selectedPlan.manifest.relaybase) {
    return {};
  }

  return {
    componentPlans: [
      {
        id: selectedPlan.id,
        label: selectedPlan.label,
        architecture: selectedPlan.architecture,
        score: selectedPlan.score,
        manifest: selectedPlan.manifest,
        choice: planChoice(selectedPlan, detection),
        writes: selectedPlan.writes.map((write) =>
          fileWritePreviewSync(write.path, write.preview, write.reason, write.action)
        )
      }
    ]
  };
}

function componentSetupPlan(
  detection: ProjectDetection,
  basePlan: EngineSetupPlan,
  metadata: ComponentSetupMetadata,
  index: number
): SetupPlan {
  const componentPlan = withComponentMetadata(basePlan, metadata);
  const manifestPath = path.join(detection.root, componentManifestFileName(metadata, index));
  const writes = componentPlan.writes.map((write) => {
    if (path.basename(write.path) === MANIFEST_FILE) {
      return fileWritePreviewSync(
        manifestPath,
        JSON.stringify(componentPlan.manifest, null, 2) + "\n",
        "Component-as-app manifest preview for grouped TUI panes.",
        "create"
      );
    }
    return fileWritePreviewSync(write.path, write.preview, write.reason, write.action);
  });

  return {
    id: componentPlan.id,
    label: componentPlan.label,
    architecture: componentPlan.architecture,
    score: componentPlan.score,
    manifest: componentPlan.manifest,
    choice: planChoice(componentPlan, detection),
    writes
  };
}

function withComponentMetadata(plan: EngineSetupPlan, metadata: ComponentSetupMetadata): EngineSetupPlan {
  const role = metadata.componentRole ?? "other";
  const baseId = String(metadata.appId ?? plan.manifest.id ?? "app");
  const displayName = metadata.displayName ?? metadata.name ?? String(plan.manifest.name ?? baseId);
  const manifest = {
    ...plan.manifest,
    ...(metadata.appId ? { id: metadata.appId } : {}),
    ...(metadata.name ? { name: metadata.name } : {}),
    ...(metadata.command ? { command: metadata.command } : {}),
    ...(metadata.cwd ? { cwd: metadata.cwd } : {}),
    ...(metadata.healthUrl ? { healthUrl: metadata.healthUrl } : {}),
    relaybase: {
      groupId: metadata.groupId ?? baseId,
      componentRole: role,
      displayName,
      paneLabel: metadata.paneLabel ?? role,
      paneOrder: metadata.paneOrder ?? (role === "frontend" ? 10 : role === "backend" ? 20 : 100)
    }
  } as AppManifestInput;

  return {
    ...plan,
    manifest,
    writes: plan.writes.map((write) =>
      path.basename(write.path) === MANIFEST_FILE
        ? {
            ...write,
            preview: JSON.stringify(manifest, null, 2) + "\n"
          }
        : write
    )
  };
}

function isComponentMetadata(value: unknown): value is ComponentSetupMetadata {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function componentManifestFileName(metadata: ComponentSetupMetadata, index: number): string {
  const raw = metadata.appId ?? metadata.name ?? metadata.componentRole ?? `component-${index + 1}`;
  const slug = String(raw)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `relaybase.${slug || `component-${index + 1}`}.app.json`;
}

function selectSetupPlan(plans: EngineSetupPlan[], request: SetupPlanRequest): EngineSetupPlan {
  const selectedId = request.selectedPlanId ?? request.profile;
  if (!selectedId) {
    if (request.portStrategyHint) {
      const match = plans.find((plan) => setupPlanHonorsPortStrategy(plan, request.portStrategyHint as PortStrategy));
      if (match) {
        return match;
      }
      throw new SetupApiRequestError(
        409,
        "SETUP_PORT_STRATEGY_UNAVAILABLE",
        "Requested setup port strategy is not available for this project.",
        {
          retryable: false,
          detail: {
            portStrategyHint: request.portStrategyHint,
            available: [...new Set(plans.flatMap((plan) => portStrategies(plan)))]
          },
          userAction: "Choose one of the port strategies returned by /__hub/api/setup/plans."
        }
      );
    }
    return plans[0] as EngineSetupPlan;
  }
  const selected =
    plans.find((plan) => plan.id === selectedId || plan.architecture === selectedId) ??
    (() => {
      throw new SetupApiRequestError(404, "SETUP_PLAN_NOT_FOUND", "Relaybase setup plan was not found.", {
        retryable: false,
        detail: { selectedPlanId: selectedId, available: plans.map((plan) => plan.id) },
        userAction: "Choose one of the setup plan ids returned by /__hub/api/setup/plans."
      });
    })();
  if (request.portStrategyHint && !setupPlanHonorsPortStrategy(selected, request.portStrategyHint as PortStrategy)) {
    throw new SetupApiRequestError(
      409,
      "SETUP_PORT_STRATEGY_MISMATCH",
      "Selected setup plan cannot honor the requested port strategy.",
      {
        retryable: false,
        detail: {
          selectedPlanId: selected.id,
          portStrategyHint: request.portStrategyHint,
          available: portStrategies(selected)
        },
        userAction: "Choose a compatible setup plan or remove the portStrategyHint."
      }
    );
  }
  return selected;
}

function setupPlanHonorsPortStrategy(plan: EngineSetupPlan, portStrategyHint: PortStrategy): boolean {
  if (portStrategyHint === "generated_launch_wrapper" || portStrategyHint === "framework_port_flags") {
    return plan.id === "framework-port-flag" || String(plan.manifest.command ?? "").includes(".relaybase/launch.cjs");
  }
  if (portStrategyHint === "fixed_upstream_port") {
    return plan.id === "pinned-upstream" || plan.manifest.upstreamPort !== undefined;
  }
  if (portStrategyHint === "docker_compose_wrapper" || portStrategyHint === "compose_port_mapping") {
    return plan.architecture === "docker-compose-service";
  }
  if (
    portStrategyHint === "managed_dynamic_port" ||
    portStrategyHint === "env_port" ||
    portStrategyHint === "runtime_specific_env"
  ) {
    return plan.architecture === "managed-dynamic-port";
  }
  return portStrategies(plan).includes(portStrategyHint);
}

function planChoice(plan: EngineSetupPlan, detection: ProjectDetection): SetupPlanChoice {
  const runtime =
    plan.runtimeId && detection.runtimeMatrix.runtimes.find((candidate) => candidate.runtime === plan.runtimeId)
      ? detection.runtimeMatrix.runtimes.find((candidate) => candidate.runtime === plan.runtimeId)
      : detection.primaryRuntime;
  return {
    id: plan.id,
    label: plan.label,
    architecture: plan.architecture,
    score: plan.score,
    framework: frameworkKind(detection.framework, plan.architecture),
    packageManager: packageManagerKind(detection.packageManager),
    portStrategies: portStrategies(plan),
    ...(runtime
      ? {
          runtimeId: runtime.runtime,
          runtimeConfidence: runtime.confidence,
          runtimeStartCommandCandidates: plan.startCommandCandidates ?? runtime.startCommandCandidates,
          runtimePortStrategies: plan.portBindingStrategies ?? runtime.portStrategies,
          runtimeHealthCandidates: plan.runtimeHealthCandidates ?? runtime.healthCandidates,
          setupQuestions: plan.setupQuestions ?? runtime.questions,
          repairCandidates: plan.repairCandidates ?? runtime.repairCandidates
        }
      : {}),
    ...(plan.selectedCommand ? { selectedCommand: plan.selectedCommand } : {}),
    ...(plan.selectedCommandSource ? { selectedCommandSource: plan.selectedCommandSource } : {}),
    ...(plan.selectedCommandCandidateId ? { selectedCommandCandidateId: plan.selectedCommandCandidateId } : {}),
    ...(plan.portStrategyHint ? { portStrategyHint: plan.portStrategyHint as PortStrategy } : {}),
    reasons: plan.reasons,
    risks: plan.risks,
    recoverySteps: plan.recoverySteps,
    requiresInput: plan.requiresInput ?? []
  };
}

function portStrategies(plan: EngineSetupPlan): PortStrategy[] {
  const strategies = new Set<PortStrategy>();
  for (const strategy of plan.portBindingStrategies ?? []) {
    if (strategy.id === "explicit_host_port_flags") {
      strategies.add("explicit_host_port_flags");
    } else if (strategy.id === "runtime_specific_env") {
      strategies.add("runtime_specific_env");
    } else if (strategy.id === "compose_port_mapping") {
      strategies.add("compose_port_mapping");
    } else {
      strategies.add(strategy.id);
    }
  }
  if (plan.manifest.upstreamPort !== undefined) {
    strategies.add("fixed_upstream_port");
  }
  if (plan.architecture === "managed-dynamic-port") {
    strategies.add("managed_dynamic_port");
    strategies.add("env_port");
  }
  if (plan.architecture === "framework-port-flag") {
    strategies.add("framework_port_flags");
    strategies.add("generated_launch_wrapper");
  }
  if (
    plan.architecture === "generated-launch-wrapper" ||
    String(plan.manifest.command).includes(".relaybase/launch.cjs")
  ) {
    strategies.add("generated_launch_wrapper");
  }
  if (plan.architecture === "docker-compose-service") {
    strategies.add("docker_compose_wrapper");
  }
  if (!strategies.size || plan.architecture === "mcp-only" || plan.architecture === "static-build-preview") {
    strategies.add("manual_custom");
  }
  return [...strategies];
}

function frameworkKind(framework: string, architecture: SetupArchitecture): FrameworkKind {
  if (architecture === "docker-compose-service") {
    return "docker_compose";
  }
  if (framework === "next" || framework === "vite" || framework === "astro") {
    return framework;
  }
  if (framework === "node-http") {
    return "node";
  }
  if (framework === "unknown") {
    return "unknown";
  }
  return "generic";
}

function packageManagerKind(packageManager: ProjectDetection["packageManager"]): PackageManagerKind {
  return packageManager;
}

function detectResultFromProject(detection: ProjectDetection): SetupDetectResult {
  const existingManifest = detection.existingManifestPath
    ? inspectManifestPathSync(detection.existingManifestPath)
    : undefined;
  const existingLaunchWrapper = detection.existingLaunchWrapperPath
    ? inspectSetupArtifactPathSync(detection.existingLaunchWrapperPath, "launch_wrapper")
    : undefined;
  const existingSetupProfile = detection.existingSetupProfilePath
    ? inspectSetupArtifactPathSync(detection.existingSetupProfilePath, "setup_profile")
    : undefined;

  return sanitizeSetupValue({
    cwd: detection.root,
    packageManager: packageManagerKind(detection.packageManager),
    packageCommand: detection.packageCommand,
    framework: frameworkKind(
      detection.framework,
      detection.dockerComposeFiles.length ? "docker-compose-service" : "managed-dynamic-port"
    ),
    appKind: detection.appKind,
    scripts: detection.scripts,
    envFiles: detection.envFiles,
    portEnvKeys: detection.portEnvKeys,
    detectedPorts: detection.detectedPorts,
    healthCandidates: detection.healthCandidates,
    dockerComposeFiles: detection.dockerComposeFiles,
    mcpHints: detection.mcpHints,
    monorepoHints: detection.monorepoHints,
    ...(existingManifest ? { existingManifest } : {}),
    ...(existingLaunchWrapper ? { existingLaunchWrapper } : {}),
    ...(existingSetupProfile ? { existingSetupProfile } : {}),
    ...(detection.primaryRuntime ? { primaryRuntime: detection.primaryRuntime } : {}),
    runtimeMatrix: detection.runtimeMatrix,
    diagnostics: diagnosticsForDetection(detection)
  }) as SetupDetectResult;
}

async function inspectManifestPath(manifestPath: string): Promise<ExistingManifestAnalysis> {
  try {
    const manifest = await readManifestFile(manifestPath);
    const app = normalizeManifest(manifest, { manifestPath });
    return sanitizeSetupValue({
      path: manifestPath,
      exists: true,
      valid: true,
      app,
      manifest,
      diagnostics: diagnosticsForApp(app)
    }) as ExistingManifestAnalysis;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        path: manifestPath,
        exists: false,
        valid: false,
        diagnostics: [
          {
            code: "SETUP_MANIFEST_MISSING",
            severity: "warning",
            message: "Manifest file does not exist.",
            userAction: "Run setup planning or choose an existing relaybase.app.json."
          }
        ],
        error: errorMessage(error)
      };
    }
    return {
      path: manifestPath,
      exists: true,
      valid: false,
      diagnostics: [
        {
          code: "SETUP_MANIFEST_INVALID",
          severity: "error",
          message: errorMessage(error),
          userAction: "Fix the manifest before registering or applying setup."
        }
      ],
      error: errorMessage(error)
    };
  }
}

function inspectManifestPathSync(manifestPath: string): ExistingManifestAnalysis {
  try {
    const raw = readFileSync(manifestPath, "utf8");
    const manifest = JSON.parse(raw) as AppManifestInput;
    const app = normalizeManifest(manifest, { manifestPath });
    return sanitizeSetupValue({
      path: manifestPath,
      exists: true,
      valid: true,
      app,
      manifest,
      diagnostics: diagnosticsForApp(app)
    }) as ExistingManifestAnalysis;
  } catch (error) {
    return {
      path: manifestPath,
      exists: false,
      valid: false,
      diagnostics: [
        {
          code: "SETUP_MANIFEST_UNREADABLE",
          severity: "warning",
          message: errorMessage(error),
          userAction: "Inspect or repair the manifest before applying setup."
        }
      ],
      error: errorMessage(error)
    };
  }
}

function inspectSetupArtifactPathSync(
  artifactPath: string,
  kind: ExistingSetupArtifactAnalysis["kind"]
): ExistingSetupArtifactAnalysis {
  try {
    const raw = readFileSync(artifactPath, "utf8");
    if (kind === "setup_profile") {
      const parsed = JSON.parse(raw) as { planId?: unknown; architecture?: unknown };
      return {
        path: artifactPath,
        exists: true,
        kind,
        valid: true,
        ...(typeof parsed.planId === "string" ? { planId: parsed.planId } : {}),
        ...(typeof parsed.architecture === "string" ? { architecture: parsed.architecture } : {}),
        diagnostics: []
      };
    }

    const valid = raw.includes("spawn") && raw.includes("process.env.PORT");
    return {
      path: artifactPath,
      exists: true,
      kind,
      valid,
      diagnostics: valid
        ? []
        : [
            {
              code: "SETUP_LAUNCH_WRAPPER_UNRECOGNIZED",
              severity: "warning",
              message: "Existing launch wrapper does not look like a Relaybase generated wrapper.",
              userAction: "Preview setup repair before overwriting the wrapper."
            }
          ]
    };
  } catch (error) {
    return {
      path: artifactPath,
      exists: true,
      kind,
      valid: false,
      diagnostics: [
        {
          code: "SETUP_ARTIFACT_UNREADABLE",
          severity: "warning",
          message: errorMessage(error),
          userAction: "Inspect the setup artifact before applying repairs."
        }
      ],
      error: errorMessage(error)
    };
  }
}

function diagnosticsForDetection(detection: ProjectDetection): SetupDiagnostic[] {
  const diagnostics: SetupDiagnostic[] = [];
  if (detection.framework === "unknown" && !detection.primaryRuntime && !detection.existingManifestPath) {
    diagnostics.push({
      code: "SETUP_PROJECT_AMBIGUOUS",
      severity: "warning",
      message: "Relaybase could not confidently identify this project framework.",
      detail: { cwd: detection.root },
      userAction: "Choose a manual command or create a relaybase.app.json manifest."
    });
  }
  if (detection.portEnvKeys.length) {
    diagnostics.push({
      code: "SETUP_PORT_ENV_DETECTED",
      severity: "info",
      message: "Project env files mention port keys; verify the app binds the Relaybase-assigned PORT.",
      detail: { keys: detection.portEnvKeys }
    });
  }
  for (const diagnostic of detection.runtimeMatrix.diagnostics) {
    diagnostics.push({
      code: diagnostic.code,
      severity: diagnostic.severity,
      message: diagnostic.message,
      detail: diagnostic.detail,
      userAction: diagnostic.userAction
    });
  }
  return diagnostics;
}

function diagnosticsForApp(app: AppRecord): SetupDiagnostic[] {
  return (app.manifestDiagnostics ?? []).map((diagnostic) => ({
    code: diagnostic.code,
    severity: diagnostic.severity,
    message: diagnostic.message,
    detail: diagnostic.detail,
    userAction: diagnostic.field ? `Fix ${diagnostic.field} in the app manifest.` : undefined
  }));
}

function manifestPatchDiagnostics(manifest: AppManifestInput, manifestPath: string): SetupDiagnostic[] {
  try {
    return diagnosticsForApp(normalizeManifest(manifest, { manifestPath }));
  } catch (error) {
    return [
      {
        code: "SETUP_MANIFEST_PATCH_INVALID",
        severity: "error",
        message: errorMessage(error),
        userAction: "Change the patch fields before applying."
      }
    ];
  }
}

function patchManifest(manifest: AppManifestInput, patch: Record<string, unknown> | undefined): AppManifestInput {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new SetupApiRequestError(400, "SETUP_PATCH_REQUIRED", "Manifest patch must be an object.", {
      retryable: false,
      userAction: "Provide a patch object with safe manifest fields."
    });
  }

  const output = structuredClone(manifest) as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (!SAFE_MANIFEST_FIELDS.has(key)) {
      throw new SetupApiRequestError(400, "SETUP_PATCH_FIELD_UNSUPPORTED", "Manifest patch field is not supported.", {
        retryable: false,
        detail: { field: key },
        userAction: "Patch only safe manifest fields documented for TUI setup."
      });
    }
    if (key === "relaybase") {
      output.relaybase = patchRelaybase(output.relaybase, value);
    } else if (key === "env") {
      output.env = patchEnv(output.env, value);
    } else if (key === "command") {
      output.command = patchCommand(value);
    } else {
      output[key] = value;
    }
  }

  return output as AppManifestInput;
}

function patchCommand(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new SetupApiRequestError(
      400,
      "SETUP_COMMAND_PATCH_INVALID",
      "Manifest command patch must be a non-empty string.",
      {
        retryable: false
      }
    );
  }
  if (/[&|<>;$`]/.test(value)) {
    throw new SetupApiRequestError(
      400,
      "SETUP_COMMAND_PATCH_UNSAFE",
      "Manifest command patch contains shell metacharacters.",
      {
        retryable: false,
        userAction: "Use setup command selection or a simple command without pipes, redirection, or backgrounding."
      }
    );
  }
  return value;
}

function patchRelaybase(current: unknown, patch: unknown): Record<string, unknown> {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new SetupApiRequestError(400, "SETUP_RELAYBASE_PATCH_INVALID", "relaybase patch must be an object.", {
      retryable: false
    });
  }
  const output =
    current && typeof current === "object" && !Array.isArray(current)
      ? { ...(current as Record<string, unknown>) }
      : {};
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (!SAFE_RELAYBASE_FIELDS.has(key)) {
      throw new SetupApiRequestError(
        400,
        "SETUP_RELAYBASE_FIELD_UNSUPPORTED",
        "relaybase patch field is not supported.",
        {
          retryable: false,
          detail: { field: key }
        }
      );
    }
    output[key] = value;
  }
  return output;
}

function patchEnv(current: unknown, patch: unknown): Record<string, unknown> {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new SetupApiRequestError(400, "SETUP_ENV_PATCH_INVALID", "env patch must be an object.", {
      retryable: false
    });
  }
  const output =
    current && typeof current === "object" && !Array.isArray(current)
      ? { ...(current as Record<string, unknown>) }
      : {};
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string") {
      throw new SetupApiRequestError(
        400,
        "SETUP_ENV_FIELD_UNSUPPORTED",
        "env patch values must be string env values.",
        {
          retryable: false,
          detail: { field: key }
        }
      );
    }
    output[key] = value;
  }
  return output;
}

function metadataFilePreviews(root: string, selectedPlan: EngineSetupPlan): FileWritePreview[] {
  const profile = {
    version: 1,
    appId: String(selectedPlan.manifest.id ?? "app"),
    planId: selectedPlan.id,
    architecture: selectedPlan.architecture,
    manifestPath: path.join(root, MANIFEST_FILE),
    command: String(selectedPlan.manifest.command ?? ""),
    envStrategy: selectedPlan.envStrategy,
    ...(selectedPlan.selectedCommand ? { selectedCommand: selectedPlan.selectedCommand } : {}),
    ...(selectedPlan.selectedCommandSource ? { selectedCommandSource: selectedPlan.selectedCommandSource } : {}),
    ...(selectedPlan.selectedCommandCandidateId
      ? { selectedCommandCandidateId: selectedPlan.selectedCommandCandidateId }
      : {}),
    ...(selectedPlan.portStrategyHint ? { portStrategy: selectedPlan.portStrategyHint } : {}),
    ...(selectedPlan.runtimeId
      ? {
          runtimeId: selectedPlan.runtimeId,
          runtimeCommandCandidates: selectedPlan.startCommandCandidates ?? [],
          runtimePortStrategies: selectedPlan.portBindingStrategies ?? [],
          runtimeHealthCandidates: selectedPlan.runtimeHealthCandidates ?? [],
          setupQuestions: selectedPlan.setupQuestions ?? []
        }
      : {})
  };
  const answers = {
    version: 1,
    selectedPlanId: selectedPlan.id,
    envStrategy: selectedPlan.envStrategy,
    commandHint: selectedPlan.selectedCommand,
    portStrategyHint: selectedPlan.portStrategyHint,
    ...(selectedPlan.manifest.relaybase ? { componentMetadata: selectedPlan.manifest.relaybase } : {})
  };

  return [
    fileWritePreviewSync(
      path.join(root, SETUP_DIR, LAUNCH_PROFILE_FILE),
      JSON.stringify(profile, null, 2) + "\n",
      "Relaybase launch profile used by open/repair flows.",
      "create"
    ),
    fileWritePreviewSync(
      path.join(root, SETUP_DIR, SETUP_PROFILE_FILE),
      JSON.stringify(profile, null, 2) + "\n",
      "TUI setup profile mirror for setup/onboarding inspection.",
      "create"
    ),
    fileWritePreviewSync(
      path.join(root, SETUP_DIR, SETUP_ANSWERS_FILE),
      JSON.stringify(answers, null, 2) + "\n",
      "Relaybase setup answers used for noninteractive replay.",
      "create"
    ),
    fileWritePreviewSync(
      path.join(root, SETUP_DIR, SETUP_REPORT_FILE),
      JSON.stringify({ version: 1, selectedPlanId: selectedPlan.id }, null, 2) + "\n",
      "Relaybase setup report written after apply.",
      "create"
    )
  ];
}

function writeRisks(writes: FileWritePreview[]): SetupApprovalRisk[] {
  const risks: SetupApprovalRisk[] = [];
  if (writes.some((write) => write.path.endsWith(MANIFEST_FILE))) {
    risks.push({
      code: "manifest_write",
      severity: "warning",
      message: "Setup may create or update relaybase.app.json.",
      requiresApproval: true
    });
  }
  if (writes.some((write) => write.path.endsWith("launch.cjs"))) {
    risks.push({
      code: "wrapper_write",
      severity: "warning",
      message: "Setup may create a Relaybase-owned launch wrapper.",
      requiresApproval: true
    });
  }
  if (
    writes.some((write) => path.basename(write.path).startsWith(".env") || write.reason.toLowerCase().includes("env"))
  ) {
    risks.push({
      code: "env_write",
      severity: "error",
      message: "Setup may change env-related files; values are redacted in previews.",
      requiresApproval: true
    });
  }
  return risks;
}

async function fileWritePreview(pathName: string, preview: string, reason: string): Promise<FileWritePreview> {
  const before = await readText(pathName);
  return fileWritePreviewFromBefore(pathName, before, preview, reason, before ? "update" : "create");
}

function fileWritePreviewSync(
  pathName: string,
  preview: string,
  reason: string,
  action: "create" | "update" | "skip"
): FileWritePreview {
  const before = readTextSync(pathName);
  return fileWritePreviewFromBefore(pathName, before, preview, reason, action);
}

function fileWritePreviewFromBefore(
  pathName: string,
  before: string | undefined,
  preview: string,
  reason: string,
  action: "create" | "update" | "skip"
): FileWritePreview {
  const safeBefore = redactSetupText(before ?? "");
  const safeAfter = redactSetupText(preview);
  const diff: FileDiff = {
    path: pathName,
    beforeExists: before !== undefined,
    afterExists: action !== "skip",
    changed: before !== preview,
    hunks: renderDiff(safeBefore, safeAfter)
  };
  return {
    path: pathName,
    action,
    reason,
    preview: safeAfter,
    diff
  };
}

function renderDiff(before: string, after: string): string[] {
  if (before === after) {
    return [];
  }
  const beforeLines = before.split(/\r?\n/).filter((line) => line.length);
  const afterLines = after.split(/\r?\n/).filter((line) => line.length);
  const hunks: string[] = [];
  for (const line of beforeLines.slice(0, 80)) {
    hunks.push(`- ${line}`);
  }
  for (const line of afterLines.slice(0, 120)) {
    hunks.push(`+ ${line}`);
  }
  if (beforeLines.length > 80 || afterLines.length > 120) {
    hunks.push("... diff truncated ...");
  }
  return hunks;
}

function requireConfirmation(raw: Record<string, unknown>, code: string, message: string): void {
  const request = raw as { confirm?: boolean; confirmation?: { confirmed?: boolean } };
  if (request.confirm === true || request.confirmation?.confirmed === true) {
    return;
  }
  throw new SetupApiRequestError(428, code, message, {
    retryable: true,
    userAction: "Preview the requested action, then retry with confirm:true or confirmation.confirmed:true."
  });
}

async function resolveProjectDirectory(cwd: string | undefined): Promise<string> {
  if (!cwd || typeof cwd !== "string") {
    throw new SetupApiRequestError(400, "SETUP_CWD_REQUIRED", "A project cwd is required for setup.", {
      retryable: false,
      userAction: "Provide cwd or currentDirectory from the TUI launch context."
    });
  }
  const resolved = path.resolve(cwd);
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) {
      throw new Error("Path is not a directory.");
    }
    return resolved;
  } catch (error) {
    throw new SetupApiRequestError(400, "SETUP_INVALID_PATH", "Relaybase setup path is invalid.", {
      retryable: false,
      detail: { cwd: resolved, error: errorMessage(error) },
      userAction: "Choose an existing project directory."
    });
  }
}

async function resolveManifestPath(manifestPath: string, cwd: string | undefined): Promise<string> {
  if (!manifestPath || typeof manifestPath !== "string") {
    throw new SetupApiRequestError(400, "SETUP_MANIFEST_PATH_REQUIRED", "A manifestPath is required.", {
      retryable: false,
      userAction: "Provide the relaybase.app.json path."
    });
  }
  const root = await resolveProjectDirectory(cwd ?? process.cwd());
  const resolved = path.resolve(root, manifestPath);
  ensureInside(root, resolved, "manifestPath");
  return resolved;
}

function ensureInside(root: string, target: string, field: string): void {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new SetupApiRequestError(
      400,
      "SETUP_PATH_OUTSIDE_PROJECT",
      "Setup path must stay inside the chosen project.",
      {
        retryable: false,
        detail: { field, root, target },
        userAction: "Choose a path inside the selected project directory."
      }
    );
  }
}

async function readText(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function readTextSync(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    return undefined;
  }
}

async function writeTextAtomic(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, content, "utf8");
  await fs.rename(tempPath, filePath);
}

function redactSetupText(text: string): string {
  const sanitized = sanitizeErrorDetail({ text }) as { text?: string };
  return (sanitized.text ?? "")
    .replace(/("([^"]*(?:token|secret|password|api[_-]?key)[^"]*)"\s*:\s*")([^"]*)(")/gi, "$1[redacted]$4")
    .replace(/('([^']*(?:token|secret|password|api[_-]?key)[^']*)'\s*:\s*')([^']*)(')/gi, "$1[redacted]$4");
}

function sanitizeSetupValue(value: unknown): unknown {
  return sanitizeErrorDetail(value);
}

async function readJsonBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > MAX_JSON_BODY_BYTES) {
      request.destroy();
      throw new SetupApiRequestError(413, "REQUEST_BODY_TOO_LARGE", "Request body exceeds the 1 MB limit.", {
        retryable: false
      });
    }
    chunks.push(buffer);
  }
  if (!chunks.length) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function publishSetupEvent(
  runtime: RelaybaseRuntime,
  type: DaemonEventType,
  correlationId: string,
  data: Record<string, unknown>
): void {
  runtime.events.publish({
    type,
    correlationId,
    data
  });
}

function setupEventSummary(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }
  const record = value as Record<string, unknown>;
  const selectedPlan = record.selectedPlan as Record<string, unknown> | undefined;
  const selectedChoice =
    selectedPlan && typeof selectedPlan.choice === "object" && selectedPlan.choice
      ? (selectedPlan.choice as Record<string, unknown>)
      : selectedPlan;
  const plan = record.plan as Record<string, unknown> | undefined;
  const result = record.result as Record<string, unknown> | undefined;
  const proof = result?.proof as Record<string, unknown> | undefined;
  return sanitizeSetupValue({
    cwd: record.cwd ?? plan?.cwd,
    choiceCount: Array.isArray(record.choices) ? record.choices.length : undefined,
    previewCount: Array.isArray(plan?.previews) ? plan.previews.length : undefined,
    selectedPlanId: selectedPlan?.id,
    runtime: setupRuntimeSummary(selectedChoice, record),
    appliedFileCount: Array.isArray(record.appliedFiles) ? record.appliedFiles.length : undefined,
    registeredAppId:
      (record.registeredApp as { id?: unknown } | undefined)?.id ??
      (record.app as { id?: unknown } | undefined)?.id ??
      (result?.appId as unknown),
    proofMode: proof?.mode,
    proofOk: proof?.ok,
    diagnosticCount: Array.isArray(record.diagnostics) ? record.diagnostics.length : undefined
  }) as Record<string, unknown>;
}

function setupRequestSummary(raw: Record<string, unknown>): Record<string, unknown> {
  return sanitizeSetupValue({
    cwd: raw.cwd ?? raw.currentDirectory,
    selectedPlanId: raw.selectedPlanId,
    profile: raw.profile,
    runtimePreference: raw.runtimePreference,
    commandHint: raw.commandHint ?? raw.command,
    portStrategyHint: raw.portStrategyHint,
    repair: raw.repair === true,
    appId: raw.appId,
    lifecycleProof: raw.lifecycleProof === true
  }) as Record<string, unknown>;
}

function setupRuntimeSummary(
  choice: Record<string, unknown> | undefined,
  record: Record<string, unknown>
): Record<string, unknown> | undefined {
  const runtimeId = choice?.runtimeId ?? (record.primaryRuntime as Record<string, unknown> | undefined)?.runtime;
  if (!runtimeId) {
    return undefined;
  }
  const commandCandidates = Array.isArray(choice?.runtimeStartCommandCandidates)
    ? (choice.runtimeStartCommandCandidates as Record<string, unknown>[])
    : [];
  const portStrategies = Array.isArray(choice?.portStrategies)
    ? choice.portStrategies
    : Array.isArray(choice?.runtimePortStrategies)
      ? (choice.runtimePortStrategies as Record<string, unknown>[]).map((strategy) => strategy.id)
      : [];
  return {
    runtimeId,
    confidence: choice?.runtimeConfidence,
    commandPreview: commandCandidates[0]?.commandPreview,
    portStrategies,
    questionCount: Array.isArray(choice?.setupQuestions) ? choice.setupQuestions.length : undefined
  };
}

function setupFailureData(error: unknown, raw: Record<string, unknown>): Record<string, unknown> {
  return sanitizeSetupValue({
    request: setupRequestSummary(raw),
    error: errorMessage(error)
  }) as Record<string, unknown>;
}

function isRepairApply(raw: Record<string, unknown>): boolean {
  return raw.repair === true;
}
