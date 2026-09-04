import { resolve } from "node:path";
import { atomicWriteJson, readJsonFile } from "../fs-safe.js";
import { BridgeError } from "../errors.js";
import { hashValue } from "../agent/util.js";
import type { TaskEvidence } from "../agent/evidence.js";
import type { OutboundDiagnostics } from "../send-diagnostics.js";
import type { WorkProposal } from "./proposal.js";
import { assertId } from "./proposal.js";
import { assertSessionId, type PeerAlias, type RootProvenance, type SessionPolicy } from "./session-policy.js";

export interface PeerTask {
  id: string; jobId: string; alias: PeerAlias; workload: string; input: Record<string, unknown>; inputHash: string;
  dependencies: string[]; depth: number; parentId?: string; runtimeTaskId?: string; delegationId?: string;
  authorityChain: string[]; rootHash: string; createdAt: string;
  compute: "planned" | "accepted" | "running" | "result-ready" | "failed" | "ambiguous";
  delivery: "local" | "planned" | "send-prepared" | "sending" | "sent" | "received" | "needs-operator";
  evidence?: TaskEvidence;
}
export interface PeerJob { id: string; root: RootProvenance; rootHash: string; tasks: string[]; status: "accepted" | "running" | "completed" | "needs-operator" }
export interface PeerEffect {
  id: string; taskId: string; source: PeerAlias; target: PeerAlias; kind: "proposal" | "result";
  actionId: string; payloadHash: string; destinationHash: string; authorityId: string;
  text: string; createdAt: string; status: "send-prepared" | "sending" | "sent" | "receiving" | "received" | "failed" | "ambiguous";
  nonce?: string; seq?: number; diagnostics?: OutboundDiagnostics;
}
export interface ProposalRecord {
  id: string; hash: string; proposal?: WorkProposal; trust: "internal" | "external" | "unverified";
  status: "accepted" | "needs-operator" | "rejected"; jobId?: string; legacyId?: string;
  replyContact?: { contactId: string; destinationHash: string };
}
export interface PeerSession {
  version: 1; sessionId: string; policyHash: string; policy: SessionPolicy; pid: number;
  lifecycle: "starting" | "active" | "stopping" | "stopped" | "halted"; reason?: string;
  createdAt: string; updatedAt: string;
  budgets: { tasks: number; outbound: number; gets: number; inference: number };
  jobs: Record<string, PeerJob>; tasks: Record<string, PeerTask>; effects: Record<string, PeerEffect>;
  proposals: Record<string, ProposalRecord>; receipts: Record<string, { alias: PeerAlias; firstSeq: number | null; lastSeq: number; previousCursor: number; messageHashes: string[]; status: "persisted" | "acked" }>;
  intake: Partial<Record<PeerAlias, { rounds: number; nextAt: number }>>;
  recovery: Record<string, { effectId: string; observation: "observed" | "not-observed" | "incomplete"; decision: "needs-operator"; seq?: number }>;
}
export function sessionDirectory(root: string, id: string): string { assertSessionId(id); return resolve(root, "swarm", "sessions", id); }
export class SessionStateStore {
  private expectedHash: string | undefined;
  constructor(readonly directory: string, readonly value: PeerSession) {}
  async save(): Promise<void> {
    const path = resolve(this.directory, "session.json");
    const current = await readJsonFile<PeerSession | null>(path, null);
    if ((current ? hashValue(current) : undefined) !== this.expectedHash) throw new BridgeError("Session checkpoint changed outside its owner");
    this.value.updatedAt = new Date().toISOString();
    await atomicWriteJson(path, this.value); this.expectedHash = hashValue(this.value);
  }
  static async read(root: string, id: string): Promise<PeerSession> {
    const value = await readJsonFile<PeerSession | null>(resolve(sessionDirectory(root, id), "session.json"), null);
    if (!value || value.version !== 1 || value.sessionId !== id || value.policyHash !== hashValue(value.policy)) throw new BridgeError("Invalid/missing session checkpoint");
    return value;
  }
}
export function validateDag(tasks: Record<string, Pick<PeerTask, "id" | "dependencies">>): void {
  const visiting = new Set<string>(), visited = new Set<string>();
  function visit(id: string): void {
    assertId(id);
    if (visiting.has(id)) throw new BridgeError("Task dependency cycle rejected");
    if (visited.has(id)) return;
    const task = tasks[id];
    if (!task || task.id !== id || new Set(task.dependencies).size !== task.dependencies.length) throw new BridgeError("Invalid task dependency");
    visiting.add(id); task.dependencies.forEach(visit); visiting.delete(id); visited.add(id);
  }
  Object.keys(tasks).forEach(visit);
}
/** Pure classification only: never restarts a runtime, grants authority, retries, or changes cursors. */
export function classifyInterruptedSession(value: PeerSession): PeerSession {
  const copy = structuredClone(value);
  if (!["stopped", "halted"].includes(copy.lifecycle)) {
    copy.lifecycle = "halted"; copy.reason = "interrupted-session-needs-operator";
    for (const effect of Object.values(copy.effects)) if (["sending", "receiving"].includes(effect.status)) effect.status = "ambiguous";
    for (const task of Object.values(copy.tasks)) if (task.compute === "running") task.compute = "ambiguous";
  }
  return copy;
}
