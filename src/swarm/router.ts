import { resolve } from "node:path";
import { BridgeError } from "../errors.js";
import { atomicWriteJson, readJsonFile, withFileLock } from "../fs-safe.js";
import { assertLocalAlias } from "../names.js";
import { assertRoleWorkload } from "../agent/roles.js";
import { validateEvidence, type ExplicitTaskContext, type TaskEvidence } from "../agent/evidence.js";
import type { AgentRuntime } from "../agent/runtime.js";
import { hashValue } from "../agent/util.js";
import { createDefaultWorkloadRegistry } from "../workloads/registry.js";
import { assertNoSecretLikeOutput } from "../workloads/types.js";

export interface LocalAgentBinding { alias: string; expectedDid: string }
export interface LocalAgentEndpoint { binding: LocalAgentBinding; runtime: AgentRuntime }

const WORK_FIELDS: Record<string, readonly string[]> = {
  "workload.research": ["topic", "objective", "context", "sources", "outputRequirements"],
  "workload.engineering": ["problemStatement", "project", "observedBehavior", "constraints", "codeContext", "requestedOutcome"],
  "workload.review": ["question", "producedResult", "expectedOutputHash", "criteria"],
  "workload.specialist": ["question", "focus", "suppliedContext"],
  "workload.coordination": ["question", "phase", "requiredEvidenceHashes"],
  "workload.synthesis": ["question", "phase", "requiredEvidenceHashes"],
};

export function validateWorkRequest(type: string, payload: Record<string, unknown>): Record<string, unknown> {
  const fields = WORK_FIELDS[type];
  if (!fields || !payload || Array.isArray(payload) || Object.keys(payload).some(key => !fields.includes(key))) {
    throw new BridgeError("Unsupported work type or task fields");
  }
  if (JSON.stringify(payload).length > 32_768) throw new BridgeError("Work request exceeds local limit");
  assertNoSecretLikeOutput(JSON.stringify(payload), "Work request");
  return createDefaultWorkloadRegistry().require(type).validateInput(structuredClone(payload)) as Record<string, unknown>;
}

export interface DelegationRequest {
  source: LocalAgentBinding;
  target: LocalAgentBinding;
  parentTaskId: string;
  key: string;
  workload: string;
  payload: Record<string, unknown>;
  evidence?: TaskEvidence[];
}

export interface DelegationRecord {
  version: 1;
  id: string;
  source: LocalAgentBinding;
  target: LocalAgentBinding;
  parentTaskId: string;
  taskId: string;
  workload: string;
  payload: Record<string, unknown>;
  context: ExplicitTaskContext;
  requestHash: string;
  status: "planned" | "dispatched" | "succeeded" | "failed" | "ambiguous";
  resultHash?: string;
  reviewerOutcome?: "VOUCH" | "REJECT" | "REVISION_REQUIRED";
}

/** Trusted local orchestrator. Calls explicit endpoint APIs; never opens another agent's memory files. */
export class LocalSwarmRouter {
  private readonly endpoints = new Map<string, LocalAgentEndpoint>();

  constructor(endpoints: LocalAgentEndpoint[], private readonly authorize?: (request: DelegationRequest) => Promise<void>) {
    const dids = new Set<string>();
    for (const endpoint of endpoints) {
      assertLocalAlias(endpoint.binding.alias);
      if (this.endpoints.has(endpoint.binding.alias) || dids.has(endpoint.binding.expectedDid)) {
        throw new BridgeError("Local swarm bindings must be unique");
      }
      this.endpoints.set(endpoint.binding.alias, { binding: { ...endpoint.binding }, runtime: endpoint.runtime });
      dids.add(endpoint.binding.expectedDid);
      this.require(endpoint.binding);
    }
  }

  localDids(): string[] { return [...this.endpoints.values()].map(endpoint => endpoint.binding.expectedDid); }

  private require(binding: LocalAgentBinding): AgentRuntime {
    const endpoint = this.endpoints.get(binding.alias);
    if (!endpoint || endpoint.binding.expectedDid !== binding.expectedDid ||
      endpoint.runtime.identityAlias !== binding.alias || endpoint.runtime.did !== binding.expectedDid || !endpoint.runtime.role) {
      throw new BridgeError("Local alias/DID/role binding mismatch");
    }
    return endpoint.runtime;
  }

  private path(source: AgentRuntime, id: string): string {
    if (!/^[a-f0-9]{64}$/u.test(id)) throw new BridgeError("Invalid delegation id");
    return resolve(source.paths.directory, "delegations", `${id}.json`);
  }

  async delegate(input: DelegationRequest): Promise<DelegationRecord> {
    input = structuredClone(input);
    const source = this.require(input.source);
    const target = this.require(input.target);
    if (source.did === target.did) throw new BridgeError("Delegation requires a distinct peer");
    if (this.authorize) await this.authorize(input);
    else if (source.role !== "coordinator") throw new BridgeError("Only a coordinator delegates to a distinct peer");
    if (!(await source.state.load()).tasks[input.parentTaskId]) throw new BridgeError("Delegation requires an existing source parent task");
    if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(input.key)) throw new BridgeError("Invalid delegation key");
    assertRoleWorkload(target.role!, input.workload);
    const payload = validateWorkRequest(input.workload, input.payload);
    const context = validateEvidence({ mode: "explicit-only", evidence: input.evidence ?? [] });
    for (const item of context.evidence) this.require({ alias: item.agentAlias, expectedDid: item.did });
    const id = hashValue({ source: input.source, parentTaskId: input.parentTaskId, key: input.key });
    const requestHash = hashValue({ source: input.source, target: input.target, parentTaskId: input.parentTaskId,
      workload: input.workload, payload, context });
    const path = this.path(source, id);
    await withFileLock(path, async () => {
      const existing = await readJsonFile<DelegationRecord | null>(path, null);
      if (existing) {
        if (existing.requestHash !== requestHash) throw new BridgeError("Delegation id reused with changed work or destination");
        return;
      }
      const record: DelegationRecord = { version: 1, id, source: input.source, target: input.target,
        parentTaskId: input.parentTaskId, taskId: `delegated_${id}`, workload: input.workload, payload,
        context, requestHash, status: "planned" };
      await atomicWriteJson(path, record);
    });
    return this.reconcile(input.source, id);
  }

  async reconcile(sourceBinding: LocalAgentBinding, id: string): Promise<DelegationRecord> {
    const source = this.require(sourceBinding);
    const path = this.path(source, id);
    return withFileLock(path, async () => {
      const record = await readJsonFile<DelegationRecord | null>(path, null);
      if (!record || record.version !== 1 || record.id !== id || hashValue(record.source) !== hashValue(sourceBinding) ||
        record.requestHash !== hashValue({ source: record.source, target: record.target, parentTaskId: record.parentTaskId,
          workload: record.workload, payload: record.payload, context: record.context })) {
        throw new BridgeError("Invalid durable delegation record");
      }
      const target = this.require(record.target);
      if (this.authorize) await this.authorize({ source: record.source, target: record.target,
        parentTaskId: record.parentTaskId, key: id, workload: record.workload, payload: record.payload, evidence: record.context.evidence });
      assertRoleWorkload(target.role!, record.workload);
      // Enqueue is itself idempotent, including a crash between dispatch and this checkpoint.
      const task = await target.enqueueTask({ id: record.taskId, idempotencyKey: `delegation:${id}`,
        type: record.workload, payload: validateWorkRequest(record.workload, record.payload),
        context: validateEvidence(record.context) });
      record.status = task.status === "succeeded" ? "succeeded" : task.status === "ambiguous" ? "ambiguous" :
        task.status === "failed" || task.status === "cancelled" ? "failed" : "dispatched";
      if (task.status === "succeeded") {
        const evidence = await target.exportTaskEvidence(task.id);
        record.resultHash = evidence.resultHash;
        if (record.workload === "workload.review") {
          record.reviewerOutcome = (evidence.output as { outcome: DelegationRecord["reviewerOutcome"] }).outcome!;
        }
      }
      await atomicWriteJson(path, record);
      await source.journal.append({ version: 1, id: `evt_${hashValue({ id, status: record.status })}`,
        timestamp: new Date().toISOString(), did: source.did, sessionId: source.sessionId,
        taskId: record.parentTaskId, taskType: record.workload, delegationId: id,
        event: `delegation-${record.status}`, outcome: record.status === "ambiguous" ? "ambiguous" :
          record.status === "failed" ? "failure" : "info", ...(record.resultHash ? { resultHash: record.resultHash } : {}) });
      return structuredClone(record);
    });
  }

  async collect(source: LocalAgentBinding, id: string): Promise<TaskEvidence> {
    const record = await this.reconcile(source, id);
    if (record.status !== "succeeded") throw new BridgeError("Delegated work is not complete; no implicit retry");
    return this.require(record.target).exportTaskEvidence(record.taskId);
  }
}
