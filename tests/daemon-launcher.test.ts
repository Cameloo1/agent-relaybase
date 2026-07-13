import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { resolveDaemonRuntimeInvocation } from "../src/daemonLauncher.ts";

test("daemon launcher resolves the TypeScript sibling with strip-types enabled", () => {
  const launcherPath = path.join(os.tmpdir(), "relaybase-source", "daemonLauncher.ts");
  const cliPath = path.join(path.dirname(launcherPath), "cli.ts");

  assert.deepEqual(resolveDaemonRuntimeInvocation(pathToFileURL(launcherPath).href), {
    cliPath,
    nodeArgs: ["--experimental-strip-types", cliPath]
  });
});

test("daemon launcher resolves the compiled JavaScript sibling without TypeScript flags", () => {
  const launcherPath = path.join(os.tmpdir(), "relaybase-package", "dist-runtime", "daemonLauncher.js");
  const cliPath = path.join(path.dirname(launcherPath), "cli.js");

  assert.deepEqual(resolveDaemonRuntimeInvocation(pathToFileURL(launcherPath).href), {
    cliPath,
    nodeArgs: [cliPath]
  });
});

test("daemon launcher rejects unsupported runtime extensions", () => {
  const launcherPath = path.join(os.tmpdir(), "relaybase-package", "dist-runtime", "daemonLauncher.mjs");

  assert.throws(
    () => resolveDaemonRuntimeInvocation(pathToFileURL(launcherPath).href),
    /Unsupported Relaybase daemon launcher extension: \.mjs/
  );
});
