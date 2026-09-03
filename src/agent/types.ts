import type { ExplicitTaskContext } from "./evidence.js";

export type AgentTaskStatus =
  | "pending"
  | "awaiting-approval"
  | "running"
  | "succeeded"
  | "failed"
  | "ambiguous"
  | "cancelled";

export type AgentRuntimeStatus =
  | "initialized"
  | "booting"
  | "recovering"
  | "idle"
  | "running"
  | "stopping"
  | "stopped"
  | "failed";

export interface AgentProfile {
  identityAlias: string;
  did: string;
  createdAt: string;
}

export interface AgentGoal {
  id: string;
  description: string;
  status: "active" | "completed" | "cancelled";
  createdAt: string;
  updatedAt: string;
}

export type ExternalEffectState = "none" | "possible" | "confirmed";

export interface AgentCheckpoint {
  phase: string;
  externalEffect: ExternalEffectState;
  updatedAt: string;
}

export interface SafeErrorRecord {
  name: string;
  code?: string;
  messageHash: string;
  outbound?: import("../send-diagnostics.js").OutboundDiagnostics;
}

export interface AgentTaskResult {
  hash: string;
  reference?: string;
  evidence?: {
    inferenceRequestId: string;
    inferenceRequestHash: string;
    inferenceResultHash: string;
    memoryWriteHashes: string[];
  };
}

export interface AgentTask {
  id: string;
  type: string;
  goalId?: string;
  idempotencyKey: string;
  status: AgentTaskStatus;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  payload: Record<string, unknown>;
  context?: ExplicitTaskContext;
  checkpoint: AgentCheckpoint;
  result?: AgentTaskResult;
  error?: SafeErrorRecord;
}

export interface AgentSession {
  id: string;
  startedAt: string;
  endedAt?: string;
  outcome: "running" | "clean" | "failed";
}

export interface AgentStateV1 {
  version: 1;
  revision: number;
  profile: AgentProfile;
  goals: Record<string, AgentGoal>;
  tasks: Record<string, AgentTask>;
  queue: string[];
  sessions: Record<string, AgentSession>;
  checkpoints: Record<string, AgentCheckpoint[]>;
  runtime: {
    status: AgentRuntimeStatus;
    updatedAt: string;
    activeSessionId?: string;
    activeTaskId?: string;
  };
}

export interface EnqueueTaskInput {
  id?: string;
  type: string;
  goalId?: string;
  idempotencyKey: string;
  payload?: Record<string, unknown>;
  context?: ExplicitTaskContext;
  maxAttempts?: number;
}

export interface SpendMetadata {
  asset: string;
  amount: string;
  network: string;
}

export interface InferenceMetadata {
  provider: string;
  model: string;
  providerSessionId?: string;
  providerResultId?: string;
  latencyMs?: number;
  usage?: Record<string, string>;
  spend?: SpendMetadata;
}

export interface InferenceRequest {
  requestId: string;
  taskId: string;
  taskType: string;
  input: unknown;
}

export type InferenceResult =
  | {
    outcome: "success";
    output: unknown;
    metadata: InferenceMetadata;
  }
  | {
    outcome: "failure";
    retrySafe: boolean;
    errorCode: string;
    metadata: InferenceMetadata;
  }
  | {
    outcome: "ambiguous";
    errorCode: string;
    metadata: InferenceMetadata;
  };

export interface InferenceProvider {
  readonly name: string;
  infer(request: InferenceRequest): Promise<InferenceResult>;
}

export interface MemoryPutRequest {
  idempotencyKey: string;
  scope: string;
  key: string;
  value: unknown;
  tags?: string[];
}

export interface MemoryRecord {
  id: string;
  idempotencyKey: string;
  scope: string;
  key: string;
  value: unknown;
  tags: string[];
  valueHash: string;
  createdAt: string;
}

export interface MemorySearchQuery {
  scope?: string;
  key?: string;
  tag?: string;
}

export interface MemoryProvider {
  put(request: MemoryPutRequest): Promise<MemoryRecord>;
  get(id: string): Promise<MemoryRecord | undefined>;
  search(query: MemorySearchQuery): Promise<MemoryRecord[]>;
}

export type JournalOutcome = "success" | "failure" | "ambiguous" | "info";

export interface JournalEntry {
  version: 1;
  id: string;
  timestamp: string;
  did: string;
  sessionId: string;
  taskId?: string;
  taskType?: string;
  event: string;
  outcome: JournalOutcome;
  inference?: InferenceMetadata;
  publicTechnocore?: {
    room: string;
    seq: number;
    did: string;
  };
  privateRoomHash?: string;
  inferenceRequestId?: string;
  inferenceRequestHash?: string;
  inferenceResultHash?: string;
  memoryWriteHashes?: string[];
  resultHash?: string;
  error?: SafeErrorRecord;
  actionHash?: string;
  delegationId?: string;
}

export interface RuntimeRunResult {
  kind: "idle" | "stopping" | "processed";
  task?: AgentTask;
}
