import { ContactStore } from "./contacts.js";
import { CursorStore } from "./cursors.js";
import { IdentityStore } from "./identity.js";
import { MailboxStore } from "./mailboxes.js";
import { NonceStore } from "./nonce-store.js";
import { AmbiguousSendError, ProtocolError } from "./errors.js";
import { attachOutbound, SignedPostRejectedError, type OutboundDiagnostics } from "./send-diagnostics.js";
import { ActionApprovalStore, ApprovalRequiredError, type ActionApproval, type SignedActionEffect } from "./agent/approvals.js";
import { hashValue } from "./agent/util.js";
import { roomClasses } from "./names.js";
import { didToPublicKeyBytes, sanitizeText, signMessage } from "./protocol.js";
import type { InboxMessage, PublicInboxMessage, RoomResponse, TechnocoreTransport, UnlockedIdentity } from "./types.js";

export interface BridgeStores {
  identities: IdentityStore;
  mailboxes: MailboxStore;
  contacts: ContactStore;
  cursors: CursorStore;
  nonces: NonceStore;
  approvals: ActionApprovalStore;
  intake?: <T>(owner: string, operation: () => Promise<T>) => Promise<T>;
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

  withIntakeOwnership<T>(owner: string, operation: () => Promise<T>): Promise<T> {
    return this.stores.intake ? this.stores.intake(owner, operation) : operation();
  }

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
    const progress: OutboundDiagnostics = { stage: "approval", nonceReservation: "not-started", dispatchBegan: false,
      headersReceived: false, bodyStarted: false, responseParsed: false, timedOut: false, errorClass: "Error" };
    let approval: ActionApproval | undefined;
    try {
      approval = await this.stores.approvals.consume(effect, actionId);
      progress.stage = "nonce-reservation"; progress.nonceReservation = "attempted";
      const nonce = await this.stores.nonces.reserve(identity.did, room);
      progress.nonceReservation = "reserved"; progress.stage = "signing";
      const signed = signMessage(identity, room, nonce, text);
      // Entering a transport can have effects before its promise rejects; never infer non-delivery from a generic error.
      progress.stage = "dispatch"; progress.dispatchBegan = true;
      const response = await this.transport.sendSignedMessage(room, {
        did: signed.did, sig: signed.signature, nonce: signed.nonce, text: signed.sanitizedText,
      });
      progress.stage = "local-confirmation"; progress.responseParsed = true; progress.headersReceived = true;
      try {
        await this.stores.approvals.finish(identity.name, approval.actionId, "confirmed");
      } catch (error) {
        throw new AmbiguousSendError("Signed send completed but local confirmation failed; approval remains spent", undefined, { cause: error });
      }
      return response;
    } catch (error) {
      const classified = progress.dispatchBegan && !(error instanceof AmbiguousSendError) && !(error instanceof SignedPostRejectedError)
        ? new AmbiguousSendError("Outbound result requires reconciliation; no automatic retry", undefined, { cause: error }) : error;
      const failure = attachOutbound(classified, progress);
      if (approval) await this.stores.approvals.finish(identity.name, approval.actionId,
        classified instanceof AmbiguousSendError ? "ambiguous" : "failed").catch(() => undefined);
      throw failure;
    }
  }

  private requireApproved(record: ActionApproval): void {
    if (record.status === "requested") throw new ApprovalRequiredError(record.actionId, record.actionHash);
    if (record.status !== "approved") throw new ProtocolError("Outbound approval already spent; reconcile before follow-up");
  }

  async readInbox(owner: string): Promise<PublicInboxMessage[]> {
    return this.withIntakeOwnership(owner, async () => {
      const peek = await this.peekInbox(owner);
      if (peek.lastSeq > peek.previousCursor) {
        await this.acknowledgeInbox(owner, peek.lastSeq);
      }
      return peek.messages.map(({ signature: _signature, ...message }) => message);
    });
  }

  async peekInbox(owner: string, query: { since?: number } = {}): Promise<InboxPeekResult> {
    return this.withIntakeOwnership(owner, () => this.peekOwnedInbox(owner, query));
  }

  private async peekOwnedInbox(owner: string, query: { since?: number }): Promise<InboxPeekResult> {
    const mailbox = await this.stores.mailboxes.load(owner);
    const since = await this.stores.cursors.get(owner, mailbox.room);
    if (query.since !== undefined && (!Number.isSafeInteger(query.since) || query.since < 0)) {
      throw new ProtocolError("Invalid inbox query cursor");
    }
    // An explicit observation cursor is not an acknowledgment or a persisted cursor reset.
    const view = await this.transport.readRoomJson(mailbox.room, { since: query.since ?? since, wait: 0, limit: 200 });
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
        ...(message.sig === undefined ? {} : { signature: message.sig }),
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
    return this.withIntakeOwnership(owner, async () => {
      const mailbox = await this.stores.mailboxes.load(owner);
      await this.stores.cursors.advance(owner, mailbox.room, seq);
    });
  }
}
