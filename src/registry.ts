import { promises as fs } from "node:fs";
import path from "node:path";
import { ensureStateDir, isNodeErrno } from "./state.ts";
import type { AppManifestInput, AppRecord, RegistryFile } from "./types.ts";
import { mergeAppRecord, normalizeManifest } from "./validation.ts";

export class Registry {
  readonly stateDir: string;
  readonly filePath: string;
  #apps = new Map<string, AppRecord>();
  #loaded = false;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    this.filePath = path.join(stateDir, "registry.json");
  }

  async load(): Promise<void> {
    await ensureStateDir(this.stateDir);

    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as RegistryFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.apps)) {
        throw new Error("Unsupported Relaybase registry format.");
      }

      this.#apps = new Map(parsed.apps.map((app) => [app.id, app]));
    } catch (error) {
      if (!isNodeErrno(error, "ENOENT")) {
        throw error;
      }

      this.#apps = new Map();
      await this.save();
    }

    this.#loaded = true;
  }

  async list(): Promise<AppRecord[]> {
    await this.#ensureLoaded();
    return [...this.#apps.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  async get(id: string): Promise<AppRecord | undefined> {
    await this.#ensureLoaded();
    return this.#apps.get(id);
  }

  async upsertManifest(input: AppManifestInput, options: { manifestPath?: string } = {}): Promise<AppRecord> {
    await this.#ensureLoaded();
    const normalized = normalizeManifest(input, options);
    const existing = this.#apps.get(normalized.id);
    const merged = mergeAppRecord(existing, normalized);
    this.#apps.set(merged.id, merged);
    await this.save();
    return merged;
  }

  // Rename and recovery use a commit-before-publish registry update so a
  // persistence failure cannot leave process-memory state ahead of registry.json.
  async upsertManifestAtomic(input: AppManifestInput, options: { manifestPath?: string } = {}): Promise<AppRecord> {
    await this.#ensureLoaded();
    const normalized = normalizeManifest(input, options);
    const merged = mergeAppRecord(this.#apps.get(normalized.id), normalized);
    const next = new Map(this.#apps);
    next.set(merged.id, merged);
    await this.#saveSnapshot(next);
    this.#apps = next;
    return merged;
  }

  async upsertRecord(record: AppRecord): Promise<AppRecord> {
    await this.#ensureLoaded();
    const merged = mergeAppRecord(this.#apps.get(record.id), record);
    this.#apps.set(merged.id, merged);
    await this.save();
    return merged;
  }

  async remove(id: string): Promise<boolean> {
    await this.#ensureLoaded();
    const removed = this.#apps.delete(id);
    if (removed) {
      await this.save();
    }

    return removed;
  }

  async save(): Promise<void> {
    await this.#saveSnapshot(this.#apps);
  }

  async #saveSnapshot(apps: Map<string, AppRecord>): Promise<void> {
    await ensureStateDir(this.stateDir);
    const data: RegistryFile = {
      version: 1,
      apps: [...apps.values()].sort((a, b) => a.id.localeCompare(b.id))
    };
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      await fs.rename(tempPath, this.filePath);
    } catch (error) {
      await fs.unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }

  async #ensureLoaded(): Promise<void> {
    if (!this.#loaded) {
      await this.load();
    }
  }
}

export async function readManifestFile(manifestPath: string): Promise<AppManifestInput> {
  const raw = await fs.readFile(path.resolve(manifestPath), "utf8");
  return JSON.parse(raw) as AppManifestInput;
}
