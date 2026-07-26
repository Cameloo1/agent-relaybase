import assert from "node:assert/strict";
import test from "node:test";
import { formatRegistrationPlan } from "../src/registrationPlanFormat.ts";
import type { RegistrationSetupResult } from "../src/setupApiTypes.ts";

test("registration plan is concise and keeps structured details behind --json", () => {
  const preview = {
    schemaVersion: 1,
    status: "approval_required",
    message: "Review registration",
    projectRoot: "C:\\workspace\\notes",
    manifestPath: "C:\\workspace\\notes\\relaybase.app.json",
    manifestState: "missing",
    previewId: "preview-1",
    app: {
      id: "notes",
      name: "Notes",
      command: "npm.cmd run dev",
      cwd: "C:\\workspace\\notes",
      protocol: "http",
      healthUrl: "/health",
      env: {},
      reasons: [],
      risks: [],
      recoverySteps: [],
      requiresInput: []
    },
    fileWritePlan: {
      root: "C:\\workspace\\notes",
      approvalRequired: true,
      risks: [],
      writes: [
        {
          path: "C:\\workspace\\notes\\relaybase.app.json",
          action: "create",
          reason: "Create the Relaybase manifest",
          preview: "{}",
          diff: {
            path: "C:\\workspace\\notes\\relaybase.app.json",
            beforeExists: false,
            afterExists: true,
            changed: true,
            hunks: []
          }
        }
      ]
    },
    verificationIntent: {
      mode: "quick",
      willStart: true,
      willStop: true,
      expectedMaximumMs: 19_000,
      healthCandidates: ["/health"]
    },
    questions: [],
    risks: [],
    approval: { required: true, previewId: "preview-1" },
    registered: false,
    started: false,
    filesWritten: false,
    retrySafe: true,
    actions: [],
    diagnostics: []
  } satisfies RegistrationSetupResult;

  const output = formatRegistrationPlan(preview);
  assert.match(output, /^Relaybase registration plan/);
  assert.match(output, /Detected app: Notes \[notes\]/);
  assert.match(output, /Launch command: npm\.cmd run dev/);
  assert.match(output, /Health route: \/health/);
  assert.match(output, /create: relaybase\.app\.json/);
  assert.match(output, /backend port closes/);
  assert.match(output, /Approval: Required/);
  assert.match(output, /does not write files, register the app, or start a process/);
  assert.doesNotMatch(output, /"previewId"|"verificationIntent"|^\s*\{/m);
});
