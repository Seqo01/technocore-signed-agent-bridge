import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { Socket } from "node:net";
import { SignedAgentBridge } from "../src/bridge.js";
import { createStores } from "../src/context.js";
import { AmbiguousSendError } from "../src/errors.js";
import { safeErrorRecord } from "../src/agent/state-store.js";
import { cleanOutbound, SignedPostRejectedError, type OutboundDiagnostics } from "../src/send-diagnostics.js";
import { InMemoryTechnocoreTransport } from "../src/mock-transport.js";
import { generatedPassphraseProvider, temporaryDirectory } from "./helpers.js";

test("outbound diagnostics classify dispatch uncertainty without leaking raw errors", async t => {
  const tmp = await temporaryDirectory(), pass = generatedPassphraseProvider();
  const originalConnect = Socket.prototype.connect;
  Socket.prototype.connect = (() => { throw new Error("Network forbidden"); }) as typeof originalConnect;
  try {
    const stores = createStores(tmp.path, pass.provider);
    await stores.identities.create("owner"); const identity = await stores.identities.unlock("owner");
    const secret = randomBytes(32).toString("base64url");
    for (const kind of ["generic", "refusal", "nonce", "confirmation"] as const) await t.test(kind, async () => {
      const transport = new InMemoryTechnocoreTransport(); let dispatches = 0;
      const send = transport.sendSignedMessage.bind(transport);
      transport.sendSignedMessage = async (...args) => {
        dispatches++;
        if (kind === "generic") throw Object.assign(new TypeError(secret), { code: "ECONNRESET" });
        if (kind === "refusal") throw new SignedPostRejectedError({ stage: "response-status", status: 400,
          timedOut: false, headersReceived: true, bodyStarted: true, endpoint: secret, contentType: secret });
        return send(...args);
      };
      const reserve = stores.nonces.reserve.bind(stores.nonces), finish = stores.approvals.finish.bind(stores.approvals);
      stores.nonces.reserve = kind === "nonce" ? async () => { throw Object.assign(new Error(secret), { code: "EACCES" }); } : reserve;
      stores.approvals.finish = async (alias, id, status) => {
        if (kind === "confirmation" && status === "confirmed") throw Object.assign(new Error(secret), { code: "ENOSPC" });
        return finish(alias, id, status);
      };
      try {
        const bridge = new SignedAgentBridge(stores, transport);
        const approval = await bridge.preparePublicSend("owner", "test-room", kind);
        await stores.approvals.grant("owner", approval.actionId, approval.actionHash);
        await assert.rejects(() => bridge.sendSignedToRoomUnlocked(identity, "test-room", kind, approval.actionId), error => {
          const record = safeErrorRecord(error);
          assert.equal(JSON.stringify(record).includes(secret), false);
          assert.equal(record.outbound?.dispatchBegan, kind !== "nonce");
          assert.equal(record.outbound?.nonceReservation, kind === "nonce" ? "attempted" : "reserved");
          assert.equal(error instanceof AmbiguousSendError, kind === "generic" || kind === "confirmation");
          if (kind === "generic") assert.equal(record.outbound?.causeCode, "ECONNRESET");
          if (kind === "refusal") { assert.equal(record.outbound?.status, 400); assert.equal(record.outbound?.headersReceived, true); }
          if (kind === "confirmation") { assert.equal(record.outbound?.stage, "local-confirmation"); assert.equal(record.outbound?.responseParsed, true); }
          return true;
        });
        assert.equal(dispatches, kind === "nonce" ? 0 : 1);
        await assert.rejects(() => bridge.sendSignedToRoomUnlocked(identity, "test-room", kind, approval.actionId));
        assert.equal(dispatches, kind === "nonce" ? 0 : 1);
      } finally { stores.nonces.reserve = reserve; stores.approvals.finish = finish; }
    });
    await t.test("diagnostic fields are allowlisted rather than trusting exception data", () => {
      const value = cleanOutbound({ stage: secret, errorClass: secret, causeCode: secret, status: 999,
        endpoint: secret, signature: secret } as unknown as OutboundDiagnostics);
      assert.equal(JSON.stringify(value).includes(secret), false); assert.equal(value.status, undefined);
    });
  } finally { Socket.prototype.connect = originalConnect; pass.cleanup(); await tmp.cleanup(); }
});
