import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { publishReleaseArtifacts } from "../scripts/publish-release-artifacts.mjs";

const packageNames = [
  "@cameloo/relaybase-tui-windows-amd64",
  "@cameloo/relaybase-tui-windows-arm64",
  "@cameloo/relaybase-tui-darwin-amd64",
  "@cameloo/relaybase-tui-darwin-arm64",
  "@cameloo/relaybase-tui-linux-amd64",
  "@cameloo/relaybase-tui-linux-arm64",
  "@cameloo/relaybase"
];

test("release publisher verifies exact artifacts and skips versions already on npm", () => {
  const directory = releaseFixture();
  const calls: string[][] = [];
  try {
    publishReleaseArtifacts({
      directory,
      spawn: (_command: string, args: string[]) => {
        calls.push(args);
        return { status: 0, stdout: '"0.1.0"\n', stderr: "" };
      }
    });
    assert.equal(calls.length, 7);
    assert.ok(calls.every((args) => args.includes("view")));
    assert.ok(calls.every((args) => !args.includes("publish")));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("release publisher publishes only confirmed npm E404 entries and fails closed on other lookup errors", () => {
  const directory = releaseFixture();
  const calls: string[][] = [];
  try {
    publishReleaseArtifacts({
      directory,
      spawn: (_command: string, args: string[]) => {
        calls.push(args);
        if (args.includes("publish")) return { status: 0, stdout: "+ published\n", stderr: "" };
        if (calls.filter((entry) => entry.includes("view")).length === 1) {
          return { status: 1, stdout: "", stderr: "npm error code E404" };
        }
        return { status: 0, stdout: '"0.1.0"\n', stderr: "" };
      }
    });
    assert.equal(calls.filter((args) => args.includes("publish")).length, 1);

    assert.throws(
      () =>
        publishReleaseArtifacts({
          directory,
          spawn: () => ({ status: 1, stdout: "", stderr: "network unavailable" })
        }),
      /Could not determine publication state/
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function releaseFixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "relaybase-release-publish-"));
  mkdirSync(directory, { recursive: true });
  const packages = packageNames.map((name, index) => {
    const file = `package-${index}.tgz`;
    const contents = Buffer.from(`artifact-${index}`);
    writeFileSync(path.join(directory, file), contents);
    return {
      name,
      version: "0.1.0",
      file,
      sha256: createHash("sha256").update(contents).digest("hex")
    };
  });
  writeFileSync(path.join(directory, "release-manifest.json"), JSON.stringify({ schemaVersion: 1, packages }), "utf8");
  return directory;
}
