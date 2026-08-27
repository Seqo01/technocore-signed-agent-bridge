import { BridgeError } from "../errors.js";
import type {
  AgentTask,
  InferenceMetadata,
  MemoryRecord,
  MemorySearchQuery,
  SafeErrorRecord,
} from "../agent/types.js";

export interface WorkloadMemoryWrite {
  scope: string;
  key: string;
  value: unknown;
  tags?: string[];
}

export interface WorkloadAction {
  type: string;
  requiresApproval: true;
  payload: Record<string, unknown>;
}

export interface WorkloadInferencePlan {
  input: unknown;
}

export interface WorkloadContext<I = unknown> {
  task: AgentTask;
  input: I;
  memories: MemoryRecord[];
}

export interface WorkloadDefinition<I = unknown, O = unknown> {
  readonly id: string;
  readonly version: number;
  readonly taskType: string;
  validateInput(payload: Record<string, unknown>): I;
  memoryQueries(input: I): MemorySearchQuery[];
  createInferencePlan(context: WorkloadContext<I>): WorkloadInferencePlan;
  validateResult(value: unknown, input: I): O;
  memoryWrites(input: I, output: O, task: AgentTask): WorkloadMemoryWrite[];
  actions(input: I, output: O): WorkloadAction[];
  readonly evidenceEvent: string;
}

export interface WorkloadEvidence {
  inferenceRequestId: string;
  inferenceRequestHash: string;
  inferenceResultHash: string;
  finalResultHash: string;
  memoryWriteHashes: string[];
}

export type WorkloadExecutionResult =
  | {
    outcome: "success";
    output: unknown;
    actions: WorkloadAction[];
    metadata: InferenceMetadata;
    evidence: WorkloadEvidence;
    resultReference: string;
    journalEvent: string;
  }
  | {
    outcome: "failure";
    retrySafe: boolean;
    error: SafeErrorRecord;
    metadata?: InferenceMetadata;
    inferenceRequestId: string;
    inferenceRequestHash: string;
    inferenceResultHash?: string;
    journalEvent: string;
  }
  | {
    outcome: "ambiguous";
    error: SafeErrorRecord;
    metadata?: InferenceMetadata;
    inferenceRequestId: string;
    inferenceRequestHash: string;
    journalEvent: string;
  };

export function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BridgeError(`${label} must be a structured object`);
  }
  return value as Record<string, unknown>;
}

export function requiredText(
  record: Record<string, unknown>,
  key: string,
  maximum = 16_384,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    throw new BridgeError(`Workload field ${key} must contain 1-${maximum} characters`);
  }
  return value;
}

export function optionalText(
  record: Record<string, unknown>,
  key: string,
  maximum = 16_384,
): string | undefined {
  if (record[key] === undefined) return undefined;
  return requiredText(record, key, maximum);
}

export function stringList(value: unknown, label: string, maximumItems = 32): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new BridgeError(`${label} must be a bounded string list`);
  }
  return value.map((item) => {
    if (typeof item !== "string" || item.trim().length === 0 || item.length > 4096) {
      throw new BridgeError(`${label} contains an invalid item`);
    }
    return item;
  });
}

export function optionalStringList(
  value: unknown,
  label: string,
  maximumItems = 32,
): string[] | undefined {
  return value === undefined ? undefined : stringList(value, label, maximumItems);
}

export function assertNoSecretLikeOutput(value: string, label: string): void {
  if (
    /\b(?:mb-)?p-[a-z0-9_-]{8,}\b/iu.test(value) ||
    /-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----/u.test(value) ||
    /\b(?:ghp_|github_pat_|sk-)[A-Za-z0-9_-]{12,}\b/u.test(value) ||
    /\bBearer\s+[A-Za-z0-9._~-]{12,}\b/iu.test(value)
  ) {
    throw new BridgeError(`${label} contains forbidden secret-like material`);
  }
}
