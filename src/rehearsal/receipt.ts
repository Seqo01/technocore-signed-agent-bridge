import type { InboxPeekResult } from "../bridge.js";
import { BridgeError } from "../errors.js";
import type { ReceiveStage } from "../receive-diagnostics.js";
import { hashValue } from "../agent/util.js";

export interface ReceiptExpectation {
  step: number;
  expectedSeq: number;
  previousCursor: number;
  senderDid: string;
  receiverDid: string;
  payloadHash: string;
}

/** Strict single-message receipt policy shared by normal and explicitly authorized recovery. */
export function validateReceipt(peek: InboxPeekResult, expected: ReceiptExpectation,
  stage: (value: ReceiveStage) => void, normal: boolean): void {
  stage("message-selection");
  if (peek.messages.length !== 1) throw new BridgeError("Missing, duplicate or conflicting receipt; operator review required");
  const message = peek.messages[0]!;
  stage("sender-did-validation");
  if (!message.serverVerifiedDid || message.senderDid !== expected.senderDid) throw new BridgeError("Receipt sender mismatch");
  stage("frame-validation");
  const frame: unknown = JSON.parse(message.text);
  if (!frame || typeof frame !== "object" || !("from" in frame) || frame.from !== expected.senderDid ||
    !("to" in frame) || frame.to !== expected.receiverDid || !("version" in frame) || frame.version !== 1 ||
    !("rehearsal" in frame) || frame.rehearsal !== "first-room-read-v1" || !("step" in frame) || frame.step !== expected.step) {
    throw new BridgeError("Receipt frame mismatch");
  }
  stage("payload-validation");
  if (hashValue(message.text) !== expected.payloadHash) throw new BridgeError("Receipt payload mismatch");
  stage("sequence-validation");
  if (peek.previousCursor !== expected.previousCursor || message.seq !== expected.expectedSeq ||
    peek.lastSeq !== message.seq || peek.firstSeq === null || peek.firstSeq > message.seq ||
    (normal && message.seq !== peek.previousCursor + 1)) throw new BridgeError("Receipt sequence mismatch");
}
