#!/usr/bin/env node

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [modulePath, stateDir] = process.argv.slice(2);
if (!modulePath || !stateDir) {
  throw new Error("Usage: compiled-native-credential-smoke.mjs <module-path> <state-dir>");
}

const { WindowsCredentialStore } = await import(pathToFileURL(path.resolve(modulePath)).href);
const store = new WindowsCredentialStore({ stateDir: path.resolve(stateDir) });
assert.equal(store.available(), true, "packaged Windows credential module is unavailable");
const fixture = "sk-or-fixture-installed-dpapi";
const plaintext = Buffer.from(fixture);
const descriptor = await store.put("openrouter", plaintext);
plaintext.fill(0);
const stored = await store.get(descriptor.credentialId);
try {
  assert.equal(stored.secret.toString("utf8"), fixture);
} finally {
  stored.secret.fill(0);
}
const envelopePath = path.join(stateDir, "agent", "credentials", `${descriptor.credentialId}.json`);
assert.doesNotMatch(await fs.readFile(envelopePath, "utf8"), new RegExp(fixture));
assert.equal(await store.delete(descriptor.credentialId), true);
console.log("Packaged Windows DPAPI credential round trip passed.");
