import { BridgeError } from "../errors.js";
import { hashValue } from "../agent/util.js";
import type { RoomResponse } from "../types.js";
import type { PeerEffect } from "./session-state.js";

/** Validate a bounded complete window before trusting any sequence or acknowledging it. */
export function validatePeerWindow(view: RoomResponse, since: number): void {
  if (!Number.isSafeInteger(view.last_seq) || view.last_seq < since || view.count !== view.messages.length || view.count > 200 ||
    (view.first_seq !== null && (!Number.isSafeInteger(view.first_seq) || view.first_seq < 1 || view.first_seq > since + 1))) throw new BridgeError("Sequence/retention ambiguity; cursor unchanged");
  let previous = since;
  for (const m of view.messages) {
    if (!Number.isSafeInteger(m.seq) || m.seq !== previous + 1 || m.seq > view.last_seq || typeof m.text !== "string" ||
      Buffer.byteLength(m.text) > 4096 || typeof m.from !== "string" || typeof m.ts !== "string") throw new BridgeError("Invalid, duplicate, or incomplete mailbox window");
    previous = m.seq;
  }
  if (previous !== view.last_seq) throw new BridgeError("Mailbox window incomplete; no backlog crawl");
  if ((view.count > 0 && view.first_seq === null) || (view.last_seq === 0 && view.first_seq !== null)) throw new BridgeError("Invalid first sequence metadata");
}
export function classifyEffectObservation(effect: PeerEffect, senderDid: string, view: RoomResponse): {
  effectId: string; observation: "observed" | "not-observed" | "incomplete"; decision: "needs-operator"; seq?: number;
} {
  try { validatePeerWindow(view, 0); } catch { return { effectId: effect.id, observation: "incomplete", decision: "needs-operator" }; }
  const matches = view.messages.filter(m => m.from === senderDid && m.nonce !== undefined && effect.nonce !== undefined &&
    String(m.nonce) === effect.nonce && hashValue(m.text) === effect.payloadHash);
  if (matches.length > 1) return { effectId: effect.id, observation: "incomplete", decision: "needs-operator" };
  return { effectId: effect.id, observation: matches.length === 1 ? "observed" : "not-observed", decision: "needs-operator",
    ...(matches.length === 1 ? { seq: matches[0]!.seq } : {}) };
}
