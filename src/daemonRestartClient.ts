import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  daemonHttpRequest,
  discovery,
  ensureDaemon,
  readDaemonSessionToken,
  type RelaybaseCommandOptions
} from "./daemonLauncher.ts";
import type { DaemonRestartPreview, DaemonRestartPrepareResult } from "./daemonRestart.ts";
import { redactDiagnosticText } from "./redaction.ts";

export type DaemonRestartCode =
  | "daemon_restarted"
  | "daemon_restarted_with_app_failures"
  | "daemon_restarted_with_warnings"
  | "daemon_started"
  | "daemon_restart_blocked"
  | "daemon_restart_busy"
  | "daemon_restart_unsupported"
  | "daemon_restart_prepare_failed"
  | "daemon_restart_shutdown_failed"
  | "daemon_restart_stop_timeout"
  | "daemon_restart_start_failed"
  | "daemon_restart_identity_unverified";

export interface DaemonRestartAppResult {
  appId: string;
  status: "restored" | "failed";
  operationId?: string;
  error?: string;
}

export interface DaemonRestartResult {
  reachable: boolean;
  compatible: boolean;
  authenticated: boolean;
  started: boolean;
  restarted: boolean;
  code: DaemonRestartCode;
  userAction: string;
  requestId: string;
  oldInstanceId?: string;
  newInstanceId?: string;
  preview?: DaemonRestartPreview;
  prepared?: DaemonRestartPrepareResult;
  appResults?: DaemonRestartAppResult[];
  warnings?: string[];
  reportPath?: string;
  error?: string;
}

export async function restartDaemon(options: RelaybaseCommandOptions): Promise<DaemonRestartResult> {
  const requestId = `restart_${randomUUID()}`;
  const paths = restartPaths(options.stateDir, requestId);
  const lease = await acquireRestartLease(paths.lockPath, requestId);
  if (!lease.acquired) {
    return {
      reachable: false,
      compatible: false,
      authenticated: false,
      started: false,
      restarted: false,
      code: "daemon_restart_busy",
      userAction: "Wait for the active daemon restart to finish before retrying.",
      requestId,
      error: lease.error
    };
  }

  let result: DaemonRestartResult | undefined;
  try {
    const existing = await discovery(options);
    if (!existing.reachable && !existing.transportReachable) {
      const started = await ensureDaemon(options, true);
      const current = await discovery(options);
      result = {
        reachable: started.compatible,
        compatible: started.compatible,
        authenticated: started.authenticated,
        started: started.started,
        restarted: false,
        code: started.compatible ? "daemon_started" : "daemon_restart_start_failed",
        userAction: started.userAction,
        requestId,
        ...(current.instanceId ? { newInstanceId: current.instanceId } : {}),
        ...(!started.compatible && started.error ? { error: started.error } : {})
      };
      return await persistRestartResult(paths.reportPath, result);
    }
    if (!existing.compatible || !existing.instanceId) {
      result = {
        reachable: existing.reachable,
        compatible: existing.compatible,
        authenticated: existing.authenticated,
        started: false,
        restarted: false,
        code: "daemon_restart_unsupported",
        userAction: existing.compatible
          ? "Restart Relaybase once from the terminal to upgrade the running daemon, then retry in-app restart."
          : "Resolve the daemon identity, state-directory, or token mismatch before restarting.",
        requestId,
        error: existing.error ?? "Running daemon does not expose a restartable instance identity."
      };
      return await persistRestartResult(paths.reportPath, result);
    }
    const token = await readDaemonSessionToken(options.stateDir);
    if (!token) {
      result = {
        reachable: true,
        compatible: false,
        authenticated: false,
        started: false,
        restarted: false,
        code: "daemon_restart_prepare_failed",
        userAction: "Restore read access to the session token in the selected Relaybase state directory.",
        requestId,
        oldInstanceId: existing.instanceId,
        error: "Relaybase session token is unavailable."
      };
      return await persistRestartResult(paths.reportPath, result);
    }

    const previewResponse = await daemonHttpRequest(
      options,
      "GET",
      "/__hub/api/daemon/restart-preview",
      undefined,
      token,
      5000
    );
    const preview = restartPreviewFromResponse(previewResponse.body);
    if (!previewResponse.ok || !preview) {
      result = {
        reachable: true,
        compatible: true,
        authenticated: true,
        started: false,
        restarted: false,
        code: "daemon_restart_unsupported",
        userAction: "Restart Relaybase once from the terminal to upgrade the running daemon, then retry.",
        requestId,
        oldInstanceId: existing.instanceId,
        error: redactedHttpError(previewResponse)
      };
      return await persistRestartResult(paths.reportPath, result);
    }
    if (!preview.canRestart) {
      result = {
        reachable: true,
        compatible: true,
        authenticated: true,
        started: false,
        restarted: false,
        code: "daemon_restart_blocked",
        userAction: "Wait for or safely cancel the listed active work, then retry daemon restart.",
        requestId,
        oldInstanceId: existing.instanceId,
        preview
      };
      return await persistRestartResult(paths.reportPath, result);
    }

    const binding = {
      requestId,
      expectedInstanceId: existing.instanceId,
      previewId: preview.previewId
    };
    const prepareResponse = await daemonHttpRequest(
      options,
      "POST",
      "/__hub/api/daemon/prepare-restart",
      binding,
      token,
      10 * 60_000
    );
    const prepared = restartPreparedFromResponse(prepareResponse.body);
    if (!prepareResponse.ok || !prepared) {
      result = {
        reachable: true,
        compatible: true,
        authenticated: true,
        started: false,
        restarted: false,
        code: "daemon_restart_prepare_failed",
        userAction: "Inspect the restart preparation result and resolve any app shutdown failure before retrying.",
        requestId,
        oldInstanceId: existing.instanceId,
        preview,
        error: redactedHttpError(prepareResponse)
      };
      return await persistRestartResult(paths.reportPath, result);
    }

    const shutdownResponse = await daemonHttpRequest(
      options,
      "POST",
      "/__hub/api/daemon/shutdown",
      { ...binding, confirm: true },
      token,
      5000
    );
    if (!shutdownResponse.ok) {
      result = {
        reachable: true,
        compatible: true,
        authenticated: true,
        started: false,
        restarted: false,
        code: "daemon_restart_shutdown_failed",
        userAction: "Retry daemon shutdown with the same prepared restart request.",
        requestId,
        oldInstanceId: existing.instanceId,
        preview,
        prepared,
        error: redactedHttpError(shutdownResponse)
      };
      return await persistRestartResult(paths.reportPath, result);
    }

    if (!(await waitForInstanceToStop(options, existing.instanceId, 30_000))) {
      result = {
        reachable: true,
        compatible: true,
        authenticated: true,
        started: false,
        restarted: false,
        code: "daemon_restart_stop_timeout",
        userAction: "Inspect the daemon log; the prepared daemon did not release its listener before timeout.",
        requestId,
        oldInstanceId: existing.instanceId,
        preview,
        prepared,
        error: "Old Relaybase daemon remained reachable after prepared shutdown."
      };
      return await persistRestartResult(paths.reportPath, result);
    }

    const started = await ensureDaemon(options, true);
    if (!started.compatible) {
      result = {
        reachable: false,
        compatible: false,
        authenticated: false,
        started: started.started,
        restarted: false,
        code: "daemon_restart_start_failed",
        userAction: started.userAction,
        requestId,
        oldInstanceId: existing.instanceId,
        preview,
        prepared,
        error: started.error
      };
      return await persistRestartResult(paths.reportPath, result);
    }
    const current = await discovery(options);
    if (!current.compatible || !current.instanceId || current.instanceId === existing.instanceId) {
      result = {
        reachable: current.reachable,
        compatible: current.compatible,
        authenticated: current.authenticated,
        started: true,
        restarted: false,
        code: "daemon_restart_identity_unverified",
        userAction: "Inspect daemon discovery and confirm that a distinct Relaybase instance started.",
        requestId,
        oldInstanceId: existing.instanceId,
        ...(current.instanceId ? { newInstanceId: current.instanceId } : {}),
        preview,
        prepared,
        error: "Relaybase could not prove that the new daemon instance differs from the old instance."
      };
      return await persistRestartResult(paths.reportPath, result);
    }

    const appResults = await restoreApps(options, token, prepared.restoreAppIds);
    const restoreFailed = appResults.some((app) => app.status === "failed");
    const warnings = (prepared.serviceShutdownFailures ?? []).map(
      (failure) => `${failure.service} shutdown reported: ${failure.error}`
    );
    result = {
      reachable: true,
      compatible: true,
      authenticated: true,
      started: true,
      restarted: true,
      code: restoreFailed
        ? "daemon_restarted_with_app_failures"
        : warnings.length > 0
          ? "daemon_restarted_with_warnings"
          : "daemon_restarted",
      userAction: restoreFailed
        ? "Relaybase restarted; inspect the listed apps that could not be restored."
        : warnings.length > 0
          ? "Relaybase restarted and restored its apps; inspect the recorded service-shutdown warnings."
          : "Relaybase daemon restarted and restored every previously running daemon-owned app.",
      requestId,
      oldInstanceId: existing.instanceId,
      newInstanceId: current.instanceId,
      preview,
      prepared,
      appResults,
      ...(warnings.length > 0 ? { warnings } : {})
    };
    return await persistRestartResult(paths.reportPath, result);
  } catch (error) {
    result = {
      reachable: false,
      compatible: false,
      authenticated: false,
      started: false,
      restarted: false,
      code: "daemon_restart_prepare_failed",
      userAction: "Inspect the redacted restart report and retry after resolving the reported boundary.",
      requestId,
      error: redactDiagnosticText(error instanceof Error ? error.message : String(error))
    };
    return await persistRestartResult(paths.reportPath, result);
  } finally {
    await lease.release();
  }
}

async function restoreApps(
  options: RelaybaseCommandOptions,
  token: string,
  appIds: string[]
): Promise<DaemonRestartAppResult[]> {
  return Promise.all(
    appIds.map(async (appId) => {
      const started = await daemonHttpRequest(
        options,
        "POST",
        `/__hub/api/apps/${encodeURIComponent(appId)}/start?async=1`,
        undefined,
        token,
        5000
      );
      const operationId = operationIdFromResponse(started.body);
      if (!started.ok || !operationId) {
        return {
          appId,
          status: "failed" as const,
          error: redactedHttpError(started)
        };
      }
      const operation = await waitForOperation(options, token, operationId, 120_000);
      if (operation.status === "succeeded") {
        return { appId, status: "restored" as const, operationId };
      }
      return {
        appId,
        status: "failed" as const,
        operationId,
        error: operation.error ?? `Restore operation ended with status ${operation.status}.`
      };
    })
  );
}

async function waitForOperation(
  options: RelaybaseCommandOptions,
  token: string,
  operationId: string,
  timeoutMs: number
): Promise<{ status: string; error?: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await daemonHttpRequest(
      options,
      "GET",
      `/__hub/api/operations/${encodeURIComponent(operationId)}`,
      undefined,
      token,
      5000
    );
    const decoded = safeJson(response.body);
    const operation = objectValue(decoded.operation);
    const status = typeof operation.status === "string" ? operation.status : "";
    if (["succeeded", "failed", "cancelled", "aborted", "skipped", "timed_out"].includes(status)) {
      const error = objectValue(operation.error);
      return {
        status,
        ...(typeof error.message === "string" ? { error: redactDiagnosticText(error.message) } : {})
      };
    }
    await delay(250);
  }
  return { status: "timed_out", error: "App restore operation did not finish before timeout." };
}

async function waitForInstanceToStop(
  options: RelaybaseCommandOptions,
  instanceId: string,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await discovery(options);
    if (!current.transportReachable || current.instanceId !== instanceId) {
      return true;
    }
    await delay(150);
  }
  return false;
}

function restartPreviewFromResponse(body: string): DaemonRestartPreview | undefined {
  const decoded = safeJson(body);
  const restart = objectValue(decoded.restart);
  const preview = objectValue(restart.preview);
  return typeof preview.previewId === "string" &&
    typeof preview.instanceId === "string" &&
    typeof preview.canRestart === "boolean"
    ? (preview as unknown as DaemonRestartPreview)
    : undefined;
}

function restartPreparedFromResponse(body: string): DaemonRestartPrepareResult | undefined {
  const decoded = safeJson(body);
  const restart = objectValue(decoded.restart);
  const prepared = objectValue(restart.prepared);
  return typeof prepared.requestId === "string" && typeof prepared.instanceId === "string"
    ? (prepared as unknown as DaemonRestartPrepareResult)
    : undefined;
}

function operationIdFromResponse(body: string): string | undefined {
  const value = safeJson(body).operationId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function redactedHttpError(response: { statusCode: number; body: string }): string {
  const decoded = safeJson(response.body);
  const message =
    typeof decoded.message === "string"
      ? decoded.message
      : typeof decoded.error === "string"
        ? decoded.error
        : response.body || `HTTP ${response.statusCode}`;
  return redactDiagnosticText(message);
}

function safeJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return objectValue(parsed);
  } catch {
    return {};
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function restartPaths(stateDir: string, requestId: string): { lockPath: string; reportPath: string } {
  const restartDir = path.join(stateDir, "restarts");
  return {
    lockPath: path.join(restartDir, "restart.lock"),
    reportPath: path.join(restartDir, `${requestId}.json`)
  };
}

async function acquireRestartLease(
  lockPath: string,
  requestId: string
): Promise<{ acquired: boolean; error?: string; release(): Promise<void> }> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const tryAcquire = async () => {
    const handle = await fs.open(lockPath, "wx", 0o600);
    await handle.writeFile(
      `${JSON.stringify({ requestId, pid: process.pid, startedAt: new Date().toISOString() })}\n`,
      "utf8"
    );
    await handle.close();
  };
  try {
    await tryAcquire();
  } catch (error) {
    const recovered = await recoverStaleLease(lockPath);
    if (!recovered) {
      return {
        acquired: false,
        error: redactDiagnosticText(error instanceof Error ? error.message : String(error)),
        release: async () => undefined
      };
    }
    await tryAcquire();
  }
  return {
    acquired: true,
    release: async () => {
      try {
        const current = safeJson(await fs.readFile(lockPath, "utf8"));
        if (current.requestId === requestId) {
          await fs.unlink(lockPath);
        }
      } catch {
        // The lease is already absent or no longer belongs to this request.
      }
    }
  };
}

async function recoverStaleLease(lockPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(lockPath);
    if (Date.now() - stat.mtimeMs < 30 * 60_000) {
      return false;
    }
    const value = safeJson(await fs.readFile(lockPath, "utf8"));
    const pid = typeof value.pid === "number" ? value.pid : undefined;
    if (pid && processRunning(pid)) {
      return false;
    }
    await fs.unlink(lockPath);
    return true;
  } catch {
    return false;
  }
}

function processRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function persistRestartResult(reportPath: string, result: DaemonRestartResult): Promise<DaemonRestartResult> {
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  const temporary = `${reportPath}.${process.pid}.tmp`;
  const report = {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    ...redactRestartReport(result),
    reportPath: undefined
  };
  await fs.writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, reportPath);
  return { ...result, reportPath };
}

function redactRestartReport<T>(value: T): T {
  if (typeof value === "string") {
    return redactDiagnosticText(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactRestartReport(entry)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, redactRestartReport(entry)])
    ) as T;
  }
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
