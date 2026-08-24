import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createStores } from "../src/context.js";
import { NonceStore } from "../src/nonce-store.js";
import { temporaryDirectory } from "./helpers.js";

test("identity, mailbox and contacts remain local and validate mb-p capabilities", async () => {
  const temporary = await temporaryDirectory();
  try {
    const stores = createStores(temporary.path);
    const alice = await stores.identities.create("alice");
    const mailbox = await stores.mailboxes.create("alice", alice.did);
    assert.match(mailbox.room, /^mb-p-[0-9a-f]{40}$/);
    assert.equal(mailbox.room.length, 45);
    await stores.contacts.add("alice", "self", alice.did, mailbox.room);
    assert.equal((await stores.contacts.get("alice", "self")).mailbox, mailbox.room);
    await assert.rejects(() => stores.contacts.add("alice", "bad", alice.did, "p-not-mailbox"), /mb and p/);

    await stores.cursors.advance("alice", mailbox.room, 42);
    const cursorFile = await readFile(`${stores.paths.cursors}\\alice.json`, "utf8");
    assert.equal(cursorFile.includes(mailbox.room), false, "cursor state must not disclose the capability");
    assert.equal(await stores.cursors.get("alice", mailbox.room), 42);
  } finally {
    await temporary.cleanup();
  }
});

test("nonce reservations are persistent, monotonic and serialized", async () => {
  const temporary = await temporaryDirectory();
  try {
    const stores = createStores(temporary.path);
    const alice = await stores.identities.create("alice");
    const room = "mb-p-0123456789abcdef";
    const values = await Promise.all(Array.from({ length: 12 }, () => stores.nonces.reserve(alice.did, room)));
    const sorted = values.map(BigInt).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    assert.equal(new Set(values).size, 12);
    for (let index = 1; index < sorted.length; index += 1) {
      assert.ok(sorted[index]! > sorted[index - 1]!);
    }
    const reopened = new NonceStore(stores.paths.nonces);
    const next = BigInt(await reopened.reserve(alice.did, room));
    assert.ok(next > sorted.at(-1)!);
  } finally {
    await temporary.cleanup();
  }
});

test("mailbox rotation atomically replaces the local capability", async () => {
  const temporary = await temporaryDirectory();
  try {
    const stores = createStores(temporary.path);
    const alice = await stores.identities.create("alice");
    const original = await stores.mailboxes.create("alice", alice.did);
    const replacement = await stores.mailboxes.rotate("alice");
    const persisted = await stores.mailboxes.load("alice");

    assert.notEqual(replacement.room, original.room);
    assert.equal(replacement.did, original.did);
    assert.deepEqual(persisted, replacement);
  } finally {
    await temporary.cleanup();
  }
});
