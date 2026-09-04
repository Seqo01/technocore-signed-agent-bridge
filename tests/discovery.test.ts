import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Socket } from "node:net";
import { execFileSync } from "node:child_process";
import { publicKeyBytesToDid, signMessage } from "../src/protocol.js";
import { TechnocorePublicDiscoveryAdapter } from "../src/discovery/adapter.js";
import { DiscoveryStore } from "../src/discovery/store.js";
import { discoveryCommand } from "../src/discovery/cli.js";
import { HttpDiscoveryReadTransport, assertReadPath, type ReadReply, type DiscoveryReadTransport } from "../src/discovery/transport.js";
import { candidateId, compareCapabilities, defaults, didPaths, digest, DISCOVERY_ORIGIN, limits, publicRoom, safeTopic,
  type Limits } from "../src/discovery/model.js";
import { temporaryDirectory } from "./helpers.js";
import type { UnlockedIdentity } from "../src/types.js";

let liveRequests = 0;
const originalConnect = Socket.prototype.connect;
before(() => { Socket.prototype.connect = function () { liveRequests++; throw new Error("Offline discovery tests forbid sockets"); } as typeof originalConnect; });
after(() => { Socket.prototype.connect = originalConnect; assert.equal(liveRequests, 0); });
const t1 = "2026-01-01T00:00:00.000Z", t2 = "2026-01-02T00:00:00.000Z";
function identity(): UnlockedIdentity {
  const pair = generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey.export({ format: "jwk" });
  return { name: "fixture", did: publicKeyBytesToDid(Buffer.from(publicKey.x!, "base64url")), fingerprint: "fixture",
    createdAt: t1, privateKey: pair.privateKey, publicKeyPem: pair.publicKey.export({ format: "pem", type: "spki" }).toString() };
}
const agent = identity(), other = identity();
function message(who = agent, room = "lobby", seq = 1, text = '{"role":"research"}') {
  const signed = signMessage(who, room, String(seq), text);
  return { seq, ts: t1, from: who.did, text: signed.sanitizedText, nonce: signed.nonce, sig: signed.signature };
}
function reply(body: unknown, contentType = "application/json", status = 200): ReadReply {
  return { status, contentType, body: typeof body === "string" ? body : JSON.stringify(body) };
}
function window(room: string, messages: unknown[], extra = {}) {
  const seqs = messages.map(m => (m as { seq: number }).seq);
  return reply({ room, count: messages.length, first_seq: seqs[0] ?? null, last_seq: seqs.at(-1) ?? 0, generation: 1, messages, ...extra });
}
function note(value: unknown, footer = "") {
  return reply(`!! UNTRUSTED CONTENT — fixture banner\n\n${typeof value === "string" ? value : JSON.stringify(value)}${footer}\n`, "text/plain");
}
class Fake implements DiscoveryReadTransport {
  paths: string[] = [];
  constructor(public queue: ReadReply[]) {}
  async get(path: string, _signal: AbortSignal) { this.paths.push(path); return this.queue.shift() ?? reply("", "text/plain", 404); }
}
async function setup(queue: ReadReply[], bounds: Partial<Limits> = {}) {
  const dir = await temporaryDirectory(); const store = new DiscoveryStore(dir.path, bounds); const transport = new Fake(queue);
  let now = t1;
  const adapter = new TechnocorePublicDiscoveryAdapter(transport, store, bounds, () => now);
  return { ...dir, store, transport, adapter, clock: (time: string) => { now = time; } };
}

test("rooms retain safe topic metadata without claiming owner, DID, endorsement or auto-fetch", async () => {
  const f = await setup([reply({ rooms: [{ room: "research", topic: "Useful research" }] })]);
  try {
    const r = await f.adapter.discoverRooms(); assert.equal(r.rooms.length, 1);
    assert.equal((await f.store.observations())[0]!.topic, "Useful research");
    assert.equal((await f.store.observations())[0]!.trustClassification, "untrusted-discovery-only");
    assert.deepEqual(await f.store.listCandidates(), []); assert.equal(f.transport.paths.length, 1);
  } finally { await f.cleanup(); }
});
test("all private, mailbox and encrypted room classes are refused, including composed/embedded p", async () => {
  const names = ["p-hidden", "mb-p-hidden", "d-p-hidden", "e-p-hidden", "mb-public", "e-public", "foo-p-hidden"];
  const f = await setup([reply({ rooms: names.map(room => ({ room, topic: "ignored" })) })]);
  try {
    assert.equal((await f.adapter.discoverRooms()).skipped, names.length);
    assert.equal((await f.store.observations()).length, 0);
    for (const room of names) { assert.equal(publicRoom(room), false); await assert.rejects(f.adapter.discoverRoom(room)); }
    assert.equal(f.transport.paths.length, 1);
  } finally { await f.cleanup(); }
});
test("server events parse exact created-room form without owner inference or auto-joining", async () => {
  const f = await setup([window("events", [{ seq: 1, ts: t1, from: "server", text: "created research" }])]);
  try {
    await f.adapter.discoverEvents(); const [o] = await f.store.observations();
    assert.equal(o!.room, "research"); assert.equal(o!.provenanceClassification, "server-observed");
    assert.equal((await f.store.listCandidates()).length, 0); assert.equal(f.transport.paths.length, 1);
    assert.match(f.transport.paths[0]!, /since=0&limit=50&wait=0$/u);
  } finally { await f.cleanup(); }
});
test("unexpected events / prose DIDs never become candidate identities", async () => {
  const f = await setup([window("events", [message(), { seq: 2, ts: t1, from: "server", text: `created p-${randomBytes(8).toString("hex")}` }]),
    window("lobby", [{ seq: 1, ts: t1, from: "nick", text: `I am ${other.did}` }])]);
  try { await f.adapter.discoverEvents(); await f.adapter.discoverRoom("lobby");
    assert.equal((await f.store.listCandidates()).length, 0); assert.equal((await f.store.observations()).length, 3);
  } finally { await f.cleanup(); }
});
test("many distinct DIDs deduplicate by key, preserving first/last, source diversity and versions", async () => {
  const first = window("lobby", [message(), message(other, "lobby", 2)]);
  const f = await setup([first, first]);
  try {
    await f.adapter.discoverRoom("lobby"); f.clock(t2); await f.adapter.discoverRoom("lobby");
    const peers = await f.store.listCandidates(); assert.equal(peers.length, 2);
    const c = peers.find(p => p.claimedDid === agent.did)!;
    assert.equal(c.firstSeenAt, t1); assert.equal(c.lastSeenAt, t2); assert.equal(c.observationCount, 1);
    assert.equal(c.sightingCount, 2); assert.equal(c.uniqueSourceCount, 1);
    const a2 = new TechnocorePublicDiscoveryAdapter(new Fake([window("research", [message(agent, "research")])]), f.store, {}, () => t2);
    await a2.discoverRoom("research");
    const inspected = await f.store.inspectCandidate(candidateId(agent.did));
    assert.equal(inspected.candidate.uniqueSourceCount, 2); assert.equal(inspected.observations.length, 2);
    assert.equal(inspected.candidate.trustClassification, "untrusted-discovery-only");
  } finally { await f.cleanup(); }
});
test("100 sightings in one source never create reputation or extra distinct peers", async () => {
  const f = await setup([window("lobby", [message()])]);
  try {
    await f.adapter.discoverRoom("lobby"); const [o] = await f.store.observations();
    for (let i = 1; i < 100; i++) { const { observationId: _id, firstSeenAt: _first, lastSeenAt: _last, sightings: _s, ...input } = o!; await f.store.append([input], t2); }
    const c = (await f.store.listCandidates())[0]!;
    assert.equal(c.observationCount, 1); assert.equal(c.sightingCount, 100); assert.equal(c.uniqueSourceCount, 1);
    assert.equal((await f.store.summary()).reputationScore, null);
  } finally { await f.cleanup(); }
});
test("DID path derivation is exact SHA256(full DID) sharding, not identity fingerprint", () => {
  const h = digest(agent.did).slice(0, 16);
  assert.deepEqual(didPaths(agent.did), { current: `/kv/did-${h.slice(0, 2)}/${h.slice(2)}`, legacy: `/kv/did/${h}` });
  assert.throws(() => didPaths("not-a-did"));
});
test("current DID note uses plain text banner and optional budget, never trusted owner auth", async () => {
  const f = await setup([note({ did: agent.did, role: "research" }, "\n# budget: fixture read budget")]);
  try { await f.adapter.lookupDidMetadata(agent.did);
    assert.deepEqual(f.transport.paths, [didPaths(agent.did).current]);
    const [o] = await f.store.observations(); assert.deepEqual(o!.claims, ["research"]);
    assert.equal(o!.signatureState, "absent"); assert.equal(o!.verificationState, "unverified");
    assert.equal(o!.provenanceClassification, "third-party-claim");
  } finally { await f.cleanup(); }
});
test("DID current 404 falls back exactly once to legacy; not-found evidence retained", async () => {
  const f = await setup([reply("missing", "text/plain", 404), note({ role: "review" })]);
  try { await f.adapter.lookupDidMetadata(agent.did);
    assert.deepEqual(f.transport.paths, Object.values(didPaths(agent.did)));
    assert.equal((await f.store.observations()).length, 2);
    assert.deepEqual((await f.store.listCandidates())[0]!.claimedCapabilities, ["review"]);
  } finally { await f.cleanup(); }
});
test("missing notes do not become authenticated observations", async () => {
  const f = await setup([]);
  try { await f.adapter.lookupDidMetadata(agent.did); assert.equal((await f.store.summary()).locallyVerifiedCandidates, 0);
    assert.ok((await f.store.observations()).every(o => o.warnings.includes("not-found")));
  } finally { await f.cleanup(); }
});
for (const [label, response] of [
  ["malformed successful note", reply("unframed", "text/plain")], ["empty note", note("")],
  ["JSON content type", reply({ value: "not the official contract" })],
  ["500", reply("private error", "text/plain", 500)], ["429", reply("private error", "text/plain", 429)],
] as const) test(`no legacy fallback/retry after ${label}`, async () => {
  const f = await setup([response]);
  try { await f.adapter.lookupDidMetadata(agent.did).catch(() => undefined); assert.equal(f.transport.paths.length, 1); }
  finally { await f.cleanup(); }
});
test("changed note creates history; same note with changed budget does not create fake version", async () => {
  const f = await setup([]);
  try {
    for (const value of [note({ role: "research" }), note({ role: "review" }), note({ role: "review" }, "\n# budget: changed")]) {
      await new TechnocorePublicDiscoveryAdapter(new Fake([value]), f.store).lookupDidMetadata(agent.did);
    }
    const c = (await f.store.listCandidates())[0]!;
    assert.equal(c.metadataHashes.length, 2); assert.equal(c.observationCount, 2); assert.equal(c.sightingCount, 3);
    assert.deepEqual(c.claimedCapabilities, ["research", "review"]);
  } finally { await f.cleanup(); }
});
test("mismatched metadata DID is warning, not a second identity or transferred capability", async () => {
  const f = await setup([note({ did: other.did, role: "research" })]);
  try { await f.adapter.lookupDidMetadata(agent.did); const c = (await f.store.listCandidates())[0]!;
    assert.equal(c.claimedDid, agent.did); assert.deepEqual(c.claimedCapabilities, []); assert.ok(c.warnings.includes("did-mismatch"));
  } finally { await f.cleanup(); }
});
test("valid record verifies exact room/nonce/stored text without retaining signature/body", async () => {
  const m = message(); const f = await setup([window("lobby", [m])]);
  try { await f.adapter.discoverRoom("lobby"); const [o] = await f.store.observations();
    assert.equal(o!.signatureState, "verified"); assert.equal(o!.verificationState, "local-signature-valid");
    const stored = await readFile(join(f.path, ".technocore-discovery", "discovery.json"), "utf8");
    assert.ok(!stored.includes(m.sig)); assert.ok(!stored.includes(m.text));
  } finally { await f.cleanup(); }
});
test("invalid signature never upgrades trust", async () => {
  const m = { ...message(), text: '{"role":"review"}' }; const f = await setup([window("lobby", [m])]);
  try { await f.adapter.discoverRoom("lobby"); assert.equal((await f.store.observations())[0]!.signatureState, "invalid");
    assert.equal((await f.store.summary()).locallyVerifiedCandidates, 0);
  } finally { await f.cleanup(); }
});
test("room replay cannot verify in a different room", async () => {
  const f = await setup([window("research", [message()])]);
  try { await f.adapter.discoverRoom("research"); assert.equal((await f.store.observations())[0]!.signatureState, "invalid"); }
  finally { await f.cleanup(); }
});
test("legacy unsigned message is server-reported only, never locally verified", async () => {
  const { sig: _sig, ...unsigned } = message(); const f = await setup([window("lobby", [unsigned])]);
  try { await f.adapter.discoverRoom("lobby"); const o = (await f.store.observations())[0]!;
    assert.equal(o.signatureState, "absent"); assert.equal(o.verificationState, "server-reported-did");
  } finally { await f.cleanup(); }
});
for (const [label, update] of [
  ["unsafe numeric nonce", { nonce: Number.MAX_SAFE_INTEGER + 1 }],
  ["unsanitized stored text", { text: "hello\nworld" }], ["missing nonce", { nonce: null }],
] as const) test(`${label} lacks exact canonical data and remains unverifiable`, async () => {
  const f = await setup([window("lobby", [{ ...message(), ...update }])]);
  try { await f.adapter.discoverRoom("lobby"); assert.equal((await f.store.observations())[0]!.signatureState, "unverifiable"); }
  finally { await f.cleanup(); }
});
test("exact large string nonce verifies without precision loss", async () => {
  const signed = signMessage(agent, "lobby", "9007199254740993", "hello");
  const f = await setup([window("lobby", [{ seq: 1, ts: t1, from: agent.did, text: signed.sanitizedText, nonce: signed.nonce, sig: signed.signature }])]);
  try { await f.adapter.discoverRoom("lobby"); assert.equal((await f.store.observations())[0]!.signatureState, "verified"); }
  finally { await f.cleanup(); }
});
test("advisory overlap uses supplied local registry vocabulary, never workload authority", async () => {
  const f = await setup([note({ capabilities: ["research", "review", "engineering", "unknown-role"] })]);
  try { await f.adapter.lookupDidMetadata(agent.did);
    const c = (await f.store.listCandidates())[0]!;
    const found = compareCapabilities(c, [{ alias: "bob", role: "researcher", workloads: [{ type: "workload.research", version: 1, inputSchema: "input", outputSchema: "output" }] }]);
    assert.equal(found[0]!.advisoryOnly, true); assert.equal(found[0]!.authority, false); assert.equal(found[0]!.alias, "bob");
    assert.ok(c.warnings.includes("unrecognized-claims"));
  } finally { await f.cleanup(); }
});
test("retention gaps and absent epochs are explicit, with no cursor creation or complete-history assertion", async () => {
  const f = await setup([window("lobby", [message(agent, "lobby", 7)], { generation: undefined })]);
  try { const r = await f.adapter.discoverRoom("lobby"); assert.equal(r.retentionGap, true); assert.equal(r.noCursorMutation, true);
    assert.equal(r.completeHistory, false); assert.ok((await f.store.observations())[0]!.warnings.includes("epoch-unknown"));
  } finally { await f.cleanup(); }
});
test("malformed individual records retain hash only, never a guessed DID", async () => {
  const f = await setup([window("lobby", [{ seq: 1, from: agent.did, text: "invalid missing timestamp" }])]);
  try { await f.adapter.discoverRoom("lobby"); assert.equal((await f.store.listCandidates()).length, 0);
    assert.equal((await f.store.observations())[0]!.provenanceClassification, "malformed");
  } finally { await f.cleanup(); }
});
test("candidate bound fails atomic batch without evicting old evidence", async () => {
  const f = await setup([window("lobby", [message()]), window("lobby", [message(other, "lobby", 2)])], { candidates: 1 });
  try { await f.adapter.discoverRoom("lobby"); const before = await readFile(join(f.path, ".technocore-discovery", "discovery.json"));
    await assert.rejects(f.adapter.discoverRoom("lobby"));
    assert.deepEqual(await readFile(join(f.path, ".technocore-discovery", "discovery.json")), before);
  } finally { await f.cleanup(); }
});
test("response bytes, room/event counts, metadata size and observation count are bounded", async () => {
  for (const [bounds, response, method] of [
    [{ responseBytes: 10 }, reply(" ".repeat(11)), "rooms"],
    [{ rooms: 1 }, reply({ rooms: [{ room: "one" }, { room: "two" }] }), "rooms"],
    [{ events: 1 }, window("events", [message(), message(other, "events", 2)]), "events"],
    [{ metadataBytes: 5 }, note({ role: "research" }), "did"],
    [{ observations: 1 }, window("lobby", [message(), message(other, "lobby", 2)]), "room"],
  ] as const) {
    const f = await setup([response], bounds);
    try { await assert.rejects(method === "rooms" ? f.adapter.discoverRooms() : method === "events" ? f.adapter.discoverEvents() :
      method === "did" ? f.adapter.lookupDidMetadata(agent.did) : f.adapter.discoverRoom("lobby")); }
    finally { await f.cleanup(); }
  }
});
test("GET request and DID lookup counts never exceed configured budgets", async () => {
  const f = await setup([note({}), note({})]);
  try { await f.adapter.lookupDidMetadata(agent.did); await assert.rejects(f.adapter.lookupDidMetadata(other.did));
    assert.equal(f.transport.paths.length, 1);
    await f.adapter.discoverRooms().catch(() => undefined); await assert.rejects(f.adapter.discoverEvents());
    assert.equal(f.transport.paths.length, 2);
  } finally { await f.cleanup(); }
});
test("timeout aborts injected request and persists no late result", async () => {
  const f = await setup([]); let signal: AbortSignal | undefined;
  const a = new TechnocorePublicDiscoveryAdapter({ get: (_p, s) => { signal = s; return new Promise(() => undefined); } }, f.store, { timeoutMs: 10 });
  try { await assert.rejects(a.discoverRooms(), /timed out/u); assert.equal(signal!.aborted, true);
    assert.equal((await f.store.observations()).length, 0);
  } finally { await f.cleanup(); }
});
test("all limits reject nonpositive/unknown/oversized values", () => {
  for (const key of Object.keys(defaults)) for (const value of [0, -1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => limits({ [key]: value }));
  }
  assert.throws(() => limits({ invented: 1 } as Partial<Limits>));
  assert.throws(() => limits({ constructor: 1 } as unknown as Partial<Limits>));
});
test("allowlist rejects GET write lanes, percent encoding, arbitrary paths, queries and private rooms", () => {
  for (const path of ["https://elsewhere.invalid/rooms", "//elsewhere.invalid/rooms", "/r/lobby/say/nick/hi", "/kv/did/abc/set/hi",
    "/r/p-hidden?format=json&since=0&limit=1&wait=0", "/r/lobby?format=json&since=0&limit=1&wait=1",
    "/r/%6cobby?format=json&since=0&limit=1&wait=0", "/rooms?format=json&limit=1&redirect=x", "/.well-known/agent.json"]) {
    assert.throws(() => assertReadPath(path));
  }
});
test("production read client only issues credential-free GET to exact reviewed origin, with no write methods", async () => {
  const calls: RequestInit[] = [];
  const fetcher: typeof fetch = async (_url, init) => { calls.push(init!); return new Response('{"rooms":[]}', { headers: { "content-type": "application/json" } }); };
  const t = new HttpDiscoveryReadTransport(DISCOVERY_ORIGIN, {}, fetcher);
  await t.get("/rooms?format=json&limit=1", new AbortController().signal);
  assert.equal(calls[0]!.method, "GET"); assert.equal(calls[0]!.redirect, "manual"); assert.equal(calls[0]!.credentials, "omit");
  assert.equal(calls[0]!.body, undefined); assert.deepEqual(Object.getOwnPropertyNames(Object.getPrototypeOf(t)), ["constructor", "get"]);
  for (const origin of ["http://technocore.chat", "https://technocore.chat/", "https://technocore.chat.evil.invalid", "https://user@technocore.chat"]) {
    assert.throws(() => new HttpDiscoveryReadTransport(origin, {}, fetcher));
  }
});
test("redirects (including same origin), wrong type and bounded streamed body fail without URL/body leak", async () => {
  for (const make of [
    () => new Response("", { status: 302, headers: { location: "https://elsewhere.invalid/private" } }),
    () => new Response("", { status: 307, headers: { location: "/rooms" } }),
    () => new Response("x", { headers: { "content-length": "10000" } }),
    () => new Response("x".repeat(30)),
  ]) {
    const t = new HttpDiscoveryReadTransport(DISCOVERY_ORIGIN, { responseBytes: 20 }, async () => make());
    await assert.rejects(t.get("/rooms?format=json&limit=1", new AbortController().signal), /Discovery GET refused or failed/u);
  }
});
test("wrong response content type / malformed JSON refused by adapter", async () => {
  for (const r of [reply("{}", "text/html"), reply("{"), reply({ rooms: "not-array" })]) {
    const f = await setup([r]); try { await assert.rejects(f.adapter.discoverRooms()); } finally { await f.cleanup(); }
  }
});
test("production client cancels interrupted bodies and reports only a static error", async () => {
  const secret = randomBytes(24).toString("hex");
  const fetcher: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.error(new Error(secret)); },
  }));
  const transport = new HttpDiscoveryReadTransport(DISCOVERY_ORIGIN, {}, fetcher);
  await assert.rejects(transport.get("/rooms?format=json&limit=1", new AbortController().signal),
    e => e instanceof Error && e.message === "Discovery GET refused or failed" && !e.cause);
});
test("production body timeout aborts a stalled stream, with no retry or persistence", async () => {
  let calls = 0; let cancelled = false;
  const fetcher: typeof fetch = async (_url, init) => {
    calls++;
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      init!.signal!.addEventListener("abort", () => { cancelled = true; controller.error(new Error("aborted")); }, { once: true });
    } }), { headers: { "content-type": "application/json" } });
  };
  const transport = new HttpDiscoveryReadTransport(DISCOVERY_ORIGIN, { timeoutMs: 10 }, fetcher);
  await assert.rejects(transport.get("/rooms?format=json&limit=1", new AbortController().signal), /timed out or was cancelled/u);
  assert.equal(calls, 1); assert.equal(cancelled, true);
});
test("fabricated followed-redirect response URL is rejected even on HTTP 200", async () => {
  const response = new Response("{}"); Object.defineProperty(response, "url", { value: "https://elsewhere.invalid/rooms" });
  const transport = new HttpDiscoveryReadTransport(DISCOVERY_ORIGIN, {}, async () => response);
  await assert.rejects(transport.get("/rooms?format=json&limit=1", new AbortController().signal));
});
test("lookup-only DIDs are distinguished from actual structured message observations", async () => {
  const f = await setup([note({ role: "review" }), window("lobby", [message(other)])]);
  try { await f.adapter.lookupDidMetadata(agent.did); await f.adapter.discoverRoom("lobby");
    const summary = await f.store.summary(); assert.equal(summary.uniqueCandidateDids, 2);
    assert.equal(summary.messageObservedDids, 1); assert.equal(summary.lookupOnlyDids, 1);
  } finally { await f.cleanup(); }
});
test("untrusted error text is discarded", async () => {
  const f = await setup([]); const secret = randomBytes(24).toString("hex");
  try { const a = new TechnocorePublicDiscoveryAdapter({ get: async () => { throw new Error(secret); } }, f.store);
    await assert.rejects(a.discoverRooms(), e => e instanceof Error && !e.message.includes(secret) && !e.cause);
  } finally { await f.cleanup(); }
});
test("raw secrets/URLs/unknown claims are neither persisted, output, followed nor turned into contacts", async () => {
  const secret = randomBytes(24).toString("hex"), capability = `mb-p-${secret}`;
  const key = agent.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const payload = { did: agent.did, role: "research", capabilities: ["review", secret], mailbox: capability,
    website: `https://elsewhere.invalid/${secret}`, privateKey: key, passphrase: secret, signature: message().sig,
    encryptedPrivateKey: secret, authToken: secret };
  const f = await setup([note(payload), reply({ rooms: [{ room: "lobby", topic: `https://elsewhere.invalid/${capability}` }] })]);
  try { await f.adapter.lookupDidMetadata(agent.did); await f.adapter.discoverRooms();
    const output = JSON.stringify([await f.store.summary(), await f.store.listCandidates(), await f.store.observations()]);
    const disk = await readFile(join(f.path, ".technocore-discovery", "discovery.json"), "utf8");
    for (const data of [output, disk]) for (const banned of [secret, capability, key, payload.signature, "elsewhere.invalid"]) assert.ok(!data.includes(banned));
    assert.deepEqual((await readdir(f.path)).sort(), [".technocore-discovery"]);
    assert.equal(f.transport.paths.length, 2);
  } finally { await f.cleanup(); }
});
test("safe topic output suppresses risky fields, controls, encoded capabilities and IPs", () => {
  for (const s of ["passphrase: abc", "privateKey: abc", "Bearer abc", "token=abc", "p-short", "mb-p-short",
    "https://example.invalid/a", "%70-hidden", "some\u001btext", "a".repeat(300), [192, 0, 2, 1].join(".")]) {
    assert.equal(safeTopic(s), "[OMITTED_UNTRUSTED_TEXT]");
  }
});
test("state survives restart; corrupt/secret-bearing state fails closed without printing it", async () => {
  const f = await setup([note({ role: "review" })]);
  try { await f.adapter.lookupDidMetadata(agent.did);
    assert.equal((await new DiscoveryStore(f.path).listCandidates()).length, 1);
    const file = join(f.path, ".technocore-discovery", "discovery.json"); const state = JSON.parse(await readFile(file, "utf8"));
    const secret = randomBytes(24).toString("hex"); state.observations[0].rawSecret = secret;
    await writeFile(file, JSON.stringify(state));
    await assert.rejects(new DiscoveryStore(f.path).summary(), e => e instanceof Error && !e.message.includes(secret));
  } finally { await f.cleanup(); }
});
test("concurrent observations serialize without losing distinct candidates", async () => {
  const f = await setup([]);
  try { await Promise.all([agent, other].map(i => new TechnocorePublicDiscoveryAdapter(new Fake([note({})]), new DiscoveryStore(f.path)).lookupDidMetadata(i.did)));
    assert.equal((await f.store.listCandidates()).length, 2);
  } finally { await f.cleanup(); }
});
test("read-only local CLI needs no origin and creates no directory", async () => {
  const f = await setup([]); const output: unknown[] = [];
  try { await discoveryCommand("discovery:summary", [], { workspace: f.path, output: v => output.push(v) });
    assert.equal(output.length, 1); assert.deepEqual(await readdir(f.path), []);
    assert.throws(() => new DiscoveryStore(join(f.path, ".technocore")));
    assert.throws(() => new DiscoveryStore(join(f.path, ".technocore. ")));
  } finally { await f.cleanup(); }
});
test("network CLI refuses absent consent/origin and unknown flags before GET", async () => {
  const f = await setup([]);
  try { for (const args of [[], ["--read-only-network"], ["--origin", DISCOVERY_ORIGIN],
    ["--read-only-network", "--origin", DISCOVERY_ORIGIN, "--post"],
    ["--read-only-network", "--origin", "https://elsewhere.invalid"]]) {
    await assert.rejects(discoveryCommand("discovery:rooms", args, { workspace: f.path, transport: f.transport, output: () => undefined }));
  } assert.equal(f.transport.paths.length, 0); assert.deepEqual(await readdir(f.path), []); }
  finally { await f.cleanup(); }
});
test("CLI injected discovery marks READ-ONLY NETWORK ACCESS and never initializes operational stores", async () => {
  const f = await setup([reply({ rooms: [{ room: "lobby", topic: "Public activity" }] })]); const output: unknown[] = [];
  try {
    const operational = join(f.path, ".technocore"); await mkdir(operational); await writeFile(join(operational, "untouched.json"), "fixture-state");
    await discoveryCommand("discovery:rooms", ["--read-only-network", "--origin", DISCOVERY_ORIGIN, "--limit", "1"],
      { workspace: f.path, transport: f.transport, output: v => output.push(v) });
    assert.match(JSON.stringify(output), /READ-ONLY NETWORK ACCESS/u);
    assert.equal(await readFile(join(operational, "untouched.json"), "utf8"), "fixture-state");
    assert.deepEqual(await readdir(operational), ["untouched.json"]);
    assert.deepEqual((await readdir(f.path)).sort(), [".technocore", ".technocore-discovery"]);
  } finally { await f.cleanup(); }
});
test("actual local CLI summary works offline without private identity unlock or operational files", async () => {
  const f = await setup([]);
  try { const cli = resolve("dist/src/cli.js");
    const output = execFileSync(process.execPath, [cli, "discovery:summary"], { cwd: f.path, encoding: "utf8" });
    assert.equal(JSON.parse(output).uniqueCandidateDids, 0); assert.deepEqual(await readdir(f.path), []);
  } finally { await f.cleanup(); }
});
test("discovery modules have no runtime/bridge/contact/identity/nonce/inference capabilities", async () => {
  const root = resolve("src/discovery");
  for (const file of await readdir(root)) {
    const source = await readFile(join(root, file), "utf8");
    const imports = source.split("\n").filter(l => l.startsWith("import ") && !l.startsWith("import type ")).join("\n");
    assert.doesNotMatch(imports, /(?:bridge|context|contact-store|identity-store|nonce-store|runtime|supervisor|approvals|inference)\.js/u);
  }
});
