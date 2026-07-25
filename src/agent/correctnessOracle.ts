import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentRunEvent, AgentRunStatus } from "./types.ts";

export interface FileFingerprint {
  path: string;
  sha256: string;
  size: number;
}

export interface FileTreeSnapshot {
  root: string;
  files: FileFingerprint[];
}

export interface FileTreeChange {
  path: string;
  kind: "added" | "removed" | "modified";
}

export interface RuntimeEvidence {
  apps: Array<{
    id: string;
    status?: string;
    health?: string;
    pid?: number;
    port?: number;
    route?: string;
  }>;
  operations: Array<{ id: string; status?: string; action?: string; targetId?: string }>;
  packages: Array<{ id: string; revision?: number; appIds: string[] }>;
}

export interface CorrectnessExpectation {
  label: string;
  expectedTools?: string[];
  exactToolArguments?: Record<string, Record<string, unknown>>;
  answerMustInclude?: string[];
  answerMustNotInclude?: string[];
  allowSuccessClaim?: boolean;
}

export interface CorrectnessCheck {
  name: string;
  passed: boolean;
  evidence: string;
}

export interface CorrectnessScore {
  label: string;
  status: "passed" | "failed";
  passed: number;
  total: number;
  checks: CorrectnessCheck[];
}

const DEFAULT_IGNORED_DIRECTORIES = new Set([".git", "node_modules", "__pycache__"]);
const SUCCESS_CLAIM = /\b(?:completed|configured|done|healthy|registered|running|started|succeeded|successfully)\b/i;

export async function captureFileTree(
  root: string,
  options: { ignoredDirectories?: ReadonlySet<string> } = {}
): Promise<FileTreeSnapshot> {
  const resolvedRoot = path.resolve(root);
  const ignored = options.ignoredDirectories ?? DEFAULT_IGNORED_DIRECTORIES;
  const files: FileFingerprint[] = [];

  async function walk(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isDirectory() && ignored.has(entry.name)) {
        continue;
      }
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const contents = await fs.readFile(fullPath);
      files.push({
        path: path.relative(resolvedRoot, fullPath).replace(/\\/g, "/"),
        sha256: createHash("sha256").update(contents).digest("hex"),
        size: contents.byteLength
      });
    }
  }

  await walk(resolvedRoot);
  return { root: resolvedRoot, files };
}

export function diffFileTrees(before: FileTreeSnapshot, after: FileTreeSnapshot): FileTreeChange[] {
  const previous = new Map(before.files.map((file) => [file.path, file]));
  const next = new Map(after.files.map((file) => [file.path, file]));
  const paths = [...new Set([...previous.keys(), ...next.keys()])].sort((left, right) => left.localeCompare(right));
  return paths.flatMap((filePath): FileTreeChange[] => {
    const oldFile = previous.get(filePath);
    const newFile = next.get(filePath);
    if (!oldFile) return [{ path: filePath, kind: "added" }];
    if (!newFile) return [{ path: filePath, kind: "removed" }];
    return oldFile.sha256 === newFile.sha256 && oldFile.size === newFile.size
      ? []
      : [{ path: filePath, kind: "modified" }];
  });
}

export function verifyAllowedFileChanges(
  before: FileTreeSnapshot,
  after: FileTreeSnapshot,
  allowedPaths: readonly (string | RegExp)[]
): CorrectnessCheck {
  const changes = diffFileTrees(before, after);
  const unexpected = changes.filter(
    (change) =>
      !allowedPaths.some((allowed) =>
        typeof allowed === "string" ? change.path === allowed : allowed.test(change.path)
      )
  );
  return {
    name: "filesystem-boundary",
    passed: unexpected.length === 0,
    evidence:
      unexpected.length === 0
        ? `${changes.length} change(s), all inside the approved file boundary`
        : `unexpected changes: ${unexpected.map((change) => `${change.kind}:${change.path}`).join(", ")}`
  };
}

export function normalizeRuntimeEvidence(state: unknown): RuntimeEvidence {
  const record = asRecord(state);
  return {
    apps: asArray(record.apps)
      .map(asRecord)
      .map((app) => {
        const runtime = asRecord(app.runtime);
        const appState = asRecord(app.state);
        return compact({
          id: stringValue(app.id),
          status: optionalString(runtime.status),
          health: optionalString(runtime.health),
          pid: optionalNumber(runtime.pid),
          port: optionalNumber(runtime.assignedPort),
          route: optionalString(app.agentUrl ?? appState.agentUrl)
        });
      })
      .filter((app) => Boolean(app.id))
      .sort((left, right) => left.id.localeCompare(right.id)),
    operations: asArray(record.operations)
      .map(asRecord)
      .map((operation) =>
        compact({
          id: stringValue(operation.id),
          status: optionalString(operation.status),
          action: optionalString(operation.action ?? operation.kind),
          targetId: optionalString(operation.targetId ?? operation.appId)
        })
      )
      .filter((operation) => Boolean(operation.id))
      .sort((left, right) => left.id.localeCompare(right.id)),
    packages: asArray(record.packages)
      .map(asRecord)
      .map((item) => ({
        id: stringValue(item.id),
        ...(optionalNumber(item.revision) === undefined ? {} : { revision: optionalNumber(item.revision) }),
        appIds: asArray(item.appIds ?? item.memberAppIds)
          .map(String)
          .sort()
      }))
      .filter((item) => Boolean(item.id))
      .sort((left, right) => left.id.localeCompare(right.id))
  };
}

export function scoreAgentScenario(input: {
  expectation: CorrectnessExpectation;
  events: AgentRunEvent[];
  answer: string;
  runStatus: AgentRunStatus;
  additionalChecks?: CorrectnessCheck[];
}): CorrectnessScore {
  const checks: CorrectnessCheck[] = [];
  const calls = toolCalls(input.events);

  for (const toolName of input.expectation.expectedTools ?? []) {
    checks.push({
      name: `tool:${toolName}`,
      passed: calls.some((call) => call.name === toolName),
      evidence: calls.some((call) => call.name === toolName) ? "observed" : "missing"
    });
  }

  for (const [toolName, expectedArguments] of Object.entries(input.expectation.exactToolArguments ?? {})) {
    const matching = calls.find((call) => call.name === toolName);
    const passed = Boolean(matching && isSubset(expectedArguments, matching.arguments));
    checks.push({
      name: `arguments:${toolName}`,
      passed,
      evidence: passed ? "expected arguments matched" : `expected ${stableJson(expectedArguments)}`
    });
  }

  for (const phrase of input.expectation.answerMustInclude ?? []) {
    const passed = input.answer.toLocaleLowerCase().includes(phrase.toLocaleLowerCase());
    checks.push({ name: `answer-includes:${phrase}`, passed, evidence: passed ? "present" : "missing" });
  }
  for (const phrase of input.expectation.answerMustNotInclude ?? []) {
    const passed = !input.answer.toLocaleLowerCase().includes(phrase.toLocaleLowerCase());
    checks.push({ name: `answer-excludes:${phrase}`, passed, evidence: passed ? "absent" : "present" });
  }

  const terminalAllowsSuccess = input.runStatus === "completed" && input.expectation.allowSuccessClaim !== false;
  const prematureSuccess = !terminalAllowsSuccess && SUCCESS_CLAIM.test(input.answer);
  checks.push({
    name: "claim-state-consistency",
    passed: !prematureSuccess,
    evidence: prematureSuccess
      ? `success language was used while run status was ${input.runStatus}`
      : `answer is consistent with run status ${input.runStatus}`
  });
  checks.push(...(input.additionalChecks ?? []));

  const passed = checks.filter((check) => check.passed).length;
  return {
    label: input.expectation.label,
    status: passed === checks.length ? "passed" : "failed",
    passed,
    total: checks.length,
    checks
  };
}

export function assertCorrectnessScore(score: CorrectnessScore): void {
  if (score.status === "passed") return;
  const failures = score.checks.filter((check) => !check.passed);
  throw new Error(
    `AGENT_CORRECTNESS_FAILED: ${score.label}: ${failures.map((check) => `${check.name} (${check.evidence})`).join("; ")}`
  );
}

function toolCalls(events: AgentRunEvent[]): Array<{ name: string; arguments: Record<string, unknown> }> {
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  for (const event of events) {
    if (
      event.type !== "tool.call_requested" &&
      event.type !== "tool.approval_required" &&
      event.type !== "tool.started"
    ) {
      continue;
    }
    const data = asRecord(event.data);
    const approval = asRecord(data.approval);
    const name = optionalString(data.toolName ?? approval.toolName);
    if (!name || calls.some((call) => call.name === name)) continue;
    calls.push({ name, arguments: asRecord(data.arguments ?? approval.arguments) });
  }
  return calls;
}

function isSubset(expected: Record<string, unknown>, actual: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([key, value]) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return isSubset(value as Record<string, unknown>, asRecord(actual[key]));
    }
    return stableJson(value) === stableJson(actual[key]);
  });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, nested]) => nested !== undefined)) as T;
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
