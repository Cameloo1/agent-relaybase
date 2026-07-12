import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OperationStore, OperationStoreClosedError } from "../src/operationStore.ts";

test("durable lifecycle operation ledger survives restart without persisting secrets", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-operation-store-"));
  const store = new OperationStore({ stateDir });
  const handle = store.enqueueLifecycle({
    operationType: "start",
    targetId: "notes",
    correlationId: "operation-ledger-test",
    run: async () => ({ status: "running", token: "operation-secret-token" }),
    evaluate: () => ({ status: "succeeded", message: "Notes started." })
  });
  await handle.done;
  const shutdown = await store.shutdown();
  assert.equal(shutdown.drained, true);
  assert.equal(shutdown.activeOperationCount, 0);

  const reloaded = new OperationStore({ stateDir });
  const operation = reloaded.get(handle.operationId);
  assert.equal(operation?.status, "succeeded");
  assert.equal(operation?.message, "Notes started.");
  assert.doesNotMatch(JSON.stringify(operation), /operation-secret-token/);
  assert.match(JSON.stringify(operation), /\[redacted\]/);
  reloaded.close();
});

test("bounded shutdown fails blocked lifecycle work closed and preserves retry discovery after restart", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-operation-interrupted-"));
  const store = new OperationStore({ stateDir });
  let release: (() => void) | undefined;
  let abortObserved = false;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handle = store.enqueueLifecycle({
    operationType: "restart",
    targetId: "notes",
    correlationId: "operation-interrupted-test",
    run: async ({ signal }) => {
      await Promise.race([
        blocked,
        new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              abortObserved = true;
              resolve();
            },
            { once: true }
          );
        })
      ]);
      if (signal.aborted) {
        throw new Error("operation aborted for shutdown");
      }
      return { status: "running" };
    },
    evaluate: () => ({ status: "succeeded" })
  });

  await waitFor(() => store.get(handle.operationId)?.status === "running");
  const shutdown = await store.shutdown({ timeoutMs: 20 });
  assert.equal(shutdown.drained, false);
  assert.equal(abortObserved, true);
  assert.equal(shutdown.activeOperationCount, 1);
  assert.deepEqual(shutdown.interruptedOperationIds, [handle.operationId]);
  assert.throws(
    () =>
      store.enqueueLifecycle({
        operationType: "start",
        targetId: "other",
        correlationId: "operation-after-shutdown",
        run: async () => ({ status: "running" }),
        evaluate: () => ({ status: "succeeded" })
      }),
    OperationStoreClosedError
  );

  const reloaded = new OperationStore({ stateDir });
  const operation = reloaded.get(handle.operationId);
  assert.equal(operation?.status, "failed");
  assert.equal(operation?.retryable, true);
  assert.equal(operation?.canRetry, true);
  assert.equal(operation?.canAbort, false);
  assert.equal(operation?.error?.code, "LIFECYCLE_OPERATION_SHUTDOWN");
  assert.match(operation?.message ?? "", /completion could not be confirmed/i);
  assert.deepEqual(
    reloaded
      .list({ statuses: ["failed"], retryableOnly: true, operationType: "restart", targetId: "notes" })
      .map((entry) => entry.operationId),
    [handle.operationId]
  );
  reloaded.close();

  const lateResult = await handle.done;
  assert.equal(lateResult.status, "failed");
  assert.equal(lateResult.error?.code, "LIFECYCLE_OPERATION_SHUTDOWN");
  release?.();
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for lifecycle operation state.");
}
