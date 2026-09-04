import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { cp, readFile, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { Socket } from "node:net";
import { createStores, createBridge } from "../src/context.js";
import { AgentRoleStore } from "../src/agent/roles.js";
import { hashValue } from "../src/agent/util.js";
import { AgentRuntime } from "../src/agent/runtime.js";
import { NonceStore } from "../src/nonce-store.js";
import { ActionApprovalStore } from "../src/agent/approvals.js";
import { SessionAuthority, PEER_ROLES, peerAliases, pairId, schemaId, type PeerAlias, type SessionPolicy } from "../src/swarm/session-policy.js";
import { SwarmSessionSupervisor } from "../src/swarm/supervisor.js";
import { SessionStateStore, validateDag, classifyInterruptedSession, sessionDirectory } from "../src/swarm/session-state.js";
import { validateProposal, safePeerText, type WorkProposal } from "../src/swarm/proposal.js";
import { validateWorkRequest } from "../src/swarm/router.js";
import { validatePeerWindow, classifyEffectObservation } from "../src/swarm/peer-recovery.js";
import { offlinePeerInference } from "../src/swarm/offline-inference.js";
import { PeerEffectReconciliation } from "../src/swarm/effect-reconciliation.js";
import { peerSessionCommand } from "../src/swarm/cli.js";
import { ExternalJobDelivery } from "../src/swarm/external-delivery.js";
import { DeterministicInferenceProvider } from "../src/agent/inference.js";
import { InferenceLedger, defaultInferenceBudgets } from "../src/agent/inference-accounting.js";
import { InMemoryTechnocoreTransport } from "../src/mock-transport.js";
import { SignedPostRejectedError } from "../src/send-diagnostics.js";
import { AmbiguousSendError } from "../src/errors.js";
import { atomicWriteJson } from "../src/fs-safe.js";
import type { ReadRoomOptions, RoomResponse, SignedMessageEnvelope } from "../src/types.js";
import { approveContactSend, generatedPassphraseProvider, temporaryDirectory } from "./helpers.js";

const secrets = generatedPassphraseProvider();
let template: Awaited<ReturnType<typeof temporaryDirectory>>;
let templatePolicy: SessionPolicy;
let externalDid: string;
let networkAttempts = 0;
const originalConnect = Socket.prototype.connect;
before(async () => {
  Socket.prototype.connect = function () { networkAttempts++; throw new Error("Live network forbidden in peer tests"); } as typeof Socket.prototype.connect;
  template = await temporaryDirectory();
  const stores = createStores(template.path, secrets.provider);
  const members: SessionPolicy["members"] = [];
  for (const alias of peerAliases) {
    const identity = await stores.identities.create(alias);
    await stores.mailboxes.create(alias, identity.did);
    await new AgentRoleStore(resolve(template.path, "agents", alias)).assign(identity, PEER_ROLES[alias]);
    members.push({ alias, did: identity.did, role: PEER_ROLES[alias], mayDelegate: true });
  }
  externalDid = (await stores.identities.create("externalfixture")).did;
  // Full mesh is TEST FIXTURE ONLY, explicit operator-created pairs. Supervisor never creates any contacts.
  const pairs: SessionPolicy["pairs"] = [];
  const workloads = ["research", "engineering", "review", "specialist", "coordination", "synthesis"].map(w => ({ type: `workload.${w}`, version: 1 as const }));
  for (const source of members) for (const target of members) if (source.did !== target.did) {
    const mailbox = await stores.mailboxes.load(target.alias);
    await stores.contacts.add(source.alias, target.alias, target.did, mailbox.room);
    pairs.push({ sourceDid: source.did, targetDid: target.did, contactId: target.alias,
      destinationHash: hashValue({ room: mailbox.room, did: target.did, contactId: target.alias }), workloads: workloads.map(w => w.type) });
  }
  templatePolicy = { version: 1, sessionId: "offline-fixture", mode: "offline", members, pairs, workloads,
    schemas: ["peer-work/v1", "peer-result/v1"], expiresAt: new Date(Date.now() + 3600000).toISOString(),
    limits: { tasks: 32, outbound: 32, gets: 32, inference: 32, payloadBytes: 4096, depth: 8, concurrency: 3, inferenceTimeoutMs: 1000 },
    network: { origin: "offline", pathClass: "signed-mailbox-only", postRetries: 0 } };
  await atomicWriteJson(resolve(template.path, "rehearsals", "first-room-read-v1.json"), { historical: true, status: "post-intent", halt: "send-failed" });
});
after(async () => { Socket.prototype.connect = originalConnect; secrets.cleanup(); await template?.cleanup(); assert.equal(networkAttempts, 0); });

function input(type: string): Record<string, unknown> {
  const values: Record<string, Record<string, unknown>> = {
    "workload.research": { topic: "Fixture", objective: "Assess supplied evidence", sources: [], outputRequirements: [] },
    "workload.engineering": { problemStatement: "Assess a fixture", project: { name: "Fixture" }, observedBehavior: "Synthetic", constraints: [], codeContext: [], requestedOutcome: "test-plan" },
    "workload.review": { question: "Review fixture evidence", producedResult: { fixture: true }, expectedOutputHash: hashValue({ fixture: true }), criteria: ["Check supplied evidence scope"] },
    "workload.specialist": { question: "Assess edge cases", focus: "Delivery", suppliedContext: "Offline fixture" },
    "workload.coordination": { question: "Plan evidence work", phase: "decomposition", requiredEvidenceHashes: [] },
    "workload.synthesis": { question: "Synthesize supplied evidence", phase: "synthesis", requiredEvidenceHashes: [] },
  };
  return validateWorkRequest(type, values[type]!);
}
const defaultWork: Record<PeerAlias, string> = { alice: "workload.coordination", bob: "workload.research", charlie: "workload.engineering", dave: "workload.review", eve: "workload.specialist" };
function proposal(p: SessionPolicy, alias: PeerAlias, requester = p.members.find(m => m.alias === alias)!.did): WorkProposal {
  const workloadType = defaultWork[alias], payload = input(workloadType);
  return { version: 1, kind: "peer-work", proposalId: `root_${alias}`, requesterDid: requester, recipientDid: p.members.find(m => m.alias === alias)!.did,
    workloadType, workloadVersion: 1, objective: "Offline bounded fixture", input: payload, inputHash: hashValue(payload), evidenceRefs: [],
    requestedOutputSchema: schemaId(workloadType, "output"), replyTo: requester, createdAt: new Date().toISOString(), provenanceClaims: { mode: "offline" } };
}
class FixtureTransport extends InMemoryTechnocoreTransport {
  writes = 0; reads = 0;
  failure?: "timeout" | "400" | "503" | "reset" | "malformed";
  beforeWrite?: () => Promise<void>;
  readOverride?: (room: string, options: ReadRoomOptions) => Promise<RoomResponse>;
  override async sendSignedMessage(room: string, envelope: SignedMessageEnvelope): Promise<RoomResponse> {
    this.writes++; await this.beforeWrite?.();
    if (this.failure === "timeout") throw new AmbiguousSendError("Synthetic timeout");
    if (this.failure === "400") throw new SignedPostRejectedError({ stage: "response-status", endpoint: "[REDACTED]", headersReceived: true, timedOut: false, status: 400, contentType: "text/plain", bodyStarted: true, errorClass: "Error" });
    if (this.failure === "503") throw new AmbiguousSendError("Synthetic 503");
    if (this.failure === "reset") throw Object.assign(new Error("Synthetic reset"), { code: "ECONNRESET" });
    if (this.failure === "malformed") return { count: 0, first_seq: null, last_seq: 0, messages: [] };
    return super.sendSignedMessage(room, envelope);
  }
  override async readRoomJson(room: string, options: ReadRoomOptions = {}): Promise<RoomResponse> {
    // Mock send implementation itself calls readRoomJson to build its response: not a supervisor GET.
    if (options.wait === 0) { this.reads++; if (this.readOverride) return this.readOverride(room, options); }
    return super.readRoomJson(room, options);
  }
}
async function fixture() {
  const tmp = await temporaryDirectory(); await cp(template.path, tmp.path, { recursive: true });
  const policy = structuredClone(templatePolicy), transport = new FixtureTransport();
  const stores = createStores(tmp.path, secrets.provider);
  let unlocks = 0;
  const start = () => SwarmSessionSupervisor.start({ root: tmp.path, policy, reviewedPolicyHash: hashValue(policy),
    passphrases: async request => { unlocks++; return secrets.provider(request); }, offlineTransport: transport });
  return { tmp, policy, stores, transport, start, unlocks: () => unlocks };
}
async function untilIdle(s: SwarmSessionSupervisor, max = 30): Promise<void> {
  for (let i = 0; i < max && s.snapshot().lifecycle === "active"; i++) if (!await s.step()) return;
  assert.notEqual(s.snapshot().lifecycle, "active", "scheduler exceeded fixture bound");
}
async function snapshotInputs(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(path: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = resolve(path, entry.name);
      if (entry.isDirectory()) await walk(full); else result[full.slice(root.length)] = hashValue(await readFile(full, "utf8"));
    }
  }
  for (const dir of ["identities", "mailboxes", "contacts", "agents", "rehearsals"]) await walk(resolve(root, dir));
  return result;
}

test("peer session unlocks five identities once, preserves immutable inputs/history, isolates state, and stops cleanly", async () => {
  const f = await fixture(); const original = await snapshotInputs(f.tmp.path); const s = await f.start();
  try {
    assert.equal(f.unlocks(), 5);
    await s.submit("bob", proposal(f.policy, "bob")); await untilIdle(s);
    assert.equal(f.unlocks(), 5); assert.equal(s.snapshot().budgets.inference, 1);
    assert.equal(s.snapshot().policy.mode, "offline"); assert.equal(f.transport.writes, 0);
    await assert.rejects(createBridge(f.transport, f.tmp.path, secrets.provider).peekInbox("bob"), /already active/);
    await assert.rejects(f.start(), /automatic resume/);
    assert.deepEqual(await snapshotInputs(f.tmp.path), original);
  } finally { await s.stop(); assert.equal(s.snapshot().lifecycle, "stopped"); await f.tmp.cleanup(); }
});

for (const [source, target] of [["bob", "dave"], ["dave", "bob"], ["charlie", "bob"], ["bob", "charlie"], ["eve", "dave"], ["dave", "eve"], ["alice", "bob"]] as [PeerAlias, PeerAlias][]) {
  test(`autonomous ${source} -> ${target} -> ${source} uses exact signed effects without Alice gateway`, async () => {
    const f = await fixture(); const s = await f.start();
    try {
      const root = await s.submit(source, proposal(f.policy, source));
      const child = await s.delegate(root, target, defaultWork[target], input(defaultWork[target]));
      await untilIdle(s);
      const state = s.snapshot();
      assert.equal(state.lifecycle, "active", state.reason);
      assert.equal(state.tasks[child]!.compute, "result-ready"); assert.equal(state.tasks[child]!.delivery, "received");
      assert.equal(state.budgets.outbound, 2); assert.equal(state.budgets.gets, 2); assert.equal(state.budgets.inference, 2);
      assert.equal(Object.values(state.effects).every(e => e.status === "received"), true);
      assert.equal(Object.values(state.jobs)[0]!.status, "completed");
      const attempts = await new InferenceLedger(resolve(sessionDirectory(f.tmp.path, f.policy.sessionId), "inference-usage.json")).read();
      assert.equal(attempts.length, 2);
      assert.equal(new Set(attempts.map(a => a.context.agentDid)).size, 2);
      for (const a of attempts) {
        assert.equal(a.context.rootRequesterDid, f.policy.members.find(m => m.alias === source)!.did);
        assert.equal(a.context.sessionId, f.policy.sessionId);
        assert.equal(a.context.jobId, state.tasks[root]!.jobId);
        assert.equal(a.context.authorityId, hashValue(f.policy));
        const node = Object.values(state.tasks).find(t => t.runtimeTaskId === a.context.taskId)!;
        assert.equal(node.evidence!.accounting!.attemptId, a.attemptId);
        assert.equal(node.evidence!.accounting!.requestHash, node.evidence!.inferenceRequestHash);
        assert.equal(node.evidence!.accounting!.providerMetadataHash, a.providerMetadataHash);
        assert.equal(a.usageStatus, "synthetic"); assert.equal(a.spendStatus, "unknown");
      }
      assert.equal(Object.values(state.receipts).every(r => r.status === "acked"), true);
      assert.equal(f.unlocks(), 5);
      if (source !== "alice" && target !== "alice") assert.equal(Object.values(state.tasks).some(t => t.alias === "alice"), false);
    } finally { await s.stop(); await f.tmp.cleanup(); }
  });
}

test("DAG branches, return-to-agent nodes, explicit synthesis evidence and true cycle rejection", async () => {
  const f = await fixture(); const s = await f.start();
  try {
    const root = await s.submit("bob", proposal(f.policy, "bob"));
    const dave = await s.delegate(root, "dave", "workload.review", input("workload.review"));
    const charlie = await s.delegate(root, "charlie", "workload.engineering", input("workload.engineering"));
    await untilIdle(s);
    const first = s.snapshot(); assert.equal(first.lifecycle, "active", first.reason);
    const synthesis = await s.delegate(dave, "bob", "workload.synthesis", { ...input("workload.synthesis"),
      requiredEvidenceHashes: [first.tasks[dave]!.evidence!.resultHash, first.tasks[charlie]!.evidence!.resultHash] }, [dave, charlie]);
    await untilIdle(s); assert.equal(s.snapshot().tasks[synthesis]!.compute, "result-ready");
    validateDag(s.snapshot().tasks);
    assert.throws(() => validateDag({ a: { id: "a", dependencies: ["b"] }, b: { id: "b", dependencies: ["a"] } }), /cycle/);
    assert.throws(() => validateDag({ a: { id: "a", dependencies: ["missing"] } }), /dependency/);
  } finally { await s.stop(); await f.tmp.cleanup(); }
});

test("partial startup unlock failure closes prior runtime references and emits no network effects", async () => {
  const f = await fixture(); let attempts = 0, closed = 0;
  const original = AgentRuntime.prototype.close;
  AgentRuntime.prototype.close = async function (...args) { closed++; return original.apply(this, args); };
  try {
    await assert.rejects(SwarmSessionSupervisor.start({ root: f.tmp.path, policy: f.policy, reviewedPolicyHash: hashValue(f.policy), offlineTransport: f.transport,
      passphrases: async request => { if (++attempts === 3) throw new Error("fixture unlock refusal"); return secrets.provider(request); } }), /startup failed/);
    assert.equal(attempts, 3); assert.equal(closed, 2); assert.equal(f.transport.writes + f.transport.reads, 0);
    const state = await SessionStateStore.read(f.tmp.path, f.policy.sessionId); assert.equal(state.lifecycle, "halted");
  } finally { AgentRuntime.prototype.close = original; await f.tmp.cleanup(); }
});

test("policy hash, capabilities, directional pairs, schemas, mode and authority scope are fail closed", () => {
  const p = structuredClone(templatePolicy), a = new SessionAuthority(p, hashValue(p));
  const bob = a.member("bob").did, dave = a.member("dave").did;
  const root = { requesterDid: bob, origin: "internal" as const, trust: "operator-local" as const, originalProposalId: "root" };
  assert.throws(() => new SessionAuthority(p, "wrong"), /hash/);
  assert.throws(() => { a.policy.members[0]!.did = "changed"; }, TypeError);
  a.delegate(bob, dave, "workload.review", 1, root);
  assert.throws(() => a.delegate(bob, dave, "workload.engineering", 1, root), /capability/);
  assert.throws(() => a.delegate(bob, dave, "workload.review", 99, root), /depth/);
  p.pairs = p.pairs.filter(pair => pair.sourceDid !== bob || pair.targetDid !== dave);
  assert.throws(() => new SessionAuthority(p, hashValue(p)).delegate(bob, dave, "workload.review", 1, root), /Directional/);
  p.members.find(m => m.alias === "bob")!.mayDelegate = false;
  assert.throws(() => new SessionAuthority(p, hashValue(p)).delegate(bob, dave, "workload.review", 1, root), /capability/);
  p.expiresAt = new Date(Date.now() - 1).toISOString(); assert.throws(() => new SessionAuthority(p, hashValue(p)), /expired/);
  assert.equal(a.capabilities.get("bob").workloads.some(w => w.type === "workload.synthesis"), true);
  assert.equal(a.capabilities.get("bob").workloads.some(w => w.type === "workload.coordination"), false);
});

test("proposal input/recipient/schema/expiry and canonical payload limits; no shell, commerce, identity APIs", () => {
  const p = proposal(templatePolicy, "bob"); validateProposal(p);
  assert.throws(() => validateProposal({ ...p, inputHash: "changed" }), /binding/);
  assert.throws(() => validateProposal({ ...p, expiresAt: "2000-01-01" }), /expired/);
  assert.throws(() => validateProposal({ ...p, authority: "trusted" }), /schema/);
  assert.throws(() => safePeerText({ data: "x".repeat(4097) }, 4096), /bounds/);
  for (const workload of ["shell.exec", "tclk.pay", "identity.create", "mailbox.rotate", "nonce.reset", "cursor.reset", "technocore.send-public"]) {
    assert.throws(() => validateWorkRequest(workload, {}), /Unsupported/);
  }
});

test("configured provider absence fails before any startup; offline provider is never mislabeled live", async () => {
  const f = await fixture();
  try {
    f.policy.mode = "configured"; f.policy.network.origin = "https://technocore.chat";
    await assert.rejects(SwarmSessionSupervisor.start({ root: f.tmp.path, policy: f.policy, reviewedPolicyHash: hashValue(f.policy), passphrases: secrets.provider }), /real inference provider/);
    await assert.rejects(SwarmSessionSupervisor.start({ root: f.tmp.path, policy: f.policy, reviewedPolicyHash: hashValue(f.policy), passphrases: secrets.provider, inference: offlinePeerInference() }), /real inference provider/);
    assert.equal(f.transport.writes + f.transport.reads, 0);
  } finally { await f.tmp.cleanup(); }
});

for (const failure of ["timeout", "400", "503", "reset", "malformed"] as const) {
  test(`${failure} halts exactly one effect, retains compute, consumes nonce once and never resends`, async () => {
    const f = await fixture(), s = await f.start();
    try {
      const root = await s.submit("bob", proposal(f.policy, "bob")); await s.step();
      const evidence = s.snapshot().tasks[root]!.evidence;
      await s.delegate(root, "dave", "workload.review", input("workload.review"));
      f.transport.failure = failure; await s.step();
      const state = s.snapshot(), effect = Object.values(state.effects)[0]!;
      assert.equal(state.lifecycle, "halted"); assert.equal(effect.status, failure === "400" ? "failed" : "ambiguous");
      assert.equal(f.transport.writes, 1); assert.equal(state.budgets.outbound, 1); assert.ok(effect.nonce);
      assert.deepEqual(state.tasks[root]!.evidence, evidence); assert.equal(state.budgets.inference, 1);
      await assert.rejects(s.step(), /inactive/); assert.equal(f.transport.writes, 1);
      const observed = classifyEffectObservation(effect, f.policy.members.find(m => m.alias === "bob")!.did, { count: 0, first_seq: null, last_seq: 0, messages: [] });
      assert.equal(observed.observation, "not-observed"); assert.equal(observed.decision, "needs-operator");
      await s.observeRetained(effect.id, { count: 0, first_seq: null, last_seq: 0, messages: [] });
      assert.equal(s.snapshot().effects[effect.id]!.status, effect.status); assert.equal(f.transport.reads, 0);
    } finally { await s.stop(); await f.tmp.cleanup(); }
  });
}

test("destination mutation blocks prior to nonce; payload mutation cannot reuse exact effect approval", async () => {
  const f = await fixture(), s = await f.start();
  try {
    const root = await s.submit("bob", proposal(f.policy, "bob")); await s.step();
    await s.delegate(root, "dave", "workload.review", input("workload.review"));
    const other = await f.stores.mailboxes.load("eve");
    await f.stores.contacts.add("bob", "dave", f.policy.members.find(m => m.alias === "dave")!.did, other.room);
    await s.step(); assert.equal(s.snapshot().lifecycle, "halted"); assert.equal(f.transport.writes, 0);
    assert.equal(s.snapshot().budgets.outbound, 0);
  } finally { await s.stop(); await f.tmp.cleanup(); }
});

test("task/depth budget exhaustion refuses new delegation", async () => {
  const f = await fixture(); f.policy.limits.tasks = 1; const s = await f.start();
  try {
    const root = await s.submit("bob", proposal(f.policy, "bob"));
    await assert.rejects(s.delegate(root, "dave", "workload.review", input("workload.review")), /budget/);
    assert.equal(s.snapshot().budgets.tasks, 1);
  } finally { await s.stop(); await f.tmp.cleanup(); }
});

for (const alias of ["bob", "charlie", "dave", "eve"] as PeerAlias[]) {
  test(`external proposal direct to ${alias}: needs operator, no reply/contact and external origin preserved`, async () => {
    const f = await fixture(), s = await f.start(); const original = await snapshotInputs(f.tmp.path);
    try {
      const p = proposal(f.policy, alias, externalDid);
      p.provenanceClaims = { trusted: true, role: "coordinator", authority: "full" }; // Ignored sender assertions.
      f.transport.readOverride = async () => ({ count: 1, first_seq: 1, last_seq: 1, messages: [{ seq: 1, ts: new Date().toISOString(), from: externalDid, nonce: 1, text: JSON.stringify(p) }] });
      await s.receive(alias);
      const record = Object.values(s.snapshot().proposals).find(x => x.trust === "external")!;
      assert.equal(record.status, "needs-operator"); assert.equal(Object.keys(s.snapshot().tasks).length, 0); assert.equal(f.transport.writes, 0);
      const scope = { workloads: [p.workloadType, "workload.review"], pairs: [] as string[], maxTasks: 2, approvalHash: "" };
      scope.approvalHash = hashValue({ proposalId: record.id, expectedHash: record.hash, workloads: scope.workloads, pairs: scope.pairs, maxTasks: scope.maxTasks });
      const rootId = await s.approveExternal(record.id, record.hash, scope); await s.step();
      assert.equal(s.snapshot().tasks[rootId]!.compute, "result-ready");
      const root = Object.values(s.snapshot().jobs)[0]!.root;
      assert.equal(root.origin, "external"); assert.equal(root.requesterDid, externalDid);
      if (alias !== "dave") await assert.rejects(s.delegate(rootId, "dave", "workload.review", input("workload.review")), /scope/);
      assert.equal(f.transport.writes, 0); assert.deepEqual(await snapshotInputs(f.tmp.path), original);
    } finally { await s.stop(); await f.tmp.cleanup(); }
  });
}

test("external approved Bob -> Dave retains root scope and cannot authorize external responses", async () => {
  const f = await fixture(), s = await f.start();
  try {
    const p = proposal(f.policy, "bob", externalDid);
    f.transport.readOverride = async () => ({ count: 1, first_seq: 1, last_seq: 1, messages: [{ seq: 1, ts: "fixture", from: externalDid, nonce: 1, text: JSON.stringify(p) }] });
    await s.receive("bob"); delete f.transport.readOverride;
    const record = Object.values(s.snapshot().proposals).find(x => x.trust === "external")!;
    const bob = f.policy.members.find(m => m.alias === "bob")!.did, dave = f.policy.members.find(m => m.alias === "dave")!.did;
    const scope = { workloads: ["workload.research", "workload.review"], pairs: [pairId(bob, dave), pairId(dave, bob)], maxTasks: 2, approvalHash: "" };
    scope.approvalHash = hashValue({ proposalId: record.id, expectedHash: record.hash, workloads: scope.workloads, pairs: scope.pairs, maxTasks: scope.maxTasks });
    const root = await s.approveExternal(record.id, record.hash, scope);
    const child = await s.delegate(root, "dave", "workload.review", input("workload.review"));
    assert.equal(s.snapshot().tasks[child]!.rootHash, s.snapshot().tasks[root]!.rootHash);
    await assert.rejects(s.delegate(child, "bob", "workload.research", input("workload.research")), /budget/);
    assert.throws(() => s.authority.pair(bob, externalDid, "workload.review", s.snapshot().jobs[s.snapshot().tasks[root]!.jobId]!.root), /Directional/);
    await untilIdle(s);
    const attempts = await new InferenceLedger(resolve(sessionDirectory(f.tmp.path, f.policy.sessionId), "inference-usage.json")).read();
    assert.equal(attempts.length, 2);
    for (const a of attempts) {
      assert.equal(a.context.rootRequesterDid, externalDid);
      assert.equal(a.context.rootOrigin, "external"); assert.equal(a.context.rootTrust, "external-approved");
      assert.equal(a.context.jobId, s.snapshot().tasks[root]!.jobId);
    }
  } finally { await s.stop(); await f.tmp.cleanup(); }
});

test("reviewed inference budgets deny a child job computation without altering message authority", async () => {
  const f = await fixture();
  f.policy.inferenceBudgets = defaultInferenceBudgets(10); f.policy.inferenceBudgets.job.maxAttempts = 1;
  const s = await f.start();
  try {
    const root = await s.submit("bob", proposal(f.policy, "bob"));
    const child = await s.delegate(root, "dave", "workload.review", input("workload.review"));
    await untilIdle(s);
    assert.equal(s.snapshot().tasks[root]!.compute, "result-ready"); assert.equal(s.snapshot().tasks[child]!.compute, "failed");
    assert.equal(s.snapshot().budgets.inference, 1);
    const summary = await new InferenceLedger(resolve(sessionDirectory(f.tmp.path, f.policy.sessionId), "inference-usage.json")).summary();
    assert.equal(summary.successes, 1); assert.equal(summary.cancelled, 1);
    assert.equal(f.transport.writes, 1); // Proposal only: failed compute does not fabricate a result send.
  } finally { await s.stop(); await f.tmp.cleanup(); }
});

test("window validation rejects retention, epoch regression, replay, duplicate and incomplete windows", () => {
  const message = { seq: 1, ts: "fixture", from: externalDid, nonce: 1, text: "{}" };
  validatePeerWindow({ count: 0, first_seq: null, last_seq: 0, messages: [] }, 0);
  assert.throws(() => validatePeerWindow({ count: 0, first_seq: null, last_seq: 0, messages: [] }, 1), /ambiguity/);
  assert.throws(() => validatePeerWindow({ count: 1, first_seq: 5, last_seq: 5, messages: [{ ...message, seq: 5 }] }, 0), /ambiguity/);
  assert.throws(() => validatePeerWindow({ count: 2, first_seq: 1, last_seq: 1, messages: [message, message] }, 0), /duplicate/);
  assert.throws(() => validatePeerWindow({ count: 1, first_seq: 1, last_seq: 1, messages: [message] }, 1), /duplicate/);
  assert.throws(() => validatePeerWindow({ count: 0, first_seq: null, last_seq: 1, messages: [] }, 0), /incomplete/);
});

test("wrong DID/unexpected internal message stops intake after persistence and BEFORE ACK", async () => {
  const f = await fixture(), s = await f.start();
  try {
    const p = proposal(f.policy, "bob", f.policy.members.find(m => m.alias === "eve")!.did);
    f.transport.readOverride = async () => ({ count: 1, first_seq: 1, last_seq: 1, messages: [{ seq: 1, ts: "fixture", from: f.policy.members.find(m => m.alias === "dave")!.did, nonce: 1, text: JSON.stringify(p) }] });
    await s.receive("bob");
    assert.equal(s.snapshot().lifecycle, "halted");
    assert.equal(Object.values(s.snapshot().receipts)[0]!.status, "persisted");
    const stores = createStores(sessionDirectory(f.tmp.path, f.policy.sessionId));
    assert.equal(await stores.cursors.get("bob", (await f.stores.mailboxes.load("bob")).room), 0);
    const agent = JSON.parse(await readFile(resolve(sessionDirectory(f.tmp.path, f.policy.sessionId), "agents", "bob", "state.json"), "utf8"));
    assert.equal(Object.values(agent.tasks).some((t: any) => t.type === "inbound.message"), true);
  } finally { await s.stop(); await f.tmp.cleanup(); }
});

test("crash while sending is ambiguous, durable match is observation only, and no nonce reset/retry", async () => {
  const f = await fixture(), s = await f.start();
  try {
    const root = await s.submit("bob", proposal(f.policy, "bob")); await s.delegate(root, "dave", "workload.review", input("workload.review"));
    let during;
    f.transport.beforeWrite = async () => { during = await SessionStateStore.read(f.tmp.path, f.policy.sessionId); };
    await s.step(); await s.step();
    assert.ok(during);
    const interrupted = classifyInterruptedSession(during!);
    assert.equal(Object.values(interrupted.effects)[0]!.status, "ambiguous"); assert.equal(interrupted.lifecycle, "halted");
    const effect = Object.values(s.snapshot().effects)[0]!, sender = s.authority.member(effect.source).did;
    const view = { count: 1, first_seq: 1, last_seq: 1, messages: [{ seq: 1, ts: "fixture", from: sender, text: effect.text, nonce: effect.nonce! }] };
    assert.equal(classifyEffectObservation(effect, sender, view).observation, "observed");
    assert.equal(classifyEffectObservation(effect, sender, view).decision, "needs-operator");
    await untilIdle(s);
    assert.equal(f.transport.writes, 2);
    const beforeNonce = await readFile(resolve(sessionDirectory(f.tmp.path, f.policy.sessionId), "nonces.json"), "utf8");
    await s.stop();
    assert.equal(await readFile(resolve(sessionDirectory(f.tmp.path, f.policy.sessionId), "nonces.json"), "utf8"), beforeNonce);
  } finally { await s.stop(); await f.tmp.cleanup(); }
});

test("bounded inference timeout halts compute without effects or repeated prompts", async () => {
  const f = await fixture(); f.policy.limits.inferenceTimeoutMs = 10;
  const provider = new DeterministicInferenceProvider(async () => new Promise(() => undefined));
  const s = await SwarmSessionSupervisor.start({ root: f.tmp.path, policy: f.policy, reviewedPolicyHash: hashValue(f.policy), passphrases: secrets.provider, offlineTransport: f.transport, inference: provider });
  try {
    const root = await s.submit("bob", proposal(f.policy, "bob")); await untilIdle(s);
    assert.equal(s.snapshot().tasks[root]!.compute, "ambiguous"); assert.equal(s.snapshot().budgets.inference, 1); assert.equal(f.transport.writes, 0);
  } finally { await s.stop(); await f.tmp.cleanup(); }
});

test("payload mutation before nonce reservation invalidates session approval", async () => {
  const f = await fixture(), s = await f.start();
  const original = AgentRuntime.prototype.approveOutboundTask;
  let changed = false;
  AgentRuntime.prototype.approveOutboundTask = async function (id, hash) {
    await original.call(this, id, hash);
    if (!changed) {
      changed = true;
      const state = await this.state.load(); state.tasks[id]!.payload.text = "tampered fixture";
      await atomicWriteJson(this.state.path, state);
    }
  };
  try {
    const root = await s.submit("bob", proposal(f.policy, "bob")); await s.delegate(root, "dave", "workload.review", input("workload.review"));
    await untilIdle(s);
    assert.equal(s.snapshot().lifecycle, "halted"); assert.equal(f.transport.writes, 0); assert.equal(s.snapshot().budgets.outbound, 0);
    assert.equal(Object.values(s.snapshot().effects).every(e => e.nonce === undefined), true);
  } finally { AgentRuntime.prototype.approveOutboundTask = original; await s.stop(); await f.tmp.cleanup(); }
});

test("destination mutation after nonce reservation fails final dispatch check with zero POSTs", async () => {
  const f = await fixture(), s = await f.start();
  const original = NonceStore.prototype.reserve;
  NonceStore.prototype.reserve = async function (did, room) {
    const nonce = await original.call(this, did, room);
    const wrong = await f.stores.mailboxes.load("eve");
    await f.stores.contacts.add("bob", "dave", s.authority.member("dave").did, wrong.room);
    return nonce;
  };
  try {
    const root = await s.submit("bob", proposal(f.policy, "bob")); await s.delegate(root, "dave", "workload.review", input("workload.review"));
    await untilIdle(s); assert.equal(s.snapshot().lifecycle, "halted"); assert.equal(f.transport.writes, 0);
    const bytes = await readFile(resolve(sessionDirectory(f.tmp.path, f.policy.sessionId), "nonces.json"), "utf8");
    assert.ok(bytes.length > 0); // Reservation stays consumed, never reset for the blocked dispatch.
  } finally { NonceStore.prototype.reserve = original; await s.stop(); await f.tmp.cleanup(); }
});

test("withholding the exact effect grant produces no signature dispatch or nonce reservation", async () => {
  const f = await fixture(), s = await f.start();
  const original = ActionApprovalStore.prototype.grant;
  ActionApprovalStore.prototype.grant = async function () { throw new Error("Fixture denied approval"); };
  try {
    const root = await s.submit("bob", proposal(f.policy, "bob")); await s.delegate(root, "dave", "workload.review", input("workload.review"));
    await untilIdle(s); assert.equal(f.transport.writes, 0); assert.equal(s.snapshot().budgets.outbound, 0);
  } finally { ActionApprovalStore.prototype.grant = original; await s.stop(); await f.tmp.cleanup(); }
});

test("generic reconciliation requires separate exact approval, reads once, never resends and preserves session/cursor/nonce", async () => {
  const f = await fixture(), s = await f.start();
  try {
    const root = await s.submit("bob", proposal(f.policy, "bob")); await s.delegate(root, "dave", "workload.review", input("workload.review"));
    f.transport.failure = "timeout"; await untilIdle(s); await s.stop();
    const effect = Object.values(s.snapshot().effects)[0]!;
    const sessionBefore = await readFile(resolve(sessionDirectory(f.tmp.path, f.policy.sessionId), "session.json"), "utf8");
    const nonceBefore = await readFile(resolve(sessionDirectory(f.tmp.path, f.policy.sessionId), "nonces.json"), "utf8");
    const recovery = new PeerEffectReconciliation(f.tmp.path, f.policy.sessionId, f.transport);
    const action = await recovery.prepare(effect.id);
    await assert.rejects(recovery.observe(effect.id, action.actionHash), /approval required/);
    assert.equal(f.transport.reads, 0);
    await recovery.authorize(effect.id, action.actionHash);
    const result = await recovery.observe(effect.id, action.actionHash);
    assert.equal(result.observation, "not-observed"); assert.equal(result.decision, "needs-operator");
    assert.equal(f.transport.reads, 1); assert.equal(f.transport.writes, 1);
    await assert.rejects(recovery.observe(effect.id, action.actionHash), /spent/);
    assert.equal(f.transport.reads, 1);
    assert.equal(await readFile(resolve(sessionDirectory(f.tmp.path, f.policy.sessionId), "session.json"), "utf8"), sessionBefore);
    assert.equal(await readFile(resolve(sessionDirectory(f.tmp.path, f.policy.sessionId), "nonces.json"), "utf8"), nonceBefore);
  } finally { await s.stop(); await f.tmp.cleanup(); }
});

test("bounded scheduled intake is opt-in, fair across peers and stops at the reviewed round budget", async () => {
  const f = await fixture(); f.policy.intake = { aliases: ["bob", "eve"], intervalMs: 1000, maxRounds: 1 };
  const s = await f.start();
  try {
    await untilIdle(s); assert.equal(f.transport.reads, 2); assert.equal(f.transport.writes, 0);
    assert.equal(s.snapshot().intake.bob?.rounds, 1); assert.equal(s.snapshot().intake.eve?.rounds, 1);
    await untilIdle(s); assert.equal(f.transport.reads, 2);
  } finally { await s.stop(); await f.tmp.cleanup(); }
});

test("legacy external requests remain proposals; replay/changed content does not create new work", async () => {
  const f = await fixture(), s = await f.start();
  try {
    let seq = 0;
    const legacy = { version: 1, id: "external_fixture", from: externalDid, workload: "workload.research", payload: input("workload.research") };
    f.transport.readOverride = async () => ({ count: 1, first_seq: 1, last_seq: ++seq, messages: [{ seq, ts: new Date().toISOString(), from: externalDid, nonce: seq, text: JSON.stringify(legacy) }] });
    await s.receive("bob");
    assert.equal(Object.values(s.snapshot().proposals).filter(p => p.status === "needs-operator").length, 1);
    await s.receive("bob");
    assert.equal(Object.values(s.snapshot().proposals).filter(p => p.status === "needs-operator").length, 1);
    legacy.payload.objective = "Changed fixture"; await s.receive("bob");
    assert.equal(Object.values(s.snapshot().proposals).some(p => p.status === "rejected"), true);
    assert.equal(Object.keys(s.snapshot().tasks).length, 0);
  } finally { await s.stop(); await f.tmp.cleanup(); }
});

test("stop during in-flight inference is bounded, releases runtimes and starts no outbound work", async () => {
  const f = await fixture(); f.policy.limits.inferenceTimeoutMs = 25;
  let entered!: () => void; const began = new Promise<void>(r => { entered = r; });
  const s = await SwarmSessionSupervisor.start({ root: f.tmp.path, policy: f.policy, reviewedPolicyHash: hashValue(f.policy), passphrases: secrets.provider,
    offlineTransport: f.transport, inference: new DeterministicInferenceProvider(async () => { entered(); return new Promise(() => undefined); }) });
  try {
    const root = await s.submit("bob", proposal(f.policy, "bob")); await s.delegate(root, "dave", "workload.review", input("workload.review"));
    const running = s.step(); await began; await s.stop(); await running;
    assert.equal(s.snapshot().lifecycle, "stopped"); assert.equal(f.transport.writes, 0);
    await assert.rejects(s.step(), /inactive/);
  } finally { await s.stop(); await f.tmp.cleanup(); }
});

test("CLI status/capabilities and runtime journal contain no capabilities, encrypted blobs, passphrases or signatures", async () => {
  const f = await fixture(), s = await f.start();
  const previousRoot = process.env.TECHNOCORE_HOME;
  const originalLog = console.log, originalError = console.error;
  const output: string[] = [];
  console.log = (...args: unknown[]) => { output.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { output.push(args.map(String).join(" ")); };
  try {
    const root = await s.submit("bob", proposal(f.policy, "bob")); await s.delegate(root, "dave", "workload.review", input("workload.review")); await untilIdle(s);
    process.env.TECHNOCORE_HOME = f.tmp.path;
    const policyPath = resolve(f.tmp.path, "policy.json"); await atomicWriteJson(policyPath, f.policy);
    await peerSessionCommand("swarm:status", [f.policy.sessionId]);
    await peerSessionCommand("peer:capabilities", ["bob", "--policy", policyPath, "--policy-hash", hashValue(f.policy)]);
    for (const alias of peerAliases) {
      const journal = resolve(sessionDirectory(f.tmp.path, f.policy.sessionId), "agents", alias, "journal.jsonl");
      try { output.push(await readFile(journal, "utf8")); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    }
    const emitted = output.join("\n");
    assert.equal(emitted.includes(secrets.passphrase.toString("hex")), false);
    for (const alias of peerAliases) {
      const mailbox = await f.stores.mailboxes.load(alias); assert.equal(emitted.includes(mailbox.room), false);
      const identity = JSON.parse(await readFile(resolve(f.stores.paths.identities, `${alias}.json`), "utf8"));
      assert.equal(emitted.includes(identity.encryptedPrivateKey.ciphertext), false);
    }
    assert.doesNotMatch(emitted, /"(?:sig|signature|privateKey|encryptedPrivateKey|passphrase)"\s*:/u);
  } finally {
    console.log = originalLog; console.error = originalError;
    if (previousRoot === undefined) delete process.env.TECHNOCORE_HOME; else process.env.TECHNOCORE_HOME = previousRoot;
    await s.stop(); await f.tmp.cleanup();
  }
});

test("repeated pair sends reserve strictly increasing per-DID/room nonces", async () => {
  const f = await fixture(), s = await f.start();
  try {
    const root = await s.submit("bob", proposal(f.policy, "bob"));
    await s.delegate(root, "dave", "workload.review", input("workload.review")); await untilIdle(s);
    await s.delegate(root, "dave", "workload.review", { ...input("workload.review"), question: "Review a second distinct task" }); await untilIdle(s);
    const effects = Object.values(s.snapshot().effects).filter(e => e.source === "bob" && e.target === "dave");
    assert.equal(effects.length, 2); assert.ok(BigInt(effects[1]!.nonce!) > BigInt(effects[0]!.nonce!));
    assert.equal(s.snapshot().budgets.inference, 3); assert.equal(f.transport.writes, 4);
  } finally { await s.stop(); await f.tmp.cleanup(); }
});

for (const budget of ["gets", "outbound", "inference"] as const) {
  test(`${budget} budget halts before an excess operation`, async () => {
    const f = await fixture(); f.policy.limits[budget] = 1; const s = await f.start();
    try {
      const root = await s.submit("bob", proposal(f.policy, "bob")); await s.delegate(root, "dave", "workload.review", input("workload.review")); await untilIdle(s);
      assert.equal(s.snapshot().lifecycle, "halted"); assert.equal(s.snapshot().budgets[budget], 1);
      if (budget === "gets") assert.equal(f.transport.reads, 1);
      if (budget === "outbound") assert.equal(f.transport.writes, 1);
    } finally { await s.stop(); await f.tmp.cleanup(); }
  });
}

test("retention and epoch ambiguity never advance the session cursor or retry the GET", async () => {
  const f = await fixture(), s = await f.start();
  try {
    const state = createStores(sessionDirectory(f.tmp.path, f.policy.sessionId));
    const room = (await f.stores.mailboxes.load("bob")).room;
    await state.cursors.advance("bob", room, 1);
    f.transport.readOverride = async () => ({ count: 0, first_seq: null, last_seq: 0, messages: [] });
    await s.receive("bob"); assert.equal(s.snapshot().lifecycle, "halted");
    assert.equal(await state.cursors.get("bob", room), 1); assert.equal(f.transport.reads, 1);
    await assert.rejects(s.receive("bob"), /inactive/); assert.equal(f.transport.reads, 1);
  } finally { await s.stop(); await f.tmp.cleanup(); }
});

async function externalJob(alias: PeerAlias = "bob", withContact = true, chain = false, limits: Partial<SessionPolicy["limits"]> = {}) {
  const f = await fixture();
  Object.assign(f.policy.limits, limits);
  const mailbox = await f.stores.mailboxes.create("externalfixture", externalDid);
  if (withContact) await f.stores.contacts.add(alias, "externalfixture", externalDid, mailbox.room);
  const localMailbox = await f.stores.mailboxes.load(alias);
  await f.stores.contacts.add("externalfixture", alias, f.policy.members.find(m => m.alias === alias)!.did, localMailbox.room);
  const p = proposal(f.policy, alias, externalDid);
  const externalBridge = createBridge(f.transport, f.tmp.path, secrets.provider);
  const enqueueExternal = async (value = p) => {
    const text = JSON.stringify(value);
    const approval = await approveContactSend(externalBridge, f.stores, "externalfixture", alias, text);
    await externalBridge.sendTo("externalfixture", alias, text, approval);
  };
  await enqueueExternal(); f.transport.writes = 0;
  const original = await snapshotInputs(f.tmp.path);
  const s = await f.start(); await s.receive(alias);
  const pending = Object.values(s.snapshot().proposals).find(v => v.trust === "external")!;
  assert.equal(pending.status, "needs-operator"); assert.equal(Object.keys(s.snapshot().tasks).length, 0);
  const bob = f.policy.members.find(m => m.alias === "bob")!.did, dave = f.policy.members.find(m => m.alias === "dave")!.did;
  const scope = { workloads: chain ? ["workload.research", "workload.review"] : [defaultWork[alias]],
    pairs: chain ? [pairId(bob, dave), pairId(dave, bob)] : [], maxTasks: chain ? 3 : 1, approvalHash: "" };
  scope.approvalHash = hashValue({ proposalId: pending.id, expectedHash: pending.hash, workloads: scope.workloads, pairs: scope.pairs, maxTasks: scope.maxTasks });
  const root = await s.approveExternal(pending.id, pending.hash, scope);
  let selected = root;
  if (chain) {
    const review = await s.delegate(root, "dave", "workload.review", input("workload.review"));
    selected = await s.delegate(review, "bob", "workload.research", { ...input("workload.research"), objective: "Synthesize the supplied review evidence" });
  }
  await untilIdle(s);
  assert.equal(s.snapshot().tasks[selected]!.compute, "result-ready");
  const directory = sessionDirectory(f.tmp.path, f.policy.sessionId);
  const service = () => new ExternalJobDelivery({ root: f.tmp.path, sessionId: f.policy.sessionId, passphrases: secrets.provider, offlineTransport: f.transport });
  return { ...f, s, root, selected, pending, original, mailbox, directory, service, enqueueExternal, p,
    ledger: () => readFile(resolve(directory, "inference-usage.json"), "utf8") };
}

for (const alias of ["bob", "charlie", "dave", "eve"] as PeerAlias[]) {
  test(`external completed ${alias} result is delivered directly once, with separate exact authority and no compute replay`, async () => {
    const f = await externalJob(alias);
    try {
      const ledger = await f.ledger();
      await assert.rejects(f.service().prepare(f.pending.id, f.selected)); // Active sessions cannot be resumed through delivery.
      await f.s.stop();
      const checkpoint = await readFile(resolve(f.directory, "session.json"), "utf8");
      const reply = await f.service().prepare(f.pending.id, f.selected);
      assert.equal(reply.compute, "completed"); assert.equal(reply.delivery, "response-prepared");
      assert.equal(reply.responderAlias, alias); assert.equal(reply.requesterDid, externalDid);
      assert.ok(reply.actionHash); assert.ok(reply.actionId);
      const fresh = f.service();
      assert.deepEqual(await fresh.prepare(f.pending.id, f.selected), reply);
      await assert.rejects(fresh.send(reply.effectId, reply.actionHash)); assert.equal(f.transport.writes, 0);
      await assert.rejects(fresh.authorize(reply.effectId, "0".repeat(64)));
      await fresh.authorize(reply.effectId, reply.actionHash);
      const sent = await f.service().send(reply.effectId, reply.actionHash);
      assert.equal(sent.delivery, "sent"); assert.equal(sent.completion, "completed"); assert.equal(sent.postAttempts, 1);
      await assert.rejects(f.service().send(reply.effectId, reply.actionHash)); assert.equal(f.transport.writes, 1);
      const received = await f.transport.readRoomJson(f.mailbox.room);
      assert.equal(received.count, 1);
      const envelope = JSON.parse(received.messages[0]!.text);
      assert.equal(envelope.kind, "external-result"); assert.equal(envelope.proposalId, f.p.proposalId);
      assert.equal(envelope.responderDid, f.policy.members.find(m => m.alias === alias)!.did);
      assert.equal(envelope.requesterDid, externalDid); assert.equal(envelope.evidenceRefs.length, 1);
      assert.equal(envelope.evidenceRefs[0].inferenceAttemptId, JSON.parse(ledger).attempts[0].attemptId);
      assert.deepEqual(envelope.output, f.s.snapshot().tasks[f.selected]!.evidence!.output);
      assert.equal(await f.ledger(), ledger); assert.equal(await readFile(resolve(f.directory, "session.json"), "utf8"), checkpoint);
      assert.deepEqual(await snapshotInputs(f.tmp.path), f.original);
      assert.equal(Object.values(f.s.snapshot().tasks).some(t => t.alias === "alice"), false);
    } finally { await f.s.stop(); await f.tmp.cleanup(); }
  });
}

test("external X -> Bob -> Dave -> Bob -> X preserves provenance, child evidence and three distinct compute attempts", async () => {
  const f = await externalJob("bob", true, true);
  try {
    await f.s.stop(); const ledger = await f.ledger();
    const reply = await f.service().prepare(f.pending.id, f.selected);
    assert.ok(reply.actionHash); assert.equal(reply.evidenceRefs!.length, 3);
    const attempts = JSON.parse(ledger).attempts;
    assert.equal(attempts.length, 3); assert.equal(attempts.filter((a: any) => a.context.taskId === f.root).length, 1);
    for (const a of attempts) { assert.equal(a.context.rootRequesterDid, externalDid); assert.equal(a.context.rootOrigin, "external"); }
    await f.service().authorize(reply.effectId, reply.actionHash);
    const result = await f.service().send(reply.effectId, reply.actionHash);
    assert.equal(result.delivery, "sent"); assert.equal(await f.ledger(), ledger);
    assert.equal(Object.values(f.s.snapshot().tasks).some(t => t.alias === "alice"), false);
    assert.equal(f.transport.writes, 5); // Four internal proposal/result effects plus one external reply.
  } finally { await f.s.stop(); await f.tmp.cleanup(); }
});

for (const failure of ["timeout", "503", "reset", "malformed", "400"] as const) {
  test(`${failure} external delivery preserves compute and never resends or treats absence as non-commit`, async () => {
    const f = await externalJob();
    try {
      await f.s.stop(); const ledger = await f.ledger(), snapshot = await readFile(resolve(f.directory, "session.json"), "utf8");
      const reply = await f.service().prepare(f.pending.id, f.selected); assert.ok(reply.actionHash);
      await f.service().authorize(reply.effectId, reply.actionHash); f.transport.failure = failure;
      const result = await f.service().send(reply.effectId, reply.actionHash);
      assert.equal(result.compute, "completed"); assert.equal(result.delivery, failure === "400" ? "failed" : "delivery-ambiguous");
      assert.equal(result.postAttempts, 1); assert.equal(f.transport.writes, 1);
      await assert.rejects(f.service().send(reply.effectId, reply.actionHash));
      const observed = await f.service().observeRetained(reply.effectId, { count: 0, first_seq: null, last_seq: 0, messages: [] });
      assert.equal(observed.observation, "not-observed"); assert.equal(observed.decision, "needs-operator");
      assert.equal(observed.compute, "completed"); assert.equal(observed.delivery, result.delivery);
      assert.equal(await f.ledger(), ledger); assert.equal(await readFile(resolve(f.directory, "session.json"), "utf8"), snapshot);
      assert.equal(f.transport.writes, 1);
    } finally { await f.s.stop(); await f.tmp.cleanup(); }
  });
}

test("missing reply contact stays needs-operator and cannot create a contact", async () => {
  const f = await externalJob("bob", false);
  try {
    await f.s.stop(); const before = await snapshotInputs(f.tmp.path);
    await assert.rejects(f.service().prepare(f.pending.id, f.selected));
    assert.equal((await f.service().jobs())[0]!.replyDestination, "needs-operator");
    assert.deepEqual(await snapshotInputs(f.tmp.path), before); assert.equal(f.transport.writes, 0);
  } finally { await f.s.stop(); await f.tmp.cleanup(); }
});

for (const mutation of ["contact", "payload", "work-scope"] as const) {
  test(`${mutation} mutation invalidates external response authority before nonce reservation`, async () => {
    const f = await externalJob();
    try {
      await f.s.stop(); const reply = await f.service().prepare(f.pending.id, f.selected); assert.ok(reply.actionHash);
      await f.service().authorize(reply.effectId, reply.actionHash);
      const stateStores = createStores(f.directory), before = await stateStores.nonces.last(f.policy.members.find(m => m.alias === "bob")!.did, f.mailbox.room);
      if (mutation === "contact") {
        const other = await f.stores.mailboxes.create("alternativefixture", externalDid);
        await f.stores.contacts.add("bob", "externalfixture", externalDid, other.room);
      } else if (mutation === "payload") {
        const path = resolve(f.directory, "external-deliveries", `${reply.effectId}.json`);
        const r = JSON.parse(await readFile(path, "utf8")); r.envelope.output = { changed: true }; await atomicWriteJson(path, r);
      } else {
        const path = resolve(f.directory, "session.json"), r = JSON.parse(await readFile(path, "utf8"));
        r.jobs[f.s.snapshot().tasks[f.root]!.jobId].root.operatorScope.maxTasks = 99; await atomicWriteJson(path, r);
      }
      await assert.rejects(f.service().send(reply.effectId, reply.actionHash));
      assert.equal(f.transport.writes, 0);
      assert.equal(await stateStores.nonces.last(f.policy.members.find(m => m.alias === "bob")!.did, f.mailbox.room), before);
    } finally { await f.s.stop(); await f.tmp.cleanup(); }
  });
}

test("external duplicate intake cannot create a second job/compute/response; changed replay revokes further work", async () => {
  const f = await externalJob();
  try {
    const ledger = await f.ledger();
    await f.enqueueExternal(); await f.s.receive("bob"); await untilIdle(f.s);
    assert.equal(Object.keys(f.s.snapshot().jobs).length, 1); assert.equal(await f.ledger(), ledger);
    const changed = { ...f.p, objective: "Changed content under the same identifier" };
    await f.enqueueExternal(changed); await f.s.receive("bob");
    assert.equal(f.s.snapshot().proposals[f.pending.id]!.status, "rejected");
    await f.s.stop(); await assert.rejects(f.service().prepare(f.pending.id, f.selected));
    assert.equal(Object.keys(f.s.snapshot().jobs).length, 1); assert.equal(await f.ledger(), ledger);
  } finally { await f.s.stop(); await f.tmp.cleanup(); }
});

test("external status CLI and restart inspection do not unlock, rerun, mutate state or disclose capabilities", async () => {
  const f = await externalJob();
  try {
    await f.s.stop(); const reply = await f.service().prepare(f.pending.id, f.selected);
    const path = resolve(f.directory, "external-deliveries", `${reply.effectId}.json`);
    const r = JSON.parse(await readFile(path, "utf8")); r.status = "sending"; r.postAttempts = 1; r.nonce = "1";
    await atomicWriteJson(path, r); const before = await readFile(path, "utf8"), ledger = await f.ledger();
    const service = new ExternalJobDelivery({ root: f.tmp.path, sessionId: f.policy.sessionId, passphrases: async () => { throw new Error("Must not unlock"); } });
    assert.equal((await service.inspect(reply.effectId)).delivery, "delivery-ambiguous");
    const output = execFileSync(process.execPath, [resolve("dist/src/cli.js"), "external:response-status", f.policy.sessionId, reply.effectId],
      { encoding: "utf8", env: { ...process.env, TECHNOCORE_HOME: f.tmp.path } });
    assert.equal(JSON.parse(output).compute, "completed"); assert.equal(output.includes(f.mailbox.room), false);
    for (const forbidden of ["encryptedPrivateKey", "privateKey", "passphrase", '"sig"', '"signature"']) assert.equal(output.includes(forbidden), false);
    assert.equal(await readFile(path, "utf8"), before); assert.equal(await f.ledger(), ledger); assert.equal(f.transport.writes, 0);
  } finally { await f.s.stop(); await f.tmp.cleanup(); }
});

for (const mutation of ["contact", "approval"] as const) {
  test(`external ${mutation} mutation after nonce reservation blocks dispatch without reclaiming the nonce`, async () => {
    const f = await externalJob(), reserve = NonceStore.prototype.reserve;
    try {
      await f.s.stop(); const ledger = await f.ledger();
      const reply = await f.service().prepare(f.pending.id, f.selected); assert.ok(reply.actionHash); assert.ok(reply.actionId);
      await f.service().authorize(reply.effectId, reply.actionHash);
      NonceStore.prototype.reserve = async function (did, room) {
        const nonce = await reserve.call(this, did, room);
        if (mutation === "contact") {
          const alternative = await f.stores.mailboxes.load("eve");
          await f.stores.contacts.add("bob", "externalfixture", externalDid, alternative.room);
        } else {
          await new ActionApprovalStore(resolve(f.directory, "external-response-approvals")).finish("bob", reply.actionId!, "failed");
        }
        return nonce;
      };
      await f.service().send(reply.effectId, reply.actionHash);
      assert.equal(f.transport.writes, 0);
      const nonces = createStores(f.directory).nonces;
      const nonce = await nonces.last(f.policy.members.find(m => m.alias === "bob")!.did, f.mailbox.room);
      assert.ok(nonce);
      await assert.rejects(f.service().send(reply.effectId, reply.actionHash));
      assert.equal(await nonces.last(f.policy.members.find(m => m.alias === "bob")!.did, f.mailbox.room), nonce);
      assert.equal(await f.ledger(), ledger);
      assert.equal(f.s.snapshot().tasks[f.selected]!.compute, "result-ready");
    } finally { NonceStore.prototype.reserve = reserve; await f.s.stop(); await f.tmp.cleanup(); }
  });
}

test("bounded external envelope refuses oversize output without delivery or new inference", async () => {
  const f = await externalJob("bob", true, false, { payloadBytes: 1024 });
  try {
    await f.s.stop(); const ledger = await f.ledger();
    await assert.rejects(f.service().prepare(f.pending.id, f.selected));
    assert.equal(f.transport.writes, 0); assert.equal(await f.ledger(), ledger);
    assert.equal(f.s.snapshot().tasks[f.selected]!.compute, "result-ready");
  } finally { await f.s.stop(); await f.tmp.cleanup(); }
});

test("crash after exact approval consumption cannot mint replacement response authority", async () => {
  const f = await externalJob();
  try {
    await f.s.stop(); const reply = await f.service().prepare(f.pending.id, f.selected); assert.ok(reply.actionHash); assert.ok(reply.actionId);
    await f.service().authorize(reply.effectId, reply.actionHash);
    const approvals = new ActionApprovalStore(resolve(f.directory, "external-response-approvals"));
    const action = await approvals.read("bob", reply.actionId);
    await approvals.consume(action, action.actionId); // Simulated process death before nonce reservation.
    const ledger = await f.ledger();
    await f.service().prepare(f.pending.id, f.selected);
    await assert.rejects(f.service().authorize(reply.effectId, reply.actionHash));
    await assert.rejects(f.service().send(reply.effectId, reply.actionHash));
    assert.equal((await approvals.read("bob", reply.actionId)).status, "executing");
    assert.equal(f.transport.writes, 0); assert.equal(await f.ledger(), ledger);
  } finally { await f.s.stop(); await f.tmp.cleanup(); }
});

test("an external response consumes remaining shared POST budget and refuses an exhausted budget", async () => {
  const f = await externalJob();
  try {
    await f.s.stop(); const path = resolve(f.directory, "session.json");
    const snapshot = JSON.parse(await readFile(path, "utf8"));
    snapshot.budgets.outbound = snapshot.policy.limits.outbound; // Retained usage from prior simulated effects.
    await atomicWriteJson(path, snapshot); const checkpoint = await readFile(path, "utf8"), ledger = await f.ledger();
    const reply = await f.service().prepare(f.pending.id, f.selected); assert.ok(reply.actionHash);
    await f.service().authorize(reply.effectId, reply.actionHash);
    const result = await f.service().send(reply.effectId, reply.actionHash);
    assert.equal(result.compute, "completed"); assert.equal(result.postAttempts, 0); assert.equal(f.transport.writes, 0);
    assert.equal(await f.ledger(), ledger); assert.equal(await readFile(path, "utf8"), checkpoint);
  } finally { await f.s.stop(); await f.tmp.cleanup(); }
});
