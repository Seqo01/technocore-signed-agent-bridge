import assert from "node:assert/strict";
import { cp, mkdir, readFile, readdir, stat, utimes, unlink } from "node:fs/promises";
import { Socket } from "node:net";
import { resolve } from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { createStores } from "../src/context.js";
import { initializeAgent } from "../src/agent/runtime.js";
import { AgentRoleStore } from "../src/agent/roles.js";
import { atomicWriteJson } from "../src/fs-safe.js";
import { AgentStateStore } from "../src/agent/state-store.js";
import { agentPaths } from "../src/agent/paths.js";
import { ActivityJournal } from "../src/agent/journal.js";
import { ActionApprovalStore } from "../src/agent/approvals.js";
import { CursorStore } from "../src/cursors.js";
import { hashValue } from "../src/agent/util.js";
import type { RecoveryBoundary } from "../src/rehearsal/recovery.js";
import { FirstReceiptReconciliation, RECONCILIATION_QUERY } from "../src/rehearsal/reconciliation.js";
import { InMemoryTechnocoreTransport } from "../src/mock-transport.js";
import { AmbiguousSendError, TransportError } from "../src/errors.js";
import { SignedPostRejectedError } from "../src/send-diagnostics.js";
import { SendReconciliation, SEND_READ_QUERY, type SendRecoveryBoundary } from "../src/rehearsal/send-reconciliation.js";
import { HttpTechnocoreTransport } from "../src/transport.js";
import type { ReadRoomOptions, RoomResponse, SignedMessageEnvelope } from "../src/types.js";
import { FirstRehearsal, GRAPH, REHEARSAL_HTTP_OPTIONS, type AnalysisPacket } from "../src/rehearsal/runner.js";
import { ALIASES, TEAM, prepareRehearsalContacts, type Alias } from "../src/rehearsal/setup.js";
import { generatedPassphraseProvider, temporaryDirectory } from "./helpers.js";

class FixtureTransport extends InMemoryTechnocoreTransport {
  posts = 0; gets = 0; insidePost = false;
  failPost: "ambiguous" | "generic" | "429" | "400" | undefined;
  mutate: ((view: RoomResponse) => RoomResponse) | undefined;
  beforeRead: (() => Promise<void>) | undefined;
  queries: ReadRoomOptions[] = [];
  override async sendSignedMessage(room: string, envelope: SignedMessageEnvelope) {
    this.posts++;
    if (this.failPost === "ambiguous") throw new AmbiguousSendError("Synthetic uncertainty");
    if (this.failPost === "generic") throw Object.assign(new TypeError("Synthetic post-dispatch exception"), { code: "ECONNRESET" });
    if (this.failPost === "429" || this.failPost === "400") throw new SignedPostRejectedError({ stage: "response-status", status: Number(this.failPost),
      headersReceived: true, timedOut: false, bodyStarted: true, contentType: "text/plain", endpoint: "https://example.test/r/[REDACTED_CAPABILITY]" });
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

    for (const failure of ["ambiguous", "generic", "429"] as const) await t.test(`${failure} stops after one POST and cannot be retried`, async () => {
      const f = await fixture(); const action = await f.runner.prepare(); await f.approve(action);
      f.transport.failPost = failure;
      await assert.rejects(() => f.runner.send(action.actionId!, action.actionHash!));
      await assert.rejects(() => new FirstRehearsal(f.options).send(action.actionId!, action.actionHash!));
      await assert.rejects(() => f.runner.receive(1));
      assert.equal(f.transport.posts, 1); assert.equal(f.transport.gets, 0);
      assert.equal((await f.stores.approvals.read("alice", action.actionId!)).status, failure === "429" ? "failed" : "ambiguous");
      if (failure === "generic") {
        const task = (await new AgentStateStore(agentPaths(f.root, "alice").state).load()).tasks.rehearsal_send_1!;
        assert.equal(task.status, "ambiguous"); assert.equal(task.error?.outbound?.causeCode, "ECONNRESET");
        assert.equal(task.error?.outbound?.dispatchBegan, true); assert.equal(task.error?.outbound?.nonceReservation, "reserved");
      }
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

    // Synthetic live-SHAPE fixture from generated temporary data, not evidence of a real live observation.
    const recoverySeed = await staleFixture();
    const seedApproval = await grantRead(recoverySeed);
    await recoverySeed.reconciliation.observe(seedApproval.authorizationId, seedApproval.authorizationHash);
    const seedManifest = JSON.parse(await readFile(recoverySeed.runner.path, "utf8"));
    seedManifest.mode = "live";
    await atomicWriteJson(recoverySeed.runner.path, seedManifest);
    const seedRecord = JSON.parse(await readFile(recoverySeed.reconciliation.path, "utf8"));
    seedRecord.spec.mode = "live"; seedRecord.spec.originalStateHash = hashValue(seedManifest); seedRecord.checkpoint.kind = "live-observation";
    const effect = { agentAlias: "bob", agentDid: seedRecord.spec.agentDid, type: seedRecord.spec.type,
      destinationHash: seedRecord.spec.mailboxContactHash, payloadHash: hashValue(seedRecord.spec) };
    seedRecord.actionHash = hashValue({ actionId: seedRecord.actionId, ...effect });
    seedRecord.checkpoint.authorizationHash = seedRecord.actionHash;
    await atomicWriteJson(recoverySeed.reconciliation.path, seedRecord);
    await atomicWriteJson(resolve(recoverySeed.root, "reconciliation-approvals/bob", `${seedRecord.actionId}.json`),
      { version: 1, ...effect, actionId: seedRecord.actionId, actionHash: seedRecord.actionHash, status: "confirmed" });

    const recoveryFixture = async () => {
      const root = resolve(tmp.path, `apply-${++next}`); await cp(recoverySeed.root, root, { recursive: true });
      const runner = new FirstRehearsal({ root, passphrases: async () => { throw new Error("Recovery must never unlock"); } });
      const recPath = resolve(root, "agents/bob/reconciliation/first-room-read-v1-step-1.json");
      const transitionPath = `${runner.path}.recovery.json`;
      const files = ["cursors/bob.json", "nonces.json", "agents/bob/state.json", "agents/bob/journal.jsonl",
        "agents/alice/state.json", "agents/alice/journal.jsonl", ...ALIASES.map(alias => `identities/${alias}.json`),
        "agents/bob/reconciliation/first-room-read-v1-step-1.json", `reconciliation-approvals/bob/${seedRecord.actionId}.json`];
      const snapshot = new Map(await Promise.all(files.map(async file => [file, await readFile(resolve(root, file), "utf8")] as const)));
      const unchanged = async () => { for (const [file, content] of snapshot) assert.equal(await readFile(resolve(root, file), "utf8"), content, `Changed ${file}`); };
      return { root, runner, recPath, transitionPath, snapshot, unchanged, id: seedRecord.actionId as string, hash: seedRecord.actionHash as string,
        apply: (hooks = {}) => runner.applyReconciliation(seedRecord.actionId, seedRecord.actionHash, hooks) };
    };
    const editJson = async (file: string, mutate: (value: any) => void) => { // JSON fault injection, generated fixtures only.
      const value = JSON.parse(await readFile(file, "utf8")); mutate(value); await atomicWriteJson(file, value);
    };

    await t.test("offline apply consumes the exact live-state shape without network/unlock/work/ACK; keeps counters and history", async () => {
      const f = await recoveryFixture();
      const result = await f.apply();
      assert.equal(result.status, "applied"); assert.equal(result.nextStep, 2); assert.equal(result.step2, "planned");
      assert.equal(result.logicalPostAttempts, 1); assert.equal(result.getAttempts, 1); assert.equal(result.observationAttempts, 1);
      assert.equal(result.networkRequests, 0); assert.equal(result.cursorMutation, "unnecessary");
      const status = await f.runner.status();
      assert.equal(status.halted, null); assert.equal(status.nextStep, 2); assert.equal(status.steps[0]!.status, "received-reconciled");
      assert.equal(status.steps[1]!.status, "planned"); assert.equal(status.steps[1]!.actionId, undefined);
      assert.equal(status.steps[0]!.recovery?.originalReceive.halted, "receipt-validation-or-persistence-failed");
      assert.equal(status.steps[0]!.recovery?.reconciliation.status, "complete");
      assert.equal(status.steps[0]!.recovery?.outcome, "applied");
      assert.deepEqual(status.results, {}); await f.unchanged();
      assert.equal((await stat(resolve(f.root, "cursors/bob.json"))).mtime.toISOString(), "2020-01-01T00:00:00.000Z");
      const original = await readFile(f.runner.path, "utf8"), recovery = await readFile(f.transitionPath, "utf8");
      const repeated = await new FirstRehearsal({ root: f.root, passphrases: async () => { throw new Error("No unlock"); } }).applyReconciliation(f.id, f.hash);
      assert.equal(repeated.status, "already-applied"); assert.equal(repeated.nextStep, 2);
      assert.equal(await readFile(f.runner.path, "utf8"), original); assert.equal(await readFile(f.transitionPath, "utf8"), recovery);
      await f.unchanged(); assert.equal(network, 0);
    });

    const recoveryFaults: Record<string, (f: Awaited<ReturnType<typeof recoveryFixture>>) => Promise<void>> = {
      observationHash: f => editJson(f.recPath, r => { r.checkpoint.observationHash = "0".repeat(64); }),
      authorizationHash: f => editJson(f.recPath, r => { r.checkpoint.authorizationHash = "0".repeat(64); }),
      payloadHash: f => editJson(f.recPath, r => { r.checkpoint.payloadHash = "0".repeat(64); }),
      seq: f => editJson(f.recPath, r => { r.checkpoint.seq = 2; }),
      senderDid: f => editJson(f.recPath, r => { r.spec.expectedSenderDid = r.spec.agentDid; }),
      receiverDid: f => editJson(f.recPath, r => { r.spec.agentDid = r.spec.expectedSenderDid; }),
      missingTask: f => editJson(resolve(f.root, "agents/bob/state.json"), s => { delete s.tasks[seedRecord.checkpoint.inboundTaskId]; s.queue = []; }),
      changedTaskPayload: f => editJson(resolve(f.root, "agents/bob/state.json"), s => { s.tasks[seedRecord.checkpoint.inboundTaskId].payload.text = "changed"; }),
      wrongInboundPayloadHash: f => editJson(f.recPath, r => { r.checkpoint.inboundPayloadHash = "0".repeat(64); }),
      missingJournal: f => unlink(resolve(f.root, "agents/bob/journal.jsonl")),
      wrongJournalEvidence: async f => {
        const file = resolve(f.root, "agents/bob/journal.jsonl");
        const entry = JSON.parse((await readFile(file, "utf8")).trim()); entry.resultHash = "0".repeat(64);
        const { atomicWriteFile } = await import("../src/fs-safe.js"); await atomicWriteFile(file, JSON.stringify(entry) + "\n");
      },
      conflictingReceipt: f => editJson(f.runner.path, s => { s.steps[0].inboundTaskId = "inbound_conflict"; }),
      conflictingObservation: f => editJson(f.runner.path, s => { s.steps[0].observation = { seq: 2 }; }),
      wrongHalt: f => editJson(f.runner.path, s => { s.halted = "ambiguous-send"; }),
      incompleteReconciliation: f => editJson(f.recPath, r => { r.status = "checkpoint"; }),
      extraObservation: f => editJson(f.recPath, r => { r.attempts = 2; }),
      offlineObservation: f => editJson(f.recPath, r => { r.checkpoint.kind = "deterministic-offline"; }),
      wrongStep: f => editJson(f.recPath, r => { r.checkpoint.step = 2; }),
      wrongNextStep: f => editJson(f.runner.path, s => { s.index = 1; }),
      extraPost: f => editJson(f.runner.path, s => { s.posts = 2; }),
      extraGet: f => editJson(f.runner.path, s => { s.gets = 2; }),
      changedCursor: async f => { await createStores(f.root).cursors.advance("bob", recoverySeed.mailbox.room, 2); },
      unconfirmedAuthority: f => editJson(resolve(f.root, "reconciliation-approvals/bob", `${f.id}.json`), r => { r.status = "approved"; }),
      changedRetainedBody: f => editJson(f.recPath, r => { r.retained.peek.messages[0].text = "changed"; }),
    };
    for (const [label, mutate] of Object.entries(recoveryFaults)) await t.test(`offline apply rejects ${label} without changing main/cursor/nonce or creating recovery intent`, async () => {
      const f = await recoveryFixture(); await mutate(f);
      const before = await readFile(f.runner.path, "utf8");
      const cursor = await readFile(resolve(f.root, "cursors/bob.json"), "utf8");
      const nonce = await readFile(resolve(f.root, "nonces.json"), "utf8");
      await assert.rejects(() => f.apply());
      assert.equal(await readFile(f.runner.path, "utf8"), before);
      assert.equal(await readFile(resolve(f.root, "cursors/bob.json"), "utf8"), cursor);
      assert.equal(await readFile(resolve(f.root, "nonces.json"), "utf8"), nonce);
      await assert.rejects(() => readFile(f.transitionPath), { code: "ENOENT" }); assert.equal(network, 0);
    });

    for (const boundary of ["recovery-intent", "receipt-verified", "main-applied", "applied"] as RecoveryBoundary[]) {
      await t.test(`offline recovery crash after ${boundary}: restart finishes from local evidence, never duplicates or advances twice`, async () => {
        const f = await recoveryFixture();
        const before = await readFile(f.runner.path, "utf8");
        await assert.rejects(() => f.apply({ afterPersist: (phase: RecoveryBoundary) => {
          if (phase === boundary) throw new Error("Synthetic crash");
        } }));
        if (boundary === "recovery-intent" || boundary === "receipt-verified") {
          assert.equal(await readFile(f.runner.path, "utf8"), before);
        } else assert.equal((await f.runner.status()).steps[0]!.status, "received-reconciled");
        const restarted = new FirstRehearsal({ root: f.root, passphrases: async () => { throw new Error("No recovery unlock"); } });
        await restarted.applyReconciliation(f.id, f.hash);
        const status = await restarted.status(); assert.equal(status.nextStep, 2); assert.equal(status.halted, null);
        assert.equal(status.steps[1]!.status, "planned"); assert.equal(status.getAttempts, 1); assert.equal(status.logicalPostAttempts, 1);
        assert.equal((await restarted.applyReconciliation(f.id, f.hash)).status, "already-applied");
        await f.unchanged(); assert.equal(network, 0);
      });
    }

    await t.test("changed evidence after recovery-intent remains safely halted and requires no GET", async () => {
      const f = await recoveryFixture(); const before = await readFile(f.runner.path, "utf8");
      await assert.rejects(() => f.apply({ afterPersist: (phase: RecoveryBoundary) => {
        if (phase === "recovery-intent") throw new Error("Synthetic crash");
      } }));
      await editJson(f.recPath, r => { r.checkpoint.observationHash = "a".repeat(64); });
      await assert.rejects(() => f.apply()); assert.equal(await readFile(f.runner.path, "utf8"), before); assert.equal(network, 0);
    });

    for (const boundary of ["recovery-intent", "receipt-verified", "main-applied", "applied"] as RecoveryBoundary[]) {
      await t.test(`process exit after ${boundary}: dead-process locks recover without GET or duplicate receipt`, async () => {
        const f = await recoveryFixture(); const before = await readFile(f.runner.path, "utf8");
        const program = `
          import { Socket } from 'node:net';
          import { resolve } from 'node:path';
          import { pathToFileURL } from 'node:url';
          Socket.prototype.connect = () => { throw new Error('Network forbidden'); };
          globalThis.fetch = () => { throw new Error('Network forbidden'); };
          const { FirstRehearsal } = await import(pathToFileURL(resolve('dist/src/rehearsal/runner.js')).href);
          const [root, id, hash, boundary] = process.argv.slice(1);
          const runner = new FirstRehearsal({ root, passphrases: async () => { throw new Error('Unlock forbidden'); } });
          await runner.applyReconciliation(id, hash, { afterPersist: phase => { if (phase === boundary) process.exit(73); } });
        `;
        const child = spawnSync(process.execPath, ["--input-type=module", "-e", program, f.root, f.id, f.hash, boundary],
          { encoding: "utf8", timeout: 5000 });
        assert.equal(child.status, 73); assert.equal(child.stdout, ""); assert.equal(child.stderr, "");
        if (boundary === "recovery-intent" || boundary === "receipt-verified") assert.equal(await readFile(f.runner.path, "utf8"), before);
        await f.apply(); assert.equal((await f.runner.status()).nextStep, 2);
        assert.equal((await f.apply()).status, "already-applied"); await f.unchanged();
      });
    }

    await t.test("apply does not run Bob; only a later explicit work command processes the bound inbound and enables preparation", async () => {
      const f = await recoveryFixture(); await f.apply(); await f.unchanged();
      const runner = new FirstRehearsal({ root: f.root, passphrases: passphrases.provider });
      await runner.work("bob", analysis("bob"));
      const prepared = await runner.prepare(); assert.equal(prepared.senderAlias, "bob"); assert.equal(prepared.destinationAlias, "alice");
      const status = await runner.status(); assert.equal(status.steps[1]!.status, "prepared");
      assert.equal(status.getAttempts, 1); assert.equal(status.logicalPostAttempts, 1); assert.equal(network, 0);
      const afterWork = await readFile(runner.path, "utf8");
      assert.equal((await f.apply()).status, "already-applied");
      assert.equal(await readFile(runner.path, "utf8"), afterWork);
    });

    await t.test("reconcile-apply CLI is offline, idempotent and secret-free in success and error output", async () => {
      const f = await recoveryFixture();
      const guard = "import {Socket} from 'node:net'; Socket.prototype.connect=()=>{throw new Error('Network forbidden')}; globalThis.fetch=()=>{throw new Error('Network forbidden')};";
      const env: NodeJS.ProcessEnv = { ...process.env, TECHNOCORE_HOME: f.root }; delete env.TECHNOCORE_URL;
      const invoke = (id: string, hash: string) => spawnSync(process.execPath,
        ["--import", `data:text/javascript,${encodeURIComponent(guard)}`, resolve("dist/src/cli.js"), "rehearsal:reconcile-apply", id, hash],
        { env, encoding: "utf8", timeout: 5000 });
      const success = invoke(f.id, f.hash), repeated = invoke(f.id, f.hash);
      assert.equal(success.status, 0); assert.equal(repeated.status, 0);
      assert.equal(JSON.parse(repeated.stdout).status, "already-applied");
      const invalid = invoke(recoverySeed.mailbox.room, "wrong"); assert.equal(invalid.status, 1);
      const output = [success, repeated, invalid].map(r => r.stdout + r.stderr).join("") + await readFile(f.transitionPath, "utf8");
      assert.equal(output.includes(recoverySeed.mailbox.room), false); assert.equal(output.includes(seedManifest.steps[0].text), false);
      for (const bytes of identityBytes.values()) assert.equal(output.includes(JSON.parse(bytes).encryptedPrivateKey.ciphertext), false);
      await f.unchanged();
    });

    // Build the historical Step 2 failure shape solely from temporary generated identities.
    const sendSeed = await recoveryFixture(); await sendSeed.apply();
    await editJson(sendSeed.runner.path, s => { s.mode = "offline"; });
    const sendTransport = new FixtureTransport(); sendTransport.failPost = "400";
    const sendRunner = new FirstRehearsal({ root: sendSeed.root, passphrases: passphrases.provider, offlineTransport: sendTransport });
    await sendRunner.work("bob", analysis("bob"));
    const outbound = await sendRunner.prepare();
    await createStores(sendSeed.root).approvals.grant("bob", outbound.actionId!, outbound.actionHash!);
    await assert.rejects(() => sendRunner.send(outbound.actionId!, outbound.actionHash!));
    const sendManifest = JSON.parse(await readFile(sendRunner.path, "utf8"));
    assert.equal(sendManifest.halted, "send-failed"); assert.equal(sendManifest.steps[1].status, "post-intent");
    const bobFailure = JSON.parse(await readFile(resolve(sendSeed.root, "agents/bob/state.json"), "utf8")).tasks.rehearsal_send_2;
    assert.equal(bobFailure.status, "failed"); assert.equal(bobFailure.error.outbound.status, 400);
    assert.equal(bobFailure.error.outbound.nonceReservation, "reserved"); assert.equal(bobFailure.error.outbound.dispatchBegan, true);

    const sendFixture = async () => {
      const root = resolve(tmp.path, `send-rec-${++next}`); await cp(sendSeed.root, root, { recursive: true });
      const stores = createStores(root); const mailbox = await stores.mailboxes.load("alice");
      let gets = 0; let posts = 0;
      const exact = { seq: 1, ts: new Date(0).toISOString(), from: sendManifest.dids.bob, nonce: 1, text: sendManifest.steps[1].text };
      let view: RoomResponse = { room: mailbox.room, count: 1, first_seq: 1, last_seq: 1, messages: [exact] };
      let readError: unknown;
      const transport = { readRoomJson: async (room: string, query?: ReadRoomOptions) => {
        gets++; assert.equal(room, mailbox.room); assert.deepEqual(query, SEND_READ_QUERY);
        if (readError) throw readError; return structuredClone(view);
      }, readRoomText: async (): Promise<string> => { throw new Error("Text GET forbidden"); },
      sendSignedMessage: async (): Promise<RoomResponse> => { posts++; throw new Error("POST forbidden"); } };
      const options = { root, passphrases: async (): Promise<Buffer> => { throw new Error("Unlock forbidden"); }, offlineTransport: transport };
      const recovery = new SendReconciliation(options); const runner = new FirstRehearsal(options);
      const snapshots = new Map<string, string>();
      const walk = async (dir: string) => { for (const e of await readdir(dir, { withFileTypes: true })) {
        const path = resolve(dir, e.name); if (e.isDirectory()) await walk(path); else snapshots.set(path, await readFile(path, "utf8"));
      } }; await walk(root);
      const unchanged = async (allowMain = false) => { for (const [path, bytes] of snapshots) {
        if (!(allowMain && path === runner.path)) assert.equal(await readFile(path, "utf8"), bytes, `Protected test state changed: ${path}`);
      } };
      const proposed = await recovery.prepare(2); const id = proposed.authorizationId, hash = proposed.authorizationHash;
      return { root, stores, mailbox, exact, recovery, runner, id, hash, transport,
        file: resolve(root, "send-reconciliation", `${id}.json`),
        authorize: () => recovery.authorize(id, hash), observe: (hooks = {}) => recovery.observe(id, hash, hooks),
        apply: (hooks = {}) => recovery.apply(id, hash, hooks), unchanged,
        counts: () => ({ gets, posts }), setView: (v: RoomResponse) => { view = v; }, setError: (e: unknown) => { readError = e; } };
    };

    await t.test("send reconciliation: exact Step 2 observation -> offline atomic apply; original failed task and Step 1 remain unchanged", async () => {
      const f = await sendFixture(); await assert.rejects(() => f.observe()); assert.deepEqual(f.counts(), { gets: 0, posts: 0 });
      await f.authorize(); const observed = await f.observe(); assert.equal(observed.status, "observed"); await f.unchanged();
      assert.equal((await f.runner.status()).halted, "send-failed");
      assert.equal((await f.apply()).status, "applied"); await f.unchanged(true);
      const state = await f.runner.status(); assert.equal(state.nextStep, 2); assert.equal(state.halted, null);
      assert.equal(state.steps[1]!.status, "sent-reconciled"); assert.equal(state.steps[1]!.seq, 1); assert.equal(state.steps[2]!.status, "planned");
      assert.equal(state.logicalPostAttempts, 2); assert.equal(state.getAttempts, 1);
      const before = await readFile(f.runner.path, "utf8"), record = await readFile(f.file, "utf8");
      assert.equal((await f.apply()).status, "already-applied");
      assert.equal(await readFile(f.runner.path, "utf8"), before); assert.equal(await readFile(f.file, "utf8"), record);
      await assert.rejects(() => f.observe()); await assert.rejects(() => f.authorize());
      assert.deepEqual(f.counts(), { gets: 1, posts: 0 });
      const output = JSON.stringify([observed, state]) + record;
      assert.equal(output.includes(f.mailbox.room), false); assert.equal(output.includes(f.exact.text), false);
      for (const bytes of identityBytes.values()) assert.equal(output.includes(JSON.parse(bytes).encryptedPrivateKey.ciphertext), false);
    });

    const viewFaults: Record<string, (f: Awaited<ReturnType<typeof sendFixture>>) => RoomResponse> = {
      wrongSender: f => ({ count: 1, first_seq: 1, last_seq: 1, messages: [{ ...f.exact, from: sendManifest.dids.alice }] }),
      wrongMailbox: f => ({ room: "different", count: 1, first_seq: 1, last_seq: 1, messages: [f.exact] }),
      unverifiedSender: f => ({ count: 1, first_seq: 1, last_seq: 1, messages: [{ ...f.exact, nonce: undefined } as unknown as RoomResponse["messages"][number]] }),
      wrongReceiver: f => ({ count: 1, first_seq: 1, last_seq: 1, messages: [{ ...f.exact, text: JSON.stringify({ ...JSON.parse(f.exact.text), to: sendManifest.dids.bob }) }] }),
      wrongStep: f => ({ count: 1, first_seq: 1, last_seq: 1, messages: [{ ...f.exact, text: JSON.stringify({ ...JSON.parse(f.exact.text), step: 4 }) }] }),
      wrongKind: f => ({ count: 1, first_seq: 1, last_seq: 1, messages: [{ ...f.exact, text: JSON.stringify({ ...JSON.parse(f.exact.text), kind: "task" }) }] }),
      wrongPayload: f => ({ count: 1, first_seq: 1, last_seq: 1, messages: [{ ...f.exact, text: "another Bob message" }] }),
      empty: () => ({ count: 0, first_seq: null, last_seq: 0, messages: [] }),
      duplicateMatching: f => ({ count: 2, first_seq: 1, last_seq: 2, messages: [f.exact, { ...f.exact, seq: 2 }] }),
      unrelatedMessages: f => ({ count: 2, first_seq: 1, last_seq: 2, messages: [{ ...f.exact, text: "unrelated one" }, { ...f.exact, seq: 2, text: "unrelated two" }] }),
      retentionWindow: () => ({ count: 0, first_seq: 300, last_seq: 500, messages: [] }),
    };
    for (const [name, makeView] of Object.entries(viewFaults)) await t.test(`send reconciliation ${name}: no false proof, resend, ACK or second GET`, async () => {
      const f = await sendFixture(); f.setView(makeView(f)); await f.authorize(); const result = await f.observe();
      assert.notEqual(result.status, "observed"); await assert.rejects(() => f.apply()); await assert.rejects(() => f.observe());
      await f.unchanged(); assert.deepEqual(f.counts(), { gets: 1, posts: 0 });
      assert.equal(JSON.stringify(result).includes("unrelated one"), false);
      if (result.status === "not-observed") assert.match(result.warning!, /No resend authorized/);
    });
    await t.test("send reconciliation can find exact payload among unrelated retained messages without exposing them", async () => {
      const f = await sendFixture(); f.setView({ count: 2, first_seq: 1, last_seq: 2, messages: [f.exact, { ...f.exact, seq: 2, text: "unrelated secret" }] });
      await f.authorize(); const result = await f.observe(); assert.equal(result.status, "observed");
      assert.equal(JSON.stringify(result).includes("unrelated secret"), false); await f.unchanged();
    });
    for (const [name, error] of Object.entries({ parse: new SyntaxError("private bytes"), http400: new TransportError("private bytes", 400),
      http503: new TransportError("private bytes", 503), timeout: Object.assign(new Error("private bytes"), { code: "ETIMEDOUT" }),
      reset: Object.assign(new Error("private bytes"), { code: "ECONNRESET" }) })) await t.test(`send observation ${name}: durable failure, one GET, no retry`, async () => {
      const f = await sendFixture(); f.setError(error); await f.authorize(); const result = await f.observe();
      assert.equal(result.status, "failed"); assert.equal(JSON.stringify(result).includes("private bytes"), false);
      await assert.rejects(() => f.observe()); await assert.rejects(() => f.apply()); await f.unchanged();
      assert.deepEqual(f.counts(), { gets: 1, posts: 0 });
    });
    for (const name of ["authorization", "actionHash", "state", "cursor", "contact", "payloadHash"] as const) await t.test(`send read authorization binds ${name} before network`, async () => {
      const f = await sendFixture(); await f.authorize();
      if (name === "authorization") { await assert.rejects(() => f.recovery.observe(f.id, "0".repeat(64))); }
      else {
        if (name === "actionHash") await editJson(f.runner.path, s => { s.steps[1].actionHash = "0".repeat(64); });
        if (name === "payloadHash") await editJson(f.file, r => { r.spec.payloadHash = "0".repeat(64); });
        if (name === "state") await editJson(f.runner.path, s => { s.gets = 2; });
        if (name === "cursor") await f.stores.cursors.advance("alice", f.mailbox.room, 1);
        if (name === "contact") await editJson(resolve(f.root, "contacts/bob.json"), c => { c.contacts.alice.did = sendManifest.dids.bob; });
        await assert.rejects(() => f.observe());
      }
      assert.deepEqual(f.counts(), { gets: 0, posts: 0 });
    });
    for (const boundary of ["get-intent", "observation-validated", "observation-persisted", "apply-intent", "main-applied", "applied"] as SendRecoveryBoundary[]) {
      await t.test(`send reconciliation crash ${boundary}: durable quarantine or offline completion`, async () => {
        const f = await sendFixture(); await f.authorize(); const crash = { afterBoundary: (p: SendRecoveryBoundary) => { if (p === boundary) throw new Error("Crash"); } };
        if (["get-intent", "observation-validated", "observation-persisted"].includes(boundary)) {
          await assert.rejects(() => f.observe(crash)); await assert.rejects(() => f.observe());
          if (boundary === "observation-persisted") { await f.apply(); await f.unchanged(true); }
          else { await assert.rejects(() => f.apply()); await f.unchanged(); }
        } else { await f.observe(); await assert.rejects(() => f.apply(crash)); await f.apply(); await f.unchanged(true); }
        assert.deepEqual(f.counts(), { gets: boundary === "get-intent" ? 0 : 1, posts: 0 });
      });
    }
    await t.test("send reconciliation HTTP adapter is injected: exact GET query, redirects disabled, no retries", async () => {
      const f = await sendFixture(); let calls = 0;
      const http = new HttpTechnocoreTransport("https://example.test", { readRetries: 0, rateLimitRetries: 0, readRedirect: "error",
        httpsRequest: () => { throw new Error("POST forbidden"); }, fetch: async (input, init) => {
          calls++; const url = new URL(input); assert.equal(init?.method, "GET"); assert.equal(init.redirect, "error");
          assert.equal(url.searchParams.get("since"), "0"); assert.equal(url.searchParams.get("limit"), "200");
          return Response.json({ count: 1, first_seq: 1, last_seq: 1, messages: [f.exact] });
        } });
      await f.authorize(); const rec = new SendReconciliation({ root: f.root, passphrases: passphrases.provider, offlineTransport: http });
      assert.equal((await rec.observe(f.id, f.hash)).status, "observed"); assert.equal(calls, 1); await f.unchanged();
    });
    await t.test("normal receive after send-apply remains explicit and preserves the original failed outbound task", async () => {
      const f = await sendFixture(); await f.authorize(); await f.observe(); await f.apply();
      const bobBefore = await readFile(resolve(f.root, "agents/bob/state.json"), "utf8");
      const runner = new FirstRehearsal({ root: f.root, passphrases: passphrases.provider, offlineTransport: f.transport });
      await runner.receive(2); assert.equal((await runner.status()).nextStep, 3);
      assert.equal(await readFile(resolve(f.root, "agents/bob/state.json"), "utf8"), bobBefore);
      const mainBefore = await readFile(runner.path, "utf8"); assert.equal((await f.apply()).status, "already-applied");
      assert.equal(await readFile(runner.path, "utf8"), mainBefore);
    });
    for (const target of ["observation", "task", "cursor", "state", "contact"] as const) await t.test(`send apply rejects changed ${target} after observation`, async () => {
      const f = await sendFixture(); await f.authorize(); await f.observe();
      if (target === "observation") await editJson(f.file, r => { r.observation.match.payloadHash = "0".repeat(64); });
      if (target === "task") await editJson(resolve(f.root, "agents/bob/state.json"), s => { s.tasks.rehearsal_send_2.attempts = 2; });
      if (target === "cursor") await f.stores.cursors.advance("alice", f.mailbox.room, 1);
      if (target === "state") await editJson(f.runner.path, s => { s.gets = 2; });
      if (target === "contact") await editJson(resolve(f.root, "contacts/bob.json"), c => { c.contacts.alice.did = sendManifest.dids.bob; });
      const before = await readFile(f.runner.path, "utf8"); await assert.rejects(() => f.apply());
      assert.equal(await readFile(f.runner.path, "utf8"), before); assert.deepEqual(f.counts(), { gets: 1, posts: 0 });
    });
    for (const boundary of ["apply-intent", "main-applied", "applied"] as SendRecoveryBoundary[]) await t.test(`send apply process exit ${boundary} recovers offline`, async () => {
      const f = await sendFixture(); await f.authorize(); await f.observe();
      const program = `import {Socket} from 'node:net'; Socket.prototype.connect=()=>{throw new Error('Network forbidden')};
        globalThis.fetch=()=>{throw new Error('Network forbidden')};
        const {SendReconciliation}=await import('./dist/src/rehearsal/send-reconciliation.js');
        const [root,id,hash,boundary]=process.argv.slice(1); const denied=async()=>{throw new Error('IO forbidden')};
        const rec=new SendReconciliation({root,passphrases:denied,offlineTransport:{readRoomJson:denied,readRoomText:denied,sendSignedMessage:denied}});
        await rec.apply(id,hash,{afterBoundary:p=>{if(p===boundary)process.exit(75)}});`;
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", program, f.root, f.id, f.hash, boundary], { encoding: "utf8", timeout: 5000 });
      assert.equal(child.status, 75); assert.equal(child.stdout + child.stderr, "");
      await f.apply(); assert.equal((await f.apply()).status, "already-applied"); await f.unchanged(true);
      assert.deepEqual(f.counts(), { gets: 1, posts: 0 });
    });
    await t.test("send reconciliation CLI prepare/authorize/status are local and secret-free", async () => {
      const root = resolve(tmp.path, `send-cli-${++next}`); await cp(sendSeed.root, root, { recursive: true });
      const main = resolve(root, "agents/alice/rehearsal/first-room-read-v1.json");
      await editJson(main, s => { s.mode = "live"; }); // Synthetic metadata only; no network transport invoked.
      const before = await readFile(main, "utf8");
      const guard = "import {Socket} from 'node:net'; Socket.prototype.connect=()=>{throw new Error('Network forbidden')};globalThis.fetch=()=>{throw new Error('Network forbidden')};";
      const env: NodeJS.ProcessEnv = { ...process.env, TECHNOCORE_HOME: root }; delete env.TECHNOCORE_URL;
      const cli = (...args: string[]) => spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(guard)}`, resolve("dist/src/cli.js"), ...args], { env, encoding: "utf8", timeout: 5000 });
      const prepare = cli("rehearsal:send-reconcile-prepare", "2"); assert.equal(prepare.status, 0);
      const p = JSON.parse(prepare.stdout);
      const auth = cli("rehearsal:send-reconcile-authorize", p.authorizationId, p.authorizationHash); assert.equal(auth.status, 0);
      const status = cli("rehearsal:send-reconcile-status", p.authorizationId, p.authorizationHash); assert.equal(status.status, 0);
      assert.equal(JSON.parse(status.stdout).observationAttempts, 0);
      const earlyApply = cli("rehearsal:send-reconcile-apply", p.authorizationId, p.authorizationHash); assert.equal(earlyApply.status, 1);
      const output = [prepare, auth, status, earlyApply].map(r => r.stdout + r.stderr).join("");
      const mailbox = await createStores(root).mailboxes.load("alice"); assert.equal(output.includes(mailbox.room), false);
      assert.equal(output.includes(sendManifest.steps[1].text), false); assert.equal(await readFile(main, "utf8"), before);
    });
    assert.equal(network, 0);
    assert.deepEqual((await readdir(resolve(base, "identities"))).sort(), ALIASES.map(n => `${n}.json`).sort());
  } finally {
    Socket.prototype.connect = connect;
    passphrases.cleanup(); await tmp.cleanup();
  }
});
