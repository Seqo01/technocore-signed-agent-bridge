import assert from "node:assert/strict";
import { test } from "node:test";
import { runOfflineDemo } from "../src/demo.js";

test("offline coordinator/worker demo completes without a live transport", async () => {
  assert.deepEqual(await runOfflineDemo(), {
    transport: "in-memory-only",
    liveWrites: false,
    task: "return status: ready",
    workerAcceptedFrom: "coordinator",
    response: "status: ready",
    coordinatorAcceptedFrom: "worker",
  });
});
