import { AmbiguousSendError, BridgeError } from "../errors.js";
import { resolve } from "node:path";
import { ApprovalRequiredError, type ActionApproval } from "./approvals.js";
import { AgentRoleStore, assertRoleWorkload, type AgentRole } from "./roles.js";
import { validateEvidence, type TaskEvidence } from "./evidence.js";
import { SignedAgentBridge, type BridgeStores } from "../bridge.js";
import { createStores } from "../context.js";
import { roomClasses } from "../names.js";
import type { PassphraseProvider } from "../passphrase.js";
import type { TechnocoreTransport, UnlockedIdentity } from "../types.js";
import { WorkloadExecutor } from "../workloads/executor.js";
import {
  createDefaultWorkloadRegistry,
  type WorkloadRegistry,
} from "../workloads/registry.js";
import { ActivityJournal } from "./journal.js";
import { LocalMemoryProvider } from "./memory.js";
import { agentPaths, type AgentPaths } from "./paths.js";
import { AgentRuntimeLock } from "./runtime-lock.js";
import { AgentStateStore, safeErrorRecord } from "./state-store.js";
import type {
  AgentTask,
  EnqueueTaskInput,
  InferenceMetadata,
  InferenceProvider,
  JournalEntry,
  MemoryProvider,
  RuntimeRunResult,
} from "./types.js";
import {
  hashText,
  hashValue,
  randomId,
  systemClock,
  timestamp,
  type AgentClock,
  type AgentIdGenerator,
} from "./util.js";

interface StoreContext extends BridgeStores {
  paths: ReturnType<typeof createStores>["paths"];
}

export interface InitializeAgentOptions {
  identityAlias: string;
  root?: string;
  passphrases: PassphraseProvider;
  clock?: AgentClock;
  ids?: AgentIdGenerator;
}

export interface InitializeAgentResult {
  identityAlias: string;
  did: string;
  created: boolean;
  unlockedForVerification: true;
  liveActivity: false;
}

export async function initializeAgent(options: InitializeAgentOptions): Promise<InitializeAgentResult> {
  const context = createStores(options.root, options.passphrases);
  const paths = agentPaths(context.paths.root, options.identityAlias);
  const state = new AgentStateStore(paths.state, options.clock, options.ids);
  let unlocked: UnlockedIdentity | undefined;
  try {
    unlocked = await context.identities.unlock(options.identityAlias);
    const initialized = await state.initialize(unlocked);
    if (initialized.state.profile.did !== unlocked.did) {
      throw new BridgeError("Agent profile DID verification failed");
    }
    return {
      identityAlias: unlocked.name,
      did: unlocked.did,
      created: initialized.created,
      unlockedForVerification: true,
      liveActivity: false,
    };
  } finally {
    unlocked = undefined;
  }
}

export interface AgentRuntimeStartOptions {
  identityAlias: string;
  expectedDid?: string;
  root?: string;
  passphrases: PassphraseProvider;
  inference: InferenceProvider;
  transport?: TechnocoreTransport;
  clock?: AgentClock;
  ids?: AgentIdGenerator;
  monotonicNow?: () => number;
  handleSignals?: boolean;
  stores?: StoreContext;
  state?: AgentStateStore;
  journal?: ActivityJournal;
  memory?: MemoryProvider;
  workloads?: WorkloadRegistry;
}

function requiredString(payload: Record<string, unknown>, key: string, maximum = 16_384): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new BridgeError(`Task payload field ${key} is invalid`);
  }
  return value;
}

export class AgentRuntime {
  readonly paths: AgentPaths;
  readonly state: AgentStateStore;
  readonly journal: ActivityJournal;
  readonly memory: MemoryProvider;
  readonly identityAlias: string;
  readonly sessionId: string;

  private unlockedIdentity: UnlockedIdentity | undefined;
  private stopRequested = false;
  private closed = false;
  private readonly bridge: SignedAgentBridge | undefined;
  private readonly workloadExecutor: WorkloadExecutor;
  private readonly signalHandler = (): void => {
    void this.requestStop();
  };

  private constructor(
    identityAlias: string,
    private readonly stores: StoreContext,
    paths: AgentPaths,
    state: AgentStateStore,
    journal: ActivityJournal,
    memory: MemoryProvider,
    private readonly inference: InferenceProvider,
    private readonly lock: AgentRuntimeLock,
    unlockedIdentity: UnlockedIdentity,
    sessionId: string,
    transport: TechnocoreTransport | undefined,
    private readonly clock: AgentClock,
    private readonly monotonicNow: () => number,
    private readonly handlesSignals: boolean,
    workloads: WorkloadRegistry,
    readonly role: AgentRole | undefined,
  ) {
    this.identityAlias = identityAlias;
    this.paths = paths;
    this.state = state;
    this.journal = journal;
    this.memory = memory;
    this.unlockedIdentity = unlockedIdentity;
    this.sessionId = sessionId;
    this.bridge = transport ? new SignedAgentBridge(stores, transport) : undefined;
    this.workloadExecutor = new WorkloadExecutor(workloads, inference, memory, monotonicNow);
    if (handlesSignals) {
      process.once("SIGINT", this.signalHandler);
      process.once("SIGTERM", this.signalHandler);
    }
  }

  static async start(options: AgentRuntimeStartOptions): Promise<AgentRuntime> {
    const clock = options.clock ?? systemClock;
    const ids = options.ids ?? randomId;
    const stores = options.stores ?? createStores(options.root, options.passphrases);
    const paths = agentPaths(stores.paths.root, options.identityAlias);
    const state = options.state ?? new AgentStateStore(paths.state, clock, ids);
    const journal = options.journal ?? new ActivityJournal(paths.journal);
    const memory = options.memory ?? new LocalMemoryProvider(paths.memory, clock);
    if (resolve(state.path) !== paths.state || resolve(journal.path) !== paths.journal ||
      (memory instanceof LocalMemoryProvider && resolve(memory.path) !== paths.memory)) {
      throw new BridgeError("Injected stores must belong to the selected agent profile");
    }
    const lock = await AgentRuntimeLock.acquire(paths.runtimeLock);
    let unlocked: UnlockedIdentity | undefined;
    let sessionId: string | undefined;
    let profileVerified = false;
    try {
      const persisted = await state.load();
      if (persisted.profile.identityAlias !== options.identityAlias) {
        throw new BridgeError("Agent profile identity alias does not match startup selection");
      }
      const publicIdentity = await stores.identities.inspect(options.identityAlias);
      if (publicIdentity.did !== persisted.profile.did ||
        (options.expectedDid !== undefined && publicIdentity.did !== options.expectedDid)) {
        throw new BridgeError("Agent profile DID does not match the unlocked identity or expected DID");
      }
      const role = await new AgentRoleStore(paths.directory).load(publicIdentity);
      unlocked = await stores.identities.unlock(options.identityAlias);
      if (unlocked.did !== persisted.profile.did) {
        throw new BridgeError("Agent profile DID does not match the unlocked identity");
      }
      profileVerified = true;
      await state.setRuntimeStatus("booting");
      await state.recoverInterruptedTasks();
      sessionId = await state.startSession(ids("session"));
      return new AgentRuntime(
        options.identityAlias,
        stores,
        paths,
        state,
        journal,
        memory,
        options.inference,
        lock,
        unlocked,
        sessionId,
        options.transport,
        clock,
        options.monotonicNow ?? (() => performance.now()),
        options.handleSignals ?? true,
        options.workloads ?? createDefaultWorkloadRegistry(),
        role,
      );
    } catch (error) {
      unlocked = undefined;
      if (sessionId) await state.endSession(sessionId, "failed").catch(() => undefined);
      else if (profileVerified) await state.setRuntimeStatus("failed").catch(() => undefined);
      await lock.release();
      throw error;
    }
  }

  get did(): string {
    return this.requireIdentity().did;
  }

  async enqueueTask(input: EnqueueTaskInput): Promise<AgentTask> {
    this.assertOpen();
    this.assertTaskAllowed(input.type);
    return this.state.enqueueTask(input);
  }

  private assertTaskAllowed(type: string): void {
    if (this.role && !["inbound.message", "technocore.send-contact", "technocore.send-public"].includes(type)) {
      assertRoleWorkload(this.role, type);
    }
  }

  private actionId(task: AgentTask): string {
    return hashValue({ did: this.did, taskId: task.id, type: task.type });
  }

  async requestOutboundApproval(taskId: string): Promise<ActionApproval> {
    this.assertOpen();
    const task = (await this.state.load()).tasks[taskId];
    if (!task) throw new BridgeError("Unknown outbound task");
    const bridge = this.requireBridge();
    if (task.type === "technocore.send-contact" && task.payload.expectedRecipientDid !== undefined) {
      const contact = await this.stores.contacts.get(this.identityAlias, requiredString(task.payload, "contactId", 128));
      if (contact.did !== task.payload.expectedRecipientDid) throw new BridgeError("Outbound recipient DID changed");
    }
    if (task.type === "technocore.send-contact") return bridge.prepareContactSend(
      this.identityAlias, requiredString(task.payload, "contactId", 128),
      requiredString(task.payload, "text"), this.actionId(task));
    if (task.type === "technocore.send-public") return bridge.preparePublicSend(
      this.identityAlias, requiredString(task.payload, "room", 48),
      requiredString(task.payload, "text"), this.actionId(task));
    throw new BridgeError("Task is not a supported outbound action");
  }

  /** Operator API. Not passed to an inference provider or peer content handler. */
  async approveOutboundTask(taskId: string, expectedActionHash: string): Promise<void> {
    const request = await this.requestOutboundApproval(taskId);
    if (request.actionHash !== expectedActionHash) throw new BridgeError("Approval hash mismatch");
    if (request.status === "requested") await this.stores.approvals.grant(this.identityAlias, request.actionId, expectedActionHash);
    else if (request.status !== "approved") throw new BridgeError("Outbound approval already spent; reconcile before follow-up");
    await this.state.resumeAfterApproval(taskId);
  }

  async exportTaskEvidence(taskId: string): Promise<TaskEvidence> {
    this.assertOpen();
    const state = await this.state.load();
    if (state.profile.did !== this.did || state.profile.identityAlias !== this.identityAlias) {
      throw new BridgeError("Profile binding changed");
    }
    const task = state.tasks[taskId];
    if (!task || task.status !== "succeeded" || !task.type.startsWith("workload.") || !task.result?.reference) {
      throw new BridgeError("Only a completed workload can export evidence");
    }
    const record = await this.memory.get(task.result.reference);
    const value = record?.value as { workload: unknown; output: unknown; actions: unknown; inferenceEvidence: {
      requestId: string; requestHash: string; resultHash: string } } | undefined;
    const journal = (await this.journal.read()).find(entry => entry.taskId === taskId && entry.resultHash === task.result!.hash);
    const durable = task.result.evidence;
    const memoryWriteHashes = durable?.memoryWriteHashes ?? journal?.memoryWriteHashes;
    if (!value?.inferenceEvidence || !memoryWriteHashes || task.result.hash !== hashValue({
      workload: value.workload, output: value.output, actions: value.actions,
      inferenceRequestHash: value.inferenceEvidence.requestHash,
      inferenceResultHash: value.inferenceEvidence.resultHash, memoryWriteHashes,
    })) throw new BridgeError("Incomplete or changed workload evidence");
    if (!journal && durable) {
      // Recover a crash after durable completion but before the final journal append, without re-running inference.
      await this.appendJournal({ id: `evt_${hashValue({ taskId, resultHash: task.result.hash, recovered: true })}`,
        taskId, taskType: task.type, event: "workload-evidence-recovered", outcome: "success",
        resultHash: task.result.hash, ...durable });
    }
    return validateEvidence({ mode: "explicit-only", evidence: [{
      agentAlias: this.identityAlias, did: this.did, taskId, workload: task.type,
      resultHash: task.result.hash, outputHash: hashValue(value.output), output: value.output,
      inferenceRequestId: value.inferenceEvidence.requestId,
      inferenceRequestHash: value.inferenceEvidence.requestHash,
      inferenceResultHash: value.inferenceEvidence.resultHash,
      memoryWriteHashes,
    }] }).evidence[0]!;
  }

  async tick(): Promise<RuntimeRunResult> {
    return this.runOnce();
  }

  async run(options: { idleDelayMs?: number } = {}): Promise<void> {
    const idleDelayMs = options.idleDelayMs ?? 1_000;
    if (!Number.isSafeInteger(idleDelayMs) || idleDelayMs < 1 || idleDelayMs > 60_000) {
      throw new BridgeError("Agent idle delay must be an integer from 1 through 60000 milliseconds");
    }
    try {
      while (!this.stopRequested) {
        const result = await this.runOnce();
        if (result.kind === "idle") {
          await new Promise((resolve) => setTimeout(resolve, idleDelayMs));
        }
      }
      await this.close("clean");
    } catch (error) {
      await this.close("failed").catch(() => undefined);
      throw error;
    }
  }

  async runOnce(): Promise<RuntimeRunResult> {
    this.assertOpen();
    if (this.stopRequested) {
      await this.state.setRuntimeStatus("stopping");
      return { kind: "stopping" };
    }
    const task = await this.state.claimNextTask();
    if (!task) {
      await this.state.setRuntimeStatus("idle");
      return { kind: "idle" };
    }

    let completed: AgentTask;
    try {
      completed = await this.executeTask(task);
    } catch (error) {
      if (error instanceof ApprovalRequiredError) {
        completed = await this.state.waitForApproval(task.id);
        await this.appendTaskJournal(completed, "outbound-approval-required", "info", { actionHash: error.actionHash });
        return { kind: "processed", task: completed };
      }
      completed = await this.state.finishTask(task.id, "failed", {
        error: safeErrorRecord(error),
      });
      await this.appendTaskJournal(completed, "task-failed", "failure", {
        error: completed.error!,
      });
    }
    return { kind: "processed", task: completed };
  }

  private async executeTask(task: AgentTask): Promise<AgentTask> {
    this.assertTaskAllowed(task.type);
    switch (task.type) {
      case "inference":
        return this.executeInference(task);
      case "memory.put":
        return this.executeMemoryPut(task);
      case "technocore.send-contact":
        return this.executeContactSend(task);
      case "technocore.send-public":
        return this.executePublicSend(task);
      case "inbound.message":
        return this.completeInboundTask(task);
      default:
        return this.executeWorkload(task);
    }
  }

  private async executeInference(task: AgentTask): Promise<AgentTask> {
    await this.state.checkpointTask(task.id, "inference-intent", "possible");
    const started = this.monotonicNow();
    let result;
    try {
      result = await this.inference.infer({
        requestId: `req_${hashValue({ taskId: task.id, attempt: task.attempts }).slice(0, 32)}`,
        taskId: task.id,
        taskType: task.type,
        input: structuredClone(task.payload.input),
      });
    } catch (error) {
      const completed = await this.state.finishTask(task.id, "ambiguous", {
        error: safeErrorRecord(error),
      });
      await this.appendTaskJournal(completed, "inference-result", "ambiguous", {
        error: completed.error!,
      });
      return completed;
    }
    const metadata: InferenceMetadata = {
      ...result.metadata,
      latencyMs: result.metadata.latencyMs ?? Math.max(0, Math.round(this.monotonicNow() - started)),
    };
    if (result.outcome === "ambiguous") {
      const completed = await this.state.finishTask(task.id, "ambiguous", {
        error: safeErrorRecord(Object.assign(new Error("Ambiguous inference outcome"), {
          code: result.errorCode,
        })),
      });
      await this.appendTaskJournal(completed, "inference-result", "ambiguous", {
        inference: metadata,
        error: completed.error!,
      });
      return completed;
    }
    if (result.outcome === "failure") {
      const error = safeErrorRecord(Object.assign(new Error("Inference provider reported failure"), {
        code: result.errorCode,
      }));
      if (result.retrySafe && task.attempts < task.maxAttempts) {
        const pending = await this.state.retryTask(task.id, error);
        await this.appendTaskJournal(pending, "inference-retry", "failure", {
          inference: metadata,
          error,
        });
        return pending;
      }
      const completed = await this.state.finishTask(task.id, "failed", { error });
      await this.appendTaskJournal(completed, "inference-result", "failure", {
        inference: metadata,
        error,
      });
      return completed;
    }

    const memory = await this.memory.put({
      idempotencyKey: `${task.idempotencyKey}:result`,
      scope: `task:${task.id}`,
      key: "inference-result",
      value: result.output,
      tags: ["inference", this.inference.name],
    });
    await this.state.checkpointTask(task.id, "inference-confirmed", "confirmed");
    const completed = await this.state.finishTask(task.id, "succeeded", {
      result: { hash: memory.valueHash, reference: memory.id },
    });
    await this.appendTaskJournal(completed, "inference-result", "success", {
      inference: metadata,
      resultHash: memory.valueHash,
      memoryWriteHashes: [memory.valueHash],
    });
    return completed;
  }

  private async executeMemoryPut(task: AgentTask): Promise<AgentTask> {
    const scope = requiredString(task.payload, "scope", 256);
    const key = requiredString(task.payload, "key", 256);
    const tagsValue = task.payload.tags;
    const tags = tagsValue === undefined
      ? undefined
      : Array.isArray(tagsValue) && tagsValue.every((tag) => typeof tag === "string")
        ? tagsValue as string[]
        : (() => { throw new BridgeError("Task payload field tags is invalid"); })();
    const memory = await this.memory.put({
      idempotencyKey: `${task.idempotencyKey}:memory`,
      scope,
      key,
      value: structuredClone(task.payload.value),
      ...(tags ? { tags } : {}),
    });
    const completed = await this.state.finishTask(task.id, "succeeded", {
      result: { hash: memory.valueHash, reference: memory.id },
    });
    await this.appendTaskJournal(completed, "memory-written", "success", {
      resultHash: memory.valueHash,
      memoryWriteHashes: [memory.valueHash],
    });
    return completed;
  }

  private async executeContactSend(task: AgentTask): Promise<AgentTask> {
    const bridge = this.requireBridge();
    const contactId = requiredString(task.payload, "contactId", 128);
    const text = requiredString(task.payload, "text");
    const contact = await this.stores.contacts.get(this.identityAlias, contactId);
    const privateRoomHash = hashText(contact.mailbox);
    const approval = await this.requireOutboundApproval(task);
    await this.state.checkpointTask(task.id, "action-intent", "possible");
    await this.appendTaskJournal(task, "outbound-action-intent", "info", { actionHash: approval.actionHash });
    try {
      const response = await bridge.sendToUnlocked(
        this.identityAlias,
        this.requireIdentity(),
        contactId,
        text,
        this.actionId(task),
      );
      const seq = response.posted?.seq ?? response.last_seq;
      await this.state.checkpointTask(task.id, "action-confirmed", "confirmed");
      const completed = await this.state.finishTask(task.id, "succeeded", {
        result: { hash: hashValue({ did: this.did, seq }), reference: `seq:${seq}` },
      });
      await this.appendTaskJournal(completed, "technocore-send", "success", {
        privateRoomHash,
        actionHash: approval.actionHash,
        resultHash: completed.result!.hash,
      });
      return completed;
    } catch (error) {
      if (!(error instanceof AmbiguousSendError)) throw error;
      const completed = await this.state.finishTask(task.id, "ambiguous", {
        error: safeErrorRecord(error),
      });
      await this.appendTaskJournal(completed, "technocore-send", "ambiguous", {
        privateRoomHash,
        actionHash: approval.actionHash,
        error: completed.error!,
      });
      return completed;
    }
  }

  private async executePublicSend(task: AgentTask): Promise<AgentTask> {
    const bridge = this.requireBridge();
    const room = requiredString(task.payload, "room", 48);
    const text = requiredString(task.payload, "text");
    const classes = roomClasses(room);
    if (classes.includes("p") || classes.includes("mb")) {
      throw new BridgeError("Agent public send requires a public room");
    }
    const approval = await this.requireOutboundApproval(task);
    await this.state.checkpointTask(task.id, "action-intent", "possible");
    await this.appendTaskJournal(task, "outbound-action-intent", "info", { actionHash: approval.actionHash });
    try {
      const response = await bridge.sendSignedToRoomUnlocked(this.requireIdentity(), room, text, this.actionId(task));
      const seq = response.posted?.seq ?? response.last_seq;
      await this.state.checkpointTask(task.id, "action-confirmed", "confirmed");
      const completed = await this.state.finishTask(task.id, "succeeded", {
        result: { hash: hashValue({ did: this.did, room, seq }), reference: `seq:${seq}` },
      });
      await this.appendTaskJournal(completed, "technocore-send", "success", {
        publicTechnocore: { room, seq, did: this.did },
        actionHash: approval.actionHash,
        resultHash: completed.result!.hash,
      });
      return completed;
    } catch (error) {
      if (!(error instanceof AmbiguousSendError)) throw error;
      const completed = await this.state.finishTask(task.id, "ambiguous", {
        error: safeErrorRecord(error),
      });
      await this.appendTaskJournal(completed, "technocore-send", "ambiguous", {
        actionHash: approval.actionHash,
        error: completed.error!,
      });
      return completed;
    }
  }

  private async completeInboundTask(task: AgentTask): Promise<AgentTask> {
    const resultHash = hashValue(task.payload);
    const completed = await this.state.finishTask(task.id, "succeeded", {
      result: { hash: resultHash, reference: "stored-untrusted-input" },
    });
    await this.appendTaskJournal(completed, "inbound-reviewed-as-data", "success", {
      resultHash,
    });
    return completed;
  }

  private async requireOutboundApproval(task: AgentTask): Promise<ActionApproval> {
    const approval = await this.requestOutboundApproval(task.id);
    if (approval.status === "requested") throw new ApprovalRequiredError(approval.actionId, approval.actionHash);
    if (approval.status !== "approved") throw new BridgeError("Outbound approval spent; reconcile before follow-up");
    return approval;
  }

  private async executeWorkload(task: AgentTask): Promise<AgentTask> {
    const result = await this.workloadExecutor.execute(task, {
      beforeInference: () => this.state.checkpointTask(
        task.id,
        "workload-inference-intent",
        "possible",
      ).then(() => undefined),
    });
    const inferenceRequestHash = result.outcome === "success"
      ? result.evidence.inferenceRequestHash
      : result.inferenceRequestHash;
    const inferenceRequestId = result.outcome === "success"
      ? result.evidence.inferenceRequestId
      : result.inferenceRequestId;
    const inferenceResultHash = result.outcome === "success"
      ? result.evidence.inferenceResultHash
      : result.outcome === "failure"
        ? result.inferenceResultHash
        : undefined;
    const common = {
      ...(result.metadata ? { inference: result.metadata } : {}),
      inferenceRequestId,
      inferenceRequestHash,
      ...(inferenceResultHash ? { inferenceResultHash } : {}),
    };
    if (result.outcome === "ambiguous") {
      const completed = await this.state.finishTask(task.id, "ambiguous", { error: result.error });
      await this.appendTaskJournal(completed, result.journalEvent, "ambiguous", {
        ...common,
        error: result.error,
      });
      return completed;
    }
    if (result.outcome === "failure") {
      if (result.retrySafe && task.attempts < task.maxAttempts) {
        const pending = await this.state.retryTask(task.id, result.error);
        await this.appendTaskJournal(pending, result.journalEvent, "failure", {
          ...common,
          error: result.error,
        });
        return pending;
      }
      const completed = await this.state.finishTask(task.id, "failed", { error: result.error });
      await this.appendTaskJournal(completed, result.journalEvent, "failure", {
        ...common,
        error: result.error,
      });
      return completed;
    }
    await this.state.checkpointTask(task.id, "workload-result-persisted", "confirmed");
    const completed = await this.state.finishTask(task.id, "succeeded", {
      result: {
        hash: result.evidence.finalResultHash,
        reference: result.resultReference,
        evidence: {
          inferenceRequestId: result.evidence.inferenceRequestId,
          inferenceRequestHash: result.evidence.inferenceRequestHash,
          inferenceResultHash: result.evidence.inferenceResultHash,
          memoryWriteHashes: result.evidence.memoryWriteHashes,
        },
      },
    });
    await this.appendTaskJournal(completed, result.journalEvent, "success", {
      ...common,
      resultHash: result.evidence.finalResultHash,
      memoryWriteHashes: result.evidence.memoryWriteHashes,
    });
    return completed;
  }

  async ingestInbox(options: { collaborationObjective?: string } = {}): Promise<number> {
    this.assertOpen();
    if (this.stopRequested) return 0;
    const bridge = this.requireBridge();
    const peek = await bridge.peekInbox(this.identityAlias);
    const mailbox = await this.stores.mailboxes.load(this.identityAlias);
    const privateRoomHash = hashText(mailbox.room);
    if (peek.lastSeq < peek.previousCursor) throw new BridgeError("Inbox epoch changed; explicit reconciliation required");
    if (peek.firstSeq !== null && peek.firstSeq > peek.previousCursor + 1) {
      await this.appendJournal({
        id: `evt_${hashText(`${this.sessionId}:inbox-retention:${peek.firstSeq}`).slice(0, 32)}`,
        event: "inbox-retention-gap",
        outcome: "info",
        privateRoomHash,
      });
      throw new BridgeError("Inbox retention gap; explicit reconciliation required");
    }
    let acknowledgeThrough = peek.previousCursor;
    for (const message of peek.messages) {
      const key = `inbound:${privateRoomHash.slice(0, 16)}:${message.seq}`;
      const collaboration = options.collaborationObjective !== undefined;
      const task = await this.state.enqueueTask({
        id: `inbound_${hashText(key).slice(0, 32)}`,
        type: collaboration ? "workload.collaboration" : "inbound.message",
        idempotencyKey: key,
        payload: collaboration ? {
          senderDid: message.senderDid,
          messageId: `${message.senderDid}:${message.seq}`,
          seq: message.seq,
          privateRoomHash,
          content: message.text,
          trust: "untrusted-external-data",
          serverVerifiedDid: message.serverVerifiedDid,
          objective: options.collaborationObjective,
        } : {
          seq: message.seq,
          ts: message.ts,
          senderDid: message.senderDid,
          ...(message.contactId ? { contactId: message.contactId } : {}),
          text: message.text,
          ...(message.nonce === undefined ? {} : { nonce: message.nonce }),
          serverVerifiedDid: message.serverVerifiedDid,
          trust: "untrusted-external-data",
        },
      });
      await this.appendJournal({
        id: `evt_${hashText(`${key}:persisted`).slice(0, 32)}`,
        taskId: task.id,
        taskType: task.type,
        event: "inbound-persisted",
        outcome: "success",
        privateRoomHash,
        resultHash: hashValue(task.payload),
      });
      acknowledgeThrough = Math.max(acknowledgeThrough, message.seq);
    }
    if (acknowledgeThrough > peek.previousCursor) {
      await bridge.acknowledgeInbox(this.identityAlias, acknowledgeThrough);
    }
    return peek.messages.length;
  }

  async requestStop(): Promise<void> {
    if (this.closed || this.stopRequested) return;
    this.stopRequested = true;
    await this.state.setRuntimeStatus("stopping");
  }

  async close(outcome: "clean" | "failed" = "clean"): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopRequested = true;
    if (this.handlesSignals) {
      process.off("SIGINT", this.signalHandler);
      process.off("SIGTERM", this.signalHandler);
    }
    try {
      await this.state.endSession(this.sessionId, outcome);
    } finally {
      this.unlockedIdentity = undefined;
      await this.lock.release();
    }
  }

  private async appendTaskJournal(
    task: AgentTask,
    event: string,
    outcome: JournalEntry["outcome"],
    details: Partial<Pick<JournalEntry,
      "inference" | "publicTechnocore" | "privateRoomHash" |
      "inferenceRequestId" | "inferenceRequestHash" | "inferenceResultHash" |
      "memoryWriteHashes" | "resultHash" | "error" | "actionHash">>,
  ): Promise<void> {
    await this.appendJournal({
      id: `evt_${hashText(`${this.sessionId}:${task.id}:${task.attempts}:${event}`).slice(0, 32)}`,
      taskId: task.id,
      taskType: task.type,
      event,
      outcome,
      ...details,
    });
  }

  private async appendJournal(
    entry: Omit<JournalEntry, "version" | "timestamp" | "did" | "sessionId">,
  ): Promise<void> {
    await this.journal.append({
      version: 1,
      timestamp: timestamp(this.clock),
      did: this.did,
      sessionId: this.sessionId,
      ...entry,
    });
  }

  private requireBridge(): SignedAgentBridge {
    if (!this.bridge) throw new BridgeError("This agent runtime has no Technocore transport");
    return this.bridge;
  }

  private requireIdentity(): UnlockedIdentity {
    if (!this.unlockedIdentity) throw new BridgeError("Agent identity is not unlocked");
    return this.unlockedIdentity;
  }

  private assertOpen(): void {
    if (this.closed) throw new BridgeError("Agent runtime is closed");
  }
}
