import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { cp, readFile } from "node:fs/promises";
import { Socket } from "node:net";
import { resolve } from "node:path";
import { createStores } from "../src/context.js";
import { SignedAgentBridge } from "../src/bridge.js";
import { AmbiguousSendError, BridgeError } from "../src/errors.js";
import { atomicWriteJson, readJsonFile } from "../src/fs-safe.js";
import { signMessage } from "../src/protocol.js";
import { SignedPostRejectedError } from "../src/send-diagnostics.js";
import { AgentRoleStore } from "../src/agent/roles.js";
import { initializeAgent } from "../src/agent/runtime.js";
import { DeterministicInferenceProvider } from "../src/agent/inference.js";
import type { InferenceProvider } from "../src/agent/types.js";
import { hashValue } from "../src/agent/util.js";
import { safePeerText } from "../src/swarm/proposal.js";
import { PEER_ROLES, peerAliases } from "../src/swarm/session-policy.js";
import { OutboundExternalWorkCoordinator, technocoreContractExtractionTemplate,
  type ExternalWorkResultEnvelope, type OutboundExternalWorkJob,
  type PrepareOutboundExternalWork } from "../src/swarm/outbound-external-work.js";
import type { ReadRoomOptions, RoomResponse, SignedMessageEnvelope, TechnocoreTransport } from "../src/types.js";
import { generatedPassphraseProvider, temporaryDirectory } from "./helpers.js";

const secrets = generatedPassphraseProvider();
let template: Awaited<ReturnType<typeof temporaryDirectory>>;
let externalDid: string;
let candidateDid: string;
let networkAttempts = 0;
const originalConnect = Socket.prototype.connect;

before(async () => {
  Socket.prototype.connect = function () { networkAttempts++; throw new Error("Live network forbidden in external-work tests"); } as typeof Socket.prototype.connect;
  template = await temporaryDirectory();
  const stores = createStores(template.path, secrets.provider);
  for (const alias of peerAliases) {
    const identity = await stores.identities.create(alias);
    await stores.mailboxes.create(alias, identity.did);
    await new AgentRoleStore(resolve(template.path, "agents", alias)).assign(identity, PEER_ROLES[alias]);
    if (alias === "bob" || alias === "dave") await initializeAgent({ identityAlias: alias, root: template.path, passphrases: secrets.provider });
  }
  const external = await stores.identities.create("externalfixture"); externalDid = external.did;
  const externalMailbox = await stores.mailboxes.create("externalfixture", external.did);
  await stores.contacts.add("bob", "externalx", external.did, externalMailbox.room);
  candidateDid = (await stores.identities.create("candidatefixture")).did;
});

after(async () => {
  Socket.prototype.connect = originalConnect;
  secrets.cleanup(); await template.cleanup(); assert.equal(networkAttempts, 0);
});

type Failure = "429" | "400" | "timeout" | "503" | "reset" | "malformed";
class FixtureTransport implements TechnocoreTransport {
  posts = 0; reads = 0; failure?: Failure; response?: RoomResponse;
  async readRoomText(): Promise<string> { throw new BridgeError("Text read forbidden"); }
  async readRoomJson(_room: string, options: ReadRoomOptions = {}): Promise<RoomResponse> {
    this.reads++;
    assert.equal(options.wait, 0); assert.equal(options.limit, 200);
    return structuredClone(this.response ?? { count: 0, first_seq: null, last_seq: options.since ?? 0, messages: [] });
  }
  async sendSignedMessage(_room: string, envelope: SignedMessageEnvelope): Promise<RoomResponse> {
    this.posts++;
    const refusal = (status: number) => new SignedPostRejectedError({ stage: "response-status", endpoint: "[REDACTED]",
      headersReceived: true, timedOut: false, status, contentType: "text/plain", bodyStarted: true });
    if (this.failure === "429") throw refusal(429);
    if (this.failure === "400") throw refusal(400);
    if (this.failure === "timeout") throw new AmbiguousSendError("Synthetic timeout", { stage: "request", endpoint: "[REDACTED]", headersReceived: false, timedOut: true });
    if (this.failure === "503") throw new AmbiguousSendError("Synthetic 503", { stage: "response-status", endpoint: "[REDACTED]", headersReceived: true, timedOut: false, status: 503 });
    if (this.failure === "reset") throw Object.assign(new Error("Synthetic reset"), { code: "ECONNRESET" });
    if (this.failure === "malformed") return { count: 0, first_seq: null, last_seq: 0, messages: [] };
    return { count: 1, first_seq: 1, last_seq: 1, messages: [], posted: {
      seq: 1, ts: "2026-09-05T00:00:00Z", from: envelope.did, text: envelope.text, nonce: envelope.nonce } };
  }
}

function reviewProvider(outcome: "VOUCH" | "REJECT" | "REVISION_REQUIRED"): DeterministicInferenceProvider {
  return new DeterministicInferenceProvider(() => ({ outcome: "success", output: {
    outcome, findings: ["The supplied result and correlation evidence were assessed"],
    independentlyChecked: outcome === "VOUCH" ? ["supplied-result-hash"] : [],
    unresolved: outcome === "VOUCH" ? [] : ["External quality remains insufficient"],
    confidence: outcome === "VOUCH" ? "high" : "medium",
  }, metadata: { provider: "deterministic-local", model: "review-fixture-v1", latencyMs: 0, usage: { requests: "1" } } }));
}

async function fixture(outcome: "VOUCH" | "REJECT" | "REVISION_REQUIRED" = "VOUCH") {
  const tmp = await temporaryDirectory(); await cp(template.path, tmp.path, { recursive: true });
  const transport = new FixtureTransport();
  let now = Date.parse("2026-09-05T10:00:00Z");
  const provider = reviewProvider(outcome);
  const options = { root: tmp.path, passphrases: secrets.provider, offlineTransport: transport,
    reviewInference: provider as InferenceProvider, clock: () => new Date(now) };
  return { tmp, stores: createStores(tmp.path, secrets.provider), transport, provider, options,
    coordinator: new OutboundExternalWorkCoordinator(options), now: () => now, advance: (ms: number) => { now += ms; } };
}

function request(overrides: Partial<PrepareOutboundExternalWork> = {}, now = Date.parse("2026-09-05T10:00:00Z")): PrepareOutboundExternalWork {
  const task = technocoreContractExtractionTemplate([
    "Signed writes use POST with did, sig, nonce and text.",
    "Room reads return retained messages and sequence metadata.",
  ]);
  return { requestId: "contract-extraction-1", requesterAlias: "bob", targetDid: externalDid, contactId: "externalx",
    ...task, responseDeadline: new Date(now + 60 * 60 * 1000).toISOString(),
    responseRouteEvidenceHash: hashValue("operator-confirmed-reciprocal-route"),
    schemaAgreementHash: hashValue("operator-confirmed-peer-work-v1"), ...overrides };
}

function jobPath(root: string, id: string): string { return resolve(root, "external-work", "jobs", `${id}.json`); }
async function job(root: string, id: string): Promise<OutboundExternalWorkJob> {
  return readJsonFile<OutboundExternalWorkJob>(jobPath(root, id), null as never);
}
async function prepared(f: Awaited<ReturnType<typeof fixture>>, overrides: Partial<PrepareOutboundExternalWork> = {}) {
  return f.coordinator.prepare(request(overrides, f.now()));
}
async function sent(f: Awaited<ReturnType<typeof fixture>>) {
  const p = await prepared(f); await f.coordinator.authorize(p.outboundJobId, p.actionHash);
  const result = await f.coordinator.send(p.outboundJobId, p.actionHash);
  assert.equal(result.state, "AWAITING_RESPONSE"); return result;
}

function researchOutput() {
  return { answer: "Three invariants and three limitations were extracted from the supplied excerpts.",
    keyClaims: ["Signed writes use POST", "The signed body binds a DID", "Reads expose sequence metadata"],
    confidence: { level: "medium" as const, rationale: "Only supplied excerpts were used" },
    limitations: ["Deployment behavior is not covered", "Retention completeness is unknown", "No live request was made"],
    suggestedFollowUp: ["Compare against a pinned source revision"] };
}

async function installResponse(f: Awaited<ReturnType<typeof fixture>>, id: string, overrides: Record<string, unknown> = {},
  options: { alias?: "externalfixture" | "candidatefixture"; signature?: "missing" | "invalid"; duplicate?: boolean } = {}) {
  const current = await job(f.tmp.path, id), output = researchOutput();
  const envelope: ExternalWorkResultEnvelope = { version: 1, kind: "external-work-result", requestId: current.requestId,
    requesterDid: current.requesterDid, responderDid: current.targetDid, workloadType: current.workloadType,
    workloadVersion: 1, requestPayloadHash: current.requestPayloadHash, status: "completed", output,
    resultHash: hashValue(output), createdAt: new Date(f.now() + 1000).toISOString(), ...overrides } as ExternalWorkResultEnvelope;
  const text = safePeerText(envelope, 4096), alias = options.alias ?? "externalfixture";
  const signer = await f.stores.identities.unlock(alias), mailbox = await f.stores.mailboxes.load("bob");
  const signed = signMessage(signer, mailbox.room, 1, text);
  const first = { seq: 1, ts: new Date(f.now() + 1000).toISOString(), from: signer.did, text,
    nonce: 1, ...(options.signature === "missing" ? {} : { sig: options.signature === "invalid" ? "A".repeat(86) : signed.signature }) };
  const messages = [first];
  if (options.duplicate) {
    const second = signMessage(signer, mailbox.room, 2, text);
    messages.push({ ...first, seq: 2, nonce: 2, sig: second.signature });
  }
  f.transport.response = { count: messages.length, first_seq: 1, last_seq: messages.length, messages };
}

async function immutableHash(root: string): Promise<string> {
  const rows: string[] = [];
  for (const directory of ["identities", "mailboxes", "contacts"]) {
    const names = (await import("node:fs/promises")).readdir(resolve(root, directory));
    for (const name of (await names).sort()) rows.push(`${directory}/${name}:${hashValue(await readFile(resolve(root, directory, name), "utf8"))}`);
  }
  return hashValue(rows);
}

test("prepare binds existing contact, request, response route and exact authority without sending", async () => {
  const f = await fixture(); try {
    const before = await immutableHash(f.tmp.path), p = await prepared(f);
    assert.equal(p.state, "PREPARED"); assert.equal(p.postAttempts, 0); assert.equal(p.readAttempts, 0);
    assert.match(p.actionHash, /^[a-f0-9]{64}$/); assert.match(p.destinationHash, /^[a-f0-9]{64}$/);
    const stored = await job(f.tmp.path, p.outboundJobId);
    assert.equal(stored.requestEnvelope.requestPayloadHash, p.requestPayloadHash);
    assert.equal(stored.actionHash, hashValue({ actionId: stored.actionId, agentAlias: "bob", agentDid: stored.requesterDid,
      type: "technocore.send-contact", destinationHash: stored.destinationHash, payloadHash: stored.transportPayloadHash }));
    assert.equal(f.transport.posts, 0); assert.equal(await immutableHash(f.tmp.path), before);
  } finally { await f.tmp.cleanup(); }
});

test("a discovery-only DID cannot become a contact or outbound target", async () => {
  const f = await fixture(); try {
    await atomicWriteJson(resolve(f.tmp.path, ".technocore-discovery", "candidate.json"), { did: candidateDid, trust: "untrusted-discovery-only" });
    assert.equal(await f.stores.contacts.findByDid("bob", candidateDid), undefined);
    await assert.rejects(prepared(f, { targetDid: candidateDid, contactId: "candidatefixture" }), /does not exist/);
    assert.equal(await f.stores.contacts.findByDid("bob", candidateDid), undefined); assert.equal(f.transport.posts, 0);
  } finally { await f.tmp.cleanup(); }
});

test("wrong target/contact DID fails closed", async () => {
  const f = await fixture(); try {
    await assert.rejects(prepared(f, { targetDid: candidateDid }), /target\/contact/); assert.equal(f.transport.posts, 0);
  } finally { await f.tmp.cleanup(); }
});

test("authorization is separate and payload mutation invalidates it", async () => {
  const f = await fixture(); try {
    const p = await prepared(f); const stored = await job(f.tmp.path, p.outboundJobId);
    stored.requestText = `${stored.requestText} changed`; await atomicWriteJson(jobPath(f.tmp.path, p.outboundJobId), stored);
    await assert.rejects(f.coordinator.authorize(p.outboundJobId, p.actionHash), /binding changed/);
    assert.equal(f.transport.posts, 0);
  } finally { await f.tmp.cleanup(); }
});

test("destination mutation after authorization prevents nonce reservation and POST", async () => {
  const f = await fixture(); try {
    const p = await prepared(f); await f.coordinator.authorize(p.outboundJobId, p.actionHash);
    await f.stores.contacts.add("bob", "externalx", externalDid, `mb-p-${"a".repeat(40)}`);
    await assert.rejects(f.coordinator.send(p.outboundJobId, p.actionHash), /binding changed/);
    assert.equal(f.transport.posts, 0);
  } finally { await f.tmp.cleanup(); }
});

test("successful request uses exactly one physical POST and restart cannot resend it", async () => {
  const f = await fixture(); try {
    const p = await sent(f); assert.equal(f.transport.posts, 1); assert.equal(p.postAttempts, 1);
    const restarted = new OutboundExternalWorkCoordinator(f.options);
    await assert.rejects(restarted.send(p.outboundJobId, p.actionHash), /authorization required/);
    assert.equal(f.transport.posts, 1);
  } finally { await f.tmp.cleanup(); }
});

for (const failure of ["429", "400", "timeout", "503", "reset", "malformed"] as Failure[]) {
  test(`${failure} produces a terminal one-POST delivery outcome with no resend`, async () => {
    const f = await fixture(); try {
      f.transport.failure = failure; const p = await prepared(f); await f.coordinator.authorize(p.outboundJobId, p.actionHash);
      const result = await f.coordinator.send(p.outboundJobId, p.actionHash);
      assert.equal(result.state, failure === "429" || failure === "400" ? "DELIVERY_REJECTED" : "AMBIGUOUS_DELIVERY");
      assert.equal(result.postAttempts, 1); assert.equal(f.transport.posts, 1);
      await assert.rejects(f.coordinator.send(p.outboundJobId, p.actionHash)); assert.equal(f.transport.posts, 1);
    } finally { await f.tmp.cleanup(); }
  });
}

test("empty bounded observation transitions to NO_RESPONSE only after the deadline", async () => {
  const f = await fixture(); try {
    const p = await sent(f); const observed = await f.coordinator.receive(p.outboundJobId);
    assert.equal(observed.state, "AWAITING_RESPONSE"); assert.equal(observed.readAttempts, 1); assert.equal(f.transport.reads, 1);
    assert.equal((await f.coordinator.receive(p.outboundJobId)).state, "AWAITING_RESPONSE"); assert.equal(f.transport.reads, 1);
    f.advance(61 * 60 * 1000); const timedOut = await f.coordinator.timeout(p.outboundJobId);
    assert.equal(timedOut.state, "NO_RESPONSE"); assert.equal(f.transport.posts, 1);
  } finally { await f.tmp.cleanup(); }
});

test("valid signed response is retained, locally verified, linked and ACKed before Dave review", async () => {
  const f = await fixture(); try {
    const p = await sent(f); await installResponse(f, p.outboundJobId);
    let orderingChecked = false;
    const coordinator = new OutboundExternalWorkCoordinator({ ...f.options, beforeAcknowledge: async (current, seq) => {
      const persisted = await job(f.tmp.path, current.outboundJobId);
      assert.equal(persisted.state, "REVIEW_PENDING"); assert.equal(persisted.response?.locallyVerified, true);
      assert.equal(seq, 1); assert.equal(await f.stores.cursors.get("bob", (await f.stores.mailboxes.load("bob")).room), 0);
      orderingChecked = true;
    } });
    const received = await coordinator.receive(p.outboundJobId);
    assert.equal(received.state, "REVIEW_PENDING"); assert.equal(received.response?.locallyVerified, true);
    assert.equal(orderingChecked, true); assert.equal(await f.stores.cursors.get("bob", (await f.stores.mailboxes.load("bob")).room), 1);
    assert.equal(JSON.stringify(received).includes('"signature":'), false);
  } finally { await f.tmp.cleanup(); }
});

test("normal inbox output omits an optional retained signature", async () => {
  const f = await fixture(); try {
    const p = await sent(f); await installResponse(f, p.outboundJobId);
    assert.equal(typeof f.transport.response!.messages[0]!.sig, "string");
    const visible = await new SignedAgentBridge(f.stores, f.transport).readInbox("bob");
    assert.equal(visible.length, 1); assert.equal("signature" in visible[0]!, false);
  } finally { await f.tmp.cleanup(); }
});

test("crash between response linkage and ACK completes from retained data without a second GET", async () => {
  const f = await fixture(); try {
    const p = await sent(f); await installResponse(f, p.outboundJobId);
    const crashing = new OutboundExternalWorkCoordinator({ ...f.options, beforeAcknowledge: async () => { throw new Error("synthetic crash"); } });
    await assert.rejects(crashing.receive(p.outboundJobId), /synthetic crash/);
    assert.equal((await job(f.tmp.path, p.outboundJobId)).state, "REVIEW_PENDING");
    assert.equal(await f.stores.cursors.get("bob", (await f.stores.mailboxes.load("bob")).room), 0);
    const recovered = await new OutboundExternalWorkCoordinator(f.options).receive(p.outboundJobId);
    assert.equal(recovered.state, "REVIEW_PENDING"); assert.equal(recovered.response?.acknowledged, true);
    assert.equal(f.transport.reads, 1); assert.equal(await f.stores.cursors.get("bob", (await f.stores.mailboxes.load("bob")).room), 1);
  } finally { await f.tmp.cleanup(); }
});

const invalidResponses: Array<[string, () => Record<string, unknown>, Parameters<typeof installResponse>[3]]> = [
  ["missing signature", () => ({}), { signature: "missing" }],
  ["invalid signature", () => ({}), { signature: "invalid" }],
  ["wrong DID", () => ({}), { alias: "candidatefixture" }],
  ["wrong request id", () => ({ requestId: "different-request" }), {}],
  ["wrong requester DID", () => ({ requesterDid: candidateDid }), {}],
  ["wrong responder DID", () => ({ responderDid: candidateDid }), {}],
  ["wrong workload", () => ({ workloadType: "workload.engineering" }), {}],
  ["wrong request payload hash", () => ({ requestPayloadHash: "0".repeat(64) }), {}],
  ["changed output with stale result hash", () => ({ output: { changed: true } }), {}],
  ["invalid completed output schema", () => ({ output: {}, resultHash: hashValue({}) }), {}],
  ["response created after deadline", () => ({ createdAt: "2026-09-05T12:00:00.000Z" }), {}],
];
for (const [name, overrides, options] of invalidResponses) {
  test(`${name} is durable INVALID_RESPONSE and never reaches review`, async () => {
    const f = await fixture(); try {
      const p = await sent(f); await installResponse(f, p.outboundJobId, overrides(), options);
      const result = await f.coordinator.receive(p.outboundJobId);
      assert.equal(result.state, "INVALID_RESPONSE"); assert.equal(result.response?.locallyVerified, false);
      assert.equal(await f.stores.cursors.get("bob", (await f.stores.mailboxes.load("bob")).room), 1);
      assert.equal((await f.coordinator.review(p.outboundJobId)).state, "INVALID_RESPONSE");
      assert.equal(f.provider.requests.length, 0);
    } finally { await f.tmp.cleanup(); }
  });
}

test("duplicate response window is rejected and cannot be replayed", async () => {
  const f = await fixture(); try {
    const p = await sent(f); await installResponse(f, p.outboundJobId, {}, { duplicate: true });
    const result = await f.coordinator.receive(p.outboundJobId);
    assert.equal(result.state, "INVALID_RESPONSE"); assert.equal(result.response?.failureCode, "invalid-window-or-duplicate");
    await assert.rejects(f.coordinator.receive(p.outboundJobId)); assert.equal(f.transport.reads, 1);
  } finally { await f.tmp.cleanup(); }
});

for (const [decision, expected] of [["VOUCH", "SUCCESS"], ["REJECT", "REJECTED_RESULT"], ["REVISION_REQUIRED", "REVISION_REQUIRED"]] as const) {
  test(`Dave ${decision} maps to ${expected} without another send`, async () => {
    const f = await fixture(decision); try {
      const p = await sent(f); await installResponse(f, p.outboundJobId); await f.coordinator.receive(p.outboundJobId);
      const result = await f.coordinator.review(p.outboundJobId);
      assert.equal(result.state, expected); assert.equal(result.review?.outcome, decision);
      assert.equal(f.transport.posts, 1); assert.equal(f.provider.requests.length, 1);
    } finally { await f.tmp.cleanup(); }
  });
}

test("restart after Dave completion neither reruns review nor reopens terminal work", async () => {
  const f = await fixture("VOUCH"); try {
    const p = await sent(f); await installResponse(f, p.outboundJobId); await f.coordinator.receive(p.outboundJobId);
    await f.coordinator.review(p.outboundJobId); assert.equal(f.provider.requests.length, 1);
    const unused = reviewProvider("REJECT");
    const restarted = new OutboundExternalWorkCoordinator({ ...f.options, reviewInference: unused });
    assert.equal((await restarted.review(p.outboundJobId)).state, "SUCCESS"); assert.equal(unused.requests.length, 0);
    await assert.rejects(restarted.receive(p.outboundJobId)); assert.equal(f.transport.reads, 1); assert.equal(f.transport.posts, 1);
  } finally { await f.tmp.cleanup(); }
});

test("restart after Dave task completion finalizes retained review evidence without rerunning inference", async () => {
  const f = await fixture("VOUCH"); try {
    const p = await sent(f); await installResponse(f, p.outboundJobId); await f.coordinator.receive(p.outboundJobId);
    const completed = await f.coordinator.review(p.outboundJobId); assert.equal(f.provider.requests.length, 1);
    const stored = await job(f.tmp.path, p.outboundJobId);
    stored.state = "REVIEW_PENDING"; stored.review = { taskId: completed.review!.taskId };
    await atomicWriteJson(jobPath(f.tmp.path, p.outboundJobId), stored);
    const unused = reviewProvider("REJECT");
    const recovered = await new OutboundExternalWorkCoordinator({ ...f.options, reviewInference: unused }).review(p.outboundJobId);
    assert.equal(recovered.state, "SUCCESS"); assert.equal(unused.requests.length, 0);
  } finally { await f.tmp.cleanup(); }
});

test("a persisted SENT state resumes response waiting offline and never posts again", async () => {
  const f = await fixture(); try {
    const p = await sent(f), stored = await job(f.tmp.path, p.outboundJobId);
    stored.state = "SENT"; await atomicWriteJson(jobPath(f.tmp.path, p.outboundJobId), stored);
    const resumed = await new OutboundExternalWorkCoordinator(f.options).receive(p.outboundJobId);
    assert.equal(resumed.state, "AWAITING_RESPONSE"); assert.equal(f.transport.posts, 1); assert.equal(f.transport.reads, 1);
  } finally { await f.tmp.cleanup(); }
});

test("late response cannot reopen a NO_RESPONSE job", async () => {
  const f = await fixture(); try {
    const p = await sent(f); await f.coordinator.receive(p.outboundJobId); f.advance(61 * 60 * 1000);
    assert.equal((await f.coordinator.timeout(p.outboundJobId)).state, "NO_RESPONSE");
    await installResponse(f, p.outboundJobId); await assert.rejects(f.coordinator.receive(p.outboundJobId));
    assert.equal((await f.coordinator.status(p.outboundJobId)).state, "NO_RESPONSE"); assert.equal(f.transport.reads, 1);
  } finally { await f.tmp.cleanup(); }
});

test("safe summaries and failures never expose capabilities, signatures or request bodies", async () => {
  const f = await fixture(); try {
    const p = await prepared(f), serialized = JSON.stringify(p);
    assert.equal(serialized.includes("mb-p-"), false); assert.equal(serialized.includes("signature"), false);
    assert.equal(serialized.includes("Signed writes use POST"), false);
    let message = ""; try { await f.coordinator.authorize(p.outboundJobId, "0".repeat(64)); } catch (error) { message = String(error); }
    assert.equal(message.includes("mb-p-"), false); assert.equal(message.includes("PRIVATE KEY"), false);
  } finally { await f.tmp.cleanup(); }
});
