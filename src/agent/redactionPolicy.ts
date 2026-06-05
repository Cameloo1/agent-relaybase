import { sanitizeAgentPayload } from "./errors.ts";

const SECRET_ASSIGNMENT_PATTERN = /\b(token|secret|password|api[_-]?key)(\s*[:=]\s*)([^\s&,;]+)/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const SECRET_VALUE_PATTERN = /\bsk-[A-Za-z0-9_-]{8,}\b/gi;
const SECRET_KEY_PATTERN = /token|secret|password|api[_-]?key|authorization|cookie|session/i;

export function redactApprovalPayload(value: unknown, knownSecrets: string[] = []): unknown {
  return sanitizeAgentPayload(redactValue(value, knownSecrets));
}

export function containsSecretLikeValue(value: unknown): boolean {
  if (typeof value === "string") {
    return (
      patternMatches(SECRET_ASSIGNMENT_PATTERN, value) ||
      patternMatches(BEARER_PATTERN, value) ||
      patternMatches(SECRET_VALUE_PATTERN, value)
    );
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsSecretLikeValue(entry));
  }
  return Object.entries(value as Record<string, unknown>).some(([key, nested]) => {
    if (SECRET_KEY_PATTERN.test(key) && typeof nested === "string" && nested.trim() && !isSafeReference(nested)) {
      return true;
    }
    return containsSecretLikeValue(nested);
  });
}

export function isSecretLikeKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

export function isSafeReference(value: string): boolean {
  return /^env:[A-Za-z_][A-Za-z0-9_]*$/.test(value.trim());
}

function patternMatches(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  const matched = pattern.test(value);
  pattern.lastIndex = 0;
  return matched;
}

function redactValue(value: unknown, knownSecrets: string[]): unknown {
  if (value === undefined || value === null) {
    return value;
  }
  if (typeof value === "string") {
    return redactString(value, knownSecrets);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, knownSecrets));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        isSecretLikeKey(key) ? "[redacted]" : redactValue(nested, knownSecrets)
      ])
    );
  }
  return String(value);
}

function redactString(value: string, knownSecrets: string[]): string {
  let output = value
    .replace(BEARER_PATTERN, "Bearer [redacted]")
    .replace(SECRET_VALUE_PATTERN, "[redacted]")
    .replace(SECRET_ASSIGNMENT_PATTERN, (_match, key: string, separator: string) => `${key}${separator}[redacted]`);
  for (const secret of knownSecrets) {
    if (secret) {
      output = output.split(secret).join("[redacted]");
    }
  }
  return output;
}
