import assert from "node:assert/strict";
import { test } from "node:test";
import { SignedAgentBridge } from "../src/bridge.js";
import { createStores } from "../src/context.js";
import { AmbiguousSendError } from "../src/errors.js";
import { InMemoryTechnocoreTransport } from "../src/mock-transport.js";
import type { ReadRoomOptions, RoomResponse, SignedMessageEnvelope, TechnocoreTransport } from "../src/types.js";
import { temporaryDirectory } from "./helpers.js";

test("signed mailbox bridge sends, attributes and advances its local cursor", async () => {
  const temporary = await temporaryDirectory();
  try {
    const { paths: _paths, ...stores } = createStores(temporary.path);
    const transport = new InMemoryTechnocoreTransport();
    const bridge = new SignedAgentBridge(stores, transport);
    const alice = await stores.identities.create("alice");
    const bob = await stores.identities.create("bob");
    const aliceMailbox = await stores.mailboxes.create("alice", alice.did);
    const bobMailbox = await stores.mailboxes.create("bob", bob.did);
    await stores.contacts.add("alice", "bob", bob.did, bobMailbox.room);
    await stores.contacts.add("bob", "alice", alice.did, aliceMailbox.room);

    await bridge.sendTo("alice", "bob", "hello\nworker");
    const first = await bridge.readInbox("bob");
    assert.deepEqual(first.map(({ contactId, text, serverVerifiedDid, trust }) => ({ contactId, text, serverVerifiedDid, trust })), [{
      contactId: "alice",
      text: "hello worker",
      serverVerifiedDid: true,
      trust: "untrusted-external-data",
    }]);
    assert.deepEqual(await bridge.readInbox("bob"), [], "cursor prevents duplicate delivery");
  } finally {
    await temporary.cleanup();
  }
});

test("signed public-room send needs only a local identity and persists its room nonce", async () => {
  const temporary = await temporaryDirectory();
  try {
    const { paths: _paths, ...stores } = createStores(temporary.path);
    const transport = new InMemoryTechnocoreTransport();
    const bridge = new SignedAgentBridge(stores, transport);
    const alice = await stores.identities.create("alice");

    const response = await bridge.sendSignedToRoom("alice", "lobby", "public\nproof");
    assert.equal(response.posted?.from, alice.did);
    assert.equal(response.posted?.text, "public proof");
    assert.equal(response.posted?.seq, 1);
    assert.ok(await stores.nonces.last(alice.did, "lobby"));
    await assert.rejects(() => stores.mailboxes.load("alice"), /does not exist/u);
    await assert.rejects(() => stores.contacts.get("alice", "bob"), /does not exist/u);
    await assert.rejects(
      () => bridge.sendSignedToRoom("alice", "mb-p-0123456789abcdef", "not public"),
      /requires a public non-mailbox room/u,
    );
    assert.equal(await stores.nonces.last(alice.did, "mb-p-0123456789abcdef"), undefined);
  } finally {
    await temporary.cleanup();
  }
});

test("an ambiguous send consumes its nonce and is never automatically repeated", async () => {
  const temporary = await temporaryDirectory();
  try {
    const { paths: _paths, ...stores } = createStores(temporary.path);
    const alice = await stores.identities.create("alice");
    const bob = await stores.identities.create("bob");
    const bobMailbox = await stores.mailboxes.create("bob", bob.did);
    await stores.contacts.add("alice", "bob", bob.did, bobMailbox.room);
    let calls = 0;
    const transport: TechnocoreTransport = {
      readRoomText: async (_room: string, _options?: ReadRoomOptions) => "",
      readRoomJson: async (_room: string, _options?: ReadRoomOptions): Promise<RoomResponse> => ({ count: 0, first_seq: null, last_seq: 0, messages: [] }),
      sendSignedMessage: async (_room: string, _envelope: SignedMessageEnvelope): Promise<RoomResponse> => {
        calls += 1;
        throw new AmbiguousSendError("unknown");
      },
    };
    const bridge = new SignedAgentBridge(stores, transport);
    await assert.rejects(() => bridge.sendTo("alice", "bob", "once"), AmbiguousSendError);
    assert.equal(calls, 1);
    const consumed = await stores.nonces.last(alice.did, bobMailbox.room);
    assert.ok(consumed);
    const next = await stores.nonces.reserve(alice.did, bobMailbox.room);
    assert.ok(BigInt(next) > BigInt(consumed!));
  } finally {
    await temporary.cleanup();
  }
});
