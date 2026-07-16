#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { targets } from "./tui-go.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function inspectAuthenticodeBuffer(input) {
  const data = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (data.length < 64 || data.readUInt16LE(0) !== 0x5a4d) {
    return invalid("not a valid PE file");
  }

  const peOffset = data.readUInt32LE(0x3c);
  if (peOffset > data.length - 24 || data.readUInt32LE(peOffset) !== 0x00004550) {
    return invalid("PE header is missing or truncated");
  }

  const optionalHeaderSize = data.readUInt16LE(peOffset + 20);
  const optionalHeader = peOffset + 24;
  if (optionalHeaderSize < 2 || optionalHeader > data.length - optionalHeaderSize) {
    return invalid("PE optional header is truncated");
  }

  const magic = data.readUInt16LE(optionalHeader);
  const numberOfDirectoriesOffset = magic === 0x10b ? 92 : magic === 0x20b ? 108 : undefined;
  const dataDirectoriesOffset = magic === 0x10b ? 96 : magic === 0x20b ? 112 : undefined;
  if (numberOfDirectoriesOffset === undefined || dataDirectoriesOffset === undefined) {
    return invalid("PE optional header has an unsupported format");
  }
  if (optionalHeaderSize < dataDirectoriesOffset + 40) {
    return invalid("PE security directory is missing");
  }

  const numberOfDirectories = data.readUInt32LE(optionalHeader + numberOfDirectoriesOffset);
  if (numberOfDirectories <= 4) {
    return unsigned("PE security directory is empty");
  }

  const securityDirectory = optionalHeader + dataDirectoriesOffset + 4 * 8;
  const certificateOffset = data.readUInt32LE(securityDirectory);
  const certificateSize = data.readUInt32LE(securityDirectory + 4);
  if (certificateOffset === 0 && certificateSize === 0) {
    return unsigned("PE security directory is empty");
  }
  if (certificateOffset === 0 || certificateSize < 8 || certificateOffset > data.length - certificateSize) {
    return invalid("PE certificate table points outside the file");
  }

  const certificates = [];
  let cursor = certificateOffset;
  const end = certificateOffset + certificateSize;
  while (cursor + 8 <= end) {
    const length = data.readUInt32LE(cursor);
    const revision = data.readUInt16LE(cursor + 4);
    const certificateType = data.readUInt16LE(cursor + 6);
    if (length < 8 || cursor > end - length) {
      return invalid("PE certificate entry is truncated");
    }
    certificates.push({ length, revision, certificateType });
    cursor += alignEight(length);
  }

  const authenticode = certificates.find(
    (certificate) => certificate.revision === 0x0200 && certificate.certificateType === 0x0002
  );
  if (!authenticode) {
    return unsigned("PE certificate table has no Authenticode PKCS#7 entry", certificates);
  }
  return {
    validPe: true,
    hasAuthenticode: true,
    status: "present",
    reason: "Authenticode certificate table is present",
    certificates
  };
}

export function inspectWindowsSignature(filePath) {
  return { filePath, ...inspectAuthenticodeBuffer(readFileSync(filePath)) };
}

export function verifyAuthenticodeTrust(filePath, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return {
      trusted: false,
      status: "Unavailable",
      statusMessage: "Windows trust validation requires a Windows runner."
    };
  }

  const spawn = options.spawn ?? spawnSync;
  const powershell = options.powershell ?? "powershell.exe";
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$signature = Get-AuthenticodeSignature -LiteralPath $args[0]",
    "$payload = [ordered]@{ status = [string]$signature.Status; statusMessage = [string]$signature.StatusMessage; signer = [string]$signature.SignerCertificate.Subject }",
    "$payload | ConvertTo-Json -Compress",
    "if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) { exit 1 }"
  ].join("; ");
  const result = spawn(powershell, ["-NoProfile", "-NonInteractive", "-Command", script, filePath], {
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let parsed;
  try {
    parsed = JSON.parse(result.stdout ?? "");
  } catch {
    parsed = undefined;
  }
  return {
    trusted: result.status === 0 && parsed?.status === "Valid",
    status: parsed?.status ?? "Error",
    statusMessage: parsed?.statusMessage ?? result.stderr?.trim() ?? result.error?.message ?? "Trust check failed.",
    signer: parsed?.signer
  };
}

export function checkWindowsSignatures(filePaths, options = {}) {
  const requirePresent = options.requirePresent ?? false;
  const requireTrusted = options.requireTrusted ?? false;
  let failed = false;
  const results = [];

  for (const filePath of filePaths) {
    let inspection;
    try {
      inspection = inspectWindowsSignature(filePath);
    } catch (error) {
      inspection = {
        filePath,
        validPe: false,
        hasAuthenticode: false,
        status: "invalid",
        reason: error instanceof Error ? error.message : String(error),
        certificates: []
      };
    }
    let trust;
    if (requireTrusted && inspection.hasAuthenticode) {
      trust = verifyAuthenticodeTrust(filePath, options);
    }
    const presentFailure = requirePresent && !inspection.hasAuthenticode;
    const trustFailure = requireTrusted && (!trust || !trust.trusted);
    failed ||= presentFailure || trustFailure;
    results.push({ ...inspection, trust });
  }

  return { ok: !failed, results };
}

function alignEight(value) {
  return (value + 7) & ~7;
}

function invalid(reason) {
  return { validPe: false, hasAuthenticode: false, status: "invalid", reason, certificates: [] };
}

function unsigned(reason, certificates = []) {
  return { validPe: true, hasAuthenticode: false, status: "unsigned", reason, certificates };
}

function cliPaths(args) {
  const explicit = args.filter((argument) => !argument.startsWith("--"));
  if (explicit.length > 0) return explicit.map((entry) => path.resolve(entry));
  return targets
    .filter((target) => target.goos === "windows")
    .map((target) => path.join(root, "bin", "relaybase-tui", target.binary));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const requireTrusted = args.includes("--require-trusted");
  const report = checkWindowsSignatures(cliPaths(args), {
    requirePresent: requireTrusted || args.includes("--require-present"),
    requireTrusted
  });
  for (const result of report.results) {
    const trust = result.trust ? `; Windows trust: ${result.trust.status}` : "";
    console.log(`${result.filePath}: ${result.status} (${result.reason})${trust}`);
    if (result.trust?.statusMessage && !result.trust.trusted) {
      console.error(`Trust detail: ${result.trust.statusMessage}`);
    }
  }
  process.exitCode = report.ok ? 0 : 1;
}
