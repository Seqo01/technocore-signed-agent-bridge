import { BridgeError } from "../errors.js";
import { assertLocalAlias } from "../names.js";
import { didToPublicKeyBytes } from "../protocol.js";
import { assertNoSecretLikeOutput } from "../workloads/types.js";
import { hashValue } from "./util.js";

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
}

export interface ExplicitTaskContext { mode: "explicit-only"; evidence: TaskEvidence[] }

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
  }
  return structuredClone(context);
}
