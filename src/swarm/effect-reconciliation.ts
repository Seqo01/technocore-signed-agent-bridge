import { resolve } from "node:path";
import { ActionApprovalStore } from "../agent/approvals.js";
import { createStores } from "../context.js";
import { atomicWriteJson } from "../fs-safe.js";
import { hashValue } from "../agent/util.js";
import { BridgeError } from "../errors.js";
import { HttpTechnocoreTransport } from "../transport.js";
import type { TechnocoreTransport } from "../types.js";
import { SessionStateStore, sessionDirectory } from "./session-state.js";
import { classifyEffectObservation } from "./peer-recovery.js";
import { withMailboxOwner } from "./mailbox-owner.js";

/** Separate exact-approval recovery boundary; session authority NEVER grants these reads.
 * Results are observations, not a resend/commit decision. No identity unlock, cursor or nonce API.
 */
export class PeerEffectReconciliation {
  private readonly approvals: ActionApprovalStore;
  private readonly directory: string;
  constructor(private readonly root: string, private readonly sessionId: string, private readonly offlineTransport?: TechnocoreTransport) {
    this.directory = resolve(sessionDirectory(root, sessionId), "effect-reconciliation");
    this.approvals = new ActionApprovalStore(resolve(this.directory, "approvals"));
  }
  private async bound(effectId: string) {
    const state = await SessionStateStore.read(this.root, this.sessionId), effect = state.effects[effectId];
    if (state.lifecycle !== "halted" || !effect || !["ambiguous", "failed"].includes(effect.status)) throw new BridgeError("Reconciliation requires a halted session and spent effect");
    const stores = createStores(this.root), source = state.policy.members.find(m => m.alias === effect.source)!, target = state.policy.members.find(m => m.alias === effect.target)!;
    const pair = state.policy.pairs.find(p => p.sourceDid === source.did && p.targetDid === target.did);
    if (!pair) throw new BridgeError("Missing original destination binding");
    const contact = await stores.contacts.get(source.alias, pair.contactId), mailbox = await stores.mailboxes.load(target.alias);
    if (mailbox.did !== target.did || contact.did !== target.did || contact.mailbox !== mailbox.room ||
      effect.destinationHash !== pair.destinationHash || hashValue({ room: contact.mailbox, did: contact.did, contactId: pair.contactId }) !== effect.destinationHash) throw new BridgeError("Reconciliation destination changed");
    const request = { agentAlias: target.alias, agentDid: target.did, type: "technocore.reconcile-send-read" as const,
      destinationHash: effect.destinationHash, payloadHash: hashValue({ session: this.sessionId, effectId, effectHash: hashValue(effect), query: { since: 0, wait: 0, limit: 200 } }) };
    return { state, effect, request, mailbox, source };
  }
  async prepare(effectId: string) {
    const { request } = await this.bound(effectId);
    return this.approvals.propose(request, hashValue({ session: this.sessionId, effectId, purpose: "single-observation" }));
  }
  async authorize(effectId: string, expectedActionHash: string): Promise<void> {
    const request = await this.prepare(effectId);
    await this.approvals.grant(request.agentAlias, request.actionId, expectedActionHash);
  }
  async observe(effectId: string, expectedActionHash: string) {
    const { state, effect, request, mailbox, source } = await this.bound(effectId);
    if (state.policy.mode === "configured" && this.offlineTransport) throw new BridgeError("Live recovery cannot use a test transport");
    if (state.policy.mode === "offline" && !this.offlineTransport) throw new BridgeError("Offline recovery requires the retained test transport");
    const prepared = await this.prepare(effectId);
    if (prepared.actionHash !== expectedActionHash) throw new BridgeError("Exact observation hash mismatch");
    return withMailboxOwner(this.root, mailbox.room, async () => {
      await this.approvals.consume(request, prepared.actionId);
      try {
        const transport = this.offlineTransport ?? new HttpTechnocoreTransport("https://technocore.chat", { readRetries: 0, rateLimitRetries: 0, readRedirect: "error" });
        const view = await transport.readRoomJson(mailbox.room, { since: 0, wait: 0, limit: 200 });
        const observation = classifyEffectObservation(effect, source.did, view);
        await atomicWriteJson(resolve(this.directory, `${prepared.actionId}.json`), { version: 1, actionHash: prepared.actionHash,
          effectHash: hashValue(effect), observation, count: view.count, firstSeq: view.first_seq, lastSeq: view.last_seq, observedAt: new Date().toISOString() });
        await this.approvals.finish(request.agentAlias, prepared.actionId, "confirmed");
        return observation;
      } catch {
        await this.approvals.finish(request.agentAlias, prepared.actionId, "ambiguous").catch(() => undefined);
        throw new BridgeError("Reconciliation observation interrupted; no retry or cursor mutation");
      }
    });
  }
}
