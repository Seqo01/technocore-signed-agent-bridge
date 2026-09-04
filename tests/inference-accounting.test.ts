import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Socket } from "node:net";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { before, after, test } from "node:test";
import { AccountedInferenceProvider, InferenceLedger, defaultInferenceBudgets, freezeInferenceContext, validateInferenceBudgets,
  type InferenceExecutionContext, type InferenceBudgets } from "../src/agent/inference-accounting.js";
import type { InferenceMetadata, InferenceRequest, InferenceResult } from "../src/agent/types.js";
import { publicKeyBytesToDid } from "../src/protocol.js";
import { hashValue } from "../src/agent/util.js";
import { atomicWriteJson } from "../src/fs-safe.js";
import { temporaryDirectory } from "./helpers.js";

function did(): string {
  const { publicKey } = generateKeyPairSync("ed25519");
  return publicKeyBytesToDid(Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url"));
}
const agent = did(), other = did(), requester = did();
let networkCalls = 0;
const originalConnect = Socket.prototype.connect;
before(() => { Socket.prototype.connect = function () { networkCalls++; throw new Error("Network forbidden in accounting tests"); } as typeof Socket.prototype.connect; });
after(() => { Socket.prototype.connect = originalConnect; assert.equal(networkCalls, 0); });

function context(request: Readonly<InferenceRequest>, overrides: Partial<InferenceExecutionContext> = {}): InferenceExecutionContext {
  return { agentDid: agent, sessionId: "session-fixture", jobId: "job-fixture", taskId: request.taskId,
    rootRequesterDid: requester, rootOrigin: "external", rootTrust: "external-approved", workloadType: request.taskType,
    workloadVersion: 1, authorityId: hashValue("fixture-authority"), providerMode: "configured", ...overrides };
}
function request(taskId = "task1", input: unknown = {}): InferenceRequest { return { requestId: `req_${hashValue(taskId).slice(0, 32)}`, taskId, taskType: "workload.research", input }; }
function success(extra: Partial<InferenceMetadata> = {}): InferenceResult {
  return { outcome: "success", output: { localFixture: true }, metadata: { provider: "fixture-provider", model: "fixture-model", ...extra } };
}
async function fixture(budgets = defaultInferenceBudgets(10), handler: (r: InferenceRequest) => Promise<InferenceResult> = async () => success()) {
  const tmp = await temporaryDirectory(); let calls = 0;
  const path = resolve(tmp.path, "inference.json");
  const p = { name: "fixture-provider", infer: async (r: InferenceRequest) => { calls++; return handler(r); } };
  const gateway = new AccountedInferenceProvider(p, { path, budgets, context, timeoutMs: 100 });
  return { tmp, path, gateway, p, calls: () => calls };
}

test("attribution is host-created, frozen, request-hashed and durably reserved before dispatch", async () => {
  const f = await fixture();
  try {
    f.p.infer = async r => {
      assert.equal(Object.isFrozen(r.executionContext), true);
      assert.equal(r.executionContext!.agentDid, agent);
      assert.throws(() => Object.assign(r.executionContext!, { agentDid: other }));
      const [a] = await f.gateway.ledger.read();
      assert.equal(a!.state, "running");
      assert.deepEqual(a!.history.map(h => h.state), ["planned", "reserved", "running"]);
      assert.equal(a!.requestHash, hashValue(r)); return success();
    };
    const result = await f.gateway.infer(request("task1", { agentDid: other, sessionId: "malicious", jobId: "malicious", authorityId: "malicious" }));
    const a = (await f.gateway.ledger.read())[0]!;
    assert.equal(a.context.agentDid, agent); assert.equal(a.context.rootRequesterDid, requester);
    assert.equal(a.context.sessionId, "session-fixture"); assert.equal(a.context.jobId, "job-fixture"); assert.equal(a.context.taskId, "task1");
    assert.equal(a.context.rootOrigin, "external"); assert.equal(a.context.authorityId, hashValue("fixture-authority"));
    assert.equal(result.metadata.accounting!.attemptId, a.attemptId); assert.equal(a.providerMetadataHash, result.metadata.accounting!.providerMetadataHash);
    assert.equal(a.resultHash, hashValue({ localFixture: true }));
    const malicious = { ...request("task2"), executionContext: context(request("task2"), { agentDid: other }) };
    await assert.rejects(f.gateway.infer(malicious), /context mismatch/);
    assert.equal((await f.gateway.ledger.read()).length, 1);
  } finally { await f.tmp.cleanup(); }
});

for (const scope of ["session", "agent", "job"] as const) {
  test(`${scope} attempt limit blocks BEFORE the provider, with durable cancellation`, async () => {
    const budgets = defaultInferenceBudgets(10); budgets[scope].maxAttempts = 1;
    const f = await fixture(budgets);
    try {
      await f.gateway.infer(request("one"));
      const result = await f.gateway.infer(request("two"));
      assert.equal(result.outcome, "failure"); assert.equal(f.calls(), 1);
      const a = (await f.gateway.ledger.read())[1]!;
      assert.equal(a.state, "cancelled"); assert.equal(a.error, "budget-denied");
      assert.deepEqual(a.history.map(h => h.state), ["planned", "cancelled"]);
    } finally { await f.tmp.cleanup(); }
  });
}

test("separate DID/job buckets and a shared session budget remain separate", async () => {
  const budgets = defaultInferenceBudgets(10); budgets.agent.maxAttempts = 1; budgets.job.maxAttempts = 1;
  const f = await fixture(budgets);
  try {
    await f.gateway.infer(request("one"));
    const second = new AccountedInferenceProvider(f.p, { path: f.path, budgets, context: r => context(r, { agentDid: other, jobId: "job-other" }) });
    assert.equal((await second.infer(request("two"))).outcome, "success");
    assert.equal((await f.gateway.ledger.summary({ agentDid: agent })).attempts, 1);
    assert.equal((await f.gateway.ledger.summary({ agentDid: other })).attempts, 1);
    assert.equal((await f.gateway.ledger.summary()).attempts, 2);
    assert.equal((await f.gateway.ledger.summary({ sessionId: "another" })).attempts, 0);
  } finally { await f.tmp.cleanup(); }
});

function economic(): InferenceBudgets {
  const b = defaultInferenceBudgets(10);
  b.session.spend = { asset: "TEST", network: "fixture", max: "1", reservePerAttempt: "1" };
  return b;
}
test("successful decimal usage and provider-reported spend are accounted, never promoted to verified", async () => {
  const b = economic(); b.session.spend!.reservePerAttempt = "0.5";
  b.session.usage = [{ unit: "tokens", max: "10", reservePerAttempt: "5" }];
  const f = await fixture(b, async () => success({ usage: { tokens: "2" }, spend: { asset: "TEST", network: "fixture", amount: "0.1" } }));
  try {
    await f.gateway.infer(request("one")); await f.gateway.infer(request("two"));
    const s = await f.gateway.ledger.summary();
    assert.equal(s.reportedSpend["fixture/TEST/provider-reported"], "0.2");
    assert.equal(s.usage["fixture-provider/provider-reported/tokens"], "4");
    assert.equal(s.unknownSpendAttempts, 0); assert.equal(s.verifiedSpend, "unsupported");
    assert.equal(s.reservations.length, 0);
  } finally { await f.tmp.cleanup(); }
});
test("missing spend is unknown and the economic reservation is not released after success", async () => {
  const f = await fixture(economic());
  try {
    await f.gateway.infer(request());
    assert.equal((await f.gateway.infer(request("next"))).outcome, "failure");
    const s = await f.gateway.ledger.summary();
    assert.equal(s.unknownSpendAttempts, 1); assert.deepEqual(s.reportedSpend, {});
    assert.equal(s.reservations[0]!.scopes[0]!.amount, "1"); assert.equal(f.calls(), 1);
  } finally { await f.tmp.cleanup(); }
});
test("usage reservations are enforced, including missing units and over-reported units", async () => {
  for (const usage of [undefined, { tokens: "8" }]) {
    const b = defaultInferenceBudgets(10); b.job.usage = [{ unit: "tokens", max: "5", reservePerAttempt: "5" }];
    const f = await fixture(b, async () => success(usage ? { usage } : {}));
    try {
      const r = await f.gateway.infer(request()); assert.equal(r.outcome, usage ? "ambiguous" : "success");
      assert.equal((await f.gateway.infer(request("second"))).outcome, "failure"); assert.equal(f.calls(), 1);
    } finally { await f.tmp.cleanup(); }
  }
});
test("timeout holds budget, does not rerun, and ignores a late provider success", async () => {
  let finish!: (r: InferenceResult) => void;
  const f = await fixture(economic(), () => new Promise(resolve => { finish = resolve; }));
  try {
    const r = await f.gateway.infer(request()); assert.equal(r.outcome, "ambiguous");
    assert.equal((await f.gateway.ledger.read())[0]!.error, "provider-timeout");
    finish(success({ spend: { asset: "TEST", network: "fixture", amount: "0" } }));
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(f.gateway.infer(request()), /no automatic retry/);
    await assert.rejects(f.gateway.infer({ ...request(), requestId: "req_another" }), /no automatic retry/);
    assert.equal((await f.gateway.infer(request("second"))).outcome, "failure");
    const s = await f.gateway.ledger.summary(); assert.equal(s.ambiguous, 1); assert.equal(s.reservations[0]!.scopes[0]!.amount, "1"); assert.equal(f.calls(), 1);
  } finally { await f.tmp.cleanup(); }
});
test("provider exception/cancellation is ambiguous; raw error text never leaves the boundary", async () => {
  const secret = randomBytes(24).toString("hex");
  const f = await fixture(economic(), async () => { throw Object.assign(new Error(secret), { name: secret }); });
  try {
    const result = await f.gateway.infer(request()); assert.equal(result.outcome, "ambiguous");
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal((await readFile(f.path, "utf8")).includes(secret), false);
  } finally { await f.tmp.cleanup(); }
});
test("offline usage is explicitly synthetic and offline providers cannot claim FLOP spend", async () => {
  for (const claimSpend of [false, true]) {
    const f = await fixture();
    try {
      f.p.infer = async () => success({ usage: { requests: "1" }, ...(claimSpend ? { spend: { asset: "FLOP", network: "testnet", amount: "0" } } : {}) });
      const p = new AccountedInferenceProvider(f.p, { path: f.path, budgets: defaultInferenceBudgets(10), context: r => context(r, { providerMode: "offline" }) });
      const r = await p.infer(request());
      assert.equal(r.outcome, claimSpend ? "ambiguous" : "success");
      assert.equal(r.metadata.usageStatus, claimSpend ? "unknown" : "synthetic");
      const s = await p.ledger.summary(); assert.equal(s.offlineAttempts, 1); assert.deepEqual(s.reportedSpend, {});
      assert.equal((await readFile(f.path, "utf8")).includes("FLOP"), false);
    } finally { await f.tmp.cleanup(); }
  }
});
test("opaque references are hashed, extra provider fields discarded and inspection is read-only/secret-free", async () => {
  const secret = randomBytes(40).toString("hex"), capability = ["mb", "p", secret].join("-");
  const f = await fixture(defaultInferenceBudgets(10), async () => success({ providerRequestId: secret, providerResultId: capability,
    ...{ authorization: secret, signature: secret, verifiedSpend: true, rawResponse: { secret } } }));
  try {
    const r = await f.gateway.infer(request());
    assert.equal(r.metadata.providerRequestId, hashValue(secret)); assert.equal(r.metadata.providerResultId, hashValue(capability));
    const before = await readFile(f.path, "utf8"), files = await readdir(f.tmp.path);
    const text = execFileSync(process.execPath, [resolve("dist/src/cli.js"), "inference:usage", f.path, "--did", agent], { encoding: "utf8" });
    assert.equal(JSON.parse(text).attempts, 1); assert.equal(text.includes(secret), false); assert.equal(before.includes(secret), false);
    assert.equal(await readFile(f.path, "utf8"), before); assert.deepEqual(await readdir(f.tmp.path), files);
    const bad = JSON.parse(before); bad.attempts[0].secret = secret; await atomicWriteJson(f.path, bad);
    await assert.rejects(new InferenceLedger(f.path).summary(), e => e instanceof Error && !e.message.includes(secret));
  } finally { await f.tmp.cleanup(); }
});
test("secret-bearing model identifiers fail closed without persisting the raw metadata", async () => {
  const capability = ["mb", "p", randomBytes(20).toString("hex")].join("-");
  const f = await fixture(defaultInferenceBudgets(10), async () => success({ model: capability }));
  try {
    assert.equal((await f.gateway.infer(request())).outcome, "ambiguous");
    assert.equal((await readFile(f.path, "utf8")).includes(capability), false);
  } finally { await f.tmp.cleanup(); }
});
for (const phase of [1, 2, 3, 4]) {
  test(`crash at durable write ${phase}: reopen never reruns or releases uncertainty`, async () => {
    const f = await fixture(economic()); const save = f.gateway.ledger.save.bind(f.gateway.ledger); let writes = 0;
    f.gateway.ledger.save = async data => { await save(data); if (++writes === phase) throw new Error("Injected persistence interruption"); };
    try {
      await assert.rejects(f.gateway.infer(request()));
      const reopened = new AccountedInferenceProvider(f.p, { path: f.path, budgets: economic(), context });
      await assert.rejects(reopened.infer(request()));
      assert.equal(f.calls(), phase < 4 ? 0 : 1);
      assert.equal((await reopened.ledger.read()).length, 1);
    } finally { await f.tmp.cleanup(); }
  });
}
test("concurrent gateway instances cannot oversubscribe an attempt budget", async () => {
  const b = defaultInferenceBudgets(1); const f = await fixture(b);
  try {
    const second = new AccountedInferenceProvider(f.p, { path: f.path, budgets: b, context });
    const results = await Promise.all([f.gateway.infer(request("one")), second.infer(request("two"))]);
    assert.equal(results.filter(r => r.outcome === "success").length, 1); assert.equal(f.calls(), 1);
  } finally { await f.tmp.cleanup(); }
});
test("budget policy changes, invalid decimals and context classifications fail closed", async () => {
  const f = await fixture();
  try {
    await f.gateway.infer(request());
    const second = new AccountedInferenceProvider(f.p, { path: f.path, budgets: defaultInferenceBudgets(20), context });
    await assert.rejects(second.infer(request("two"))); assert.equal(f.calls(), 1);
    for (const value of ["NaN", "-1", "1e5", "0.0000000000000000001"]) {
      const b = economic(); b.session.spend!.max = value; assert.throws(() => validateInferenceBudgets(b));
    }
    assert.throws(() => freezeInferenceContext(context(request(), { rootTrust: "operator-local" })));
  } finally { await f.tmp.cleanup(); }
});

test("provider-reported backend name cannot replace the host-selected adapter identity", async () => {
  const f = await fixture(defaultInferenceBudgets(10), async () => success({ provider: "another-backend" }));
  try {
    const result = await f.gateway.infer(request());
    assert.equal(result.outcome, "success"); assert.equal(result.metadata.provider, "fixture-provider");
    assert.equal((await f.gateway.ledger.read())[0]!.provider, "fixture-provider");
  } finally { await f.tmp.cleanup(); }
});

test("pending billing retains a full spend reservation even when the provider reports zero", async () => {
  const f = await fixture(economic(), async () => success({ billingStatus: "pending", spend: { asset: "TEST", network: "fixture", amount: "0" } }));
  try {
    assert.equal((await f.gateway.infer(request())).outcome, "success");
    assert.equal((await f.gateway.infer(request("second"))).outcome, "failure");
    const s = await f.gateway.ledger.summary(); assert.equal(s.reservations[0]!.scopes[0]!.amount, "1"); assert.equal(f.calls(), 1);
  } finally { await f.tmp.cleanup(); }
});

test("a conclusive provider failure is recorded separately from ambiguous compute", async () => {
  const f = await fixture(defaultInferenceBudgets(10), async () => ({ outcome: "failure", retrySafe: false,
    errorCode: "FIXTURE_REFUSAL", metadata: { provider: "fixture-provider", model: "fixture-model" } }));
  try {
    const result = await f.gateway.infer(request()); assert.equal(result.outcome, "failure");
    const s = await f.gateway.ledger.summary(); assert.equal(s.failures, 1); assert.equal(s.ambiguous, 0); assert.equal(s.unknownSpendAttempts, 1);
  } finally { await f.tmp.cleanup(); }
});
