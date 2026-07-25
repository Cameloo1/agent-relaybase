import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { safeToolExecute, successResult, type RelaybaseAgentToolDefinition } from "./common.ts";

const parameters = z
  .object({
    projectRoot: z.string().optional(),
    maxDepth: z.number().int().min(0).max(4).optional(),
    maxDirectories: z.number().int().positive().max(300).optional()
  })
  .strict();

const EXCLUDED = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".venv",
  "target",
  "bin",
  "obj",
  "coverage",
  "artifacts"
]);
const MARKERS: Record<string, number> = {
  "relaybase.app.json": 100,
  "package.json": 40,
  "pyproject.toml": 40,
  "Cargo.toml": 40,
  "go.mod": 40,
  "docker-compose.yml": 30,
  "docker-compose.yaml": 30,
  "compose.yml": 30,
  "compose.yaml": 30
};

export function createDiscoverProjectRootsTool(): RelaybaseAgentToolDefinition<z.infer<typeof parameters>> {
  const definition: RelaybaseAgentToolDefinition<z.infer<typeof parameters>> = {
    name: "discover_project_roots",
    description:
      "Discover and rank plausible project roots inside one user-authorized folder. The scan is read-only, depth/time/count bounded, skips vendor/build/cache directories, and explains each rank.",
    parameters,
    approvalRequired: false,
    risk: "low",
    execute: (input, context) =>
      safeToolExecute(definition, input, async () => {
        const requested = input.projectRoot ?? context.tuiContext.currentCwd;
        if (!requested) {
          return successResult(definition.name, {
            candidates: [],
            ambiguous: false,
            notice: "No authorized project root is selected."
          });
        }
        const root = await fs.realpath(path.resolve(requested));
        const started = Date.now();
        const maxDepth = input.maxDepth ?? 3;
        const maxDirectories = input.maxDirectories ?? 200;
        const candidates: Array<{ path: string; score: number; evidence: string[] }> = [];
        let scannedDirectories = 0;
        let truncated = false;

        async function walk(directory: string, depth: number): Promise<void> {
          if (depth > maxDepth || scannedDirectories >= maxDirectories || Date.now() - started >= 1_500) {
            truncated = true;
            return;
          }
          scannedDirectories += 1;
          let entries: import("node:fs").Dirent[];
          try {
            entries = await fs.readdir(directory, { withFileTypes: true });
          } catch {
            return;
          }
          const names = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
          const evidence = Object.keys(MARKERS).filter((marker) => names.has(marker));
          if (evidence.length) {
            candidates.push({
              path: directory,
              score: evidence.reduce((total, marker) => total + MARKERS[marker]!, 0) - depth * 2,
              evidence
            });
          }
          for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (truncated || !entry.isDirectory() || entry.isSymbolicLink() || EXCLUDED.has(entry.name)) {
              continue;
            }
            await walk(path.join(directory, entry.name), depth + 1);
          }
        }

        await walk(root, 0);
        candidates.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
        const topScore = candidates[0]?.score;
        return successResult(definition.name, {
          searchRoot: root,
          candidates: candidates.slice(0, 25).map((candidate, index) => ({ ...candidate, rank: index + 1 })),
          ambiguous: candidates.filter((candidate) => candidate.score === topScore).length > 1,
          limits: { maxDepth, maxDirectories, scannedDirectories, elapsedMs: Date.now() - started, truncated },
          skippedDirectories: [...EXCLUDED]
        });
      })
  };
  return definition;
}
