import { ContactStore } from "./contacts.js";
import { CursorStore } from "./cursors.js";
import { IdentityStore } from "./identity.js";
import { MailboxStore } from "./mailboxes.js";
import { NonceStore } from "./nonce-store.js";
import { AmbiguousSendError, ProtocolError } from "./errors.js";
import { ActionApprovalStore, ApprovalRequiredError, type ActionApproval, type SignedActionEffect } from "./agent/approvals.js";
import { hashValue } from "./agent/util.js";
import { roomClasses } from "./names.js";
import { didToPublicKeyBytes, sanitizeText, signMessage } from "./protocol.js";
import type { InboxMessage, RoomResponse, TechnocoreTransport, UnlockedIdentity } from "./types.js";

export interface BridgeStores {
  identities: IdentityStore;
  mailboxes: MailboxStore;
  contacts: ContactStore;
  cursors: CursorStore;
  nonces: NonceStore;
  approvals: ActionApprovalStore;
}

export interface InboxPeekResult {
  messages: InboxMessage[];
  previousCursor: number;
  firstSeq: number | null;
  lastSeq: number;
}

export class SignedAgentBridge {
  constructor(
    private readonly stores: BridgeStores,
    private readonly transport: TechnocoreTransport,
  ) {}

  async prepareContactSend(sender: string, contactId: string, text: string, actionId?: string) {
    const identity = await this.stores.identities.inspect(sender);
    const contact = await this.stores.contacts.get(sender, contactId);
    return this.stores.approvals.propose(this.effect(identity.name, identity.did,
      "technocore.send-contact", { room: contact.mailbox, did: contact.did, contactId }, text), actionId);
  }

  async preparePublicSend(sender: string, room: string, text: string, actionId?: string) {
    const classes = roomClasses(room);
    if (classes.includes("p") || classes.includes("mb")) throw new ProtocolError("Public send requires a public non-mailbox room");
    const identity = await this.stores.identities.inspect(sender);
    return this.stores.approvals.propose(this.effect(identity.name, identity.did,
      "technocore.send-public", { room }, text), actionId);
  }

  private effect(agentAlias: string, agentDid: string, type: SignedActionEffect["type"],
    destination: unknown, text: string): SignedActionEffect {
    return { agentAlias, agentDid, type, destinationHash: hashValue(destination),
      payloadHash: hashValue(sanitizeText(text)) };
  }

  async sendTo(sender: string, contactId: string, text: string, actionId?: string): Promise<RoomResponse> {
    const approval = await this.prepareContactSend(sender, contactId, text, actionId);
    this.requireApproved(approval);
    const identity = await this.stores.identities.unlock(sender);
    return this.sendToUnlocked(sender, identity, contactId, text, approval.actionId);
  }

  async sendToUnlocked(
    sender: string,
    identity: UnlockedIdentity,
    contactId: string,
    text: string,
    actionId?: string,
  ): Promise<RoomResponse> {
    if (identity.name !== sender) throw new ProtocolError("Unlocked identity does not match sender");
    const contact = await this.stores.contacts.get(sender, contactId);
    return this.sendSigned(identity, contact.mailbox, text, this.effect(sender, identity.did,
      "technocore.send-contact", { room: contact.mailbox, did: contact.did, contactId }, text), actionId);
  }

  async sendSignedToRoom(sender: string, room: string, text: string, actionId?: string): Promise<RoomResponse> {
    const classes = roomClasses(room);
    if (classes.includes("p") || classes.includes("mb")) {
      throw new ProtocolError("room:send-signed requires a public non-mailbox room");
    }
    const approval = await this.preparePublicSend(sender, room, text, actionId);
    this.requireApproved(approval);
    const identity = await this.stores.identities.unlock(sender);
    return this.sendSignedToRoomUnlocked(identity, room, text, approval.actionId);
  }

  async sendSignedToRoomUnlocked(
    identity: UnlockedIdentity,
    room: string,
    text: string,
    actionId?: string,
  ): Promise<RoomResponse> {
    const classes = roomClasses(room);
    if (classes.includes("p") || classes.includes("mb")) {
      throw new ProtocolError("room:send-signed requires a public non-mailbox room");
    }
    return this.sendSigned(identity, room, text,
      this.effect(identity.name, identity.did, "technocore.send-public", { room }, text), actionId);
  }

  private async sendSigned(identity: UnlockedIdentity, room: string, text: string,
    effect: SignedActionEffect, actionId?: string): Promise<RoomResponse> {
    // Shared execution boundary for ALL bridge signing paths. No approval, no nonce, no IO.
    const approval = await this.stores.approvals.consume(effect, actionId);
    try {
      const nonce = await this.stores.nonces.reserve(identity.did, room);
      const signed = signMessage(identity, room, nonce, text);
      const response = await this.transport.sendSignedMessage(room, {
        did: signed.did, sig: signed.signature, nonce: signed.nonce, text: signed.sanitizedText,
      });
      try {
        await this.stores.approvals.finish(identity.name, approval.actionId, "confirmed");
      } catch {
        throw new AmbiguousSendError("Signed send completed but local confirmation failed; approval remains spent");
      }
      return response;
    } catch (error) {
      await this.stores.approvals.finish(identity.name, approval.actionId,
        error instanceof AmbiguousSendError ? "ambiguous" : "failed").catch(() => undefined);
      throw error;
    }
  }

  private requireApproved(record: ActionApproval): void {
    if (record.status === "requested") throw new ApprovalRequiredError(record.actionId, record.actionHash);
    if (record.status !== "approved") throw new ProtocolError("Outbound approval already spent; reconcile before follow-up");
  }

  async readInbox(owner: string): Promise<InboxMessage[]> {
    const peek = await this.peekInbox(owner);
    if (peek.lastSeq > peek.previousCursor) {
      await this.acknowledgeInbox(owner, peek.lastSeq);
    }
    return peek.messages;
  }

  async peekInbox(owner: string): Promise<InboxPeekResult> {
    const mailbox = await this.stores.mailboxes.load(owner);
    const since = await this.stores.cursors.get(owner, mailbox.room);
    const view = await this.transport.readRoomJson(mailbox.room, { since, wait: 0, limit: 200 });
    const inbox: InboxMessage[] = [];
    for (const message of view.messages) {
      let serverVerifiedDid = false;
      try {
        didToPublicKeyBytes(message.from);
        serverVerifiedDid = message.nonce !== undefined;
      } catch {
        serverVerifiedDid = false;
      }
      const contact = await this.stores.contacts.findByDid(owner, message.from);
      inbox.push({
        seq: message.seq,
        ts: message.ts,
        senderDid: message.from,
        ...(contact ? { contactId: contact.contactId } : {}),
        text: message.text,
        ...(message.nonce === undefined ? {} : { nonce: message.nonce }),
        serverVerifiedDid,
        trust: "untrusted-external-data",
      });
    }
    return {
      messages: inbox,
      previousCursor: since,
      firstSeq: view.first_seq,
      lastSeq: view.last_seq,
    };
  }

  async acknowledgeInbox(owner: string, seq: number): Promise<void> {
    const mailbox = await this.stores.mailboxes.load(owner);
    await this.stores.cursors.advance(owner, mailbox.room, seq);
  }
}
