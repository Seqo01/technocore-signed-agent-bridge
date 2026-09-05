import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { SignedAgentBridge } from "../bridge.js";
import { createStores } from "../context.js";
import { AmbiguousSendError, BridgeError } from "../errors.js";
import { atomicCreateJson, atomicWriteJson, pathExists, readJsonFile, withFileLock } from "../fs-safe.js";
import { didToPublicKeyBytes, sanitizeText, verifySignedMessage } from "../protocol.js";
import { outboundDiagnostics, SignedPostRejectedError, type OutboundDiagnostics } from "../send-diagnostics.js";
import { HttpTechnocoreTransport } from "../transport.js";
import type { InboxMessage, RoomResponse, TechnocoreTransport } from "../types.js";
import type { PassphraseProvider } from "../passphrase.js";
import { ActionApprovalStore, type ExactActionEffect } from "../agent/approvals.js";
import { readCompletedTaskEvidence } from "../agent/evidence.js";
import { ActivityJournal } from "../agent/journal.js";
import { LocalMemoryProvider } from "../agent/memory.js";
import { agentPaths } from "../agent/paths.js";
import { AgentRoleStore } from "../agent/roles.js";
import { AgentRuntime } from "../agent/runtime.js";
import { AgentStateStore } from "../agent/state-store.js";
import type { InferenceProvider } from "../agent/types.js";
import { hashValue, systemClock, type AgentClock } from "../agent/util.js";
import { assertLocalAlias } from "../names.js";
import { createDefaultWorkloadRegistry } from "../workloads/registry.js";
import type { ReviewOutput } from "../workloads/review.js";
import { assertNoSecretLikeOutput, stringList } from "../workloads/types.js";
import { peerAliases, schemaId } from "./session-policy.js";
import { safePeerText } from "./proposal.js";

export const OUTBOUND_EXTERNAL_WORK_STATES = [
  "PREPARED", "AUTHORIZED", "SENDING", "SENT", "AWAITING_RESPONSE", "RESPONSE_RECEIVED",
  "REVIEW_PENDING", "SUCCESS", "REJECTED_RESULT", "REVISION_REQUIRED", "NO_RESPONSE",
  "INVALID_RESPONSE", "DELIVERY_REJECTED", "AMBIGUOUS_DELIVERY",
] as const;
export type OutboundExternalWorkState = typeof OUTBOUND_EXTERNAL_WORK_STATES[number];

export interface ExternalWorkRequestEnvelope {
  version: 1;
  kind: "external-work-request";
  requestId: string;
  requesterDid: string;
  targetDid: string;
  workloadType: string;
  workloadVersion: 1;
  objective: string;
  input: Record<string, unknown>;
  inputHash: string;
  expectedOutputSchema: string;
  requestPayloadHash: string;
  responseDeadline: string;
  createdAt: string;
}

export interface ExternalWorkResultEnvelope {
  version: 1;
  kind: "external-work-result";
  requestId: string;
  requesterDid: string;
  responderDid: string;
  workloadType: string;
  workloadVersion: 1;
  requestPayloadHash: string;
  status: "completed" | "failed" | "declined";
  output: unknown;
  resultHash: string;
  createdAt: string;
}

export interface PrepareOutboundExternalWork {
  requestId: string;
  requesterAlias: string;
  targetDid: string;
  contactId: string;
  objective: string;
  workloadType: string;
  workloadVersion: 1;
  input: Record<string, unknown>;
  responseDeadline: string;
  responseRouteEvidenceHash: string;
  schemaAgreementHash: string;
  reviewCriteria: string[];
}

/** Public, non-secret pilot task material. It performs no read, send, inference or persistence. */
export function technocoreContractExtractionTemplate(excerpts: string[]): Pick<PrepareOutboundExternalWork,
  "objective" | "workloadType" | "workloadVersion" | "input" | "reviewCriteria"> {
  const supplied = stringList(excerpts, "Technocore source excerpts", 8);
  if (!supplied.length) throw new BridgeError("At least one operator-supplied excerpt is required");
  const context = supplied.map((excerpt, index) => `[excerpt-${index + 1}] ${excerpt}`).join("\n");
  const input = { topic: "Technocore signed POST and room-read contract", objective:
    "Using only the supplied excerpts, extract exactly three protocol invariants and exactly three uncertainties or limitations.",
    context, sources: supplied.map((_excerpt, index) => ({ id: `excerpt-${index + 1}`, title: "Operator-supplied public excerpt" })),
    outputRequirements: ["Exactly three keyClaims", "Exactly three limitations", "No live web or tool use", "Cite excerpt identifiers in the answer"] };
  assertNoSecretLikeOutput(JSON.stringify(input), "Technocore contract extraction template");
  return { objective: "Extract three Technocore protocol invariants and three uncertainties from supplied public excerpts",
    workloadType: "workload.research", workloadVersion: 1, input,
    reviewCriteria: ["Exactly three protocol invariants are present", "Exactly three uncertainties or limitations are present",
      "Every claim is traceable to the supplied excerpts", "No live verification or unsupported source access is claimed"] };
}

interface ResponseLink {
  checkpointRef: string;
  checkpointHash: string;
  seq: number;
  senderDid: string;
  messageHash: string;
  signatureHash?: string;
  locallyVerified: boolean;
  resultHash?: string;
  responseStatus?: ExternalWorkResultEnvelope["status"];
  failureCode?: string;
  receivedAt: string;
  acknowledged?: boolean;
}

interface ReviewLink {
  taskId: string;
  resultHash?: string;
  evidenceHash?: string;
  outcome?: ReviewOutput["outcome"];
}

interface IntakePolicy {
  since: number;
  maxReads: 1;
  readAttempts: number;
  wait: 0;
  limit: 200;
  checkpointRef?: string;
  checkpointHash?: string;
  readStartedAt?: string;
  readFailure?: "transport-failed" | "persistence-failed";
}

export interface OutboundExternalWorkJob {
  version: 1;
  outboundJobId: string;
  requestId: string;
  requesterAlias: string;
  requesterDid: string;
  reviewerAlias: "dave";
  reviewerDid: string;
  targetDid: string;
  contactId: string;
  destinationHash: string;
  responseRouteHash: string;
  responseRouteEvidenceHash: string;
  schemaAgreementHash: string;
  objective: string;
  workloadType: string;
  workloadVersion: 1;
  input: Record<string, unknown>;
  inputHash: string;
  expectedOutputSchema: string;
  requestPayloadHash: string;
  transportPayloadHash: string;
  requestEnvelope: ExternalWorkRequestEnvelope;
  requestText: string;
  actionId: string;
  actionHash: string;
  authorityId: string;
  preparedAt: string;
  responseDeadline: string;
  reviewCriteria: string[];
  state: OutboundExternalWorkState;
  postAttempts: number;
  sentSeq?: number;
  deliveryDiagnostics?: OutboundDiagnostics;
  intake: IntakePolicy;
  response?: ResponseLink;
  review?: ReviewLink;
}

interface ResponseCheckpoint {
  version: 1;
  outboundJobId: string;
  roomHash: string;
  previousCursor: number;
  firstSeq: number | null;
  lastSeq: number;
  messages: InboxMessage[];
  observedAt: string;
}

export interface OutboundExternalWorkSummary {
  outboundJobId: string;
  requestId: string;
  requesterAlias: string;
  requesterDid: string;
  reviewerAlias: "dave";
  reviewerDid: string;
  targetDid: string;
  contactId: string;
  destinationHash: string;
  responseRouteHash: string;
  workloadType: string;
  workloadVersion: 1;
  inputHash: string;
  expectedOutputSchema: string;
  requestPayloadHash: string;
  actionId: string;
  actionHash: string;
  authorityId: string;
  preparedAt: string;
  responseDeadline: string;
  state: OutboundExternalWorkState;
  postAttempts: number;
  sentSeq?: number;
  readAttempts: number;
  response?: Omit<ResponseLink, "checkpointRef">;
  review?: ReviewLink;
  deliveryDiagnostics?: OutboundDiagnostics;
}

export interface OutboundExternalWorkOptions {
  root: string;
  passphrases?: PassphraseProvider;
  origin?: string;
  /** Test seam only. Production calls construct a zero-retry HTTP transport. */
  offlineTransport?: TechnocoreTransport;
  /** Host-supplied provider used only for Dave's workload.review. */
  reviewInference?: InferenceProvider;
  clock?: AgentClock;
  /** Test seam for proving persist-before-ACK ordering. */
  beforeAcknowledge?: (job: Readonly<OutboundExternalWorkJob>, seq: number) => Promise<void>;
}

class GuardedApprovals extends ActionApprovalStore {
  constructor(directory: string, private readonly guard: (effect: ExactActionEffect, id?: string) => Promise<void>) {
    super(directory);
  }
  override async consume(effect: ExactActionEffect, id?: string) {
    await this.guard(effect, id);
    return super.consume(effect, id);
  }
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function assertRequestId(value: string): void {
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(value)) throw new BridgeError("Invalid external work request id");
}

function requestBinding(envelope: Omit<ExternalWorkRequestEnvelope, "requestPayloadHash">): string {
  return hashValue(envelope);
}

function effectFor(job: Pick<OutboundExternalWorkJob, "requesterAlias" | "requesterDid" | "destinationHash" | "transportPayloadHash">): ExactActionEffect {
  return { agentAlias: job.requesterAlias, agentDid: job.requesterDid, type: "technocore.send-contact",
    destinationHash: job.destinationHash, payloadHash: job.transportPayloadHash };
}

const terminal = new Set<OutboundExternalWorkState>([
  "SUCCESS", "REJECTED_RESULT", "REVISION_REQUIRED", "NO_RESPONSE", "INVALID_RESPONSE",
  "DELIVERY_REJECTED", "AMBIGUOUS_DELIVERY",
]);

/** Durable one-shot local->external work lifecycle. Discovery is deliberately absent. */
export class OutboundExternalWorkCoordinator {
  private readonly stores;
  private readonly clock: AgentClock;
  readonly directory: string;
  constructor(private readonly options: OutboundExternalWorkOptions) {
    this.stores = createStores(options.root, options.passphrases);
    this.clock = options.clock ?? systemClock;
    this.directory = resolve(this.stores.paths.root, "external-work");
  }

  private jobPath(id: string): string {
    if (!isHash(id)) throw new BridgeError("Invalid outbound external job id");
    return resolve(this.directory, "jobs", `${id}.json`);
  }
  private checkpointPath(id: string): string { return resolve(this.directory, "intake", `${id}-read-1.json`); }
  private approvals(): ActionApprovalStore { return new ActionApprovalStore(resolve(this.directory, "approvals")); }
  private now(): string { return this.clock().toISOString(); }

  private summary(job: OutboundExternalWorkJob): OutboundExternalWorkSummary {
    return { outboundJobId: job.outboundJobId, requestId: job.requestId, requesterAlias: job.requesterAlias,
      requesterDid: job.requesterDid, reviewerAlias: job.reviewerAlias, reviewerDid: job.reviewerDid,
      targetDid: job.targetDid, contactId: job.contactId, destinationHash: job.destinationHash,
      responseRouteHash: job.responseRouteHash, workloadType: job.workloadType, workloadVersion: job.workloadVersion,
      inputHash: job.inputHash, expectedOutputSchema: job.expectedOutputSchema, requestPayloadHash: job.requestPayloadHash,
      actionId: job.actionId, actionHash: job.actionHash, authorityId: job.authorityId,
      preparedAt: job.preparedAt, responseDeadline: job.responseDeadline,
      state: job.state === "SENDING" ? "AMBIGUOUS_DELIVERY" : job.state, postAttempts: job.postAttempts,
      ...(job.sentSeq === undefined ? {} : { sentSeq: job.sentSeq }), readAttempts: job.intake.readAttempts,
      ...(job.response ? { response: (({ checkpointRef: _checkpointRef, ...safe }) => safe)(job.response) } : {}),
      ...(job.review ? { review: structuredClone(job.review) } : {}),
      ...(job.deliveryDiagnostics ? { deliveryDiagnostics: structuredClone(job.deliveryDiagnostics) } : {}) };
  }

  private validateStored(job: OutboundExternalWorkJob): void {
    if (!job || job.version !== 1 || !isHash(job.outboundJobId) || !OUTBOUND_EXTERNAL_WORK_STATES.includes(job.state) ||
      job.workloadVersion !== 1 || job.reviewerAlias !== "dave" || !isHash(job.destinationHash) ||
      !isHash(job.responseRouteHash) || !isHash(job.responseRouteEvidenceHash) || !isHash(job.schemaAgreementHash) ||
      !isHash(job.inputHash) || !isHash(job.requestPayloadHash) || !isHash(job.transportPayloadHash) ||
      !isHash(job.actionId) || !isHash(job.actionHash) || !isHash(job.authorityId) ||
      !Number.isSafeInteger(job.postAttempts) || job.postAttempts < 0 || job.postAttempts > 1 ||
      job.intake.maxReads !== 1 || job.intake.wait !== 0 || job.intake.limit !== 200 ||
      !Number.isSafeInteger(job.intake.readAttempts) || job.intake.readAttempts < 0 || job.intake.readAttempts > 1 ||
      !Number.isSafeInteger(job.intake.since) || job.intake.since < 0) throw new BridgeError("Invalid outbound external work record");
    assertRequestId(job.requestId); assertLocalAlias(job.requesterAlias); didToPublicKeyBytes(job.requesterDid);
    didToPublicKeyBytes(job.reviewerDid); didToPublicKeyBytes(job.targetDid);
    if (!Number.isFinite(Date.parse(job.preparedAt)) || !Number.isFinite(Date.parse(job.responseDeadline)) ||
      Date.parse(job.responseDeadline) <= Date.parse(job.preparedAt) || job.inputHash !== hashValue(job.input)) {
      throw new BridgeError("Invalid outbound external work timing or input binding");
    }
    const { requestPayloadHash: _requestPayloadHash, ...base } = job.requestEnvelope;
    const expectedJobId = hashValue({ requesterDid: job.requesterDid, requestId: job.requestId });
    const expectedAuthorityId = hashValue({ kind: "outbound-external-work/v1", outboundJobId: job.outboundJobId,
      requesterDid: job.requesterDid, targetDid: job.targetDid, destinationHash: job.destinationHash,
      responseRouteHash: job.responseRouteHash, responseRouteEvidenceHash: job.responseRouteEvidenceHash,
      schemaAgreementHash: job.schemaAgreementHash, requestPayloadHash: job.requestPayloadHash,
      reviewerDid: job.reviewerDid, reviewCriteriaHash: hashValue(job.reviewCriteria) });
    const expectedActionId = hashValue({ outboundJobId: job.outboundJobId, authorityId: job.authorityId,
      requestId: job.requestId, effect: "external-work-request" });
    if (job.requestEnvelope.version !== 1 || job.requestEnvelope.kind !== "external-work-request" ||
      job.requestEnvelope.requestId !== job.requestId || job.requestEnvelope.requesterDid !== job.requesterDid ||
      job.requestEnvelope.targetDid !== job.targetDid || job.requestEnvelope.workloadType !== job.workloadType ||
      job.requestEnvelope.workloadVersion !== 1 || job.requestEnvelope.objective !== job.objective ||
      hashValue(job.requestEnvelope.input) !== job.inputHash || job.requestEnvelope.inputHash !== job.inputHash ||
      job.requestEnvelope.expectedOutputSchema !== job.expectedOutputSchema ||
      job.requestEnvelope.responseDeadline !== job.responseDeadline || job.requestEnvelope.createdAt !== job.preparedAt ||
      requestBinding(base) !== job.requestPayloadHash || job.requestEnvelope.requestPayloadHash !== job.requestPayloadHash ||
      safePeerText(job.requestEnvelope, 4096) !== job.requestText || hashValue(job.requestText) !== job.transportPayloadHash ||
      job.outboundJobId !== expectedJobId || job.authorityId !== expectedAuthorityId || job.actionId !== expectedActionId ||
      job.actionHash !== hashValue({ actionId: job.actionId, ...effectFor(job) })) {
      throw new BridgeError("Outbound external request/action binding changed");
    }
    stringList(job.reviewCriteria, "External review criteria", 16);
    if (job.response && (!isHash(job.response.checkpointHash) || !Number.isSafeInteger(job.response.seq) || job.response.seq < 1 ||
      !isHash(job.response.messageHash) || typeof job.response.senderDid !== "string" ||
      job.response.signatureHash !== undefined && !isHash(job.response.signatureHash) ||
      job.response.resultHash !== undefined && !isHash(job.response.resultHash))) throw new BridgeError("Invalid external response linkage");
    if (job.review && (!/^[A-Za-z0-9._:-]{1,128}$/u.test(job.review.taskId) ||
      job.review.resultHash !== undefined && !isHash(job.review.resultHash) ||
      job.review.evidenceHash !== undefined && !isHash(job.review.evidenceHash) ||
      job.review.outcome !== undefined && !["VOUCH", "REJECT", "REVISION_REQUIRED"].includes(job.review.outcome))) {
      throw new BridgeError("Invalid external review linkage");
    }
    if (["PREPARED", "AUTHORIZED"].includes(job.state) && job.postAttempts !== 0 ||
      ["SENDING", "SENT", "AWAITING_RESPONSE", "RESPONSE_RECEIVED", "REVIEW_PENDING", "SUCCESS",
        "REJECTED_RESULT", "REVISION_REQUIRED", "NO_RESPONSE", "INVALID_RESPONSE", "DELIVERY_REJECTED",
        "AMBIGUOUS_DELIVERY"].includes(job.state) && job.postAttempts !== 1 ||
      ["SENT", "AWAITING_RESPONSE", "RESPONSE_RECEIVED", "REVIEW_PENDING", "SUCCESS", "REJECTED_RESULT",
        "REVISION_REQUIRED", "NO_RESPONSE", "INVALID_RESPONSE"].includes(job.state) && job.sentSeq === undefined ||
      ["RESPONSE_RECEIVED", "REVIEW_PENDING", "SUCCESS", "REJECTED_RESULT", "REVISION_REQUIRED"].includes(job.state) &&
        (!job.response?.locallyVerified || !job.response.resultHash || !job.response.signatureHash) ||
      job.state === "INVALID_RESPONSE" && (!job.response || job.response.locallyVerified) ||
      ["SUCCESS", "REJECTED_RESULT", "REVISION_REQUIRED"].includes(job.state) && !job.review?.outcome ||
      job.state === "SUCCESS" && job.review?.outcome !== "VOUCH" ||
      job.state === "REJECTED_RESULT" && job.review?.outcome !== "REJECT" ||
      job.state === "REVISION_REQUIRED" && job.review?.outcome !== "REVISION_REQUIRED") {
      throw new BridgeError("Invalid outbound external work lifecycle linkage");
    }
    assertNoSecretLikeOutput(JSON.stringify({ objective: job.objective, input: job.input, reviewCriteria: job.reviewCriteria }), "External work request");
  }

  private async record(id: string): Promise<OutboundExternalWorkJob> {
    const job = await readJsonFile<OutboundExternalWorkJob | null>(this.jobPath(id), null);
    if (!job || job.outboundJobId !== id) throw new BridgeError("Missing outbound external work job");
    this.validateStored(job); return job;
  }

  private async assertTargetExternal(targetDid: string): Promise<void> {
    for (const alias of peerAliases) {
      const path = resolve(this.stores.paths.identities, `${alias}.json`);
      if (await pathExists(path) && (await this.stores.identities.inspect(alias)).did === targetDid) {
        throw new BridgeError("Outbound external target is a local swarm DID");
      }
    }
  }

  private async validateCurrent(job: OutboundExternalWorkJob): Promise<void> {
    this.validateStored(job);
    const identity = await this.stores.identities.inspect(job.requesterAlias);
    const role = await new AgentRoleStore(resolve(this.stores.paths.root, "agents", job.requesterAlias)).load(identity);
    const reviewer = await this.stores.identities.inspect("dave");
    const reviewerRole = await new AgentRoleStore(resolve(this.stores.paths.root, "agents", "dave")).load(reviewer);
    const contact = await this.stores.contacts.get(job.requesterAlias, job.contactId);
    const mailbox = await this.stores.mailboxes.load(job.requesterAlias);
    if (!role || identity.did !== job.requesterDid || reviewer.did !== job.reviewerDid || reviewerRole !== "reviewer" ||
      contact.did !== job.targetDid || mailbox.did !== job.requesterDid ||
      hashValue({ room: contact.mailbox, did: contact.did, contactId: contact.contactId }) !== job.destinationHash ||
      hashValue({ room: mailbox.room, did: mailbox.did, owner: job.requesterAlias }) !== job.responseRouteHash) {
      throw new BridgeError("Outbound external contact, identity, role or response route binding changed");
    }
    await this.assertTargetExternal(job.targetDid);
    const definition = createDefaultWorkloadRegistry().require(job.workloadType);
    if (definition.version !== job.workloadVersion || schemaId(job.workloadType, "output") !== job.expectedOutputSchema ||
      hashValue(definition.validateInput(structuredClone(job.input))) !== job.inputHash) {
      throw new BridgeError("Outbound external workload binding changed");
    }
  }

  async prepare(input: PrepareOutboundExternalWork): Promise<OutboundExternalWorkSummary> {
    const allowed = new Set(["requestId", "requesterAlias", "targetDid", "contactId", "objective", "workloadType",
      "workloadVersion", "input", "responseDeadline", "responseRouteEvidenceHash", "schemaAgreementHash", "reviewCriteria"]);
    if (Object.keys(input).some(key => !allowed.has(key))) throw new BridgeError("Outbound external work input contains unsupported fields");
    assertRequestId(input.requestId); const requesterAlias = assertLocalAlias(input.requesterAlias);
    didToPublicKeyBytes(input.targetDid); await this.assertTargetExternal(input.targetDid);
    if (input.workloadVersion !== 1 || typeof input.objective !== "string" || !input.objective.trim() || input.objective.length > 512 ||
      !input.input || typeof input.input !== "object" || Array.isArray(input.input) || !isHash(input.responseRouteEvidenceHash) ||
      !isHash(input.schemaAgreementHash)) throw new BridgeError("Invalid outbound external work input");
    const reviewCriteria = stringList(input.reviewCriteria, "External review criteria", 16);
    if (!reviewCriteria.length) throw new BridgeError("External result requires review criteria");
    const preparedAt = this.now(), deadline = Date.parse(input.responseDeadline);
    if (!Number.isFinite(deadline) || deadline <= Date.parse(preparedAt) || deadline > Date.parse(preparedAt) + 24 * 60 * 60 * 1000) {
      throw new BridgeError("External response deadline must be within 24 hours");
    }
    const identity = await this.stores.identities.inspect(requesterAlias);
    const role = await new AgentRoleStore(resolve(this.stores.paths.root, "agents", requesterAlias)).load(identity);
    const reviewer = await this.stores.identities.inspect("dave");
    const reviewerRole = await new AgentRoleStore(resolve(this.stores.paths.root, "agents", "dave")).load(reviewer);
    if (!role || reviewerRole !== "reviewer") throw new BridgeError("Requester and Dave reviewer roles must be operator-configured");
    const contact = await this.stores.contacts.get(requesterAlias, input.contactId);
    const mailbox = await this.stores.mailboxes.load(requesterAlias);
    if (contact.did !== input.targetDid || mailbox.did !== identity.did) throw new BridgeError("External target/contact or response route DID mismatch");
    const workload = createDefaultWorkloadRegistry().require(input.workloadType);
    if (workload.version !== input.workloadVersion) throw new BridgeError("External workload version is unsupported");
    const normalizedInput = workload.validateInput(structuredClone(input.input));
    if (!normalizedInput || typeof normalizedInput !== "object" || Array.isArray(normalizedInput)) throw new BridgeError("External workload input must remain structured");
    const structuredInput = normalizedInput as Record<string, unknown>;
    const inputHash = hashValue(structuredInput), expectedOutputSchema = schemaId(input.workloadType, "output");
    const baseEnvelope = { version: 1 as const, kind: "external-work-request" as const, requestId: input.requestId,
      requesterDid: identity.did, targetDid: input.targetDid, workloadType: input.workloadType, workloadVersion: 1 as const,
      objective: input.objective, input: structuredInput, inputHash, expectedOutputSchema,
      responseDeadline: input.responseDeadline, createdAt: preparedAt };
    const requestPayloadHash = requestBinding(baseEnvelope);
    const requestEnvelope: ExternalWorkRequestEnvelope = { ...baseEnvelope, requestPayloadHash };
    const requestText = safePeerText(requestEnvelope, 4096), transportPayloadHash = hashValue(requestText);
    assertNoSecretLikeOutput(requestText, "External work request");
    const destinationHash = hashValue({ room: contact.mailbox, did: contact.did, contactId: contact.contactId });
    const responseRouteHash = hashValue({ room: mailbox.room, did: mailbox.did, owner: requesterAlias });
    const outboundJobId = hashValue({ requesterDid: identity.did, requestId: input.requestId });
    const authorityId = hashValue({ kind: "outbound-external-work/v1", outboundJobId, requesterDid: identity.did,
      targetDid: input.targetDid, destinationHash, responseRouteHash, responseRouteEvidenceHash: input.responseRouteEvidenceHash,
      schemaAgreementHash: input.schemaAgreementHash, requestPayloadHash, reviewerDid: reviewer.did,
      reviewCriteriaHash: hashValue(reviewCriteria) });
    const actionId = hashValue({ outboundJobId, authorityId, requestId: input.requestId, effect: "external-work-request" });
    const effect = { agentAlias: requesterAlias, agentDid: identity.did, type: "technocore.send-contact" as const,
      destinationHash, payloadHash: transportPayloadHash };
    const actionHash = hashValue({ actionId, ...effect });
    const since = await this.stores.cursors.get(requesterAlias, mailbox.room);
    const job: OutboundExternalWorkJob = { version: 1, outboundJobId, requestId: input.requestId, requesterAlias,
      requesterDid: identity.did, reviewerAlias: "dave", reviewerDid: reviewer.did, targetDid: input.targetDid,
      contactId: contact.contactId, destinationHash, responseRouteHash,
      responseRouteEvidenceHash: input.responseRouteEvidenceHash, schemaAgreementHash: input.schemaAgreementHash,
      objective: input.objective, workloadType: input.workloadType, workloadVersion: 1, input: structuredInput, inputHash,
      expectedOutputSchema, requestPayloadHash, transportPayloadHash, requestEnvelope, requestText, actionId, actionHash,
      authorityId, preparedAt, responseDeadline: input.responseDeadline, reviewCriteria, state: "PREPARED", postAttempts: 0,
      intake: { since, maxReads: 1, readAttempts: 0, wait: 0, limit: 200 } };
    return withFileLock(this.jobPath(outboundJobId), async () => {
      const existing = await readJsonFile<OutboundExternalWorkJob | null>(this.jobPath(outboundJobId), null);
      if (existing) {
        this.validateStored(existing);
        if (hashValue(existing.requestEnvelope) !== hashValue(job.requestEnvelope) || existing.destinationHash !== destinationHash ||
          existing.responseRouteHash !== responseRouteHash || existing.schemaAgreementHash !== input.schemaAgreementHash) {
          throw new BridgeError("External request id already binds different work");
        }
        await this.validateCurrent(existing);
        await this.approvals().propose(effectFor(existing), existing.actionId);
        return this.summary(existing);
      }
      await atomicWriteJson(this.jobPath(outboundJobId), job);
      const approval = await this.approvals().propose(effect, actionId);
      if (approval.actionHash !== actionHash) throw new BridgeError("External request approval binding mismatch");
      return this.summary(job);
    });
  }

  async status(id: string): Promise<OutboundExternalWorkSummary> { return this.summary(await this.record(id)); }

  async list(): Promise<OutboundExternalWorkSummary[]> {
    let names: string[];
    try { names = await readdir(resolve(this.directory, "jobs")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const results: OutboundExternalWorkSummary[] = [];
    for (const name of names.filter(value => /^[a-f0-9]{64}\.json$/u.test(value)).sort()) results.push(await this.status(name.slice(0, -5)));
    return results;
  }

  async authorize(id: string, expectedActionHash: string): Promise<OutboundExternalWorkSummary> {
    return withFileLock(this.jobPath(id), async () => {
      const job = await this.record(id); await this.validateCurrent(job);
      if (!["PREPARED", "AUTHORIZED"].includes(job.state) || job.actionHash !== expectedActionHash ||
        Date.parse(job.responseDeadline) <= this.clock().getTime()) throw new BridgeError("Exact unexpired external work authority required");
      const approval = await this.approvals().propose(effectFor(job), job.actionId);
      if (approval.actionHash !== expectedActionHash) throw new BridgeError("External work approval hash mismatch");
      if (approval.status === "requested") await this.approvals().grant(job.requesterAlias, job.actionId, expectedActionHash);
      else if (approval.status !== "approved") throw new BridgeError("External work authority already spent");
      job.state = "AUTHORIZED"; await atomicWriteJson(this.jobPath(id), job); return this.summary(job);
    });
  }

  private transport(): TechnocoreTransport {
    if (this.options.offlineTransport) return this.options.offlineTransport;
    if (!this.options.origin) throw new BridgeError("Explicit Technocore origin required; no request made");
    return new HttpTechnocoreTransport(this.options.origin, { rateLimitRetries: 0, readRetries: 0,
      readRedirect: "error", writeTimeoutMs: 30_000 });
  }

  async send(id: string, expectedActionHash: string): Promise<OutboundExternalWorkSummary> {
    return withFileLock(this.jobPath(id), async () => {
      const job = await this.record(id); await this.validateCurrent(job);
      if (job.state !== "AUTHORIZED" || job.postAttempts !== 0 || job.actionHash !== expectedActionHash ||
        Date.parse(job.responseDeadline) <= this.clock().getTime()) throw new BridgeError("Unspent exact external work authorization required");
      const approval = await this.approvals().read(job.requesterAlias, job.actionId);
      if (approval.status !== "approved" || approval.actionHash !== expectedActionHash) throw new BridgeError("External work request is not approved");
      const guarded = new GuardedApprovals(resolve(this.directory, "approvals"), async (effect, actionId) => {
        const persisted = await this.record(id); await this.validateCurrent(persisted);
        if (hashValue(persisted) !== hashValue(job) || persisted.state !== "AUTHORIZED" || actionId !== job.actionId ||
          hashValue(effect) !== hashValue(effectFor(job))) throw new BridgeError("External work binding changed before nonce reservation");
      });
      const noReads = { readRoomText: async (): Promise<string> => { throw new BridgeError("External send has no read authority"); },
        readRoomJson: async (): Promise<RoomResponse> => { throw new BridgeError("External send has no read authority"); } };
      const transport: TechnocoreTransport = { ...noReads, sendSignedMessage: async (room, envelope) => {
        const persisted = await this.record(id); await this.validateCurrent(persisted);
        const currentApproval = await guarded.read(job.requesterAlias, job.actionId);
        const contact = await this.stores.contacts.get(job.requesterAlias, job.contactId);
        if (hashValue(persisted) !== hashValue(job) || currentApproval.status !== "executing" ||
          currentApproval.actionHash !== job.actionHash || room !== contact.mailbox || envelope.did !== job.requesterDid ||
          hashValue(envelope.text) !== job.transportPayloadHash) throw new BridgeError("External work binding changed before dispatch");
        job.state = "SENDING"; job.postAttempts = 1; await atomicWriteJson(this.jobPath(id), job);
        const response = await this.transport().sendSignedMessage(room, envelope);
        const posted = response.posted;
        if (!posted || !Number.isSafeInteger(posted.seq) || posted.seq < 1 || posted.from !== envelope.did ||
          String(posted.nonce) !== envelope.nonce || hashValue(posted.text) !== job.transportPayloadHash) {
          throw new AmbiguousSendError("External work receipt mismatch; no retry");
        }
        job.sentSeq = posted.seq; await atomicWriteJson(this.jobPath(id), job); return response;
      } };
      try {
        await new SignedAgentBridge({ ...this.stores, approvals: guarded }, transport)
          .sendTo(job.requesterAlias, job.contactId, job.requestText, job.actionId);
        job.state = "SENT"; await atomicWriteJson(this.jobPath(id), job);
        job.state = "AWAITING_RESPONSE"; await atomicWriteJson(this.jobPath(id), job);
      } catch (error) {
        const diagnostics = outboundDiagnostics(error);
        if (!diagnostics && job.postAttempts === 0) throw error;
        if (diagnostics) job.deliveryDiagnostics = diagnostics;
        job.state = error instanceof SignedPostRejectedError || diagnostics?.dispatchBegan === false
          ? "DELIVERY_REJECTED" : "AMBIGUOUS_DELIVERY";
        await atomicWriteJson(this.jobPath(id), job);
      }
      return this.summary(job);
    });
  }

  private validateCheckpoint(value: ResponseCheckpoint, job: OutboundExternalWorkJob): void {
    if (!value || value.version !== 1 || value.outboundJobId !== job.outboundJobId || value.roomHash !== job.responseRouteHash ||
      value.previousCursor !== job.intake.since || !Number.isSafeInteger(value.lastSeq) || value.lastSeq < value.previousCursor ||
      value.firstSeq !== null && (!Number.isSafeInteger(value.firstSeq) || value.firstSeq < 1) ||
      !Array.isArray(value.messages) || value.messages.length > job.intake.limit) throw new BridgeError("Invalid retained external response checkpoint");
  }

  private validateResult(message: InboxMessage, job: OutboundExternalWorkJob, room: string): ExternalWorkResultEnvelope {
    if (message.senderDid !== job.targetDid) throw new BridgeError("wrong-sender-did");
    if (message.signature === undefined || message.nonce === undefined || sanitizeText(message.text) !== message.text ||
      !verifySignedMessage(room, { did: message.senderDid,
        signature: message.signature, nonce: String(message.nonce), sanitizedText: message.text })) throw new BridgeError("invalid-or-missing-signature");
    let parsed: unknown;
    try { parsed = JSON.parse(message.text); } catch { throw new BridgeError("invalid-response-json"); }
    if (safePeerText(parsed, 4096) !== message.text) throw new BridgeError("noncanonical-response-json");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new BridgeError("invalid-response-schema");
    const value = parsed as Record<string, unknown>;
    const allowed = new Set(["version", "kind", "requestId", "requesterDid", "responderDid", "workloadType",
      "workloadVersion", "requestPayloadHash", "status", "output", "resultHash", "createdAt"]);
    if (Object.keys(value).some(key => !allowed.has(key)) || value.version !== 1 || value.kind !== "external-work-result" ||
      value.requestId !== job.requestId || value.requesterDid !== job.requesterDid || value.responderDid !== job.targetDid ||
      value.workloadType !== job.workloadType || value.workloadVersion !== job.workloadVersion ||
      value.requestPayloadHash !== job.requestPayloadHash || !["completed", "failed", "declined"].includes(String(value.status)) ||
      value.output === undefined || !isHash(value.resultHash) || value.resultHash !== hashValue(value.output) ||
      typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) ||
      Date.parse(value.createdAt) < Date.parse(job.preparedAt) || Date.parse(value.createdAt) > Date.parse(job.responseDeadline)) {
      throw new BridgeError("invalid-response-correlation");
    }
    if (value.status === "completed") createDefaultWorkloadRegistry().require(job.workloadType).validateResult(structuredClone(value.output), job.input);
    return structuredClone(value) as unknown as ExternalWorkResultEnvelope;
  }

  private async acknowledge(job: OutboundExternalWorkJob, seq: number): Promise<void> {
    const mailbox = await this.stores.mailboxes.load(job.requesterAlias);
    if (await this.stores.cursors.get(job.requesterAlias, mailbox.room) !== job.intake.since) {
      throw new BridgeError("External response cursor changed before acknowledgement");
    }
    await this.options.beforeAcknowledge?.(structuredClone(job), seq);
    await this.stores.cursors.advance(job.requesterAlias, mailbox.room, seq);
  }

  private async completePendingAcknowledgement(job: OutboundExternalWorkJob): Promise<boolean> {
    if (!job.response || job.response.acknowledged) return false;
    const checkpoint = await readJsonFile<ResponseCheckpoint | null>(job.response.checkpointRef, null);
    if (!checkpoint || hashValue(checkpoint) !== job.response.checkpointHash ||
      !checkpoint.messages.some(message => message.seq === job.response!.seq)) throw new BridgeError("External response ACK evidence changed");
    const mailbox = await this.stores.mailboxes.load(job.requesterAlias);
    const cursor = await this.stores.cursors.get(job.requesterAlias, mailbox.room);
    if (cursor === job.intake.since) await this.acknowledge(job, job.response.seq);
    else if (cursor < job.response.seq) throw new BridgeError("External response cursor cannot be reconciled offline");
    job.response.acknowledged = true; await atomicWriteJson(this.jobPath(job.outboundJobId), job); return true;
  }

  private async processCheckpoint(job: OutboundExternalWorkJob, checkpoint: ResponseCheckpoint, checkpointRef: string, room: string): Promise<void> {
    this.validateCheckpoint(checkpoint, job);
    const checkpointHash = hashValue(checkpoint);
    job.intake.checkpointRef = checkpointRef; job.intake.checkpointHash = checkpointHash;
    if ((checkpoint.messages.length === 0) !== (checkpoint.firstSeq === null) ||
      checkpoint.messages.length === 0 && checkpoint.lastSeq !== checkpoint.previousCursor ||
      checkpoint.messages.length === 1 && checkpoint.lastSeq !== checkpoint.messages[0]!.seq ||
      checkpoint.firstSeq !== null && checkpoint.firstSeq > checkpoint.previousCursor + 1 ||
      checkpoint.messages.some((message, index, list) => !Number.isSafeInteger(message.seq) || message.seq <= checkpoint.previousCursor ||
        index > 0 && message.seq <= list[index - 1]!.seq) || checkpoint.messages.length > 1) {
      const last = checkpoint.messages.at(-1);
      job.state = "INVALID_RESPONSE";
      if (last) job.response = { checkpointRef, checkpointHash, seq: last.seq, senderDid: last.senderDid,
        messageHash: hashValue({ seq: last.seq, did: last.senderDid, text: last.text, nonce: last.nonce }), locallyVerified: false,
        failureCode: "invalid-window-or-duplicate", receivedAt: this.now() };
      await atomicWriteJson(this.jobPath(job.outboundJobId), job);
      if (last) {
        await this.acknowledge(job, last.seq);
        job.response!.acknowledged = true; await atomicWriteJson(this.jobPath(job.outboundJobId), job);
      }
      return;
    }
    const message = checkpoint.messages[0];
    if (!message) { await atomicWriteJson(this.jobPath(job.outboundJobId), job); return; }
    let result: ExternalWorkResultEnvelope | undefined;
    let failureCode: string | undefined;
    const signatureHash = message.signature === undefined ? undefined : hashValue(message.signature);
    try { result = this.validateResult(message, job, room); } catch (error) {
      failureCode = error instanceof BridgeError && /^[a-z-]+$/u.test(error.message) ? error.message : "invalid-response";
    }
    job.response = { checkpointRef, checkpointHash, seq: message.seq, senderDid: message.senderDid,
      messageHash: hashValue({ seq: message.seq, did: message.senderDid, text: message.text, nonce: message.nonce }),
      ...(signatureHash ? { signatureHash } : {}), locallyVerified: result !== undefined,
      ...(result ? { resultHash: result.resultHash, responseStatus: result.status } : {}),
      ...(failureCode ? { failureCode } : {}), receivedAt: this.now() };
    if (!result) job.state = "INVALID_RESPONSE";
    else {
      job.state = "RESPONSE_RECEIVED"; await atomicWriteJson(this.jobPath(job.outboundJobId), job);
      job.state = "REVIEW_PENDING";
    }
    await atomicWriteJson(this.jobPath(job.outboundJobId), job); // Linkage is durable before ACK.
    await this.acknowledge(job, message.seq);
    job.response.acknowledged = true; await atomicWriteJson(this.jobPath(job.outboundJobId), job);
  }

  async receive(id: string): Promise<OutboundExternalWorkSummary> {
    return withFileLock(this.jobPath(id), async () => {
      const job = await this.record(id); await this.validateCurrent(job);
      if (job.response && await this.completePendingAcknowledgement(job)) return this.summary(job);
      if (job.state === "SENT" && job.sentSeq !== undefined) {
        const approval = await this.approvals().read(job.requesterAlias, job.actionId);
        if (approval.status !== "confirmed") throw new BridgeError("Confirmed send evidence is incomplete");
        job.state = "AWAITING_RESPONSE"; await atomicWriteJson(this.jobPath(id), job);
      }
      if (job.state !== "AWAITING_RESPONSE") throw new BridgeError("External work is not awaiting a response");
      if (Date.parse(job.responseDeadline) <= this.clock().getTime()) throw new BridgeError("Response deadline elapsed; use timeout without a new GET");
      const mailbox = await this.stores.mailboxes.load(job.requesterAlias);
      if (await this.stores.cursors.get(job.requesterAlias, mailbox.room) !== job.intake.since) throw new BridgeError("External response cursor changed; no GET made");
      const checkpointRef = this.checkpointPath(id);
      let checkpoint = await readJsonFile<ResponseCheckpoint | null>(checkpointRef, null);
      if (!checkpoint) {
        if (job.intake.readAttempts >= job.intake.maxReads) throw new BridgeError("External response read budget spent; no retry");
        job.intake.readAttempts = 1; job.intake.readStartedAt = this.now(); await atomicWriteJson(this.jobPath(id), job);
        let readCompleted = false;
        try {
          const bridge = new SignedAgentBridge(this.stores, this.transport());
          await bridge.withIntakeOwnership(job.requesterAlias, async () => {
            const peek = await bridge.peekInbox(job.requesterAlias, { since: job.intake.since });
            readCompleted = true;
            checkpoint = { version: 1, outboundJobId: id, roomHash: job.responseRouteHash,
              previousCursor: peek.previousCursor, firstSeq: peek.firstSeq, lastSeq: peek.lastSeq,
              messages: structuredClone(peek.messages), observedAt: this.now() };
            await atomicCreateJson(checkpointRef, checkpoint); // Untrusted exact material retained before verification.
          });
        } catch (error) {
          job.intake.readFailure = readCompleted ? "persistence-failed" : "transport-failed";
          await atomicWriteJson(this.jobPath(id), job); throw error;
        }
      }
      if (!checkpoint) throw new BridgeError("External response checkpoint was not retained");
      await this.processCheckpoint(job, checkpoint, checkpointRef, mailbox.room);
      return this.summary(job);
    });
  }

  async timeout(id: string): Promise<OutboundExternalWorkSummary> {
    return withFileLock(this.jobPath(id), async () => {
      const job = await this.record(id); await this.validateCurrent(job);
      if (terminal.has(job.state)) return this.summary(job);
      if (job.state !== "AWAITING_RESPONSE" || job.intake.readAttempts !== job.intake.maxReads ||
        Date.parse(job.responseDeadline) > this.clock().getTime()) throw new BridgeError("NO_RESPONSE requires an elapsed deadline and spent bounded observation");
      job.state = "NO_RESPONSE"; await atomicWriteJson(this.jobPath(id), job); return this.summary(job);
    });
  }

  private async completedReview(job: OutboundExternalWorkJob): Promise<Awaited<ReturnType<typeof readCompletedTaskEvidence>>["evidence"] | undefined> {
    if (!job.review?.taskId) return undefined;
    const paths = agentPaths(this.stores.paths.root, "dave");
    try { return (await readCompletedTaskEvidence({ state: new AgentStateStore(paths.state), memory: new LocalMemoryProvider(paths.memory),
      journal: new ActivityJournal(paths.journal) }, "dave", job.reviewerDid, job.review.taskId)).evidence; }
    catch { return undefined; }
  }

  async review(id: string): Promise<OutboundExternalWorkSummary> {
    return withFileLock(this.jobPath(id), async () => {
      const job = await this.record(id); await this.validateCurrent(job);
      if (terminal.has(job.state)) return this.summary(job);
      if (job.state !== "REVIEW_PENDING" || !job.response?.locallyVerified || !job.response.resultHash) {
        throw new BridgeError("A locally verified correlated response is required for review");
      }
      const checkpoint = await readJsonFile<ResponseCheckpoint | null>(job.response.checkpointRef, null);
      if (!checkpoint || hashValue(checkpoint) !== job.response.checkpointHash || checkpoint.messages.length !== 1) {
        throw new BridgeError("External response evidence changed before review");
      }
      const mailbox = await this.stores.mailboxes.load(job.requesterAlias);
      const response = this.validateResult(checkpoint.messages[0]!, job, mailbox.room);
      const producedResult = { request: { requestId: job.requestId, objective: job.objective, input: job.input,
        inputHash: job.inputHash, expectedOutputSchema: job.expectedOutputSchema },
        response: { status: response.status, output: response.output, resultHash: response.resultHash },
        correlation: { requesterDid: job.requesterDid, responderDid: job.targetDid, requestPayloadHash: job.requestPayloadHash,
          locallyVerifiedSignature: true, messageHash: job.response.messageHash } };
      const taskId = `external_review_${job.outboundJobId.slice(0, 32)}`;
      job.review ??= { taskId }; await atomicWriteJson(this.jobPath(id), job);
      let evidence = await this.completedReview(job);
      if (!evidence) {
        if (!this.options.reviewInference) throw new BridgeError("Dave review requires a configured host inference provider; no substitute was used");
        const runtime = await AgentRuntime.start({ identityAlias: "dave", expectedDid: job.reviewerDid,
          root: this.stores.paths.root, passphrases: this.options.passphrases ?? (async () => { throw new BridgeError("Passphrase provider required"); }),
          inference: this.options.reviewInference, clock: this.clock, handleSignals: false });
        try {
          const state = await runtime.state.load();
          if (!state.tasks[taskId]) await runtime.enqueueTask({ id: taskId, idempotencyKey: `external-review:${job.outboundJobId}`,
            type: "workload.review", maxAttempts: 1, payload: { question: `Review external result for: ${job.objective}`,
              producedResult, expectedOutputHash: hashValue(producedResult), criteria: job.reviewCriteria } });
          const run = await runtime.runOnce(taskId);
          if (run.kind !== "processed" || run.task?.status !== "succeeded") throw new BridgeError("Dave review did not complete; no automatic rerun");
          evidence = await runtime.exportTaskEvidence(taskId);
        } finally { await runtime.close(); }
      }
      if (!evidence) throw new BridgeError("Dave review evidence is unavailable");
      const output = evidence.output as ReviewOutput;
      if (!output || !["VOUCH", "REJECT", "REVISION_REQUIRED"].includes(output.outcome)) throw new BridgeError("Invalid Dave review evidence");
      job.review = { taskId, resultHash: evidence.resultHash, evidenceHash: hashValue(evidence), outcome: output.outcome };
      job.state = output.outcome === "VOUCH" ? "SUCCESS" : output.outcome === "REJECT" ? "REJECTED_RESULT" : "REVISION_REQUIRED";
      await atomicWriteJson(this.jobPath(id), job); return this.summary(job);
    });
  }
}
