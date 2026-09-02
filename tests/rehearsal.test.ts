import assert from "node:assert/strict";
import { cp, mkdir, readFile, readdir } from "node:fs/promises";
import { Socket } from "node:net";
import { resolve } from "node:path";
import { test } from "node:test";
import { createStores } from "../src/context.js";
import { initializeAgent } from "../src/agent/runtime.js";
import { AgentRoleStore } from "../src/agent/roles.js";
import { atomicWriteJson } from "../src/fs-safe.js";
import { InMemoryTechnocoreTransport } from "../src/mock-transport.js";
import { AmbiguousSendError, TransportError } from "../src/errors.js";
import type { ReadRoomOptions, RoomResponse, SignedMessageEnvelope } from "../src/types.js";
import { FirstRehearsal, GRAPH, REHEARSAL_HTTP_OPTIONS, type AnalysisPacket } from "../src/rehearsal/runner.js";
import { ALIASES, TEAM, prepareRehearsalContacts, type Alias } from "../src/rehearsal/setup.js";
import { generatedPassphraseProvider, temporaryDirectory } from "./helpers.js";

class FixtureTransport extends InMemoryTechnocoreTransport {
  posts = 0; gets = 0; insidePost = false;
  failPost: "ambiguous" | "429" | undefined;
  mutate: ((view: RoomResponse) => RoomResponse) | undefined;
  beforeRead: (() => Promise<void>) | undefined;
  override async sendSignedMessage(room: string, envelope: SignedMessageEnvelope) {
    this.posts++;
    if (this.failPost === "ambiguous") throw new AmbiguousSendError("Synthetic uncertainty");
    if (this.failPost === "429") throw new TransportError("Synthetic refusal", 429);
    this.insidePost = true;
    try { return await super.sendSignedMessage(room, envelope); } finally { this.insidePost = false; }
  }
  override async readRoomJson(room: string, options?: ReadRoomOptions) {
    if (!this.insidePost) { this.gets++; await this.beforeRead?.(); }
    const view = await super.readRoomJson(room, options);
    return !this.insidePost && this.mutate ? this.mutate(view) : view;
  }
}

function analysis(alias: Alias, evidenceHashes: string[] = []): AnalysisPacket {
  const sources = [{ kind: "deterministic-offline" as const, summary: "Generated fixtures; no service behavior has been observed live." }];
  const output = {
    bob: { answer: "Persist before acknowledging; distinguish duplicate delivery from replay.", keyClaims: ["Sequence alone does not identify a room epoch"],
      confidence: { level: "low", rationale: "Offline fixtures only" }, limitations: ["No live API research"], suggestedFollowUp: ["Inspect official source with separate read authorization"] },
    charlie: { findings: ["Cursor regression and retention gaps need reconciliation"], likelyCauses: [], proposedTests: ["Restart between persistence and ack"],
      proposedChange: "Fail closed on gaps", risks: ["Blind retry after ambiguous POST"], unresolvedQuestions: ["Actual service epoch semantics"], recommendation: "Keep exact-effect approval and durable receipts" },
    dave: { outcome: "REVISION_REQUIRED", findings: ["Supplied result hash checked; live causality remains unknown"], independentlyChecked: ["supplied-result-hash"],
      unresolved: ["Source/live evidence missing"], confidence: "low" },
    eve: { secondOpinion: "Sequence reuse can alias historical work", edgeCases: ["Epoch reset followed by sequence catch-up"], alternatives: ["Operator reconciliation"],
      overlookedRisks: ["Lost local ACK checkpoint"], limitations: ["Offline supplied evidence only"] },
    alice: { summary: "Evidence supports conservative agent-side recovery, not claims about live guarantees", steps: ["Persist", "Validate", "Acknowledge"], evidenceHashes,
      limitations: ["Deterministic offline rehearsal"] },
  }[alias];
  return { sources, output };
}

test("controlled rehearsal: fixed graph, exact approval, durable recovery and no live network", async t => {
  const tmp = await temporaryDirectory();
  const passphrases = generatedPassphraseProvider();
  const connect = Socket.prototype.connect;
  let network = 0;
  Socket.prototype.connect = function () { network++; throw new Error("Network forbidden in rehearsal tests"); } as typeof connect;
  const base = resolve(tmp.path, "seed");
  await mkdir(base);
  const seed = createStores(base, passphrases.provider);
  const identityBytes = new Map<string, string>();
  let next = 0;
  try {
    for (const name of ALIASES) {
      const identity = await seed.identities.create(name);
      await initializeAgent({ identityAlias: name, root: base, passphrases: passphrases.provider });
      await new AgentRoleStore(resolve(base, "agents", name)).assign(identity, TEAM[name]);
      identityBytes.set(name, await readFile(resolve(base, "identities", `${name}.json`), "utf8"));
    }
    for (const name of ["alice", "bob"] as const) await seed.mailboxes.create(name, (await seed.identities.inspect(name)).did);
    for (const [owner, target] of [["alice", "bob"], ["bob", "alice"]]) {
      const mailbox = await seed.mailboxes.load(target!);
      await seed.contacts.add(owner!, target!, mailbox.did, mailbox.room);
    }
    const before = new Map<string, string>();
    for (const p of ["mailboxes/alice.json", "mailboxes/bob.json", "contacts/bob.json"]) before.set(p, await readFile(resolve(base, p), "utf8"));
    const aliceBob = await seed.contacts.get("alice", "bob");
    await prepareRehearsalContacts(base);

    await t.test("local setup adds only six edges, preserves Alice/Bob and never unlocks or rotates", async () => {
      const maps: Record<string, string[]> = {};
      for (const alias of ALIASES) {
        const state = JSON.parse(await readFile(resolve(base, "contacts", `${alias}.json`), "utf8"));
        maps[alias] = Object.keys(state.contacts).sort();
        assert.equal(await readFile(resolve(base, "identities", `${alias}.json`), "utf8"), identityBytes.get(alias));
      }
      assert.deepEqual(maps, { alice: ["bob", "charlie", "dave", "eve"], bob: ["alice"], charlie: ["alice"], dave: ["alice"], eve: ["alice"] });
      assert.deepEqual(await seed.contacts.get("alice", "bob"), aliceBob);
      for (const [path, bytes] of before) assert.equal(await readFile(resolve(base, path), "utf8"), bytes);
      await prepareRehearsalContacts(base);
      for (const [path, bytes] of before) assert.equal(await readFile(resolve(base, path), "utf8"), bytes);
    });

    const fixture = async () => {
      const root = resolve(tmp.path, `case-${++next}`);
      await cp(base, root, { recursive: true });
      const transport = new FixtureTransport();
      const stores = createStores(root, passphrases.provider);
      const options = { root, passphrases: passphrases.provider, offlineTransport: transport };
      const runner = new FirstRehearsal(options);
      const approve = async (action: Awaited<ReturnType<FirstRehearsal["prepare"]>>) => {
        await stores.approvals.grant(action.senderAlias, action.actionId!, action.actionHash!);
      };
      return { root, transport, stores, runner, options, approve };
    };

    await t.test("exact eight signed steps, restarts, evidence scopes and no ninth synthesis send", async () => {
      const f = await fixture(); let runner = f.runner;
      assert.deepEqual(GRAPH, [["alice", "bob"], ["bob", "alice"], ["alice", "charlie"], ["charlie", "alice"], ["alice", "dave"], ["dave", "alice"], ["alice", "eve"], ["eve", "alice"]]);
      const allOutputs: string[] = [];
      for (let i = 0; i < 8; i++) {
        if (i % 2) await runner.work(GRAPH[i]![0], analysis(GRAPH[i]![0]));
        const prepared = await runner.prepare(); allOutputs.push(JSON.stringify(prepared));
        assert.equal(prepared.senderAlias, GRAPH[i]![0]);
        assert.equal(prepared.destinationAlias, GRAPH[i]![1]);
        await assert.rejects(() => runner.send(prepared.actionId!, prepared.actionHash!), /approval/u);
        assert.equal(f.transport.posts, i);
        await f.approve(prepared);
        await runner.send(prepared.actionId!, prepared.actionHash!);
        runner = new FirstRehearsal(f.options); // new host process between send and read
        await runner.receive(i + 1);
        runner = new FirstRehearsal(f.options);
        assert.equal((await runner.status()).getAttempts, i + 1);
      }
      const status = await runner.status();
      const final = await runner.work("alice", analysis("alice", ["bob", "charlie", "dave", "eve"].map(name => status.results[name]!.resultHash!)));
      assert.equal(final.complete, true); assert.equal(f.transport.posts, 8); assert.equal(f.transport.gets, 8);
      assert.ok(final.steps.every(s => s.observation?.kind === "deterministic-offline"));
      await assert.rejects(() => runner.prepare(), /No further/u);
      await assert.rejects(() => runner.send("unused", "unused"), /No further/u);
      assert.equal((await new FirstRehearsal(f.options).status()).complete, true);
      const aliceJournal = await readFile(resolve(f.root, "agents", "alice", "journal.jsonl"), "utf8");
      assert.match(aliceJournal, /operator-supplied/u);
      assert.equal(aliceJournal.includes('"model":"fixture-v1"'), false);
      for (const name of ALIASES) {
        const cap = (await f.stores.mailboxes.load(name)).room;
        assert.equal(allOutputs.join("").includes(cap), false);
        assert.equal(aliceJournal.includes(cap), false);
        assert.equal((await readFile(runner.path, "utf8")).includes(cap), false);
        assert.equal(await readFile(resolve(f.root, "identities", `${name}.json`), "utf8"), identityBytes.get(name));
      }
    });

    await t.test("preparation never unlocks or calls a transport", async () => {
      const f = await fixture();
      const runner = new FirstRehearsal({ ...f.options, passphrases: async () => { throw new Error("Unlock forbidden"); } });
      const action = await runner.prepare();
      assert.match(action.actionId!, /^[a-f0-9]{64}$/u);
      assert.equal(f.transport.posts + f.transport.gets, 0);
      assert.equal(await f.stores.nonces.last(action.senderDid, (await f.stores.mailboxes.load("bob")).room), undefined);
    });

    await t.test("payload mutation invalidates approval before nonce/network", async () => {
      const f = await fixture(); const action = await f.runner.prepare(); await f.approve(action);
      const path = resolve(f.root, "agents", "alice", "state.json");
      const state = JSON.parse(await readFile(path, "utf8"));
      state.tasks.rehearsal_send_1.payload.text = "changed after approval";
      await atomicWriteJson(path, state);
      await assert.rejects(() => f.runner.send(action.actionId!, action.actionHash!), /payload/u);
      assert.equal(f.transport.posts, 0);
      assert.equal(await f.stores.nonces.last(action.senderDid, (await f.stores.mailboxes.load("bob")).room), undefined);
    });

    for (const failure of ["ambiguous", "429"] as const) await t.test(`${failure} stops after one POST and cannot be retried`, async () => {
      const f = await fixture(); const action = await f.runner.prepare(); await f.approve(action);
      f.transport.failPost = failure;
      await assert.rejects(() => f.runner.send(action.actionId!, action.actionHash!));
      await assert.rejects(() => new FirstRehearsal(f.options).send(action.actionId!, action.actionHash!));
      await assert.rejects(() => f.runner.receive(1));
      assert.equal(f.transport.posts, 1); assert.equal(f.transport.gets, 0);
      assert.equal((await f.stores.approvals.read("alice", action.actionId!)).status, failure === "ambiguous" ? "ambiguous" : "failed");
      assert.equal(REHEARSAL_HTTP_OPTIONS.rateLimitRetries, 0); assert.equal(REHEARSAL_HTTP_OPTIONS.readRetries, 0);
    });

    const faults: Record<string, (v: RoomResponse) => RoomResponse> = {
      duplicate: v => ({ ...v, count: 2, messages: [v.messages[0]!, v.messages[0]!] }),
      replay: v => ({ ...v, messages: [{ ...v.messages[0]!, seq: 0 }], last_seq: 0 }),
      wrongDid: v => ({ ...v, messages: [{ ...v.messages[0]!, from: "not-a-did" }] }),
      unexpected: v => ({ ...v, messages: [{ ...v.messages[0]!, text: "Unrelated incoming data" }] }),
      retentionGap: v => ({ ...v, first_seq: 3 }),
      epochRegression: v => ({ ...v, last_seq: 0, messages: [] }),
      backlog: v => ({ ...v, last_seq: 300 }),
    };
    for (const [label, mutate] of Object.entries(faults)) await t.test(`${label}: stop without acknowledgment or repeated GET`, async () => {
      const f = await fixture(); const action = await f.runner.prepare(); await f.approve(action);
      await f.runner.send(action.actionId!, action.actionHash!); f.transport.mutate = mutate;
      await assert.rejects(() => f.runner.receive(1));
      assert.equal(await f.stores.cursors.get("bob", (await f.stores.mailboxes.load("bob")).room), 0);
      await assert.rejects(() => new FirstRehearsal(f.options).receive(1));
      assert.equal(f.transport.gets, 1);
    });

    await t.test("intake persistence failure cannot advance the cursor", async () => {
      const f = await fixture(); const action = await f.runner.prepare(); await f.approve(action);
      await f.runner.send(action.actionId!, action.actionHash!);
      // A directory at the journal path forces append failure after task persistence.
      const { ActivityJournal } = await import("../src/agent/journal.js");
      const original = ActivityJournal.prototype.append;
      ActivityJournal.prototype.append = async function (entry) {
        if (entry.event === "inbound-persisted") throw new Error("Injected persistence failure");
        return original.call(this, entry);
      };
      try { await assert.rejects(() => f.runner.receive(1)); }
      finally { ActivityJournal.prototype.append = original; }
      assert.equal(await f.stores.cursors.get("bob", (await f.stores.mailboxes.load("bob")).room), 0);
    });

    await t.test("crash after durable receipt can reconcile ACK locally without another GET", async () => {
      const f = await fixture(); const action = await f.runner.prepare(); await f.approve(action);
      await f.runner.send(action.actionId!, action.actionHash!); await f.runner.receive(1);
      const state = JSON.parse(await readFile(f.runner.path, "utf8"));
      state.index = 0; state.steps[0].status = "received";
      await atomicWriteJson(f.runner.path, state);
      const recovered = await new FirstRehearsal(f.options).receive(1);
      assert.equal(recovered.nextStep, 2); assert.equal(f.transport.gets, 1);
      assert.equal((await readFile(resolve(f.root, "agents", "bob", "journal.jsonl"), "utf8")).split('"event":"inbound-persisted"').length - 1, 1);
    });

    await t.test("crash at network intent quarantines rather than replaying", async () => {
      const f = await fixture(); await f.runner.prepare();
      const state = JSON.parse(await readFile(f.runner.path, "utf8"));
      state.steps[0].status = "post-intent"; state.posts = 1;
      await atomicWriteJson(f.runner.path, state);
      await assert.rejects(() => new FirstRehearsal(f.options).prepare(), /Interrupted/u);
      assert.equal(f.transport.posts, 0); assert.equal((await f.runner.status()).halted, "interrupted-network-operation");
    });

    await t.test("operator data cannot self-label a live observation or expose capabilities", async () => {
      const f = await fixture(); const action = await f.runner.prepare(); await f.approve(action);
      await f.runner.send(action.actionId!, action.actionHash!); await f.runner.receive(1);
      const malicious = analysis("bob");
      malicious.sources[0]!.kind = "live-observation" as "operator-supplied";
      await assert.rejects(() => f.runner.work("bob", malicious), /provenance/u);
      malicious.sources[0]!.kind = "operator-supplied";
      malicious.sources[0]!.summary = (await f.stores.mailboxes.load("bob")).room;
      await assert.rejects(() => f.runner.work("bob", malicious), error => {
        assert.equal(String(error).includes(malicious.sources[0]!.summary), false); return true;
      });
      assert.equal(f.transport.posts, 1);
    });

    assert.equal(network, 0);
    assert.deepEqual((await readdir(resolve(base, "identities"))).sort(), ALIASES.map(n => `${n}.json`).sort());
  } finally {
    Socket.prototype.connect = connect;
    passphrases.cleanup(); await tmp.cleanup();
  }
});
