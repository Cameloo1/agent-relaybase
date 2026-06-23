import { randomUUID } from "node:crypto";
import type http from "node:http";
import type { RelaybaseError, RelaybaseErrorResponse } from "./apiTypes.ts";

export const CORRELATION_ID_HEADER = "x-relaybase-correlation-id";

interface RelaybaseErrorInput {
  code: string;
  message: string;
  detail?: unknown;
  retryable: boolean;
  userAction?: string;
  correlationId: string;
}

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_TOKEN_DETAIL_KEYS = new Set(["tokenpath", "tokenpresent"]);
const SECRET_ASSIGNMENT_PATTERN =
  /\b(token|secret|password|passwd|pwd|api[_-]?key|auth[_-]?token|cookie|session)(\s*[:=]\s*)(?!<)([^\s&,;]+)/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const MAX_DETAIL_DEPTH = 8;

export function correlationIdForRequest(request: http.IncomingMessage): string {
  const raw = request.headers[CORRELATION_ID_HEADER];
  const candidate = Array.isArray(raw) ? raw[0] : raw;

  if (candidate && CORRELATION_ID_PATTERN.test(candidate)) {
    return candidate;
  }

  return randomUUID();
}

export function setCorrelationHeader(response: http.ServerResponse, correlationId: string): void {
  if (!response.headersSent) {
    response.setHeader(CORRELATION_ID_HEADER, correlationId);
  }
}

export function createRelaybaseError(input: RelaybaseErrorInput): RelaybaseError {
  const detail = sanitizeErrorDetail(input.detail);
  const relaybaseError: RelaybaseError = {
    code: input.code,
    message: input.message,
    retryable: input.retryable,
    correlationId: input.correlationId
  };

  if (detail !== undefined) {
    relaybaseError.detail = detail;
  }

  if (input.userAction) {
    relaybaseError.userAction = input.userAction;
  }

  return relaybaseError;
}

export function relaybaseErrorResponse(input: RelaybaseErrorInput): RelaybaseErrorResponse {
  const relaybaseError = createRelaybaseError(input);
  const response: RelaybaseErrorResponse = {
    error: relaybaseError.message,
    code: relaybaseError.code,
    recoverable: relaybaseError.retryable,
    correlationId: relaybaseError.correlationId,
    relaybaseError
  };

  if (relaybaseError.detail !== undefined) {
    response.details = relaybaseError.detail;
  }

  return response;
}

export function sanitizeErrorDetail(detail: unknown): unknown {
  return sanitizeValue(detail, new WeakSet(), 0);
}

function sanitizeValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value === undefined || value === null) {
    return value;
  }

  if (typeof value === "string") {
    return redactString(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "symbol" || typeof value === "function") {
    return String(value);
  }

  if (value instanceof Error) {
    return {
      name: redactString(value.name),
      message: redactString(value.message)
    };
  }

  if (depth >= MAX_DETAIL_DEPTH) {
    return "[redacted-depth]";
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, seen, depth + 1));
  }

  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[redacted-circular]";
    }

    seen.add(value);
    const output: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      output[key] = isSensitiveDetailKey(key) ? "[redacted]" : sanitizeValue(nestedValue, seen, depth + 1);
    }
    seen.delete(value);
    return output;
  }

  return String(value);
}

function isSensitiveDetailKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (SAFE_TOKEN_DETAIL_KEYS.has(normalized)) {
    return false;
  }

  return (
    normalized === "token" ||
    normalized.endsWith("token") ||
    normalized === "secret" ||
    normalized.endsWith("secret") ||
    normalized === "password" ||
    normalized.endsWith("password") ||
    normalized === "pass" ||
    normalized.endsWith("pass") ||
    normalized === "passwd" ||
    normalized.endsWith("passwd") ||
    normalized === "pwd" ||
    normalized.endsWith("pwd") ||
    normalized === "passphrase" ||
    normalized.endsWith("passphrase") ||
    normalized === "authorization" ||
    normalized.endsWith("authorization") ||
    normalized === "auth" ||
    normalized.endsWith("auth") ||
    normalized === "cookie" ||
    normalized.endsWith("cookie") ||
    normalized === "session" ||
    normalized.endsWith("session") ||
    normalized === "credential" ||
    normalized.endsWith("credential") ||
    normalized === "credentials" ||
    normalized.endsWith("credentials") ||
    normalized === "apikey" ||
    normalized.endsWith("apikey") ||
    normalized === "key" ||
    normalized.endsWith("key") ||
    normalized === "cert" ||
    normalized.endsWith("cert") ||
    normalized === "privatekey" ||
    normalized.endsWith("privatekey")
  );
}

function redactString(value: string): string {
  return value
    .replace(BEARER_PATTERN, "Bearer [redacted]")
    .replace(SECRET_ASSIGNMENT_PATTERN, (_match, key: string, separator: string) => `${key}${separator}[redacted]`);
}
