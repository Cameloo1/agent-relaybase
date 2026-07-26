import path from "node:path";

export function manifestFieldsChanged(input: Record<string, unknown>): string[] {
  const patch = patchObject(input);
  return Object.keys(patch);
}

export function envKeysChanged(input: Record<string, unknown>): string[] {
  const patch = patchObject(input);
  const env = patch.env;
  if (env && typeof env === "object" && !Array.isArray(env)) {
    return Object.keys(env as Record<string, unknown>);
  }
  return typeof input.key === "string" ? [input.key] : [];
}

export function healthRouteChosen(input: Record<string, unknown>): string | undefined {
  if (typeof input.healthUrl === "string") {
    return input.healthUrl;
  }
  const patch = patchObject(input);
  return typeof patch.healthUrl === "string" ? patch.healthUrl : undefined;
}

export function portStrategyChosen(input: Record<string, unknown>): string | undefined {
  if (typeof input.portStrategy === "string") {
    return input.portStrategy;
  }
  if (typeof input.upstreamPort === "number") {
    return `pinned:${input.upstreamPort}`;
  }
  const patch = patchObject(input);
  return typeof patch.upstreamPort === "number" ? `pinned:${patch.upstreamPort}` : undefined;
}

export function fileWritesFromPreview(value: unknown): unknown[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  const record = value as Record<string, unknown>;
  const direct = record.fileWritePlan;
  if (hasWrites(direct)) {
    return direct.writes;
  }
  const selectedPlan = record.selectedPlan;
  if (
    selectedPlan &&
    typeof selectedPlan === "object" &&
    Array.isArray((selectedPlan as { writes?: unknown }).writes)
  ) {
    return (selectedPlan as { writes: unknown[] }).writes;
  }
  return [];
}

export function looksLikePathTraversal(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  if (normalized.includes("../") || normalized === ".." || normalized.endsWith("/..")) {
    return true;
  }
  const parsed = path.parse(value);
  return parsed.root === "" && normalized.split("/").includes("..");
}

function patchObject(input: Record<string, unknown>): Record<string, unknown> {
  const patch = input.patch;
  return patch && typeof patch === "object" && !Array.isArray(patch) ? (patch as Record<string, unknown>) : {};
}

function hasWrites(value: unknown): value is { writes: unknown[] } {
  return Boolean(value && typeof value === "object" && Array.isArray((value as { writes?: unknown }).writes));
}
