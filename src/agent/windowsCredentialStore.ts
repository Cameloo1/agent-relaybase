import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  AgentCredentialError,
  type CredentialDescriptor,
  type CredentialStore,
  type StoredCredential
} from "./credentialStore.ts";

const MAX_CREDENTIAL_BYTES = 16 * 1024;
const MAX_ENVELOPE_BYTES = 128 * 1024;
const ENVELOPE_SCHEMA_VERSION = 1;
const PAYLOAD_MAGIC = "relaybase-agent-credential-v1";

interface WindowsCredentialNative {
  protectCurrentUser(plaintext: Buffer): Buffer;
  unprotectCurrentUser(protectedValue: Buffer): Buffer;
  checkUserVerificationAvailability(): { available: boolean; reason?: string };
  requestUserVerification(reason: string): Promise<boolean> | boolean;
  restrictPathToCurrentUser(path: string): boolean;
  isPathRestrictedToCurrentUser(path: string): boolean;
}

interface CredentialEnvelope {
  schemaVersion: 1;
  provider: "openrouter";
  credentialId: string;
  protection: "windows-dpapi-current-user";
  createdAt: string;
  updatedAt: string;
  ciphertext: string;
}

export class WindowsCredentialStore implements CredentialStore {
  readonly #directory: string;
  #native?: WindowsCredentialNative;
  #nativeLoaded = false;

  constructor(options: { stateDir: string; native?: WindowsCredentialNative }) {
    this.#directory = path.join(options.stateDir, "agent", "credentials");
    this.#native = options.native;
    this.#nativeLoaded = Boolean(options.native);
  }

  available(): boolean {
    return process.platform === "win32" && Boolean(this.#nativeBridge());
  }

  protectionMode(): "windows-dpapi-current-user" {
    return "windows-dpapi-current-user";
  }

  verificationAvailability(): { available: boolean; reason?: string } {
    const native = this.#nativeBridge();
    if (!native) {
      return { available: false, reason: "native_module_unavailable" };
    }
    return native.checkUserVerificationAvailability();
  }

  async requestVerification(reason: string): Promise<void> {
    const native = this.#nativeBridge();
    if (!native) {
      throw new AgentCredentialError(
        "AGENT_WINDOWS_VERIFICATION_UNAVAILABLE",
        "Windows user verification is unavailable in this Relaybase installation."
      );
    }
    const verified = await native.requestUserVerification(reason);
    if (!verified) {
      throw new AgentCredentialError(
        "AGENT_WINDOWS_VERIFICATION_UNAVAILABLE",
        "Windows user verification did not complete."
      );
    }
  }

  async put(provider: "openrouter", secret: Buffer): Promise<CredentialDescriptor> {
    const native = this.#nativeBridge();
    if (!native || process.platform !== "win32") {
      throw new AgentCredentialError(
        "AGENT_CREDENTIAL_DPAPI_PROTECT_FAILED",
        "Windows DPAPI credential protection is unavailable."
      );
    }
    if (secret.byteLength === 0 || secret.byteLength > MAX_CREDENTIAL_BYTES) {
      throw new AgentCredentialError(
        "AGENT_CREDENTIAL_DPAPI_PROTECT_FAILED",
        "Credential size is outside the supported bounds."
      );
    }

    const credentialId = randomUUID();
    const now = new Date().toISOString();
    const payload = Buffer.from(
      JSON.stringify({
        magic: PAYLOAD_MAGIC,
        provider,
        credentialId,
        length: secret.byteLength,
        credential: secret.toString("base64")
      }),
      "utf8"
    );
    let ciphertext: Buffer;
    try {
      ciphertext = native.protectCurrentUser(payload);
      if (ciphertext.byteLength === 0 || ciphertext.byteLength > MAX_ENVELOPE_BYTES / 2) {
        ciphertext.fill(0);
        throw new AgentCredentialError(
          "AGENT_CREDENTIAL_DPAPI_PROTECT_FAILED",
          "Windows DPAPI returned protected data outside the supported bounds."
        );
      }
    } catch {
      throw new AgentCredentialError(
        "AGENT_CREDENTIAL_DPAPI_PROTECT_FAILED",
        "Windows DPAPI could not protect the credential."
      );
    } finally {
      payload.fill(0);
    }

    const envelope: CredentialEnvelope = {
      schemaVersion: ENVELOPE_SCHEMA_VERSION,
      provider,
      credentialId,
      protection: "windows-dpapi-current-user",
      createdAt: now,
      updatedAt: now,
      ciphertext: ciphertext.toString("base64")
    };
    ciphertext.fill(0);
    await this.#writeEnvelope(envelope);
    return descriptorFromEnvelope(envelope);
  }

  async get(credentialId: string): Promise<StoredCredential> {
    const native = this.#nativeBridge();
    if (!native || process.platform !== "win32") {
      throw new AgentCredentialError(
        "AGENT_CREDENTIAL_DPAPI_UNPROTECT_FAILED",
        "Windows DPAPI credential decryption is unavailable."
      );
    }
    const envelope = await this.#readEnvelope(credentialId);
    let plaintext: Buffer;
    try {
      plaintext = native.unprotectCurrentUser(Buffer.from(envelope.ciphertext, "base64"));
    } catch {
      throw new AgentCredentialError(
        "AGENT_CREDENTIAL_DPAPI_UNPROTECT_FAILED",
        "Windows DPAPI could not decrypt the stored credential."
      );
    }

    try {
      const parsed = JSON.parse(plaintext.toString("utf8")) as Record<string, unknown>;
      const credential =
        typeof parsed.credential === "string" ? Buffer.from(parsed.credential, "base64") : Buffer.alloc(0);
      if (
        parsed.magic !== PAYLOAD_MAGIC ||
        parsed.provider !== envelope.provider ||
        parsed.credentialId !== envelope.credentialId ||
        parsed.length !== credential.byteLength ||
        credential.byteLength === 0 ||
        credential.byteLength > MAX_CREDENTIAL_BYTES
      ) {
        credential.fill(0);
        throw new AgentCredentialError("AGENT_CREDENTIAL_CORRUPT", "The protected credential payload is invalid.");
      }
      return { ...descriptorFromEnvelope(envelope), secret: credential };
    } catch (error) {
      if (error instanceof AgentCredentialError) {
        throw error;
      }
      throw new AgentCredentialError("AGENT_CREDENTIAL_CORRUPT", "The protected credential payload is corrupt.");
    } finally {
      plaintext.fill(0);
    }
  }

  async delete(credentialId: string): Promise<boolean> {
    try {
      await fs.unlink(this.#credentialPath(credentialId));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  restrictPathToCurrentUser(target: string): void {
    this.#restrictPath(target);
  }

  async inspectPathProtection(target: string): Promise<"restricted" | "weak" | "unknown"> {
    const native = this.#nativeBridge();
    if (!native || process.platform !== "win32") {
      return "unknown";
    }
    try {
      await fs.stat(target);
      return native.isPathRestrictedToCurrentUser(target) ? "restricted" : "weak";
    } catch {
      return "unknown";
    }
  }

  async inspectProtection(credentialId?: string): Promise<{
    available: boolean;
    credentialExists: boolean;
    acl: "restricted" | "weak" | "unknown";
    errorCode?: string;
  }> {
    const native = this.#nativeBridge();
    if (!native || process.platform !== "win32") {
      return {
        available: false,
        credentialExists: false,
        acl: "unknown",
        errorCode: "AGENT_CREDENTIAL_DPAPI_UNPROTECT_FAILED"
      };
    }
    if (!credentialId || !/^[0-9a-f-]{36}$/i.test(credentialId)) {
      return { available: true, credentialExists: false, acl: "unknown", errorCode: "AGENT_CREDENTIAL_MISSING" };
    }
    const credentialPath = this.#credentialPath(credentialId);
    try {
      const [directory, credential] = await Promise.all([fs.stat(this.#directory), fs.stat(credentialPath)]);
      if (!directory.isDirectory() || !credential.isFile()) {
        return {
          available: true,
          credentialExists: false,
          acl: "unknown",
          errorCode: "AGENT_CREDENTIAL_MISSING"
        };
      }
      const restricted =
        native.isPathRestrictedToCurrentUser(this.#directory) && native.isPathRestrictedToCurrentUser(credentialPath);
      return { available: true, credentialExists: true, acl: restricted ? "restricted" : "weak" };
    } catch (error) {
      return {
        available: true,
        credentialExists: false,
        acl: "unknown",
        errorCode:
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? "AGENT_CREDENTIAL_MISSING"
            : "AGENT_CREDENTIAL_DPAPI_UNPROTECT_FAILED"
      };
    }
  }

  async repairProtection(credentialId: string): Promise<void> {
    const credentialPath = this.#credentialPath(credentialId);
    const [directory, credential] = await Promise.all([fs.stat(this.#directory), fs.stat(credentialPath)]);
    if (!directory.isDirectory() || !credential.isFile()) {
      throw new AgentCredentialError("AGENT_CREDENTIAL_MISSING", "The protected credential is missing.");
    }
    this.#restrictPath(this.#directory);
    this.#restrictPath(credentialPath);
    const inspection = await this.inspectProtection(credentialId);
    if (inspection.acl !== "restricted") {
      throw new AgentCredentialError(
        "AGENT_CREDENTIAL_DPAPI_PROTECT_FAILED",
        "Relaybase could not verify the repaired credential access policy."
      );
    }
  }

  async #writeEnvelope(envelope: CredentialEnvelope): Promise<void> {
    await fs.mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.#directory, 0o700).catch(() => undefined);
    this.#restrictPath(this.#directory);
    const destination = this.#credentialPath(envelope.credentialId);
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(envelope, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.chmod(temporary, 0o600).catch(() => undefined);
      this.#restrictPath(temporary);
      await fs.rename(temporary, destination);
      this.#restrictPath(destination);
    } catch (error) {
      await fs.unlink(temporary).catch(() => undefined);
      await fs.unlink(destination).catch(() => undefined);
      if (error instanceof AgentCredentialError) {
        throw error;
      }
      throw new AgentCredentialError(
        "AGENT_CREDENTIAL_DPAPI_PROTECT_FAILED",
        "Relaybase could not persist the protected credential safely."
      );
    }
  }

  async #readEnvelope(credentialId: string): Promise<CredentialEnvelope> {
    if (!/^[0-9a-f-]{36}$/i.test(credentialId)) {
      throw new AgentCredentialError("AGENT_CREDENTIAL_CORRUPT", "Credential identity is invalid.");
    }
    let raw: string;
    try {
      const stat = await fs.stat(this.#credentialPath(credentialId));
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_ENVELOPE_BYTES) {
        throw new AgentCredentialError(
          "AGENT_CREDENTIAL_CORRUPT",
          "The protected credential envelope size is invalid."
        );
      }
      raw = await fs.readFile(this.#credentialPath(credentialId), "utf8");
    } catch (error) {
      if (error instanceof AgentCredentialError) {
        throw error;
      }
      throw new AgentCredentialError("AGENT_CREDENTIAL_MISSING", "The protected credential is missing.");
    }
    try {
      const envelope = JSON.parse(raw) as CredentialEnvelope;
      if (
        envelope.schemaVersion !== ENVELOPE_SCHEMA_VERSION ||
        envelope.provider !== "openrouter" ||
        envelope.credentialId !== credentialId ||
        envelope.protection !== "windows-dpapi-current-user" ||
        !envelope.ciphertext
      ) {
        throw new Error("invalid envelope");
      }
      return envelope;
    } catch {
      throw new AgentCredentialError("AGENT_CREDENTIAL_CORRUPT", "The protected credential envelope is invalid.");
    }
  }

  #credentialPath(credentialId: string): string {
    return path.join(this.#directory, `${credentialId}.json`);
  }

  #restrictPath(target: string): void {
    const native = this.#nativeBridge();
    if (!native || !native.restrictPathToCurrentUser(target)) {
      throw new AgentCredentialError(
        "AGENT_CREDENTIAL_DPAPI_PROTECT_FAILED",
        "Relaybase could not restrict protected credential storage to the current Windows user."
      );
    }
  }

  #nativeBridge(): WindowsCredentialNative | undefined {
    if (!this.#nativeLoaded) {
      this.#native = loadWindowsCredentialNative();
      this.#nativeLoaded = true;
    }
    return this.#native;
  }
}

function descriptorFromEnvelope(envelope: CredentialEnvelope): CredentialDescriptor {
  return {
    provider: envelope.provider,
    credentialId: envelope.credentialId,
    protection: envelope.protection,
    createdAt: envelope.createdAt,
    updatedAt: envelope.updatedAt
  };
}

function loadWindowsCredentialNative(): WindowsCredentialNative | undefined {
  if (process.platform !== "win32") {
    return undefined;
  }
  const require = createRequire(import.meta.url);
  const candidates = [
    path.resolve("dist-runtime", "native", `relaybase_windows-win32-${process.arch}.node`),
    path.join(path.dirname(import.meta.dirname), "native", `relaybase_windows-win32-${process.arch}.node`),
    path.resolve("native", "windows-dpapi", "build", "Release", "relaybase_windows.node"),
    path.join(path.dirname(process.execPath), "relaybase_windows.node")
  ];
  for (const candidate of candidates) {
    try {
      return require(candidate) as WindowsCredentialNative;
    } catch {
      continue;
    }
  }
  return undefined;
}

export type { WindowsCredentialNative };
