export interface StoredIdentity {
  version: 1;
  name: string;
  did: string;
  fingerprint: string;
  publicKeyPem: string;
  privateKeyPem: string;
  createdAt: string;
}

export interface PublicIdentity {
  name: string;
  did: string;
  fingerprint: string;
  createdAt: string;
}

export interface StoredMailbox {
  version: 1;
  owner: string;
  did: string;
  room: string;
  createdAt: string;
}

export interface Contact {
  contactId: string;
  did: string;
  mailbox: string;
  lastSeenSeq: number;
  addedAt: string;
}

export interface RoomMessage {
  seq: number;
  ts: string;
  from: string;
  text: string;
  nonce?: number | string;
}

export interface RoomResponse {
  room?: string;
  count: number;
  first_seq: number | null;
  last_seq: number;
  messages: RoomMessage[];
  posted?: RoomMessage;
}

export interface SignedMessageEnvelope {
  did: string;
  sig: string;
  nonce: string;
  text: string;
}

export interface SignedMessage {
  did: string;
  signature: string;
  nonce: string;
  sanitizedText: string;
  canonicalPayload: string;
}

export interface InboxMessage {
  seq: number;
  ts: string;
  senderDid: string;
  contactId?: string;
  text: string;
  nonce?: number | string;
  serverVerifiedDid: boolean;
  trust: "untrusted-external-data";
}

export interface ReadRoomOptions {
  since?: number;
  wait?: number;
  limit?: number;
}

export interface TechnocoreTransport {
  readRoomText(room: string, options?: ReadRoomOptions): Promise<string>;
  readRoomJson(room: string, options?: ReadRoomOptions): Promise<RoomResponse>;
  sendSignedMessage(
    room: string,
    envelope: SignedMessageEnvelope,
  ): Promise<RoomResponse>;
}
