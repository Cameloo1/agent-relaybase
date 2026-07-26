import { createHash, randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentConfigManager, SafeProviderCredentialMetadata } from "./configManager.ts";

const OPENROUTER_AUTH_URL = "https://openrouter.ai/auth";
const OPENROUTER_EXCHANGE_URL = "https://openrouter.ai/api/v1/auth/keys";
const OPENROUTER_KEY_STATUS_URL = "https://openrouter.ai/api/v1/key";
const DEFAULT_ATTEMPT_TTL_MS = 5 * 60_000;
const DEFAULT_PROVIDER_TIMEOUT_MS = 15_000;
const MAX_PROVIDER_BODY_BYTES = 64 * 1024;
const MAX_RETAINED_ATTEMPTS = 8;

export type OpenRouterConnectionAttemptStatus =
  | "waiting_for_browser"
  | "exchanging"
  | "validating"
  | "connected"
  | "connected_unverified"
  | "cancelled"
  | "expired"
  | "failed";

export interface OpenRouterConnectionAttemptState {
  attemptId: string;
  mode: "connect" | "replace";
  status: OpenRouterConnectionAttemptStatus;
  authorizationUrl?: string;
  expiresAt: string;
  completedAt?: string;
  diagnostic?: {
    code: string;
    message: string;
    userAction: string;
  };
}

interface InternalAttempt extends OpenRouterConnectionAttemptState {
  verifier: string;
  state: string;
  callbackPath: string;
  server: http.Server;
  timer: NodeJS.Timeout;
  used: boolean;
}

export interface OpenRouterConnectionManagerOptions {
  configManager: AgentConfigManager;
  fetch?: typeof globalThis.fetch;
  attemptTtlMs?: number;
  authUrl?: string;
  exchangeUrl?: string;
  keyStatusUrl?: string;
  providerTimeoutMs?: number;
  onStateChange?: (state: OpenRouterConnectionAttemptState) => void;
}

export class OpenRouterConnectionManager {
  readonly #configManager: AgentConfigManager;
  readonly #fetch: typeof globalThis.fetch;
  readonly #attemptTtlMs: number;
  readonly #authUrl: string;
  readonly #exchangeUrl: string;
  readonly #keyStatusUrl: string;
  readonly #providerTimeoutMs: number;
  readonly #onStateChange?: (state: OpenRouterConnectionAttemptState) => void;
  #attempts = new Map<string, InternalAttempt>();

  constructor(options: OpenRouterConnectionManagerOptions) {
    this.#configManager = options.configManager;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#attemptTtlMs = options.attemptTtlMs ?? DEFAULT_ATTEMPT_TTL_MS;
    this.#authUrl = options.authUrl ?? OPENROUTER_AUTH_URL;
    this.#exchangeUrl = options.exchangeUrl ?? OPENROUTER_EXCHANGE_URL;
    this.#keyStatusUrl = options.keyStatusUrl ?? OPENROUTER_KEY_STATUS_URL;
    this.#providerTimeoutMs = Math.max(1_000, options.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS);
    this.#onStateChange = options.onStateChange;
  }

  async start(mode: "connect" | "replace" = "connect"): Promise<OpenRouterConnectionAttemptState> {
    this.#pruneAttempts();
    for (const attempt of this.#attempts.values()) {
      if (
        attempt.status === "waiting_for_browser" ||
        attempt.status === "exchanging" ||
        attempt.status === "validating"
      ) {
        return safeAttempt(attempt);
      }
    }

    const attemptId = randomUUID();
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = randomBytes(32).toString("base64url");
    const callbackPath = `/relaybase/openrouter/callback/${attemptId}`;
    const expiresAt = new Date(Date.now() + this.#attemptTtlMs).toISOString();
    const server = http.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address() as AddressInfo;
    const callbackUrl = new URL(`http://127.0.0.1:${address.port}${callbackPath}`);
    callbackUrl.searchParams.set("state", state);
    const authorizationUrl = new URL(this.#authUrl);
    authorizationUrl.searchParams.set("callback_url", callbackUrl.toString());
    authorizationUrl.searchParams.set("code_challenge", challenge);
    authorizationUrl.searchParams.set("code_challenge_method", "S256");

    const timer = setTimeout(() => {
      const attempt = this.#attempts.get(attemptId);
      if (!attempt || terminalAttempt(attempt.status)) {
        return;
      }
      attempt.status = "expired";
      attempt.completedAt = new Date().toISOString();
      attempt.diagnostic = {
        code: "AGENT_PROVIDER_CONNECTION_EXPIRED",
        message: "The OpenRouter connection attempt expired.",
        userAction: "Start a new OpenRouter connection attempt."
      };
      closeAttemptServer(attempt);
      clearAttemptSecrets(attempt);
      this.#emit(attempt);
    }, this.#attemptTtlMs);
    timer.unref?.();

    const attempt: InternalAttempt = {
      attemptId,
      mode,
      status: "waiting_for_browser",
      authorizationUrl: authorizationUrl.toString(),
      expiresAt,
      verifier,
      state,
      callbackPath,
      server,
      timer,
      used: false
    };
    this.#attempts.set(attemptId, attempt);
    server.on("request", (request, response) => {
      void this.#handleCallback(attempt, request, response);
    });
    this.#emit(attempt);
    return safeAttempt(attempt);
  }

  status(attemptId?: string): OpenRouterConnectionAttemptState | null {
    if (attemptId) {
      const attempt = this.#attempts.get(attemptId);
      return attempt ? safeAttempt(attempt) : null;
    }
    const latest = [...this.#attempts.values()].at(-1);
    return latest ? safeAttempt(latest) : null;
  }

  clearTerminalAttempts(): number {
    let cleared = 0;
    for (const [attemptId, attempt] of this.#attempts) {
      if (!terminalAttempt(attempt.status)) {
        continue;
      }
      closeAttemptServer(attempt);
      clearAttemptSecrets(attempt);
      this.#attempts.delete(attemptId);
      cleared += 1;
    }
    return cleared;
  }

  close(): void {
    for (const attempt of this.#attempts.values()) {
      closeAttemptServer(attempt);
      clearAttemptSecrets(attempt);
    }
    this.#attempts.clear();
  }

  async validateCredential(credential: string): Promise<SafeProviderCredentialMetadata> {
    return validateOpenRouterCredential(credential, {
      fetch: this.#fetch,
      keyStatusUrl: this.#keyStatusUrl
    });
  }

  async #handleCallback(
    attempt: InternalAttempt,
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> {
    response.setHeader("cache-control", "no-store");
    if (attempt.used || terminalAttempt(attempt.status)) {
      sendCallbackPage(response, 410, "This OpenRouter connection attempt is no longer active.");
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method !== "GET" || url.pathname !== attempt.callbackPath) {
      sendCallbackPage(response, 404, "OpenRouter callback route not found.");
      return;
    }
    if (url.searchParams.get("state") !== attempt.state) {
      attempt.status = "failed";
      attempt.completedAt = new Date().toISOString();
      attempt.diagnostic = {
        code: "AGENT_PROVIDER_CONNECTION_STATE_MISMATCH",
        message: "The OpenRouter connection callback did not match the active attempt.",
        userAction: "Close this page and start a fresh OpenRouter connection."
      };
      sendCallbackPage(response, 400, "Relaybase rejected the callback because its state did not match.");
      closeAttemptServer(attempt);
      clearAttemptSecrets(attempt);
      this.#emit(attempt);
      return;
    }
    if (url.searchParams.has("error")) {
      attempt.status = "cancelled";
      attempt.completedAt = new Date().toISOString();
      attempt.diagnostic = {
        code: "AGENT_PROVIDER_CONNECTION_CANCELLED",
        message: "The OpenRouter connection was cancelled.",
        userAction: "Start a new connection attempt when ready."
      };
      sendCallbackPage(response, 200, "OpenRouter connection cancelled. You may close this page.");
      closeAttemptServer(attempt);
      clearAttemptSecrets(attempt);
      this.#emit(attempt);
      return;
    }
    const codes = url.searchParams.getAll("code").filter(Boolean);
    if (codes.length !== 1) {
      sendCallbackPage(response, 400, "Relaybase did not receive one valid authorization code.");
      return;
    }

    attempt.used = true;
    attempt.status = "exchanging";
    this.#emit(attempt);
    closeAttemptServer(attempt);
    sendCallbackPage(response, 200, "Relaybase received the authorization. You may close this page.");
    await this.#exchangeAndStore(attempt, codes[0] ?? "");
  }

  async #exchangeAndStore(attempt: InternalAttempt, code: string): Promise<void> {
    let credentialBuffer: Buffer | undefined;
    try {
      const exchangeResponse = await fetchWithTimeout(
        this.#fetch,
        this.#exchangeUrl,
        {
          method: "POST",
          redirect: "error",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            code,
            code_verifier: attempt.verifier,
            code_challenge_method: "S256"
          })
        },
        this.#providerTimeoutMs
      );
      const exchangeBody = await boundedJson(exchangeResponse);
      if (!exchangeResponse.ok || typeof exchangeBody.key !== "string" || !exchangeBody.key) {
        throw new OpenRouterConnectionError(
          "AGENT_PROVIDER_EXCHANGE_FAILED",
          "OpenRouter did not exchange the authorization code for a credential."
        );
      }
      credentialBuffer = Buffer.from(exchangeBody.key, "utf8");
      let metadata: SafeProviderCredentialMetadata | undefined;
      let verified = false;
      attempt.status = "validating";
      this.#emit(attempt);
      try {
        metadata = await this.validateCredential(exchangeBody.key);
        verified = true;
      } catch (error) {
        if (!(error instanceof OpenRouterValidationUnavailableError)) {
          throw error;
        }
      }
      await this.#configManager.storeManagedCredential(credentialBuffer, {
        verified,
        ...(metadata ? { metadata } : {})
      });
      attempt.status = verified ? "connected" : "connected_unverified";
      attempt.completedAt = new Date().toISOString();
      if (!verified) {
        attempt.diagnostic = {
          code: "AGENT_PROVIDER_KEY_UNVERIFIED",
          message: "The OpenRouter credential was protected locally but could not be validated.",
          userAction: "Retry provider validation before enabling remote Agent use."
        };
      }
      this.#emit(attempt);
    } catch (error) {
      attempt.status = "failed";
      attempt.completedAt = new Date().toISOString();
      attempt.diagnostic = safeConnectionDiagnostic(error);
      this.#emit(attempt);
    } finally {
      credentialBuffer?.fill(0);
      clearAttemptSecrets(attempt);
      this.#pruneAttempts();
    }
  }

  #emit(attempt: InternalAttempt): void {
    this.#onStateChange?.(safeAttempt(attempt));
  }

  #pruneAttempts(): void {
    const terminal = [...this.#attempts.values()].filter((attempt) => terminalAttempt(attempt.status));
    for (const attempt of terminal.slice(0, Math.max(0, terminal.length - MAX_RETAINED_ATTEMPTS))) {
      closeAttemptServer(attempt);
      clearAttemptSecrets(attempt);
      this.#attempts.delete(attempt.attemptId);
    }
  }
}

export async function validateOpenRouterCredential(
  credential: string,
  options: { fetch?: typeof globalThis.fetch; keyStatusUrl?: string } = {}
): Promise<SafeProviderCredentialMetadata> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchWithTimeout(
      fetchImpl,
      options.keyStatusUrl ?? OPENROUTER_KEY_STATUS_URL,
      {
        method: "GET",
        redirect: "error",
        headers: { authorization: `Bearer ${credential}` }
      },
      DEFAULT_PROVIDER_TIMEOUT_MS
    );
  } catch {
    throw new OpenRouterValidationUnavailableError();
  }
  const body = await boundedJson(response);
  if (!response.ok || !body.data || typeof body.data !== "object" || Array.isArray(body.data)) {
    throw new OpenRouterConnectionError("AGENT_PROVIDER_KEY_INVALID", "OpenRouter rejected the connected credential.");
  }
  const data = body.data as Record<string, unknown>;
  const keyLabel = safeKeyLabel(data.label);
  const metadata: SafeProviderCredentialMetadata = {
    ...(keyLabel ? { keyLabel } : {}),
    ...(finiteNumber(data.limit) !== undefined ? { limitUsd: finiteNumber(data.limit) } : {}),
    ...(finiteNumber(data.limit_remaining) !== undefined
      ? { limitRemainingUsd: finiteNumber(data.limit_remaining) }
      : {}),
    ...(data.limit_reset === "daily" || data.limit_reset === "weekly" || data.limit_reset === "monthly"
      ? { limitReset: data.limit_reset }
      : data.limit_reset === null
        ? { limitReset: null }
        : {}),
    ...(typeof data.expires_at === "string" || data.expires_at === null ? { expiresAt: data.expires_at } : {})
  };
  if (
    typeof metadata.expiresAt === "string" &&
    Number.isFinite(Date.parse(metadata.expiresAt)) &&
    Date.parse(metadata.expiresAt) <= Date.now()
  ) {
    throw new OpenRouterConnectionError("AGENT_CREDENTIAL_EXPIRED", "The OpenRouter credential is expired.");
  }
  return metadata;
}

function safeKeyLabel(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const label = value.trim().slice(0, 80);
  return label && !/sk-or-|bearer|authorization|api[_-]?key\s*[:=]/i.test(label) ? label : undefined;
}

export class OpenRouterConnectionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export class OpenRouterValidationUnavailableError extends Error {}

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PROVIDER_BODY_BYTES) {
    throw new OpenRouterConnectionError(
      "AGENT_PROVIDER_RESPONSE_TOO_LARGE",
      "OpenRouter returned an oversized response."
    );
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > MAX_PROVIDER_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new OpenRouterConnectionError(
          "AGENT_PROVIDER_RESPONSE_TOO_LARGE",
          "OpenRouter returned an oversized response."
        );
      }
      chunks.push(item.value);
    }
  }
  const text = reader
    ? Buffer.concat(
        chunks.map((chunk) => Buffer.from(chunk)),
        total
      ).toString("utf8")
    : "";
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function fetchWithTimeout(
  fetchImpl: typeof globalThis.fetch,
  input: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  return fetchImpl(input, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs)
  });
}

function safeAttempt(attempt: InternalAttempt): OpenRouterConnectionAttemptState {
  return {
    attemptId: attempt.attemptId,
    mode: attempt.mode,
    status: attempt.status,
    ...(attempt.status === "waiting_for_browser" ? { authorizationUrl: attempt.authorizationUrl } : {}),
    expiresAt: attempt.expiresAt,
    ...(attempt.completedAt ? { completedAt: attempt.completedAt } : {}),
    ...(attempt.diagnostic ? { diagnostic: { ...attempt.diagnostic } } : {})
  };
}

function safeConnectionDiagnostic(error: unknown): OpenRouterConnectionAttemptState["diagnostic"] {
  if (error instanceof OpenRouterConnectionError) {
    return {
      code: error.code,
      message: error.message,
      userAction: "Retry the OpenRouter connection. If it repeats, inspect provider availability."
    };
  }
  return {
    code: "AGENT_PROVIDER_CONNECTION_FAILED",
    message: "Relaybase could not complete the OpenRouter connection.",
    userAction: "Retry the connection. The previous active credential, if any, was preserved."
  };
}

function terminalAttempt(status: OpenRouterConnectionAttemptStatus): boolean {
  return ["connected", "connected_unverified", "cancelled", "expired", "failed"].includes(status);
}

function closeAttemptServer(attempt: InternalAttempt): void {
  clearTimeout(attempt.timer);
  if (attempt.server.listening) {
    attempt.server.close();
  }
}

function clearAttemptSecrets(attempt: InternalAttempt): void {
  attempt.verifier = "";
  attempt.state = "";
  delete attempt.authorizationUrl;
}

function sendCallbackPage(response: http.ServerResponse, status: number, message: string): void {
  const escaped = message.replace(/[&<>"']/g, (character) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character] ?? character;
  });
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'"
  });
  response.end(
    `<!doctype html><meta charset="utf-8"><title>Relaybase OpenRouter connection</title><style>body{font:16px system-ui;max-width:42rem;margin:4rem auto;padding:0 1rem;color:#171717}</style><h1>Relaybase</h1><p>${escaped}</p>`
  );
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
