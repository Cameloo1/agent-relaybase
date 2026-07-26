import type http from "node:http";
import type { RelaybaseRuntime } from "../server.ts";
import { sendJson } from "../responses.ts";
import { AgentGatewayRequestError } from "./gateway.ts";
import type { AgentMessageRequest, AgentRunEvent } from "./types.ts";

type RequireToken = (options?: { code?: string; message?: string; userAction?: string }) => void;
const MAX_JSON_BODY_BYTES = 1024 * 1024;
const MAX_AGENT_CONTROL_BODY_BYTES = 64 * 1024;
const MAX_REPLAY_DELTA_CHARS = 4096;

export async function handleAgentApiRequest(input: {
  runtime: RelaybaseRuntime;
  request: http.IncomingMessage;
  response: http.ServerResponse;
  parts: string[];
  requireToken: RequireToken;
}): Promise<boolean> {
  const { runtime, request, response, parts, requireToken } = input;
  if (parts[0] !== "__hub" || parts[1] !== "api" || parts[2] !== "agent") {
    return false;
  }

  requireToken({
    code: "UNAUTHORIZED_AGENT_GATEWAY",
    message: "Unauthorized Relaybase Agent Gateway access.",
    userAction: "Use the session token from this daemon state directory before using the Agent Gateway."
  });
  response.setHeader("cache-control", "no-store");
  response.setHeader("pragma", "no-cache");

  const route = parts.slice(3);

  if (request.method === "GET" && route.length === 1 && route[0] === "config") {
    sendJson(response, 200, { agent: { config: await runtime.agentGateway.getConfigStatus() } });
    return true;
  }

  if (request.method === "GET" && route.length === 1 && route[0] === "usage") {
    const url = new URL(request.url ?? "/", "http://localhost");
    const scope = url.searchParams.get("scope") ?? "active-thread";
    if (scope !== "active-thread") {
      throw new AgentGatewayRequestError(400, "AGENT_USAGE_SCOPE_INVALID", "Agent usage scope is invalid.", {
        retryable: false,
        userAction: "Use scope=active-thread."
      });
    }
    sendJson(response, 200, { agent: { usage: runtime.agentGateway.getActiveUsage() } });
    return true;
  }

  if (request.method === "PUT" && route.length === 1 && route[0] === "config") {
    const body = await readJsonBody(request, MAX_AGENT_CONTROL_BODY_BYTES);
    sendJson(response, 200, { agent: { config: runtime.agentGateway.updateConfig(body) } });
    return true;
  }

  if (request.method === "POST" && route.length === 2 && route[0] === "config" && route[1] === "reload") {
    sendJson(response, 200, { agent: { reload: await runtime.agentGateway.reloadConfig() } });
    return true;
  }

  if (request.method === "GET" && route.length === 2 && route[0] === "security" && route[1] === "status") {
    sendJson(response, 200, { agent: { security: await runtime.agentGateway.agentSecurityStatus() } });
    return true;
  }

  if (request.method === "POST" && route.length === 2 && route[0] === "security" && route[1] === "diagnose") {
    const body = await readJsonBody(request, MAX_AGENT_CONTROL_BODY_BYTES);
    requireAllowedFields(body, ["online"]);
    sendJson(response, 200, {
      agent: { security: await runtime.agentGateway.agentSecurityStatus({ online: body.online === true }) }
    });
    return true;
  }

  if (
    request.method === "GET" &&
    route.length === 4 &&
    route[0] === "security" &&
    route[1] === "repair" &&
    route[2] === "operations" &&
    route[3] === "latest"
  ) {
    sendJson(response, 200, {
      agent: {
        security: {
          repair: { operation: runtime.agentGateway.latestAgentSecurityRepairOperation() }
        }
      }
    });
    return true;
  }

  if (
    request.method === "GET" &&
    route.length === 4 &&
    route[0] === "security" &&
    route[1] === "repair" &&
    route[2] === "previews"
  ) {
    sendJson(response, 200, {
      agent: {
        security: {
          repair: { preview: runtime.agentGateway.agentSecurityRepairPreview(route[3]!) }
        }
      }
    });
    return true;
  }

  if (
    request.method === "POST" &&
    route.length === 3 &&
    route[0] === "security" &&
    route[1] === "repair" &&
    route[2] === "preview"
  ) {
    const body = await readJsonBody(request, MAX_AGENT_CONTROL_BODY_BYTES);
    requireAllowedFields(body, ["actionIds", "issueCodes", "safe", "online"]);
    rejectSecretRepairInput(body);
    sendJson(response, 200, {
      agent: {
        security: {
          repair: {
            preview: await runtime.agentGateway.previewAgentSecurityRepair({
              actionIds: stringArray(body.actionIds) as Parameters<
                typeof runtime.agentGateway.previewAgentSecurityRepair
              >[0]["actionIds"],
              issueCodes: stringArray(body.issueCodes),
              safe: body.safe === true,
              online: body.online === true
            })
          }
        }
      }
    });
    return true;
  }

  if (
    request.method === "POST" &&
    route.length === 3 &&
    route[0] === "security" &&
    route[1] === "repair" &&
    route[2] === "apply"
  ) {
    const body = await readJsonBody(request, MAX_AGENT_CONTROL_BODY_BYTES);
    requireAllowedFields(body, ["previewId", "idempotencyKey", "confirmation"]);
    rejectSecretRepairInput(body);
    sendJson(response, 200, {
      agent: {
        security: {
          repair: {
            operation: await runtime.agentGateway.applyAgentSecurityRepair({
              previewId: requiredBodyString(body, "previewId"),
              idempotencyKey: requiredBodyString(body, "idempotencyKey"),
              confirmation: requiredBodyString(body, "confirmation")
            })
          }
        }
      }
    });
    return true;
  }

  if (
    request.method === "GET" &&
    route.length === 4 &&
    route[0] === "security" &&
    route[1] === "repair" &&
    route[2] === "operations"
  ) {
    sendJson(response, 200, {
      agent: {
        security: {
          repair: { operation: runtime.agentGateway.agentSecurityRepairOperation(route[3]!) }
        }
      }
    });
    return true;
  }

  if (
    request.method === "POST" &&
    route.length === 5 &&
    route[0] === "security" &&
    route[1] === "repair" &&
    route[2] === "operations" &&
    route[4] === "cancel"
  ) {
    const body = await readJsonBody(request, MAX_AGENT_CONTROL_BODY_BYTES);
    requireAllowedFields(body, []);
    sendJson(response, 200, {
      agent: {
        security: {
          repair: { operation: runtime.agentGateway.cancelAgentSecurityRepair(route[3]!) }
        }
      }
    });
    return true;
  }

  if (
    request.method === "GET" &&
    route.length === 3 &&
    route[0] === "provider" &&
    route[1] === "openrouter" &&
    route[2] === "status"
  ) {
    const url = new URL(request.url ?? "/", "http://localhost");
    sendJson(response, 200, {
      agent: { provider: await runtime.agentGateway.providerStatus(url.searchParams.get("attemptId") ?? undefined) }
    });
    return true;
  }

  if (
    request.method === "POST" &&
    route.length === 3 &&
    route[0] === "provider" &&
    route[1] === "openrouter" &&
    (route[2] === "connect" || route[2] === "replace")
  ) {
    const body = await readJsonBody(request, MAX_AGENT_CONTROL_BODY_BYTES);
    sendJson(response, 202, {
      agent: {
        provider: {
          attempt: await runtime.agentGateway.connectOpenRouter(route[2] === "replace" ? "replace" : "connect", {
            openBrowser: body.openBrowser === true
          })
        }
      }
    });
    return true;
  }

  if (
    request.method === "POST" &&
    route.length === 4 &&
    route[0] === "provider" &&
    route[1] === "openrouter" &&
    route[2] === "legacy-removal" &&
    route[3] === "preview"
  ) {
    sendJson(response, 200, {
      agent: { provider: { legacyRemoval: await runtime.agentGateway.previewLegacyCredentialRemoval() } }
    });
    return true;
  }

  if (
    request.method === "POST" &&
    route.length === 4 &&
    route[0] === "provider" &&
    route[1] === "openrouter" &&
    route[2] === "legacy-removal" &&
    route[3] === "apply"
  ) {
    const body = await readJsonBody(request, MAX_AGENT_CONTROL_BODY_BYTES);
    requireControlConfirmation(body, "remove_legacy_external_credential");
    const previewId = typeof body.previewId === "string" ? body.previewId : "";
    if (!previewId) {
      throw new AgentGatewayRequestError(
        400,
        "AGENT_LEGACY_CREDENTIAL_REMOVAL_PREVIEW_REQUIRED",
        "A bound legacy credential removal preview is required.",
        { retryable: false, userAction: "Create a fresh removal preview and confirm it." }
      );
    }
    sendJson(response, 200, {
      agent: { provider: { legacyRemoval: await runtime.agentGateway.applyLegacyCredentialRemoval(previewId) } }
    });
    return true;
  }

  if (
    request.method === "POST" &&
    route.length === 3 &&
    route[0] === "provider" &&
    route[1] === "openrouter" &&
    route[2] === "validate"
  ) {
    await readJsonBody(request, MAX_AGENT_CONTROL_BODY_BYTES);
    sendJson(response, 200, { agent: { provider: await runtime.agentGateway.validateOpenRouterCredential() } });
    return true;
  }

  if (
    request.method === "POST" &&
    route.length === 3 &&
    route[0] === "provider" &&
    route[1] === "openrouter" &&
    route[2] === "disconnect"
  ) {
    const body = await readJsonBody(request, MAX_AGENT_CONTROL_BODY_BYTES);
    requireControlConfirmation(body, "disconnect_local_only");
    sendJson(response, 200, { agent: { provider: await runtime.agentGateway.disconnectOpenRouter() } });
    return true;
  }

  if (
    request.method === "POST" &&
    route.length === 3 &&
    route[0] === "provider" &&
    route[1] === "openrouter" &&
    route[2] === "migrate"
  ) {
    const body = await readJsonBody(request, MAX_AGENT_CONTROL_BODY_BYTES);
    requireControlConfirmation(body, "migrate_to_windows_dpapi");
    sendJson(response, 200, { agent: { provider: await runtime.agentGateway.migrateOpenRouterCredential() } });
    return true;
  }

  if (
    request.method === "POST" &&
    route.length === 4 &&
    route[0] === "provider" &&
    route[1] === "openrouter" &&
    route[2] === "revoke" &&
    route[3] === "preview"
  ) {
    sendJson(response, 200, {
      agent: {
        provider: runtime.agentGateway.previewOpenRouterRevocation()
      }
    });
    return true;
  }

  if (
    request.method === "POST" &&
    route.length === 3 &&
    route[0] === "provider" &&
    route[1] === "openrouter" &&
    route[2] === "revoke"
  ) {
    const body = await readJsonBody(request, MAX_AGENT_CONTROL_BODY_BYTES);
    requireControlConfirmation(body, "open_provider_key_management");
    runtime.agentGateway.recordOpenRouterRevocationUnconfirmed();
    sendJson(response, 409, {
      code: "AGENT_PROVIDER_REVOCATION_UNCONFIRMED",
      message: "Relaybase cannot revoke this key without an OpenRouter management credential.",
      retryable: false,
      userAction: "Revoke the key in OpenRouter, then disconnect it locally.",
      detail: {
        managementUrl: "https://openrouter.ai/settings/keys",
        localCredentialPreserved: true
      }
    });
    return true;
  }

  if (
    request.method === "PUT" &&
    route.length === 3 &&
    route[0] === "provider" &&
    route[1] === "openrouter" &&
    route[2] === "security-mode"
  ) {
    const body = await readJsonBody(request, MAX_AGENT_CONTROL_BODY_BYTES);
    sendJson(response, 200, {
      agent: { provider: runtime.agentGateway.setWindowsVerificationMode(body.mode) }
    });
    return true;
  }

  if (request.method === "POST" && route.length === 1 && route[0] === "sessions") {
    const body = await readJsonBody(request);
    const session = await runtime.agentGateway.createSession(runtime, body);
    sendJson(response, 201, { agent: { session } });
    return true;
  }

  if (request.method === "GET" && route.length === 1 && route[0] === "sessions") {
    sendJson(response, 200, { agent: { sessions: runtime.agentGateway.listSessions() } });
    return true;
  }

  if (request.method === "GET" && route.length === 2 && route[0] === "sessions" && route[1] === "active") {
    sendJson(response, 200, { agent: { session: runtime.agentGateway.getActiveSession() ?? null } });
    return true;
  }

  if (request.method === "GET" && route.length === 2 && route[0] === "sessions") {
    sendJson(response, 200, { agent: { session: runtime.agentGateway.getSession(route[1]) } });
    return true;
  }

  if (request.method === "PATCH" && route.length === 2 && route[0] === "sessions") {
    const body = await readJsonBody(request);
    const session = await runtime.agentGateway.updateSession(runtime, route[1], body);
    sendJson(response, 200, { agent: { session } });
    return true;
  }

  if (request.method === "POST" && route.length === 3 && route[0] === "sessions" && route[2] === "activate") {
    sendJson(response, 200, { agent: { session: runtime.agentGateway.activateSession(route[1]) } });
    return true;
  }

  if (request.method === "POST" && route.length === 3 && route[0] === "sessions" && route[2] === "clear") {
    sendJson(response, 200, { agent: { session: runtime.agentGateway.clearSession(route[1]) } });
    return true;
  }

  if (request.method === "DELETE" && route.length === 2 && route[0] === "sessions") {
    sendJson(response, 200, { agent: { session: runtime.agentGateway.clearSession(route[1]) } });
    return true;
  }

  if (request.method === "GET" && route.length === 3 && route[0] === "sessions" && route[2] === "export") {
    const url = new URL(request.url ?? "/", "http://localhost");
    const format = url.searchParams.get("format") === "markdown" ? "markdown" : "json";
    sendJson(response, 200, { agent: { export: runtime.agentGateway.exportSession(route[1], { format }) } });
    return true;
  }

  if (request.method === "GET" && route.length === 3 && route[0] === "sessions" && route[2] === "context-preview") {
    sendJson(response, 200, { agent: { contextPreview: runtime.agentGateway.threadContextPreview(route[1]) } });
    return true;
  }

  if (request.method === "GET" && route.length === 3 && route[0] === "sessions" && route[2] === "runs") {
    sendJson(response, 200, { agent: { runs: runtime.agentGateway.listRuns(route[1]) } });
    return true;
  }

  if (
    request.method === "GET" &&
    route.length === 4 &&
    route[0] === "sessions" &&
    route[2] === "runs" &&
    route[3] === "active"
  ) {
    sendJson(response, 200, { agent: { run: runtime.agentGateway.activeRun(route[1]) ?? null } });
    return true;
  }

  if (request.method === "GET" && route.length === 4 && route[0] === "sessions" && route[2] === "runs") {
    sendJson(response, 200, { agent: { run: runtime.agentGateway.getRun(route[1], route[3]) } });
    return true;
  }

  if (
    request.method === "POST" &&
    route.length === 5 &&
    route[0] === "sessions" &&
    route[2] === "runs" &&
    route[4] === "cancel"
  ) {
    sendJson(response, 200, { agent: { run: runtime.agentGateway.cancelRun(route[1], route[3]) } });
    return true;
  }

  if (
    request.method === "POST" &&
    route.length === 5 &&
    route[0] === "sessions" &&
    route[2] === "runs" &&
    route[4] === "retry"
  ) {
    const body = await readJsonBody(request);
    const idempotencyKey = requestIdempotencyKey(request, body);
    const result = await runtime.agentGateway.retryRun(runtime, route[1], route[3], {
      ...(idempotencyKey ? { idempotencyKey } : {})
    });
    sendJson(response, 202, { agent: result });
    return true;
  }

  if (request.method === "POST" && route.length === 3 && route[0] === "sessions" && route[2] === "messages") {
    const body = await readJsonBody(request);
    const idempotencyKey = requestIdempotencyKey(request, body);
    const result = await runtime.agentGateway.addMessage(runtime, route[1], {
      ...(body as unknown as AgentMessageRequest),
      ...(idempotencyKey ? { idempotencyKey } : {})
    });
    sendJson(response, 202, { agent: result });
    return true;
  }

  if (request.method === "GET" && route.length === 3 && route[0] === "sessions" && route[2] === "events") {
    const url = new URL(request.url ?? "/", "http://localhost");
    await streamAgentSessionEvents(runtime, request, response, route[1], parseAfterSequence(url, request));
    return true;
  }

  if (request.method === "POST" && route.length === 3 && route[0] === "approvals" && route[2] === "approve") {
    const body = await readJsonBody(request);
    const approval = await runtime.agentGateway.resolveApproval(runtime, route[1], "approved", body);
    sendJson(response, 200, { agent: { approval } });
    return true;
  }

  if (request.method === "POST" && route.length === 3 && route[0] === "approvals" && route[2] === "reject") {
    const body = await readJsonBody(request);
    const approval = await runtime.agentGateway.resolveApproval(runtime, route[1], "rejected", body);
    sendJson(response, 200, { agent: { approval } });
    return true;
  }

  if (request.method === "GET" && route.length === 1 && route[0] === "diagnostics") {
    sendJson(response, 200, { agent: { diagnostics: await runtime.agentGateway.diagnostics(runtime) } });
    return true;
  }

  throw new AgentGatewayRequestError(404, "AGENT_ROUTE_NOT_FOUND", "Relaybase Agent Gateway route was not found.", {
    retryable: false,
    detail: { method: request.method, route: parts.join("/") },
    userAction: "Use one of the documented /__hub/api/agent routes."
  });
}

async function streamAgentSessionEvents(
  runtime: RelaybaseRuntime,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  sessionId: string,
  afterSequence: number
): Promise<void> {
  runtime.agentGateway.getSession(sessionId);
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  response.flushHeaders?.();

  let closed = false;
  const send = (eventName: string, id: string, data: unknown, retryMs?: number) => {
    if (closed || response.destroyed) {
      return;
    }
    if (retryMs !== undefined) {
      response.write(`retry: ${retryMs}\n`);
    }
    response.write(`id: ${id}\nevent: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send(
    "diagnostic",
    "agent-session-connected",
    {
      sessionId,
      reconnect: {
        replay: "events_after_sequence",
        requiresSessionRefresh: false,
        lastEventId: headerText(request.headers["last-event-id"]) || null,
        afterSequence
      }
    },
    3000
  );

  for (const event of coalesceAgentReplayEvents(runtime.agentGateway.sessionEvents(sessionId, afterSequence))) {
    send(event.type, String(event.sequence), event);
  }

  send("stream.replay_completed", `agent-replay-${afterSequence}`, {
    id: `agent-replay-${afterSequence}`,
    sequence: 0,
    sessionId,
    type: "stream.replay_completed",
    data: { afterSequence }
  });

  const unsubscribe = runtime.agentGateway.subscribeSession(sessionId, (event) => {
    send(event.type, String(event.sequence), event);
  });
  const heartbeat = setInterval(() => {
    if (!closed && !response.destroyed) {
      response.write(`: heartbeat ${new Date().toISOString()}\n\n`);
    }
  }, 1000);

  const cleanup = () => {
    if (closed) {
      return;
    }
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    if (!response.destroyed) {
      response.end();
    }
  };
  request.once("close", cleanup);
  response.once("close", cleanup);
}

export function coalesceAgentReplayEvents(events: readonly AgentRunEvent[]): AgentRunEvent[] {
  const coalesced: AgentRunEvent[] = [];
  let pendingEvent: AgentRunEvent | undefined;
  let pendingDelta = "";

  const flush = () => {
    if (!pendingEvent || !pendingDelta) {
      pendingEvent = undefined;
      pendingDelta = "";
      return;
    }
    const data = isRecord(pendingEvent.data) ? pendingEvent.data : {};
    coalesced.push({ ...pendingEvent, data: { ...data, delta: pendingDelta } });
    pendingEvent = undefined;
    pendingDelta = "";
  };

  for (const event of events) {
    const delta = event.type === "model.delta" && isRecord(event.data) ? event.data.delta : undefined;
    if (typeof delta !== "string" || !delta) {
      flush();
      coalesced.push(event);
      continue;
    }
    if (
      pendingEvent &&
      (pendingEvent.runId !== event.runId || pendingDelta.length + delta.length > MAX_REPLAY_DELTA_CHARS)
    ) {
      flush();
    }
    pendingEvent = event;
    pendingDelta += delta;
  }
  flush();
  return coalesced;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function headerText(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join(",") : (value ?? "");
}

function parseAfterSequence(url: URL, request: http.IncomingMessage): number {
  const queryValue = url.searchParams.get("afterSequence");
  const headerValue = headerText(request.headers["last-event-id"]);
  const value = queryValue ?? sequenceFromEventId(headerValue);
  if (!value) {
    return 0;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function sequenceFromEventId(value: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const match = value.match(/(?:^|:)(\d+)$/);
  return match?.[1] ?? (/^\d+$/.test(value) ? value : undefined);
}

function requestIdempotencyKey(request: http.IncomingMessage, body: Record<string, unknown>): string | undefined {
  const headerKey = headerText(request.headers["idempotency-key"]).trim();
  const bodyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
  if (headerKey && bodyKey && headerKey !== bodyKey) {
    throw new AgentGatewayRequestError(
      400,
      "AGENT_IDEMPOTENCY_KEY_CONFLICT",
      "Idempotency-Key header and body idempotencyKey must match when both are provided.",
      { retryable: false, userAction: "Send one stable idempotency key for the submission." }
    );
  }
  return headerKey || bodyKey || undefined;
}

async function readJsonBody(
  request: http.IncomingMessage,
  maximumBytes = MAX_JSON_BODY_BYTES
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maximumBytes) {
      request.destroy();
      throw new AgentGatewayRequestError(413, "REQUEST_BODY_TOO_LARGE", "Request body exceeds the route limit.", {
        retryable: false
      });
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function requireControlConfirmation(body: Record<string, unknown>, expected: string): void {
  if (body.confirm !== expected) {
    throw new AgentGatewayRequestError(
      400,
      "AGENT_PROVIDER_CONFIRMATION_REQUIRED",
      "This provider action requires an exact confirmation binding.",
      {
        retryable: false,
        userAction: `Retry with confirm=${expected}.`
      }
    );
  }
}

function requireAllowedFields(body: Record<string, unknown>, allowed: string[]): void {
  const unexpected = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new AgentGatewayRequestError(
      400,
      "AGENT_SECURITY_REPAIR_REQUEST_INVALID",
      "Agent security repair request contains unsupported fields.",
      {
        retryable: false,
        detail: { unexpectedFields: unexpected.sort() },
        userAction: "Use the documented repair request."
      }
    );
  }
}

function rejectSecretRepairInput(value: unknown, depth = 0): void {
  if (depth > 6 || value === null || value === undefined) {
    return;
  }
  if (typeof value === "string") {
    if (/\bsk-(?:or-)?[A-Za-z0-9._-]{8,}/i.test(value)) {
      throw new AgentGatewayRequestError(
        400,
        "AGENT_RAW_API_KEY_NOT_ALLOWED",
        "Agent security repair requests must not contain a raw provider key.",
        { retryable: false, userAction: "Use the daemon-owned Provider connection flow." }
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) rejectSecretRepairInput(item, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (/^(?:apiKey|credential|secret|token|ciphertext|environmentValue)$/i.test(key)) {
        throw new AgentGatewayRequestError(
          400,
          "AGENT_RAW_API_KEY_NOT_ALLOWED",
          "Agent security repair requests must not contain credential material.",
          { retryable: false, userAction: "Use the daemon-owned Provider connection flow." }
        );
      }
      rejectSecretRepairInput(nested, depth + 1);
    }
  }
}

function stringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new AgentGatewayRequestError(
      400,
      "AGENT_SECURITY_REPAIR_REQUEST_INVALID",
      "Agent security repair list fields must contain non-empty strings.",
      { retryable: false, userAction: "Use action and issue identifiers returned by diagnosis." }
    );
  }
  return value.map((item) => String(item).trim());
}

function requiredBodyString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || !value.trim() || value.length > 512) {
    throw new AgentGatewayRequestError(
      400,
      "AGENT_SECURITY_REPAIR_REQUEST_INVALID",
      `Agent security repair field ${field} is required and must be bounded text.`,
      { retryable: false, userAction: "Use the exact values returned by the repair preview." }
    );
  }
  return value.trim();
}
