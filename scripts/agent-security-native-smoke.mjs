#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import path from "node:path";

const [modulePath, stateDir] = process.argv.slice(2);
if (!modulePath || !stateDir) {
  throw new Error("Usage: agent-security-native-smoke.mjs <native-module-path> <state-dir>");
}

const require = createRequire(import.meta.url);
const native = require(path.resolve(modulePath));
const directory = path.resolve(stateDir);
const journalPath = path.join(directory, "repair.sqlite");
await fs.mkdir(directory, { recursive: true });
await fs.writeFile(journalPath, "", { flag: "wx" });

assert.equal(native.restrictPathToCurrentUser(directory), true);
assert.equal(native.restrictPathToCurrentUser(journalPath), true);
assert.equal(native.isPathRestrictedToCurrentUser(directory), true);
assert.equal(native.isPathRestrictedToCurrentUser(journalPath), true);

console.log("Relaybase Agent security native ACL inspect/repair smoke passed.");
