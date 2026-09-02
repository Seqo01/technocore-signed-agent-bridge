import { resolve } from "node:path";
import { createStores } from "../context.js";
import { SignedAgentBridge } from "../bridge.js";
import { AmbiguousSendError, BridgeError } from "../errors.js";
import { atomicWriteJson, readJsonFile } from "../fs-safe.js";
import { sanitizeText } from "../protocol.js";
import { HttpTechnocoreTransport } from "../transport.js";
import { InMemoryTechnocoreTransport } from "../mock-transport.js";
import type { TechnocoreTransport } from "../types.js";
import type { PassphraseProvider } from "../passphrase.js";
import { AgentRuntime } from "../agent/runtime.js";
import { AgentRuntimeLock } from "../agent/runtime-lock.js";
import { AgentStateStore } from "../agent/state-store.js";
import { AgentRoleStore } from "../agent/roles.js";
import { agentPaths } from "../agent/paths.js";
import { hashValue } from "../agent/util.js";
import type { AgentTask, InferenceProvider } from "../agent/types.js";
import type { TaskEvidence } from "../agent/evidence.js";
import { validateEvidence } from "../agent/evidence.js";
import { LocalSwarmRouter, validateWorkRequest } from "../swarm/router.js";
import { assertNoSecretLikeOutput } from "../workloads/types.js";
import { ALIASES, TEAM, type Alias } from "./setup.js";
import { validateReceipt } from "./receipt.js";
import { receiveFailure, type ReadProgress, type ReceiveFailure, type ReceiveStage } from "../receive-diagnostics.js";

export const QUESTION = "Assess Technocore room-read reliability and edge behavior, focusing on duplicate delivery, replay handling, retention gaps, room epoch/sequence behavior, and safe agent-side recovery. Produce a concise evidence-backed engineering recommendation.";
export const GRAPH = Object.freeze([
  ["alice", "bob"], ["bob", "alice"], ["alice", "charlie"], ["charlie", "alice"],
  ["alice", "dave"], ["dave", "alice"], ["alice", "eve"], ["eve", "alice"],
].map(pair => Object.freeze(pair as [Alias, Alias])));
export const REHEARSAL_HTTP_OPTIONS = Object.freeze({ readRetries: 0, rateLimitRetries: 0, writeTimeoutMs: 30_000 });
const ID = "first-room-read-v1";
const PARENT = "rehearsal_parent";
const FINAL = "rehearsal_final";
const WORKERS = ["bob", "charlie", "dave", "eve"] as const;
type Worker = typeof WORKERS[number];
type SourceKind = "operator-supplied" | "source-derived" | "deterministic-offline";
export interface AnalysisPacket {
  sources: { kind: SourceKind; summary: string; reference?: string; contentHash?: string }[];
  output: unknown;
}
interface Analysis { packetHash: string; packet: AnalysisPacket; evidence?: TaskEvidence; delegationId?: string }
interface Step {
  status: "planned" | "prepared" | "post-intent" | "sent" | "get-intent" | "received" | "acknowledged";
  text?: string; taskId?: string; actionId?: string; actionHash?: string; payloadHash?: string;
  seq?: number; inboundTaskId?: string;
  failure?: ReceiveFailure;
  observation?: { kind: "live-observation" | "deterministic-offline"; firstSeq: number | null; lastSeq: number; seq: number; messageHash: string };
}
export interface RehearsalState {
  version: 1; id: typeof ID; dids: Record<Alias, string>; destinations: string[];
  mode: "offline" | "live";
  index: number; posts: number; gets: number; halted?: string; complete: boolean;
  steps: Step[]; analyses: Partial<Record<Alias, Analysis>>;
}
type State = RehearsalState;
export interface RehearsalOptions {
  root?: string;
  passphrases: PassphraseProvider;
  /** Trusted test seam. Never accepted by CLI or by an input file. Observations are labeled offline. */
  offlineTransport?: TechnocoreTransport;
}

function packet(value: AnalysisPacket): AnalysisPacket {
  if (!value || Object.keys(value).some(k => !["sources", "output"].includes(k)) ||
    !Array.isArray(value.sources) || !value.sources.length || value.sources.length > 16 || value.output === undefined) {
    throw new BridgeError("Analysis needs explicit provenance and a structured output");
  }
  const serialized = JSON.stringify(value);
  if (serialized.length > 24_000) throw new BridgeError("Analysis packet exceeds rehearsal limit");
  assertNoSecretLikeOutput(serialized, "Rehearsal analysis");
  for (const source of value.sources) {
    if (!source || !["operator-supplied", "source-derived", "deterministic-offline"].includes(source.kind) ||
      typeof source.summary !== "string" || !source.summary || source.summary.length > 2000 ||
      Object.keys(source).some(k => !["kind", "summary", "reference", "contentHash"].includes(k)) ||
      (source.reference !== undefined && (typeof source.reference !== "string" || source.reference.length > 2000)) ||
      (source.contentHash !== undefined && !/^[a-f0-9]{64}$/u.test(source.contentHash)) ||
      (source.kind === "source-derived" && (!source.reference || !source.contentHash))) {
      throw new BridgeError("Invalid provenance; live observations can only be recorded by receipt processing");
    }
  }
  if (/live[- ]verified|"(?:liveVerified|serverVerifiedDid)"\s*:\s*true/iu.test(serialized)) {
    throw new BridgeError("Operator analysis cannot declare itself live-verified");
  }
  return structuredClone(value);
}

/** Fixed first rehearsal. Every method is one bounded operator invocation, never a loop. */
export class FirstRehearsal {
  private readonly stores;
  readonly path: string;
  constructor(private readonly options: RehearsalOptions) {
    this.stores = createStores(options.root, options.passphrases);
    this.path = resolve(this.stores.paths.root, "agents", "alice", "rehearsal", `${ID}.json`);
  }

  private async bindings() {
    const dids = {} as Record<Alias, string>;
    for (const alias of ALIASES) {
      const identity = await this.stores.identities.inspect(alias);
      const paths = agentPaths(this.stores.paths.root, alias);
      const state = await new AgentStateStore(paths.state).load();
      if (state.profile.did !== identity.did || state.profile.identityAlias !== alias ||
        await new AgentRoleStore(paths.directory).load(identity) !== TEAM[alias]) throw new BridgeError("Rehearsal DID/profile/role mismatch");
      dids[alias] = identity.did;
    }
    if (new Set(Object.values(dids)).size !== 5) throw new BridgeError("Rehearsal identities must be distinct");
    const destinations = [];
    for (const [from, to] of GRAPH) {
      const contact = await this.stores.contacts.get(from, to);
      const mailbox = await this.stores.mailboxes.load(to);
      if (contact.did !== dids[to] || mailbox.did !== dids[to] || contact.mailbox !== mailbox.room) throw new BridgeError("Rehearsal contact binding mismatch");
      destinations.push(hashValue({ room: contact.mailbox, did: contact.did, contactId: to }));
    }
    return { dids, destinations };
  }

  private async saved(state: State) { await atomicWriteJson(this.path, state); }
  private async locked<T>(create: boolean, fn: (state: State) => Promise<T>, inspectOnly = false): Promise<T> {
    const guard = await AgentRuntimeLock.acquire(`${this.path}.guard`);
    try {
      const bindings = await this.bindings();
      let state = await readJsonFile<State | null>(this.path, null);
      if (!state && create) {
        state = { version: 1, id: ID, mode: this.options.offlineTransport ? "offline" : "live", ...bindings, index: 0, posts: 0, gets: 0,
          complete: false, steps: GRAPH.map(() => ({ status: "planned" })), analyses: {} };
        await this.saved(state);
      }
      if (!state || state.version !== 1 || state.id !== ID || state.steps.length !== 8 ||
        state.mode !== (this.options.offlineTransport ? "offline" : "live") ||
        !Number.isInteger(state.index) || state.index < 0 || state.index > 8 ||
        !Number.isInteger(state.posts) || state.posts < 0 || state.posts > 8 ||
        !Number.isInteger(state.gets) || state.gets < 0 || state.gets > 8 ||
        hashValue(state.dids) !== hashValue(bindings.dids) || hashValue(state.destinations) !== hashValue(bindings.destinations)) {
        throw new BridgeError("Rehearsal state or destination changed; stop and reconcile");
      }
      if (inspectOnly) return await fn(state);
      if (state.steps.some((step, i) => i < state.index ? step.status !== "acknowledged" :
        i > state.index ? step.status !== "planned" : !["planned", "prepared", "post-intent", "sent", "get-intent", "received"].includes(step.status))) {
        return await this.halt(state, "unexpected-step-state");
      }
      if (state.halted) throw new BridgeError("Rehearsal halted; no automatic continuation or retry");
      if (state.steps.some(s => s.status === "post-intent" || s.status === "get-intent")) {
        state.halted = "interrupted-network-operation"; await this.saved(state);
        throw new BridgeError("Interrupted rehearsal IO; reconcile without retrying");
      }
      return await fn(state);
    } finally { await guard.release(); }
  }

  private async halt(state: State, reason: string): Promise<never> {
    state.halted = reason; await this.saved(state);
    throw new BridgeError(`Rehearsal stopped: ${reason}`);
  }
  private selected(state: State) {
    if (state.index >= 8 || state.complete) throw new BridgeError("No further signed step; synthesis is local only");
    return { step: state.steps[state.index]!, from: GRAPH[state.index]![0], to: GRAPH[state.index]![1] };
  }

  private workRequest(state: State, alias: Worker) {
    const selected = alias === "bob" ? [] : alias === "eve" ? ["charlie"] : alias === "dave" ? ["bob", "charlie"] : ["bob"];
    const evidence = selected.map(name => {
      const value = state.analyses[name as Alias]?.evidence;
      if (!value) throw new BridgeError("Required selected evidence is missing");
      return value;
    });
    validateEvidence({ mode: "explicit-only", evidence });
    const type = { bob: "workload.research", charlie: "workload.engineering", dave: "workload.review", eve: "workload.specialist" }[alias];
    const payload = alias === "bob" ? { topic: "Technocore room-read recovery", objective: QUESTION,
      context: "Use explicitly supplied provenance only. No automatic research/network. Delivery receipts verify coordination, not every API claim.", sources: [], outputRequirements: ["Separate source evidence, operator assertions and actual observations"] } :
      alias === "charlie" ? { problemStatement: QUESTION, project: { name: "Technocore room-read recovery" },
        observedBehavior: "See selected evidence; do not infer unobserved live behavior", constraints: ["No shell, network, upstream mutations or blind write retries"], requestedOutcome: "risk-analysis" } :
      alias === "dave" ? { question: QUESTION, producedResult: evidence[1]!.output, expectedOutputHash: evidence[1]!.outputHash,
        criteria: ["Distinguish source-derived evidence from live observation", "Check duplicate/replay/retention/epoch recovery recommendations", "Report unresolved verification limits"] } :
        { question: QUESTION, focus: "Distinct edge cases, sequence resets, lost acknowledgments, ambiguity and restart hazards",
          suppliedContext: "Use the selected engineering output. Do not mirror the reviewer; no new network actions." };
    return { type, payload: validateWorkRequest(type, payload), evidence };
  }

  private wire(state: State): string {
    const { from, to } = this.selected(state);
    const isRequest = state.index % 2 === 0;
    let content: unknown;
    if (isRequest) {
      const work = this.workRequest(state, to as Worker);
      content = { question: QUESTION, workload: work.type, requestHash: hashValue(work), evidenceHashes: work.evidence.map(e => e.resultHash) };
    } else {
      const analysis = state.analyses[from];
      if (!analysis?.evidence) throw new BridgeError("Operator analysis is required before preparing this response");
      content = { resultHash: analysis.evidence.resultHash, outputHash: analysis.evidence.outputHash,
        provenanceHash: analysis.packetHash, scope: "operator-assisted-supplied-evidence-only",
        summary: sanitizeText(JSON.stringify(analysis.evidence.output)).slice(0, 240) };
    }
    const text = sanitizeText(JSON.stringify({ version: 1, rehearsal: ID, step: state.index + 1,
      from: state.dids[from], to: state.dids[to], kind: isRequest ? "request" : "result", content }));
    assertNoSecretLikeOutput(text, "Rehearsal message");
    return text;
  }

  private metadata(state: State) {
    const { from, to, step } = this.selected(state);
    return { senderAlias: from, senderDid: state.dids[from], destinationAlias: to, destinationDid: state.dids[to],
      actionId: step.actionId, actionType: "technocore.send-contact", payloadPreview: step.text?.slice(0, 480),
      payloadHash: step.payloadHash, actionHash: step.actionHash };
  }

  async prepare() {
    return this.locked(true, async state => {
      const { step, from, to } = this.selected(state);
      if (!["planned", "prepared"].includes(step.status)) throw new BridgeError("Current step is not awaiting preparation");
      const text = this.wire(state);
      if (step.text !== undefined && step.text !== text) return await this.halt(state, "prepared-payload-changed");
      const taskId = `rehearsal_send_${state.index + 1}`;
      const taskState = new AgentStateStore(agentPaths(this.stores.paths.root, from).state);
      await taskState.enqueueTask({ id: taskId, idempotencyKey: taskId, type: "technocore.send-contact",
        payload: { contactId: to, text, expectedRecipientDid: state.dids[to] } });
      const actionId = hashValue({ did: state.dids[from], taskId, type: "technocore.send-contact" });
      const bridge = new SignedAgentBridge(this.stores, new InMemoryTechnocoreTransport());
      const approval = await bridge.prepareContactSend(from, to, text, actionId);
      if (!["requested", "approved"].includes(approval.status)) return await this.halt(state, "approval-already-spent");
      Object.assign(step, { status: "prepared", text, taskId, actionId, actionHash: approval.actionHash, payloadHash: approval.payloadHash });
      await this.saved(state);
      return this.metadata(state);
    });
  }

  private transport(onReadProgress?: (progress: ReadProgress) => void): TechnocoreTransport {
    if (this.options.offlineTransport) return this.options.offlineTransport;
    // Constructed only inside an explicit send/receive, never in prepare/status/work.
    if (process.env.TECHNOCORE_URL !== "https://technocore.chat") throw new BridgeError("Explicit canonical TECHNOCORE_URL is required for live rehearsal IO");
    return new HttpTechnocoreTransport(process.env.TECHNOCORE_URL, { ...REHEARSAL_HTTP_OPTIONS, ...(onReadProgress ? { onReadProgress } : {}) });
  }

  private async runtime(alias: Alias, state: State, transport?: TechnocoreTransport, inference?: InferenceProvider) {
    return AgentRuntime.start({ identityAlias: alias, expectedDid: state.dids[alias], root: this.stores.paths.root,
      passphrases: this.options.passphrases, handleSignals: false, ...(transport ? { transport } : {}),
      inference: inference ?? { name: "disabled", infer: async () => { throw new BridgeError("No inference permitted in this operation"); } } });
  }

  private async assertNoOtherWork(runtime: AgentRuntime, permitted: string[]) {
    const tasks = Object.values((await runtime.state.load()).tasks);
    if (tasks.some(t => ["pending", "running", "awaiting-approval", "ambiguous"].includes(t.status) && !permitted.includes(t.id))) {
      throw new BridgeError("Unexpected pending or ambiguous work; stop before IO");
    }
  }

  async send(actionId: string, actionHash: string) {
    return this.locked(false, async state => {
      const { step, from, to } = this.selected(state);
      if (step.status !== "prepared" || actionId !== step.actionId || actionHash !== step.actionHash) throw new BridgeError("Exact prepared action required");
      const approval = await this.stores.approvals.read(from, actionId);
      if (approval.status !== "approved" || approval.actionHash !== actionHash) throw new BridgeError("Exact operator approval required; nothing sent");
      const task = (await new AgentStateStore(agentPaths(this.stores.paths.root, from).state).load()).tasks[step.taskId!];
      if (!task || task.status !== "pending" || task.type !== "technocore.send-contact" ||
        task.payload.text !== step.text || task.payload.contactId !== to || task.payload.expectedRecipientDid !== state.dids[to] ||
        this.wire(state) !== step.text || hashValue(sanitizeText(step.text!)) !== step.payloadHash) return await this.halt(state, "approved-payload-changed");
      if (state.posts >= 8) return await this.halt(state, "post-budget-exhausted");
      const base = this.transport();
      const mailbox = await this.stores.mailboxes.load(to);
      let called = false;
      const denied = async (): Promise<never> => { throw new BridgeError("Operation outside rehearsal IO plan"); };
      const transport: TechnocoreTransport = { readRoomJson: denied, readRoomText: denied,
        sendSignedMessage: async (room, envelope) => {
          if (called || room !== mailbox.room || envelope.did !== state.dids[from] || hashValue(envelope.text) !== step.payloadHash) throw new BridgeError("Unexpected rehearsal POST");
          called = true;
          const response = await base.sendSignedMessage(room, envelope);
          if (!response.posted || response.posted.from !== state.dids[from] || response.posted.text !== step.text || !Number.isSafeInteger(response.posted.seq)) {
            throw new AmbiguousSendError("Rehearsal POST receipt could not be matched; do not retry");
          }
          return response;
        } };
      const runtime = await this.runtime(from, state, transport);
      try {
        await this.assertNoOtherWork(runtime, [step.taskId!]);
        step.status = "post-intent"; state.posts++; await this.saved(state);
        const result = await runtime.runOnce(step.taskId);
        if (result.task?.status !== "succeeded") return await this.halt(state, result.task?.status === "ambiguous" ? "ambiguous-send" : "send-failed");
        const seq = Number(result.task.result?.reference?.replace("seq:", ""));
        if (!Number.isSafeInteger(seq) || seq < 1) return await this.halt(state, "unknown-send-receipt");
        step.seq = seq; step.status = "sent"; await this.saved(state);
        return { ...this.metadata(state), status: "sent", seq };
      } catch (error) {
        if (!state.halted) { state.halted = "send-operation-stopped"; await this.saved(state); }
        throw new BridgeError("Rehearsal send stopped; inspect safe local state; no retry");
      } finally { await runtime.close(); }
    });
  }

  async receive(stepNumber: number) {
    return this.locked(false, async state => {
      const { step, from, to } = this.selected(state);
      if (stepNumber !== state.index + 1 || !["sent", "received"].includes(step.status)) throw new BridgeError("Exact sent step required for receipt");
      const mailbox = await this.stores.mailboxes.load(to);
      // Crash after durable receipt and before cursor ack: verify existing persisted data, no second GET.
      if (step.status === "received") {
        await this.completeReceipt(state, to); return this.summary(state);
      }
      const previousCursor = await this.stores.cursors.get(to, mailbox.room);
      if (step.seq !== previousCursor + 1) {
        step.failure = receiveFailure({ step: stepNumber, expectedSeq: step.seq!, previousCursor, stage: "preflight",
          code: "stale-cursor-or-room-sequence-mismatch", contactHash: state.destinations[state.index]! }, new BridgeError("Sequence mismatch"));
        return await this.halt(state, "stale-cursor-or-room-sequence-mismatch");
      }
      if (state.gets >= 8) return await this.halt(state, "get-budget-exhausted");
      let stage: ReceiveStage = "preflight";
      let http: Omit<ReadProgress, "stage"> = {};
      let runtime: AgentRuntime | undefined;
      const setStage = (value: ReceiveStage) => { stage = value; };
      try {
        const base = this.transport(progress => { stage = progress.stage; const { stage: _, ...safe } = progress; http = { ...http, ...safe }; });
        let called = false;
        const denied = async (): Promise<never> => { throw new BridgeError("Operation outside rehearsal IO plan"); };
        const transport: TechnocoreTransport = { sendSignedMessage: denied, readRoomText: denied,
          readRoomJson: async (room, options) => {
            if (called || room !== mailbox.room || options?.since !== previousCursor || options.wait !== 0 || options.limit !== 200) throw new BridgeError("Unexpected rehearsal GET");
            called = true; return base.readRoomJson(room, options);
          } };
        stage = "identity-unlock";
        runtime = await this.runtime(to, state, transport);
        await this.assertNoOtherWork(runtime, []);
        stage = "get-intent";
        step.status = "get-intent"; state.gets++; await this.saved(state);
        await runtime.ingestInbox({ onStage: setStage, validate: peek => {
          validateReceipt(peek, { step: stepNumber, expectedSeq: step.seq!, previousCursor,
            senderDid: state.dids[from], receiverDid: state.dids[to], payloadHash: step.payloadHash! }, setStage, true);
        }, afterPersist: async peek => {
          const inbound = Object.values((await runtime!.state.load()).tasks).find(t => t.type === "inbound.message" &&
            t.payload.seq === step.seq && t.payload.senderDid === state.dids[from] && t.payload.text === step.text);
          if (!inbound) throw new BridgeError("Durable inbound receipt missing");
          step.inboundTaskId = inbound.id;
          step.observation = { kind: this.options.offlineTransport ? "deterministic-offline" : "live-observation",
            firstSeq: peek.firstSeq, lastSeq: peek.lastSeq, seq: step.seq!, messageHash: step.payloadHash! };
          step.status = "received"; await this.saved(state);
        } });
        stage = "local-completion";
        await runtime.runOnce(step.inboundTaskId);
        await runtime.close(); runtime = undefined;
        stage = "cursor-ack";
        await this.completeReceipt(state, to);
      } catch (error) {
        step.failure = receiveFailure({ step: stepNumber, expectedSeq: step.seq!, previousCursor, stage,
          code: "receive-failed", contactHash: state.destinations[stepNumber - 1]!, http }, error);
        state.halted = "receipt-validation-or-persistence-failed"; await this.saved(state);
        throw new BridgeError(`Rehearsal receipt stopped; no retry or cursor reset; stage=${step.failure.stage}; code=${step.failure.code}; errorClass=${step.failure.errorClass}`);
      } finally { await runtime?.close(step.failure ? "failed" : "clean"); }
      return this.summary(state);
    });
  }

  private async completeReceipt(state: State, to: Alias) {
    const step = state.steps[state.index]!;
    const paths = agentPaths(this.stores.paths.root, to);
    const task = (await new AgentStateStore(paths.state).load()).tasks[step.inboundTaskId!];
    const { ActivityJournal } = await import("../agent/journal.js");
    const journal = await new ActivityJournal(paths.journal).read();
    if (!task || task.payload.seq !== step.seq || task.payload.text !== step.text ||
      task.payload.senderDid !== state.dids[GRAPH[state.index]![0]] || task.payload.serverVerifiedDid !== true ||
      !journal.some(e => e.taskId === task.id && e.event === "inbound-persisted" && e.resultHash === hashValue(task.payload))) {
      return await this.halt(state, "receipt-recovery-evidence-mismatch");
    }
    const mailbox = await this.stores.mailboxes.load(to);
    const cursor = await this.stores.cursors.get(to, mailbox.room);
    if (cursor !== step.seq && cursor !== step.seq! - 1) return await this.halt(state, "receipt-cursor-changed");
    await new SignedAgentBridge(this.stores, new InMemoryTechnocoreTransport()).acknowledgeInbox(to, step.seq!);
    // Only this already-persisted inbound item may be finalized during recovery.
    if (task.status !== "succeeded") {
      const runtime = await this.runtime(to, state);
      try { await this.assertNoOtherWork(runtime, [task.id]); await runtime.runOnce(task.id); }
      finally { await runtime.close(); }
    }
    step.status = "acknowledged"; state.index++; await this.saved(state);
  }

  async work(alias: Alias, supplied: AnalysisPacket) {
    return this.locked(false, async state => {
      const final = state.index === 8;
      if (final ? alias !== "alice" : state.index % 2 !== 1 || GRAPH[state.index]![0] !== alias) throw new BridgeError("Analysis is not the current rehearsal step");
      if (state.complete) return this.summary(state);
      const validated = packet(supplied);
      const packetHash = hashValue(validated);
      const prior = state.analyses[alias];
      if (prior && prior.packetHash !== packetHash) return await this.halt(state, "analysis-input-changed");
      if (prior?.evidence) return this.summary(state);
      state.analyses[alias] = { ...prior, packet: validated, packetHash }; await this.saved(state);
      const provider: InferenceProvider = { name: "operator-supplied", infer: async request => {
        if (request.taskId === PARENT) return { outcome: "success", output: { summary: "Fixed operator-controlled eight-message plan",
          steps: ["Research", "Engineering", "Review", "Specialist"], evidenceHashes: [], limitations: ["Plan only; no research performed"] },
          metadata: { provider: "deterministic-local", model: "fixed-rehearsal-plan" } };
        return { outcome: "success", output: validated.output, metadata: { provider: "operator-supplied", model: "manual-analysis-v1" } };
      } };
      const runtimes = new Map<Alias, AgentRuntime>();
      try {
        for (const name of ALIASES) runtimes.set(name, await this.runtime(name, state, undefined, provider));
        const alice = runtimes.get("alice")!;
        const parent = await alice.enqueueTask({ id: PARENT, idempotencyKey: PARENT, type: "workload.coordination",
          payload: { question: QUESTION, phase: "decomposition" }, context: { mode: "explicit-only", evidence: [] } });
        await this.runLocal(alice, parent);
        const router = new LocalSwarmRouter(ALIASES.map(name => ({ binding: { alias: name, expectedDid: state.dids[name] }, runtime: runtimes.get(name)! })));
        let task: AgentTask;
        if (final) {
          const evidence = WORKERS.map(name => {
            const result = state.analyses[name]?.evidence;
            if (!result) throw new BridgeError("Synthesis requires all four results");
            return result;
          });
          task = await alice.enqueueTask({ id: FINAL, idempotencyKey: FINAL, type: "workload.coordination",
            payload: { question: QUESTION, phase: "synthesis", requiredEvidenceHashes: evidence.map(e => e.resultHash) },
            context: { mode: "explicit-only", evidence } });
        } else {
          const request = this.workRequest(state, alias as Worker);
          const delegation = await router.delegate({ source: { alias: "alice", expectedDid: state.dids.alice },
            target: { alias, expectedDid: state.dids[alias] }, parentTaskId: PARENT, key: `rehearsal_${alias}`,
            workload: request.type, payload: request.payload, evidence: request.evidence });
          state.analyses[alias]!.delegationId = delegation.id; await this.saved(state);
          task = (await runtimes.get(alias)!.state.load()).tasks[delegation.taskId]!;
        }
        const runtime = runtimes.get(alias)!;
        await this.runLocal(runtime, task);
        const evidence = final ? await alice.exportTaskEvidence(task.id) : await router.collect(
          { alias: "alice", expectedDid: state.dids.alice }, state.analyses[alias]!.delegationId!);
        await runtime.memory.put({ scope: "rehearsal-provenance", key: task.id, idempotencyKey: `provenance:${task.id}`,
          value: { packetHash, sources: validated.sources, analysisScope: "operator-assisted-supplied-evidence-only", resultHash: evidence.resultHash }, tags: [ID] });
        state.analyses[alias]!.evidence = evidence;
        if (final) state.complete = true;
        await this.saved(state); return this.summary(state);
      } catch {
        state.halted = "local-analysis-failed"; await this.saved(state);
        throw new BridgeError("Rehearsal analysis stopped; supplied output or local state requires review");
      } finally { for (const runtime of [...runtimes.values()].reverse()) await runtime.close(); }
    });
  }

  private async runLocal(runtime: AgentRuntime, task: AgentTask) {
    if (task.status === "succeeded") return;
    await this.assertNoOtherWork(runtime, [task.id]);
    if (task.status !== "pending" || (await runtime.runOnce(task.id)).task?.status !== "succeeded") throw new BridgeError("Local analysis did not complete; no automatic retry");
  }

  private summary(state: State) {
    return { rehearsal: ID, nextStep: state.index < 8 ? state.index + 1 : null, complete: state.complete, halted: state.halted ?? null,
      logicalPostAttempts: state.posts, getAttempts: state.gets, budget: { maxPosts: 8, maxGets: 8, automaticRetries: 0 },
      steps: state.steps.map((step, index) => ({ number: index + 1, from: GRAPH[index]![0], to: GRAPH[index]![1],
        status: step.status, actionId: step.actionId, actionHash: step.actionHash, payloadHash: step.payloadHash, seq: step.seq,
        observation: step.observation, failure: step.failure })),
      results: Object.fromEntries(Object.entries(state.analyses).map(([alias, value]) => [alias, {
        packetHash: value.packetHash, resultHash: value.evidence?.resultHash, scope: "operator-assisted-supplied-evidence-only" }])) };
  }
  async status() { return this.locked(false, async state => this.summary(state), true); }

  /** Host-only read of a quarantined rehearsal under its existing lock. Never saves or advances it. */
  async withHaltedSnapshot<T>(operation: (state: RehearsalState) => Promise<T>): Promise<T> {
    return this.locked(false, async state => {
      if (!state.halted) throw new BridgeError("Reconciliation requires a halted rehearsal");
      return operation(structuredClone(state));
    }, true);
  }
}
