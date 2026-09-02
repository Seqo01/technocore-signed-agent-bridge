import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { test } from "node:test";
import { ActivityJournal } from "../src/agent/journal.js";
import { DeterministicInferenceProvider } from "../src/agent/inference.js";
import { agentPaths } from "../src/agent/paths.js";
import { AgentRuntime, initializeAgent } from "../src/agent/runtime.js";
import { AgentStateStore } from "../src/agent/state-store.js";
import type { JournalEntry } from "../src/agent/types.js";
import { SignedAgentBridge } from "../src/bridge.js";
import { createStores } from "../src/context.js";
import { atomicWriteJson, readJsonFile } from "../src/fs-safe.js";
import { InMemoryTechnocoreTransport } from "../src/mock-transport.js";
import type { PassphraseProvider } from "../src/passphrase.js";
import type {
  ReadRoomOptions,
  RoomResponse,
  SignedMessageEnvelope,
  TechnocoreTransport,
} from "../src/types.js";
import { approveContactSend, generatedPassphraseProvider, temporaryDirectory } from "./helpers.js";

function countingProvider(base: PassphraseProvider): {
  provider: PassphraseProvider;
  calls: () => number;
  reset: () => void;
} {
  let count = 0;
  return {
    provider: async (request) => {
      count += 1;
      return base(request);
    },
    calls: () => count,
    reset: () => { count = 0; },
  };
}

class CapturingTransport implements TechnocoreTransport {
  readonly envelopes: SignedMessageEnvelope[] = [];
  constructor(readonly inner = new InMemoryTechnocoreTransport()) {}
  readRoomText(room: string, options?: ReadRoomOptions): Promise<string> {
    return this.inner.readRoomText(room, options);
  }
  readRoomJson(room: string, options?: ReadRoomOptions): Promise<RoomResponse> {
    return this.inner.readRoomJson(room, options);
  }
  sendSignedMessage(room: string, envelope: SignedMessageEnvelope): Promise<RoomResponse> {
    this.envelopes.push(structuredClone(envelope));
    return this.inner.sendSignedMessage(room, envelope);
  }
}

class FailingJournal extends ActivityJournal {
  override async append(_entry: JournalEntry): Promise<boolean> {
    throw new Error("injected journal failure");
  }
}

test("agent init binds an existing encrypted DID without changing the identity file", async () => {
  const temporary = await temporaryDirectory();
  const passphrases = generatedPassphraseProvider();
  try {
    const stores = createStores(temporary.path, passphrases.provider);
    const alice = await stores.identities.create("alice");
    const identityPath = `${stores.paths.identities}\\alice.json`;
    const before = await readFile(identityPath, "utf8");
    const result = await initializeAgent({
      identityAlias: "alice",
      root: temporary.path,
      passphrases: passphrases.provider,
    });
    const after = await readFile(identityPath, "utf8");
    assert.equal(result.did, alice.did);
    assert.equal(result.created, true);
    assert.equal(result.liveActivity, false);
    assert.equal(after, before);
    const state = await new AgentStateStore(agentPaths(temporary.path, "alice").state).load();
    assert.equal(state.profile.identityAlias, "alice");
    assert.equal(state.profile.did, alice.did);

    await assert.rejects(
      () => initializeAgent({
        identityAlias: "missing",
        root: temporary.path,
        passphrases: passphrases.provider,
      }),
      /does not exist/u,
    );

    await rm(identityPath);
    await assert.rejects(
      () => AgentRuntime.start({
        identityAlias: "alice",
        root: temporary.path,
        passphrases: passphrases.provider,
        inference: new DeterministicInferenceProvider(),
      }),
      /does not exist/u,
    );
  } finally {
    passphrases.cleanup();
    await temporary.cleanup();
  }
});

test("agent startup fails closed for wrong passphrase and profile DID mismatch", async () => {
  const temporary = await temporaryDirectory();
  const passphrases = generatedPassphraseProvider();
  const wrong = generatedPassphraseProvider();
  try {
    const stores = createStores(temporary.path, passphrases.provider);
    await stores.identities.create("alice");
    const bob = await stores.identities.create("bob");
    await initializeAgent({
      identityAlias: "alice",
      root: temporary.path,
      passphrases: passphrases.provider,
    });
    await assert.rejects(
      () => AgentRuntime.start({
        identityAlias: "alice",
        root: temporary.path,
        passphrases: wrong.provider,
        inference: new DeterministicInferenceProvider(),
      }),
      /could not be unlocked/u,
    );

    const statePath = agentPaths(temporary.path, "alice").state;
    const state = await readJsonFile<Record<string, unknown>>(statePath, {});
    (state.profile as Record<string, unknown>).did = bob.did;
    await atomicWriteJson(statePath, state);
    await assert.rejects(
      () => AgentRuntime.start({
        identityAlias: "alice",
        root: temporary.path,
        passphrases: passphrases.provider,
        inference: new DeterministicInferenceProvider(),
      }),
      /profile DID does not match/u,
    );
  } finally {
    wrong.cleanup();
    passphrases.cleanup();
    await temporary.cleanup();
  }
});

test("one runtime unlock serves multiple signed operations without leaking signed material", async () => {
  const temporary = await temporaryDirectory();
  const passphrases = generatedPassphraseProvider();
  const counted = countingProvider(passphrases.provider);
  try {
    const stores = createStores(temporary.path, counted.provider);
    const alice = await stores.identities.create("alice");
    const bob = await stores.identities.create("bob");
    const bobMailbox = await stores.mailboxes.create("bob", bob.did);
    await stores.contacts.add("alice", "bob", bob.did, bobMailbox.room);
    await initializeAgent({
      identityAlias: "alice",
      root: temporary.path,
      passphrases: counted.provider,
    });
    counted.reset();

    const transport = new CapturingTransport();
    const runtime = await AgentRuntime.start({
      identityAlias: "alice",
      passphrases: counted.provider,
      inference: new DeterministicInferenceProvider(),
      transport,
      stores,
    });
    try {
      await runtime.enqueueTask({
        type: "technocore.send-contact",
        id: "send-one",
        idempotencyKey: "send-one",
        payload: { contactId: "bob", text: "offline one" },
      });
      await runtime.enqueueTask({
        type: "technocore.send-contact",
        id: "send-two",
        idempotencyKey: "send-two",
        payload: { contactId: "bob", text: "offline two" },
      });
      for (const taskId of ["send-one", "send-two"]) {
        const request = await runtime.requestOutboundApproval(taskId);
        await runtime.approveOutboundTask(taskId, request.actionHash);
      }
      assert.equal((await runtime.runOnce()).task?.status, "succeeded");
      assert.equal((await runtime.runOnce()).task?.status, "succeeded");
      assert.equal(counted.calls(), 1, "runtime must unlock once, not once per signature");
      assert.equal(transport.envelopes.length, 2);
      assert.equal(transport.envelopes[0]?.did, alice.did);
      const journal = await readFile(runtime.paths.journal, "utf8");
      assert.equal(journal.includes(bobMailbox.room), false);
      assert.equal(journal.includes(passphrases.passphrase.toString("base64url")), false);
      assert.equal(journal.includes("offline one"), false);
      assert.equal(journal.includes("offline two"), false);
      const storedIdentity = await readJsonFile<{
        encryptedPrivateKey?: { ciphertext?: string };
      }>(`${stores.paths.identities}\\alice.json`, {});
      assert.equal(
        journal.includes(storedIdentity.encryptedPrivateKey?.ciphertext ?? "not-present"),
        false,
      );
      for (const envelope of transport.envelopes) {
        assert.equal(journal.includes(envelope.sig), false);
        assert.equal(journal.includes(JSON.stringify(envelope)), false);
      }
    } finally {
      await runtime.close();
    }
  } finally {
    passphrases.cleanup();
    await temporary.cleanup();
  }
});

test("deterministic inference supports success, bounded safe failure and ambiguous outcomes", async () => {
  const temporary = await temporaryDirectory();
  const passphrases = generatedPassphraseProvider();
  try {
    const stores = createStores(temporary.path, passphrases.provider);
    await stores.identities.create("alice");
    await initializeAgent({
      identityAlias: "alice",
      root: temporary.path,
      passphrases: passphrases.provider,
    });
    const inference = new DeterministicInferenceProvider((request) => {
      const mode = (request.input as { mode?: string } | undefined)?.mode;
      if (mode === "throw-secret") {
        throw new Error(`provider failed with hidden sentinel and mb-p-${"f".repeat(40)}`);
      }
      if (mode === "failure") return {
        outcome: "failure",
        retrySafe: true,
        errorCode: "fixture-failure",
        metadata: { provider: "deterministic-local", model: "fixture-v1" },
      };
      if (mode === "ambiguous") return {
        outcome: "ambiguous",
        errorCode: "fixture-ambiguous",
        metadata: {
          provider: "deterministic-local",
          model: "fixture-v1",
          spend: { asset: "test-token", amount: "1", network: "offline" },
        },
      };
      return {
        outcome: "success",
        output: { answer: 42 },
        metadata: { provider: "deterministic-local", model: "fixture-v1" },
      };
    });
    const runtime = await AgentRuntime.start({
      identityAlias: "alice",
      root: temporary.path,
      passphrases: passphrases.provider,
      inference,
    });
    try {
      await runtime.enqueueTask({
        type: "inference",
        idempotencyKey: "infer-success",
        payload: { input: { mode: "success" } },
      });
      await runtime.enqueueTask({
        type: "inference",
        idempotencyKey: "infer-failure",
        maxAttempts: 2,
        payload: { input: { mode: "failure" } },
      });
      await runtime.enqueueTask({
        type: "inference",
        idempotencyKey: "infer-ambiguous",
        payload: { input: { mode: "ambiguous" } },
      });
      await runtime.enqueueTask({
        type: "inference",
        idempotencyKey: "infer-thrown-secret",
        payload: { input: { mode: "throw-secret" } },
      });
      assert.equal((await runtime.runOnce()).task?.status, "succeeded");
      assert.equal((await runtime.runOnce()).task?.status, "pending");
      assert.equal((await runtime.runOnce()).task?.status, "failed");
      assert.equal((await runtime.runOnce()).task?.status, "ambiguous");
      assert.equal((await runtime.runOnce()).task?.status, "ambiguous");
      const memory = await runtime.memory.search({ tag: "inference" });
      assert.equal(memory.length, 1);
      assert.deepEqual(memory[0]?.value, { answer: 42 });
      const journal = await readFile(runtime.paths.journal, "utf8");
      assert.equal(journal.includes("hidden sentinel"), false);
      assert.equal(journal.includes(`mb-p-${"f".repeat(40)}`), false);
    } finally {
      await runtime.close();
    }
  } finally {
    passphrases.cleanup();
    await temporary.cleanup();
  }
});

test("restart recovery requeues pre-effect work and quarantines possible effects", async () => {
  const temporary = await temporaryDirectory();
  const passphrases = generatedPassphraseProvider();
  try {
    const stores = createStores(temporary.path, passphrases.provider);
    const alice = await stores.identities.create("alice");
    await initializeAgent({
      identityAlias: "alice",
      root: temporary.path,
      passphrases: passphrases.provider,
    });
    const state = new AgentStateStore(agentPaths(stores.paths.root, "alice").state);
    const safe = await state.enqueueTask({
      type: "inference",
      idempotencyKey: "recover-safe",
      payload: { input: "safe" },
    });
    const possible = await state.enqueueTask({
      type: "inference",
      idempotencyKey: "recover-possible",
      payload: { input: "possible" },
    });
    assert.equal((await state.claimNextTask())?.id, safe.id);
    assert.equal((await state.claimNextTask())?.id, possible.id);
    await state.checkpointTask(possible.id, "inference-intent", "possible");

    const inference = new DeterministicInferenceProvider();
    const runtime = await AgentRuntime.start({
      identityAlias: "alice",
      root: temporary.path,
      passphrases: passphrases.provider,
      inference,
    });
    try {
      const recovered = await runtime.state.load();
      assert.equal(recovered.tasks[safe.id]?.status, "pending");
      assert.equal(recovered.tasks[possible.id]?.status, "ambiguous");
      assert.equal((await runtime.runOnce()).task?.id, safe.id);
      assert.equal(inference.requests.length, 1);
    } finally {
      await runtime.close();
    }
    assert.equal((await state.load()).profile.did, alice.did);
  } finally {
    passphrases.cleanup();
    await temporary.cleanup();
  }
});

test("graceful stop selects no new task and leaves pending work durable", async () => {
  const temporary = await temporaryDirectory();
  const passphrases = generatedPassphraseProvider();
  try {
    const stores = createStores(temporary.path, passphrases.provider);
    await stores.identities.create("alice");
    await initializeAgent({
      identityAlias: "alice",
      root: temporary.path,
      passphrases: passphrases.provider,
    });
    const runtime = await AgentRuntime.start({
      identityAlias: "alice",
      root: temporary.path,
      passphrases: passphrases.provider,
      inference: new DeterministicInferenceProvider(),
    });
    const task = await runtime.enqueueTask({
      type: "inference",
      idempotencyKey: "stop-pending",
      payload: { input: "wait" },
    });
    await runtime.requestStop();
    assert.equal((await runtime.runOnce()).kind, "stopping");
    assert.equal((await runtime.state.load()).tasks[task.id]?.status, "pending");
    await runtime.run({ idleDelayMs: 1 });
    assert.equal((await runtime.state.load()).runtime.status, "stopped");
  } finally {
    passphrases.cleanup();
    await temporary.cleanup();
  }
});

test("inbox ingestion persists and journals before cursor acknowledgement", async () => {
  const temporary = await temporaryDirectory();
  const passphrases = generatedPassphraseProvider();
  try {
    const stores = createStores(temporary.path, passphrases.provider);
    const alice = await stores.identities.create("alice");
    const bob = await stores.identities.create("bob");
    const aliceMailbox = await stores.mailboxes.create("alice", alice.did);
    const bobMailbox = await stores.mailboxes.create("bob", bob.did);
    await stores.contacts.add("alice", "bob", bob.did, bobMailbox.room);
    await stores.contacts.add("bob", "alice", alice.did, aliceMailbox.room);
    const transport = new InMemoryTechnocoreTransport();
    const bridge = new SignedAgentBridge(stores, transport);
    await bridge.sendTo("alice", "bob", "untrusted inbound text",
      await approveContactSend(bridge, stores, "alice", "bob", "untrusted inbound text"));
    await initializeAgent({
      identityAlias: "bob",
      root: temporary.path,
      passphrases: passphrases.provider,
    });

    const paths = agentPaths(stores.paths.root, "bob");
    const failing = await AgentRuntime.start({
      identityAlias: "bob",
      passphrases: passphrases.provider,
      inference: new DeterministicInferenceProvider(),
      transport,
      stores,
      journal: new FailingJournal(paths.journal),
    });
    await assert.rejects(() => failing.ingestInbox(), /injected journal failure/u);
    const afterFailure = await failing.state.load();
    assert.equal(Object.values(afterFailure.tasks).filter(({ type }) => type === "inbound.message").length, 1);
    assert.equal(await stores.cursors.get("bob", bobMailbox.room), 0);
    await failing.close("failed");

    const recovered = await AgentRuntime.start({
      identityAlias: "bob",
      passphrases: passphrases.provider,
      inference: new DeterministicInferenceProvider(),
      transport,
      stores,
    });
    try {
      assert.equal(await recovered.ingestInbox(), 1);
      assert.equal(await stores.cursors.get("bob", bobMailbox.room), 1);
      const state = await recovered.state.load();
      assert.equal(Object.values(state.tasks).filter(({ type }) => type === "inbound.message").length, 1);
      const task = Object.values(state.tasks).find(({ type }) => type === "inbound.message")!;
      assert.equal(task.payload.trust, "untrusted-external-data");
      assert.equal(task.status, "pending", "inbound text must not execute during ingestion");
    } finally {
      await recovered.close();
    }
  } finally {
    passphrases.cleanup();
    await temporary.cleanup();
  }
});
