import assert from "node:assert/strict";
import { test } from "node:test";
import { createStores } from "../src/context.js";
import { atomicWriteJson } from "../src/fs-safe.js";
import { AgentStateStore } from "../src/agent/state-store.js";
import { agentPaths } from "../src/agent/paths.js";
import { AgentRuntimeLock } from "../src/agent/runtime-lock.js";
import { generatedPassphraseProvider, temporaryDirectory } from "./helpers.js";

function fixedClock(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++));
}

function sequentialIds(): (prefix: string) => string {
  let next = 0;
  return (prefix) => `${prefix}_${++next}`;
}

test("agent profile, goals, tasks and queue survive reopen with idempotent task creation", async () => {
  const temporary = await temporaryDirectory();
  const passphrases = generatedPassphraseProvider();
  try {
    const stores = createStores(temporary.path, passphrases.provider);
    const alice = await stores.identities.create("alice");
    const paths = agentPaths(stores.paths.root, "alice");
    const clock = fixedClock();
    const ids = sequentialIds();
    const state = new AgentStateStore(paths.state, clock, ids);
    assert.equal((await state.initialize(alice)).created, true);
    assert.equal((await state.initialize(alice)).created, false);

    const goal = await state.addGoal("Persist reliable work");
    const first = await state.enqueueTask({
      type: "memory.put",
      goalId: goal.id,
      idempotencyKey: "remember-one",
      payload: { scope: "test", key: "one", value: 1 },
    });
    const duplicate = await state.enqueueTask({
      type: "memory.put",
      goalId: goal.id,
      idempotencyKey: "remember-one",
      payload: { scope: "test", key: "one", value: 1 },
    });
    const second = await state.enqueueTask({
      type: "memory.put",
      idempotencyKey: "remember-two",
      payload: { scope: "test", key: "two", value: 2 },
    });
    assert.equal(duplicate.id, first.id);
    await assert.rejects(
      () => state.enqueueTask({
        type: "memory.put",
        idempotencyKey: "remember-one",
        payload: { scope: "test", key: "changed", value: 1 },
      }),
      /idempotency key.*different/u,
    );

    const reopened = new AgentStateStore(paths.state, clock, ids);
    const loaded = await reopened.load();
    assert.equal(loaded.profile.did, alice.did);
    assert.equal(Object.keys(loaded.goals).length, 1);
    assert.equal(Object.keys(loaded.tasks).length, 2);
    assert.deepEqual(loaded.queue, [first.id, second.id]);
    assert.equal((await reopened.claimNextTask())?.id, first.id);
  } finally {
    passphrases.cleanup();
    await temporary.cleanup();
  }
});

test("agent runtime lock prevents concurrent execution and permits clean reopen", async () => {
  const temporary = await temporaryDirectory();
  try {
    const path = agentPaths(temporary.path, "alice").runtimeLock;
    const first = await AgentRuntimeLock.acquire(path);
    await assert.rejects(() => AgentRuntimeLock.acquire(path), /already active/u);
    await first.release();
    const reopened = await AgentRuntimeLock.acquire(path);
    await reopened.release();
    await atomicWriteJson(path, {
      version: 1,
      pid: 2_147_483_647,
      token: "dead-process-lock-token",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const recovered = await AgentRuntimeLock.acquire(path);
    await recovered.release();
  } finally {
    await temporary.cleanup();
  }
});
