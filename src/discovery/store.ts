import { lstat, open } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { BridgeError } from "../errors.js";
import { atomicWriteJson, withFileLock } from "../fs-safe.js";
import { candidateId, candidates, digest, DISCOVERY_ORIGIN, isClaim, isDid, limits, publicRoom, safeTopic,
  TRUST, unique, type Limits, type NewObservation, type Observation } from "./model.js";

interface DiscoveryState { format: "technocore-public-discovery"; version: 1; observations: Observation[] }
const empty = (): DiscoveryState => ({ format: "technocore-public-discovery", version: 1, observations: [] });
const hash = (s: unknown): s is string => typeof s === "string" && /^[a-f0-9]{64}$/u.test(s);
const timestamp = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3,6}Z$/u.test(s) && Number.isFinite(Date.parse(s));
const warnings = ["topic-untrusted", "content-omitted", "unrecognized-claims", "note-not-owner-authenticated", "did-mismatch",
  "signature-invalid", "canonical-data-unavailable", "unsigned-record", "retention-gap", "epoch-unknown", "unexpected-event", "malformed-record", "not-found"];
const keys = new Set(["observationId", "candidateId", "claimedDid", "endpointClass", "sourceOrigin", "sourceRef", "sourceHash",
  "contentHash", "metadataHash", "metadataVersion", "firstSeenAt", "lastSeenAt", "sightings", "room", "topic", "seq",
  "serverTimestamp", "generation", "signatureState", "signatureHash", "verificationState", "provenanceClassification", "trustClassification", "claims", "warnings"]);
function id(o: NewObservation): string {
  return digest(JSON.stringify([o.candidateId ?? null, o.endpointClass, o.sourceOrigin, o.sourceRef,
    o.seq ?? null, o.generation ?? null, o.contentHash]));
}
function validate(o: Observation, bounds: Limits): void {
  if (!o || typeof o !== "object" || Object.keys(o).some(k => !keys.has(k)) ||
    o.sourceOrigin !== DISCOVERY_ORIGIN || o.trustClassification !== TRUST || o.metadataVersion !== 1 ||
    !["rooms", "events", "public-room", "did-current", "did-legacy"].includes(o.endpointClass) ||
    !["absent", "verified", "invalid", "unverifiable"].includes(o.signatureState) ||
    !["local-signature-valid", "server-reported-did", "unverified"].includes(o.verificationState) ||
    !["server-observed", "signed-message-verified", "unsigned-self-claim", "third-party-claim", "malformed", "unknown"].includes(o.provenanceClassification) ||
    typeof o.sourceRef !== "string" || !(/^(?:\/rooms|\/r\/[a-z0-9][a-z0-9_-]{0,47}|\/kv\/(?:did-[a-f0-9]{2}\/[a-f0-9]{14}|did\/[a-f0-9]{16}))$/u.test(o.sourceRef)) ||
    (o.sourceRef.startsWith("/r/") && !publicRoom(o.sourceRef.slice(3))) ||
    !hash(o.sourceHash) || o.sourceHash !== digest(o.sourceOrigin + o.sourceRef) || !hash(o.contentHash) ||
    !hash(o.observationId) || o.observationId !== id(o) ||
    (o.metadataHash !== undefined && !hash(o.metadataHash)) || (o.signatureHash !== undefined && !hash(o.signatureHash)) ||
    !timestamp(o.firstSeenAt) || !timestamp(o.lastSeenAt) || o.lastSeenAt < o.firstSeenAt ||
    !Number.isSafeInteger(o.sightings) || o.sightings < 1 ||
    (o.claimedDid !== undefined && (!isDid(o.claimedDid) || o.candidateId !== candidateId(o.claimedDid))) ||
    (o.candidateId !== undefined && o.claimedDid === undefined) ||
    (o.room !== undefined && !publicRoom(o.room)) ||
    (o.topic !== undefined && (typeof o.topic !== "string" || safeTopic(o.topic, bounds.stringLength) !== o.topic)) ||
    (o.serverTimestamp !== undefined && !timestamp(o.serverTimestamp)) ||
    (o.seq !== undefined && (!Number.isSafeInteger(o.seq) || o.seq < 1)) ||
    (o.generation !== undefined && (!Number.isSafeInteger(o.generation) || o.generation < 0)) ||
    !Array.isArray(o.claims) || o.claims.length > 20 || !o.claims.every(isClaim) ||
    !Array.isArray(o.warnings) || o.warnings.length > 20 || !o.warnings.every(w => warnings.includes(w))) {
    throw new BridgeError("Invalid or unsafe discovery state");
  }
}

/** Only one dedicated snapshot is written; no operational store or runtime is reachable here. */
export class DiscoveryStore {
  private readonly file: string;
  private readonly bounds: Limits;
  constructor(workspace: string, bounds: Partial<Limits> = {}) {
    const base = resolve(workspace);
    if (base.split(/[\\/]/u).some(p => p.toLowerCase().replace(/[ .]+$/u, "") === ".technocore")) throw new BridgeError("Discovery cannot use operational state");
    this.file = join(base, ".technocore-discovery", "discovery.json");
    this.bounds = limits(bounds);
  }
  private async guard(): Promise<void> {
    // Refuse symlink/junction redirection into an operational directory. Same-user malicious races remain outside this boundary.
    let path = this.file;
    while (path !== parse(path).root) {
      try { if ((await lstat(path)).isSymbolicLink()) throw new BridgeError("Discovery state symlinks are forbidden"); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new BridgeError("Discovery state path refused"); }
      path = dirname(path);
    }
  }
  private async load(): Promise<DiscoveryState> {
    await this.guard();
    let handle;
    try {
      handle = await open(this.file, "r");
      // Bounded read even if the file grows after stat.
      const buffer = Buffer.alloc(this.bounds.stateBytes + 1);
      let bytes = 0;
      while (bytes < buffer.length) {
        const part = await handle.read(buffer, bytes, buffer.length - bytes, null);
        if (!part.bytesRead) break; bytes += part.bytesRead;
      }
      if (bytes > this.bounds.stateBytes) throw new Error("size");
      const state = JSON.parse(buffer.subarray(0, bytes).toString("utf8")) as DiscoveryState;
      if (state.format !== "technocore-public-discovery" || state.version !== 1 ||
        Object.keys(state).some(k => !["format", "version", "observations"].includes(k)) ||
        !Array.isArray(state.observations) || state.observations.length > this.bounds.observations) throw new Error("schema");
      state.observations.forEach(o => validate(o, this.bounds));
      if (new Set(state.observations.map(o => o.observationId)).size !== state.observations.length ||
        candidates(state.observations).length > this.bounds.candidates) throw new Error("limit");
      return state;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return empty();
      throw new BridgeError("Discovery state is unreadable or unsafe; no repair attempted");
    } finally { await handle?.close(); }
  }
  async append(batch: NewObservation[], observedAt: string): Promise<void> {
    if (!timestamp(observedAt) || batch.length > this.bounds.observations) throw new BridgeError("Invalid discovery batch");
    await this.guard();
    try {
      await withFileLock(this.file, async () => {
        const state = await this.load();
        for (const incoming of batch) {
          const o: Observation = { ...incoming, observationId: id(incoming), firstSeenAt: observedAt, lastSeenAt: observedAt, sightings: 1 };
          validate(o, this.bounds);
          const previous = state.observations.find(v => v.observationId === o.observationId);
          if (previous) {
            previous.firstSeenAt = [previous.firstSeenAt, observedAt].sort()[0]!;
            previous.lastSeenAt = [previous.lastSeenAt, observedAt].sort()[1]!;
            if (previous.sightings === Number.MAX_SAFE_INTEGER) throw new Error("counter");
            previous.sightings++; // Identical evidence is not a new version or a new peer.
          } else state.observations.push(o);
        }
        if (state.observations.length > this.bounds.observations || candidates(state.observations).length > this.bounds.candidates ||
          Buffer.byteLength(JSON.stringify(state, null, 2) + "\n") > this.bounds.stateBytes) throw new Error("limit");
        await atomicWriteJson(this.file, state);
      });
    } catch { throw new BridgeError("Discovery persistence refused; no evidence was evicted"); }
  }
  async observations(): Promise<Observation[]> { return (await this.load()).observations; }
  async listCandidates() { return candidates(await this.observations()); }
  async inspectCandidate(id: string) {
    if (!hash(id)) throw new BridgeError("Invalid discovery candidate id");
    const observations = await this.observations();
    const candidate = candidates(observations).find(c => c.candidateId === id);
    if (!candidate) throw new BridgeError("Discovery candidate not found");
    return { candidate, observations: observations.filter(o => o.candidateId === id) };
  }
  async summary() {
    const observations = await this.observations(); const peers = candidates(observations);
    return { uniqueCandidateDids: peers.length, totalObservations: observations.length,
      messageObservedDids: peers.filter(c => c.sourceTypes.includes("public-room")).length,
      lookupOnlyDids: peers.filter(c => !c.sourceTypes.includes("public-room")).length,
      sightings: observations.reduce((n, o) => n + o.sightings, 0),
      uniqueSources: new Set(observations.map(o => o.sourceRef)).size, sourceTypes: unique(observations.map(o => o.endpointClass)),
      locallyVerifiedCandidates: peers.filter(c => c.signatureStates.includes("verified")).length,
      candidatesWithoutLocalVerification: peers.filter(c => !c.signatureStates.includes("verified")).length,
      unsignedCandidates: peers.filter(c => c.signatureStates.includes("absent")).length,
      capabilityClaimCategories: unique(peers.flatMap(c => c.claimedCapabilities)),
      firstSeenAt: observations.map(o => o.firstSeenAt).sort()[0] ?? null,
      lastSeenAt: observations.map(o => o.lastSeenAt).sort().at(-1) ?? null,
      authority: false, reputationScore: null, completeDirectory: false };
  }
}
