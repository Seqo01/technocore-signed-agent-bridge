import { resolve } from "node:path";
import { BridgeError } from "../errors.js";
import { atomicWriteJson, readJsonFile, withFileLock } from "../fs-safe.js";
import { didToPublicKeyBytes } from "../protocol.js";
import type { ContactStore } from "../contacts.js";
import type { AgentRuntime } from "../agent/runtime.js";
import { assertRoleWorkload } from "../agent/roles.js";
import { hashValue } from "../agent/util.js";
import type { AgentTask } from "../agent/types.js";
import { validateWorkRequest } from "./router.js";
import { assertNoSecretLikeOutput } from "../workloads/types.js";

export interface ExternalWorkRequest {
  version: 1; id: string; from: string; workload: string; payload: Record<string, unknown>;
}
export interface ExternalTaskProposal {
  version: 1; id: string; senderDid: string; inboundTaskId: string; requestHash: string;
  status: "proposed" | "approved" | "dispatched" | "rejected";
  reason?: string; request?: ExternalWorkRequest; workHash?: string; localTaskId?: string;
}

// Conservative refusal of known instruction attacks, not a claim of complete prompt-injection detection.
const UNSAFE_REQUEST = /ignore\s+(?:your\s+)?policy|(?:send|show|reveal)\s+(?:me\s+)?(?:your\s+)?private\s+key|run\s+(?:this\s+)?(?:powershell|shell|command)|forward\s+(?:your\s+)?mailbox|approve\s+(?:this\s+)?automatically|(?:modify|change|rotate)\s+(?:your\s+)?(?:identity|policy)/iu;

/** External DIDs are references only. This object never creates identities or grants outbound approvals. */
export class ExternalTaskRouter {
  constructor(private readonly runtime: AgentRuntime, private readonly localDids: readonly string[],
    private readonly contacts: ContactStore) {
    if (!runtime.role || !localDids.includes(runtime.did)) throw new BridgeError("External intake requires a bound local role");
    this.localDids = Object.freeze([...localDids]);
  }

  private path(id: string): string {
    if (!/^[a-f0-9]{64}$/u.test(id)) throw new BridgeError("Invalid external proposal id");
    return resolve(this.runtime.paths.directory, "external-proposals", `${id}.json`);
  }

  private assertExternal(did: string): void {
    didToPublicKeyBytes(did);
    if (this.localDids.includes(did)) throw new BridgeError("Local profile DID cannot be routed as an external peer");
  }

  async receiveInbox(): Promise<ExternalTaskProposal[]> {
    // Runtime persists and journals inbound data BEFORE advancing the local cursor.
    await this.runtime.ingestInbox();
    const inbound = Object.values((await this.runtime.state.load()).tasks).filter(task => task.type === "inbound.message");
    const proposals: ExternalTaskProposal[] = [];
    for (const task of inbound) proposals.push(await this.classify(task));
    return proposals;
  }

  /** Host-only adapter for unified intake; performs no read and no cursor acknowledgement. */
  async classify(task: AgentTask): Promise<ExternalTaskProposal> {
    const senderDid = String(task.payload.senderDid);
    let request: ExternalWorkRequest | undefined;
    let reason: string | undefined;
    let id = hashValue({ did: this.runtime.did, inboundTaskId: task.id });
    try {
      if (task.payload.serverVerifiedDid !== true || task.payload.trust !== "untrusted-external-data") {
        throw new BridgeError("Unverified transport identity");
      }
      this.assertExternal(senderDid);
      const text = task.payload.text;
      if (typeof text !== "string" || text.length > 4096) throw new BridgeError("Invalid external content");
      const parsed = JSON.parse(text) as ExternalWorkRequest;
      if (!parsed || parsed.version !== 1 || parsed.from !== senderDid ||
        typeof parsed.id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/u.test(parsed.id) ||
        Object.keys(parsed).some(key => !["version", "id", "from", "workload", "payload"].includes(key))) {
        throw new BridgeError("External request identity/schema mismatch");
      }
      id = hashValue({ localDid: this.runtime.did, senderDid, messageId: parsed.id });
      if (UNSAFE_REQUEST.test(text)) throw new BridgeError("Unsafe external work request");
      assertRoleWorkload(this.runtime.role!, parsed.workload);
      request = { version: 1, id: parsed.id, from: senderDid, workload: parsed.workload,
        payload: validateWorkRequest(parsed.workload, parsed.payload) };
    } catch {
      reason = "unverified-malformed-unsafe-or-unsupported-request";
    }
    const requestHash = hashValue({ senderDid, text: task.payload.text });
    const path = this.path(id);
    return withFileLock(path, async () => {
      const existing = await readJsonFile<ExternalTaskProposal | null>(path, null);
      if (existing) {
        if (existing.requestHash !== requestHash) return { version: 1, id: hashValue({ id, requestHash }),
          senderDid, inboundTaskId: task.id, requestHash, status: "rejected", reason: "message-id-replayed-with-different-content" };
        return existing;
      }
      const proposal: ExternalTaskProposal = { version: 1, id, senderDid, inboundTaskId: task.id, requestHash,
        status: reason ? "rejected" : "proposed", ...(reason ? { reason } : {}),
        ...(request ? { request, workHash: hashValue(request) } : {}) };
      await atomicWriteJson(path, proposal);
      return proposal;
    });
  }

  /** Operator approval for work only. Cannot authorize a signed send. */
  async approve(id: string, expectedHash: string): Promise<void> {
    await withFileLock(this.path(id), async () => {
      const proposal = await readJsonFile<ExternalTaskProposal | null>(this.path(id), null);
      if (!proposal || proposal.status !== "proposed" || proposal.requestHash !== expectedHash ||
        !proposal.request || proposal.workHash !== hashValue(proposal.request)) {
        throw new BridgeError("External work proposal cannot be approved");
      }
      proposal.status = "approved";
      await atomicWriteJson(this.path(id), proposal);
    });
  }

  async dispatch(id: string): Promise<AgentTask> {
    return withFileLock(this.path(id), async () => {
      const proposal = await readJsonFile<ExternalTaskProposal | null>(this.path(id), null);
      if (!proposal?.request || !["approved", "dispatched"].includes(proposal.status)) {
        throw new BridgeError("External work requires explicit operator approval");
      }
      this.assertExternal(proposal.senderDid);
      const request = proposal.request;
      if (request.from !== proposal.senderDid || proposal.workHash !== hashValue(request)) throw new BridgeError("External work binding changed");
      assertRoleWorkload(this.runtime.role!, request.workload);
      const task = await this.runtime.enqueueTask({ id: `external_${id}`, idempotencyKey: `external:${id}`,
        type: request.workload, payload: validateWorkRequest(request.workload, request.payload),
        context: { mode: "explicit-only", evidence: [] } });
      proposal.status = "dispatched";
      proposal.localTaskId = task.id;
      await atomicWriteJson(this.path(id), proposal);
      return task;
    });
  }

  async proposeResponse(id: string): Promise<AgentTask> {
    const proposal = await readJsonFile<ExternalTaskProposal | null>(this.path(id), null);
    if (!proposal?.localTaskId || proposal.status !== "dispatched") throw new BridgeError("External work is not dispatched");
    const evidence = await this.runtime.exportTaskEvidence(proposal.localTaskId);
    const contact = await this.contacts.findByDid(this.runtime.identityAlias, proposal.senderDid);
    if (!contact) throw new BridgeError("External peer needs an operator-managed contact before replying");
    return this.proposeOutbound(contact.contactId, proposal.senderDid, {
      version: 1, requestId: proposal.request!.id, resultHash: evidence.resultHash, output: evidence.output,
    }, `response:${id}`);
  }

  async proposeOutbound(contactId: string, expectedDid: string, content: unknown, key: string): Promise<AgentTask> {
    this.assertExternal(expectedDid);
    const contact = await this.contacts.get(this.runtime.identityAlias, contactId);
    if (contact.did !== expectedDid) throw new BridgeError("External destination DID mismatch");
    const text = JSON.stringify(content);
    if (text.length > 4096) throw new BridgeError("External message exceeds canonical message limit");
    assertNoSecretLikeOutput(text, "External response");
    return this.runtime.enqueueTask({ id: `outbound_${hashValue({ did: this.runtime.did, key })}`,
      idempotencyKey: `outbound:${hashValue(key)}`, type: "technocore.send-contact",
      payload: { contactId, text, expectedRecipientDid: expectedDid } });
  }
}
