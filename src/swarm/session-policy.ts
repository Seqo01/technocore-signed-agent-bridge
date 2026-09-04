import { BridgeError } from "../errors.js";
import { didToPublicKeyBytes } from "../protocol.js";
import { hashValue } from "../agent/util.js";
import { ROLE_WORKLOADS, type AgentRole } from "../agent/roles.js";
import { assertLocalAlias } from "../names.js";

export const PEER_ROLES = { alice: "coordinator", bob: "researcher", charlie: "engineer", dave: "reviewer", eve: "specialist" } as const;
export type PeerAlias = keyof typeof PEER_ROLES;
export type ProviderMode = "offline" | "configured";
export const peerAliases = Object.keys(PEER_ROLES) as PeerAlias[];
export interface PeerMember { alias: PeerAlias; did: string; role: AgentRole; mayDelegate: boolean }
export interface PeerPair { sourceDid: string; targetDid: string; contactId: string; destinationHash: string; workloads: string[] }
export interface SessionLimits {
  tasks: number; outbound: number; gets: number; inference: number; payloadBytes: number;
  depth: number; concurrency: number; inferenceTimeoutMs: number;
}
export interface SessionPolicy {
  version: 1; sessionId: string; mode: ProviderMode; members: PeerMember[]; pairs: PeerPair[];
  schemas: ["peer-work/v1", "peer-result/v1"]; workloads: { type: string; version: 1 }[];
  limits: SessionLimits; expiresAt: string;
  intake?: { aliases: PeerAlias[]; intervalMs: number; maxRounds: number };
  network: { origin: "offline" | "https://technocore.chat"; pathClass: "signed-mailbox-only"; postRetries: 0 };
}
export interface RootProvenance {
  requesterDid: string; origin: "internal" | "external"; trust: "operator-local" | "external-approved";
  originalProposalId: string; operatorScope?: { approvalHash: string; workloads: string[]; pairs: string[]; maxTasks: number };
}
export interface Capability {
  version: 1; alias: PeerAlias; did: string; role: AgentRole; mayDelegate: boolean;
  workloads: { type: string; version: 1; inputSchema: string; outputSchema: string }[];
  limits: SessionLimits; providerMode: ProviderMode; availability: "starting" | "available" | "stopped";
}
export function schemaId(type: string, direction: "input" | "output"): string { return `${type}/${direction}/v1`; }
export function pairId(source: string, target: string): string { return hashValue({ source, target }); }
export function assertSessionId(id: string): void {
  if (!/^[a-zA-Z0-9_-]{1,64}$/u.test(id)) throw new BridgeError("Invalid session id");
}
function immutable<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(immutable); Object.freeze(value); }
  return value;
}
export class CapabilityRegistry {
  private readonly records: Capability[];
  constructor(policy: SessionPolicy) {
    this.records = policy.members.map(member => ({ version: 1, ...member,
      workloads: ROLE_WORKLOADS[member.role].filter(type => type !== "workload.collaboration").map(type => ({
        type, version: 1, inputSchema: schemaId(type, "input"), outputSchema: schemaId(type, "output") })),
      limits: structuredClone(policy.limits), providerMode: policy.mode, availability: "starting" }));
  }
  get(alias: string): Capability {
    const record = this.records.find(item => item.alias === alias);
    if (!record) throw new BridgeError("Unknown local peer");
    return structuredClone(record);
  }
  supports(did: string, type: string, version: number): boolean {
    return this.records.some(item => item.did === did && item.workloads.some(work => work.type === type && work.version === version));
  }
  availability(value: Capability["availability"]): void { for (const record of this.records) record.availability = value; }
}
/** Local reviewed authority, not a protocol/discovery assertion and never inference output. */
export class SessionAuthority {
  readonly policy: SessionPolicy;
  readonly hash: string;
  readonly capabilities: CapabilityRegistry;
  constructor(input: SessionPolicy, reviewedHash: string, private readonly now: () => number = Date.now) {
    this.policy = immutable(structuredClone(input));
    this.hash = hashValue(this.policy);
    if (this.hash !== reviewedHash) throw new BridgeError("Reviewed session policy hash mismatch");
    const p = this.policy;
    assertSessionId(p.sessionId);
    if (p.version !== 1 || !["offline", "configured"].includes(p.mode) || p.members.length !== 5 ||
      new Set(p.members.map(m => m.did)).size !== 5 || new Set(p.members.map(m => m.alias)).size !== 5 ||
      JSON.stringify(p.schemas) !== JSON.stringify(["peer-work/v1", "peer-result/v1"]) ||
      p.network.pathClass !== "signed-mailbox-only" || p.network.postRetries !== 0 ||
      p.network.origin !== (p.mode === "offline" ? "offline" : "https://technocore.chat")) throw new BridgeError("Invalid session policy");
    for (const m of p.members) {
      assertLocalAlias(m.alias); didToPublicKeyBytes(m.did);
      if (PEER_ROLES[m.alias] !== m.role || typeof m.mayDelegate !== "boolean") throw new BridgeError("Peer role binding mismatch");
    }
    const bounds: SessionLimits = { tasks: 1000, outbound: 1000, gets: 1000, inference: 1000, payloadBytes: 4096, depth: 32, concurrency: 5, inferenceTimeoutMs: 60000 };
    if (Object.keys(p.limits).length !== Object.keys(bounds).length) throw new BridgeError("Invalid budget schema");
    for (const key of Object.keys(bounds) as (keyof SessionLimits)[]) {
      if (!Number.isSafeInteger(p.limits[key]) || p.limits[key] < 1 || p.limits[key] > bounds[key]) throw new BridgeError("Invalid session budget");
    }
    if (p.intake && (!Array.isArray(p.intake.aliases) || p.intake.aliases.length > 5 || new Set(p.intake.aliases).size !== p.intake.aliases.length ||
      p.intake.aliases.some(alias => !peerAliases.includes(alias)) || !Number.isSafeInteger(p.intake.intervalMs) || p.intake.intervalMs < 1000 || p.intake.intervalMs > 60000 ||
      !Number.isSafeInteger(p.intake.maxRounds) || p.intake.maxRounds < 1 || p.intake.maxRounds > 100)) throw new BridgeError("Invalid bounded intake schedule");
    if (!Number.isFinite(Date.parse(p.expiresAt)) || Date.parse(p.expiresAt) > now() + 24 * 60 * 60 * 1000) throw new BridgeError("Invalid bounded session expiration");
    this.capabilities = new CapabilityRegistry(p);
    for (const w of p.workloads) if (w.version !== 1 || !p.members.some(m => this.capabilities.supports(m.did, w.type, w.version))) throw new BridgeError("Unsupported policy workload");
    const pairs = new Set<string>();
    for (const pair of p.pairs) {
      const key = pairId(pair.sourceDid, pair.targetDid);
      assertLocalAlias(pair.contactId);
      if (pairs.has(key) || pair.sourceDid === pair.targetDid || !p.members.some(m => m.did === pair.sourceDid) ||
        !p.members.some(m => m.did === pair.targetDid) || !/^[a-f0-9]{64}$/u.test(pair.destinationHash) ||
        pair.workloads.length === 0 || pair.workloads.some(type => !p.workloads.some(w => w.type === type))) throw new BridgeError("Invalid directional pair policy");
      pairs.add(key);
    }
    this.checkTime();
  }
  checkTime(): void { if (this.now() >= Date.parse(this.policy.expiresAt)) throw new BridgeError("Session authority expired"); }
  member(alias: string): PeerMember {
    const member = this.policy.members.find(m => m.alias === alias);
    if (!member) throw new BridgeError("Peer is not a session member");
    return member;
  }
  workload(target: string, type: string): void {
    this.checkTime();
    if (!this.policy.workloads.some(w => w.type === type && w.version === 1) || !this.capabilities.supports(target, type, 1)) throw new BridgeError("Workload/capability not authorized");
  }
  pair(source: string, target: string, type: string, root: RootProvenance): PeerPair {
    this.checkTime();
    const pair = this.policy.pairs.find(p => p.sourceDid === source && p.targetDid === target && p.workloads.includes(type));
    if (!pair) throw new BridgeError("Directional peer effect not authorized");
    if (root.origin === "external" && (!root.operatorScope || !root.operatorScope.workloads.includes(type) ||
      !root.operatorScope.pairs.includes(pairId(source, target)))) throw new BridgeError("External root scope cannot be widened");
    return pair;
  }
  delegate(source: string, target: string, type: string, depth: number, root: RootProvenance): void {
    if (!this.policy.members.some(m => m.did === source && m.mayDelegate) || depth > this.policy.limits.depth) throw new BridgeError("Delegation capability/depth denied");
    this.workload(target, type); this.pair(source, target, type, root);
  }
}
