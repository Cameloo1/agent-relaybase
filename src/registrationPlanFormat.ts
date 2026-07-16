import path from "node:path";
import { redactDiagnosticText } from "./redaction.ts";
import type { RegistrationSetupResult } from "./setupApiTypes.ts";

export function formatRegistrationPlan(value: Record<string, unknown> | RegistrationSetupResult): string {
  const preview = value as RegistrationSetupResult;
  const app = preview.app;
  const appLabel = app ? `${clean(app.name || app.id)} [${clean(app.id)}]` : "Detection incomplete";
  const command = app?.launch
    ? [app.launch.executable, ...app.launch.args].map(clean).filter(Boolean).join(" ")
    : clean(app?.command ?? "Not determined");
  const healthTargets = preview.verificationIntent?.healthCandidates?.length
    ? preview.verificationIntent.healthCandidates.map(clean).join(", ")
    : clean(app?.healthUrl ?? "No health route detected");
  const writes = (preview.fileWritePlan?.writes ?? []).filter((write) => write.action !== "skip" && write.diff.changed);
  const lines = [
    "Relaybase registration plan",
    "",
    `Detected app: ${appLabel}`,
    `Project: ${clean(preview.projectRoot || app?.cwd || "Unknown")}`,
    `Launch command: ${command}`,
    `Health route: ${healthTargets}`,
    `Manifest: ${clean(preview.manifestPath || "Not determined")}`,
    "",
    "Files that would change:"
  ];

  if (writes.length === 0) {
    lines.push("- None");
  } else {
    for (const write of writes) {
      lines.push(`- ${write.action}: ${displayPath(write.path, preview.projectRoot)} — ${clean(write.reason)}`);
    }
  }

  lines.push("", "Verification:");
  if (preview.verificationIntent?.mode === "quick") {
    lines.push("- Start the app once on a Relaybase-managed test port.");
    lines.push("- Check the detected health route.");
    lines.push("- Stop the app and verify that the backend port closes.");
    lines.push(`- Expected maximum: ${preview.verificationIntent.expectedMaximumMs}ms; no app is left running.`);
  } else {
    lines.push("- Disabled; registration will not make a launch-readiness claim.");
  }

  lines.push(
    "",
    `Approval: ${preview.approval?.required ? "Required before files or registry state change." : "Not required for this preview."}`,
    "This plan does not write files, register the app, or start a process.",
    "Next: run the same command without --plan to review confirmation; add --yes only after accepting this plan.",
    "Use --plan --json when full structured output is required."
  );
  return lines.join("\n");
}

function displayPath(filePath: string, projectRoot: string): string {
  const safePath = clean(filePath);
  const safeRoot = clean(projectRoot);
  if (!safePath || !safeRoot) {
    return safePath || "Unknown file";
  }
  const pathApi = /^[A-Za-z]:[\\/]/.test(safeRoot) ? path.win32 : path;
  const relative = pathApi.relative(safeRoot, safePath);
  return relative && !relative.startsWith("..") && !pathApi.isAbsolute(relative) ? clean(relative) : safePath;
}

function clean(value: unknown): string {
  return redactDiagnosticText(String(value ?? ""))
    .replace(/[\r\n\t]+/g, " ")
    .trim();
}
