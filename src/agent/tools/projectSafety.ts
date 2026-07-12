import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentProjectRootGrant, AgentProjectRootGrantSource, TuiAgentContext } from "../types.ts";

export const PROJECT_INSPECTION_LIMITS = Object.freeze({
  maxAggregateBytes: 1_048_576,
  maxDurationMs: 1_500,
  maxLiteralLength: 512,
  maxRegexLength: 128,
  maxSearchLineChars: 4_096
});

export type SensitiveProjectFileCategory =
  | "environment"
  | "private_key"
  | "credential_store"
  | "package_auth"
  | "cloud_credentials";

export interface SensitiveProjectFileDecision {
  denied: true;
  category: SensitiveProjectFileCategory;
}

export interface ProjectScopeAuthorizationFailure {
  ok: false;
  code: "PROJECT_ROOT_NOT_GRANTED";
  message: string;
  userAction: string;
  detail: {
    requestedRootName: string;
    grantCount: number;
  };
}

export type ProjectScopeAuthorization = { ok: true } | ProjectScopeAuthorizationFailure;

const PROJECT_SCOPED_AGENT_TOOLS = new Set([
  "detect_project",
  "plan_app_setup",
  "preview_setup_writes",
  "apply_setup_plan",
  "register_manifest",
  "inspect_manifest",
  "validate_manifest",
  "patch_manifest_fields",
  "set_health_route",
  "set_pinned_port",
  "set_component_metadata",
  "add_env_override_safe",
  "open_project_or_app",
  "setup_and_start_project",
  "prove_app_health",
  "repair_app_setup"
]);

const CURRENT_CWD_DEFAULT_TOOLS = new Set([
  "detect_project",
  "plan_app_setup",
  "preview_setup_writes",
  "apply_setup_plan",
  "validate_manifest",
  "repair_app_setup"
]);

export async function authorizeAgentToolProjectScope(
  toolName: string,
  input: Record<string, unknown>,
  context: Pick<TuiAgentContext, "currentCwd">,
  grants: readonly AgentProjectRootGrant[] | undefined
): Promise<ProjectScopeAuthorization> {
  if (!PROJECT_SCOPED_AGENT_TOOLS.has(toolName)) {
    return { ok: true };
  }

  const paths = projectScopePaths(input, context, toolName);
  for (const requested of paths) {
    const canonicalTarget = await canonicalizeScopePath(requested.value, requested.kind, requested.baseDirectory);
    if (!canonicalTarget || !(await findCanonicalProjectRootGrantContaining(canonicalTarget, grants))) {
      return {
        ok: false,
        code: "PROJECT_ROOT_NOT_GRANTED",
        message: "The requested project path is outside the folders explicitly granted by the user.",
        userAction:
          "Select the project folder through /add, /configure, /register, or launch Relaybase from that folder, then retry.",
        detail: {
          requestedRootName: path.basename(path.resolve(requested.value)),
          grantCount: grants?.length ?? 0
        }
      };
    }
  }
  return { ok: true };
}

export async function findCanonicalProjectRootGrantContaining(
  canonicalTarget: string,
  grants: readonly AgentProjectRootGrant[] | undefined
): Promise<AgentProjectRootGrant | undefined> {
  for (const grant of grants ?? []) {
    if (!grant.grantId.trim() || !path.isAbsolute(grant.canonicalRoot)) {
      continue;
    }
    try {
      const verifiedCanonicalRoot = await fs.realpath(grant.canonicalRoot);
      if (
        sameFilesystemPath(verifiedCanonicalRoot, grant.canonicalRoot) &&
        isInsidePath(verifiedCanonicalRoot, canonicalTarget)
      ) {
        return grant;
      }
    } catch {
      // Stale or replaced grants never authorize filesystem access.
    }
  }
  return undefined;
}

export async function createCanonicalProjectRootGrant(
  root: string,
  source: AgentProjectRootGrantSource,
  grantId?: string
): Promise<AgentProjectRootGrant> {
  const resolved = path.resolve(root);
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) {
    throw new Error("Project root grant target must be a directory.");
  }
  const canonicalRoot = await fs.realpath(resolved);
  return {
    grantId: grantId ?? `project_${createHash("sha256").update(canonicalRoot).digest("hex").slice(0, 16)}`,
    canonicalRoot,
    source
  };
}

export async function findCanonicalProjectRootGrant(
  canonicalRoot: string,
  grants: readonly AgentProjectRootGrant[] | undefined
): Promise<AgentProjectRootGrant | undefined> {
  for (const grant of grants ?? []) {
    if (!grant.grantId.trim() || !path.isAbsolute(grant.canonicalRoot)) {
      continue;
    }
    try {
      const verifiedCanonicalRoot = await fs.realpath(grant.canonicalRoot);
      if (
        sameFilesystemPath(verifiedCanonicalRoot, grant.canonicalRoot) &&
        sameFilesystemPath(verifiedCanonicalRoot, canonicalRoot)
      ) {
        return grant;
      }
    } catch {
      // A stale or unavailable grant is not claimable and must not authorize access.
    }
  }
  return undefined;
}

export function classifySensitiveProjectFile(relativeFilePath: string): SensitiveProjectFileDecision | undefined {
  const normalized = relativeFilePath.replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
  const segments = normalized.split("/").filter(Boolean);
  const basename = segments.at(-1) ?? "";

  if (
    basename === ".env" ||
    basename.startsWith(".env.") ||
    basename === ".envrc" ||
    basename.startsWith(".envrc.") ||
    basename.endsWith(".env")
  ) {
    return { denied: true, category: "environment" };
  }
  if (
    /\.(?:pem|key|p12|pfx|jks|keystore|kdbx)$/i.test(basename) ||
    /^(?:id_(?:rsa|dsa|ecdsa|ed25519)|private[_-]?key)$/i.test(basename)
  ) {
    return { denied: true, category: "private_key" };
  }
  if ([".npmrc", ".pypirc", ".netrc", ".git-credentials"].includes(basename)) {
    return { denied: true, category: "package_auth" };
  }
  if (
    normalized === ".aws/credentials" ||
    normalized.endsWith("/.aws/credentials") ||
    normalized === ".docker/config.json" ||
    normalized.endsWith("/.docker/config.json") ||
    normalized === ".kube/config" ||
    normalized.endsWith("/.kube/config") ||
    basename === "application_default_credentials.json" ||
    /^(?:service[_-]?account|gcloud)[^/]*\.json$/i.test(basename)
  ) {
    return { denied: true, category: "cloud_credentials" };
  }
  if (
    [
      "credentials",
      "credentials.json",
      "credentials.xml",
      "secrets.json",
      "secrets.yaml",
      "secrets.yml",
      "keychain",
      "keyring"
    ].includes(basename) ||
    /^(?:auth|credential|credentials|secret|secrets)[_-]?(?:store|config)?\.(?:json|ya?ml|toml|ini|db)$/i.test(basename)
  ) {
    return { denied: true, category: "credential_store" };
  }
  return undefined;
}

export function compileSafeProjectSearchPattern(query: string, regex: boolean, caseSensitive: boolean): RegExp | Error {
  if (!regex) {
    if (query.length > PROJECT_INSPECTION_LIMITS.maxLiteralLength) {
      return new Error(`Literal query exceeds ${PROJECT_INSPECTION_LIMITS.maxLiteralLength} characters.`);
    }
    return new RegExp(escapeRegex(query), caseSensitive ? "u" : "iu");
  }
  const unsafeReason = unsafeRegexReason(query);
  if (unsafeReason) {
    return new Error(`Unsafe regular expression rejected: ${unsafeReason}`);
  }
  try {
    return new RegExp(query, caseSensitive ? "u" : "iu");
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

export function redactProjectText(value: string): { text: string; count: number } {
  let count = 0;
  const replacement = (prefix?: string, suffix?: string): string => {
    count += 1;
    return `${prefix ?? ""}[redacted]${suffix ?? ""}`;
  };
  const preserveLineShape = (match: string): string => {
    count += 1;
    const lineBreaks = match.match(/\r?\n/g) ?? [];
    return `[redacted private key]${lineBreaks.join("")}`;
  };

  const text = value
    .replace(/-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g, preserveLineShape)
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*$/g, preserveLineShape)
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, (_match, prefix: string) => replacement(prefix))
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{16,}|AKIA[0-9A-Z]{16})\b/g, () => replacement())
    .replace(
      /\b([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)([^@\s/]+)(@)/gi,
      (_match, prefix: string, _secret: string, suffix: string) => replacement(prefix, suffix)
    )
    .replace(
      /("(?:[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSCODE|API_KEY|PRIVATE_KEY|CLIENT_SECRET|ACCESS_KEY)|DATABASE_URL|REDIS_URL|MONGODB_URI|AUTHORIZATION|COOKIE|SESSION)"\s*:\s*")([^"\r\n]+)(")/gi,
      (_match, prefix: string, _secret: string, suffix: string) => replacement(prefix, suffix)
    )
    .replace(
      /\b((?:[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSCODE|API_KEY|PRIVATE_KEY|CLIENT_SECRET|ACCESS_KEY)|DATABASE_URL|REDIS_URL|MONGODB_URI|AUTHORIZATION|COOKIE|SESSION)\s*[:=]\s*["'])([^"'\r\n]+)(["'])/gi,
      (_match, prefix: string, _secret: string, suffix: string) => replacement(prefix, suffix)
    )
    .replace(
      /\b((?:apiKey|privateKey|clientSecret|accessKey|secretKey|databaseUrl|redisUrl|mongodbUri|authToken|sessionToken)\s*[:=]\s*["'])([^"'\r\n]+)(["'])/gi,
      (_match, prefix: string, _secret: string, suffix: string) => replacement(prefix, suffix)
    )
    .replace(
      /("(?:apiKey|privateKey|clientSecret|accessKey|secretKey|databaseUrl|redisUrl|mongodbUri|authToken|sessionToken)"\s*:\s*")([^"\r\n]+)(")/gi,
      (_match, prefix: string, _secret: string, suffix: string) => replacement(prefix, suffix)
    )
    .replace(
      /\b((?:[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSCODE|API_KEY|PRIVATE_KEY|CLIENT_SECRET|ACCESS_KEY)|DATABASE_URL|REDIS_URL|MONGODB_URI|AUTHORIZATION|COOKIE|SESSION)\s*[:=]\s*)([^\s"'\x60,;]+)/gi,
      (_match, prefix: string) => replacement(prefix)
    )
    .replace(
      /\b((?:apiKey|privateKey|clientSecret|accessKey|secretKey|databaseUrl|redisUrl|mongodbUri|authToken|sessionToken)\s*[:=]\s*)([^\s"'\x60,;]+)/gi,
      (_match, prefix: string) => replacement(prefix)
    )
    .replace(
      /\b((?:--)?(?:token|secret|password|passcode|api[-_]?key|client[-_]?secret)\s*[=:]\s*)([^\s"'\x60,;]+)/gi,
      (_match, prefix: string) => replacement(prefix)
    );
  return { text, count };
}

function unsafeRegexReason(query: string): string | undefined {
  if (query.length > PROJECT_INSPECTION_LIMITS.maxRegexLength) {
    return `pattern exceeds ${PROJECT_INSPECTION_LIMITS.maxRegexLength} characters`;
  }
  if (/\\(?:[1-9]|k<)/.test(query)) {
    return "backreferences are not supported";
  }
  if (/\(\?[=!<]/.test(query)) {
    return "lookaround assertions are not supported";
  }
  const structure = regexStructure(query);
  if (/[()|{}]/.test(structure)) {
    return "groups, alternation, and counted repetition are not supported";
  }
  if (/(?:\*|\+|\?){2}/.test(structure)) {
    return "stacked quantifiers are not supported";
  }
  if ((structure.match(/[+*]/g) ?? []).length > 4) {
    return "pattern has too many unbounded quantifiers";
  }
  if ((structure.match(/\.\*/g) ?? []).length > 1) {
    return "pattern has multiple unbounded wildcards";
  }
  return undefined;
}

function regexStructure(value: string): string {
  let structure = "";
  let escaped = false;
  let inCharacterClass = false;
  for (const character of value) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "[") {
      inCharacterClass = true;
      continue;
    }
    if (character === "]") {
      inCharacterClass = false;
      continue;
    }
    if (!inCharacterClass) {
      structure += character;
    }
  }
  return structure;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type ProjectScopePath = {
  value: string;
  kind: "directory" | "file";
  baseDirectory?: string;
};

function projectScopePaths(
  input: Record<string, unknown>,
  context: Pick<TuiAgentContext, "currentCwd">,
  toolName: string
): ProjectScopePath[] {
  const paths: ProjectScopePath[] = [];
  const cwd = stringValue(input.cwd ?? input.currentDirectory ?? input.projectRoot);
  const baseDirectory = cwd ?? context.currentCwd;
  addScopePath(paths, cwd, "directory");
  addScopePath(paths, stringValue(input.manifestPath), "file", baseDirectory);

  const componentMetadata = recordValue(input.componentMetadata);
  addScopePath(paths, stringValue(componentMetadata?.cwd), "directory", baseDirectory);
  for (const component of Array.isArray(input.components) ? input.components : []) {
    addScopePath(paths, stringValue(recordValue(component)?.cwd), "directory", baseDirectory);
  }
  const patch = recordValue(input.patch);
  addScopePath(paths, stringValue(patch?.cwd), "directory", baseDirectory);

  if (paths.length || (toolName === "validate_manifest" && recordValue(input.manifest))) {
    return paths;
  }
  if (toolName === "open_project_or_app" && hasRegisteredTarget(input)) {
    return paths;
  }
  if (toolName === "setup_and_start_project" && input.phase === "start_registered" && hasRegisteredTarget(input)) {
    return paths;
  }
  if (
    [
      "patch_manifest_fields",
      "set_health_route",
      "set_pinned_port",
      "set_component_metadata",
      "add_env_override_safe"
    ].includes(toolName) &&
    typeof input.appId === "string"
  ) {
    return paths;
  }
  if ((CURRENT_CWD_DEFAULT_TOOLS.has(toolName) || toolName === "prove_app_health") && context.currentCwd) {
    addScopePath(paths, context.currentCwd, "directory");
  }
  return paths;
}

function addScopePath(
  paths: ProjectScopePath[],
  value: string | undefined,
  kind: ProjectScopePath["kind"],
  baseDirectory?: string
): void {
  if (value) {
    paths.push({ value, kind, ...(baseDirectory ? { baseDirectory } : {}) });
  }
}

async function canonicalizeScopePath(
  value: string,
  _kind: ProjectScopePath["kind"],
  baseDirectory?: string
): Promise<string | undefined> {
  const absolute = path.isAbsolute(value) ? path.resolve(value) : path.resolve(baseDirectory ?? process.cwd(), value);
  try {
    return await fs.realpath(absolute);
  } catch {
    const suffix: string[] = [path.basename(absolute)];
    let probe = path.dirname(absolute);
    while (true) {
      try {
        const canonicalAncestor = await fs.realpath(probe);
        return path.join(canonicalAncestor, ...suffix);
      } catch {
        const parent = path.dirname(probe);
        if (parent === probe) {
          return undefined;
        }
        suffix.unshift(path.basename(probe));
        probe = parent;
      }
    }
  }
}

function hasRegisteredTarget(input: Record<string, unknown>): boolean {
  return [input.appId, input.appName, input.target].some((value) => typeof value === "string" && value.trim());
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function isInsidePath(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function sameFilesystemPath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}
