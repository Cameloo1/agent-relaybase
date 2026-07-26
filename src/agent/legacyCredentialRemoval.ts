import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parseEnvFile } from "../envFile.ts";
import { AgentCredentialError } from "./credentialStore.ts";

const MAX_EXTERNAL_FILE_BYTES = 1024 * 1024;
const PREVIEW_TTL_MS = 5 * 60 * 1000;
const LEGACY_KEY = "OPENROUTER_API_KEY";

export interface LegacyCredentialRemovalPreview {
  previewId: string;
  sourceLabel: string;
  keyName: typeof LEGACY_KEY;
  lineNumber: number;
  changedLineCount: 1;
  expiresAt: string;
  warning: string;
}

interface BoundPreview {
  fingerprint: string;
  replacement: string;
  expiresAtMs: number;
}

export class LegacyCredentialRemovalManager {
  readonly #filePath?: string;
  readonly #sourceLabel: string;
  readonly #restrictPath?: (target: string) => void;
  readonly #previews = new Map<string, BoundPreview>();

  constructor(options: { filePath?: string; sourceLabel: string; restrictPath?: (target: string) => void }) {
    this.#filePath = options.filePath ? path.resolve(options.filePath) : undefined;
    this.#sourceLabel = options.sourceLabel;
    this.#restrictPath = options.restrictPath;
  }

  async preview(): Promise<LegacyCredentialRemovalPreview> {
    this.#expirePreviews();
    if (!this.#filePath) {
      throw unavailable(
        "The legacy credential came from the daemon shell environment, which Relaybase cannot remove from its parent process."
      );
    }
    if (process.platform === "win32" && !this.#restrictPath) {
      throw unavailable("Secure same-directory temporary-file ACL enforcement is unavailable.");
    }
    const { raw, fingerprint } = await readBoundedFile(this.#filePath);
    const parsed = parseEnvFile(raw);
    if (parsed.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      throw unavailable("The selected external configuration is invalid, so exact removal cannot be guaranteed.");
    }
    const lines = splitLinesPreservingEndings(raw);
    const matches = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => /^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=/.test(withoutLineEnding(line)));
    if (matches.length !== 1) {
      throw unavailable(
        matches.length === 0
          ? "The selected external configuration does not contain one removable OpenRouter key assignment."
          : "The selected external configuration contains multiple OpenRouter key assignments."
      );
    }
    const match = matches[0]!;
    const replacement = lines.filter((_line, index) => index !== match.index).join("");
    const previewId = randomUUID();
    const expiresAtMs = Date.now() + PREVIEW_TTL_MS;
    this.#previews.set(previewId, { fingerprint, replacement, expiresAtMs });
    return {
      previewId,
      sourceLabel: this.#sourceLabel,
      keyName: LEGACY_KEY,
      lineNumber: match.index + 1,
      changedLineCount: 1,
      expiresAt: new Date(expiresAtMs).toISOString(),
      warning: "Only the selected assignment will be removed. No plaintext backup will be created."
    };
  }

  async apply(previewId: string): Promise<{ removed: true; sourceLabel: string; changedLineCount: 1 }> {
    this.#expirePreviews();
    const preview = this.#previews.get(previewId);
    if (!preview || !this.#filePath) {
      throw new AgentCredentialError(
        "AGENT_LEGACY_CREDENTIAL_REMOVAL_STALE",
        "The legacy credential removal preview is missing or expired."
      );
    }
    this.#previews.delete(previewId);
    const current = await readBoundedFile(this.#filePath);
    if (current.fingerprint !== preview.fingerprint) {
      throw new AgentCredentialError(
        "AGENT_LEGACY_CREDENTIAL_REMOVAL_STALE",
        "The external configuration changed after the removal preview."
      );
    }

    const temporary = path.join(
      path.dirname(this.#filePath),
      `.${path.basename(this.#filePath)}.${process.pid}.${randomUUID()}.tmp`
    );
    try {
      const handle = await fs.open(temporary, "wx", 0o600);
      await handle.close();
      await fs.chmod(temporary, 0o600).catch(() => undefined);
      this.#restrictPath?.(temporary);
      const writeHandle = await fs.open(temporary, "r+");
      try {
        await writeHandle.writeFile(preview.replacement, "utf8");
        await writeHandle.sync();
      } finally {
        await writeHandle.close();
      }
      await fs.rename(temporary, this.#filePath);
      this.#restrictPath?.(this.#filePath);
    } catch (error) {
      await fs.unlink(temporary).catch(() => undefined);
      if (error instanceof AgentCredentialError) {
        throw error;
      }
      throw new AgentCredentialError(
        "AGENT_LEGACY_CREDENTIAL_REMOVAL_FAILED",
        "Relaybase could not atomically remove the legacy credential assignment."
      );
    }
    return { removed: true, sourceLabel: this.#sourceLabel, changedLineCount: 1 };
  }

  #expirePreviews(): void {
    const now = Date.now();
    for (const [previewId, preview] of this.#previews) {
      if (preview.expiresAtMs <= now) {
        this.#previews.delete(previewId);
      }
    }
  }
}

async function readBoundedFile(filePath: string): Promise<{ raw: string; fingerprint: string }> {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    throw unavailable("The selected external configuration is unavailable.");
  }
  if (!stat.isFile() || stat.size > MAX_EXTERNAL_FILE_BYTES) {
    throw unavailable("The selected external configuration is not a supported bounded file.");
  }
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    throw unavailable("The selected external configuration could not be read.");
  }
  return { raw, fingerprint: createHash("sha256").update(raw).digest("hex") };
}

function splitLinesPreservingEndings(raw: string): string[] {
  if (!raw) {
    return [];
  }
  return raw.match(/[^\r\n]*(?:\r\n|\n|$)/g)?.filter((line) => line.length > 0) ?? [];
}

function withoutLineEnding(line: string): string {
  return line.replace(/\r?\n$/, "");
}

function unavailable(message: string): AgentCredentialError {
  return new AgentCredentialError("AGENT_LEGACY_CREDENTIAL_REMOVAL_UNAVAILABLE", message);
}
