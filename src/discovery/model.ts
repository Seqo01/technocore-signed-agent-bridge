import { createHash } from "node:crypto";
import { BridgeError } from "../errors.js";
import { roomClasses, TECHNOCORE_NAME_PATTERN } from "../names.js";
import { didToPublicKeyBytes } from "../protocol.js";
import type { Capability } from "../swarm/session-policy.js";

export const DISCOVERY_ORIGIN = "https://technocore.chat";
export const SOURCE_REVISION = "82d942936050f1ab0fb9f34db17893b89f3e064b";
export const TRUST = "untrusted-discovery-only" as const;
export const defaults = Object.freeze({ responseBytes: 262144, rooms: 50, events: 50,
  candidates: 1000, observations: 10000, didLookups: 1, metadataBytes: 32768,
  stringLength: 256, timeoutMs: 10000, requests: 2, stateBytes: 8388608 });
export type Limits = { readonly [K in keyof typeof defaults]: number };
export function limits(input: Partial<Limits> = {}): Limits {
  const result = { ...defaults, ...input };
  for (const [key, value] of Object.entries(result)) {
    if (!Object.hasOwn(defaults, key) || !Number.isSafeInteger(value) || value < 1 ||
      value > defaults[key as keyof Limits]) throw new BridgeError("Invalid discovery limit");
  }
  return Object.freeze(result);
}
export function digest(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
export function isDid(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  try { didToPublicKeyBytes(value); return true; } catch { return false; }
}
export function publicRoom(value: unknown): value is string {
  return typeof value === "string" && TECHNOCORE_NAME_PATTERN.test(value) &&
    !/(?:^|-)p(?:-|$)/u.test(value) && !roomClasses(value).some(c => c === "p" || c === "mb" || c === "e");
}
export function didPaths(did: string): { current: string; legacy: string } {
  if (!isDid(did)) throw new BridgeError("Invalid discovery DID");
  const key = digest(did).slice(0, 16);
  return { current: `/kv/did-${key.slice(0, 2)}/${key.slice(2)}`, legacy: `/kv/did/${key}` };
}
export const claimVocabulary = ["research", "researcher", "review", "reviewer", "engineering", "engineer",
  "coordination", "coordinator", "synthesis", "specialist", "edge-cases", "workload.research",
  "workload.review", "workload.engineering", "workload.coordination", "workload.synthesis", "workload.specialist"] as const;
export type Claim = typeof claimVocabulary[number];
export function isClaim(value: unknown): value is Claim {
  return typeof value === "string" && (claimVocabulary as readonly string[]).includes(value);
}
// Omit entire risky strings instead of partially displaying credentials/URLs. No raw message/note is retained.
export function safeTopic(value: unknown, maxLength: number = defaults.stringLength): string {
  if (typeof value !== "string") return "";
  if (value.length > maxLength || /[\p{C}\p{Zl}\p{Zp}]/u.test(value) ||
    /(?:\b(?:mb-|d-|e-)*p-|\b(?:mb|e)-|:\/\/|www\.|%[a-f0-9]{2}|[a-z0-9_-]{40,}|private.?key|encrypted|passphrase|password|secret|token|authorization|bearer|signature|\bsig\b|\bauth\b|\bkey\b|\b\d{1,3}(?:\.\d{1,3}){3}\b|[a-f0-9]{1,4}:[a-f0-9:]{2,})/iu.test(value)) return "[OMITTED_UNTRUSTED_TEXT]";
  return value;
}
export type EndpointClass = "rooms" | "events" | "public-room" | "did-current" | "did-legacy";
export type SignatureState = "absent" | "verified" | "invalid" | "unverifiable";
export type Provenance = "server-observed" | "signed-message-verified" | "unsigned-self-claim" | "third-party-claim" | "malformed" | "unknown";
export type Warning = "topic-untrusted" | "content-omitted" | "unrecognized-claims" | "note-not-owner-authenticated" |
  "did-mismatch" | "signature-invalid" | "canonical-data-unavailable" | "unsigned-record" |
  "retention-gap" | "epoch-unknown" | "unexpected-event" | "malformed-record" | "not-found";
export interface Observation {
  observationId: string; candidateId?: string; claimedDid?: string;
  endpointClass: EndpointClass; sourceOrigin: typeof DISCOVERY_ORIGIN; sourceRef: string;
  sourceHash: string; contentHash: string; metadataHash?: string; metadataVersion: 1;
  firstSeenAt: string; lastSeenAt: string; sightings: number;
  room?: string; topic?: string; seq?: number; serverTimestamp?: string; generation?: number;
  signatureState: SignatureState; signatureHash?: string;
  verificationState: "local-signature-valid" | "server-reported-did" | "unverified";
  provenanceClassification: Provenance; trustClassification: typeof TRUST;
  claims: Claim[]; warnings: Warning[];
}
export type NewObservation = Omit<Observation, "observationId" | "firstSeenAt" | "lastSeenAt" | "sightings">;
export interface Candidate {
  candidateId: string; claimedDid: string; sourceTypes: EndpointClass[]; sourceRefs: string[]; sourceHashes: string[];
  firstSeenAt: string; lastSeenAt: string; observationCount: number; sightingCount: number; uniqueSourceCount: number;
  rooms: string[]; claimedCapabilities: Claim[]; metadataHashes: string[]; metadataVersion: 1;
  signatureStates: SignatureState[]; verificationStates: Observation["verificationState"][];
  provenanceClassifications: Provenance[]; trustClassification: typeof TRUST; warnings: Warning[];
  annotations: string[];
}
export function candidateId(did: string): string { return digest(did); }
export function unique<T>(values: T[]): T[] { return [...new Set(values)]; }
export function candidates(observations: Observation[]): Candidate[] {
  const grouped = new Map<string, Observation[]>();
  for (const o of observations) if (o.candidateId && o.claimedDid) {
    const group = grouped.get(o.candidateId) ?? []; group.push(o); grouped.set(o.candidateId, group);
  }
  return [...grouped].map(([id, group]) => {
    const refs = unique(group.map(o => o.sourceRef));
    return { candidateId: id, claimedDid: group[0]!.claimedDid!, sourceTypes: unique(group.map(o => o.endpointClass)),
      sourceRefs: refs, sourceHashes: unique(group.map(o => o.sourceHash)), firstSeenAt: group.map(o => o.firstSeenAt).sort()[0]!,
      lastSeenAt: group.map(o => o.lastSeenAt).sort().at(-1)!, observationCount: group.length,
      sightingCount: group.reduce((n, o) => n + o.sightings, 0), uniqueSourceCount: refs.length,
      rooms: unique(group.flatMap(o => o.room ? [o.room] : [])), claimedCapabilities: unique(group.flatMap(o => o.claims)),
      metadataHashes: unique(group.flatMap(o => o.metadataHash ? [o.metadataHash] : [])), metadataVersion: 1 as const,
      signatureStates: unique(group.map(o => o.signatureState)), verificationStates: unique(group.map(o => o.verificationState)),
      provenanceClassifications: unique(group.map(o => o.provenanceClassification)), trustClassification: TRUST,
      warnings: unique(group.flatMap(o => o.warnings)), annotations: ["Discovery only; no authority or reputation score",
        "Distinct sources are not proof of independent operators", "Verified messages do not authenticate unrelated note claims"] };
  });
}
/** Exact local vocabulary overlap only; not a global role taxonomy or authority decision. */
export function compareCapabilities(candidate: Candidate, local: readonly Pick<Capability, "alias" | "role" | "workloads">[]) {
  const aliases: Record<string, string> = { researcher: "research", reviewer: "review", engineer: "engineering",
    coordinator: "coordination", "edge-cases": "specialist" };
  const claims = candidate.claimedCapabilities.map(c => c.replace(/^workload\./u, "")).map(c => aliases[c] ?? c);
  return local.flatMap(c => {
    const overlap = c.workloads.map(w => w.type).filter(w => claims.includes(w.replace(/^workload\./u, "")));
    return overlap.length ? [{ alias: c.alias, role: c.role, overlap, advisoryOnly: true as const, authority: false as const }] : [];
  });
}
