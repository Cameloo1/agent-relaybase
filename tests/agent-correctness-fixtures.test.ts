import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import test from "node:test";
import { detectSetup } from "../src/setupApi.ts";
import { captureFileTree, diffFileTrees } from "../src/agent/correctnessOracle.ts";
import { createCorrectnessFixtureLab } from "./fixtures/agent-correctness.ts";

test("correctness fixture lab represents Node, Python, Go, manifest, ambiguity, secret, and failure boundaries", async () => {
  const lab = await createCorrectnessFixtureLab();
  assert.equal(Object.keys(lab.fixtures).length, 10);

  for (const fixture of Object.values(lab.fixtures)) {
    const before = await captureFileTree(fixture.root);
    const detected = await detectSetup({ cwd: fixture.root });
    const after = await captureFileTree(fixture.root);
    assert.deepEqual(diffFileTrees(before, after), [], `${fixture.kind} detection must be read-only`);

    if (fixture.expected.runtime) {
      const serialized = JSON.stringify(detected);
      assert.match(
        serialized,
        new RegExp(fixture.expected.runtime.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        fixture.kind
      );
    }
    assert.doesNotMatch(
      JSON.stringify(detected),
      new RegExp(lab.secretValue),
      `${fixture.kind} leaked the fixture secret`
    );
  }

  const invalid = JSON.stringify(await detectSetup({ cwd: lab.fixtures["invalid-manifest"].root }));
  assert.match(invalid, /manifest/i);
  assert.match(invalid, /invalid|parse|syntax/i);

  const unsupported = JSON.stringify(await detectSetup({ cwd: lab.fixtures.unsupported.root }));
  assert.match(unsupported, /unknown|unsupported|manual|no .*runtime/i);

  const monorepo = JSON.stringify(await detectSetup({ cwd: lab.fixtures["ambiguous-monorepo"].root }));
  assert.match(monorepo, /apps[\\/]web|apps[\\/]api|workspace/i);

  await fs.rm(lab.root, { recursive: true, force: true });
});
