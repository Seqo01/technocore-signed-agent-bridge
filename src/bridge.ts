import { ContactStore } from "./contacts.js";
import { CursorStore } from "./cursors.js";
import { IdentityStore } from "./identity.js";
import { MailboxStore } from "./mailboxes.js";
import { NonceStore } from "./nonce-store.js";
import { ProtocolError } from "./errors.js";
import { roomClasses } from "./names.js";
import { didToPublicKeyBytes, signMessage } from "./protocol.js";
import type { InboxMessage, RoomResponse, TechnocoreTransport, UnlockedIdentity } from "./types.js";

export interface BridgeStores {
  identities: IdentityStore;
  mailboxes: MailboxStore;
  contacts: ContactStore;
  cursors: CursorStore;
  nonces: NonceStore;
}

export class SignedAgentBridge {
  constructor(
    private readonly stores: BridgeStores,
    private readonly transport: TechnocoreTransport,
  ) {}

  async sendTo(sender: string, contactId: string, text: string): Promise<RoomResponse> {
    const identity = await this.stores.identities.unlock(sender);
    const contact = await this.stores.contacts.get(sender, contactId);
    return this.sendSigned(identity, contact.mailbox, text);
  }

  async sendSignedToRoom(sender: string, room: string, text: string): Promise<RoomResponse> {
    const classes = roomClasses(room);
    if (classes.includes("p") || classes.includes("mb")) {
      throw new ProtocolError("room:send-signed requires a public non-mailbox room");
    }
    const identity = await this.stores.identities.unlock(sender);
    return this.sendSigned(identity, room, text);
  }

  private async sendSigned(identity: UnlockedIdentity, room: string, text: string): Promise<RoomResponse> {
    const nonce = await this.stores.nonces.reserve(identity.did, room);
    const signed = signMessage(identity, room, nonce, text);
    return this.transport.sendSignedMessage(room, {
      did: signed.did,
      sig: signed.signature,
      nonce: signed.nonce,
      text: signed.sanitizedText,
    });
  }

  async readInbox(owner: string): Promise<InboxMessage[]> {
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
    if (view.last_seq > since) {
      await this.stores.cursors.advance(owner, mailbox.room, view.last_seq);
    }
    return inbox;
  }
}
