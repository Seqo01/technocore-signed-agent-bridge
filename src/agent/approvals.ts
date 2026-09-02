import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { BridgeError } from "../errors.js";
import { atomicWriteJson, readJsonFile } from "../fs-safe.js";
import { assertLocalAlias } from "../names.js";
import { didToPublicKeyBytes } from "../protocol.js";
import { hashValue } from "./util.js";
import { AgentRuntimeLock } from "./runtime-lock.js";

export interface SignedActionEffect {
  agentAlias: string;
  agentDid: string;
  type: "technocore.send-contact" | "technocore.send-public";
  destinationHash: string;
  payloadHash: string;
}

export interface ActionApproval extends SignedActionEffect {
  version: 1;
  actionId: string;
  actionHash: string;
  status: "requested" | "approved" | "executing" | "confirmed" | "ambiguous" | "failed";
}

export class ApprovalRequiredError extends BridgeError {
  constructor(readonly actionId: string, readonly actionHash: string) {
    super(`Exact operator approval required: action=${actionId}; hash=${actionHash}`);
    this.name = "ApprovalRequiredError";
  }
}

function normalizeEffect(value: SignedActionEffect): SignedActionEffect {
  assertLocalAlias(value.agentAlias);
  didToPublicKeyBytes(value.agentDid);
  if (!/^[a-f0-9]{64}$/u.test(value.destinationHash) || !/^[a-f0-9]{64}$/u.test(value.payloadHash) ||
    !["technocore.send-contact", "technocore.send-public"].includes(value.type)) {
    throw new BridgeError("Invalid outbound effect");
  }
  return { agentAlias: value.agentAlias, agentDid: value.agentDid, type: value.type,
    destinationHash: value.destinationHash, payloadHash: value.payloadHash };
}

/** Local operator authority, never exposed to workloads or peer message handlers.
 * Records contain hashes only. An executing record is spent, including after a crash.
 */
export class ActionApprovalStore {
  constructor(private readonly directory: string) {}

  private async locked<T>(path: string, operation: () => Promise<T>): Promise<T> {
    // Do not steal an action-consumption lock merely because its age exceeds a TTL.
    const lock = await AgentRuntimeLock.acquire(`${path}.approval-lock`);
    try { return await operation(); } finally { await lock.release(); }
  }

  private path(alias: string, id: string): string {
    assertLocalAlias(alias);
    if (!/^[a-f0-9-]{32,64}$/u.test(id)) throw new BridgeError("Invalid action id");
    return resolve(this.directory, alias, `${id}.json`);
  }

  async read(alias: string, id: string): Promise<ActionApproval> {
    const value = await readJsonFile<ActionApproval | null>(this.path(alias, id), null);
    if (!value || value.version !== 1 || value.agentAlias !== alias || value.actionId !== id ||
      !["requested", "approved", "executing", "confirmed", "ambiguous", "failed"].includes(value.status) ||
      value.actionHash !== hashValue({ actionId: id, ...normalizeEffect(value) })) {
      throw new BridgeError("Missing or invalid outbound approval record");
    }
    return value;
  }

  async propose(effect: SignedActionEffect, actionId: string = randomUUID()): Promise<ActionApproval> {
    const normalized = normalizeEffect(effect);
    const actionHash = hashValue({ actionId, ...normalized });
    const path = this.path(effect.agentAlias, actionId);
    return this.locked(path, async () => {
      if (await readJsonFile<unknown>(path, null) !== null) {
        const existing = await this.read(effect.agentAlias, actionId);
        if (existing.actionHash !== actionHash) throw new BridgeError("Action payload or destination changed; approval invalid");
        return existing;
      }
      const record: ActionApproval = { version: 1, ...normalized, actionId, actionHash, status: "requested" };
      await atomicWriteJson(path, record);
      return record;
    });
  }

  async grant(alias: string, id: string, expectedHash: string): Promise<ActionApproval> {
    return this.locked(this.path(alias, id), async () => {
      const record = await this.read(alias, id);
      if (record.actionHash !== expectedHash || record.status !== "requested") {
        throw new BridgeError("Approval hash mismatch or action already approved/spent");
      }
      record.status = "approved";
      await atomicWriteJson(this.path(alias, id), record);
      return record;
    });
  }

  async consume(effect: SignedActionEffect, id?: string): Promise<ActionApproval> {
    const requested = await this.propose(effect, id);
    return this.locked(this.path(effect.agentAlias, requested.actionId), async () => {
      const record = await this.read(effect.agentAlias, requested.actionId);
      if (record.status === "requested") throw new ApprovalRequiredError(record.actionId, record.actionHash);
      if (record.status !== "approved") throw new BridgeError("Outbound approval already spent; reconcile before follow-up");
      record.status = "executing";
      await atomicWriteJson(this.path(effect.agentAlias, record.actionId), record);
      return record;
    });
  }

  async finish(alias: string, id: string, status: "confirmed" | "ambiguous" | "failed"): Promise<void> {
    await this.locked(this.path(alias, id), async () => {
      const record = await this.read(alias, id);
      if (record.status !== "executing") throw new BridgeError("Outbound action is not executing");
      record.status = status;
      await atomicWriteJson(this.path(alias, id), record);
    });
  }
}
