import { BridgeError } from "../errors.js";
import { assertLocalAlias } from "../names.js";
import { didToPublicKeyBytes } from "../protocol.js";
import { assertNoSecretLikeOutput } from "../workloads/types.js";
import { hashValue } from "./util.js";
import { cleanInferenceBinding, type InferenceBinding } from "./inference-accounting.js";
import type { AgentStateStore } from "./state-store.js";
import type { ActivityJournal } from "./journal.js";
import type { MemoryProvider } from "./types.js";

export interface TaskEvidence {
  agentAlias: string;
  did: string;
  taskId: string;
  workload: string;
  resultHash: string;
  outputHash: string;
  inferenceRequestId: string;
  inferenceRequestHash: string;
  inferenceResultHash: string;
  memoryWriteHashes: string[];
  output: unknown;
  accounting?: InferenceBinding;
}

export interface ExplicitTaskContext { mode: "explicit-only"; evidence: TaskEvidence[] }

/** Shared read-only evidence validation. Does not unlock, recover tasks or run inference. */
export async function readCompletedTaskEvidence(stores: { state: AgentStateStore; memory: MemoryProvider; journal: ActivityJournal },
  alias: string, did: string, taskId: string) {
  const state = await stores.state.load();
  if (state.profile.did !== did || state.profile.identityAlias !== alias) throw new BridgeError("Profile binding changed");
  const task = state.tasks[taskId];
  if (!task || task.status !== "succeeded" || !task.type.startsWith("workload.") || !task.result?.reference) throw new BridgeError("Only a completed workload can export evidence");
  const record = await stores.memory.get(task.result.reference);
  const value = record?.value as { workload: unknown; output: unknown; actions: unknown; inferenceEvidence: {
    requestId: string; requestHash: string; resultHash: string; accounting?: InferenceBinding } } | undefined;
  const journal = (await stores.journal.read()).find(entry => entry.taskId === taskId && entry.resultHash === task.result!.hash);
  const memoryWriteHashes = task.result.evidence?.memoryWriteHashes ?? journal?.memoryWriteHashes;
  if (!value?.inferenceEvidence || !memoryWriteHashes || task.result.hash !== hashValue({
    workload: value.workload, output: value.output, actions: value.actions,
    inferenceRequestHash: value.inferenceEvidence.requestHash, inferenceResultHash: value.inferenceEvidence.resultHash, memoryWriteHashes,
    ...(value.inferenceEvidence.accounting ? { accounting: value.inferenceEvidence.accounting } : {}),
  })) throw new BridgeError("Incomplete or changed workload evidence");
  const evidence = validateEvidence({ mode: "explicit-only", evidence: [{
    agentAlias: alias, did, taskId, workload: task.type, resultHash: task.result.hash, outputHash: hashValue(value.output), output: value.output,
    inferenceRequestId: value.inferenceEvidence.requestId, inferenceRequestHash: value.inferenceEvidence.requestHash,
    inferenceResultHash: value.inferenceEvidence.resultHash, memoryWriteHashes,
    ...(value.inferenceEvidence.accounting ? { accounting: value.inferenceEvidence.accounting } : {}),
  }] }).evidence[0]!;
  return { evidence, task, journalMissing: !journal };
}

export function validateEvidence(context: ExplicitTaskContext): ExplicitTaskContext {
  if (context.mode !== "explicit-only" || !Array.isArray(context.evidence) || context.evidence.length > 16) {
    throw new BridgeError("Invalid explicit evidence context");
  }
  if (JSON.stringify(context).length > 131_072) throw new BridgeError("Evidence context exceeds local limit");
  for (const item of context.evidence) {
    assertLocalAlias(item.agentAlias);
    didToPublicKeyBytes(item.did);
    if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(item.taskId) || !item.workload.startsWith("workload.") ||
      !/^req_[a-f0-9]{32}$/u.test(item.inferenceRequestId) || !Array.isArray(item.memoryWriteHashes) ||
      item.memoryWriteHashes.length > 64 ||
      [item.resultHash, item.outputHash, item.inferenceRequestHash, item.inferenceResultHash,
        ...item.memoryWriteHashes].some(hash => !/^[a-f0-9]{64}$/u.test(hash)) ||
      item.outputHash !== hashValue(item.output)) throw new BridgeError("Invalid or changed evidence snapshot");
    assertNoSecretLikeOutput(JSON.stringify(item), "Evidence snapshot");
    if (item.accounting) {
      const binding = cleanInferenceBinding(item.accounting);
      if (hashValue(binding) !== hashValue(item.accounting) || binding.context.agentDid !== item.did ||
        binding.context.taskId !== item.taskId || binding.requestHash !== item.inferenceRequestHash) throw new BridgeError("Inference evidence binding mismatch");
    }
  }
  return structuredClone(context);
}
