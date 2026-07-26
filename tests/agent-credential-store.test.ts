import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { withoutAgentCredentialEnvironment } from "../src/agent/childEnvironment.ts";
import { AgentCredentialError, CredentialLease } from "../src/agent/credentialStore.ts";
import { WindowsCredentialStore, type WindowsCredentialNative } from "../src/agent/windowsCredentialStore.ts";

const FIXTURE_SECRET = "sk-or-fixture-dpapi-roundtrip";

test("credential lease becomes unreadable after prompt disposal", () => {
  const lease = new CredentialLease(Buffer.from(FIXTURE_SECRET), {
    credentialId: "fixture",
    protection: "none"
  });
  assert.equal(lease.value(), FIXTURE_SECRET);
  lease.dispose();
  assert.throws(() => lease.value(), /no longer available/);
});

test("child environments exclude built-in and configured Agent credential names", () => {
  const sanitized = withoutAgentCredentialEnvironment(
    {
      PATH: "fixture-path",
      OPENROUTER_API_KEY: FIXTURE_SECRET,
      RELAYBASE_AGENT_MODEL: "openrouter/fixture",
      RELAYBASE_CUSTOM_PROVIDER_KEY: FIXTURE_SECRET
    },
    ["RELAYBASE_CUSTOM_PROVIDER_KEY"]
  );
  assert.equal(sanitized.PATH, "fixture-path");
  assert.equal(sanitized.OPENROUTER_API_KEY, undefined);
  assert.equal(sanitized.RELAYBASE_AGENT_MODEL, undefined);
  assert.equal(sanitized.RELAYBASE_CUSTOM_PROVIDER_KEY, undefined);
  assert.doesNotMatch(JSON.stringify(sanitized), new RegExp(FIXTURE_SECRET));
});

test(
  "Windows credential store writes only protected fixture data and detects corrupted envelopes",
  { skip: process.platform !== "win32" },
  async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-agent-dpapi-"));
    const protectedPaths: string[] = [];
    const native: WindowsCredentialNative = {
      protectCurrentUser: (plaintext) => transformFixtureBuffer(plaintext),
      unprotectCurrentUser: (ciphertext) => transformFixtureBuffer(ciphertext),
      checkUserVerificationAvailability: () => ({
        available: false,
        reason: "fixture_headless_daemon"
      }),
      requestUserVerification: () => false,
      restrictPathToCurrentUser: (target) => {
        protectedPaths.push(target);
        return true;
      },
      isPathRestrictedToCurrentUser: (target) => protectedPaths.includes(target)
    };
    const store = new WindowsCredentialStore({ stateDir, native });
    const secret = Buffer.from(FIXTURE_SECRET);
    const descriptor = await store.put("openrouter", secret);
    const stored = await store.get(descriptor.credentialId);
    try {
      assert.equal(stored.secret.toString("utf8"), FIXTURE_SECRET);
      assert.equal(descriptor.protection, "windows-dpapi-current-user");
      assert.deepEqual(store.verificationAvailability(), {
        available: false,
        reason: "fixture_headless_daemon"
      });
    } finally {
      stored.secret.fill(0);
      secret.fill(0);
    }

    const credentialPath = path.join(stateDir, "agent", "credentials", `${descriptor.credentialId}.json`);
    const raw = await fs.readFile(credentialPath, "utf8");
    assert.doesNotMatch(raw, new RegExp(FIXTURE_SECRET));
    assert.ok(protectedPaths.includes(credentialPath));

    const envelope = JSON.parse(raw) as Record<string, unknown>;
    envelope.ciphertext = Buffer.from("corrupt").toString("base64");
    await fs.writeFile(credentialPath, JSON.stringify(envelope), "utf8");
    await assert.rejects(
      store.get(descriptor.credentialId),
      (error: unknown) =>
        error instanceof AgentCredentialError &&
        ["AGENT_CREDENTIAL_CORRUPT", "AGENT_CREDENTIAL_DPAPI_UNPROTECT_FAILED"].includes(error.code)
    );
  }
);

test(
  "Windows credential store rejects oversized envelopes before native unprotect",
  { skip: process.platform !== "win32" },
  async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-agent-dpapi-oversized-"));
    let unprotectCalls = 0;
    const native: WindowsCredentialNative = {
      protectCurrentUser: (plaintext) => transformFixtureBuffer(plaintext),
      unprotectCurrentUser: (ciphertext) => {
        unprotectCalls += 1;
        return transformFixtureBuffer(ciphertext);
      },
      checkUserVerificationAvailability: () => ({ available: false }),
      requestUserVerification: () => false,
      restrictPathToCurrentUser: () => true,
      isPathRestrictedToCurrentUser: () => true
    };
    const store = new WindowsCredentialStore({ stateDir, native });
    const secret = Buffer.from(FIXTURE_SECRET);
    const descriptor = await store.put("openrouter", secret);
    secret.fill(0);
    const credentialPath = path.join(stateDir, "agent", "credentials", `${descriptor.credentialId}.json`);
    await fs.writeFile(credentialPath, Buffer.alloc(128 * 1024 + 1, 0x61));

    await assert.rejects(
      store.get(descriptor.credentialId),
      (error: unknown) => error instanceof AgentCredentialError && error.code === "AGENT_CREDENTIAL_CORRUPT"
    );
    assert.equal(unprotectCalls, 0);
  }
);

test(
  "Windows credential store inspects and repairs the exact credential ACL",
  { skip: process.platform !== "win32" },
  async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-agent-dpapi-acl-repair-"));
    const restricted = new Set<string>();
    const native: WindowsCredentialNative = {
      protectCurrentUser: (plaintext) => transformFixtureBuffer(plaintext),
      unprotectCurrentUser: (ciphertext) => transformFixtureBuffer(ciphertext),
      checkUserVerificationAvailability: () => ({ available: false }),
      requestUserVerification: () => false,
      restrictPathToCurrentUser: (target) => {
        restricted.add(target);
        return true;
      },
      isPathRestrictedToCurrentUser: (target) => restricted.has(target)
    };
    const store = new WindowsCredentialStore({ stateDir, native });
    const secret = Buffer.from(FIXTURE_SECRET);
    const descriptor = await store.put("openrouter", secret);
    secret.fill(0);
    const credentialPath = path.join(stateDir, "agent", "credentials", `${descriptor.credentialId}.json`);
    restricted.delete(credentialPath);
    assert.equal((await store.inspectProtection(descriptor.credentialId)).acl, "weak");
    await store.repairProtection(descriptor.credentialId);
    assert.equal((await store.inspectProtection(descriptor.credentialId)).acl, "restricted");
  }
);

test(
  "Windows credential store fails closed when current-user ACL restriction cannot be established",
  { skip: process.platform !== "win32" },
  async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-agent-dpapi-acl-"));
    const native: WindowsCredentialNative = {
      protectCurrentUser: (plaintext) => transformFixtureBuffer(plaintext),
      unprotectCurrentUser: (ciphertext) => transformFixtureBuffer(ciphertext),
      checkUserVerificationAvailability: () => ({ available: false }),
      requestUserVerification: () => false,
      restrictPathToCurrentUser: () => false,
      isPathRestrictedToCurrentUser: () => false
    };
    const store = new WindowsCredentialStore({ stateDir, native });
    const secret = Buffer.from(FIXTURE_SECRET);
    try {
      await assert.rejects(
        store.put("openrouter", secret),
        (error: unknown) =>
          error instanceof AgentCredentialError && error.code === "AGENT_CREDENTIAL_DPAPI_PROTECT_FAILED"
      );
    } finally {
      secret.fill(0);
    }
    const credentialDir = path.join(stateDir, "agent", "credentials");
    const files = await fs.readdir(credentialDir).catch(() => []);
    assert.deepEqual(files, []);
  }
);

function transformFixtureBuffer(input: Buffer): Buffer {
  return Buffer.from(input).map((value) => value ^ 0xa5);
}
