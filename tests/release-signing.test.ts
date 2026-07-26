import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acceptSignedWindowsBinaries } from "../scripts/accept-signed-windows.mjs";
import {
  checkWindowsSignatures,
  inspectAuthenticodeBuffer,
  verifyAuthenticodeTrust
} from "../scripts/windows-signature.mjs";
import { ensureGoCommandDirectories, windowsResourceVersion } from "../scripts/windows-version-resource.mjs";

test("Authenticode inspection distinguishes signed, unsigned, and malformed PE files", () => {
  const signed = inspectAuthenticodeBuffer(peFixture({ signed: true }));
  assert.equal(signed.validPe, true);
  assert.equal(signed.hasAuthenticode, true);
  assert.equal(signed.certificates[0]?.revision, 0x0200);
  assert.equal(signed.certificates[0]?.certificateType, 0x0002);

  const unsigned = inspectAuthenticodeBuffer(peFixture({ signed: false }));
  assert.equal(unsigned.validPe, true);
  assert.equal(unsigned.hasAuthenticode, false);
  assert.equal(unsigned.status, "unsigned");

  const malformed = inspectAuthenticodeBuffer(Buffer.from("not a PE file"));
  assert.equal(malformed.validPe, false);
  assert.equal(malformed.hasAuthenticode, false);
});

test("signature gate fails closed when any required Windows binary is unsigned", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "relaybase-signature-gate-"));
  try {
    const signedPath = path.join(directory, "signed.exe");
    const unsignedPath = path.join(directory, "unsigned.exe");
    writeFileSync(signedPath, peFixture({ signed: true }));
    writeFileSync(unsignedPath, peFixture({ signed: false }));
    const report = checkWindowsSignatures([signedPath, unsignedPath], { requirePresent: true });
    assert.equal(report.ok, false);
    assert.equal(report.results[0]?.hasAuthenticode, true);
    assert.equal(report.results[1]?.hasAuthenticode, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("signed artifact acceptance requires and preserves TUI and credential-module certificate tables", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "relaybase-signpath-output-"));
  const source = path.join(directory, "source");
  const destination = path.join(directory, "destination", "tui");
  const nativeDestination = path.join(directory, "destination", "native");
  try {
    mkdirSync(source, { recursive: true });
    for (const binary of [
      "relaybase-tui-windows-amd64.exe",
      "relaybase-tui-windows-arm64.exe",
      "relaybase_windows-win32-x64.node",
      "relaybase_windows-win32-arm64.node"
    ]) {
      writeFileSync(path.join(source, binary), peFixture({ signed: true }));
    }
    const accepted = acceptSignedWindowsBinaries({
      sourceDir: source,
      destinationDir: destination,
      nativeDestinationDir: nativeDestination
    });
    assert.equal(accepted.length, 4);
    for (const entry of accepted) {
      assert.deepEqual(readFileSync(entry.destination), readFileSync(entry.source));
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Windows version conversion is deterministic and bounded", () => {
  assert.equal(windowsResourceVersion("0.1.0"), "0.1.0.0");
  assert.equal(windowsResourceVersion("12.34.56-beta.1"), "12.34.56.0");
  assert.throws(() => windowsResourceVersion("1.2"), /cannot be represented/);
  assert.throws(() => windowsResourceVersion("1.2.70000"), /exceeds Windows version metadata limits/);
});

test("Windows resource generation prepares clean Go cache and temp directories", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "relaybase-go-directories-"));
  const goCache = path.join(directory, "cache", "nested");
  const goTmp = path.join(directory, "tmp", "nested");
  try {
    ensureGoCommandDirectories({ GOCACHE: goCache, GOTMPDIR: goTmp });
    assert.equal(existsSync(goCache), true);
    assert.equal(existsSync(goTmp), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Windows trust validation is explicitly unavailable off Windows", () => {
  const trust = verifyAuthenticodeTrust("relaybase.exe", { platform: "linux" });
  assert.equal(trust.trusted, false);
  assert.equal(trust.status, "Unavailable");
});

function peFixture(options: { signed: boolean }) {
  const certificateOffset = 0x200;
  const certificateSize = options.signed ? 16 : 0;
  const data = Buffer.alloc(certificateOffset + certificateSize);
  data.writeUInt16LE(0x5a4d, 0);
  data.writeUInt32LE(0x80, 0x3c);
  data.writeUInt32LE(0x00004550, 0x80);
  data.writeUInt16LE(0x8664, 0x84);
  data.writeUInt16LE(0x00f0, 0x94);
  const optionalHeader = 0x98;
  data.writeUInt16LE(0x20b, optionalHeader);
  data.writeUInt32LE(16, optionalHeader + 108);
  const securityDirectory = optionalHeader + 112 + 4 * 8;
  if (options.signed) {
    data.writeUInt32LE(certificateOffset, securityDirectory);
    data.writeUInt32LE(certificateSize, securityDirectory + 4);
    data.writeUInt32LE(certificateSize, certificateOffset);
    data.writeUInt16LE(0x0200, certificateOffset + 4);
    data.writeUInt16LE(0x0002, certificateOffset + 6);
    data.fill(0xa5, certificateOffset + 8, certificateOffset + certificateSize);
  }
  return data;
}
