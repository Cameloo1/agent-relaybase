import { createHash, timingSafeEqual } from "node:crypto";
import type { SetupPlanPreview } from "../../setupApiTypes.ts";
import type { AgentSetupPreviewBinding } from "../types.ts";

export type SetupPreviewBindingFailure = "missing" | "schema" | "setup_plan" | "digest" | "revision";

export function createSetupPreviewBinding(preview: SetupPlanPreview): AgentSetupPreviewBinding {
  return {
    schemaVersion: 1,
    algorithm: "sha256",
    digest: sha256(stableJson(preview)),
    revision: sha256(
      stableJson({
        cwd: preview.cwd,
        setupPlanId: preview.selectedPlan.id,
        writes: preview.fileWritePlan.writes.map((write) => ({
          path: write.path,
          action: write.action,
          beforeExists: write.diff.beforeExists,
          changed: write.diff.changed,
          hunks: write.diff.hunks
        }))
      })
    ),
    setupPlanId: preview.selectedPlan.id
  };
}

export function verifySetupPreviewBinding(
  preview: SetupPlanPreview,
  binding: AgentSetupPreviewBinding | undefined
): { ok: true } | { ok: false; failure: SetupPreviewBindingFailure } {
  if (!binding) {
    return { ok: false, failure: "missing" };
  }
  if (binding.schemaVersion !== 1 || binding.algorithm !== "sha256") {
    return { ok: false, failure: "schema" };
  }
  const current = createSetupPreviewBinding(preview);
  if (binding.setupPlanId !== current.setupPlanId) {
    return { ok: false, failure: "setup_plan" };
  }
  if (!safeHashEqual(binding.digest, current.digest)) {
    return { ok: false, failure: "digest" };
  }
  if (!safeHashEqual(binding.revision, current.revision)) {
    return { ok: false, failure: "revision" };
  }
  return { ok: true };
}

function safeHashEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
