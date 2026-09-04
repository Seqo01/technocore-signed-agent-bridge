import { BridgeError } from "../errors.js";
import { hashValue } from "../agent/util.js";
import { didToPublicKeyBytes, sanitizeText } from "../protocol.js";
import { validateWorkRequest } from "./router.js";
import { schemaId } from "./session-policy.js";
import { assertNoSecretLikeOutput } from "../workloads/types.js";

export interface WorkProposal {
  version: 1; kind: "peer-work"; proposalId: string; requesterDid: string; recipientDid: string;
  workloadType: string; workloadVersion: 1; objective: string; input: Record<string, unknown>; inputHash: string;
  evidenceRefs: string[]; requestedOutputSchema: string; jobId?: string; parentTaskId?: string; delegationId?: string;
  replyTo: string; createdAt: string; expiresAt?: string; provenanceClaims: Record<string, unknown>;
}
export function assertId(id: string): void {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_:-]{1,128}$/u.test(id)) throw new BridgeError("Invalid peer record id");
}
export function safePeerText(value: unknown, maxBytes: number): string {
  const text = JSON.stringify(value);
  if (typeof text !== "string" || Buffer.byteLength(text) > maxBytes || sanitizeText(text) !== text) throw new BridgeError("Peer payload exceeds canonical bounds");
  assertNoSecretLikeOutput(text, "Peer payload");
  return text;
}
export function validateProposal(value: unknown, maxBytes = 4096, now = Date.now()): WorkProposal {
  safePeerText(value, maxBytes);
  const p = value as WorkProposal;
  const allowed = ["version", "kind", "proposalId", "requesterDid", "recipientDid", "workloadType", "workloadVersion", "objective", "input", "inputHash", "evidenceRefs", "requestedOutputSchema", "jobId", "parentTaskId", "delegationId", "replyTo", "createdAt", "expiresAt", "provenanceClaims"];
  if (!p || p.version !== 1 || p.kind !== "peer-work" || Object.keys(p).some(k => !allowed.includes(k)) || p.workloadVersion !== 1 ||
    typeof p.objective !== "string" || !p.objective.trim() || p.objective.length > 512 || !Array.isArray(p.evidenceRefs) || p.evidenceRefs.length > 16 ||
    p.evidenceRefs.some(h => !/^[a-f0-9]{64}$/u.test(h)) || !p.provenanceClaims || typeof p.provenanceClaims !== "object" || Array.isArray(p.provenanceClaims)) throw new BridgeError("Invalid proposal schema");
  assertId(p.proposalId);
  for (const id of [p.jobId, p.parentTaskId, p.delegationId]) if (id !== undefined) assertId(id);
  didToPublicKeyBytes(p.requesterDid); didToPublicKeyBytes(p.recipientDid); didToPublicKeyBytes(p.replyTo);
  if (!Number.isFinite(Date.parse(p.createdAt)) || Date.parse(p.createdAt) > now + 60000 ||
    (p.expiresAt !== undefined && (!Number.isFinite(Date.parse(p.expiresAt)) || Date.parse(p.expiresAt) <= now || Date.parse(p.expiresAt) < Date.parse(p.createdAt)))) throw new BridgeError("Proposal expired or timestamp invalid");
  const input = validateWorkRequest(p.workloadType, p.input);
  if (p.inputHash !== hashValue(p.input) || hashValue(input) !== hashValue(p.input) || p.requestedOutputSchema !== schemaId(p.workloadType, "output")) throw new BridgeError("Proposal input/schema binding mismatch");
  return structuredClone(p);
}
