import assert from "node:assert/strict";
import { cp, mkdir, readFile, readdir, stat, utimes } from "node:fs/promises";
import { Socket } from "node:net";
import { resolve } from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { createStores } from "../src/context.js";
import { initializeAgent } from "../src/agent/runtime.js";
import { AgentRoleStore } from "../src/agent/roles.js";
import { atomicWriteJson } from "../src/fs-safe.js";
import { AgentStateStore } from "../src/agent/state-store.js";
import { ActivityJournal } from "../src/agent/journal.js";
import { ActionApprovalStore } from "../src/agent/approvals.js";
import { CursorStore } from "../src/cursors.js";
import { FirstReceiptReconciliation, RECONCILIATION_QUERY } from "../src/rehearsal/reconciliation.js";
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
  queries: ReadRoomOptions[] = [];
  override async sendSignedMessage(room: string, envelope: SignedMessageEnvelope) {
    this.posts++;
    if (this.failPost === "ambiguous") throw new AmbiguousSendError("Synthetic uncertainty");
    if (this.failPost === "429") throw new TransportError("Synthetic refusal", 429);
    this.insidePost = true;
    try { return await super.sendSignedMessage(room, envelope); } finally { this.insidePost = false; }
  }
  override async readRoomJson(room: string, options?: ReadRoomOptions) {
    if (!this.insidePost) { this.gets++; this.queries.push({ ...options }); await this.beforeRead?.(); }
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

    const staleFixture = async (legacy = true) => {
      const f = await fixture();
      const mailbox = await f.stores.mailboxes.load("bob");
      await f.stores.cursors.advance("bob", mailbox.room, 1);
      const cursorPath = resolve(f.root, "cursors", "bob.json");
      const old = new Date("2020-01-01T00:00:00Z"); await utimes(cursorPath, old, old);
      const cursorBytes = await readFile(cursorPath, "utf8");
      const action = await f.runner.prepare(); await f.approve(action);
      await f.runner.send(action.actionId!, action.actionHash!);
      if (legacy) {
        const state = JSON.parse(await readFile(f.runner.path, "utf8"));
        state.steps[0].status = "get-intent"; state.gets = 1; state.halted = "receipt-validation-or-persistence-failed";
        await atomicWriteJson(f.runner.path, state);
      }
      const reconciliation = new FirstReceiptReconciliation(f.options);
      return { ...f, action, mailbox, cursorPath, cursorBytes, reconciliation };
    };
    const grantRead = async (f: Awaited<ReturnType<typeof staleFixture>>) => {
      const prepared = await f.reconciliation.prepare();
      await f.reconciliation.authorize(prepared.authorizationId, prepared.authorizationHash);
      return prepared;
    };
    const assertCursor = async (f: Awaited<ReturnType<typeof staleFixture>>) => {
      assert.equal(await readFile(f.cursorPath, "utf8"), f.cursorBytes);
      assert.equal((await stat(f.cursorPath)).mtime.toISOString(), "2020-01-01T00:00:00.000Z");
    };

    await t.test("seq1/cursor0 normal receive remains allowed", async () => {
      const f = await fixture(); const action = await f.runner.prepare(); await f.approve(action);
      await f.runner.send(action.actionId!, action.actionHash!); await f.runner.receive(1);
      assert.equal(f.transport.gets, 1); assert.equal((await f.runner.status()).steps[0]!.status, "acknowledged");
    });

    await t.test("old cursor1/sent seq1 preflight stops before unlock/GET, preserves cursor and GET count", async () => {
      const f = await staleFixture(false);
      const runner = new FirstRehearsal({ ...f.options, passphrases: async () => { throw new Error("Unlock must not occur"); } });
      const ack = CursorStore.prototype.advance; let acks = 0;
      CursorStore.prototype.advance = async () => { acks++; throw new Error("ACK forbidden"); };
      try { await assert.rejects(() => runner.receive(1), /stale-cursor-or-room-sequence-mismatch/u); }
      finally { CursorStore.prototype.advance = ack; }
      const state = await runner.status();
      assert.equal(state.getAttempts, 0); assert.equal(f.transport.gets, 0); assert.equal(acks, 0);
      assert.equal(state.steps[0]!.status, "sent");
      assert.equal(state.steps[0]!.failure?.stage, "preflight");
      assert.equal(state.steps[0]!.failure?.expectedSeq, 1); assert.equal(state.steps[0]!.failure?.previousCursor, 1);
      await assertCursor(f);
      // The new preflight-halt class can prepare the separate observation too.
      assert.equal((await f.reconciliation.prepare()).effect.previousCursor, 1);
    });

    await t.test("separate exact read authority: prepare/authorize never unlock, old send authority cannot read", async () => {
      const f = await staleFixture();
      const recon = new FirstReceiptReconciliation({ ...f.options, passphrases: async () => { throw new Error("No local preparation unlock"); } });
      const prepared = await recon.prepare();
      assert.deepEqual(prepared.effect.query, { since: 0, wait: 0, limit: 200 });
      assert.equal(prepared.effect.agentAlias, "bob"); assert.equal(prepared.effect.step, 1);
      assert.equal(prepared.effect.expectedSenderDid, f.action.senderDid);
      assert.equal(prepared.effect.agentDid, f.action.destinationDid);
      assert.equal(prepared.effect.expectedPayloadHash, f.action.payloadHash);
      await assert.rejects(() => recon.observe(f.action.actionId!, f.action.actionHash!));
      await assert.rejects(() => recon.observe(prepared.authorizationId, prepared.authorizationHash));
      await recon.authorize(prepared.authorizationId, prepared.authorizationHash);
      assert.equal(f.transport.gets, 0); await assertCursor(f);
    });

    await t.test("one bounded query, durable task -> journal -> checkpoint; no cursor write or automatic step advance", async () => {
      const f = await staleFixture(); const p = await grantRead(f);
      const rehearsalBytes = await readFile(f.runner.path, "utf8");
      const nonceBytes = await readFile(resolve(f.root, "nonces.json"), "utf8");
      const order: string[] = [];
      f.transport.beforeRead = async () => { await assertCursor(f); order.push("GET"); };
      const enqueue = AgentStateStore.prototype.enqueueTask, append = ActivityJournal.prototype.append;
      const ack = CursorStore.prototype.advance;
      AgentStateStore.prototype.enqueueTask = async function (input) {
        const result = await enqueue.call(this, input);
        if (input.type === "inbound.message") {
          const record = JSON.parse(await readFile(f.reconciliation.path, "utf8"));
          assert.ok(record.retained); assert.equal(record.checkpoint, undefined); order.push("task");
        }
        return result;
      };
      ActivityJournal.prototype.append = async function (entry) {
        if (entry.event === "inbound-persisted") {
          const state = await new AgentStateStore(resolve(f.root, "agents/bob/state.json")).load();
          assert.ok(state.tasks[entry.taskId!]);
          assert.equal(JSON.parse(await readFile(f.reconciliation.path, "utf8")).checkpoint, undefined);
        }
        const result = await append.call(this, entry);
        if (entry.event === "inbound-persisted") order.push("journal");
        return result;
      };
      CursorStore.prototype.advance = async () => { throw new Error("No cursor write permitted"); };
      try {
        const result = await f.reconciliation.observe(p.authorizationId, p.authorizationHash);
        assert.equal(result.status, "complete"); assert.ok(result.checkpoint); order.push("checkpoint");
        assert.equal(result.checkpoint.kind, "deterministic-offline");
        const output = JSON.stringify(result);
        assert.equal(output.includes(f.mailbox.room), false);
        assert.equal(output.includes(JSON.parse(rehearsalBytes).steps[0].text), false);
      } finally {
        AgentStateStore.prototype.enqueueTask = enqueue; ActivityJournal.prototype.append = append; CursorStore.prototype.advance = ack;
      }
      assert.deepEqual(order, ["GET", "task", "journal", "checkpoint"]);
      assert.deepEqual(f.transport.queries, [RECONCILIATION_QUERY]); assert.equal(f.transport.gets, 1);
      assert.equal(await readFile(f.runner.path, "utf8"), rehearsalBytes);
      assert.equal(await readFile(resolve(f.root, "nonces.json"), "utf8"), nonceBytes);
      const retained = JSON.parse(await readFile(f.reconciliation.path, "utf8")).retained;
      assert.equal(JSON.stringify(retained).includes(f.mailbox.room), false);
      await assertCursor(f);
    });

    for (const crash of ["inbound-persistence", "journal-persistence", "receipt-checkpoint", "local-completion"] as const) {
      await t.test(`crash at ${crash}: restart completes retained observation offline, no second GET`, async () => {
        const f = await staleFixture(); const p = await grantRead(f);
        const originalManifest = await readFile(f.runner.path, "utf8");
        const enqueue = AgentStateStore.prototype.enqueueTask, append = ActivityJournal.prototype.append, finish = ActionApprovalStore.prototype.finish;
        const load = AgentStateStore.prototype.load;
        let persisted = false;
        AgentStateStore.prototype.enqueueTask = async function (input) {
          const task = await enqueue.call(this, input);
          if (input.type === "inbound.message" && crash === "inbound-persistence") throw new Error("Injected crash after inbound task");
          return task;
        };
        ActivityJournal.prototype.append = async function (entry) {
          if (entry.event === "inbound-persisted" && crash === "journal-persistence") throw new Error("Injected journal failure");
          const result = await append.call(this, entry);
          if (entry.event === "inbound-persisted") persisted = true;
          return result;
        };
        AgentStateStore.prototype.load = async function () {
          if (persisted && crash === "receipt-checkpoint") throw new Error("Injected checkpoint failure");
          return load.call(this);
        };
        ActionApprovalStore.prototype.finish = async function (alias, id, status) {
          if (id === p.authorizationId && crash === "local-completion") {
            assert.ok(JSON.parse(await readFile(f.reconciliation.path, "utf8")).checkpoint);
            throw new Error("Injected crash after checkpoint");
          }
          return finish.call(this, alias, id, status);
        };
        try { await assert.rejects(() => f.reconciliation.observe(p.authorizationId, p.authorizationHash)); }
        finally {
          AgentStateStore.prototype.enqueueTask = enqueue; ActivityJournal.prototype.append = append;
          ActionApprovalStore.prototype.finish = finish; AgentStateStore.prototype.load = load;
        }
        const failed = await f.reconciliation.status(); assert.equal(failed.failure?.stage, crash);
        const recon = new FirstReceiptReconciliation(f.options);
        const result = await recon.complete(p.authorizationId, p.authorizationHash);
        assert.equal(result.status, "complete"); assert.equal(f.transport.gets, 1);
        await recon.complete(p.authorizationId, p.authorizationHash);
        await assert.rejects(() => recon.observe(p.authorizationId, p.authorizationHash));
        assert.equal(f.transport.gets, 1);
        const state = await new AgentStateStore(resolve(f.root, "agents/bob/state.json")).load();
        assert.equal(Object.values(state.tasks).filter(t => t.type === "inbound.message").length, 1);
        const journal = await new ActivityJournal(resolve(f.root, "agents/bob/journal.jsonl")).read();
        assert.equal(journal.filter(e => e.event === "inbound-persisted").length, 1);
        assert.equal(await readFile(f.runner.path, "utf8"), originalManifest); await assertCursor(f);
      });
    }

    const mutateFrame = (view: RoomResponse, field: string, value: unknown) => {
      const message = view.messages[0]!;
      return { ...view, messages: [{ ...message, text: JSON.stringify({ ...JSON.parse(message.text), [field]: value }) }] };
    };
    const receiptFaults: Record<string, { stage: string; mutate: (view: RoomResponse) => RoomResponse }> = {
      absent: { stage: "message-selection", mutate: v => ({ ...v, count: 0, messages: [] }) },
      wrongSender: { stage: "sender-did-validation", mutate: v => ({ ...v, messages: [{ ...v.messages[0]!, from: "not-a-did" }] }) },
      unverified: { stage: "sender-did-validation", mutate: v => { const { nonce: _, ...message } = v.messages[0]!; return { ...v, messages: [message] }; } },
      frameFrom: { stage: "frame-validation", mutate: v => mutateFrame(v, "from", "unexpected") },
      frameTo: { stage: "frame-validation", mutate: v => mutateFrame(v, "to", "unexpected") },
      frameVersion: { stage: "frame-validation", mutate: v => mutateFrame(v, "version", 2) },
      frameStep: { stage: "frame-validation", mutate: v => mutateFrame(v, "step", 2) },
      frameRehearsal: { stage: "frame-validation", mutate: v => mutateFrame(v, "rehearsal", "other") },
      payloadHash: { stage: "payload-validation", mutate: v => mutateFrame(v, "content", "changed payload") },
      duplicate: { stage: "message-selection", mutate: v => ({ ...v, count: 2, messages: [v.messages[0]!, v.messages[0]!] }) },
      conflict: { stage: "message-selection", mutate: v => ({ ...v, count: 2, messages: [v.messages[0]!, { ...v.messages[0]!, text: "conflicting candidate" }] }) },
      wrongSequence: { stage: "sequence-validation", mutate: v => ({ ...v, messages: [{ ...v.messages[0]!, seq: 2 }], last_seq: 2 }) },
      retentionGap: { stage: "sequence-validation", mutate: v => ({ ...v, first_seq: 3 }) },
      epochRegression: { stage: "sequence-validation", mutate: v => ({ ...v, last_seq: 0 }) },
    };
    for (const [label, fault] of Object.entries(receiptFaults)) await t.test(`reconciliation ${label}: fail closed without ACK, retained data, retry or advance`, async () => {
      const f = await staleFixture(); const p = await grantRead(f);
      const original = await readFile(f.runner.path, "utf8"); f.transport.mutate = fault.mutate;
      await assert.rejects(() => f.reconciliation.observe(p.authorizationId, p.authorizationHash));
      const result = await f.reconciliation.status();
      assert.equal(result.failure?.stage, fault.stage); assert.equal(result.observationAttempts, 1);
      const record = JSON.parse(await readFile(f.reconciliation.path, "utf8"));
      assert.equal(record.retained, undefined); assert.equal(record.checkpoint, undefined);
      await assert.rejects(() => f.reconciliation.complete(p.authorizationId, p.authorizationHash));
      await assert.rejects(() => f.reconciliation.observe(p.authorizationId, p.authorizationHash));
      assert.equal(f.transport.gets, 1); assert.equal(f.transport.posts, 1);
      assert.equal(await readFile(f.runner.path, "utf8"), original);
      assert.equal(Object.keys((await new AgentStateStore(resolve(f.root, "agents/bob/state.json")).load()).tasks).length, 0);
      await assertCursor(f);
    });

    await t.test("every exact read binding rejects mutation before network", async () => {
      const f = await staleFixture(); const p = await grantRead(f);
      const record = JSON.parse(await readFile(f.reconciliation.path, "utf8"));
      const mutations: ((spec: Record<string, unknown>) => void)[] = [
        s => { s.agentAlias = "alice"; }, s => { s.agentDid = f.action.senderDid; }, s => { s.step = 2; },
        s => { s.mailboxContactHash = "a".repeat(64); }, s => { s.expectedSenderDid = f.action.destinationDid; },
        s => { s.expectedSeq = 2; }, s => { s.expectedPayloadHash = "a".repeat(64); }, s => { s.previousCursor = 0; },
        s => { s.origin = "https://example.invalid"; }, s => { s.mode = "live"; },
        s => { s.query = { since: 1, wait: 0, limit: 200 }; }, s => { s.query = { since: 0, wait: 1, limit: 200 }; },
        s => { s.query = { since: 0, wait: 0, limit: 100 }; }, s => { s.originalStateHash = "a".repeat(64); },
      ];
      for (const mutate of mutations) {
        const changed = structuredClone(record); mutate(changed.spec);
        await atomicWriteJson(f.reconciliation.path, changed);
        await assert.rejects(() => f.reconciliation.observe(p.authorizationId, p.authorizationHash));
      }
      await atomicWriteJson(f.reconciliation.path, record);
      await assert.rejects(() => f.reconciliation.observe(p.authorizationId, "b".repeat(64)));
      assert.equal(f.transport.gets, 0); await assertCursor(f);
    });

    await t.test("transport exception is attempted once and safe diagnostics omit body/capability/private content", async () => {
      const f = await staleFixture(); const p = await grantRead(f);
      const text = JSON.parse(await readFile(f.runner.path, "utf8")).steps[0].text;
      f.transport.beforeRead = async () => { throw Object.assign(new Error(`${f.mailbox.room} ${text}`), { code: f.mailbox.room }); };
      let errorText = "";
      try { await f.reconciliation.observe(p.authorizationId, p.authorizationHash); } catch (error) { errorText = String(error); }
      const result = await f.reconciliation.status();
      assert.equal(result.failure?.stage, "transport"); assert.equal(result.failure?.causeCode, undefined);
      const exposed = errorText + JSON.stringify(result) + JSON.stringify(JSON.parse(await readFile(f.reconciliation.path, "utf8")).failure);
      assert.equal(exposed.includes(f.mailbox.room), false); assert.equal(exposed.includes(text), false);
      await assert.rejects(() => f.reconciliation.observe(p.authorizationId, p.authorizationHash));
      assert.equal(f.transport.gets, 1); await assertCursor(f);
    });

    await t.test("normal receive diagnostics retain the failing validation stage, never raw parse errors", async () => {
      const f = await fixture(); const action = await f.runner.prepare(); await f.approve(action);
      await f.runner.send(action.actionId!, action.actionHash!);
      const cap = (await f.stores.mailboxes.load("bob")).room;
      f.transport.mutate = v => ({ ...v, messages: [{ ...v.messages[0]!, text: cap }] });
      let errorText = ""; try { await f.runner.receive(1); } catch (error) { errorText = String(error); }
      const result = await f.runner.status();
      assert.equal(result.steps[0]!.failure?.stage, "frame-validation");
      assert.equal((errorText + JSON.stringify(result)).includes(cap), false);
    });

    await t.test("CLI read authorization commands emit only safe metadata and make zero network calls", async () => {
      const f = await staleFixture();
      const manifest = JSON.parse(await readFile(f.runner.path, "utf8"));
      manifest.mode = "live"; // Generated fixture only; preparation makes no claim of a live observation.
      await atomicWriteJson(f.runner.path, manifest);
      const before = await readFile(f.runner.path, "utf8");
      const guard = "import {Socket} from 'node:net'; Socket.prototype.connect=()=>{throw new Error('Network forbidden')}; globalThis.fetch=()=>{throw new Error('Network forbidden')};";
      const env: NodeJS.ProcessEnv = { ...process.env, TECHNOCORE_HOME: f.root }; delete env.TECHNOCORE_URL;
      const invoke = (...args: string[]) => spawnSync(process.execPath,
        ["--import", `data:text/javascript,${encodeURIComponent(guard)}`, resolve("dist/src/cli.js"), ...args],
        { env, encoding: "utf8", timeout: 5000 });
      const prepare = invoke("rehearsal:reconcile-prepare"); assert.equal(prepare.status, 0);
      const p = JSON.parse(prepare.stdout);
      const authorize = invoke("rehearsal:reconcile-authorize", p.authorizationId, p.authorizationHash); assert.equal(authorize.status, 0);
      const inspected = invoke("rehearsal:reconcile-status"); assert.equal(inspected.status, 0);
      const invalid = invoke("rehearsal:reconcile-authorize", p.authorizationId, "a".repeat(64)); assert.equal(invalid.status, 1);
      const output = [prepare, authorize, inspected, invalid].map(r => r.stdout + r.stderr).join("");
      for (const alias of ALIASES) {
        assert.equal(output.includes((await f.stores.mailboxes.load(alias)).room), false);
        const identity = JSON.parse(identityBytes.get(alias)!);
        assert.equal(output.includes(identity.encryptedPrivateKey.ciphertext), false);
      }
      assert.equal(output.includes(manifest.steps[0].text), false);
      assert.equal(output.includes(passphrases.passphrase.toString("base64url")), false);
      assert.equal(await readFile(f.runner.path, "utf8"), before); await assertCursor(f);
    });

    assert.equal(network, 0);
    assert.deepEqual((await readdir(resolve(base, "identities"))).sort(), ALIASES.map(n => `${n}.json`).sort());
  } finally {
    Socket.prototype.connect = connect;
    passphrases.cleanup(); await tmp.cleanup();
  }
});
