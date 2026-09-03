import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ActionApprovalStore } from "../agent/approvals.js";
import { ActivityJournal } from "../agent/journal.js";
import { agentPaths } from "../agent/paths.js";
import { AgentRuntimeLock } from "../agent/runtime-lock.js";
import { AgentStateStore } from "../agent/state-store.js";
import { hashText, hashValue } from "../agent/util.js";
import { createStores } from "../context.js";
import { BridgeError } from "../errors.js";
import { atomicWriteJson, readJsonFile } from "../fs-safe.js";
import { validateReceipt } from "./receipt.js";
import type { ReconciliationRecord } from "./reconciliation.js";
import type { RehearsalState } from "./runner.js";

export type RecoveryBoundary = "recovery-intent" | "receipt-verified" | "main-applied" | "applied";
export interface RecoveryHooks {
  /** Trusted offline crash-injection seam; never accepted by CLI or serialized input. */
  afterPersist?: (phase: RecoveryBoundary) => void | Promise<void>;
}

export interface RecoveredReceipt {
  version: 1;
  step: 1;
  seq: 1;
  payloadHash: string;
  inboundTaskId: string;
  inboundPayloadHash: string;
  observationHash: string;
  authorizationId: string;
  authorizationHash: string;
  reconciliationFileHash: string;
  journalEvidenceHash: string;
  originalStateHash: string;
  recoveredAt: string;
  cursorMutation: "unnecessary";
  originalReceive: { status: "get-intent"; halted: "receipt-validation-or-persistence-failed" };
  reconciliation: { status: "complete"; kind: "live-observation"; observationAttempts: 1 };
  outcome: "applied";
}

interface RecoveryTransition {
  version: 1;
  phase: "recovery-intent" | "receipt-verified" | "applied";
  receipt: RecoveredReceipt;
  receiptHash: string;
}

function requireEvidence(condition: unknown): asserts condition {
  if (!condition) throw new BridgeError("Offline recovery evidence mismatch");
}

export function reconciliationFile(root: string): string {
  return resolve(root, "agents/bob/reconciliation/first-room-read-v1-step-1.json");
}

/** Called under reconciliation + rehearsal locks. This module has no transport, unlock or execution path. */
export async function applyReceiptRecovery(root: string, mainPath: string, current: RehearsalState,
  id: string, hash: string, hooks: RecoveryHooks = {}) {
  const locks: AgentRuntimeLock[] = [];
  try {
    for (const alias of ["alice", "bob"]) locks.push(await AgentRuntimeLock.acquire(agentPaths(root, alias).runtimeLock));
    const stores = createStores(root);
    const transitionPath = `${mainPath}.recovery.json`;
    let transition = await readJsonFile<RecoveryTransition | null>(transitionPath, null);
    const alreadyApplied = current.steps[0]?.status === "received-reconciled";
    const original = structuredClone(current);
    if (alreadyApplied) {
      requireEvidence(transition && current.index >= 1 && current.steps[0]?.recovery &&
        hashValue(current.steps[0].recovery) === transition.receiptHash);
      original.index = 0; original.halted = "receipt-validation-or-persistence-failed";
      const step = original.steps[0]!;
      step.status = "get-intent"; delete step.recovery; delete step.inboundTaskId; delete step.observation;
      // Reconstruct only the immutable source of this transition, not later operator work.
      // An already-applied command must never roll back later steps or clear a later halt.
      original.posts = 1; original.gets = 1; original.complete = false; original.analyses = {};
      original.steps = [step, ...original.steps.slice(1).map(() => ({ status: "planned" as const }))];
    }

    const validate = async () => {
      const step = original.steps[0]!;
      requireEvidence(original.mode === "live" && original.index === 0 && !original.complete && original.posts === 1 && original.gets === 1 &&
        original.halted === "receipt-validation-or-persistence-failed" && step.status === "get-intent" && step.seq === 1 &&
        !step.observation && !step.inboundTaskId && !step.recovery && typeof step.text === "string" && hashValue(step.text) === step.payloadHash &&
        original.steps.slice(1).every(s => hashValue(s) === hashValue({ status: "planned" })) && Object.keys(original.analyses).length === 0);
      const raw = await readFile(reconciliationFile(root), "utf8");
      const record = JSON.parse(raw) as ReconciliationRecord;
      const checkpoint = record.checkpoint, retained = record.retained, spec = record.spec;
      requireEvidence(record.version === 1 && record.status === "complete" && record.attempts === 1 && !record.failure &&
        record.actionId === id && record.actionHash === hash && checkpoint && retained);
      const expectedSpec = { version: 1, type: "technocore.reconcile-read", agentAlias: "bob", agentDid: original.dids.bob,
        step: 1, mailboxContactHash: original.destinations[0], origin: "https://technocore.chat", query: { since: 0, wait: 0, limit: 200 },
        expectedSenderDid: original.dids.alice, expectedSeq: 1, expectedPayloadHash: step.payloadHash, previousCursor: 1,
        originalStateHash: hashValue(original), mode: "live" };
      requireEvidence(hashValue(spec) === hashValue(expectedSpec));
      const authority = await new ActionApprovalStore(resolve(root, "reconciliation-approvals")).read("bob", id);
      const expectedEffect = { agentAlias: "bob", agentDid: original.dids.bob, type: "technocore.reconcile-read",
        destinationHash: original.destinations[0], payloadHash: hashValue(spec) };
      requireEvidence(id === hashValue({ purpose: "first-receipt-reconciliation-v1", originalSendAction: step.actionId }) &&
        authority.status === "confirmed" && authority.actionHash === hash && hash === hashValue({ actionId: id, ...expectedEffect }));
      requireEvidence(checkpoint.kind === "live-observation" && checkpoint.step === 1 && checkpoint.seq === 1 && checkpoint.cursorUnchanged === true &&
        checkpoint.authorizationHash === hash && checkpoint.payloadHash === step.payloadHash && !Number.isNaN(Date.parse(checkpoint.timestamp)) &&
        checkpoint.observationHash === retained.hash && retained.hash === hashValue(retained.peek));
      validateReceipt(retained.peek, { step: 1, expectedSeq: 1, previousCursor: 1, senderDid: original.dids.alice,
        receiverDid: original.dids.bob, payloadHash: step.payloadHash! }, () => undefined, false);
      const mailbox = await stores.mailboxes.load("bob");
      requireEvidence(mailbox.did === original.dids.bob && await stores.cursors.get("bob", mailbox.room) === 1);
      const key = `inbound:${hashText(mailbox.room).slice(0, 16)}:1`;
      const taskId = `inbound_${hashText(key).slice(0, 32)}`;
      const bob = await new AgentStateStore(agentPaths(root, "bob").state).load();
      const task = bob.tasks[taskId];
      const message = retained.peek.messages[0]!;
      const payload = { seq: message.seq, ts: message.ts, senderDid: message.senderDid,
        ...(message.contactId ? { contactId: message.contactId } : {}), text: message.text,
        ...(message.nonce === undefined ? {} : { nonce: message.nonce }), serverVerifiedDid: true, trust: "untrusted-external-data" };
      requireEvidence(bob.profile.identityAlias === "bob" && bob.profile.did === original.dids.bob && checkpoint.inboundTaskId === taskId &&
        task?.type === "inbound.message" && task.id === taskId && task.idempotencyKey === key &&
        ["pending", "succeeded"].includes(task.status) && hashValue(task.payload) === checkpoint.inboundPayloadHash &&
        hashValue(payload) === checkpoint.inboundPayloadHash && task.payload.text === step.text);
      const journal = await new ActivityJournal(agentPaths(root, "bob").journal).read();
      const evidence = journal.filter(e => e.event === "inbound-persisted" && e.taskId === taskId);
      requireEvidence(evidence.length === 1);
      const entry = evidence[0]!;
      requireEvidence(entry.id === `evt_${hashText(`${key}:persisted`).slice(0, 32)}` && entry.did === original.dids.bob &&
        entry.taskType === "inbound.message" && entry.outcome === "success" && entry.resultHash === checkpoint.inboundPayloadHash &&
        entry.privateRoomHash === hashText(mailbox.room));
      const alice = await new AgentStateStore(agentPaths(root, "alice").state).load();
      const send = alice.tasks[step.taskId!];
      const sentApproval = await stores.approvals.read("alice", step.actionId!);
      requireEvidence(send?.type === "technocore.send-contact" && send.status === "succeeded" && send.result?.reference === "seq:1" &&
        send.payload.text === step.text && send.payload.contactId === "bob" && send.payload.expectedRecipientDid === original.dids.bob &&
        sentApproval.status === "confirmed" && sentApproval.agentDid === original.dids.alice && sentApproval.actionHash === step.actionHash &&
        sentApproval.payloadHash === step.payloadHash && sentApproval.destinationHash === original.destinations[0]);
      return { checkpoint, peek: retained.peek, reconciliationFileHash: hashText(raw), journalEvidenceHash: hashValue(entry) };
    };

    // Reject bad input before creating an intent or mutating either evidence or the main manifest.
    const verified = await validate();
    if (transition) {
      requireEvidence(transition.version === 1 && ["recovery-intent", "receipt-verified", "applied"].includes(transition.phase) &&
        !Number.isNaN(Date.parse(transition.receipt.recoveredAt)));
    }
    const receipt: RecoveredReceipt = { version: 1, step: 1, seq: 1, payloadHash: original.steps[0]!.payloadHash!,
      inboundTaskId: verified.checkpoint.inboundTaskId, inboundPayloadHash: verified.checkpoint.inboundPayloadHash,
      observationHash: verified.checkpoint.observationHash, authorizationId: id, authorizationHash: hash,
      reconciliationFileHash: verified.reconciliationFileHash, journalEvidenceHash: verified.journalEvidenceHash,
      originalStateHash: hashValue(original), recoveredAt: transition?.receipt.recoveredAt ?? new Date().toISOString(),
      cursorMutation: "unnecessary", originalReceive: { status: "get-intent", halted: "receipt-validation-or-persistence-failed" },
      reconciliation: { status: "complete", kind: "live-observation", observationAttempts: 1 }, outcome: "applied" };
    const receiptHash = hashValue(receipt);
    if (transition) requireEvidence(transition.receiptHash === receiptHash && hashValue(transition.receipt) === receiptHash);
    requireEvidence(!alreadyApplied || transition?.phase === "receipt-verified" || transition?.phase === "applied");
    requireEvidence(alreadyApplied || transition?.phase !== "applied");
    const next = structuredClone(original);
    next.steps[0]!.status = "received-reconciled";
    next.steps[0]!.inboundTaskId = receipt.inboundTaskId;
    next.steps[0]!.observation = { kind: "live-observation", firstSeq: verified.peek.firstSeq, lastSeq: verified.peek.lastSeq,
      seq: 1, messageHash: receipt.payloadHash };
    next.steps[0]!.recovery = receipt;
    next.index = 1; delete next.halted;
    if (alreadyApplied) requireEvidence(hashValue(current.steps[0]) === hashValue(next.steps[0]) &&
      (transition?.phase === "applied" || hashValue(current) === hashValue(next)));
    const report = (status: "applied" | "already-applied") => ({ status, nextStep: alreadyApplied ? current.index + 1 : 2,
      step1: "received-reconciled", step2: alreadyApplied ? current.steps[1]!.status : "planned",
      logicalPostAttempts: current.posts, getAttempts: current.gets, observationAttempts: 1, cursorMutation: "unnecessary", networkRequests: 0,
      authorizationId: id, authorizationHash: hash, recovery: receipt });
    if (alreadyApplied && transition?.phase === "applied") return report("already-applied");

    if (!transition) {
      transition = { version: 1, phase: "recovery-intent", receipt, receiptHash };
      await atomicWriteJson(transitionPath, transition); await hooks.afterPersist?.("recovery-intent");
    }
    if (!alreadyApplied) {
      const checked = await validate();
      requireEvidence(checked.reconciliationFileHash === receipt.reconciliationFileHash && checked.journalEvidenceHash === receipt.journalEvidenceHash);
      if (transition.phase === "recovery-intent") {
        transition.phase = "receipt-verified"; await atomicWriteJson(transitionPath, transition);
        await hooks.afterPersist?.("receipt-verified");
      }
      requireEvidence(hashValue(await readJsonFile(mainPath, null)) === hashValue(original));
      const finalEvidence = await validate();
      requireEvidence(finalEvidence.reconciliationFileHash === receipt.reconciliationFileHash && finalEvidence.journalEvidenceHash === receipt.journalEvidenceHash);
      // One atomic replacement installs receipt + index + halt removal, never a partially unhalted state.
      await atomicWriteJson(mainPath, next); await hooks.afterPersist?.("main-applied");
    }
    transition.phase = "applied"; await atomicWriteJson(transitionPath, transition); await hooks.afterPersist?.("applied");
    return report(alreadyApplied ? "already-applied" : "applied");
  } finally { for (const lock of locks.reverse()) await lock.release(); }
}
