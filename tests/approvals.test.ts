import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { ActionApprovalStore, ApprovalRequiredError } from "../src/agent/approvals.js";
import { DeterministicInferenceProvider } from "../src/agent/inference.js";
import { AgentRuntime, initializeAgent } from "../src/agent/runtime.js";
import { hashValue } from "../src/agent/util.js";
import { SignedAgentBridge } from "../src/bridge.js";
import { createStores } from "../src/context.js";
import { AmbiguousSendError } from "../src/errors.js";
import { atomicWriteJson, pathExists } from "../src/fs-safe.js";
import { InMemoryTechnocoreTransport } from "../src/mock-transport.js";
import type { RoomResponse, SignedMessageEnvelope } from "../src/types.js";
import { generatedPassphraseProvider, temporaryDirectory } from "./helpers.js";

class ProbeTransport extends InMemoryTechnocoreTransport {
  writes = 0;
  ambiguous = false;
  override async sendSignedMessage(room: string, body: SignedMessageEnvelope): Promise<RoomResponse> {
    this.writes++;
    if (this.ambiguous) throw new AmbiguousSendError("Test-only unknown outcome");
    return super.sendSignedMessage(room, body);
  }
}

test("shared approval gate blocks direct tasks, payload/destination mutations, reuse and ambiguous retries", async t => {
  const tmp = await temporaryDirectory();
  const secret = generatedPassphraseProvider();
  let runtime: AgentRuntime | undefined;
  try {
    const stores = createStores(tmp.path, secret.provider);
    const owner = await stores.identities.create("owner");
    const peer = await stores.identities.create("peer");
    const mailbox = await stores.mailboxes.create("peer", peer.did);
    await stores.contacts.add("owner", "peer", peer.did, mailbox.room);
    await initializeAgent({ identityAlias: "owner", root: tmp.path, passphrases: secret.provider });
    const transport = new ProbeTransport();
    const options = { identityAlias: "owner", root: tmp.path, passphrases: secret.provider,
      inference: new DeterministicInferenceProvider(), transport, handleSignals: false };
    runtime = await AgentRuntime.start(options);
    const bridge = new SignedAgentBridge(stores, transport);

    await t.test("no boolean or raw task insertion bypasses approval; nonce remains absent", async () => {
      for (const type of ["technocore.send-contact", "technocore.send-public"]) {
        const task = await runtime!.state.enqueueTask({ type, idempotencyKey: type,
          payload: { contactId: "peer", room: "public", text: "one exact effect", approved: true, approval: { approved: true } } });
        const result = await runtime!.runOnce();
        assert.equal(result.task?.id, task.id);
        assert.equal(result.task?.status, "awaiting-approval");
      }
      assert.equal(transport.writes, 0);
      assert.equal(await pathExists(stores.paths.nonces), false);
    });

    await t.test("approval is bound to the runtime-derived task identity and canonical effect", async () => {
      const tasks = Object.values((await runtime!.state.load()).tasks);
      for (const task of tasks) {
        const requested = await runtime!.requestOutboundApproval(task.id);
        await runtime!.approveOutboundTask(task.id, requested.actionHash);
        assert.equal((await runtime!.runOnce()).task?.status, "succeeded");
        assert.equal((await stores.approvals.read("owner", requested.actionId)).status, "confirmed");
        await assert.rejects(() => stores.approvals.grant("owner", requested.actionId, requested.actionHash), /spent/u);
      }
      assert.equal(transport.writes, 2);
    });

    await t.test("task mutation after approval invalidates exact content and does not reserve a nonce", async () => {
      const task = await runtime!.enqueueTask({ type: "technocore.send-contact", idempotencyKey: "mutation",
        payload: { contactId: "peer", text: "reviewed content" } });
      const request = await runtime!.requestOutboundApproval(task.id);
      await runtime!.approveOutboundTask(task.id, request.actionHash);
      const before = await readFile(stores.paths.nonces, "utf8");
      const state = await runtime!.state.load();
      state.tasks[task.id]!.payload.text = "different content";
      await atomicWriteJson(runtime!.paths.state, state);
      assert.equal((await runtime!.runOnce()).task?.status, "failed");
      assert.equal(transport.writes, 2);
      assert.equal(await readFile(stores.paths.nonces, "utf8"), before);
      assert.equal((await stores.approvals.read("owner", request.actionId)).status, "approved");
    });

    await t.test("room, recipient and action type cannot reuse another approval", async () => {
      const request = await bridge.preparePublicSend("owner", "public", "one");
      await stores.approvals.grant("owner", request.actionId, request.actionHash);
      await assert.rejects(() => bridge.sendSignedToRoom("owner", "another", "one", request.actionId), /changed/u);
      await assert.rejects(() => bridge.sendTo("owner", "peer", "one", request.actionId), /changed/u);
      const other = await bridge.preparePublicSend("peer", "public", "one");
      await assert.rejects(() => stores.approvals.grant("peer", other.actionId, request.actionHash), /hash mismatch/u);
      assert.equal(transport.writes, 2);
    });

    await t.test("concurrent consumers can spend one approval only once", async () => {
      const request = await bridge.preparePublicSend("owner", "public", "parallel");
      await stores.approvals.grant("owner", request.actionId, request.actionHash);
      const unlocked = await stores.identities.unlock("owner");
      const results = await Promise.allSettled([
        bridge.sendSignedToRoomUnlocked(unlocked, "public", "parallel", request.actionId),
        bridge.sendSignedToRoomUnlocked(unlocked, "public", "parallel", request.actionId),
      ]);
      assert.equal(results.filter(item => item.status === "fulfilled").length, 1);
      assert.equal(transport.writes, 3);
    });

    await t.test("approval survives a crash between grant and task resume without granting a second effect", async () => {
      const task = await runtime!.enqueueTask({ type: "technocore.send-public", idempotencyKey: "grant-crash",
        payload: { room: "public", text: "durable but not resumed" } });
      assert.equal((await runtime!.runOnce()).task?.status, "awaiting-approval");
      const request = await runtime!.requestOutboundApproval(task.id);
      await stores.approvals.grant("owner", request.actionId, request.actionHash);
      await runtime!.close();
      runtime = await AgentRuntime.start(options);
      await runtime.approveOutboundTask(task.id, request.actionHash);
      assert.equal((await runtime.runOnce()).task?.status, "succeeded");
      assert.equal(transport.writes, 4);
    });

    await t.test("ambiguous send spends approval and nonce, survives restart and is never replayed", async () => {
      const task = await runtime!.enqueueTask({ type: "technocore.send-contact", idempotencyKey: "ambiguous",
        payload: { contactId: "peer", text: "uncertain" } });
      const request = await runtime!.requestOutboundApproval(task.id);
      await runtime!.approveOutboundTask(task.id, request.actionHash);
      const nonceBefore = await readFile(stores.paths.nonces, "utf8");
      transport.ambiguous = true;
      assert.equal((await runtime!.runOnce()).task?.status, "ambiguous");
      assert.notEqual(await readFile(stores.paths.nonces, "utf8"), nonceBefore);
      await runtime!.close();
      runtime = await AgentRuntime.start(options);
      assert.equal((await runtime.runOnce()).kind, "idle");
      assert.equal((await new ActionApprovalStore(stores.paths.approvals).read("owner", request.actionId)).status, "ambiguous");
      await assert.rejects(() => runtime!.approveOutboundTask(task.id, request.actionHash), /spent/u);
      assert.equal(transport.writes, 5);
    });

    await t.test("crash after approval consumption is quarantined even before nonce reservation", async () => {
      const task = await runtime!.enqueueTask({ type: "technocore.send-public", idempotencyKey: "crash-consumed",
        payload: { room: "public", text: "crash boundary" } });
      const request = await runtime!.requestOutboundApproval(task.id);
      await runtime!.approveOutboundTask(task.id, request.actionHash);
      assert.equal((await runtime!.state.claimNextTask())?.id, task.id);
      await runtime!.state.checkpointTask(task.id, "action-intent", "possible");
      await stores.approvals.consume(request, request.actionId);
      await runtime!.close();
      runtime = await AgentRuntime.start(options);
      assert.equal((await runtime.state.load()).tasks[task.id]?.status, "ambiguous");
      assert.equal((await runtime.runOnce()).kind, "idle");
      await assert.rejects(() => bridge.sendSignedToRoom("owner", "public", "crash boundary", request.actionId), /spent/u);
      assert.equal(transport.writes, 5);
    });

    await t.test("CLI-equivalent bridge calls cannot send without durable approval; errors/journal are secret-free", async () => {
      await assert.rejects(() => bridge.sendTo("owner", "peer", "private message body"), ApprovalRequiredError);
      const journal = await readFile(runtime!.paths.journal, "utf8");
      assert.equal(journal.includes(mailbox.room), false);
      assert.equal(journal.includes("private message body"), false);
      assert.equal(journal.includes(secret.passphrase.toString("base64url")), false);
      assert.equal(journal.includes("encryptedPrivateKey"), false);
      assert.equal(transport.writes, 5);
      const wrongEffect = { agentAlias: "owner", agentDid: owner.did, type: "commerce.claim" as never,
        destinationHash: hashValue("somewhere"), payloadHash: hashValue("anything") };
      await assert.rejects(() => stores.approvals.propose(wrongEffect), /Invalid outbound/u);
    });
  } finally {
    await runtime?.close();
    secret.cleanup();
    await tmp.cleanup();
  }
});
