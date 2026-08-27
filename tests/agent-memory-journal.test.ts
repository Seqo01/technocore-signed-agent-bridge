import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { ActivityJournal } from "../src/agent/journal.js";
import { LocalMemoryProvider } from "../src/agent/memory.js";
import { hashText } from "../src/agent/util.js";
import { createStores } from "../src/context.js";
import { agentPaths } from "../src/agent/paths.js";
import { generatedPassphraseProvider, temporaryDirectory } from "./helpers.js";

test("local memory is durable, deterministic and idempotent across reopen", async () => {
  const temporary = await temporaryDirectory();
  try {
    const path = agentPaths(temporary.path, "alice").memory;
    const firstProvider = new LocalMemoryProvider(path, () => new Date("2026-01-01T00:00:00Z"));
    const first = await firstProvider.put({
      idempotencyKey: "memory-one",
      scope: "project",
      key: "decision",
      value: { answer: 42 },
      tags: ["durable", "test"],
    });
    const duplicate = await firstProvider.put({
      idempotencyKey: "memory-one",
      scope: "project",
      key: "decision",
      value: { answer: 42 },
      tags: ["test", "durable"],
    });
    assert.equal(duplicate.id, first.id);
    await assert.rejects(
      () => firstProvider.put({
        idempotencyKey: "memory-one",
        scope: "project",
        key: "decision",
        value: { answer: 43 },
        tags: ["durable", "test"],
      }),
      /idempotency key.*different/u,
    );

    const reopened = new LocalMemoryProvider(path);
    assert.deepEqual((await reopened.get(first.id))?.value, { answer: 42 });
    assert.deepEqual((await reopened.search({ scope: "project" })).map(({ id }) => id), [first.id]);
    assert.deepEqual((await reopened.search({ key: "decision" })).map(({ id }) => id), [first.id]);
    assert.deepEqual((await reopened.search({ tag: "durable" })).map(({ id }) => id), [first.id]);
    assert.deepEqual(await reopened.search({ tag: "missing" }), []);
  } finally {
    await temporary.cleanup();
  }
});

test("activity journal is append-only, idempotent and rejects private room material", async () => {
  const temporary = await temporaryDirectory();
  const passphrases = generatedPassphraseProvider();
  try {
    const stores = createStores(temporary.path, passphrases.provider);
    const alice = await stores.identities.create("alice");
    const path = agentPaths(stores.paths.root, "alice").journal;
    const journal = new ActivityJournal(path);
    const entry = {
      version: 1 as const,
      id: "event_1",
      timestamp: "2026-01-01T00:00:00.000Z",
      did: alice.did,
      sessionId: "session_1",
      event: "task-complete",
      outcome: "success" as const,
      resultHash: hashText("public result"),
      inference: {
        provider: "deterministic-local",
        model: "fixture-v1",
        latencyMs: 5,
        usage: { requests: "1" },
        spend: { asset: "test-token", amount: "0.125", network: "offline" },
      },
    };
    assert.equal(await journal.append(entry), true);
    assert.equal(await journal.append(entry), false);
    assert.equal((await journal.read()).length, 1);

    const capability = `mb-p-${"a".repeat(40)}`;
    await assert.rejects(
      () => journal.append({
        ...entry,
        id: "event_2",
        publicTechnocore: { room: capability, seq: 1, did: alice.did },
      }),
      /Private room names|forbidden secret/u,
    );
    const raw = await readFile(path, "utf8");
    assert.equal(raw.includes(capability), false);
    assert.equal(raw.includes(passphrases.passphrase.toString("base64url")), false);
    assert.equal(raw.includes("signature"), false);
    assert.equal(raw.includes("privateKey"), false);
  } finally {
    passphrases.cleanup();
    await temporary.cleanup();
  }
});
