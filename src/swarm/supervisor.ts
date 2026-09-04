import { mkdir, readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AgentRuntime } from "../agent/runtime.js";
import { AgentStateStore } from "../agent/state-store.js";
import { AgentRoleStore } from "../agent/roles.js";
import { agentPaths } from "../agent/paths.js";
import { AgentRuntimeLock } from "../agent/runtime-lock.js";
import { ActionApprovalStore, type ExactActionEffect } from "../agent/approvals.js";
import type { InferenceProvider, AgentTask } from "../agent/types.js";
import { defaultInferenceBudgets, type InferenceAccountingOptions } from "../agent/inference-accounting.js";
import { hashValue } from "../agent/util.js";
import { createStores } from "../context.js";
import { atomicWriteJson, ensurePrivateDirectory, pathExists, readJsonFile } from "../fs-safe.js";
import { BridgeError, AmbiguousSendError } from "../errors.js";
import { SignedPostRejectedError, cleanOutbound, outboundDiagnostics } from "../send-diagnostics.js";
import { HttpTechnocoreTransport } from "../transport.js";
import { InMemoryTechnocoreTransport } from "../mock-transport.js";
import type { PassphraseProvider } from "../passphrase.js";
import type { TechnocoreTransport, RoomResponse, SignedMessageEnvelope, ReadRoomOptions } from "../types.js";
import { LocalSwarmRouter, validateWorkRequest } from "./router.js";
import { ExternalTaskRouter } from "./external.js";
import { mailboxOwnerPath } from "./mailbox-owner.js";
import { validateProposal, safePeerText, type WorkProposal } from "./proposal.js";
import { SessionAuthority, peerAliases, pairId, schemaId, type SessionPolicy, type PeerAlias, type RootProvenance } from "./session-policy.js";
import { SessionStateStore, sessionDirectory, validateDag, type PeerTask, type PeerEffect, type PeerSession, type ProposalRecord } from "./session-state.js";
import { validatePeerWindow, classifyEffectObservation } from "./peer-recovery.js";
import { offlinePeerInference } from "./offline-inference.js";

export interface PeerSessionOptions {
  root: string; policy: SessionPolicy; reviewedPolicyHash: string; passphrases: PassphraseProvider;
  inference?: InferenceProvider; offlineTransport?: TechnocoreTransport; now?: () => number;
}
class GuardedApprovals extends ActionApprovalStore {
  constructor(path: string, private readonly guard: (effect: ExactActionEffect, id: string) => Promise<void>) { super(path); }
  override async consume(effect: ExactActionEffect, id?: string) {
    if (!id) throw new BridgeError("Session action id required");
    await this.guard(effect, id); // Shared signer consumes this immediately before nonce reservation.
    return super.consume(effect, id);
  }
}

/** Infrastructure has no DID. No identities or mailbox capabilities are created by this class. */
export class SwarmSessionSupervisor {
  readonly authority: SessionAuthority;
  private readonly runtimes = new Map<PeerAlias, AgentRuntime>();
  private readonly owners: AgentRuntimeLock[] = [];
  private readonly originals: ReturnType<typeof createStores>;
  private readonly stores: Map<PeerAlias, ReturnType<typeof createStores>> = new Map();
  private readonly rooms = new Map<PeerAlias, string>();
  private readonly store: SessionStateStore;
  private readonly transport: TechnocoreTransport;
  private router!: LocalSwarmRouter;
  private activeEffect: PeerEffect | undefined;
  private readOwner: PeerAlias | undefined;
  private stopRequested = false;
  private closed = false;
  private turn = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;

  private constructor(options: PeerSessionOptions, authority: SessionAuthority) {
    this.authority = authority; this.now = options.now ?? Date.now;
    this.originals = createStores(options.root, options.passphrases);
    const directory = sessionDirectory(this.originals.paths.root, authority.policy.sessionId);
    const createdAt = new Date(this.now()).toISOString();
    this.store = new SessionStateStore(directory, { version: 1, sessionId: authority.policy.sessionId, policyHash: authority.hash,
      policy: structuredClone(authority.policy), pid: process.pid, lifecycle: "starting", createdAt, updatedAt: createdAt,
      budgets: { tasks: 0, outbound: 0, gets: 0, inference: 0 }, jobs: {}, tasks: {}, effects: {}, proposals: {}, receipts: {}, recovery: {}, intake: {} });
    this.transport = authority.policy.mode === "offline" ? options.offlineTransport ?? new InMemoryTechnocoreTransport() :
      new HttpTechnocoreTransport(authority.policy.network.origin, { readRetries: 0, rateLimitRetries: 0, readRedirect: "error", writeTimeoutMs: 30000 });
  }
  static async start(options: PeerSessionOptions): Promise<SwarmSessionSupervisor> {
    const authority = new SessionAuthority(options.policy, options.reviewedPolicyHash, options.now);
    if (authority.policy.mode === "configured" && (!options.inference || options.inference.name === "deterministic-local" || options.offlineTransport)) throw new BridgeError("Configured real inference provider required; no offline fallback");
    if (authority.policy.mode === "offline" && options.inference && options.inference.name !== "deterministic-local") throw new BridgeError("Offline session requires an explicitly deterministic provider");
    const s = new SwarmSessionSupervisor(options, authority);
    await ensurePrivateDirectory(resolve(s.store.directory, ".."));
    try { await mkdir(s.store.directory, { mode: 0o700 }); }
    catch { throw new BridgeError("Session id already exists; automatic resume is forbidden"); }
    try {
      // All public bindings and contacts validated before the first unlock; no synthetic replacements.
      for (const member of authority.policy.members) {
        const identity = await s.originals.identities.inspect(member.alias);
        const role = await new AgentRoleStore(agentPaths(s.originals.paths.root, member.alias).directory).load(identity);
        const mailbox = await s.originals.mailboxes.load(member.alias);
        if (identity.did !== member.did || role !== member.role || mailbox.did !== member.did) throw new BridgeError("Existing identity/profile/mailbox binding mismatch");
        if ([...s.rooms.values()].includes(mailbox.room)) throw new BridgeError("Physical mailbox is shared by multiple peers");
        s.rooms.set(member.alias, mailbox.room);
      }
      for (const pair of authority.policy.pairs) await s.checkDestination(pair.sourceDid, pair.targetDid, pair.contactId, pair.destinationHash);
      // Offline simulated cursors/nonces stay isolated; mailbox ownership still excludes other real readers.
      for (const alias of [...peerAliases].sort()) s.owners.push(await AgentRuntimeLock.acquire(mailboxOwnerPath(s.originals.paths.root, s.rooms.get(alias)!)));
      await s.store.save();
      for (const member of authority.policy.members) {
        const local = createStores(s.store.directory, options.passphrases);
        const approvals = new GuardedApprovals(local.paths.approvals, (effect, id) => s.guardApproval(effect, id));
        const stores = { ...local, identities: s.originals.identities, mailboxes: s.originals.mailboxes, contacts: s.originals.contacts,
          nonces: authority.policy.mode === "offline" ? local.nonces : s.originals.nonces,
          cursors: authority.policy.mode === "offline" ? local.cursors : s.originals.cursors, approvals,
          intake: async <T>(_alias: string, operation: () => Promise<T>) => { s.assertActive(); return operation(); } };
        s.stores.set(member.alias, stores);
        const paths = agentPaths(s.store.directory, member.alias);
        const identity = await stores.identities.inspect(member.alias);
        await new AgentStateStore(paths.state).initialize(identity);
        await new AgentRoleStore(paths.directory).assign(identity, member.role);
        const provider = options.inference ?? offlinePeerInference();
        const runtime = await AgentRuntime.start({ identityAlias: member.alias, expectedDid: member.did, stores,
          passphrases: options.passphrases, inference: provider, inferenceAccounting: s.inferenceAccounting(member.alias),
          transport: s.scopedTransport(member.alias), handleSignals: false });
        s.runtimes.set(member.alias, runtime);
      }
      s.router = new LocalSwarmRouter([...s.runtimes].map(([alias, runtime]) => ({ binding: { alias, expectedDid: runtime.did }, runtime })), async request => {
        const node = Object.values(s.data.tasks).find(t => t.alias === request.target.alias && t.parentId &&
          s.data.tasks[t.parentId]?.runtimeTaskId === request.parentTaskId && t.inputHash === hashValue(request.payload) &&
          (request.key === t.id || request.key === hashValue({ source: request.source, parentTaskId: request.parentTaskId, key: t.id })) &&
          hashValue(request.evidence ?? []) === hashValue(t.dependencies.map(dep => s.data.tasks[dep]!.evidence!)));
        if (!node || node.compute !== "planned") throw new BridgeError("Delegation is not bound to an accepted session DAG node");
        s.authorizeNode(node);
      });
      s.data.lifecycle = "active"; s.authority.capabilities.availability("available"); await s.store.save();
      return s;
    } catch {
      s.data.lifecycle = "halted"; s.data.reason = "startup-failed";
      await s.store.save().catch(() => undefined); await s.release();
      throw new BridgeError("Peer session startup failed; opened runtimes released; no network effects");
    }
  }
  private get data(): PeerSession { return this.store.value; }
  snapshot(): PeerSession { return structuredClone(this.data); }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation); this.queue = next.catch(() => undefined); return next;
  }
  private assertActive(): void {
    if (this.stopRequested || this.closed || this.data.lifecycle !== "active") throw new BridgeError("Session authority inactive");
    this.authority.checkTime();
  }
  private budget(key: keyof PeerSession["budgets"]): void {
    this.assertActive();
    if (this.data.budgets[key] >= this.authority.policy.limits[key]) throw new BridgeError("Session budget exhausted");
  }
  private runtime(alias: PeerAlias): AgentRuntime {
    const runtime = this.runtimes.get(alias);
    if (!runtime) throw new BridgeError("Peer runtime unavailable");
    return runtime;
  }
  private inferenceAccounting(alias: PeerAlias): InferenceAccountingOptions {
    return { path: resolve(this.store.directory, "inference-usage.json"),
      budgets: this.authority.policy.inferenceBudgets ?? defaultInferenceBudgets(this.authority.policy.limits.inference),
      timeoutMs: this.authority.policy.limits.inferenceTimeoutMs,
      context: request => {
        const node = Object.values(this.data.tasks).find(t => t.alias === alias && t.runtimeTaskId === request.taskId);
        if (!node || node.compute !== "running") throw new BridgeError("Inference requires a running host-bound DAG task");
        this.authorizeNode(node);
        const root = this.data.jobs[node.jobId]!.root;
        return { agentDid: this.authority.member(alias).did, sessionId: this.data.sessionId, jobId: node.jobId,
          taskId: request.taskId, rootRequesterDid: root.requesterDid, rootOrigin: root.origin, rootTrust: root.trust,
          workloadType: node.workload, workloadVersion: 1, authorityId: this.authority.hash, providerMode: this.authority.policy.mode };
      },
      beforeDispatch: async () => { this.budget("inference"); this.data.budgets.inference++; await this.store.save(); },
    };
  }
  private async checkDestination(source: string, target: string, contactId: string, expectedHash: string): Promise<void> {
    const member = this.authority.policy.members.find(m => m.did === source);
    const recipient = this.authority.policy.members.find(m => m.did === target);
    if (!member || !recipient) throw new BridgeError("Unknown destination peer");
    const contact = await this.originals.contacts.get(member.alias, contactId);
    const mailbox = await this.originals.mailboxes.load(recipient.alias);
    if (contact.did !== target || contact.mailbox !== mailbox.room || mailbox.room !== this.rooms.get(recipient.alias) ||
      hashValue({ room: contact.mailbox, did: contact.did, contactId }) !== expectedHash) throw new BridgeError("Destination/contact binding changed");
  }
  private authorizeNode(node: PeerTask): void {
    this.assertActive();
    const job = this.data.jobs[node.jobId];
    if (!job || hashValue(job.root) !== job.rootHash || node.rootHash !== job.rootHash || node.inputHash !== hashValue(node.input) ||
      node.authorityChain[0] !== this.authority.hash) throw new BridgeError("Job provenance/input/authority binding changed");
    this.authority.workload(this.authority.member(node.alias).did, node.workload);
    if (job.root.origin === "external" && (!job.root.operatorScope || !job.root.operatorScope.workloads.includes(node.workload) || job.tasks.length > job.root.operatorScope.maxTasks)) throw new BridgeError("External job requires exact bounded operator scope");
    if (node.parentId) {
      const parent = this.data.tasks[node.parentId]!;
      this.authority.delegate(this.authority.member(parent.alias).did, this.authority.member(node.alias).did, node.workload, node.depth, job.root);
    }
  }
  private async guardEffect(effect: PeerEffect): Promise<void> {
    this.assertActive();
    const node = this.data.tasks[effect.taskId]!; this.authorizeNode(node);
    const pair = this.authority.pair(this.authority.member(effect.source).did, this.authority.member(effect.target).did, node.workload, this.data.jobs[node.jobId]!.root);
    if (effect.authorityId !== this.authority.hash || hashValue(effect.text) !== effect.payloadHash || effect.destinationHash !== pair.destinationHash ||
      safePeerText(JSON.parse(effect.text), this.authority.policy.limits.payloadBytes) !== effect.text) throw new BridgeError("Outbound payload/authority binding changed");
    await this.checkDestination(pair.sourceDid, pair.targetDid, pair.contactId, effect.destinationHash);
  }
  private async guardApproval(request: ExactActionEffect, id: string): Promise<void> {
    const e = this.activeEffect;
    if (!e || e.actionId !== id || e.status !== "send-prepared" || request.type !== "technocore.send-contact" ||
      request.agentAlias !== e.source || request.agentDid !== this.authority.member(e.source).did || request.payloadHash !== e.payloadHash || request.destinationHash !== e.destinationHash) throw new BridgeError("Exact session effect approval mismatch");
    this.budget("outbound"); await this.guardEffect(e);
  }
  private scopedTransport(alias: PeerAlias): TechnocoreTransport {
    return {
      readRoomText: async () => { throw new BridgeError("Text reads are not session intake"); },
      readRoomJson: async (room, query) => this.read(alias, room, query),
      sendSignedMessage: async (room, envelope) => this.dispatch(alias, room, envelope),
    };
  }
  private async dispatch(alias: PeerAlias, room: string, envelope: SignedMessageEnvelope): Promise<RoomResponse> {
    const e = this.activeEffect;
    if (!e || e.source !== alias || e.status !== "send-prepared" || room !== this.rooms.get(e.target) ||
      envelope.did !== this.authority.member(alias).did || hashValue(envelope.text) !== e.payloadHash) throw new BridgeError("Dispatch differs from authorized effect");
    this.budget("outbound"); await this.guardEffect(e);
    e.status = "sending"; e.nonce = envelope.nonce; this.data.budgets.outbound++; await this.store.save();
    // Durable sending intent is conservative even if the process dies just before this call.
    try {
      await this.guardEffect(e); // Recheck after intent persistence and immediately before IO.
      const result = await this.transport.sendSignedMessage(room, envelope);
      const posted = result.posted;
      if (!posted || !Number.isSafeInteger(posted.seq) || posted.seq < 1 || posted.from !== envelope.did ||
        String(posted.nonce) !== envelope.nonce || hashValue(posted.text) !== e.payloadHash) throw new AmbiguousSendError("Receipt does not bind to the session effect; no retry");
      e.seq = posted.seq; e.status = "sent"; await this.store.save(); return result;
    } catch (error) {
      e.status = error instanceof SignedPostRejectedError ? "failed" : "ambiguous";
      const diagnostics = outboundDiagnostics(error); if (diagnostics) e.diagnostics = cleanOutbound(diagnostics);
      await this.halt("outbound-needs-operator"); throw error;
    }
  }
  private async read(alias: PeerAlias, room: string, query?: ReadRoomOptions): Promise<RoomResponse> {
    if (this.readOwner !== alias || room !== this.rooms.get(alias) || query?.limit !== 200 || query.wait !== 0) throw new BridgeError("Read outside bounded intake authority");
    this.budget("gets"); this.data.budgets.gets++; await this.store.save();
    const view = await this.transport.readRoomJson(room, query);
    validatePeerWindow(view, query.since ?? 0);
    return view;
  }
  private async halt(reason: string): Promise<void> {
    this.data.lifecycle = "halted"; this.data.reason = reason; await this.store.save();
  }
  private async rootTask(alias: PeerAlias, input: WorkProposal, root: RootProvenance): Promise<string> {
    this.budget("tasks"); this.authority.workload(this.authority.member(alias).did, input.workloadType);
    const jobId = hashValue({ session: this.data.sessionId, root: input.proposalId, requester: input.requesterDid });
    if (this.data.jobs[jobId]) throw new BridgeError("Root proposal already submitted; no duplicate job");
    const id = hashValue({ jobId, root: true }), rootHash = hashValue(root);
    this.data.jobs[jobId] = { id: jobId, root: structuredClone(root), rootHash, tasks: [id], status: "accepted" };
    const node: PeerTask = { id, jobId, alias, workload: input.workloadType, input: structuredClone(input.input), inputHash: input.inputHash,
      dependencies: [], depth: 0, authorityChain: [this.authority.hash], rootHash, createdAt: new Date(this.now()).toISOString(), compute: "planned", delivery: "local" };
    this.data.tasks[id] = node; this.data.budgets.tasks++;
    await this.store.save();
    try {
      await this.runtime(alias).enqueueTask({ id, idempotencyKey: `peer:${id}`, type: node.workload, payload: node.input, context: { mode: "explicit-only", evidence: [] } });
      node.runtimeTaskId = id; node.compute = "accepted"; await this.store.save(); return id;
    } catch {
      node.compute = "failed"; this.data.jobs[jobId]!.status = "needs-operator";
      await this.store.save(); throw new BridgeError("Root task persistence failed; no automatic recovery");
    }
  }
  /** Operator-local submission is never an external send or sender-provided authority. */
  submit(alias: PeerAlias, proposal: WorkProposal): Promise<string> {
    return this.serial(async () => {
      this.assertActive(); const p = validateProposal(proposal, this.authority.policy.limits.payloadBytes, this.now());
      if (p.recipientDid !== this.authority.member(alias).did || !this.authority.policy.members.some(m => m.did === p.requesterDid) ||
        p.evidenceRefs.length || p.parentTaskId || p.jobId || p.delegationId) throw new BridgeError("Local root proposal binding invalid");
      return this.rootTask(alias, p, { requesterDid: p.requesterDid, origin: "internal", trust: "operator-local", originalProposalId: p.proposalId });
    });
  }
  delegate(parentId: string, target: PeerAlias, workload: string, input: Record<string, unknown>, dependencies: string[] = [parentId]): Promise<string> {
    return this.serial(async () => {
      this.budget("tasks"); const parent = this.data.tasks[parentId];
      if (!parent || parent.alias === target || !dependencies.includes(parentId) || dependencies.some(id => this.data.tasks[id]?.jobId !== parent.jobId)) throw new BridgeError("Invalid task DAG parent/dependencies");
      const payload = validateWorkRequest(workload, input); safePeerText(payload, this.authority.policy.limits.payloadBytes);
      const id = hashValue({ session: this.data.sessionId, parentId, target, workload, payload, dependencies });
      if (this.data.tasks[id]) return id;
      const node: PeerTask = { id, jobId: parent.jobId, alias: target, workload, input: payload, inputHash: hashValue(payload),
        dependencies: [...dependencies], parentId, depth: parent.depth + 1, authorityChain: [...parent.authorityChain, id], rootHash: parent.rootHash,
        createdAt: new Date(this.now()).toISOString(), compute: "planned", delivery: "planned" };
      const job = this.data.jobs[node.jobId]!;
      if (job.root.operatorScope && job.tasks.length >= job.root.operatorScope.maxTasks) throw new BridgeError("External job task budget exhausted");
      this.authorizeNode(node); this.budget("outbound"); this.budget("inference");
      validateDag({ ...this.data.tasks, [id]: node });
      this.data.tasks[id] = node; job.tasks.push(id); job.status = "running"; this.data.budgets.tasks++; await this.store.save(); return id;
    });
  }
  private proposalFor(node: PeerTask): WorkProposal {
    const parent = this.data.tasks[node.parentId!]!;
    return { version: 1, kind: "peer-work", proposalId: node.id, requesterDid: this.authority.member(parent.alias).did,
      recipientDid: this.authority.member(node.alias).did, workloadType: node.workload, workloadVersion: 1, objective: "Perform the bounded supplied peer workload",
      input: node.input, inputHash: node.inputHash, evidenceRefs: node.dependencies.map(id => this.data.tasks[id]!.evidence!.resultHash),
      requestedOutputSchema: schemaId(node.workload, "output"), jobId: node.jobId, parentTaskId: parent.id, delegationId: node.id,
      replyTo: this.authority.member(parent.alias).did, createdAt: node.createdAt, expiresAt: this.authority.policy.expiresAt,
      provenanceClaims: { mode: this.authority.policy.mode } };
  }
  private async send(node: PeerTask, kind: PeerEffect["kind"]): Promise<void> {
    const parent = this.data.tasks[node.parentId!]!;
    const source = kind === "proposal" ? parent.alias : node.alias, target = kind === "proposal" ? node.alias : parent.alias;
    const text = safePeerText(kind === "proposal" ? this.proposalFor(node) : { version: 1, kind: "peer-result", taskId: node.id, jobId: node.jobId,
      requesterDid: this.authority.member(source).did, recipientDid: this.authority.member(target).did, resultHash: node.evidence!.resultHash,
      mode: this.authority.policy.mode }, this.authority.policy.limits.payloadBytes);
    const id = hashValue({ session: this.data.sessionId, task: node.id, kind });
    if (this.data.effects[id]) throw new BridgeError("Outbound effect already exists; no automatic resend");
    const pair = this.authority.pair(this.authority.member(source).did, this.authority.member(target).did, node.workload, this.data.jobs[node.jobId]!.root);
    const taskId = `peer_send_${id}`, actionId = hashValue({ did: this.authority.member(source).did, taskId, type: "technocore.send-contact" });
    const effect: PeerEffect = { id, taskId: node.id, source, target, kind, actionId, payloadHash: hashValue(text), destinationHash: pair.destinationHash,
      authorityId: this.authority.hash, text, createdAt: new Date(this.now()).toISOString(), status: "send-prepared" };
    this.budget("outbound"); await this.guardEffect(effect); // Before even creating the exact-action record.
    this.data.effects[id] = effect; await this.store.save(); this.activeEffect = effect;
    try {
      const runtime = this.runtime(source);
      await runtime.enqueueTask({ id: taskId, idempotencyKey: taskId, type: "technocore.send-contact", payload: { contactId: pair.contactId, text, expectedRecipientDid: pair.targetDid } });
      const approval = await runtime.requestOutboundApproval(taskId);
      if (approval.actionId !== effect.actionId || approval.payloadHash !== effect.payloadHash || approval.destinationHash !== effect.destinationHash) throw new BridgeError("Prepared effect mismatch");
      await this.guardEffect(effect); await runtime.approveOutboundTask(taskId, approval.actionHash);
      await runtime.runOnce(taskId);
      const task = (await runtime.state.load()).tasks[taskId]!;
      if (task.status !== "succeeded") {
        if (effect.status === "send-prepared") effect.status = "failed";
        await this.halt("outbound-needs-operator"); return;
      }
      if (kind === "result") node.delivery = "sent";
      await this.store.save();
    } finally { this.activeEffect = undefined; }
  }
  /** Exactly one bounded GET; not a polling/backlog/retry loop. */
  receive(alias: PeerAlias): Promise<void> { return this.serial(() => this.receiveOwned(alias)); }
  private async receiveOwned(alias: PeerAlias): Promise<void> {
    this.assertActive(); const runtime = this.runtime(alias); this.readOwner = alias;
    const effects = Object.values(this.data.effects).filter(e => e.target === alias && e.status === "sent");
    for (const e of effects) e.status = "receiving";
    await this.store.save();
    try {
      await runtime.ingestInbox({ validate: async peek => {
        const retained = { alias, previousCursor: peek.previousCursor, firstSeq: peek.firstSeq, lastSeq: peek.lastSeq, messageHashes: peek.messages.map(m => hashValue(m)), status: "persisted" as const };
        const receiptId = hashValue(retained);
        // Bounded raw inbound data is retained privately before semantic validation. Never logged.
        await atomicWriteJson(resolve(this.store.directory, "intake", `${receiptId}.json`), peek);
        this.data.receipts[receiptId] = retained; await this.store.save();
      }, afterPersist: async peek => {
        for (const message of peek.messages) {
          const task = Object.values((await runtime.state.load()).tasks).find(t => t.type === "inbound.message" && t.payload.seq === message.seq);
          if (!task) throw new BridgeError("Durable intake task missing");
          await this.classifyInbound(alias, task);
        }
        for (const effect of effects) if (effect.status !== "received") throw new BridgeError("Expected effect not observed; no retry");
        await this.store.save(); // Proposal/job references before runtime cursor ACK.
      } });
      for (const receipt of Object.values(this.data.receipts)) if (receipt.alias === alias) receipt.status = "acked";
      this.completeJobs();
      await this.store.save();
    } catch {
      for (const effect of effects) if (effect.status !== "received") effect.status = "ambiguous";
      await this.halt("intake-needs-operator");
    } finally { this.readOwner = undefined; }
  }
  private async classifyInbound(alias: PeerAlias, inbound: AgentTask): Promise<void> {
    const sender = String(inbound.payload.senderDid), text = String(inbound.payload.text);
    const internal = this.authority.policy.members.some(m => m.did === sender);
    const id = hashValue({ alias, sender, text });
    const rejected: ProposalRecord = { id, hash: hashValue(text), trust: internal ? "internal" : "unverified", status: "rejected" };
    let parsed: unknown;
    try { if (inbound.payload.serverVerifiedDid !== true) throw new BridgeError("Unverified sender"); parsed = JSON.parse(text); }
    catch { this.data.proposals[id] = rejected; if (internal) throw new BridgeError("Invalid internal receipt"); return; }
    if (internal) {
      const effect = Object.values(this.data.effects).find(e => e.target === alias && this.authority.member(e.source).did === sender && e.payloadHash === hashValue(text));
      if (!effect || effect.status !== "receiving" || effect.seq !== inbound.payload.seq || effect.nonce !== String(inbound.payload.nonce)) throw new BridgeError("Unexpected, replayed, or changed peer message");
      const node = this.data.tasks[effect.taskId]!;
      await this.guardEffect(effect);
      if (effect.kind === "proposal") {
        const p = validateProposal(parsed, this.authority.policy.limits.payloadBytes, this.now());
        if (p.requesterDid !== sender || p.recipientDid !== this.authority.member(alias).did || hashValue(p) !== hashValue(this.proposalFor(node))) throw new BridgeError("Peer proposal metadata mismatch");
        const parent = this.data.tasks[node.parentId!]!;
        const record = await this.router.delegate({ source: { alias: parent.alias, expectedDid: this.authority.member(parent.alias).did },
          target: { alias, expectedDid: this.authority.member(alias).did }, parentTaskId: parent.runtimeTaskId!, key: node.id,
          workload: node.workload, payload: node.input, evidence: node.dependencies.map(dep => this.data.tasks[dep]!.evidence!) });
        node.runtimeTaskId = record.taskId; node.delegationId = record.id; node.compute = "accepted";
        this.data.proposals[id] = { id, hash: hashValue(p), proposal: p, trust: "internal", status: "accepted", jobId: node.jobId };
      } else {
        const p = parsed as Record<string, unknown>;
        if (p.kind !== "peer-result" || p.requesterDid !== sender || p.recipientDid !== this.authority.member(alias).did || p.resultHash !== node.evidence?.resultHash) throw new BridgeError("Result receipt mismatch");
        node.delivery = "received";
      }
      effect.status = "received"; return;
    }
    // Adapt validated generic proposals to the existing work-only external approval machinery.
    let p: WorkProposal;
    try {
      const old = parsed as Record<string, unknown>;
      if (old && old.version === 1 && old.kind === undefined && Object.keys(old).every(k => ["version", "id", "from", "workload", "payload"].includes(k))) {
        if (old.from !== sender || typeof old.workload !== "string") throw new BridgeError("Legacy external sender mismatch");
        const payload = validateWorkRequest(old.workload, old.payload as Record<string, unknown>);
        parsed = { version: 1, kind: "peer-work", proposalId: old.id, requesterDid: sender, recipientDid: this.authority.member(alias).did,
          workloadType: old.workload, workloadVersion: 1, objective: "Legacy bounded external work proposal", input: payload, inputHash: hashValue(payload), evidenceRefs: [],
          requestedOutputSchema: schemaId(old.workload, "output"), replyTo: sender, createdAt: inbound.createdAt, provenanceClaims: { adapter: "legacy-external-v1" } };
      }
      p = validateProposal(parsed, this.authority.policy.limits.payloadBytes, this.now());
      if (p.requesterDid !== sender || p.recipientDid !== this.authority.member(alias).did || p.jobId || p.parentTaskId || p.delegationId || p.evidenceRefs.length) throw new BridgeError("Unknown external scope");
      this.authority.workload(p.recipientDid, p.workloadType);
    } catch { this.data.proposals[id] = rejected; return; }
    const replayKey = hashValue({ alias, sender, proposalId: p.proposalId });
    const prior = this.data.proposals[replayKey];
    if (prior) { if (prior.hash !== hashValue(p)) this.data.proposals[id] = rejected; return; }
    const router = new ExternalTaskRouter(this.runtime(alias), this.authority.policy.members.map(m => m.did), this.originals.contacts);
    const adapted = structuredClone(inbound);
    adapted.payload.text = JSON.stringify({ version: 1, id: p.proposalId, from: sender, workload: p.workloadType, payload: p.input });
    const legacy = await router.classify(adapted);
    this.data.proposals[replayKey] = { id: replayKey, hash: hashValue(p), proposal: p, trust: "external", status: legacy.status === "rejected" ? "rejected" : "needs-operator", legacyId: legacy.id };
  }
  /** Exact local work approval; explicitly excludes all external responses and contact creation. */
  approveExternal(proposalId: string, expectedHash: string, scope: NonNullable<RootProvenance["operatorScope"]>): Promise<string> {
    return this.serial(async () => {
      this.assertActive(); const record = this.data.proposals[proposalId];
      if (!record?.proposal || record.status !== "needs-operator" || record.hash !== expectedHash || scope.approvalHash !== hashValue({ proposalId, expectedHash, workloads: scope.workloads, pairs: scope.pairs, maxTasks: scope.maxTasks })) throw new BridgeError("Exact external work scope approval required");
      const p = validateProposal(record.proposal, this.authority.policy.limits.payloadBytes, this.now());
      if (!Number.isSafeInteger(scope.maxTasks) || scope.maxTasks < 1 || scope.maxTasks > this.authority.policy.limits.tasks ||
        !scope.workloads.includes(p.workloadType) || scope.workloads.some(w => !this.authority.policy.workloads.some(x => x.type === w)) ||
        scope.pairs.some(key => !this.authority.policy.pairs.some(x => pairId(x.sourceDid, x.targetDid) === key))) throw new BridgeError("External scope exceeds session policy");
      const alias = this.authority.policy.members.find(m => m.did === p.recipientDid)!.alias;
      // Existing router records the same work-only approval; session DAG owns execution/provenance.
      const router = new ExternalTaskRouter(this.runtime(alias), this.authority.policy.members.map(m => m.did), this.originals.contacts);
      const legacy = await readJsonFile<{ requestHash: string } | null>(resolve(this.runtime(alias).paths.directory, "external-proposals", `${record.legacyId}.json`), null);
      if (!legacy) throw new BridgeError("External intake approval record missing");
      await router.approve(record.legacyId!, legacy.requestHash);
      const id = await this.rootTask(alias, p, { requesterDid: p.requesterDid, origin: "external", trust: "external-approved", originalProposalId: p.proposalId, operatorScope: structuredClone(scope) });
      record.status = "accepted"; record.jobId = this.data.tasks[id]!.jobId; await this.store.save(); return id;
    });
  }
  /** Fair serial scheduling is intentionally <= every configured concurrency bound. */
  step(): Promise<boolean> { return this.serial(async () => {
    this.assertActive();
    try {
      for (let offset = 0; offset < 5; offset++) {
        const alias = peerAliases[(this.turn + offset) % 5]!;
        const receipt = Object.values(this.data.effects).find(e => e.target === alias && e.status === "sent");
        if (receipt) { this.turn = (this.turn + offset + 1) % 5; await this.receiveOwned(alias); return true; }
        const node = Object.values(this.data.tasks).find(t => t.alias === alias &&
          ((t.compute === "planned" && t.dependencies.every(d => this.data.tasks[d]?.compute === "result-ready" && ["local", "received"].includes(this.data.tasks[d]!.delivery))) ||
            t.compute === "accepted" || (t.compute === "result-ready" && t.delivery === "planned")));
        if (!node) {
          const schedule = this.authority.policy.intake;
          const intake = this.data.intake[alias] ?? { rounds: 0, nextAt: 0 };
          if (schedule?.aliases.includes(alias) && intake.rounds < schedule.maxRounds && this.now() >= intake.nextAt) {
            this.data.intake[alias] = { rounds: intake.rounds + 1, nextAt: this.now() + schedule.intervalMs };
            this.turn = (this.turn + offset + 1) % 5; await this.store.save(); await this.receiveOwned(alias); return true;
          }
          continue;
        }
        this.turn = (this.turn + offset + 1) % 5; this.authorizeNode(node);
        if (node.compute === "planned") await this.send(node, "proposal");
        else if (node.compute === "accepted") {
          this.budget("inference"); node.compute = "running"; await this.store.save();
          const runtime = this.runtime(alias); await runtime.runOnce(node.runtimeTaskId!);
          const task = (await runtime.state.load()).tasks[node.runtimeTaskId!]!;
          if (task.status === "succeeded") { node.evidence = await runtime.exportTaskEvidence(task.id); node.compute = "result-ready"; }
          else { node.compute = task.status === "ambiguous" ? "ambiguous" : "failed"; this.data.jobs[node.jobId]!.status = "needs-operator"; }
          await this.store.save();
        } else await this.send(node, "result");
        this.completeJobs();
        await this.store.save(); return true;
      }
      return false;
    } catch { await this.halt("policy-budget-or-persistence-needs-operator"); return false; }
  }); }
  private completeJobs(): void {
    for (const job of Object.values(this.data.jobs)) if (job.tasks.every(id => this.data.tasks[id]!.compute === "result-ready" && ["local", "received"].includes(this.data.tasks[id]!.delivery))) job.status = "completed";
  }
  /** Offline evidence classification only. Caller supplies an already retained observation; no GET/ACK/approval. */
  observeRetained(effectId: string, view: RoomResponse): Promise<void> {
    return this.serial(async () => {
      const e = this.data.effects[effectId];
      if (!e || !["failed", "ambiguous"].includes(e.status)) throw new BridgeError("Recovery requires a spent effect");
      this.data.recovery[effectId] = classifyEffectObservation(e, this.authority.member(e.source).did, view); await this.store.save();
    });
  }
  async run(): Promise<void> {
    const stop = () => { this.stopRequested = true; };
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
    const timer = setInterval(() => { void pathExists(resolve(this.store.directory, "stop.json")).then(exists => { if (exists) stop(); }).catch(stop); }, 250);
    try {
      while (!this.stopRequested && this.data.lifecycle === "active") {
        if (this.now() >= Date.parse(this.authority.policy.expiresAt)) break;
        await this.drainLocalSubmissions();
        if (!(await this.step())) await new Promise(resolveDelay => setTimeout(resolveDelay, 250));
      }
    } finally { clearInterval(timer); process.off("SIGINT", stop); process.off("SIGTERM", stop); await this.stop(); }
  }
  private async drainLocalSubmissions(): Promise<void> {
    const directory = resolve(this.store.directory, "submissions");
    if (!await pathExists(directory)) return;
    const names = (await readdir(directory)).filter(n => /^[a-f0-9]{64}\.json$/u.test(n)).sort().slice(0, this.authority.policy.limits.tasks);
    for (const name of names) {
      const marker = resolve(this.store.directory, "submission-results", name);
      if (await pathExists(marker)) continue;
      try {
        const bytes = await readFile(resolve(directory, name));
        if (bytes.length > this.authority.policy.limits.payloadBytes + 256) throw new BridgeError("Submission too large");
        const value = JSON.parse(bytes.toString()) as { alias: PeerAlias; proposal: WorkProposal };
        const taskId = await this.submit(value.alias, value.proposal); await atomicWriteJson(marker, { status: "accepted", taskId });
      } catch { await atomicWriteJson(marker, { status: "rejected" }); }
    }
  }
  async stop(): Promise<void> {
    this.stopRequested = true;
    await this.queue; // Each inference/read/write is bounded; no new operation can dispatch after stopRequested.
    if (this.closed) return;
    for (const e of Object.values(this.data.effects)) if (["sending", "receiving"].includes(e.status)) e.status = "ambiguous";
    if (this.data.lifecycle !== "halted") this.data.lifecycle = "stopping";
    try { await this.store.save(); }
    finally {
      await this.release();
      if (this.data.lifecycle !== "halted") this.data.lifecycle = "stopped";
      await this.store.save();
    }
  }
  private async release(): Promise<void> {
    this.closed = true;
    for (const runtime of this.runtimes.values()) await runtime.close(this.data.lifecycle === "halted" ? "failed" : "clean").catch(() => undefined);
    this.runtimes.clear(); this.stores.clear(); this.authority.capabilities.availability("stopped");
    for (const owner of this.owners.reverse()) await owner.release().catch(() => undefined);
    this.owners.length = 0;
  }
}
