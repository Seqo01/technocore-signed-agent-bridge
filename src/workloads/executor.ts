import { BridgeError } from "../errors.js";
import { safeErrorRecord } from "../agent/state-store.js";
import type {
  AgentTask,
  InferenceMetadata,
  InferenceProvider,
  MemoryProvider,
  MemoryRecord,
} from "../agent/types.js";
import { hashValue } from "../agent/util.js";
import { validateEvidence } from "../agent/evidence.js";
import type { WorkloadExecutionResult, WorkloadMemoryWrite } from "./types.js";
import { assertNoSecretLikeOutput } from "./types.js";
import type { WorkloadRegistry } from "./registry.js";

const MAX_CONTEXT_RECORDS = 64;

function inferenceError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function withLatency(
  metadata: InferenceMetadata,
  started: number,
  monotonicNow: () => number,
): InferenceMetadata {
  return {
    ...metadata,
    latencyMs: metadata.latencyMs ?? Math.max(0, Math.round(monotonicNow() - started)),
  };
}

function uniqueMemories(records: MemoryRecord[]): MemoryRecord[] {
  const byId = new Map<string, MemoryRecord>();
  for (const record of records) byId.set(record.id, record);
  return [...byId.values()]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    .slice(-MAX_CONTEXT_RECORDS);
}

export class WorkloadExecutor {
  constructor(
    private readonly registry: WorkloadRegistry,
    private readonly inference: InferenceProvider,
    private readonly memory: MemoryProvider,
    private readonly monotonicNow: () => number,
  ) {}

  async execute(
    task: AgentTask,
    hooks: { beforeInference?: () => Promise<void> } = {},
  ): Promise<WorkloadExecutionResult> {
    const workload = this.registry.require(task.type);
    const inferenceRequestId = `req_${hashValue({
      taskId: task.id,
      workloadId: workload.id,
      workloadVersion: workload.version,
      attempt: task.attempts,
    }).slice(0, 32)}`;
    let input: unknown;
    let memories: MemoryRecord[];
    let plan;
    try {
      input = workload.validateInput(structuredClone(task.payload));
      const context = task.context ? validateEvidence(task.context) : undefined;
      const memoryGroups = context ? [] : await Promise.all(
        workload.memoryQueries(input).map((query) => this.memory.search(query)),
      );
      memories = uniqueMemories(memoryGroups.flat());
      plan = workload.createInferencePlan({ task, input, memories });
      if (context) plan = { input: { ...plan.input as Record<string, unknown>, explicitEvidence: context.evidence } };
      assertNoSecretLikeOutput(JSON.stringify(plan.input), "Workload inference request");
    } catch (error) {
      return {
        outcome: "failure",
        retrySafe: false,
        error: safeErrorRecord(error),
        inferenceRequestId,
        inferenceRequestHash: hashValue({ taskId: task.id, invalidInput: true }),
        journalEvent: `${workload.id}-validation-failed`,
      };
    }

    const request = {
      requestId: inferenceRequestId,
      taskId: task.id,
      taskType: task.type,
      input: {
        workload: { id: workload.id, version: workload.version },
        plan: structuredClone(plan.input),
      },
    };
    const inferenceRequestHash = hashValue(request);
    await hooks.beforeInference?.();
    const started = this.monotonicNow();
    let result;
    try {
      result = await this.inference.infer(request);
    } catch (error) {
      return {
        outcome: "ambiguous",
        error: safeErrorRecord(error),
        inferenceRequestId,
        inferenceRequestHash,
        journalEvent: `${workload.id}-inference-ambiguous`,
      };
    }
    const metadata = withLatency(result.metadata, started, this.monotonicNow);
    if (result.outcome === "ambiguous") {
      return {
        outcome: "ambiguous",
        error: safeErrorRecord(inferenceError(result.errorCode, "Ambiguous workload inference outcome")),
        metadata,
        inferenceRequestId,
        inferenceRequestHash,
        journalEvent: `${workload.id}-inference-ambiguous`,
      };
    }
    if (result.outcome === "failure") {
      return {
        outcome: "failure",
        retrySafe: result.retrySafe,
        error: safeErrorRecord(inferenceError(result.errorCode, "Workload inference provider reported failure")),
        metadata,
        inferenceRequestId,
        inferenceRequestHash,
        journalEvent: `${workload.id}-inference-failed`,
      };
    }

    const inferenceResultHash = hashValue(result.output);
    let output: unknown;
    let actions;
    let writes: WorkloadMemoryWrite[];
    try {
      output = workload.validateResult(structuredClone(result.output), input);
      actions = workload.actions(input, output);
      if (actions.some((action) => action.requiresApproval !== true)) {
        throw new BridgeError("Workload action omitted mandatory operator approval");
      }
      assertNoSecretLikeOutput(JSON.stringify({ output, actions }), "Workload result");
      writes = workload.memoryWrites(input, output, task);
    } catch (error) {
      return {
        outcome: "failure",
        retrySafe: false,
        error: safeErrorRecord(error),
        metadata,
        inferenceRequestId,
        inferenceRequestHash,
        inferenceResultHash,
        journalEvent: `${workload.id}-result-invalid`,
      };
    }

    const primary = await this.memory.put({
      idempotencyKey: `${task.idempotencyKey}:workload-result`,
      scope: "workload-result",
      key: task.id,
      value: {
        workload: { id: workload.id, version: workload.version },
        inferenceEvidence: {
          requestId: inferenceRequestId,
          requestHash: inferenceRequestHash,
          resultHash: inferenceResultHash,
        },
        output,
        actions,
      },
      tags: [`workload:${workload.id}`, "workload-result"],
    });
    const records = [primary];
    for (const [index, write] of writes.entries()) {
      records.push(await this.memory.put({
        idempotencyKey: `${task.idempotencyKey}:workload-memory:${index}`,
        scope: write.scope,
        key: write.key,
        value: structuredClone(write.value),
        ...(write.tags ? { tags: [...write.tags] } : {}),
      }));
    }
    const memoryWriteHashes = records.map((record) => record.valueHash);
    const finalResultHash = hashValue({
      workload: { id: workload.id, version: workload.version },
      output,
      actions,
      inferenceRequestHash,
      inferenceResultHash,
      memoryWriteHashes,
    });
    return {
      outcome: "success",
      output,
      actions,
      metadata,
      evidence: {
        inferenceRequestId,
        inferenceRequestHash,
        inferenceResultHash,
        finalResultHash,
        memoryWriteHashes,
      },
      resultReference: primary.id,
      journalEvent: workload.evidenceEvent,
    };
  }
}
