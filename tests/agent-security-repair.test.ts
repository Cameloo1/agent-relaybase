import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentSecurityDoctor } from "../src/agent/securityDoctor.ts";
import { AgentSecurityRepairError, AgentSecurityRepairService } from "../src/agent/securityRepairService.ts";
import { AgentSecurityRepairJournal } from "../src/agent/securityRepairJournal.ts";
import type { AgentConfig } from "../src/agent/types.ts";

test("Agent security repair binds preview, applies a safe action, verifies, and replays idempotently", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-agent-security-repair-"));
  const journal = new AgentSecurityRepairJournal({ stateDir });
  let attemptStatus: string | null = "expired";
  const config = fixtureConfig();
  const doctor = new AgentSecurityDoctor({
    getConfig: () => structuredClone(config),
    refreshManagedCredentialState: async () => undefined,
    inspectCredentialProtection: async () => ({ available: true, credentialExists: true, acl: "restricted" }),
    providerAttempt: () => (attemptStatus ? { status: attemptStatus } : null),
    windowsVerificationAvailability: () => ({ available: false })
  });
  const audits: string[] = [];
  const service = new AgentSecurityRepairService({
    doctor,
    journal,
    binding: () => ({
      configRevisionId: config.revision!.id,
      credentialIdentity: "credential-hash",
      sourceFingerprint: "source-hash"
    }),
    refreshManagedCredentialState: async () => undefined,
    clearStaleProviderConnection: () => {
      attemptStatus = null;
    },
    repairCredentialAcl: async () => undefined,
    validateManagedCredential: async () => undefined,
    migrateLegacyCredential: async () => undefined,
    removeLegacyExternalAssignment: async () => undefined,
    disconnectLocalCredential: async () => undefined,
    openProviderKeyManagement: async () => undefined,
    reloadSelectedAgentConfig: async () => undefined,
    audit: (type) => audits.push(type)
  });

  try {
    const preview = await service.preview({
      actionIds: ["clear_stale_provider_connection"],
      issueCodes: ["AGENT_PROVIDER_CONNECTION_STALE"]
    });
    assert.equal(preview.actions[0]?.riskClass, "safe_local");
    const receipt = await service.apply({
      previewId: preview.previewId,
      idempotencyKey: "fixture-idempotency-key",
      confirmation: preview.confirmation.value
    });
    assert.equal(receipt.outcome, "verified");
    assert.deepEqual(receipt.appliedActionIds, ["clear_stale_provider_connection"]);
    const replay = await service.apply({
      previewId: preview.previewId,
      idempotencyKey: "fixture-idempotency-key",
      confirmation: preview.confirmation.value
    });
    assert.deepEqual(replay, receipt);
    assert.ok(audits.includes("agent.security_repair_completed"));
  } finally {
    journal.close();
  }
});

test("Agent security repair rejects state drift before mutation", async () => {
  const journal = new AgentSecurityRepairJournal();
  const config = fixtureConfig();
  let revision = config.revision!.id;
  let clearCalls = 0;
  const doctor = new AgentSecurityDoctor({
    getConfig: () => structuredClone(config),
    refreshManagedCredentialState: async () => undefined,
    inspectCredentialProtection: async () => ({ available: true, credentialExists: true, acl: "restricted" }),
    providerAttempt: () => ({ status: "expired" }),
    windowsVerificationAvailability: () => ({ available: false })
  });
  const service = new AgentSecurityRepairService({
    doctor,
    journal,
    binding: () => ({
      configRevisionId: revision,
      credentialIdentity: "credential-hash",
      sourceFingerprint: "source-hash"
    }),
    refreshManagedCredentialState: async () => undefined,
    clearStaleProviderConnection: () => {
      clearCalls += 1;
    },
    repairCredentialAcl: async () => undefined,
    validateManagedCredential: async () => undefined,
    migrateLegacyCredential: async () => undefined,
    removeLegacyExternalAssignment: async () => undefined,
    disconnectLocalCredential: async () => undefined,
    openProviderKeyManagement: async () => undefined,
    reloadSelectedAgentConfig: async () => undefined,
    audit: () => undefined
  });
  try {
    const preview = await service.preview({ actionIds: ["clear_stale_provider_connection"] });
    revision = "revision-2";
    await assert.rejects(
      service.apply({
        previewId: preview.previewId,
        idempotencyKey: "fixture-stale-key",
        confirmation: preview.confirmation.value
      }),
      (error: unknown) =>
        error instanceof AgentSecurityRepairError && error.code === "AGENT_SECURITY_REPAIR_PREVIEW_STALE"
    );
    assert.equal(clearCalls, 0);
  } finally {
    journal.close();
  }
});

test("Agent security repair journal resolves running operations as interrupted after daemon restart", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-agent-security-journal-"));
  const first = new AgentSecurityRepairJournal({ stateDir });
  const operation = first.beginOperation("preview-1", "idempotency-1");
  first.close();

  const reopened = new AgentSecurityRepairJournal({ stateDir });
  try {
    const recovered = reopened.operation(operation.operationId);
    assert.equal(recovered?.state, "completed");
    assert.equal(recovered?.outcome, "interrupted");
  } finally {
    reopened.close();
  }
});

test("Agent security repair requires exact confirmation and rejects expired previews without mutation", async () => {
  const journal = new AgentSecurityRepairJournal();
  const config = fixtureConfig();
  let clearCalls = 0;
  const doctor = new AgentSecurityDoctor({
    getConfig: () => structuredClone(config),
    refreshManagedCredentialState: async () => undefined,
    inspectCredentialProtection: async () => ({ available: true, credentialExists: true, acl: "restricted" }),
    providerAttempt: () => ({ status: "expired" }),
    windowsVerificationAvailability: () => ({ available: false })
  });
  let previewNow = new Date();
  const dependencies = {
    doctor,
    journal,
    binding: () => ({
      configRevisionId: config.revision!.id,
      credentialIdentity: "credential-hash",
      sourceFingerprint: "source-hash"
    }),
    refreshManagedCredentialState: async () => undefined,
    clearStaleProviderConnection: () => {
      clearCalls += 1;
    },
    repairCredentialAcl: async () => undefined,
    validateManagedCredential: async () => undefined,
    migrateLegacyCredential: async () => undefined,
    removeLegacyExternalAssignment: async () => undefined,
    disconnectLocalCredential: async () => undefined,
    openProviderKeyManagement: async () => undefined,
    reloadSelectedAgentConfig: async () => undefined,
    audit: () => undefined,
    now: () => previewNow
  };
  const service = new AgentSecurityRepairService(dependencies);
  try {
    const preview = await service.preview({ actionIds: ["clear_stale_provider_connection"] });
    await assert.rejects(
      service.apply({
        previewId: preview.previewId,
        idempotencyKey: "wrong-confirmation",
        confirmation: "not-the-bound-confirmation"
      }),
      (error: unknown) =>
        error instanceof AgentSecurityRepairError && error.code === "AGENT_SECURITY_REPAIR_CONFIRMATION_REQUIRED"
    );
    previewNow = new Date("2020-01-01T00:00:00.000Z");
    const expired = await service.preview({ actionIds: ["clear_stale_provider_connection"] });
    await assert.rejects(
      service.apply({
        previewId: expired.previewId,
        idempotencyKey: "expired-preview",
        confirmation: expired.confirmation.value
      }),
      (error: unknown) =>
        error instanceof AgentSecurityRepairError && error.code === "AGENT_SECURITY_REPAIR_PREVIEW_STALE"
    );
    assert.equal(clearCalls, 0);
  } finally {
    journal.close();
  }
});

test("Agent security repair serializes apply and records partial failure evidence", async () => {
  const journal = new AgentSecurityRepairJournal();
  const config = fixtureConfig();
  let acl: "weak" | "restricted" = "weak";
  let releaseACL: (() => void) | undefined;
  let aclStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    aclStarted = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    releaseACL = resolve;
  });
  const doctor = new AgentSecurityDoctor({
    getConfig: () => structuredClone(config),
    refreshManagedCredentialState: async () => undefined,
    inspectCredentialProtection: async () => ({ available: true, credentialExists: true, acl }),
    providerAttempt: () => ({ status: "expired" }),
    windowsVerificationAvailability: () => ({ available: false })
  });
  const service = new AgentSecurityRepairService({
    doctor,
    journal,
    binding: () => ({
      configRevisionId: config.revision!.id,
      credentialIdentity: "credential-hash",
      sourceFingerprint: "source-hash"
    }),
    refreshManagedCredentialState: async () => undefined,
    clearStaleProviderConnection: () => {
      throw Object.assign(new Error("safe fixture failure"), { code: "AGENT_FIXTURE_CLEAR_FAILED" });
    },
    repairCredentialAcl: async () => {
      aclStarted?.();
      await hold;
      acl = "restricted";
    },
    validateManagedCredential: async () => undefined,
    migrateLegacyCredential: async () => undefined,
    removeLegacyExternalAssignment: async () => undefined,
    disconnectLocalCredential: async () => undefined,
    openProviderKeyManagement: async () => undefined,
    reloadSelectedAgentConfig: async () => undefined,
    audit: () => undefined
  });
  try {
    const preview = await service.preview({
      actionIds: ["repair_credential_acl", "clear_stale_provider_connection"]
    });
    const applying = service.apply({
      previewId: preview.previewId,
      idempotencyKey: "partial-operation",
      confirmation: preview.confirmation.value
    });
    await started;
    await assert.rejects(
      service.apply({
        previewId: preview.previewId,
        idempotencyKey: "concurrent-operation",
        confirmation: preview.confirmation.value
      }),
      (error: unknown) => error instanceof AgentSecurityRepairError && error.code === "AGENT_SECURITY_REPAIR_CONFLICT"
    );
    releaseACL?.();
    await assert.rejects(applying, AgentSecurityRepairError);
    const receipt = journal.latestOperation();
    assert.equal(receipt?.outcome, "partial");
    assert.deepEqual(receipt?.appliedActionIds, ["repair_credential_acl"]);
    assert.equal(receipt?.errorCode, "AGENT_FIXTURE_CLEAR_FAILED");
    assert.doesNotMatch(JSON.stringify(receipt), /safe fixture failure/);
  } finally {
    releaseACL?.();
    journal.close();
  }
});

function fixtureConfig(): AgentConfig {
  return {
    enabled: true,
    provider: {
      provider: "openrouter",
      modelSlug: "openrouter/test",
      modelSource: { kind: "persisted_config", label: "saved Agent configuration" },
      apiKeySource: { type: "managed_windows_dpapi", credentialId: "fixture-id", configured: true },
      remoteModelEnabled: true
    },
    execution: {
      segmentMaxTurns: 8,
      totalMaxTurns: 32,
      inactivityTimeoutMs: 120_000,
      hardRunTimeoutMs: 900_000,
      maxOutputTokens: 4096,
      reasoningEffort: "medium",
      noProgressRepeatLimit: 3
    },
    toolAllowlist: [],
    toolAllowlistMode: "all_registered",
    approvalPolicy: "always_for_mutations",
    setupFileWritePolicy: "approval_required",
    allowBrowserOpen: false,
    allowCopyRoute: false,
    updatedAt: new Date().toISOString(),
    revision: { id: "revision-1", generation: 1, loadedAt: new Date().toISOString() },
    source: { mode: "managed", health: "healthy", label: "managed" },
    readiness: "ready",
    credential: {
      provider: "openrouter",
      connection: "connected",
      source: "windows_dpapi",
      protection: "windows-dpapi-current-user",
      credentialId: "fixture-id",
      lastValidatedAt: new Date().toISOString(),
      limitUsd: 5,
      expiresAt: "2027-07-24T00:00:00.000Z",
      highSecurityMode: "unavailable"
    }
  };
}
