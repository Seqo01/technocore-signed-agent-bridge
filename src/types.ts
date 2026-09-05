import type { KeyObject } from "node:crypto";

export interface StoredIdentityV1 {
  version: 1;
  name: string;
  did: string;
  fingerprint: string;
  publicKeyPem: string;
  privateKeyPem: string;
  createdAt: string;
}

export interface ScryptKdfParameters {
  name: "scrypt";
  salt: string;
  N: number;
  r: number;
  p: number;
  keyLength: 32;
}

export interface AesGcmParameters {
  name: "aes-256-gcm";
  iv: string;
  tagLength: 16;
  tag: string;
}

export interface EncryptedPrivateKey {
  format: "pkcs8-der";
  encoding: "base64url";
  kdf: ScryptKdfParameters;
  cipher: AesGcmParameters;
  aadVersion: 1;
  ciphertext: string;
}

export interface StoredIdentityV2 {
  version: 2;
  name: string;
  did: string;
  fingerprint: string;
  publicKeyPem: string;
  createdAt: string;
  encryptedAt: string;
  encryptedPrivateKey: EncryptedPrivateKey;
}

export type StoredIdentity = StoredIdentityV1 | StoredIdentityV2;

export interface PublicIdentity {
  name: string;
  did: string;
  fingerprint: string;
  createdAt: string;
}

export interface UnlockedIdentity extends PublicIdentity {
  publicKeyPem: string;
  privateKey: KeyObject;
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
  sig?: string;
}

export interface RoomResponse {
  room?: string;
  count: number;
  first_seq: number | null;
  last_seq: number;
  generation?: number;
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
  /** Internal intake material. Normal inbox output must omit it. */
  signature?: string;
  serverVerifiedDid: boolean;
  trust: "untrusted-external-data";
}

export type PublicInboxMessage = Omit<InboxMessage, "signature">;

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
