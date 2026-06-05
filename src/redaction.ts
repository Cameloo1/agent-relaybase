const INLINE_SECRET_PATTERNS: Array<{ category: string; pattern: RegExp }> = [
  {
    category: "env_assignment",
    pattern: /\b((?:api[_-]?key|token|secret|password|passwd|pwd|private[_-]?key|key)\s*[=:]\s*)(["'])(.*?)\2/gi
  },
  {
    category: "env_assignment",
    pattern: /\b((?:api[_-]?key|token|secret|password|passwd|pwd|private[_-]?key|key)\s*[=:]\s*)([^\s"'`;,]+)/gi
  },
  {
    category: "bearer_token",
    pattern: /\b(authorization\s*:\s*bearer\s+)([^\s"'`;,]+)/gi
  },
  {
    category: "bearer_token",
    pattern: /\b(bearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi
  }
];

export interface RedactionReport {
  replacements: number;
  categories: Record<string, number>;
}

export interface RedactionResult {
  value: string;
  redacted: boolean;
  report: RedactionReport;
}

export interface RedactionOptions {
  env?: NodeJS.ProcessEnv;
  extraSecrets?: string[];
}

export interface RedactedValueResult {
  value: unknown;
  redacted: boolean;
  report: RedactionReport;
}

export function redactSecretLikeValues(value: string, env: NodeJS.ProcessEnv = process.env): RedactionResult {
  return redactForExport(value, { env });
}

export function redactForExport(value: string, options: RedactionOptions = {}): RedactionResult {
  const env = options.env ?? process.env;
  let redacted = value;
  const report = emptyRedactionReport();

  for (const [key, envValue] of Object.entries(env)) {
    if (!envValue || envValue.length < 4 || !/(token|secret|password|key)/i.test(key)) {
      continue;
    }

    if (redacted.includes(envValue)) {
      const replacement = replaceLiteral(redacted, envValue);
      redacted = replacement.value;
      addRedaction(report, "environment_value", replacement.count);
    }
  }

  for (const secret of options.extraSecrets ?? []) {
    if (!secret || secret.length < 4 || !redacted.includes(secret)) {
      continue;
    }

    const replacement = replaceLiteral(redacted, secret);
    redacted = replacement.value;
    addRedaction(report, "relaybase_token", replacement.count);
  }

  for (const { category, pattern } of INLINE_SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (...args: unknown[]) => {
      const prefix = String(args[1]);
      const quoteOrSecret = String(args[2] ?? "");
      const hasQuote = quoteOrSecret === "'" || quoteOrSecret === '"';
      addRedaction(report, category, 1);
      return hasQuote ? `${prefix}${quoteOrSecret}[redacted]${quoteOrSecret}` : `${prefix}[redacted]`;
    });
  }

  return {
    value: redacted,
    redacted: report.replacements > 0,
    report
  };
}

export function redactValueForExport(value: unknown, options: RedactionOptions = {}): RedactedValueResult {
  return redactUnknownValue(value, options, new WeakSet(), 0);
}

export function emptyRedactionReport(): RedactionReport {
  return {
    replacements: 0,
    categories: {}
  };
}

export function mergeRedactionReports(target: RedactionReport, ...reports: RedactionReport[]): RedactionReport {
  for (const report of reports) {
    for (const [category, count] of Object.entries(report.categories)) {
      addRedaction(target, category, count);
    }
  }
  return target;
}

function redactUnknownValue(
  value: unknown,
  options: RedactionOptions,
  seen: WeakSet<object>,
  depth: number
): RedactedValueResult {
  if (typeof value === "string") {
    return redactForExport(value, options);
  }

  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") {
    return {
      value,
      redacted: false,
      report: emptyRedactionReport()
    };
  }

  if (typeof value === "bigint") {
    return redactForExport(value.toString(), options);
  }

  if (typeof value === "symbol" || typeof value === "function") {
    return redactForExport(String(value), options);
  }

  if (depth > 12) {
    const report = emptyRedactionReport();
    addRedaction(report, "max_depth", 1);
    return {
      value: "[redacted-depth]",
      redacted: true,
      report
    };
  }

  if (value instanceof Error) {
    return redactUnknownValue({ name: value.name, message: value.message }, options, seen, depth + 1);
  }

  if (Array.isArray(value)) {
    const report = emptyRedactionReport();
    const output = value.map((item) => {
      const redacted = redactUnknownValue(item, options, seen, depth + 1);
      mergeRedactionReports(report, redacted.report);
      return redacted.value;
    });
    return {
      value: output,
      redacted: report.replacements > 0,
      report
    };
  }

  if (typeof value === "object") {
    if (seen.has(value)) {
      const report = emptyRedactionReport();
      addRedaction(report, "circular", 1);
      return {
        value: "[redacted-circular]",
        redacted: true,
        report
      };
    }

    seen.add(value);
    const report = emptyRedactionReport();
    const output: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveObjectKey(key)) {
        output[key] = "[redacted]";
        addRedaction(report, "sensitive_key", 1);
        continue;
      }

      const redacted = redactUnknownValue(nestedValue, options, seen, depth + 1);
      output[key] = redacted.value;
      mergeRedactionReports(report, redacted.report);
    }
    seen.delete(value);
    return {
      value: output,
      redacted: report.replacements > 0,
      report
    };
  }

  return {
    value,
    redacted: false,
    report: emptyRedactionReport()
  };
}

function replaceLiteral(value: string, secret: string): { value: string; count: number } {
  const parts = value.split(secret);
  if (parts.length === 1) {
    return { value, count: 0 };
  }
  return {
    value: parts.join("[redacted]"),
    count: parts.length - 1
  };
}

function addRedaction(report: RedactionReport, category: string, count: number): void {
  if (count <= 0) {
    return;
  }

  report.replacements += count;
  report.categories[category] = (report.categories[category] ?? 0) + count;
}

function isSensitiveObjectKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return (
    normalized === "token" ||
    normalized.endsWith("token") ||
    normalized === "secret" ||
    normalized.endsWith("secret") ||
    normalized === "password" ||
    normalized.endsWith("password") ||
    normalized === "passphrase" ||
    normalized === "authorization" ||
    normalized === "apikey" ||
    normalized.endsWith("apikey") ||
    normalized === "privatekey" ||
    normalized.endsWith("privatekey")
  );
}
