import type { AgentRedactionReport } from "./errors.ts";
import { sanitizeAgentPayloadWithReport } from "./errors.ts";

const MAX_PERSISTED_STRING_LENGTH = 4000;

export interface SanitizedSessionPayload<T> {
  value: T;
  redactionReport: AgentRedactionReport;
}

export function sanitizeSessionPayload<T>(value: T): T {
  return sanitizeSessionPayloadWithReport(value).value;
}

export function sanitizeSessionPayloadWithReport<T>(value: T): SanitizedSessionPayload<T> {
  const sanitized = sanitizeAgentPayloadWithReport(value);
  return {
    value: summarizeSessionPayload(sanitized.value, [], 0) as T,
    redactionReport: sanitized.report
  };
}

function summarizeSessionPayload(value: unknown, pathParts: string[], depth: number): unknown {
  if (value === undefined || value === null || depth > 10) {
    return value;
  }
  const key = pathParts.at(-1)?.toLowerCase() ?? "";
  if (typeof value === "string") {
    if (key === "preview" || key === "content" || key === "message" || key === "delta") {
      return truncate(value, MAX_PERSISTED_STRING_LENGTH);
    }
    return value.length > MAX_PERSISTED_STRING_LENGTH ? truncate(value, MAX_PERSISTED_STRING_LENGTH) : value;
  }
  if (Array.isArray(value)) {
    if (key === "hunks") {
      return [`[${value.length} redacted diff hunks]`];
    }
    if (key === "logs" || key === "recentlogs") {
      return { omittedLogLineCount: value.length };
    }
    return value.map((entry, index) => summarizeSessionPayload(entry, [...pathParts, String(index)], depth + 1));
  }
  if (typeof value === "object") {
    if (key === "diff") {
      const record = value as Record<string, unknown>;
      return {
        path: typeof record.path === "string" ? record.path : undefined,
        beforeExists: typeof record.beforeExists === "boolean" ? record.beforeExists : undefined,
        afterExists: typeof record.afterExists === "boolean" ? record.afterExists : undefined,
        changed: typeof record.changed === "boolean" ? record.changed : undefined,
        hunkCount: Array.isArray(record.hunks) ? record.hunks.length : undefined
      };
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([nestedKey, nested]) => [
        nestedKey,
        summarizeSessionPayload(nested, [...pathParts, nestedKey], depth + 1)
      ])
    );
  }
  return value;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength)}...[truncated ${value.length - maxLength} chars]`;
}
