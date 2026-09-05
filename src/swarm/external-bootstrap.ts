import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { ActionApprovalStore, type ExactActionEffect } from "../agent/approvals.js";
import { hashValue, systemClock, type AgentClock } from "../agent/util.js";
import { SignedAgentBridge } from "../bridge.js";
import { createStores } from "../context.js";
import { DiscoveryStore } from "../discovery/store.js";
import type { Observation } from "../discovery/model.js";
import { publicRoom } from "../discovery/model.js";
import { AmbiguousSendError, BridgeError } from "../errors.js";
import { atomicCreateJson, atomicWriteJson, readJsonFile, withFileLock } from "../fs-safe.js";
import { assertLocalAlias, roomClasses } from "../names.js";
import type { PassphraseProvider } from "../passphrase.js";
import { didToPublicKeyBytes, sanitizeText, verifySignedMessage } from "../protocol.js";
import { outboundDiagnostics, SignedPostRejectedError, type OutboundDiagnostics } from "../send-diagnostics.js";
import { HttpTechnocoreTransport } from "../transport.js";
import type { RoomMessage, TechnocoreTransport } from "../types.js";
import { assertNoSecretLikeOutput } from "../workloads/types.js";
import { safePeerText } from "./proposal.js";
import { peerAliases } from "./session-policy.js";

export const EXTERNAL_BOOTSTRAP_STATES = [
  "PREPARED", "AUTHORIZED", "SENDING", "SENT", "AWAITING_RESPONSE", "ACCEPTED_EVIDENCE",
  "NO_RESPONSE", "INVALID_RESPONSE", "AMBIGUOUS_DELIVERY", "REJECTED",
] as const;
export type ExternalBootstrapState = typeof EXTERNAL_BOOTSTRAP_STATES[number];
export type BootstrapResponseMode = "same-public-room" | "public-owned-room";

export interface PublicOwnedRoomDescriptor {
  type: "public-owned-room";
  room: string;
  ownerDid: string;
}

export interface ExternalBootstrapRequestEnvelope {
  version: 1;
  kind: "external-bootstrap-request";
  purpose: "bounded-agent-work-interoperability";
  bootstrapId: string;
  requesterDid: string;
  targetDid: string;
  challengeId: string;
  supportedRequestSchemas: string[];
  supportedResultSchemas: string[];
  proposedResponseMode: BootstrapResponseMode;
  proposedResponseRoute?: PublicOwnedRoomDescriptor;
  responseRequirements: {
    signedByTargetDid: true;
    bindsChallengeId: true;
    noPrivateMailboxCapabilityInPublicResponse: true;
  };
  createdAt: string;
  expiresAt: string;
}

export interface ExternalBootstrapResponseEnvelope {
  version: 1;
  kind: "external-bootstrap-response";
  bootstrapId: string;
  challengeId: string;
  requesterDid: string;
  responderDid: string;
  accepted: boolean;
  acceptedRequestSchemas: string[];
  acceptedResultSchemas: string[];
  responseMode: BootstrapResponseMode;
  responseRoute?: PublicOwnedRoomDescriptor;
  endpointHash?: string;
  createdAt: string;
  expiresAt: string;
}

export interface PrepareExternalBootstrap {
  candidateId: string;
  requesterAlias: string;
  targetDid: string;
  selectedPublicRoom: string;
  selectedRoomGeneration?: number;
  supportedRequestSchemas: string[];
  supportedResultSchemas: string[];
  proposedResponseMode: BootstrapResponseMode;
  proposedResponseRoute?: PublicOwnedRoomDescriptor;
  expiresAt: string;
}

interface DiscoverySelectionEvidence {
  observationIds: string[];
  evidenceHash: string;
  lastSeenAt: string;
  latestObservedSeq?: number;
}

interface BootstrapObservationPolicy {
  since: number;
  generation?: number;
  maxReads: 1;
  readAttempts: number;
  wait: 0;
  limit: 200;
  acknowledgedThrough: number;
  checkpointRef?: string;
  checkpointHash?: string;
  readStartedAt?: string;
  readFailure?: "transport-failed" | "persistence-failed";
}

interface BootstrapResponseLink {
  checkpointRef: string;
  checkpointHash: string;
  seq: number;
  senderDid: string;
  messageHash: string;
  signatureHash?: string;
  locallyVerified: boolean;
  accepted?: boolean;
  agreedRequestSchemas?: string[];
  agreedResultSchemas?: string[];
  responseMode?: BootstrapResponseMode;
  routeHash?: string;
  failureCode?: string;
  receivedAt: string;
  acknowledged: boolean;
}

interface RetainedBootstrapMessage {
  seq: number;
  ts: string;
  senderDid: string;
  messageHash: string;
  contentOmitted: boolean;
  text?: string;
  nonce?: number | string;
  signature?: string;
}

interface BootstrapObservationCheckpoint {
  version: 1;
  bootstrapId: string;
  roomHash: string;
  previousCursor: number;
  firstSeq: number | null;
  lastSeq: number;
  lastReturnedSeq: number | null;
  generation?: number;
  matchingMessages: RetainedBootstrapMessage[];
  matchingOverflow: boolean;
  observedAt: string;
}

export interface PublicOwnedRouteVerification {
  ownerMetadataHash: string;
  allowListHash: string;
  ownerDid: string;
  allowedRequesterDid: string;
  verifiedAt: string;
}

export interface ExternalBootstrapPromotionProposal {
  version: 1;
  kind: "external-bootstrap-promotion-proposal";
  proposalId: string;
  bootstrapId: string;
  candidateId: string;
  targetDid: string;
  verifiedBootstrapEvidenceHash: string;
  selectedPublicRoom: string;
  agreedRequestSchemas: string[];
  agreedResultSchemas: string[];
  agreedResponseMode: BootstrapResponseMode;
  responseRoute?: PublicOwnedRoomDescriptor;
  routeHash: string;
  freshnessEvidence: { responseCreatedAt: string; responseExpiresAt: string; observedAt: string; seq: number };
  publicOwnedRouteVerification?: PublicOwnedRouteVerification;
  warnings: string[];
  operatorReviewRequired: true;
  createsContact: false;
  grantsAuthority: false;
  createdAt: string;
}

export interface ExternalBootstrapRecord {
  version: 1;
  bootstrapId: string;
  candidateId: string;
  requesterAlias: string;
  requesterDid: string;
  targetDid: string;
  selectedPublicRoom: string;
  selectedRoomGeneration?: number;
  discoveryEvidence: DiscoverySelectionEvidence;
  challengeId: string;
  handshakeVersion: 1;
  supportedRequestSchemas: string[];
  supportedResultSchemas: string[];
  proposedResponseMode: BootstrapResponseMode;
  proposedResponseRoute?: PublicOwnedRoomDescriptor;
  requestEnvelope: ExternalBootstrapRequestEnvelope;
  requestText: string;
  requestPayloadHash: string;
  transportPayloadHash: string;
  destinationHash: string;
  actionId: string;
  actionHash: string;
  createdAt: string;
  expiresAt: string;
  sendAttemptCount: number;
  sentSeq?: number;
  deliveryDiagnostics?: OutboundDiagnostics;
  observation: BootstrapObservationPolicy;
  response?: BootstrapResponseLink;
  acceptedResponse?: ExternalBootstrapResponseEnvelope;
  publicOwnedRouteVerification?: PublicOwnedRouteVerification;
  promotionProposalRef?: string;
  promotionProposalHash?: string;
  challengeConsumedAt?: string;
  state: ExternalBootstrapState;
}

export interface ExternalBootstrapSummary {
  bootstrapId: string;
  candidateId: string;
  requesterAlias: string;
  requesterDid: string;
  targetDid: string;
  selectedPublicRoom: string;
  selectedRoomGeneration?: number;
  challengeId: string;
  handshakeVersion: 1;
  supportedRequestSchemas: string[];
  supportedResultSchemas: string[];
  proposedResponseMode: BootstrapResponseMode;
  requestPayloadHash: string;
  actionId: string;
  actionHash: string;
  createdAt: string;
  expiresAt: string;
  state: ExternalBootstrapState;
  sendAttemptCount: number;
  sentSeq?: number;
  readAttempts: number;
  response?: Omit<BootstrapResponseLink, "checkpointRef">;
  promotionProposalHash?: string;
  operatorReviewRequired: true;
  createsContact: false;
  grantsAuthority: false;
  deliveryDiagnostics?: OutboundDiagnostics;
}

export interface ExternalBootstrapOptions {
  root: string;
  discoveryWorkspace: string;
  passphrases?: PassphraseProvider;
  origin?: string;
  /** Test seam only. Production constructs zero-retry HTTP transports. */
  offlineTransport?: TechnocoreTransport;
  clock?: AgentClock;
  /** Future read-only owner/allow-list verifier boundary. No production implementation exists yet. */
  verifyPublicOwnedRoute?: (
    route: Readonly<PublicOwnedRoomDescriptor>,
    context: Readonly<{ requesterDid: string; targetDid: string; bootstrapId: string }>,
  ) => Promise<PublicOwnedRouteVerification | undefined>;
  /** Test seam proving evidence persistence precedes cursor advancement. */
  beforeCursorAdvance?: (record: Readonly<ExternalBootstrapRecord>, seq: number) => Promise<void>;
}

const terminal = new Set<ExternalBootstrapState>([
  "ACCEPTED_EVIDENCE", "NO_RESPONSE", "INVALID_RESPONSE", "AMBIGUOUS_DELIVERY", "REJECTED",
]);
const schemaPattern = /^[a-z][a-z0-9.-]{0,63}\/v[1-9][0-9]{0,2}$/u;
const privateCapabilityPattern = /\b(?:mb-)?p-[a-z0-9_-]{1,48}\b/iu;

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function schemas(value: unknown, label: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || value.length > 16 || (!allowEmpty && value.length === 0) ||
    value.some(item => typeof item !== "string" || !schemaPattern.test(item)) ||
    new Set(value).size !== value.length) throw new BridgeError(`Invalid ${label}`);
  return [...value] as string[];
}

function privateCapability(text: string): boolean {
  if (privateCapabilityPattern.test(text)) return true;
  try { return privateCapabilityPattern.test(decodeURIComponent(text)); } catch { return true; }
}

function validatePublicOwnedRoute(value: unknown, targetDid: string): PublicOwnedRoomDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BridgeError("Invalid public-owned response route");
  const route = value as PublicOwnedRoomDescriptor;
  if (Object.keys(route).some(key => !["type", "room", "ownerDid"].includes(key)) ||
    route.type !== "public-owned-room" || !publicRoom(route.room) || !roomClasses(route.room).includes("d") ||
    route.ownerDid !== targetDid) throw new BridgeError("Invalid or unrelated public-owned response route");
  didToPublicKeyBytes(route.ownerDid);
  assertNoSecretLikeOutput(JSON.stringify(route), "Public bootstrap route");
  return structuredClone(route);
}

function selectionProjection(observations: Observation[]): unknown[] {
  return observations.map(o => ({ observationId: o.observationId, claimedDid: o.claimedDid, room: o.room,
    seq: o.seq, generation: o.generation, sourceHash: o.sourceHash, contentHash: o.contentHash,
    signatureState: o.signatureState, verificationState: o.verificationState,
    provenanceClassification: o.provenanceClassification })).sort((a, b) => a.observationId.localeCompare(b.observationId));
}

function effectFor(record: Pick<ExternalBootstrapRecord,
  "requesterAlias" | "requesterDid" | "destinationHash" | "transportPayloadHash">): ExactActionEffect {
  return { agentAlias: record.requesterAlias, agentDid: record.requesterDid, type: "technocore.send-public",
    destinationHash: record.destinationHash, payloadHash: record.transportPayloadHash };
}

function publicSendDestination(room: string): string { return hashValue({ room }); }

class GuardedBootstrapApprovals extends ActionApprovalStore {
  constructor(directory: string, private readonly guard: (effect: ExactActionEffect, id?: string) => Promise<void>) {
    super(directory);
  }
  override async consume(effect: ExactActionEffect, id?: string) {
    await this.guard(effect, id);
    return super.consume(effect, id);
  }
}

/** Quarantined, one-candidate bootstrap lifecycle. It never writes contacts or discovery state. */
export class ExternalBootstrapCoordinator {
  private readonly stores;
  private readonly discovery: DiscoveryStore;
  private readonly clock: AgentClock;
  readonly directory: string;

  constructor(private readonly options: ExternalBootstrapOptions) {
    this.stores = createStores(options.root, options.passphrases);
    this.discovery = new DiscoveryStore(options.discoveryWorkspace);
    this.clock = options.clock ?? systemClock;
    this.directory = resolve(this.stores.paths.root, "external-bootstrap");
  }

  private now(): string { return this.clock().toISOString(); }
  private recordPath(id: string): string {
    if (!isHash(id)) throw new BridgeError("Invalid external bootstrap id");
    return resolve(this.directory, "records", `${id}.json`);
  }
  private checkpointPath(id: string): string { return resolve(this.directory, "observations", `${id}-read-1.json`); }
  private proposalPath(id: string): string { return resolve(this.directory, "proposals", `${id}.json`); }
  private approvals(): ActionApprovalStore { return new ActionApprovalStore(resolve(this.directory, "approvals")); }
  private transport(): TechnocoreTransport {
    if (this.options.offlineTransport) return this.options.offlineTransport;
    if (!this.options.origin) throw new BridgeError("Technocore origin is required; no request made");
    return new HttpTechnocoreTransport(this.options.origin, { readRetries: 0, rateLimitRetries: 0 });
  }

  private summary(record: ExternalBootstrapRecord): ExternalBootstrapSummary {
    return { bootstrapId: record.bootstrapId, candidateId: record.candidateId,
      requesterAlias: record.requesterAlias, requesterDid: record.requesterDid, targetDid: record.targetDid,
      selectedPublicRoom: record.selectedPublicRoom,
      ...(record.selectedRoomGeneration === undefined ? {} : { selectedRoomGeneration: record.selectedRoomGeneration }),
      challengeId: record.challengeId, handshakeVersion: 1,
      supportedRequestSchemas: [...record.supportedRequestSchemas], supportedResultSchemas: [...record.supportedResultSchemas],
      proposedResponseMode: record.proposedResponseMode, requestPayloadHash: record.requestPayloadHash,
      actionId: record.actionId, actionHash: record.actionHash, createdAt: record.createdAt, expiresAt: record.expiresAt,
      state: record.state === "SENDING" ? "AMBIGUOUS_DELIVERY" : record.state,
      sendAttemptCount: record.sendAttemptCount, ...(record.sentSeq === undefined ? {} : { sentSeq: record.sentSeq }),
      readAttempts: record.observation.readAttempts,
      ...(record.response ? { response: (({ checkpointRef: _checkpointRef, ...safe }) => structuredClone(safe))(record.response) } : {}),
      ...(record.promotionProposalHash ? { promotionProposalHash: record.promotionProposalHash } : {}),
      operatorReviewRequired: true, createsContact: false, grantsAuthority: false,
      ...(record.deliveryDiagnostics ? { deliveryDiagnostics: structuredClone(record.deliveryDiagnostics) } : {}) };
  }

  private validateStored(record: ExternalBootstrapRecord): void {
    if (!record || record.version !== 1 || !isHash(record.bootstrapId) || !isHash(record.candidateId) ||
      !EXTERNAL_BOOTSTRAP_STATES.includes(record.state) || record.handshakeVersion !== 1 ||
      !isHash(record.discoveryEvidence.evidenceHash) || !record.discoveryEvidence.observationIds.length ||
      !record.discoveryEvidence.observationIds.every(isHash) || !isTimestamp(record.discoveryEvidence.lastSeenAt) ||
      !isHash(record.requestPayloadHash) || !isHash(record.transportPayloadHash) || !isHash(record.destinationHash) ||
      !isHash(record.actionId) || !isHash(record.actionHash) || !isTimestamp(record.createdAt) ||
      !isTimestamp(record.expiresAt) || Date.parse(record.expiresAt) <= Date.parse(record.createdAt) ||
      !Number.isSafeInteger(record.sendAttemptCount) || record.sendAttemptCount < 0 || record.sendAttemptCount > 1 ||
      record.observation.maxReads !== 1 || record.observation.wait !== 0 || record.observation.limit !== 200 ||
      !Number.isSafeInteger(record.observation.readAttempts) || record.observation.readAttempts < 0 || record.observation.readAttempts > 1 ||
      !Number.isSafeInteger(record.observation.since) || record.observation.since < 0 ||
      !Number.isSafeInteger(record.observation.acknowledgedThrough) || record.observation.acknowledgedThrough < 0) {
      throw new BridgeError("Invalid external bootstrap record");
    }
    assertLocalAlias(record.requesterAlias); didToPublicKeyBytes(record.requesterDid); didToPublicKeyBytes(record.targetDid);
    if (!publicRoom(record.selectedPublicRoom) || record.selectedRoomGeneration !== undefined &&
      (!Number.isSafeInteger(record.selectedRoomGeneration) || record.selectedRoomGeneration < 0) ||
      !/^[0-9a-f-]{36}$/u.test(record.challengeId)) throw new BridgeError("Invalid bootstrap selection binding");
    schemas(record.supportedRequestSchemas, "bootstrap request schemas");
    schemas(record.supportedResultSchemas, "bootstrap result schemas");
    if (!(["same-public-room", "public-owned-room"] as string[]).includes(record.proposedResponseMode)) {
      throw new BridgeError("Invalid bootstrap response mode");
    }
    if (record.proposedResponseRoute) validatePublicOwnedRoute(record.proposedResponseRoute, record.targetDid);
    if (record.proposedResponseMode === "same-public-room" && record.proposedResponseRoute !== undefined) {
      throw new BridgeError("Same-room bootstrap cannot carry another response route");
    }
    const expectedEnvelope: ExternalBootstrapRequestEnvelope = {
      version: 1, kind: "external-bootstrap-request", purpose: "bounded-agent-work-interoperability", bootstrapId: record.bootstrapId,
      requesterDid: record.requesterDid, targetDid: record.targetDid, challengeId: record.challengeId,
      supportedRequestSchemas: record.supportedRequestSchemas, supportedResultSchemas: record.supportedResultSchemas,
      proposedResponseMode: record.proposedResponseMode,
      ...(record.proposedResponseRoute ? { proposedResponseRoute: record.proposedResponseRoute } : {}),
      responseRequirements: { signedByTargetDid: true, bindsChallengeId: true,
        noPrivateMailboxCapabilityInPublicResponse: true },
      createdAt: record.createdAt, expiresAt: record.expiresAt,
    };
    const expectedText = safePeerText(expectedEnvelope, 4096);
    if (hashValue(expectedEnvelope) !== record.requestPayloadHash || record.requestText !== expectedText ||
      record.transportPayloadHash !== hashValue(expectedText) || record.destinationHash !== publicSendDestination(record.selectedPublicRoom) ||
      record.actionId !== hashValue({ bootstrapId: record.bootstrapId, challengeId: record.challengeId,
        requesterDid: record.requesterDid, targetDid: record.targetDid, selectedPublicRoom: record.selectedPublicRoom,
        expiresAt: record.expiresAt, effect: "external-bootstrap-request" }) ||
      record.actionHash !== hashValue({ actionId: record.actionId, ...effectFor(record) }) ||
      hashValue(record.requestEnvelope) !== hashValue(expectedEnvelope)) throw new BridgeError("Bootstrap request/action binding changed");
    if (["PREPARED", "AUTHORIZED"].includes(record.state) && record.sendAttemptCount !== 0 ||
      ["SENDING", "SENT", "AWAITING_RESPONSE", "ACCEPTED_EVIDENCE", "NO_RESPONSE", "INVALID_RESPONSE",
        "AMBIGUOUS_DELIVERY"].includes(record.state) && record.sendAttemptCount !== 1 ||
      ["SENT", "AWAITING_RESPONSE", "ACCEPTED_EVIDENCE", "NO_RESPONSE", "INVALID_RESPONSE"].includes(record.state) &&
        record.sentSeq === undefined || record.state === "ACCEPTED_EVIDENCE" &&
        (!record.response?.locallyVerified || record.response.accepted !== true || !record.challengeConsumedAt || !record.acceptedResponse) ||
      record.state === "INVALID_RESPONSE" && (!record.response || record.response.locallyVerified)) {
      throw new BridgeError("Invalid external bootstrap lifecycle linkage");
    }
    if (record.response && (!isHash(record.response.checkpointHash) || !Number.isSafeInteger(record.response.seq) ||
      record.response.seq < 1 || !isHash(record.response.messageHash) || record.response.signatureHash !== undefined &&
      !isHash(record.response.signatureHash))) throw new BridgeError("Invalid bootstrap response linkage");
    if (record.promotionProposalHash !== undefined && (!isHash(record.promotionProposalHash) || !record.promotionProposalRef)) {
      throw new BridgeError("Invalid bootstrap promotion linkage");
    }
    assertNoSecretLikeOutput(record.requestText, "Bootstrap request");
  }

  private async record(id: string): Promise<ExternalBootstrapRecord> {
    const value = await readJsonFile<ExternalBootstrapRecord | null>(this.recordPath(id), null);
    if (!value || value.bootstrapId !== id) throw new BridgeError("Missing external bootstrap record");
    this.validateStored(value); return value;
  }

  private async selection(candidateId: string, targetDid: string, room: string,
    selectedGeneration?: number): Promise<{ evidence: DiscoverySelectionEvidence; generation?: number }> {
    const inspected = await this.discovery.inspectCandidate(candidateId);
    if (inspected.candidate.claimedDid !== targetDid) throw new BridgeError("Bootstrap target DID does not match candidate");
    if (!publicRoom(room) || !inspected.candidate.rooms.includes(room)) throw new BridgeError("Selected room is not a candidate public-room observation");
    const inRoom = inspected.observations.filter(o => o.room === room && o.claimedDid === targetDid);
    if (inRoom.some(o => o.signatureState === "invalid")) throw new BridgeError("Candidate has a contradictory invalid-signature room observation");
    const verified = inRoom.filter(o => o.signatureState === "verified" && o.verificationState === "local-signature-valid" &&
      o.provenanceClassification === "signed-message-verified");
    if (!verified.length) throw new BridgeError("Candidate has no locally verified signed activity in the selected room");
    const generations = [...new Set(verified.flatMap(o => o.generation === undefined ? [] : [o.generation]))].sort((a, b) => a - b);
    const generation = generations.at(-1);
    if (selectedGeneration !== undefined && selectedGeneration !== generation) throw new BridgeError("Selected room generation is not supported by discovery evidence");
    const selected = generation === undefined ? verified : verified.filter(o => o.generation === generation);
    const projected = selectionProjection(selected);
    return { evidence: { observationIds: selected.map(o => o.observationId).sort(), evidenceHash: hashValue(projected),
      lastSeenAt: selected.map(o => o.lastSeenAt).sort().at(-1)!,
      ...(!selected.some(o => o.seq !== undefined) ? {} : { latestObservedSeq: Math.max(...selected.flatMap(o => o.seq === undefined ? [] : [o.seq])) }) },
      ...(generation === undefined ? {} : { generation }) };
  }

  private async validateCurrent(record: ExternalBootstrapRecord): Promise<void> {
    this.validateStored(record);
    const identity = await this.stores.identities.inspect(record.requesterAlias);
    if (identity.did !== record.requesterDid) throw new BridgeError("Bootstrap requester identity changed");
    const current = await this.discovery.inspectCandidate(record.candidateId);
    if (current.candidate.claimedDid !== record.targetDid) throw new BridgeError("Bootstrap discovery target changed");
    const selected = current.observations.filter(o => record.discoveryEvidence.observationIds.includes(o.observationId));
    if (selected.length !== record.discoveryEvidence.observationIds.length ||
      hashValue(selectionProjection(selected)) !== record.discoveryEvidence.evidenceHash ||
      current.observations.some(o => o.room === record.selectedPublicRoom && o.claimedDid === record.targetDid && o.signatureState === "invalid")) {
      throw new BridgeError("Bootstrap discovery evidence changed or became contradictory");
    }
  }

  async prepare(input: PrepareExternalBootstrap): Promise<ExternalBootstrapSummary> {
    if (!isHash(input.candidateId)) throw new BridgeError("Invalid discovery candidate id");
    assertLocalAlias(input.requesterAlias); didToPublicKeyBytes(input.targetDid);
    if (!publicRoom(input.selectedPublicRoom)) throw new BridgeError("Bootstrap requires a public non-mailbox room");
    const requestSchemas = schemas(input.supportedRequestSchemas, "bootstrap request schemas");
    const resultSchemas = schemas(input.supportedResultSchemas, "bootstrap result schemas");
    if (!isTimestamp(input.expiresAt)) throw new BridgeError("Invalid bootstrap expiry");
    const createdAt = this.now();
    if (Date.parse(input.expiresAt) <= Date.parse(createdAt)) throw new BridgeError("Bootstrap expiry must be in the future");
    if (!(["same-public-room", "public-owned-room"] as string[]).includes(input.proposedResponseMode)) {
      throw new BridgeError("Invalid proposed bootstrap response mode");
    }
    if (input.proposedResponseMode === "same-public-room" && input.proposedResponseRoute !== undefined) {
      throw new BridgeError("Same-room bootstrap cannot publish another route");
    }
    const route = input.proposedResponseRoute === undefined ? undefined : validatePublicOwnedRoute(input.proposedResponseRoute, input.targetDid);
    const identity = await this.stores.identities.inspect(input.requesterAlias);
    for (const alias of peerAliases) {
      try { if ((await this.stores.identities.inspect(alias)).did === input.targetDid) throw new BridgeError("Bootstrap target is a local swarm DID"); }
      catch (error) { if (error instanceof BridgeError && error.message === "Bootstrap target is a local swarm DID") throw error; }
    }
    const selected = await this.selection(input.candidateId, input.targetDid, input.selectedPublicRoom, input.selectedRoomGeneration);
    const challengeId = randomUUID();
    const provisionalId = hashValue({ candidateId: input.candidateId, requesterDid: identity.did, targetDid: input.targetDid,
      selectedPublicRoom: input.selectedPublicRoom, challengeId, createdAt });
    const requestEnvelope: ExternalBootstrapRequestEnvelope = { version: 1, kind: "external-bootstrap-request",
      purpose: "bounded-agent-work-interoperability",
      bootstrapId: provisionalId, requesterDid: identity.did, targetDid: input.targetDid, challengeId,
      supportedRequestSchemas: requestSchemas, supportedResultSchemas: resultSchemas,
      proposedResponseMode: input.proposedResponseMode, ...(route ? { proposedResponseRoute: route } : {}),
      responseRequirements: { signedByTargetDid: true, bindsChallengeId: true,
        noPrivateMailboxCapabilityInPublicResponse: true },
      createdAt, expiresAt: input.expiresAt };
    const requestText = safePeerText(requestEnvelope, 4096);
    const record: ExternalBootstrapRecord = { version: 1, bootstrapId: provisionalId, candidateId: input.candidateId,
      requesterAlias: identity.name, requesterDid: identity.did, targetDid: input.targetDid,
      selectedPublicRoom: input.selectedPublicRoom, ...(selected.generation === undefined ? {} : { selectedRoomGeneration: selected.generation }),
      discoveryEvidence: selected.evidence, challengeId, handshakeVersion: 1,
      supportedRequestSchemas: requestSchemas, supportedResultSchemas: resultSchemas,
      proposedResponseMode: input.proposedResponseMode, ...(route ? { proposedResponseRoute: route } : {}),
      requestEnvelope, requestText, requestPayloadHash: hashValue(requestEnvelope), transportPayloadHash: hashValue(requestText),
      destinationHash: publicSendDestination(input.selectedPublicRoom),
      actionId: hashValue({ bootstrapId: provisionalId, challengeId, requesterDid: identity.did, targetDid: input.targetDid,
        selectedPublicRoom: input.selectedPublicRoom, expiresAt: input.expiresAt, effect: "external-bootstrap-request" }),
      actionHash: "", createdAt, expiresAt: input.expiresAt, sendAttemptCount: 0,
      observation: { since: selected.evidence.latestObservedSeq ?? 0, ...(selected.generation === undefined ? {} : { generation: selected.generation }),
        maxReads: 1, readAttempts: 0, wait: 0, limit: 200, acknowledgedThrough: selected.evidence.latestObservedSeq ?? 0 },
      state: "PREPARED" };
    record.actionHash = hashValue({ actionId: record.actionId, ...effectFor(record) });
    this.validateStored(record);
    const approval = await this.approvals().propose(effectFor(record), record.actionId);
    if (approval.actionHash !== record.actionHash) throw new BridgeError("Bootstrap approval binding mismatch");
    await atomicCreateJson(this.recordPath(record.bootstrapId), record);
    return this.summary(record);
  }

  async status(id: string): Promise<ExternalBootstrapSummary> { return this.summary(await this.record(id)); }

  async list(): Promise<ExternalBootstrapSummary[]> {
    let names: string[];
    try { names = await readdir(resolve(this.directory, "records")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const output: ExternalBootstrapSummary[] = [];
    for (const name of names.filter(n => /^[a-f0-9]{64}\.json$/u.test(n)).sort()) output.push(await this.status(name.slice(0, -5)));
    return output;
  }

  async authorize(id: string, expectedActionHash: string): Promise<ExternalBootstrapSummary> {
    return withFileLock(this.recordPath(id), async () => {
      const record = await this.record(id); await this.validateCurrent(record);
      if (expectedActionHash !== record.actionHash) throw new BridgeError("Bootstrap action hash mismatch");
      const approval = await this.approvals().read(record.requesterAlias, record.actionId);
      if (record.state === "PREPARED" && approval.status === "approved") {
        record.state = "AUTHORIZED"; await atomicWriteJson(this.recordPath(id), record); return this.summary(record);
      }
      if (record.state !== "PREPARED" || approval.status !== "requested") throw new BridgeError("Bootstrap cannot be authorized in its current state");
      await this.approvals().grant(record.requesterAlias, record.actionId, expectedActionHash);
      record.state = "AUTHORIZED"; await atomicWriteJson(this.recordPath(id), record); return this.summary(record);
    });
  }

  async send(id: string, expectedActionHash: string): Promise<ExternalBootstrapSummary> {
    return withFileLock(this.recordPath(id), async () => {
      const record = await this.record(id); await this.validateCurrent(record);
      if (record.state !== "AUTHORIZED" || expectedActionHash !== record.actionHash) throw new BridgeError("Exact bootstrap authorization required");
      if (Date.parse(record.expiresAt) <= this.clock().getTime()) throw new BridgeError("Bootstrap authorization expired; no POST made");
      const base = this.transport();
      const approvals = new GuardedBootstrapApprovals(resolve(this.directory, "approvals"), async (effect, actionId) => {
        const persisted = await this.record(id); await this.validateCurrent(persisted);
        if (hashValue(persisted) !== hashValue(record) || actionId !== record.actionId ||
          hashValue(effect) !== hashValue(effectFor(record))) throw new BridgeError("Bootstrap binding changed before nonce reservation");
      });
      const transport: TechnocoreTransport = {
        readRoomText: async () => { throw new BridgeError("Bootstrap send has no read authority"); },
        readRoomJson: async () => { throw new BridgeError("Bootstrap send has no read authority"); },
        sendSignedMessage: async (room, envelope) => {
          const persisted = await this.record(id); await this.validateCurrent(persisted);
          const approval = await approvals.read(record.requesterAlias, record.actionId);
          if (hashValue(persisted) !== hashValue(record) || approval.status !== "executing" ||
            approval.actionHash !== record.actionHash || room !== record.selectedPublicRoom ||
            envelope.did !== record.requesterDid || hashValue(envelope.text) !== record.transportPayloadHash) {
            throw new BridgeError("Bootstrap binding changed before dispatch");
          }
          record.state = "SENDING"; record.sendAttemptCount = 1; await atomicWriteJson(this.recordPath(id), record);
          const response = await base.sendSignedMessage(room, envelope);
          const posted = response.posted;
          if (!posted || !Number.isSafeInteger(posted.seq) || posted.seq < 1 || posted.from !== envelope.did ||
            String(posted.nonce) !== envelope.nonce || hashValue(posted.text) !== record.transportPayloadHash) {
            throw new AmbiguousSendError("Bootstrap receipt mismatch; no retry");
          }
          record.sentSeq = posted.seq; record.observation.since = posted.seq;
          record.observation.acknowledgedThrough = posted.seq;
          if (response.generation !== undefined) record.observation.generation = response.generation;
          await atomicWriteJson(this.recordPath(id), record); return response;
        },
      };
      try {
        const bridge = new SignedAgentBridge({ ...this.stores, approvals }, transport);
        await bridge.sendSignedToRoom(record.requesterAlias, record.selectedPublicRoom, record.requestText, record.actionId);
        record.state = "SENT"; await atomicWriteJson(this.recordPath(id), record);
        record.state = "AWAITING_RESPONSE"; await atomicWriteJson(this.recordPath(id), record);
      } catch (error) {
        const diagnostics = outboundDiagnostics(error);
        if (diagnostics) record.deliveryDiagnostics = diagnostics;
        if (record.sendAttemptCount === 0) record.state = "REJECTED";
        else record.state = error instanceof SignedPostRejectedError || diagnostics?.dispatchBegan === false
          ? "REJECTED" : "AMBIGUOUS_DELIVERY";
        await atomicWriteJson(this.recordPath(id), record);
      }
      return this.summary(record);
    });
  }

  private relevantMessage(message: RoomMessage, bootstrapId: string): boolean {
    return message.text.includes(bootstrapId);
  }

  private retained(message: RoomMessage): RetainedBootstrapMessage {
    const omitted = privateCapability(message.text);
    return { seq: message.seq, ts: message.ts, senderDid: message.from,
      messageHash: hashValue({ seq: message.seq, did: message.from, text: message.text, nonce: message.nonce }),
      contentOmitted: omitted, ...(omitted ? {} : { text: message.text }),
      ...(message.nonce === undefined ? {} : { nonce: message.nonce }),
      ...(!omitted && message.sig !== undefined ? { signature: message.sig } : {}) };
  }

  private validateCheckpoint(checkpoint: BootstrapObservationCheckpoint, record: ExternalBootstrapRecord): void {
    if (!checkpoint || checkpoint.version !== 1 || checkpoint.bootstrapId !== record.bootstrapId ||
      checkpoint.roomHash !== hashValue(record.selectedPublicRoom) || checkpoint.previousCursor !== record.observation.since ||
      !Number.isSafeInteger(checkpoint.lastSeq) || checkpoint.lastSeq < 0 || checkpoint.firstSeq !== null &&
      (!Number.isSafeInteger(checkpoint.firstSeq) || checkpoint.firstSeq < 1) || checkpoint.lastReturnedSeq !== null &&
      (!Number.isSafeInteger(checkpoint.lastReturnedSeq) || checkpoint.lastReturnedSeq < 1) ||
      !Array.isArray(checkpoint.matchingMessages) || checkpoint.matchingMessages.length > 16 || !isTimestamp(checkpoint.observedAt)) {
      throw new BridgeError("Invalid bootstrap observation checkpoint");
    }
    if (typeof checkpoint.matchingOverflow !== "boolean") throw new BridgeError("Invalid bootstrap observation checkpoint");
  }

  private async verifyResponse(message: RetainedBootstrapMessage, record: ExternalBootstrapRecord): Promise<{
    envelope: ExternalBootstrapResponseEnvelope; state: "ACCEPTED_EVIDENCE" | "REJECTED";
    failureCode?: string; routeHash: string; ownedVerification?: PublicOwnedRouteVerification;
  }> {
    if (message.contentOmitted) throw new BridgeError("private-capability-in-public-response");
    if (message.senderDid !== record.targetDid) throw new BridgeError("wrong-sender-did");
    if (!message.text || message.signature === undefined || message.nonce === undefined || sanitizeText(message.text) !== message.text ||
      !verifySignedMessage(record.selectedPublicRoom, { did: message.senderDid, signature: message.signature,
        nonce: String(message.nonce), sanitizedText: message.text })) throw new BridgeError("invalid-or-missing-local-signature");
    let parsed: unknown;
    try { parsed = JSON.parse(message.text); } catch { throw new BridgeError("malformed-response-json"); }
    if (safePeerText(parsed, 4096) !== message.text || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new BridgeError("noncanonical-response-schema");
    }
    const value = parsed as Record<string, unknown>;
    const allowed = new Set(["version", "kind", "bootstrapId", "challengeId", "requesterDid", "responderDid",
      "accepted", "acceptedRequestSchemas", "acceptedResultSchemas", "responseMode", "responseRoute", "endpointHash",
      "createdAt", "expiresAt"]);
    if (Object.keys(value).some(key => !allowed.has(key)) || value.version !== 1 || value.kind !== "external-bootstrap-response" ||
      value.bootstrapId !== record.bootstrapId || value.challengeId !== record.challengeId ||
      value.requesterDid !== record.requesterDid || value.responderDid !== record.targetDid || typeof value.accepted !== "boolean" ||
      value.responseMode !== record.proposedResponseMode || !isTimestamp(value.createdAt) || !isTimestamp(value.expiresAt) ||
      Date.parse(value.createdAt as string) < Date.parse(record.createdAt) || Date.parse(value.createdAt as string) > this.clock().getTime() + 60_000 ||
      Date.parse(value.expiresAt as string) <= this.clock().getTime() || Date.parse(value.expiresAt as string) > Date.parse(record.expiresAt) ||
      Date.parse(value.expiresAt as string) <= Date.parse(value.createdAt as string) ||
      record.challengeConsumedAt !== undefined) throw new BridgeError("invalid-response-correlation-or-freshness");
    const acceptedRequests = schemas(value.acceptedRequestSchemas, "accepted request schemas", true);
    const acceptedResults = schemas(value.acceptedResultSchemas, "accepted result schemas", true);
    if (!value.accepted) {
      if (value.responseRoute !== undefined || value.endpointHash !== undefined) throw new BridgeError("declined-response-cannot-nominate-route");
      return { envelope: structuredClone(value) as unknown as ExternalBootstrapResponseEnvelope, state: "REJECTED",
        failureCode: "target-declined", routeHash: hashValue({ type: "declined", responseMode: value.responseMode }) };
    }
    let route: PublicOwnedRoomDescriptor | undefined;
    let routeHash: string;
    let ownedVerification: PublicOwnedRouteVerification | undefined;
    if (value.responseMode === "same-public-room") {
      if (value.responseRoute !== undefined || value.endpointHash !== undefined) throw new BridgeError("same-room-route-substitution");
      routeHash = hashValue({ type: "same-public-room", room: record.selectedPublicRoom });
    } else {
      route = validatePublicOwnedRoute(value.responseRoute, record.targetDid);
      routeHash = hashValue(route);
      if (value.endpointHash !== routeHash || record.proposedResponseRoute && hashValue(record.proposedResponseRoute) !== routeHash) {
        throw new BridgeError("public-owned-route-substitution");
      }
      ownedVerification = await this.options.verifyPublicOwnedRoute?.(route, {
        requesterDid: record.requesterDid, targetDid: record.targetDid, bootstrapId: record.bootstrapId,
      });
      if (!ownedVerification || !isHash(ownedVerification.ownerMetadataHash) || !isHash(ownedVerification.allowListHash) ||
        ownedVerification.ownerDid !== record.targetDid || ownedVerification.allowedRequesterDid !== record.requesterDid ||
        !isTimestamp(ownedVerification.verifiedAt)) throw new BridgeError("public-owned-route-verification-required");
    }
    const envelope = structuredClone(value) as unknown as ExternalBootstrapResponseEnvelope;
    const sharedRequests = acceptedRequests.filter(schema => record.supportedRequestSchemas.includes(schema));
    const sharedResults = acceptedResults.filter(schema => record.supportedResultSchemas.includes(schema));
    if (!sharedRequests.length || !sharedResults.length || sharedRequests.length !== acceptedRequests.length ||
      sharedResults.length !== acceptedResults.length) return { envelope, state: "REJECTED", failureCode: "schema-mismatch", routeHash,
      ...(ownedVerification ? { ownedVerification } : {}) };
    return { envelope, state: "ACCEPTED_EVIDENCE", routeHash, ...(ownedVerification ? { ownedVerification } : {}) };
  }

  private async advanceCursor(record: ExternalBootstrapRecord, checkpoint: BootstrapObservationCheckpoint): Promise<void> {
    const next = checkpoint.lastReturnedSeq ?? checkpoint.previousCursor;
    if (next < record.observation.acknowledgedThrough) throw new BridgeError("Bootstrap observation cursor regression");
    await this.options.beforeCursorAdvance?.(structuredClone(record), next);
    record.observation.acknowledgedThrough = next;
    await atomicWriteJson(this.recordPath(record.bootstrapId), record);
  }

  private async completePendingCursor(record: ExternalBootstrapRecord): Promise<boolean> {
    if (!record.observation.checkpointRef || !record.observation.checkpointHash) return false;
    const checkpoint = await readJsonFile<BootstrapObservationCheckpoint | null>(record.observation.checkpointRef, null);
    if (!checkpoint || hashValue(checkpoint) !== record.observation.checkpointHash) throw new BridgeError("Bootstrap observation evidence changed");
    this.validateCheckpoint(checkpoint, record);
    const expected = checkpoint.lastReturnedSeq ?? checkpoint.previousCursor;
    if (record.observation.acknowledgedThrough < expected) {
      await this.advanceCursor(record, checkpoint);
      if (record.response && !record.response.acknowledged) {
        record.response.acknowledged = true;
        await atomicWriteJson(this.recordPath(record.bootstrapId), record);
      }
      return true;
    }
    if (record.response && !record.response.acknowledged) {
      record.response.acknowledged = true;
      await atomicWriteJson(this.recordPath(record.bootstrapId), record);
      return true;
    }
    return false;
  }

  private async processCheckpoint(record: ExternalBootstrapRecord, checkpoint: BootstrapObservationCheckpoint,
    checkpointRef: string): Promise<void> {
    this.validateCheckpoint(checkpoint, record);
    const checkpointHash = hashValue(checkpoint);
    record.observation.checkpointRef = checkpointRef; record.observation.checkpointHash = checkpointHash;
    const generationMismatch = record.observation.generation !== undefined &&
      (checkpoint.generation === undefined || checkpoint.generation !== record.observation.generation);
    const retentionGap = checkpoint.firstSeq !== null && checkpoint.firstSeq > checkpoint.previousCursor + 1;
    const windowIncomplete = checkpoint.lastReturnedSeq !== null && checkpoint.lastReturnedSeq < checkpoint.lastSeq;
    if (generationMismatch || retentionGap || windowIncomplete || checkpoint.matchingOverflow || checkpoint.matchingMessages.length > 1) {
      const message = checkpoint.matchingMessages[0];
      record.state = "INVALID_RESPONSE";
      record.response = { checkpointRef, checkpointHash, seq: message?.seq ?? checkpoint.lastReturnedSeq ?? checkpoint.previousCursor + 1,
        senderDid: message?.senderDid ?? record.targetDid,
        messageHash: message?.messageHash ?? hashValue({ bootstrapId: record.bootstrapId, checkpointHash }),
        locallyVerified: false, failureCode: generationMismatch ? "room-generation-mismatch" : retentionGap ? "retention-gap" :
          windowIncomplete ? "incomplete-observation-window" : "conflicting-or-replayed-response", receivedAt: this.now(), acknowledged: false };
      await atomicWriteJson(this.recordPath(record.bootstrapId), record);
      await this.advanceCursor(record, checkpoint); record.response.acknowledged = true;
      await atomicWriteJson(this.recordPath(record.bootstrapId), record); return;
    }
    const message = checkpoint.matchingMessages[0];
    if (!message) {
      await atomicWriteJson(this.recordPath(record.bootstrapId), record);
      await this.advanceCursor(record, checkpoint); return;
    }
    try {
      const result = await this.verifyResponse(message, record);
      record.response = { checkpointRef, checkpointHash, seq: message.seq, senderDid: message.senderDid,
        messageHash: message.messageHash, ...(message.signature ? { signatureHash: hashValue(message.signature) } : {}),
        locallyVerified: true, accepted: result.envelope.accepted,
        agreedRequestSchemas: [...result.envelope.acceptedRequestSchemas], agreedResultSchemas: [...result.envelope.acceptedResultSchemas],
        responseMode: result.envelope.responseMode, routeHash: result.routeHash,
        ...(result.failureCode ? { failureCode: result.failureCode } : {}), receivedAt: this.now(), acknowledged: false };
      record.acceptedResponse = result.envelope; record.challengeConsumedAt = this.now();
      if (result.ownedVerification) record.publicOwnedRouteVerification = result.ownedVerification;
      record.state = result.state;
    } catch (error) {
      const code = error instanceof BridgeError && /^[a-z0-9-]+$/u.test(error.message) ? error.message : "invalid-bootstrap-response";
      record.response = { checkpointRef, checkpointHash, seq: message.seq, senderDid: message.senderDid,
        messageHash: message.messageHash, ...(message.signature ? { signatureHash: hashValue(message.signature) } : {}),
        locallyVerified: false, failureCode: code, receivedAt: this.now(), acknowledged: false };
      record.state = "INVALID_RESPONSE";
    }
    await atomicWriteJson(this.recordPath(record.bootstrapId), record);
    await this.advanceCursor(record, checkpoint); record.response.acknowledged = true;
    await atomicWriteJson(this.recordPath(record.bootstrapId), record);
  }

  async receive(id: string): Promise<ExternalBootstrapSummary> {
    return withFileLock(this.recordPath(id), async () => {
      const record = await this.record(id); await this.validateCurrent(record);
      if (await this.completePendingCursor(record)) return this.summary(record);
      if (terminal.has(record.state)) return this.summary(record);
      if (record.state === "SENT" && record.sentSeq !== undefined) {
        const approval = await this.approvals().read(record.requesterAlias, record.actionId);
        if (approval.status !== "confirmed") throw new BridgeError("Confirmed bootstrap send evidence is incomplete");
        record.state = "AWAITING_RESPONSE"; await atomicWriteJson(this.recordPath(id), record);
      }
      if (record.state !== "AWAITING_RESPONSE") throw new BridgeError("Bootstrap is not awaiting a response");
      if (Date.parse(record.expiresAt) <= this.clock().getTime()) throw new BridgeError("Bootstrap deadline elapsed; use timeout without a new GET");
      if (record.observation.readAttempts >= 1) return this.summary(record);
      const checkpointRef = this.checkpointPath(id);
      let checkpoint = await readJsonFile<BootstrapObservationCheckpoint | null>(checkpointRef, null);
      if (!checkpoint) {
        record.observation.readAttempts = 1; record.observation.readStartedAt = this.now();
        await atomicWriteJson(this.recordPath(id), record);
        let readCompleted = false;
        try {
          const view = await this.transport().readRoomJson(record.selectedPublicRoom,
            { since: record.observation.since, wait: 0, limit: 200 });
          readCompleted = true;
          const relevant = view.messages.filter(message => this.relevantMessage(message, id));
          const matching = relevant.slice(0, 16).map(message => this.retained(message));
          checkpoint = { version: 1, bootstrapId: id, roomHash: hashValue(record.selectedPublicRoom),
            previousCursor: record.observation.since, firstSeq: view.first_seq, lastSeq: view.last_seq,
            lastReturnedSeq: view.messages.at(-1)?.seq ?? null,
            ...(view.generation === undefined ? {} : { generation: view.generation }), matchingMessages: matching,
            matchingOverflow: relevant.length > 16, observedAt: this.now() };
          await atomicCreateJson(checkpointRef, checkpoint);
        } catch (error) {
          record.observation.readFailure = readCompleted ? "persistence-failed" : "transport-failed";
          await atomicWriteJson(this.recordPath(id), record); throw error;
        }
      }
      await this.processCheckpoint(record, checkpoint, checkpointRef);
      return this.summary(record);
    });
  }

  async timeout(id: string): Promise<ExternalBootstrapSummary> {
    return withFileLock(this.recordPath(id), async () => {
      const record = await this.record(id); await this.validateCurrent(record);
      if (terminal.has(record.state)) return this.summary(record);
      if (record.state !== "AWAITING_RESPONSE" || record.observation.readAttempts !== 1 ||
        Date.parse(record.expiresAt) > this.clock().getTime()) {
        throw new BridgeError("NO_RESPONSE requires an elapsed deadline and one spent bounded observation");
      }
      record.state = "NO_RESPONSE"; await atomicWriteJson(this.recordPath(id), record); return this.summary(record);
    });
  }

  async proposal(id: string): Promise<ExternalBootstrapPromotionProposal> {
    return withFileLock(this.recordPath(id), async () => {
      const record = await this.record(id); await this.validateCurrent(record);
      if (record.state !== "ACCEPTED_EVIDENCE" || !record.response?.locallyVerified ||
        !record.response.accepted || !record.acceptedResponse || !record.response.routeHash) {
        throw new BridgeError("A locally verified accepted bootstrap response is required for a promotion proposal");
      }
      const path = this.proposalPath(id);
      const existing = await readJsonFile<ExternalBootstrapPromotionProposal | null>(path, null);
      if (existing) {
        const expectedId = hashValue({ bootstrapId: id, evidenceHash: record.response.messageHash,
          routeHash: record.response.routeHash });
        if (existing.version !== 1 || existing.kind !== "external-bootstrap-promotion-proposal" ||
          existing.proposalId !== expectedId || existing.bootstrapId !== id || existing.candidateId !== record.candidateId ||
          existing.targetDid !== record.targetDid || existing.operatorReviewRequired !== true ||
          existing.createsContact !== false || existing.grantsAuthority !== false) {
          throw new BridgeError("Existing bootstrap proposal does not match current evidence");
        }
        record.promotionProposalRef = path; record.promotionProposalHash = hashValue(existing);
        await atomicWriteJson(this.recordPath(id), record);
        return structuredClone(existing);
      }
      const response = record.acceptedResponse;
      const proposal: ExternalBootstrapPromotionProposal = { version: 1, kind: "external-bootstrap-promotion-proposal",
        proposalId: hashValue({ bootstrapId: id, evidenceHash: record.response.messageHash, routeHash: record.response.routeHash }),
        bootstrapId: id, candidateId: record.candidateId, targetDid: record.targetDid,
        verifiedBootstrapEvidenceHash: hashValue({ discoveryEvidenceHash: record.discoveryEvidence.evidenceHash,
          requestPayloadHash: record.requestPayloadHash, responseMessageHash: record.response.messageHash,
          signatureHash: record.response.signatureHash, challengeId: record.challengeId }),
        selectedPublicRoom: record.selectedPublicRoom,
        agreedRequestSchemas: [...record.response.agreedRequestSchemas!], agreedResultSchemas: [...record.response.agreedResultSchemas!],
        agreedResponseMode: response.responseMode, ...(response.responseRoute ? { responseRoute: response.responseRoute } : {}),
        routeHash: record.response.routeHash,
        freshnessEvidence: { responseCreatedAt: response.createdAt, responseExpiresAt: response.expiresAt,
          observedAt: record.response.receivedAt, seq: record.response.seq },
        ...(record.publicOwnedRouteVerification ? { publicOwnedRouteVerification: record.publicOwnedRouteVerification } : {}),
        warnings: ["Quarantined evidence only; this is not a contact or trust grant",
          "Public-room reachability is best-effort and content remains public",
          "Operator must independently review the endpoint and schema agreement"],
        operatorReviewRequired: true, createsContact: false, grantsAuthority: false, createdAt: this.now() };
      await atomicCreateJson(path, proposal);
      record.promotionProposalRef = path; record.promotionProposalHash = hashValue(proposal);
      await atomicWriteJson(this.recordPath(id), record);
      return structuredClone(proposal);
    });
  }
}
