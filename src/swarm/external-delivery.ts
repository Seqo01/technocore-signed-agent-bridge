import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createStores } from "../context.js";
import { SignedAgentBridge } from "../bridge.js";
import { BridgeError, AmbiguousSendError } from "../errors.js";
import { atomicWriteJson, readJsonFile } from "../fs-safe.js";
import { ActionApprovalStore, type ExactActionEffect } from "../agent/approvals.js";
import { AgentRuntimeLock } from "../agent/runtime-lock.js";
import { AgentStateStore } from "../agent/state-store.js";
import { ActivityJournal } from "../agent/journal.js";
import { LocalMemoryProvider } from "../agent/memory.js";
import { agentPaths } from "../agent/paths.js";
import { readCompletedTaskEvidence } from "../agent/evidence.js";
import { InferenceLedger } from "../agent/inference-accounting.js";
import { hashValue } from "../agent/util.js";
import { HttpTechnocoreTransport } from "../transport.js";
import { SignedPostRejectedError } from "../send-diagnostics.js";
import type { PassphraseProvider } from "../passphrase.js";
import type { TechnocoreTransport, RoomResponse } from "../types.js";
import { safePeerText } from "./proposal.js";
import { SessionStateStore, sessionDirectory, validateDag, type PeerSession } from "./session-state.js";
import { classifyEffectObservation } from "./peer-recovery.js";
import type { PeerAlias } from "./session-policy.js";

export interface ExternalResultEnvelope {
  version: 1; kind: "external-result";
  proposalId: string; jobId: string; taskId: string; rootTaskId: string;
  requesterDid: string; responderDid: string; workload: { type: string; version: 1 };
  rootProvenanceHash: string; workAuthorityHash: string;
  resultHash: string; resultReference: string; evidenceHash: string;
  evidenceRefs: { taskId: string; resultHash: string; evidenceHash: string; inferenceAttemptId: string; inferenceRequestHash: string }[];
  output: unknown; completionStatus: "compute-completed"; createdAt: string;
}
type DeliveryStatus = "response-prepared" | "response-authorized" | "sending" | "sent" | "delivery-ambiguous" | "failed";
export interface ExternalDeliverySummary {
  effectId: string; compute: "completed" | "unverified"; delivery: DeliveryStatus | "needs-operator";
  proposalId?: string; jobId?: string; taskId?: string; responderDid?: string; requesterDid?: string;
  responderAlias?: PeerAlias; actionId?: string; actionHash?: string; destinationHash?: string;
  payloadHash?: string; resultHash?: string; evidenceRefs?: ExternalResultEnvelope["evidenceRefs"];
  completion?: "completed" | "needs-operator"; postAttempts?: number; seq?: number;
  observation?: ReturnType<typeof classifyEffectObservation>["observation"]; decision?: "needs-operator";
}
interface DeliveryRecord {
  version: 1; id: string; proposalRecordId: string; nodeId: string; sessionHash: string;
  alias: PeerAlias; requesterDid: string; responderDid: string; contactId: string; destinationHash: string;
  envelope: ExternalResultEnvelope; payloadHash: string; actionId: string; actionHash: string;
  status: DeliveryStatus; postAttempts: number; nonce?: string; seq?: number;
  observation?: ReturnType<typeof classifyEffectObservation>;
}
export interface ExternalDeliveryOptions {
  root: string; sessionId: string; passphrases?: PassphraseProvider;
  /** Test seam only. Never accepted from CLI/proposals. */
  offlineTransport?: TechnocoreTransport;
}
class DeliveryApprovals extends ActionApprovalStore {
  constructor(path: string, private readonly guard: (effect: ExactActionEffect, id?: string) => Promise<void>) { super(path); }
  override async consume(effect: ExactActionEffect, id?: string) { await this.guard(effect, id); return super.consume(effect, id); }
}
const noReads = {
  readRoomText: async (): Promise<string> => { throw new BridgeError("External delivery has no read authority"); },
  readRoomJson: async (): Promise<RoomResponse> => { throw new BridgeError("External delivery has no read authority"); },
};

/** One-shot post-compute delivery. Never starts/resumes AgentRuntime or invokes inference. */
export class ExternalJobDelivery {
  private readonly base;
  readonly directory: string;
  constructor(private readonly options: ExternalDeliveryOptions) {
    this.base = createStores(options.root, options.passphrases);
    this.directory = sessionDirectory(this.base.paths.root, options.sessionId);
  }
  private path(id: string): string {
    if (!/^[a-f0-9]{64}$/u.test(id)) throw new BridgeError("Invalid external effect id");
    return resolve(this.directory, "external-deliveries", `${id}.json`);
  }
  private approvals() { return new ActionApprovalStore(resolve(this.directory, "external-response-approvals")); }
  private async locked<T>(work: () => Promise<T>): Promise<T> {
    const lock = await AgentRuntimeLock.acquire(resolve(this.directory, "external-delivery.lock"));
    try { return await work(); }
    catch { throw new BridgeError("External delivery needs operator review; no automatic retry or compute rerun"); }
    finally { await lock.release(); }
  }
  private async session(): Promise<PeerSession> { return SessionStateStore.read(this.base.paths.root, this.options.sessionId); }
  private async record(id: string): Promise<DeliveryRecord> {
    const r = await readJsonFile<DeliveryRecord | null>(this.path(id), null);
    if (!r || r.version !== 1 || r.id !== id || !["response-prepared", "response-authorized", "sending", "sent", "delivery-ambiguous", "failed"].includes(r.status) ||
      !Number.isSafeInteger(r.postAttempts) || r.postAttempts < 0 || r.postAttempts > 1) throw new BridgeError("Invalid external delivery record");
    return r;
  }
  private async material(state: PeerSession, proposalRecordId: string, nodeId: string) {
    const p = state.proposals[proposalRecordId], job = p?.jobId ? state.jobs[p.jobId] : undefined;
    const node = state.tasks[nodeId];
    const root = job?.root;
    if (state.lifecycle !== "stopped" || !p?.proposal || p.trust !== "external" || p.status !== "accepted" ||
      p.hash !== hashValue(p.proposal) || !job || job.status !== "completed" || !root?.operatorScope || root.origin !== "external" || root.trust !== "external-approved" ||
      job.rootHash !== hashValue(root) || root.originalProposalId !== p.proposal.proposalId || root.requesterDid !== p.proposal.requesterDid ||
      !node || node.jobId !== job.id || node.compute !== "result-ready" || !job.tasks.includes(nodeId) || !node.runtimeTaskId ||
      state.policy.members.find(m => m.alias === node.alias)?.did !== p.proposal.recipientDid ||
      state.policy.members.some(m => m.did === root.requesterDid)) throw new BridgeError("Completed external result is unavailable; needs operator");
    const scope = root.operatorScope;
    if (scope.approvalHash !== hashValue({ proposalId: p.id, expectedHash: p.hash, workloads: scope.workloads, pairs: scope.pairs, maxTasks: scope.maxTasks }) ||
      job.tasks.length > scope.maxTasks || job.tasks.some(id => state.tasks[id]?.jobId !== job.id || state.tasks[id]?.compute !== "result-ready" || !scope.workloads.includes(state.tasks[id]!.workload))) throw new BridgeError("External work scope changed");
    validateDag(state.tasks);
    const rootNode = state.tasks[job.tasks[0]!]!;
    if (!rootNode || rootNode.parentId || rootNode.alias !== node.alias || rootNode.inputHash !== p.proposal.inputHash) throw new BridgeError("External root binding changed");
    const selected = new Set<string>();
    const visit = (id: string) => {
      if (selected.has(id)) return;
      const t = state.tasks[id];
      if (!t || t.jobId !== job.id || t.rootHash !== job.rootHash || hashValue(t.input) !== t.inputHash || t.authorityChain[0] !== state.policyHash) throw new BridgeError("External evidence DAG changed");
      selected.add(id); t.dependencies.forEach(visit);
    };
    visit(node.id);
    if (!selected.has(rootNode.id)) throw new BridgeError("Result must descend from the original external root");
    const ledger = await new InferenceLedger(resolve(this.directory, "inference-usage.json")).read();
    const refs: ExternalResultEnvelope["evidenceRefs"] = [];
    let completed: Awaited<ReturnType<typeof readCompletedTaskEvidence>> | undefined;
    for (const id of [...selected].sort()) {
      const t = state.tasks[id]!, did = state.policy.members.find(m => m.alias === t.alias)!.did;
      const paths = agentPaths(this.directory, t.alias);
      const evidence = await readCompletedTaskEvidence({ state: new AgentStateStore(paths.state), memory: new LocalMemoryProvider(paths.memory), journal: new ActivityJournal(paths.journal) }, t.alias, did, t.runtimeTaskId!);
      if (evidence.evidence.workload !== t.workload || hashValue(evidence.evidence) !== hashValue(t.evidence)) throw new BridgeError("Persisted peer evidence changed");
      const binding = evidence.evidence.accounting, a = ledger.find(a => a.attemptId === binding?.attemptId);
      if (!binding || !a || a.state !== "succeeded" || a.context.agentDid !== did || a.context.sessionId !== state.sessionId || a.context.jobId !== job.id ||
        a.context.taskId !== t.runtimeTaskId || a.context.rootRequesterDid !== root.requesterDid || a.context.rootOrigin !== "external" || a.context.rootTrust !== "external-approved" ||
        a.context.authorityId !== state.policyHash || a.requestHash !== evidence.evidence.inferenceRequestHash || a.providerMetadataHash !== binding.providerMetadataHash) throw new BridgeError("Inference attribution changed or missing");
      refs.push({ taskId: evidence.evidence.taskId, resultHash: evidence.evidence.resultHash, evidenceHash: hashValue(evidence.evidence), inferenceAttemptId: a.attemptId, inferenceRequestHash: a.requestHash });
      if (id === nodeId) completed = evidence;
    }
    if (!completed || !p.replyContact) throw new BridgeError("No intake-bound reply contact; needs operator");
    const contact = await this.base.contacts.get(node.alias, p.replyContact.contactId);
    if (contact.did !== root.requesterDid || hashValue({ room: contact.mailbox, did: contact.did, contactId: contact.contactId }) !== p.replyContact.destinationHash) throw new BridgeError("Reply destination changed; needs operator");
    const identity = await this.base.identities.inspect(node.alias);
    if (identity.did !== p.proposal.recipientDid) throw new BridgeError("Responder identity changed");
    const e = completed.evidence;
    const envelope: ExternalResultEnvelope = { version: 1, kind: "external-result", proposalId: p.proposal.proposalId,
      jobId: job.id, taskId: e.taskId, rootTaskId: rootNode.runtimeTaskId!, requesterDid: root.requesterDid, responderDid: identity.did,
      workload: { type: node.workload, version: 1 }, rootProvenanceHash: job.rootHash, workAuthorityHash: scope.approvalHash,
      resultHash: e.resultHash, resultReference: completed.task.result!.reference!, evidenceHash: hashValue(e), evidenceRefs: refs,
      output: e.output, completionStatus: "compute-completed", createdAt: completed.task.finishedAt! };
    const text = safePeerText(envelope, Math.min(4096, state.policy.limits.payloadBytes));
    if (/"(?:sig|signature)"\s*:/iu.test(text) || /\b[A-Za-z0-9_-]{86}\b/u.test(text)) throw new BridgeError("External result contains signature-like material");
    return { envelope, text, node, contact, destinationHash: p.replyContact.destinationHash };
  }
  private async validate(r: DeliveryRecord) {
    const state = await this.session();
    if (r.sessionHash !== hashValue(state)) throw new BridgeError("Closed session checkpoint changed");
    const m = await this.material(state, r.proposalRecordId, r.nodeId);
    const id = hashValue({ sessionId: state.sessionId, policyHash: state.policyHash, proposalRecordId: r.proposalRecordId, kind: "external-result" });
    const actionId = hashValue({ externalEffect: id, taskId: m.envelope.taskId, resultHash: m.envelope.resultHash });
    const effect = { agentAlias: m.node.alias, agentDid: m.envelope.responderDid, type: "technocore.send-contact" as const,
      destinationHash: m.destinationHash, payloadHash: hashValue(m.text) };
    if (id !== r.id || actionId !== r.actionId || r.actionHash !== hashValue({ actionId, ...effect }) || r.alias !== m.node.alias || r.contactId !== m.contact.contactId ||
      r.requesterDid !== m.envelope.requesterDid || r.responderDid !== m.envelope.responderDid || r.destinationHash !== m.destinationHash || r.payloadHash !== effect.payloadHash || hashValue(r.envelope) !== hashValue(m.envelope)) throw new BridgeError("External result/action binding changed");
    return { state, m, effect };
  }
  async prepare(proposalRecordId: string, nodeId: string) {
    return this.locked(async () => {
      const state = await this.session(), m = await this.material(state, proposalRecordId, nodeId);
      const id = hashValue({ sessionId: state.sessionId, policyHash: state.policyHash, proposalRecordId, kind: "external-result" });
      const existing = await readJsonFile<DeliveryRecord | null>(this.path(id), null);
      if (existing) {
        if (existing.nodeId !== nodeId) throw new BridgeError("Response result already selected; cannot replace it");
        await this.validate(existing); return this.inspect(id);
      }
      const actionId = hashValue({ externalEffect: id, taskId: m.envelope.taskId, resultHash: m.envelope.resultHash });
      const effect = { agentAlias: m.node.alias, agentDid: m.envelope.responderDid, type: "technocore.send-contact" as const, destinationHash: m.destinationHash, payloadHash: hashValue(m.text) };
      const r: DeliveryRecord = { version: 1, id, proposalRecordId, nodeId, sessionHash: hashValue(state), alias: m.node.alias,
        requesterDid: m.envelope.requesterDid, responderDid: m.envelope.responderDid, contactId: m.contact.contactId, destinationHash: m.destinationHash,
        envelope: m.envelope, payloadHash: effect.payloadHash, actionId, actionHash: hashValue({ actionId, ...effect }), status: "response-prepared", postAttempts: 0 };
      await atomicWriteJson(this.path(id), r); // Durable linkage before the exact approval proposal.
      await this.approvals().propose(effect, actionId);
      return this.inspect(id);
    });
  }
  async authorize(id: string, expectedActionHash: string) {
    return this.locked(async () => {
      const r = await this.record(id), { effect } = await this.validate(r);
      if (r.actionHash !== expectedActionHash || !["response-prepared", "response-authorized"].includes(r.status)) throw new BridgeError("Exact unspent response authority required");
      const a = await this.approvals().propose(effect, r.actionId);
      if (a.status === "requested") await this.approvals().grant(r.alias, r.actionId, expectedActionHash);
      else if (a.status !== "approved") throw new BridgeError("Response authority spent");
      r.status = "response-authorized"; await atomicWriteJson(this.path(id), r); return this.inspect(id);
    });
  }
  private async guard(r: DeliveryRecord) {
    const persisted = await this.record(r.id);
    if (hashValue(persisted) !== hashValue(r)) throw new BridgeError("External effect changed outside its owner");
    const value = await this.validate(r);
    if (Date.now() >= Date.parse(value.state.policy.expiresAt)) throw new BridgeError("Response session window expired; needs operator");
    return value;
  }
  async send(id: string, expectedActionHash: string) {
    return this.locked(async () => {
      const r = await this.record(id);
      if (r.status !== "response-authorized" || r.postAttempts !== 0 || r.actionHash !== expectedActionHash) throw new BridgeError("Unspent exact response authorization required");
      const { state, m } = await this.guard(r);
      const approved = await this.approvals().read(r.alias, r.actionId);
      if (approved.status !== "approved" || approved.actionHash !== expectedActionHash) throw new BridgeError("External response not approved");
      if ((state.policy.mode === "offline") !== !!this.options.offlineTransport) throw new BridgeError("Explicit offline transport required; configured mode cannot inject a fixture");
      const paths = agentPaths(this.directory, r.alias);
      const owner = await AgentRuntimeLock.acquire(paths.runtimeLock);
      try {
        const stores = { ...this.base, nonces: state.policy.mode === "offline" ? createStores(this.directory).nonces : this.base.nonces,
          approvals: new DeliveryApprovals(resolve(this.directory, "external-response-approvals"), async (effect, actionId) => {
            const v = await this.guard(r);
            if (r.status !== "response-authorized" || actionId !== r.actionId || hashValue(effect) !== hashValue(v.effect)) throw new BridgeError("External approval binding changed before nonce reservation");
          }) };
        const transport: TechnocoreTransport = { ...noReads, sendSignedMessage: async (room, envelope) => {
          const v = await this.guard(r);
          const authority = await stores.approvals.read(r.alias, r.actionId);
          if (authority.status !== "executing" || authority.actionHash !== r.actionHash) throw new BridgeError("Response authority changed before dispatch");
          if (room !== v.m.contact.mailbox || envelope.did !== r.responderDid || hashValue(envelope.text) !== r.payloadHash) throw new BridgeError("External dispatch binding changed");
          const names = await readdir(resolve(this.directory, "external-deliveries"));
          let attempts = state.budgets.outbound;
          for (const name of names.filter(n => /^[a-f0-9]{64}\.json$/u.test(n))) attempts += (await this.record(name.slice(0, -5))).postAttempts;
          if (attempts >= state.policy.limits.outbound) throw new BridgeError("External delivery exceeds remaining session POST budget");
          r.status = "sending"; r.postAttempts = 1; r.nonce = envelope.nonce; await atomicWriteJson(this.path(id), r);
          await this.guard(r); // Includes current contact/payload/evidence, immediately before IO.
          const io = this.options.offlineTransport ?? new HttpTechnocoreTransport(state.policy.network.origin, { rateLimitRetries: 0, readRetries: 0, writeTimeoutMs: 30000 });
          const response = await io.sendSignedMessage(room, envelope);
          const p = response.posted;
          if (!p || !Number.isSafeInteger(p.seq) || p.seq < 1 || p.from !== envelope.did || String(p.nonce) !== envelope.nonce || hashValue(p.text) !== r.payloadHash) throw new AmbiguousSendError("External result receipt mismatch; no retry");
          r.seq = p.seq; // Sent is installed only after the shared approval confirmation succeeds.
          return response;
        } };
        try {
          await new SignedAgentBridge(stores, transport).sendTo(r.alias, r.contactId, m.text, r.actionId);
          r.status = "sent"; await atomicWriteJson(this.path(id), r);
        } catch (error) {
          r.status = error instanceof SignedPostRejectedError ? "failed" : r.postAttempts ? "delivery-ambiguous" : "failed";
          await atomicWriteJson(this.path(id), r);
        }
      } finally { await owner.release(); }
      return this.inspect(id);
    });
  }
  /** Inspect does not unlock, repair, execute or resume. A persisted sending intent remains unresolved. */
  async inspect(id: string): Promise<ExternalDeliverySummary> {
    const r = await this.record(id);
    try {
      await this.validate(r);
      return { effectId: r.id, proposalId: r.envelope.proposalId, jobId: r.envelope.jobId, taskId: r.envelope.taskId,
        responderDid: r.responderDid, requesterDid: r.requesterDid, responderAlias: r.alias, actionId: r.actionId, actionHash: r.actionHash,
        destinationHash: r.destinationHash, payloadHash: r.payloadHash, resultHash: r.envelope.resultHash, evidenceRefs: r.envelope.evidenceRefs,
        compute: "completed", delivery: r.status === "sending" ? "delivery-ambiguous" : r.status,
        completion: r.status === "sent" ? "completed" : "needs-operator", postAttempts: r.postAttempts,
        ...(r.seq === undefined ? {} : { seq: r.seq }), ...(r.observation ? { observation: r.observation.observation, decision: "needs-operator" } : {}) };
    } catch { return { effectId: id, compute: "unverified", delivery: "needs-operator" }; }
  }
  /** Already retained data only. No GET, ACK, grant, resend or compute. Negative observation is not non-commit proof. */
  async observeRetained(id: string, view: RoomResponse) {
    return this.locked(async () => {
      const r = await this.record(id); await this.validate(r);
      if (!["sending", "delivery-ambiguous", "failed"].includes(r.status)) throw new BridgeError("A spent delivery is required");
      r.observation = classifyEffectObservation(r, r.responderDid, view); await atomicWriteJson(this.path(id), r);
      return this.inspect(id);
    });
  }
  async jobs() {
    const s = await this.session();
    const view = Object.values(s.proposals).filter(p => p.trust === "external").map(p => ({
      proposalRecordId: p.id, proposalHash: p.hash, proposalId: p.proposal?.proposalId, requesterDid: p.proposal?.requesterDid,
      recipientDid: p.proposal?.recipientDid, workApproval: p.status, jobId: p.jobId,
      replyDestination: p.replyContact ? "intake-bound-contact" : "needs-operator",
      tasks: p.jobId ? s.jobs[p.jobId]?.tasks.map(id => ({ nodeId: id, alias: s.tasks[id]?.alias, compute: s.tasks[id]?.compute, resultHash: s.tasks[id]?.evidence?.resultHash })) : [],
    }));
    safePeerText(view, 131072); return view;
  }
}
