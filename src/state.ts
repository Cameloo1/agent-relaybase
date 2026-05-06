import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 7777;
export const DEFAULT_PORT_RANGE_START = 17000;
export const DEFAULT_PORT_RANGE_END = 17999;

export function getDefaultStateDir(): string {
  if (process.env.PORTHUB_STATE_DIR) {
    return path.resolve(process.env.PORTHUB_STATE_DIR);
  }

  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, "PortHub");
  }

  return path.join(os.homedir(), ".porthub");
}

export async function ensureStateDir(stateDir: string): Promise<void> {
  await fs.mkdir(stateDir, { recursive: true });
}

export async function getOrCreateSessionToken(stateDir: string): Promise<string> {
  await ensureStateDir(stateDir);
  const tokenPath = path.join(stateDir, "session-token");

  try {
    const existing = (await fs.readFile(tokenPath, "utf8")).trim();
    if (existing.length >= 32) {
      return existing;
    }
  } catch (error) {
    if (!isNodeErrno(error, "ENOENT")) {
      throw error;
    }
  }

  const token = randomBytes(32).toString("hex");
  await fs.writeFile(tokenPath, `${token}\n`, { mode: 0o600 });
  return token;
}

export function isNodeErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

