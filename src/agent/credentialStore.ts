export type CredentialProtectionMode = "none" | "windows-dpapi-current-user";

export interface CredentialDescriptor {
  provider: "openrouter";
  credentialId: string;
  protection: CredentialProtectionMode;
  createdAt: string;
  updatedAt: string;
}

export interface StoredCredential extends CredentialDescriptor {
  secret: Buffer;
}

export interface CredentialStore {
  available(): boolean;
  protectionMode(): CredentialProtectionMode;
  put(provider: "openrouter", secret: Buffer): Promise<CredentialDescriptor>;
  get(credentialId: string): Promise<StoredCredential>;
  delete(credentialId: string): Promise<boolean>;
  restrictPathToCurrentUser?(target: string): void;
  inspectProtection?(credentialId?: string): Promise<{
    available: boolean;
    credentialExists: boolean;
    acl: "restricted" | "weak" | "unknown";
    errorCode?: string;
  }>;
  repairProtection?(credentialId: string): Promise<void>;
  inspectPathProtection?(target: string): Promise<"restricted" | "weak" | "unknown">;
  verificationAvailability?(): { available: boolean; reason?: string };
}

export class CredentialLease {
  readonly credentialId: string;
  readonly protection: CredentialProtectionMode;
  #secret: Buffer | undefined;

  constructor(secret: Buffer, options: { credentialId: string; protection: CredentialProtectionMode }) {
    if (secret.byteLength === 0) {
      throw new Error("Credential lease cannot be empty.");
    }
    this.#secret = Buffer.from(secret);
    this.credentialId = options.credentialId;
    this.protection = options.protection;
  }

  value(): string {
    if (!this.#secret) {
      throw new Error("Credential lease is no longer available.");
    }
    return this.#secret.toString("utf8");
  }

  dispose(): void {
    this.#secret?.fill(0);
    this.#secret = undefined;
  }
}

export class AgentCredentialError extends Error {
  readonly code:
    | "AGENT_CREDENTIAL_MISSING"
    | "AGENT_CREDENTIAL_DPAPI_PROTECT_FAILED"
    | "AGENT_CREDENTIAL_DPAPI_UNPROTECT_FAILED"
    | "AGENT_CREDENTIAL_CORRUPT"
    | "AGENT_WINDOWS_VERIFICATION_UNAVAILABLE"
    | "AGENT_LEGACY_CREDENTIAL_REMOVAL_UNAVAILABLE"
    | "AGENT_LEGACY_CREDENTIAL_REMOVAL_STALE"
    | "AGENT_LEGACY_CREDENTIAL_REMOVAL_FAILED";

  constructor(code: AgentCredentialError["code"], message: string) {
    super(message);
    this.code = code;
  }
}
