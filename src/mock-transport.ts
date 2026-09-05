import { ProtocolError, TransportError } from "./errors.js";
import { assertTechnocoreName } from "./names.js";
import { sanitizeText, verifySignedMessage } from "./protocol.js";
import type { ReadRoomOptions, RoomMessage, RoomResponse, SignedMessageEnvelope, TechnocoreTransport } from "./types.js";

export class InMemoryTechnocoreTransport implements TechnocoreTransport {
  private readonly rooms = new Map<string, RoomMessage[]>();
  private readonly nonces = new Map<string, bigint>();
  private clock = 0;

  async readRoomText(room: string, options: ReadRoomOptions = {}): Promise<string> {
    const view = await this.readRoomJson(room, options);
    return view.messages.map((message) => `${message.seq} ${message.ts} <${message.from}> ${message.text}`).join("\n");
  }

  async readRoomJson(room: string, options: ReadRoomOptions = {}): Promise<RoomResponse> {
    assertTechnocoreName(room, "room");
    const since = options.since ?? 0;
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
    const available = (this.rooms.get(room) ?? []).filter((message) => message.seq > since);
    const messages = available.slice(-limit).map((message) => ({ ...message }));
    return {
      room,
      count: messages.length,
      first_seq: messages[0]?.seq ?? null,
      last_seq: messages.at(-1)?.seq ?? since,
      messages,
    };
  }

  async sendSignedMessage(room: string, envelope: SignedMessageEnvelope): Promise<RoomResponse> {
    assertTechnocoreName(room, "room");
    const sanitizedText = sanitizeText(envelope.text);
    if (sanitizedText !== envelope.text) {
      throw new ProtocolError("Mock received text that was not sanitized before signing");
    }
    if (!verifySignedMessage(room, {
      did: envelope.did,
      signature: envelope.sig,
      nonce: envelope.nonce,
      sanitizedText,
    })) {
      throw new TransportError("Mock rejected invalid signed message", 403);
    }
    const key = `${envelope.did}|${room}`;
    const nonce = BigInt(envelope.nonce);
    const previous = this.nonces.get(key);
    if (previous !== undefined && nonce <= previous) {
      throw new TransportError("Mock rejected replayed nonce", 409);
    }
    this.nonces.set(key, nonce);
    const messages = this.rooms.get(room) ?? [];
    const posted: RoomMessage = {
      seq: messages.length + 1,
      ts: new Date(Date.UTC(2026, 0, 1, 0, 0, this.clock++)).toISOString().replace(".000", ""),
      from: envelope.did,
      text: sanitizedText,
      nonce: Number(nonce),
      sig: envelope.sig,
    };
    messages.push(posted);
    this.rooms.set(room, messages);
    const view = await this.readRoomJson(room, { limit: 20 });
    return { ...view, posted: { ...posted } };
  }
}
