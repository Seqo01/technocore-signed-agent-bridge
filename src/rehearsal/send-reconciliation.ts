import { resolve } from "node:path";
import { ActionApprovalStore, type ExactActionEffect } from "../agent/approvals.js";
import { agentPaths } from "../agent/paths.js";
import { AgentRuntimeLock } from "../agent/runtime-lock.js";
import { AgentStateStore } from "../agent/state-store.js";
import { hashValue } from "../agent/util.js";
import { createStores } from "../context.js";
import { BridgeError, TransportError } from "../errors.js";
import { atomicWriteJson, readJsonFile } from "../fs-safe.js";
import { sanitizeText } from "../protocol.js";
import { receiveFailure, type ReadProgress, type ReceiveFailure, type ReceiveStage } from "../receive-diagnostics.js";
import { HttpTechnocoreTransport, parseRoomResponse } from "../transport.js";
import type { RoomResponse } from "../types.js";
import { FirstRehearsal, GRAPH, type RehearsalOptions, type RehearsalState } from "./runner.js";
import type { Alias } from "./setup.js";

export const SEND_READ_QUERY = Object.freeze({ since: 0, wait: 0, limit: 200 });
export const SEND_READ_OPTIONS = Object.freeze({ readRetries: 0, rateLimitRetries: 0, readRedirect: "error" as const });
export type SendRecoveryBoundary = "get-intent" | "observation-validated" | "observation-persisted" | "apply-intent" | "main-applied" | "applied";
export interface SendRecoveryHooks { afterBoundary?: (phase: SendRecoveryBoundary) => void | Promise<void> }
interface SendSpec {
  version: 1; type: "technocore.reconcile-send-read"; rehearsalId: "first-room-read-v1"; rehearsalVersion: 1;
  step: number; senderAlias: Alias; senderDid: string; receiverAlias: Alias; receiverDid: string;
  originalActionId: string; originalActionHash: string; payloadHash: string; mailboxContactHash: string;
  origin: "https://technocore.chat"; query: typeof SEND_READ_QUERY; previousCursor: number;
  originalStateHash: string; originalTaskHash: string; originalApprovalHash: string;
  originalHalt: string; originalTaskStatus: "failed" | "ambiguous"; posts: number; gets: number;
  kind: "task" | "result"; mode: "live" | "offline";
}
interface Observation {
  version: 1; outcome: "observed" | "not-observed"; specHash: string; timestamp: string;
  kind: "live-observation" | "deterministic-offline";
  scope: { query: typeof SEND_READ_QUERY; firstSeq: number | null; lastSeq: number; count: number;
    lastReturnedSeq: number | null; retentionGap: boolean; windowIncomplete: boolean };
  match?: { seq: number; timestamp: string; senderDid: string; receiverDid: string; payloadHash: string; serverVerifiedDid: true };
}
export interface SendRecoveryReceipt {
  version: 1; step: number; seq: number; authorizationId: string; authorizationHash: string;
  observationHash: string; payloadHash: string; originalStateHash: string; originalTaskHash: string;
  originalHalt: string; originalTaskStatus: "failed" | "ambiguous"; recoveredAt: string;
  observationAttempts: 1; cursorMutation: "unnecessary"; originalHttpReceipt: "not-fabricated";
}
interface RecordV1 {
  version: 1; id: string; hash: string; spec: SendSpec; attempts: 0 | 1;
  status: "prepared" | "get-intent" | "observed" | "not-observed" | "failed";
  observation?: Observation; observationHash?: string; failure?: ReceiveFailure;
  apply?: { phase: "intent" | "applied"; receipt: SendRecoveryReceipt; receiptHash: string; nextStateHash: string };
}
const requireEvidence = (ok: unknown): void => { if (!ok) throw new BridgeError("Send reconciliation evidence mismatch"); };

/** Reusable bounded matcher: never returns/persists unrelated messages or a private body. */
export function matchSentMessage(view: RoomResponse, spec: SendSpec, room: string): Observation {
  const parsed = parseRoomResponse(view);
  requireEvidence((parsed.room === undefined || parsed.room === room) && parsed.count <= 200 && parsed.last_seq >= spec.previousCursor);
  let previous = 0;
  for (const message of parsed.messages) {
    requireEvidence(message.seq > previous && message.seq <= parsed.last_seq && parsed.first_seq !== null && message.seq >= parsed.first_seq);
    previous = message.seq;
  }
  const candidates = parsed.messages.filter(m => hashValue(m.text) === spec.payloadHash);
  requireEvidence(candidates.length <= 1);
  const match = candidates[0];
  if (match) {
    requireEvidence(match.from === spec.senderDid && typeof match.nonce === "number" && Number.isSafeInteger(match.nonce) && match.nonce >= 0);
    const frame = JSON.parse(match.text);
    requireEvidence(frame.version === 1 && frame.rehearsal === spec.rehearsalId && frame.step === spec.step &&
      frame.from === spec.senderDid && frame.to === spec.receiverDid && frame.kind === spec.kind &&
      !Number.isNaN(Date.parse(match.ts)));
  }
  return { version: 1, outcome: match ? "observed" : "not-observed", specHash: hashValue(spec), timestamp: new Date().toISOString(),
    kind: spec.mode === "live" ? "live-observation" : "deterministic-offline",
    scope: { query: { ...SEND_READ_QUERY }, firstSeq: parsed.first_seq, lastSeq: parsed.last_seq, count: parsed.count,
      lastReturnedSeq: parsed.messages.at(-1)?.seq ?? null,
      retentionGap: parsed.first_seq !== null && parsed.first_seq > spec.previousCursor + 1,
      windowIncomplete: (parsed.messages.at(-1)?.seq ?? 0) < parsed.last_seq },
    ...(match ? { match: { seq: match.seq, timestamp: new Date(match.ts).toISOString(), senderDid: spec.senderDid, receiverDid: spec.receiverDid,
      payloadHash: spec.payloadHash, serverVerifiedDid: true as const } } : {}) };
}

/** No automatic invocation. Sender task, original approval and all cursor/nonce data remain immutable. */
export class SendReconciliation {
  private readonly stores;
  private readonly approvals;
  private readonly runner;
  private readonly directory: string;
  constructor(private readonly options: RehearsalOptions) {
    this.stores = createStores(options.root);
    this.directory = resolve(this.stores.paths.root, "send-reconciliation");
    this.approvals = new ActionApprovalStore(resolve(this.directory, "approvals"));
    this.runner = new FirstRehearsal(options);
  }
  private path(id: string) {
    requireEvidence(/^[a-f0-9]{64}$/u.test(id)); return resolve(this.directory, `${id}.json`);
  }
  private effect(spec: SendSpec): ExactActionEffect {
    return { agentAlias: spec.receiverAlias, agentDid: spec.receiverDid, type: spec.type,
      destinationHash: spec.mailboxContactHash, payloadHash: hashValue(spec) };
  }
  private async locked<T>(fn: (state: RehearsalState) => Promise<T>): Promise<T> {
    const held: AgentRuntimeLock[] = [];
    try {
      held.push(await AgentRuntimeLock.acquire(resolve(this.directory, "operation.lock")));
      return await this.runner.withSendRecoverySnapshot(async state => {
        // Serialize with local runtimes without starting them or unlocking identities.
        for (const alias of [...new Set(GRAPH[state.index] ?? ["alice", "bob"])].sort()) {
          held.push(await AgentRuntimeLock.acquire(agentPaths(this.stores.paths.root, alias).runtimeLock));
        }
        return fn(state);
      });
    } catch {
      throw new BridgeError("Send reconciliation stopped; inspect safe status; no retry, resend or cursor change");
    } finally { for (const lock of held.reverse()) await lock.release(); }
  }
  private async context(state: RehearsalState, number: number): Promise<SendSpec> {
    const step = state.steps[number - 1]; const pair = GRAPH[number - 1];
    requireEvidence(pair && step && number === state.index + 1 && !state.complete && step!.status === "post-intent" &&
      ["send-failed", "ambiguous-send"].includes(state.halted ?? "") && !step!.seq && !step!.sendRecovery &&
      state.posts === number && state.gets === number - 1 && state.steps.slice(number).every(s => s.status === "planned"));
    const [senderAlias, receiverAlias] = pair!;
    const task = (await new AgentStateStore(agentPaths(this.stores.paths.root, senderAlias).state).load()).tasks[step!.taskId!];
    const approval = await this.stores.approvals.read(senderAlias, step!.actionId!);
    requireEvidence(task && ["failed", "ambiguous"].includes(task.status) && task.attempts === 1 && !task.result &&
      task.type === "technocore.send-contact" && task.payload.contactId === receiverAlias &&
      task.payload.expectedRecipientDid === state.dids[receiverAlias] && task.payload.text === step!.text &&
      typeof step!.text === "string" && sanitizeText(step!.text!) === step!.text && hashValue(step!.text) === step!.payloadHash &&
      ["failed", "ambiguous", "executing"].includes(approval.status) && approval.type === "technocore.send-contact" &&
      approval.agentDid === state.dids[senderAlias] && approval.actionHash === step!.actionHash &&
      approval.payloadHash === step!.payloadHash && approval.destinationHash === state.destinations[number - 1]);
    const kind = number % 2 === 0 ? "result" : "task";
    const frame = JSON.parse(step!.text!);
    requireEvidence(frame.version === 1 && frame.rehearsal === state.id && frame.step === number && frame.kind === kind &&
      frame.from === state.dids[senderAlias] && frame.to === state.dids[receiverAlias]);
    const mailbox = await this.stores.mailboxes.load(receiverAlias);
    const contact = await this.stores.contacts.get(senderAlias, receiverAlias);
    requireEvidence(mailbox.did === state.dids[receiverAlias] && contact.did === mailbox.did && contact.mailbox === mailbox.room &&
      hashValue({ room: contact.mailbox, did: contact.did, contactId: receiverAlias }) === state.destinations[number - 1] &&
      hashValue(await readJsonFile(this.runner.path, null)) === hashValue(state));
    return { version: 1, type: "technocore.reconcile-send-read", rehearsalId: state.id, rehearsalVersion: state.version, step: number,
      senderAlias, senderDid: state.dids[senderAlias], receiverAlias, receiverDid: state.dids[receiverAlias],
      originalActionId: step!.actionId!, originalActionHash: step!.actionHash!, payloadHash: step!.payloadHash!,
      mailboxContactHash: state.destinations[number - 1]!, origin: "https://technocore.chat", query: { ...SEND_READ_QUERY },
      previousCursor: await this.stores.cursors.get(receiverAlias, mailbox.room), originalStateHash: hashValue(state),
      originalTaskHash: hashValue(task), originalApprovalHash: hashValue(approval), originalHalt: state.halted!,
      originalTaskStatus: task!.status as "failed" | "ambiguous", posts: state.posts, gets: state.gets, kind, mode: state.mode };
  }
  private async load(id: string, hash: string): Promise<RecordV1> {
    const record = await readJsonFile<RecordV1 | null>(this.path(id), null);
    requireEvidence(record && record.version === 1 && record.id === id && record.hash === hash &&
      record.spec.type === "technocore.reconcile-send-read" && record.spec.origin === "https://technocore.chat" &&
      hashValue(record.spec.query) === hashValue(SEND_READ_QUERY) && [0, 1].includes(record.attempts) &&
      ["prepared", "get-intent", "observed", "not-observed", "failed"].includes(record.status));
    const r = record!;
    requireEvidence(id === hashValue({ purpose: r.spec.type, rehearsal: r.spec.rehearsalId, step: r.spec.step, actionId: r.spec.originalActionId }) &&
      hash === hashValue({ actionId: id, ...this.effect(r.spec) }));
    return r;
  }
  private summary(r: RecordV1) {
    return { authorizationId: r.id, authorizationHash: r.hash, effect: r.spec, status: r.status, observationAttempts: r.attempts,
      observation: r.observation, observationHash: r.observationHash, failure: r.failure, apply: r.apply,
      automaticRetries: 0, cursorMutation: "none", originalHttpReceipt: "not-fabricated",
      ...(r.status === "not-observed" ? { warning: "Only this retained window was searched. No resend authorized. Origin request/commit logs or separately reviewed complete retention/epoch evidence are needed before deciding on a fresh send." } : {}) };
  }
  async prepare(step: number) {
    return this.locked(async state => {
      const spec = await this.context(state, step);
      const id = hashValue({ purpose: spec.type, rehearsal: spec.rehearsalId, step, actionId: spec.originalActionId });
      const hash = hashValue({ actionId: id, ...this.effect(spec) });
      const existing = await readJsonFile<RecordV1 | null>(this.path(id), null);
      if (existing) { const r = await this.load(id, hash); requireEvidence(hashValue(r.spec) === hashValue(spec)); return this.summary(r); }
      await this.approvals.propose(this.effect(spec), id);
      const record: RecordV1 = { version: 1, id, hash, spec, attempts: 0, status: "prepared" };
      await atomicWriteJson(this.path(id), record); return this.summary(record);
    });
  }
  async authorize(id: string, hash: string) {
    return this.locked(async state => {
      const r = await this.load(id, hash);
      requireEvidence(r.status === "prepared" && r.attempts === 0 && hashValue(await this.context(state, r.spec.step)) === hashValue(r.spec));
      await this.approvals.grant(r.spec.receiverAlias, id, hash); return { ...this.summary(r), authorizationStatus: "approved", networkRequests: 0 };
    });
  }
  async status(id: string, hash: string) { return this.locked(async () => this.summary(await this.load(id, hash))); }

  async observe(id: string, hash: string, hooks: SendRecoveryHooks = {}) {
    return this.locked(async state => {
      const r = await this.load(id, hash);
      requireEvidence(r.status === "prepared" && r.attempts === 0 && hashValue(await this.context(state, r.spec.step)) === hashValue(r.spec));
      if (!this.options.offlineTransport) requireEvidence(process.env.TECHNOCORE_URL === r.spec.origin);
      let stage: ReceiveStage = "get-intent"; let http: Omit<ReadProgress, "stage"> = {};
      const transport = this.options.offlineTransport ?? new HttpTechnocoreTransport(r.spec.origin, { ...SEND_READ_OPTIONS,
        onReadProgress: p => { stage = p.stage; const { stage: _, ...fields } = p; http = { ...http, ...fields }; } });
      const mailbox = await this.stores.mailboxes.load(r.spec.receiverAlias);
      await this.approvals.consume(this.effect(r.spec), id);
      r.attempts = 1; r.status = "get-intent"; await atomicWriteJson(this.path(id), r);
      await hooks.afterBoundary?.("get-intent");
      let observation: Observation;
      try {
        stage = "transport";
        const view = await transport.readRoomJson(mailbox.room, { ...SEND_READ_QUERY }); // The only network call in this module.
        stage = "message-selection";
        observation = matchSentMessage(view, r.spec, mailbox.room);
        requireEvidence(hashValue(await this.context(state, r.spec.step)) === hashValue(r.spec));
      } catch (error) {
        if (error instanceof TransportError && Number.isInteger(error.status) && error.status! >= 100 && error.status! <= 599) {
          http = { ...http, status: error.status!, headersReceived: true };
        }
        r.status = "failed";
        r.failure = receiveFailure({ step: r.spec.step, expectedSeq: r.spec.previousCursor + 1, previousCursor: r.spec.previousCursor,
          stage, code: "reconciliation-failed", contactHash: r.spec.mailboxContactHash, http }, error);
        await atomicWriteJson(this.path(id), r);
        await this.approvals.finish(r.spec.receiverAlias, id, "failed"); return this.summary(r);
      }
      await hooks.afterBoundary?.("observation-validated");
      r.observation = observation; r.observationHash = hashValue(observation); r.status = observation.outcome;
      await atomicWriteJson(this.path(id), r); await hooks.afterBoundary?.("observation-persisted");
      await this.approvals.finish(r.spec.receiverAlias, id, "confirmed"); return this.summary(r);
    });
  }

  async apply(id: string, hash: string, hooks: SendRecoveryHooks = {}) {
    return this.locked(async state => {
      const r = await this.load(id, hash); const o = r.observation; const match = o?.match;
      requireEvidence(r.status === "observed" && r.attempts === 1 && o && match && o.outcome === "observed" &&
        r.observationHash === hashValue(o) && o.specHash === hashValue(r.spec) &&
        o.kind === (r.spec.mode === "live" ? "live-observation" : "deterministic-offline") &&
        match!.senderDid === r.spec.senderDid && match!.receiverDid === r.spec.receiverDid && match!.payloadHash === r.spec.payloadHash &&
        match!.serverVerifiedDid === true && Number.isSafeInteger(match!.seq) && match!.seq === r.spec.previousCursor + 1 &&
        !o.scope.retentionGap && !Number.isNaN(Date.parse(o.timestamp)) && !Number.isNaN(Date.parse(match!.timestamp)));
      const readAuthority = await this.approvals.read(r.spec.receiverAlias, id);
      requireEvidence(readAuthority.actionHash === hash && ["executing", "confirmed"].includes(readAuthority.status));
      const step = state.steps[r.spec.step - 1]!;
      const receipt: SendRecoveryReceipt = { version: 1, step: r.spec.step, seq: match!.seq, authorizationId: id, authorizationHash: hash,
        observationHash: r.observationHash!, payloadHash: r.spec.payloadHash, originalStateHash: r.spec.originalStateHash,
        originalTaskHash: r.spec.originalTaskHash, originalHalt: r.spec.originalHalt, originalTaskStatus: r.spec.originalTaskStatus,
        recoveredAt: r.apply?.receipt.recoveredAt ?? new Date().toISOString(), observationAttempts: 1,
        cursorMutation: "unnecessary", originalHttpReceipt: "not-fabricated" };
      const receiptHash = hashValue(receipt);
      if (r.apply) requireEvidence(["intent", "applied"].includes(r.apply.phase) && r.apply.receiptHash === receiptHash && hashValue(r.apply.receipt) === receiptHash);
      if (step.sendRecovery) {
        requireEvidence(r.apply && hashValue(step.sendRecovery) === receiptHash && step.seq === receipt.seq);
        if (r.apply!.phase !== "applied") {
          requireEvidence(hashValue(state) === r.apply!.nextStateHash);
          r.apply!.phase = "applied"; await atomicWriteJson(this.path(id), r);
        }
        return { status: "already-applied", step: r.spec.step, networkRequests: 0, receipt };
      }
      requireEvidence(!r.apply || r.apply.phase === "intent");
      requireEvidence(hashValue(await this.context(state, r.spec.step)) === hashValue(r.spec));
      const next = structuredClone(state);
      next.steps[r.spec.step - 1]!.status = "sent-reconciled";
      next.steps[r.spec.step - 1]!.seq = receipt.seq; next.steps[r.spec.step - 1]!.sendRecovery = receipt;
      delete next.halted; // Only the exact original halt, verified above. No receive, ACK or task execution.
      const nextStateHash = hashValue(next);
      if (r.apply) requireEvidence(r.apply.nextStateHash === nextStateHash);
      if (readAuthority.status === "executing") await this.approvals.finish(r.spec.receiverAlias, id, "confirmed");
      if (!r.apply) {
        r.apply = { phase: "intent", receipt, receiptHash, nextStateHash };
        await atomicWriteJson(this.path(id), r); await hooks.afterBoundary?.("apply-intent");
      }
      requireEvidence(hashValue(await this.context(state, r.spec.step)) === hashValue(r.spec) &&
        hashValue(await readJsonFile(this.runner.path, null)) === r.spec.originalStateHash);
      await atomicWriteJson(this.runner.path, next); await hooks.afterBoundary?.("main-applied");
      r.apply.phase = "applied"; await atomicWriteJson(this.path(id), r); await hooks.afterBoundary?.("applied");
      return { status: "applied", step: r.spec.step, stepStatus: "sent-reconciled", networkRequests: 0,
        logicalPostAttempts: next.posts, getAttempts: next.gets, observationAttempts: 1, receipt };
    });
  }
}
