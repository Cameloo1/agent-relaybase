import { existsSync, readFileSync, renameSync, unlinkSync } from "node:fs";

const MAX_NPM_SHIM_BYTES = 64 * 1024;
const RELAYBASE_ENTRYPOINT = "node_modules/@cameloo/relaybase/bin/relaybase.cjs";

export function isRecognizedRelaybaseNpmPowerShellShim(content: string): boolean {
  if (!content || Buffer.byteLength(content, "utf8") > MAX_NPM_SHIM_BYTES) {
    return false;
  }
  const normalized = content.replaceAll("\\", "/").toLowerCase();
  return (
    normalized.includes(RELAYBASE_ENTRYPOINT) &&
    normalized.includes("$basedir") &&
    normalized.includes("$lastexitcode") &&
    (normalized.includes("node$exe") || normalized.includes('node"'))
  );
}

export function removeRecognizedRelaybasePowerShellShim(
  ps1Path: string,
  cmdPath: string,
  options: { backupSuffix?: string } = {}
): { removed: boolean; reason?: "missing" | "unrecognized" | "failed"; error?: string } {
  if (!existsSync(ps1Path) || !existsSync(cmdPath)) {
    return { removed: false, reason: "missing" };
  }
  let content: string;
  try {
    content = readFileSync(ps1Path, "utf8");
  } catch (error) {
    return { removed: false, reason: "failed", error: errorMessage(error) };
  }
  if (!isRecognizedRelaybaseNpmPowerShellShim(content)) {
    return { removed: false, reason: "unrecognized" };
  }

  const backupPath = `${ps1Path}.${options.backupSuffix ?? `relaybase-backup-${process.pid}`}`;
  try {
    renameSync(ps1Path, backupPath);
    if (!existsSync(cmdPath)) {
      throw new Error("relaybase.cmd disappeared during PowerShell shim repair.");
    }
    unlinkSync(backupPath);
    return { removed: true };
  } catch (error) {
    try {
      if (existsSync(backupPath) && !existsSync(ps1Path)) {
        renameSync(backupPath, ps1Path);
      }
    } catch (restoreError) {
      return {
        removed: false,
        reason: "failed",
        error: `${errorMessage(error)} Restore failed: ${errorMessage(restoreError)}`
      };
    }
    return { removed: false, reason: "failed", error: errorMessage(error) };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
