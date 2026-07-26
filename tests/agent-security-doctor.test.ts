import assert from "node:assert/strict";
import test from "node:test";
import { AgentSecurityDoctor, type AgentCredentialProtectionInspection } from "../src/agent/securityDoctor.ts";
import type { AgentConfig } from "../src/agent/types.ts";

test("Agent security doctor reports healthy protected state without provider work or secrets", async () => {
  let refreshCalls = 0;
  let inspectionCalls = 0;
  const doctor = doctorFor(managedConfig(), {
    refresh: () => {
      refreshCalls += 1;
    },
    inspect: () => {
      inspectionCalls += 1;
      return { available: true, credentialExists: true, acl: "restricted" };
    }
  });

  const status = await doctor.diagnose();
  assert.equal(status.healthy, true);
  assert.equal(status.online, false);
  assert.equal(refreshCalls, 1);
  assert.equal(inspectionCalls, 1);
  assert.ok(status.findings.some((finding) => finding.code === "AGENT_CREDENTIAL_PROTECTED"));
  assert.ok(status.findings.some((finding) => finding.code === "AGENT_PROVIDER_KEY_VALIDATED"));
  assert.doesNotMatch(JSON.stringify(status), /fixture-secret|credential-123/);
});

test("Agent security doctor distinguishes weak ACL, legacy external, shell-owned, and missing states", async () => {
  const weak = await doctorFor(managedConfig(), {
    inspect: () => ({ available: true, credentialExists: true, acl: "weak" })
  }).diagnose();
  assert.equal(weak.state, "blocked");
  assert.equal(
    weak.findings.find((finding) => finding.code === "AGENT_CREDENTIAL_ACL_WEAK")?.recommendedActionId,
    "repair_credential_acl"
  );

  const externalConfig = managedConfig();
  externalConfig.provider.apiKeySource = {
    type: "environment",
    envVar: "OPENROUTER_API_KEY",
    configured: true
  };
  externalConfig.credential = {
    provider: "openrouter",
    connection: "connected",
    source: "external_file",
    protection: "none",
    highSecurityMode: "unavailable"
  };
  const external = await doctorFor(externalConfig).diagnose();
  assert.equal(
    external.findings.find((finding) => finding.code === "AGENT_LEGACY_CREDENTIAL_PRESENT")?.recommendedActionId,
    "migrate_legacy_credential"
  );

  externalConfig.credential.source = "environment";
  const shell = await doctorFor(externalConfig).diagnose();
  const shellFinding = shell.findings.find((finding) => finding.code === "AGENT_CREDENTIAL_SOURCE_SHELL_OWNED");
  assert.equal(shellFinding?.requiresRestart, true);
  assert.ok(shellFinding?.alternateActionIds?.includes("route_to_daemon_restart"));

  externalConfig.provider.apiKeySource.configured = false;
  externalConfig.credential = undefined;
  const missing = await doctorFor(externalConfig).diagnose();
  assert.equal(missing.state, "blocked");
  assert.equal(
    missing.findings.find((finding) => finding.code === "AGENT_CREDENTIAL_MISSING")?.recommendedActionId,
    "route_to_provider_connect"
  );
});

test("Agent security doctor keeps optional unavailable Windows verification healthy and flags required mode", async () => {
  const optional = await doctorFor(managedConfig()).diagnose();
  assert.equal(
    optional.findings.find((finding) => finding.code === "AGENT_WINDOWS_VERIFICATION_STATUS")?.state,
    "healthy"
  );

  const requiredConfig = managedConfig();
  requiredConfig.credential!.highSecurityMode = "required";
  const required = await doctorFor(requiredConfig).diagnose();
  assert.equal(required.state, "blocked");
  assert.ok(required.findings.some((finding) => finding.code === "AGENT_WINDOWS_VERIFICATION_UNAVAILABLE"));
});

test("Agent security doctor performs provider work only for an explicit online check and preserves safe state on failure", async () => {
  let probeCalls = 0;
  const doctor = doctorFor(managedConfig(), {
    probe: async () => {
      probeCalls += 1;
      throw new Error("fixture body with sk-or-secret must not escape");
    }
  });
  const local = await doctor.diagnose();
  assert.equal(probeCalls, 0);
  assert.equal(local.online, false);
  const online = await doctor.diagnose({ online: true });
  assert.equal(probeCalls, 1);
  assert.equal(online.online, true);
  assert.ok(online.findings.some((finding) => finding.code === "AGENT_PROVIDER_METADATA_STALE"));
  assert.doesNotMatch(JSON.stringify(online), /sk-or-secret|fixture body/);
});

function doctorFor(
  config: AgentConfig,
  options: {
    refresh?: () => void;
    inspect?: () => AgentCredentialProtectionInspection;
    probe?: () => Promise<void>;
  } = {}
): AgentSecurityDoctor {
  return new AgentSecurityDoctor({
    getConfig: () => structuredClone(config),
    refreshManagedCredentialState: async () => {
      options.refresh?.();
    },
    inspectCredentialProtection: async () =>
      options.inspect?.() ?? { available: true, credentialExists: true, acl: "restricted" },
    providerAttempt: () => null,
    ...(options.probe ? { probeProviderCredential: options.probe } : {}),
    windowsVerificationAvailability: () => ({ available: false, reason: "fixture_headless" }),
    now: () => new Date("2026-07-24T00:00:00.000Z")
  });
}

function managedConfig(): AgentConfig {
  return {
    enabled: true,
    provider: {
      provider: "openrouter",
      modelSlug: "openrouter/test",
      modelSource: { kind: "persisted_config", label: "saved Agent configuration" },
      apiKeySource: {
        type: "managed_windows_dpapi",
        credentialId: "credential-123",
        configured: true
      },
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
    updatedAt: "2026-07-24T00:00:00.000Z",
    revision: {
      id: "revision-1",
      generation: 1,
      loadedAt: "2026-07-24T00:00:00.000Z"
    },
    source: {
      mode: "managed",
      health: "healthy",
      label: "Relaybase managed configuration"
    },
    readiness: "ready",
    credential: {
      provider: "openrouter",
      connection: "connected",
      source: "windows_dpapi",
      protection: "windows-dpapi-current-user",
      credentialId: "credential-123",
      lastValidatedAt: "2026-07-24T00:00:00.000Z",
      keyLabel: "Relaybase fixture",
      limitUsd: 5,
      expiresAt: "2027-07-24T00:00:00.000Z",
      highSecurityMode: "unavailable"
    }
  };
}
