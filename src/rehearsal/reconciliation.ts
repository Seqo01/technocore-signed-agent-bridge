import { resolve } from "node:path";
import { createStores } from "../context.js";
import type { InboxPeekResult } from "../bridge.js";
import { BridgeError } from "../errors.js";
import { atomicWriteJson, readJsonFile } from "../fs-safe.js";
import { sanitizeText } from "../protocol.js";
import { HttpTechnocoreTransport, type HttpTransportOptions } from "../transport.js";
import type { TechnocoreTransport } from "../types.js";
import { receiveFailure, type ReadProgress, type ReceiveFailure, type ReceiveStage } from "../receive-diagnostics.js";
import { ActionApprovalStore, type ExactActionEffect } from "../agent/approvals.js";
import { ActivityJournal } from "../agent/journal.js";
import { AgentRuntime, type InboxIntakeOptions } from "../agent/runtime.js";
import { AgentRuntimeLock } from "../agent/runtime-lock.js";
import { AgentStateStore } from "../agent/state-store.js";
import { agentPaths } from "../agent/paths.js";
import { hashText, hashValue } from "../agent/util.js";
import { FirstRehearsal, type RehearsalOptions, type RehearsalState } from "./runner.js";
import { validateReceipt } from "./receipt.js";

export const RECONCILIATION_QUERY = Object.freeze({ since: 0, wait: 0, limit: 200 });
export const RECONCILIATION_HTTP_OPTIONS = Object.freeze({ readRetries: 0, rateLimitRetries: 0, readRedirect: "error" } satisfies HttpTransportOptions);

interface ReadSpec {
  version: 1;
  type: "technocore.reconcile-read";
  agentAlias: "bob";
  agentDid: string;
  step: 1;
  mailboxContactHash: string;
  origin: "https://technocore.chat";
  query: typeof RECONCILIATION_QUERY;
  expectedSenderDid: string;
  expectedSeq: 1;
  expectedPayloadHash: string;
  previousCursor: 1;
  originalStateHash: string;
  mode: "live" | "offline";
}

interface Checkpoint {
  step: 1; seq: 1; payloadHash: string; inboundTaskId: string; inboundPayloadHash: string;
  observationHash: string; authorizationHash: string; timestamp: string;
  kind: "live-observation" | "deterministic-offline";
  cursorUnchanged: true;
}

interface RecordV1 {
  version: 1;
  spec: ReadSpec;
  actionId: string;
  actionHash: string;
  attempts: 0 | 1;
  status: "prepared" | "get-intent" | "observed" | "checkpoint" | "complete" | "failed";
  // Only the single validated message is retained, under ignored private local state.
  // Never store raw HTTP responses, unrelated messages, room names, URLs or signatures.
  retained?: { peek: InboxPeekResult; hash: string };
  checkpoint?: Checkpoint;
  failure?: ReceiveFailure;
}

const denied = async (): Promise<never> => { throw new BridgeError("Operation outside reconciliation policy"); };

/** A single exact-authorized observation; does not reset cursors or advance/unhalt the rehearsal. */
export class FirstReceiptReconciliation {
  private readonly stores;
  private readonly approvals;
  readonly path: string;
  constructor(private readonly options: RehearsalOptions) {
    this.stores = createStores(options.root, options.passphrases);
    this.approvals = new ActionApprovalStore(resolve(this.stores.paths.root, "reconciliation-approvals"));
    this.path = resolve(this.stores.paths.root, "agents", "bob", "reconciliation", "first-room-read-v1-step-1.json");
  }

  private async context(state: RehearsalState) {
    const step = state.steps[0]!;
    if (state.index !== 0 || state.complete || state.posts !== 1 || state.gets > 1 ||
      !["receipt-validation-or-persistence-failed", "stale-cursor-or-room-sequence-mismatch"].includes(state.halted ?? "") ||
      !["get-intent", "sent"].includes(step.status) || step.seq !== 1 || step.observation || step.inboundTaskId ||
      !step.text || sanitizeText(step.text) !== step.text || hashValue(step.text) !== step.payloadHash ||
      !step.actionId || !step.actionHash || !step.taskId || state.steps.slice(1).some(s => s.status !== "planned")) {
      throw new BridgeError("Not the supported halted first-receipt condition");
    }
    const mailbox = await this.stores.mailboxes.load("bob");
    const previousCursor = await this.stores.cursors.get("bob", mailbox.room);
    if (previousCursor !== 1) throw new BridgeError("Reconciliation requires the unchanged existing cursor");
    const sender = await new AgentStateStore(agentPaths(this.stores.paths.root, "alice").state).load();
    const task = sender.tasks[step.taskId];
    const sent = await this.stores.approvals.read("alice", step.actionId);
    if (sent.status !== "confirmed" || sent.actionHash !== step.actionHash || sent.payloadHash !== step.payloadHash ||
      sent.destinationHash !== state.destinations[0] || task?.status !== "succeeded" || task.result?.reference !== "seq:1" ||
      task.payload.text !== step.text || task.payload.contactId !== "bob" || task.payload.expectedRecipientDid !== state.dids.bob) {
      throw new BridgeError("Original successful send evidence changed");
    }
    const spec: ReadSpec = { version: 1, type: "technocore.reconcile-read", agentAlias: "bob", agentDid: state.dids.bob,
      step: 1, mailboxContactHash: state.destinations[0]!, origin: "https://technocore.chat", query: { ...RECONCILIATION_QUERY },
      expectedSenderDid: state.dids.alice, expectedSeq: 1, expectedPayloadHash: step.payloadHash!, previousCursor: 1,
      originalStateHash: hashValue(state), mode: state.mode };
    const actionId = hashValue({ purpose: "first-receipt-reconciliation-v1", originalSendAction: step.actionId });
    const effect: ExactActionEffect = { agentAlias: "bob", agentDid: spec.agentDid, type: spec.type,
      destinationHash: spec.mailboxContactHash, payloadHash: hashValue(spec) };
    return { spec, actionId, effect, mailbox };
  }

  private async locked<T>(operation: (context: Awaited<ReturnType<FirstReceiptReconciliation["context"]>>) => Promise<T>): Promise<T> {
    try {
      const lock = await AgentRuntimeLock.acquire(`${this.path}.lock`);
      try {
        return await new FirstRehearsal(this.options).withHaltedSnapshot(async state => operation(await this.context(state)));
      } finally { await lock.release(); }
    } catch {
      // Including preflight/storage/unlock errors: no raw path, body, frame or nested exception in CLI output.
      throw new BridgeError("Reconciliation stopped; inspect safe reconciliation diagnostics; no retry, cursor reset or rehearsal advance");
    }
  }

  private async load(context: Awaited<ReturnType<FirstReceiptReconciliation["context"]>>, id?: string, hash?: string) {
    const record = await readJsonFile<RecordV1 | null>(this.path, null);
    if (!record || record.version !== 1 || hashValue(record.spec) !== hashValue(context.spec) ||
      record.actionId !== context.actionId || record.actionHash !== hashValue({ actionId: context.actionId, ...context.effect }) ||
      (id !== undefined && id !== record.actionId) || (hash !== undefined && hash !== record.actionHash) ||
      ![0, 1].includes(record.attempts) || !["prepared", "get-intent", "observed", "checkpoint", "complete", "failed"].includes(record.status) ||
      (record.attempts === 0 && (record.status !== "prepared" || record.retained || record.checkpoint))) {
      throw new BridgeError("Exact reconciliation authorization or state changed");
    }
    return record;
  }

  private summary(record: RecordV1) {
    return { authorizationId: record.actionId, authorizationHash: record.actionHash, effect: record.spec,
      status: record.status, observationAttempts: record.attempts, checkpoint: record.checkpoint, failure: record.failure,
      rehearsalRemainsHalted: true, automaticRetries: 0 };
  }

  async prepare() {
    return this.locked(async context => {
      const existing = await readJsonFile<unknown>(this.path, null);
      if (existing) return this.summary(await this.load(context));
      const approval = await this.approvals.propose(context.effect, context.actionId);
      if (!["requested", "approved"].includes(approval.status)) throw new BridgeError("Read authorization already spent");
      const record: RecordV1 = { version: 1, spec: context.spec, actionId: approval.actionId, actionHash: approval.actionHash,
        attempts: 0, status: "prepared" };
      await atomicWriteJson(this.path, record);
      return this.summary(record);
    });
  }

  async authorize(id: string, hash: string) {
    return this.locked(async context => {
      const record = await this.load(context, id, hash);
      if (record.attempts !== 0) throw new BridgeError("Read authorization already spent");
      await this.approvals.grant("bob", id, hash);
      return { ...this.summary(record), authorizationStatus: "approved", networkRequests: 0 };
    });
  }

  async status() { return this.locked(async context => this.summary(await this.load(context))); }

  /** The ONLY method that may make one GET, and only after separately granted exact read authority. */
  async observe(id: string, hash: string) { return this.execute(id, hash, false); }

  /** Local recovery only. Even after a crash this method cannot construct a live transport. */
  async complete(id: string, hash: string) { return this.execute(id, hash, true); }

  private async execute(id: string, hash: string, offline: boolean) {
    return this.locked(async context => {
      const record = await this.load(context, id, hash);
      const authority = await this.approvals.read("bob", id);
      if (authority.actionHash !== hash) throw new BridgeError("Exact read authority changed");
      if (offline) {
        if (record.attempts !== 1 || !record.retained || !["executing", "confirmed"].includes(authority.status)) {
          throw new BridgeError("No retained authorized observation; another GET is forbidden");
        }
      } else if (record.attempts !== 0 || record.status !== "prepared" || authority.status !== "approved") {
        throw new BridgeError("A separate, unused exact read authorization is required");
      }
      let stage: ReceiveStage = "preflight";
      let http: Omit<ReadProgress, "stage"> = {};
      const setStage = (value: ReceiveStage) => { stage = value; };
      let runtime: AgentRuntime | undefined;
      try {
        const expected = { step: 1, expectedSeq: 1, previousCursor: 1, senderDid: context.spec.expectedSenderDid,
          receiverDid: context.spec.agentDid, payloadHash: context.spec.expectedPayloadHash };
        if (record.retained) {
          if (hashValue(record.retained.peek) !== record.retained.hash) throw new BridgeError("Retained observation changed");
          validateReceipt(record.retained.peek, expected, setStage, false);
        }
        let called = false;
        const transport: TechnocoreTransport = { sendSignedMessage: denied, readRoomText: denied,
          readRoomJson: async (room, query) => {
            if (offline || called || room !== context.mailbox.room || hashValue(query) !== hashValue(RECONCILIATION_QUERY)) {
              throw new BridgeError("Unexpected reconciliation read");
            }
            called = true;
            if (await this.stores.cursors.get("bob", room) !== 1) throw new BridgeError("Cursor changed before observation");
            if (this.options.offlineTransport) return this.options.offlineTransport.readRoomJson(room, RECONCILIATION_QUERY);
            if (process.env.TECHNOCORE_URL !== context.spec.origin) throw new BridgeError("Canonical live endpoint is required");
            return new HttpTechnocoreTransport(context.spec.origin, { ...RECONCILIATION_HTTP_OPTIONS,
              onReadProgress: progress => { stage = progress.stage; const { stage: _, ...safe } = progress; http = { ...http, ...safe }; },
            }).readRoomJson(room, RECONCILIATION_QUERY);
          } };
        stage = "identity-unlock";
        runtime = await AgentRuntime.start({ identityAlias: "bob", expectedDid: context.spec.agentDid, root: this.stores.paths.root,
          passphrases: this.options.passphrases, handleSignals: false, transport,
          inference: { name: "disabled", infer: denied } });
        const key = `inbound:${hashText(context.mailbox.room).slice(0, 16)}:1`;
        const taskId = `inbound_${hashText(key).slice(0, 32)}`;
        const tasks = Object.values((await runtime.state.load()).tasks);
        if (tasks.some(t => ["pending", "running", "awaiting-approval", "ambiguous"].includes(t.status) &&
          !(offline && t.id === taskId && t.type === "inbound.message"))) throw new BridgeError("Unexpected pending work");
        const intake: InboxIntakeOptions = {
          onStage: setStage,
          validate: async peek => {
            validateReceipt(peek, expected, setStage, false);
            // Retain only a fully validated single message. Do not spread untrusted objects into state.
            const message = peek.messages[0]!;
            const retained: InboxPeekResult = { previousCursor: 1, firstSeq: peek.firstSeq, lastSeq: peek.lastSeq, messages: [{
              seq: message.seq, ts: message.ts, senderDid: message.senderDid,
              ...(message.contactId ? { contactId: message.contactId } : {}), text: message.text,
              ...(message.nonce === undefined ? {} : { nonce: message.nonce }), serverVerifiedDid: true, trust: "untrusted-external-data",
            }] };
            if (record.retained && record.retained.hash !== hashValue(retained)) throw new BridgeError("Observation changed during recovery");
            if (!record.retained) {
              stage = "receipt-checkpoint";
              record.retained = { peek: retained, hash: hashValue(retained) }; record.status = "observed";
              await atomicWriteJson(this.path, record);
            }
          },
          afterPersist: async () => {
            const task = (await runtime!.state.load()).tasks[taskId];
            const journal = await new ActivityJournal(agentPaths(this.stores.paths.root, "bob").journal).read();
            if (!task || task.type !== "inbound.message" || task.payload.seq !== 1 ||
              task.payload.senderDid !== context.spec.expectedSenderDid || task.payload.serverVerifiedDid !== true ||
              hashValue(task.payload.text) !== context.spec.expectedPayloadHash ||
              !journal.some(e => e.taskId === taskId && e.event === "inbound-persisted" && e.resultHash === hashValue(task.payload))) {
              throw new BridgeError("Durable receipt evidence missing");
            }
            if (await this.stores.cursors.get("bob", context.mailbox.room) !== 1) throw new BridgeError("Cursor changed during persistence");
            record.checkpoint = { step: 1, seq: 1, payloadHash: context.spec.expectedPayloadHash, inboundTaskId: taskId,
              inboundPayloadHash: hashValue(task.payload), observationHash: record.retained!.hash, authorizationHash: hash,
              timestamp: record.checkpoint?.timestamp ?? new Date().toISOString(), cursorUnchanged: true,
              kind: this.options.offlineTransport ? "deterministic-offline" : "live-observation" };
            record.status = "checkpoint"; await atomicWriteJson(this.path, record);
          },
        };
        if (offline) {
          await runtime.persistInbox(structuredClone(record.retained!.peek), intake);
        } else {
          stage = "get-intent";
          // Intent + authority are consumed durably BEFORE any IO; either crash window fails closed.
          await this.approvals.consume(context.effect, id);
          record.attempts = 1; record.status = "get-intent"; await atomicWriteJson(this.path, record);
          await runtime.ingestInbox({ ...intake, since: 0 });
        }
        // Intake does not rewrite a cursor already equal to seq=1. The checkpoint, not that old cursor, is receipt evidence.
        stage = "local-completion";
        if (authority.status !== "confirmed") await this.approvals.finish("bob", id, "confirmed");
        record.status = "complete"; delete record.failure; await atomicWriteJson(this.path, record);
        return this.summary(record);
      } catch (error) {
        record.failure = receiveFailure({ step: 1, expectedSeq: 1, previousCursor: 1, stage, code: "reconciliation-failed",
          contactHash: context.spec.mailboxContactHash, http }, error);
        // Failed preflight does not consume read authority; failed/ambiguous IO never permits a second GET.
        if (record.attempts === 1) record.status = "failed";
        await atomicWriteJson(this.path, record);
        throw new BridgeError("Reconciliation failed closed");
      } finally { await runtime?.close(record.failure ? "failed" : "clean"); }
    });
  }
}
