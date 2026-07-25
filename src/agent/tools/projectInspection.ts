import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { detectSetup } from "../../setupApi.ts";
import {
  diagnosticResult,
  safeToolExecute,
  successResult,
  type AgentToolStructuredResult,
  type AgentToolExecutionContext,
  type RelaybaseAgentToolDefinition
} from "./common.ts";
import {
  PROJECT_INSPECTION_LIMITS,
  classifySensitiveProjectFile,
  compileSafeProjectSearchPattern,
  findCanonicalProjectRootGrant,
  redactProjectText,
  type SensitiveProjectFileCategory
} from "./projectSafety.ts";

const DEFAULT_EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".venv",
  "target",
  "bin",
  "obj"
]);

const rootFields = {
  projectRootGrantId: z.string().min(1).optional(),
  projectRoot: z.string().optional(),
  cwd: z.string().optional(),
  currentDirectory: z.string().optional()
};

const listParameters = z
  .object({
    ...rootFields,
    maxFiles: z.number().int().positive().max(500).optional(),
    maxDepth: z.number().int().nonnegative().max(10).optional()
  })
  .strict();

const searchParameters = z
  .object({
    ...rootFields,
    query: z.string().min(1),
    regex: z.boolean().optional(),
    caseSensitive: z.boolean().optional(),
    maxResults: z.number().int().positive().max(200).optional(),
    maxFiles: z.number().int().positive().max(500).optional()
  })
  .strict();

const readParameters = z
  .object({
    ...rootFields,
    path: z.string().min(1),
    maxBytes: z.number().int().positive().max(65_536).optional()
  })
  .strict();

const detectParameters = z
  .object({
    ...rootFields
  })
  .strict();

type ProjectRootInput = {
  projectRootGrantId?: string;
  projectRoot?: string;
  cwd?: string;
  currentDirectory?: string;
};

interface ProjectRoot {
  requested: string;
  root: string;
  grantId: string;
  grantSource: string;
}

interface ListedFile {
  path: string;
  sizeBytes: number;
  modifiedAt: string;
}

type InspectionStopReason = "file_limit" | "depth_limit" | "time_limit" | "aggregate_bytes" | "result_limit";

interface SensitiveFileSummary {
  deniedCount: number;
  categories: Partial<Record<SensitiveProjectFileCategory, number>>;
}

export function createProjectListFilesTool(): RelaybaseAgentToolDefinition<z.infer<typeof listParameters>> {
  const definition: RelaybaseAgentToolDefinition<z.infer<typeof listParameters>> = {
    name: "project_list_files",
    description:
      "List bounded project files for setup inference. Read-only, project-root scoped, skips vendor/build/cache directories, and never executes commands.",
    parameters: listParameters,
    approvalRequired: false,
    risk: "low",
    execute: (input, context) =>
      safeToolExecute(definition, input, async () => {
        const startedAt = Date.now();
        const root = await resolveProjectRoot(definition.name, input, context);
        if (isToolResult(root)) {
          return root;
        }
        const listed = await listProjectFiles(root.root, {
          maxFiles: input.maxFiles ?? 200,
          maxDepth: input.maxDepth ?? 5,
          deadlineAt: startedAt + PROJECT_INSPECTION_LIMITS.maxDurationMs
        });
        return successResult(definition.name, {
          projectRoot: root.root,
          projectRootGrant: { grantId: root.grantId, source: root.grantSource },
          files: listed.files,
          skippedDirectories: [...DEFAULT_EXCLUDED_DIRS],
          sensitiveFiles: listed.sensitiveFiles,
          truncated: listed.truncated,
          limits: {
            ...listed.limits,
            maxDurationMs: PROJECT_INSPECTION_LIMITS.maxDurationMs,
            elapsedMs: Date.now() - startedAt,
            stopReason: listed.stopReason
          }
        });
      })
  };
  return definition;
}

export function createProjectSearchFilesTool(): RelaybaseAgentToolDefinition<z.infer<typeof searchParameters>> {
  const definition: RelaybaseAgentToolDefinition<z.infer<typeof searchParameters>> = {
    name: "project_search_files",
    description:
      "Search bounded project text files for setup inference. This is an rg-like daemon tool: scoped, redacted, audited by Agent Gateway, and read-only.",
    parameters: searchParameters,
    approvalRequired: false,
    risk: "medium",
    execute: (input, context) =>
      safeToolExecute(definition, input, async () => {
        const startedAt = Date.now();
        const deadlineAt = startedAt + PROJECT_INSPECTION_LIMITS.maxDurationMs;
        const root = await resolveProjectRoot(definition.name, input, context);
        if (isToolResult(root)) {
          return root;
        }
        const pattern = compileSafeProjectSearchPattern(
          input.query,
          Boolean(input.regex),
          Boolean(input.caseSensitive)
        );
        if (pattern instanceof Error) {
          return diagnosticResult(definition.name, "PROJECT_SEARCH_REGEX_UNSAFE", pattern.message, {
            severity: "warning",
            userAction: "Use literal search or a simple bounded regular expression without groups or backreferences."
          });
        }
        const listed = await listProjectFiles(root.root, {
          maxFiles: input.maxFiles ?? 300,
          maxDepth: 8,
          deadlineAt
        });
        const maxResults = input.maxResults ?? 50;
        const matches: Array<{ path: string; line: number; text: string; redactionCount: number }> = [];
        let redactionCount = 0;
        let readBytes = 0;
        let scannedFiles = 0;
        let perFileTruncations = 0;
        let lineTruncations = 0;
        let stopReason: InspectionStopReason | undefined = listed.stopReason;
        for (const file of listed.files) {
          if (matches.length >= maxResults) {
            stopReason = "result_limit";
            break;
          }
          if (Date.now() >= deadlineAt) {
            stopReason = "time_limit";
            break;
          }
          const remainingBytes = PROJECT_INSPECTION_LIMITS.maxAggregateBytes - readBytes;
          if (remainingBytes <= 0) {
            stopReason = "aggregate_bytes";
            break;
          }
          const absolute = path.join(root.root, file.path);
          const content = await readTextFile(absolute, Math.min(65_536, remainingBytes));
          scannedFiles += 1;
          if (!content.ok) {
            continue;
          }
          readBytes += content.bytesRead;
          if (content.truncated) {
            perFileTruncations += 1;
          }
          const safeContent = redactProjectText(content.text);
          const rawLines = content.text.split(/\r?\n/);
          const safeLines = safeContent.text.split(/\r?\n/);
          for (let index = 0; index < rawLines.length && matches.length < maxResults; index += 1) {
            if (Date.now() >= deadlineAt) {
              stopReason = "time_limit";
              break;
            }
            const rawLine = rawLines[index] ?? "";
            const boundedLine = rawLine.slice(0, PROJECT_INSPECTION_LIMITS.maxSearchLineChars);
            if (!patternMatches(pattern, boundedLine)) {
              continue;
            }
            if (rawLine.length > boundedLine.length) {
              lineTruncations += 1;
            }
            const safeLine = safeLines[index] ?? "";
            const lineWasRedacted = safeLine !== rawLine;
            const outputLine = lineWasRedacted && !safeLine ? "[redacted]" : safeLine;
            const lineRedactionCount = lineWasRedacted ? 1 : 0;
            redactionCount += lineRedactionCount;
            matches.push({
              path: file.path,
              line: index + 1,
              text: outputLine.slice(0, PROJECT_INSPECTION_LIMITS.maxSearchLineChars),
              redactionCount: lineRedactionCount
            });
          }
        }
        return successResult(definition.name, {
          projectRoot: root.root,
          projectRootGrant: { grantId: root.grantId, source: root.grantSource },
          query: redactProjectText(input.query).text,
          regex: Boolean(input.regex),
          matches,
          redactionReport: { replacementCount: redactionCount },
          sensitiveFiles: listed.sensitiveFiles,
          truncated:
            listed.truncated ||
            Boolean(stopReason) ||
            matches.length >= maxResults ||
            perFileTruncations > 0 ||
            lineTruncations > 0,
          limits: {
            maxResults,
            maxFiles: input.maxFiles ?? 300,
            maxBytesPerFile: 65_536,
            maxAggregateBytes: PROJECT_INSPECTION_LIMITS.maxAggregateBytes,
            maxDurationMs: PROJECT_INSPECTION_LIMITS.maxDurationMs,
            maxSearchLineChars: PROJECT_INSPECTION_LIMITS.maxSearchLineChars,
            scannedFiles,
            readBytes,
            elapsedMs: Date.now() - startedAt,
            perFileTruncations,
            lineTruncations,
            stopReason
          }
        });
      })
  };
  return definition;
}

export function createProjectReadFileTool(): RelaybaseAgentToolDefinition<z.infer<typeof readParameters>> {
  const definition: RelaybaseAgentToolDefinition<z.infer<typeof readParameters>> = {
    name: "project_read_file",
    description:
      "Read one bounded project file for setup inference. This is a cat-like daemon tool: scoped to the project root, redacted, read-only, and never executable.",
    parameters: readParameters,
    approvalRequired: false,
    risk: "medium",
    execute: (input, context) =>
      safeToolExecute(definition, input, async () => {
        const root = await resolveProjectRoot(definition.name, input, context);
        if (isToolResult(root)) {
          return root;
        }
        const file = await resolveInsideProject(root.root, input.path);
        if (!file.ok) {
          return diagnosticResult(definition.name, file.code, file.message, {
            severity: "warning",
            userAction: file.userAction,
            detail: file.detail
          });
        }
        const relativeFilePath = relativePath(root.root, file.path);
        const sensitiveFile = classifySensitiveProjectFile(relativeFilePath);
        if (sensitiveFile) {
          return diagnosticResult(
            definition.name,
            "PROJECT_SENSITIVE_FILE_DENIED",
            "Sensitive project files cannot be read by Agent inspection tools.",
            {
              severity: "warning",
              userAction: "Inspect this file yourself and provide only the non-secret facts the Agent needs.",
              detail: { policy: "deny", category: sensitiveFile.category }
            }
          );
        }
        const content = await readTextFile(file.path, input.maxBytes ?? 32_768);
        if (!content.ok) {
          return diagnosticResult(definition.name, content.code, content.message, {
            severity: "warning",
            userAction: content.userAction,
            detail: content.detail
          });
        }
        const redacted = redactProjectText(content.text);
        return successResult(definition.name, {
          projectRoot: root.root,
          projectRootGrant: { grantId: root.grantId, source: root.grantSource },
          path: relativeFilePath,
          content: redacted.text,
          truncated: content.truncated,
          redactionReport: { replacementCount: redacted.count },
          limits: { maxBytes: input.maxBytes ?? 32_768, bytesRead: content.bytesRead }
        });
      })
  };
  return definition;
}

export function createProjectDetectStartCommandsTool(): RelaybaseAgentToolDefinition<z.infer<typeof detectParameters>> {
  const definition: RelaybaseAgentToolDefinition<z.infer<typeof detectParameters>> = {
    name: "project_detect_start_commands",
    description:
      "Detect likely project startup commands using Relaybase setup detection. This is read-only and returns command candidates as setup hints, not executable shell instructions.",
    parameters: detectParameters,
    approvalRequired: false,
    risk: "low",
    execute: (input, context) =>
      safeToolExecute(definition, input, async () => {
        const root = await resolveProjectRoot(definition.name, input, context);
        if (isToolResult(root)) {
          return root;
        }
        const detection = await detectSetup({ cwd: root.root });
        const candidates =
          detection.runtimeMatrix?.runtimes.flatMap((runtime) =>
            runtime.startCommandCandidates.map((candidate) => ({
              runtime: runtime.runtime,
              runtimeLabel: runtime.label,
              id: candidate.id,
              label: candidate.label,
              commandPreview: candidate.commandPreview,
              confidence: candidate.confidence,
              reasons: candidate.reasons,
              risks: candidate.risks
            }))
          ) ?? [];
        return successResult(definition.name, {
          projectRoot: root.root,
          projectRootGrant: { grantId: root.grantId, source: root.grantSource },
          packageManager: detection.packageManager,
          packageCommand: detection.packageCommand,
          framework: detection.framework,
          scripts: safeStringRecord(detection.scripts),
          primaryRuntime: detection.primaryRuntime,
          commandCandidates: candidates,
          setupQuestions: detection.runtimeMatrix?.questions ?? [],
          diagnostics: detection.diagnostics
        });
      })
  };
  return definition;
}

export function createProjectInspectPackageScriptsTool(): RelaybaseAgentToolDefinition<
  z.infer<typeof detectParameters>
> {
  const definition: RelaybaseAgentToolDefinition<z.infer<typeof detectParameters>> = {
    name: "project_inspect_package_scripts",
    description:
      "Read package.json scripts from a project root for setup inference. This is read-only, scoped, redacted, and never executes package scripts.",
    parameters: detectParameters,
    approvalRequired: false,
    risk: "low",
    execute: (input, context) =>
      safeToolExecute(definition, input, async () => {
        const root = await resolveProjectRoot(definition.name, input, context);
        if (isToolResult(root)) {
          return root;
        }
        const packagePath = path.join(root.root, "package.json");
        const content = await readTextFile(packagePath, 65_536);
        if (!content.ok) {
          return diagnosticResult(definition.name, "PROJECT_PACKAGE_JSON_UNAVAILABLE", "package.json is unavailable.", {
            severity: "warning",
            userAction: "Use detect_project for non-Node projects or choose a supported project root.",
            detail: content.detail
          });
        }
        let parsed: { scripts?: Record<string, string>; dependencies?: unknown; devDependencies?: unknown };
        try {
          parsed = JSON.parse(content.text) as {
            scripts?: Record<string, string>;
            dependencies?: unknown;
            devDependencies?: unknown;
          };
        } catch (error) {
          return diagnosticResult(
            definition.name,
            "PROJECT_PACKAGE_JSON_INVALID",
            "package.json could not be parsed.",
            {
              severity: "warning",
              userAction: "Repair package.json or choose a different project root.",
              detail: { error: error instanceof Error ? error.message : String(error) }
            }
          );
        }
        const scripts = safeStringRecord(parsed.scripts);
        return successResult(definition.name, {
          projectRoot: root.root,
          projectRootGrant: { grantId: root.grantId, source: root.grantSource },
          packageJson: "package.json",
          scripts,
          candidateScripts: Object.entries(scripts)
            .filter(
              ([name, command]) =>
                /^(dev|start|serve)$/.test(name) || /\b(next|vite|astro|node|tsx|nuxt|remix)\b/i.test(command)
            )
            .map(([name, command]) => ({
              script: name,
              command,
              commandHint: `${packageManagerCommand(root.root)} run ${name}`
            })),
          hasDependencies: Boolean(parsed.dependencies),
          hasDevDependencies: Boolean(parsed.devDependencies)
        });
      })
  };
  return definition;
}

async function resolveProjectRoot(
  tool: string,
  input: ProjectRootInput,
  context: AgentToolExecutionContext
): Promise<ProjectRoot | AgentToolStructuredResult> {
  const selectedGrant = input.projectRootGrantId
    ? context.projectRootGrants?.find((grant) => grant.grantId === input.projectRootGrantId)
    : undefined;
  if (input.projectRootGrantId && !selectedGrant) {
    return diagnosticResult(tool, "PROJECT_ROOT_GRANT_NOT_FOUND", "The selected project-root grant is unavailable.", {
      severity: "warning",
      userAction: "Refresh Agent context and choose one of the currently authorized project roots.",
      detail: {
        requestedGrantId: input.projectRootGrantId,
        availableGrantIds: (context.projectRootGrants ?? []).map((entry) => entry.grantId)
      }
    });
  }
  const requested = input.projectRoot ?? input.cwd ?? input.currentDirectory ?? context.tuiContext.currentCwd;
  if (selectedGrant && (!requested || !requested.trim())) {
    try {
      const canonicalRoot = await fs.realpath(selectedGrant.canonicalRoot);
      const verifiedGrant = await findCanonicalProjectRootGrant(canonicalRoot, [selectedGrant]);
      if (verifiedGrant) {
        return {
          requested: selectedGrant.grantId,
          root: canonicalRoot,
          grantId: verifiedGrant.grantId,
          grantSource: verifiedGrant.source
        };
      }
    } catch {
      // The structured stale-grant diagnostic below is safer than using an unavailable path.
    }
    return diagnosticResult(tool, "PROJECT_ROOT_GRANT_STALE", "The selected project-root grant is no longer valid.", {
      severity: "error",
      userAction: "Refresh Agent context and select the project folder again.",
      detail: { requestedGrantId: selectedGrant.grantId }
    });
  }
  if (!requested || !requested.trim()) {
    return diagnosticResult(tool, "PROJECT_ROOT_REQUIRED", "A project root is required for project inspection.", {
      severity: "warning",
      userAction: "Provide projectRoot, cwd, currentDirectory, or launch the TUI from the project folder."
    });
  }
  const resolved = path.resolve(requested);
  let stat: import("node:fs").Stats;
  try {
    stat = await fs.stat(resolved);
  } catch (error) {
    return diagnosticResult(tool, "PROJECT_ROOT_UNAVAILABLE", "Project root is unavailable.", {
      severity: "warning",
      userAction: "Choose an existing project directory.",
      detail: {
        requestedRootName: path.basename(resolved),
        errorType: error instanceof Error ? error.name : "Error"
      }
    });
  }
  if (!stat.isDirectory()) {
    if (stat.isFile()) {
      const parent = await fs.realpath(path.dirname(resolved));
      const parentGrant = await findCanonicalProjectRootGrant(parent, context.projectRootGrants);
      if (parentGrant && (!selectedGrant || parentGrant.grantId === selectedGrant.grantId)) {
        return {
          requested,
          root: parent,
          grantId: parentGrant.grantId,
          grantSource: parentGrant.source
        };
      }
    }
    return diagnosticResult(tool, "PROJECT_ROOT_NOT_DIRECTORY", "Project root must be a directory.", {
      severity: "warning",
      userAction: "Use projectRootGrantId or choose the granted project folder instead of a file.",
      detail: {
        requestedRootName: path.basename(resolved),
        availableGrantIds: (context.projectRootGrants ?? []).map((entry) => entry.grantId)
      }
    });
  }
  const root = await fs.realpath(resolved);
  const grant = await findCanonicalProjectRootGrant(root, context.projectRootGrants);
  if (!grant || (selectedGrant && grant.grantId !== selectedGrant.grantId)) {
    return diagnosticResult(
      tool,
      "PROJECT_ROOT_NOT_GRANTED",
      "Project inspection is limited to explicitly granted canonical roots.",
      {
        severity: "error",
        userAction: "Select the project folder through the trusted Relaybase UI, then retry inspection.",
        detail: {
          requestedRootName: path.basename(root),
          grantCount: context.projectRootGrants?.length ?? 0,
          availableGrantIds: (context.projectRootGrants ?? []).map((entry) => entry.grantId)
        }
      }
    );
  }
  return { requested, root, grantId: grant.grantId, grantSource: grant.source };
}

function isToolResult(value: ProjectRoot | AgentToolStructuredResult): value is AgentToolStructuredResult {
  return "status" in value && "tool" in value;
}

async function listProjectFiles(
  root: string,
  options: { maxFiles: number; maxDepth: number; deadlineAt: number }
): Promise<{
  files: ListedFile[];
  truncated: boolean;
  stopReason?: InspectionStopReason;
  sensitiveFiles: SensitiveFileSummary;
  limits: { maxFiles: number; maxDepth: number };
}> {
  const files: ListedFile[] = [];
  const sensitiveFiles: SensitiveFileSummary = { deniedCount: 0, categories: {} };
  let truncated = false;
  let stopReason: InspectionStopReason | undefined;

  async function walk(directory: string, depth: number): Promise<void> {
    if (Date.now() >= options.deadlineAt) {
      truncated = true;
      stopReason = "time_limit";
      return;
    }
    if (files.length >= options.maxFiles) {
      truncated = true;
      stopReason = "file_limit";
      return;
    }
    if (depth > options.maxDepth) {
      truncated = true;
      stopReason ??= "depth_limit";
      return;
    }
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (Date.now() >= options.deadlineAt) {
        truncated = true;
        stopReason = "time_limit";
        return;
      }
      if (files.length >= options.maxFiles) {
        truncated = true;
        stopReason = "file_limit";
        return;
      }
      if (entry.isSymbolicLink()) {
        continue;
      }
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (DEFAULT_EXCLUDED_DIRS.has(entry.name)) {
          continue;
        }
        await walk(absolute, depth + 1);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const filePath = relativePath(root, absolute);
      const sensitiveFile = classifySensitiveProjectFile(filePath);
      if (sensitiveFile) {
        sensitiveFiles.deniedCount += 1;
        sensitiveFiles.categories[sensitiveFile.category] =
          (sensitiveFiles.categories[sensitiveFile.category] ?? 0) + 1;
        continue;
      }
      let stat: import("node:fs").Stats;
      try {
        stat = await fs.stat(absolute);
      } catch {
        continue;
      }
      files.push({
        path: filePath,
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString()
      });
    }
  }

  await walk(root, 0);
  return {
    files,
    truncated,
    ...(stopReason ? { stopReason } : {}),
    sensitiveFiles,
    limits: { maxFiles: options.maxFiles, maxDepth: options.maxDepth }
  };
}

async function resolveInsideProject(
  root: string,
  requestedPath: string
): Promise<
  { ok: true; path: string } | { ok: false; code: string; message: string; userAction: string; detail?: unknown }
> {
  const resolved = path.isAbsolute(requestedPath) ? path.resolve(requestedPath) : path.resolve(root, requestedPath);
  let real: string;
  try {
    real = await fs.realpath(resolved);
  } catch (error) {
    return {
      ok: false,
      code: "PROJECT_FILE_UNAVAILABLE",
      message: "Project file is unavailable.",
      userAction: "Choose an existing file inside the project root.",
      detail: { requestedPath, error: error instanceof Error ? error.message : String(error) }
    };
  }
  if (!isInside(root, real)) {
    return {
      ok: false,
      code: "PROJECT_PATH_OUTSIDE_ROOT",
      message: "Requested file is outside the approved project root.",
      userAction: "Read only files under the selected project root.",
      detail: { requestedPath }
    };
  }
  const stat = await fs.stat(real);
  if (!stat.isFile()) {
    return {
      ok: false,
      code: "PROJECT_FILE_NOT_TEXT_FILE",
      message: "Requested path is not a regular file.",
      userAction: "Choose a regular text file inside the project root.",
      detail: { requestedPath }
    };
  }
  return { ok: true, path: real };
}

async function readTextFile(
  filePath: string,
  maxBytes: number
): Promise<
  | { ok: true; text: string; truncated: boolean; bytesRead: number }
  | { ok: false; code: string; message: string; userAction: string; detail?: unknown }
> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(filePath, "r");
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const slice = buffer.subarray(0, Math.min(bytesRead, maxBytes));
    if (slice.includes(0)) {
      return {
        ok: false,
        code: "PROJECT_BINARY_FILE_SKIPPED",
        message: "Project file appears to be binary and was skipped.",
        userAction: "Choose a text file relevant to project setup.",
        detail: { file: path.basename(filePath) }
      };
    }
    return { ok: true, text: slice.toString("utf8"), truncated: bytesRead > maxBytes, bytesRead: slice.length };
  } catch (error) {
    return {
      ok: false,
      code: "PROJECT_FILE_READ_FAILED",
      message: "Project file could not be read.",
      userAction: "Check file permissions or choose another file.",
      detail: { file: path.basename(filePath), error: error instanceof Error ? error.message : String(error) }
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return Boolean(relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative)));
}

function relativePath(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join("/");
}

function patternMatches(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  const matched = pattern.test(value);
  pattern.lastIndex = 0;
  return matched;
}

function safeStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([key, nested]) => [key, redactProjectText(nested).text])
  );
}

function packageManagerCommand(root: string): string {
  return hasSibling(root, "pnpm-lock.yaml")
    ? "pnpm"
    : hasSibling(root, "yarn.lock")
      ? "yarn"
      : hasSibling(root, "bun.lockb") || hasSibling(root, "bun.lock")
        ? "bun"
        : process.platform === "win32"
          ? "npm.cmd"
          : "npm";
}

function hasSibling(root: string, fileName: string): boolean {
  return existsSync(path.join(root, fileName));
}
