import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentCredentialError } from "../src/agent/credentialStore.ts";
import { LegacyCredentialRemovalManager } from "../src/agent/legacyCredentialRemoval.ts";

const FIXTURE_SECRET = "sk-or-fixture-legacy-removal";

test("legacy credential cleanup removes exactly one preview-bound assignment without a plaintext backup", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-agent-legacy-removal-"));
  const envPath = path.join(directory, "agent.env");
  const original = [
    "# Relaybase fixture",
    "RELAYBASE_AGENT_ENABLED=1",
    `export OPENROUTER_API_KEY="${FIXTURE_SECRET}" # selected`,
    "RELAYBASE_AGENT_MODEL=openrouter/fixture",
    ""
  ].join("\r\n");
  await fs.writeFile(envPath, original, "utf8");
  const restricted: string[] = [];
  const manager = new LegacyCredentialRemovalManager({
    filePath: envPath,
    sourceLabel: "RELAYBASE_ENV_FILE",
    restrictPath: (target) => restricted.push(target)
  });

  const preview = await manager.preview();
  assert.equal(preview.keyName, "OPENROUTER_API_KEY");
  assert.equal(preview.lineNumber, 3);
  assert.equal(preview.changedLineCount, 1);
  assert.doesNotMatch(JSON.stringify(preview), new RegExp(FIXTURE_SECRET));

  const applied = await manager.apply(preview.previewId);
  assert.equal(applied.removed, true);
  const current = await fs.readFile(envPath, "utf8");
  assert.equal(
    current,
    ["# Relaybase fixture", "RELAYBASE_AGENT_ENABLED=1", "RELAYBASE_AGENT_MODEL=openrouter/fixture", ""].join("\r\n")
  );
  assert.doesNotMatch(current, new RegExp(FIXTURE_SECRET));
  assert.ok(restricted.some((target) => target.endsWith(".tmp")));
  assert.ok(restricted.includes(envPath));
  assert.deepEqual((await fs.readdir(directory)).sort(), ["agent.env"]);
});

test("legacy credential cleanup rejects a stale preview and preserves the changed source", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-agent-legacy-stale-"));
  const envPath = path.join(directory, ".env");
  await fs.writeFile(envPath, `OPENROUTER_API_KEY=${FIXTURE_SECRET}\nOTHER=value\n`, "utf8");
  const manager = new LegacyCredentialRemovalManager({
    filePath: envPath,
    sourceLabel: ".env",
    restrictPath: () => undefined
  });
  const preview = await manager.preview();
  const changed = `OPENROUTER_API_KEY=${FIXTURE_SECRET}\nOTHER=changed\n`;
  await fs.writeFile(envPath, changed, "utf8");

  await assert.rejects(
    manager.apply(preview.previewId),
    (error: unknown) => error instanceof AgentCredentialError && error.code === "AGENT_LEGACY_CREDENTIAL_REMOVAL_STALE"
  );
  assert.equal(await fs.readFile(envPath, "utf8"), changed);
});

test("legacy credential cleanup refuses ambiguous duplicate assignments", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-agent-legacy-ambiguous-"));
  const envPath = path.join(directory, ".env");
  await fs.writeFile(
    envPath,
    `OPENROUTER_API_KEY=${FIXTURE_SECRET}\nOPENROUTER_API_KEY=${FIXTURE_SECRET}-two\n`,
    "utf8"
  );
  const manager = new LegacyCredentialRemovalManager({
    filePath: envPath,
    sourceLabel: ".env",
    restrictPath: () => undefined
  });

  await assert.rejects(
    manager.preview(),
    (error: unknown) =>
      error instanceof AgentCredentialError && error.code === "AGENT_LEGACY_CREDENTIAL_REMOVAL_UNAVAILABLE"
  );
  assert.match(await fs.readFile(envPath, "utf8"), new RegExp(FIXTURE_SECRET));
});
