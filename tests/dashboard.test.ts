import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { cp } from "node:fs/promises";
import { request } from "node:http";
import { Socket } from "node:net";
import { Script, createContext } from "node:vm";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { createStores } from "../src/context.js";
import { AgentRoleStore } from "../src/agent/roles.js";
import { hashValue } from "../src/agent/util.js";
import { DashboardController } from "../src/dashboard/controller.js";
import { startDashboardServer } from "../src/dashboard/server.js";
import { html, css, javascript } from "../src/dashboard/ui.js";
import { dashboardCommand } from "../src/dashboard/cli.js";
import { peerAliases, PEER_ROLES, type SessionPolicy } from "../src/swarm/session-policy.js";
import { SessionStateStore, sessionDirectory } from "../src/swarm/session-state.js";
import { SwarmSessionSupervisor } from "../src/swarm/supervisor.js";
import { atomicWriteJson, pathExists } from "../src/fs-safe.js";
import { generatedPassphraseProvider, temporaryDirectory } from "./helpers.js";

const secret = generatedPassphraseProvider();
let template: Awaited<ReturnType<typeof temporaryDirectory>>;
let policy: SessionPolicy;
const originalConnect = Socket.prototype.connect;
let nonlocalAttempts = 0;
before(async () => {
  Socket.prototype.connect = function (this: Socket, ...args: unknown[]) {
    const first = args[0] as Record<string, unknown>;
    const options = Array.isArray(first) ? first[0] as Record<string, unknown> : first;
    if (options?.host !== "127.0.0.1") { nonlocalAttempts++; throw new Error("Non-loopback network forbidden in dashboard tests"); }
    return Reflect.apply(originalConnect, this, args);
  } as typeof Socket.prototype.connect;
  template = await temporaryDirectory();
  const stores = createStores(template.path, secret.provider);
  const members: SessionPolicy["members"] = [];
  for (const alias of peerAliases) {
    const identity = await stores.identities.create(alias);
    await stores.mailboxes.create(alias, identity.did);
    await new AgentRoleStore(resolve(template.path, "agents", alias)).assign(identity, PEER_ROLES[alias]);
    members.push({ alias, did: identity.did, role: PEER_ROLES[alias], mayDelegate: alias === "bob" });
  }
  policy = { version: 1, sessionId: "dashboard-fixture", mode: "offline", members, pairs: [],
    schemas: ["peer-work/v1", "peer-result/v1"], workloads: [{ type: "workload.research", version: 1 }],
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    limits: { tasks: 10, outbound: 10, gets: 10, inference: 10, payloadBytes: 4096, depth: 4, concurrency: 1, inferenceTimeoutMs: 1000 },
    network: { origin: "offline", pathClass: "signed-mailbox-only", postRetries: 0 } };
});
after(async () => { Socket.prototype.connect = originalConnect; await template?.cleanup(); secret.cleanup(); assert.equal(nonlocalAttempts, 0); });

const task = () => ({ objective: "Check supplied protocol excerpt", acceptanceCriteria: ["Cite source line L1"],
  source: "L1: A completed task must not rerun after restart.", flow: ["bob"] });
async function fixture() {
  const tmp = await temporaryDirectory(); await cp(template.path, tmp.path, { recursive: true });
  const controller = new DashboardController(tmp.path, policy, secret.provider);
  return { tmp, controller, close: async () => { await controller.close(); await tmp.cleanup(); } };
}
async function until<T>(fn: () => Promise<T>, done: (v: T) => boolean): Promise<T> {
  const end = Date.now() + 20000;
  while (Date.now() < end) { const value = await fn(); if (done(value)) return value; await new Promise(r => setTimeout(r, 30)); }
  throw new Error("Dashboard condition not reached");
}
async function control(c: DashboardController, action: "start" | "stop" | "pause" | "resume") {
  await c.request(action); const view = await until(() => c.view(), v => v.phase === null);
  assert.equal(view.error, null); return view;
}
async function completed(c: DashboardController, count: number) {
  const v = await until(() => c.view(), v => v.view!.counts.completed === count || !!v.error ||
    v.view!.jobs.some(j => j.status === "needs-operator") || v.view!.submissions.some(s => s.status === "rejected"));
  assert.equal(v.view!.counts.completed, count, JSON.stringify({ lifecycle: v.view!.lifecycle, reason: v.view!.reason,
    counts: v.view!.counts, tasks: v.view!.tasks.map(t => ({ compute: t.compute, runtimeStatus: t.runtimeStatus, failureCode: t.failureCode })) }));
}
async function http(origin: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; text: string }>((done, reject) => {
    const data = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    const req = request(origin, { path, method: data === undefined ? "GET" : "POST", headers: {
      ...(data === undefined ? {} : { Origin: origin, "X-Swarm-Local": "1", "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(data)) }), ...headers } }, res => {
      const chunks: Buffer[] = []; res.on("data", c => chunks.push(Buffer.from(c))); res.on("end", () => done({ status: res.statusCode!, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    }); req.on("error", reject); req.end(data);
  });
}

test("dashboard read before START never creates state or unlocks keys", async () => {
  const f = await fixture(); try {
    const c = new DashboardController(f.tmp.path, policy, async () => { throw new Error("No unlock on read"); });
    const v = await c.view(); assert.equal(v.view, null); assert.equal(v.agents.length, 5); assert.equal(v.allowed.start, true);
    assert.equal(await pathExists(sessionDirectory(f.tmp.path, policy.sessionId)), false);
  } finally { await f.close(); }
});
test("real supervisor lifecycle: pause, durable queue, complete, stop, resume without duplicate inference", async () => {
  const f = await fixture(); try {
    await control(f.controller, "start"); await control(f.controller, "pause");
    const queued = await f.controller.submit(task()); const v = await f.controller.view();
    assert.equal(v.view!.counts.queuedSubmissions, 1); assert.equal(v.view!.inference.attempts, 0);
    await control(f.controller, "resume");
    await until(() => f.controller.view(), v => v.view!.jobs.some(j => j.jobId === queued.jobId && j.status === "completed"));
    const complete = await f.controller.view(queued.jobId);
    assert.equal(complete.view!.inference.attempts, 1); assert.equal(complete.view!.tasks.length, 1);
    assert.equal(complete.view!.tasks[0]!.agent, "bob"); assert.ok(complete.view!.tasks[0]!.result); assert.ok(complete.view!.tasks[0]!.provenance);
    assert.deepEqual(complete.operatorTask, task()); assert.equal(complete.view!.counts.externalJobs, 0);
    assert.equal((await control(f.controller, "stop")).view!.lifecycle, "stopped");
    await control(f.controller, "resume"); await f.controller.submit(task());
    assert.equal((await f.controller.view()).view!.inference.attempts, 1);
    const after = await f.controller.view(queued.jobId); assert.deepEqual(after.view!.tasks[0]!.result, complete.view!.tasks[0]!.result);
    await control(f.controller, "stop");
  } finally { await f.close(); }
});
test("new dashboard process can inspect and explicitly reopen same stopped session", async () => {
  const f = await fixture(); try {
    await control(f.controller, "start"); await control(f.controller, "stop");
    const next = new DashboardController(f.tmp.path, policy, secret.provider);
    try { assert.equal((await next.view()).allowed.resume, true); await control(next, "resume"); await control(next, "stop"); }
    finally { await next.close(); }
  } finally { await f.close(); }
});
test("pause and resume remain consistent with concurrent browser-like state reads", async () => {
  const f = await fixture(); try {
    await control(f.controller, "start");
    for (let i = 0; i < 8; i++) {
      await control(f.controller, "pause");
      await f.controller.submit({ ...task(), objective: "Check supplied rule " + i });
      await control(f.controller, "resume");
      await completed(f.controller, i + 1);
    }
    await control(f.controller, "stop");
  } finally { await f.close(); }
});

test("PAUSE waits for the existing runtime intake boundary instead of rejecting an in-flight submission", async () => {
  const f = await fixture();
  const original = SwarmSessionSupervisor.prototype.submitOperator;
  let entered = false, release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  SwarmSessionSupervisor.prototype.submitOperator = async function (value) {
    entered = true; await gate; return original.call(this, value);
  };
  try {
    await control(f.controller, "start"); await f.controller.submit(task());
    await until(async () => entered, Boolean);
    await f.controller.request("pause");
    await new Promise(done => setTimeout(done, 150));
    const pending = await f.controller.view();
    assert.equal(pending.phase, "pause");
    assert.equal(pending.view!.lifecycle, "active");
    release();
    const paused = await until(() => f.controller.view(), v => v.phase === null);
    assert.equal(paused.error, null); assert.equal(paused.view!.lifecycle, "paused");
    assert.equal(paused.view!.submissions[0]!.status, "accepted");
    await control(f.controller, "resume");
    await until(() => f.controller.view(), v => v.view!.counts.completed === 1);
    assert.equal((await f.controller.view()).view!.inference.attempts, 1);
  } finally { release(); SwarmSessionSupervisor.prototype.submitOperator = original; await f.close(); }
});
test("dashboard reads cannot overlap owner checkpoint writes, including startup and STOP", async () => {
  const f = await fixture();
  const read = SessionStateStore.read, save = SessionStateStore.prototype.save;
  let reading = 0, collisions = 0;
  SessionStateStore.read = async (...args) => {
    reading++;
    try { await new Promise(done => setTimeout(done, 10)); return await read(...args); }
    finally { reading--; }
  };
  SessionStateStore.prototype.save = async function () {
    if (reading) { collisions++; throw Object.assign(new Error("Simulated Windows sharing conflict"), { code: "EPERM" }); }
    return save.call(this);
  };
  try {
    await control(f.controller, "start"); await f.controller.submit(task());
    await Promise.all(Array.from({ length: 8 }, () => f.controller.view()));
    await completed(f.controller, 1);
    await control(f.controller, "pause"); await control(f.controller, "resume");
    await control(f.controller, "stop"); await control(f.controller, "resume");
    await control(f.controller, "stop");
    assert.equal(collisions, 0); assert.equal((await f.controller.view()).view!.inference.attempts, 1);
  } finally { SessionStateStore.read = read; SessionStateStore.prototype.save = save; await f.close(); }
});
test("invalid transitions and duplicate concurrent START cannot start a second owner", async () => {
  const f = await fixture(); try {
    await assert.rejects(f.controller.request("pause")); await assert.rejects(f.controller.submit(task()));
    const results = await Promise.allSettled([f.controller.request("start"), f.controller.request("start")]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    await until(() => f.controller.view(), v => v.phase === null);
    await assert.rejects(f.controller.request("start")); await control(f.controller, "stop");
    await assert.rejects(f.controller.request("start"));
  } finally { await f.close(); }
});
test("locked identity prompt is server-only; raw failure does not appear in projection", async () => {
  const f = await fixture(); const secretText = randomBytes(32).toString("hex");
  const c = new DashboardController(f.tmp.path, policy, async () => { throw new Error(secretText); });
  try {
    await c.request("start"); const v = await until(() => c.view(), v => v.phase === null);
    assert.ok(v.error); assert.equal(JSON.stringify(v).includes(secretText), false); assert.equal(v.view!.lifecycle, "halted");
  } finally { await c.close(); await f.close(); }
});
test("foreign owner is observable but not controllable through dashboard", async () => {
  const f = await fixture(); try {
    await control(f.controller, "start"); const observer = new DashboardController(f.tmp.path, policy, secret.provider);
    try { const v = await observer.view(); assert.equal(v.allowed.stop, false); assert.equal(v.allowed.submit, false); assert.equal(v.allowed.resume, false); }
    finally { await observer.close(); }
  } finally { await f.close(); }
});
test("configured mode is rejected before a session or transport starts", () => {
  assert.throws(() => new DashboardController(template.path, { ...policy, mode: "configured" }, secret.provider));
});
test("expired session stays readable but reopen fails without inference or retry", async () => {
  const f = await fixture(); try {
    await control(f.controller, "start"); await control(f.controller, "stop");
    const state = await SessionStateStore.read(f.tmp.path, policy.sessionId);
    state.policy.expiresAt = new Date(Date.now() - 1000).toISOString(); state.policyHash = hashValue(state.policy);
    await atomicWriteJson(resolve(sessionDirectory(f.tmp.path, policy.sessionId), "session.json"), state);
    const c = new DashboardController(f.tmp.path, state.policy, secret.provider);
    try { assert.ok((await c.view()).view); await c.request("resume"); const v = await until(() => c.view(), v => v.phase === null); assert.ok(v.error); assert.equal(v.view!.inference.attempts, 0); }
    finally { await c.close(); }
  } finally { await f.close(); }
});
test("shutdown stops the owned runtime cleanly", async () => {
  const f = await fixture(); try { await control(f.controller, "start"); await f.controller.close(); assert.equal((await f.controller.view()).view!.lifecycle, "stopped"); }
  finally { await f.close(); }
});
test("task validation rejects unapproved role flow and secret-like input", async () => {
  const f = await fixture(); try {
    await control(f.controller, "start");
    await assert.rejects(f.controller.submit({ ...task(), flow: ["bob", "dave"] }));
    await assert.rejects(f.controller.submit({ ...task(), source: "mb-p-" + randomBytes(20).toString("hex") }));
    await assert.rejects(f.controller.submit({ ...task(), sourceFile: "../../anything" }));
  } finally { await f.close(); }
});
test("loopback HTTP end-to-end uses controller and persisted result", async () => {
  const f = await fixture(); const app = await startDashboardServer(f.controller, 0);
  try {
    assert.match(app.origin, /^http:\/\/127\.0\.0\.1:/u);
    assert.equal((await http(app.origin, "/api/control/start", {})).status, 202);
    await until(() => f.controller.view(), v => v.phase === null);
    const queued = await http(app.origin, "/api/tasks", task()); assert.equal(queued.status, 202);
    const id = (JSON.parse(queued.text) as { jobId: string }).jobId;
    await completed(f.controller, 1);
    const result = await http(app.origin, "/api/jobs/" + id); assert.equal(result.status, 200);
    assert.equal(JSON.parse(result.text).view.inference.attempts, 1);
    assert.doesNotMatch(result.text, /privateKey|encryptedPrivateKey|passphrase|mb-p-|"signature"/u);
    assert.equal((await http(app.origin, "/api/control/stop", {})).status, 202);
    await until(() => f.controller.view(), v => v.phase === null);
  } finally { await app.close(); await f.close(); }
});
for (const [name, headers] of [
  ["foreign Origin", { Origin: "https://example.invalid" }],
  ["rebinding Host", { Host: "example.invalid" }],
  ["missing Origin", { Origin: "" }],
  ["missing custom header", { "X-Swarm-Local": "" }],
  ["cross-site fetch", { "Sec-Fetch-Site": "cross-site" }],
] as [string, Record<string,string>][]) test(`HTTP rejects ${name} before mutation`, async () => {
  const f = await fixture(); const app = await startDashboardServer(f.controller, 0);
  try { assert.equal((await http(app.origin, "/api/control/start", {}, headers)).status, 403); assert.equal((await f.controller.view()).view, null); }
  finally { await app.close(); await f.close(); }
});
test("HTTP bounds, malformed input, controls with arguments and unknown routes fail closed", async () => {
  const f = await fixture(); const app = await startDashboardServer(f.controller, 0);
  try {
    for (const body of ["{", "x".repeat(8300), '{"secret":"not-echoed"}']) {
      const r = await http(app.origin, "/api/control/start", body); assert.equal(r.status, 400); assert.equal(r.text.includes("not-echoed"), false);
    }
    assert.equal((await http(app.origin, "/api/control/start", {}, { "Content-Type": "text/plain" })).status, 400);
    for (const path of ["/.technocore/identities/bob.json", "/api/jobs/../../", "/api/state?file=anything", "/unknown"]) assert.equal((await http(app.origin, path)).status, 404);
    assert.equal((await f.controller.view()).view, null);
  } finally { await app.close(); await f.close(); }
});
test("static assets are local, CSP fenced, no-store and JavaScript parses", async () => {
  new Script(javascript);
  assert.doesNotMatch(javascript, /innerHTML|eval\(|localStorage|sessionStorage/u);
  assert.doesNotMatch(html + css, /https?:\/\//u);
  assert.match(html, /TESTING ONLY/u); assert.match(css, /prefers-reduced-motion/u);
  const f = await fixture(); const app = await startDashboardServer(f.controller, 0);
  try { for (const path of ["/", "/app.js", "/app.css", "/api/state"]) {
    const r = await http(app.origin, path); assert.equal(r.status, 200); assert.equal(r.headers["cache-control"], "no-store");
    assert.match(String(r.headers["content-security-policy"]), /frame-ancestors 'none'/u);
    assert.equal(r.headers["access-control-allow-origin"], undefined);
  } } finally { await app.close(); await f.close(); }
});
test("CLI rejects missing, duplicate, unknown and remote-bind arguments", async () => {
  for (const args of [[], ["--policy","x","--session","x"], ["--host","0.0.0.0"], ["--session","x","--session","y"]]) await assert.rejects(dashboardCommand(args));
});

/** Small DOM seam for presentation only; the existing controller tests own lifecycle rules. */
function uiFixture() {
  class Element {
    textContent = ""; className = ""; hidden = false; disabled = false; tabIndex = -1;
    dataset: Record<string, string> = {}; attributes: Record<string, string> = {};
    children: Element[] = []; handlers: Record<string, () => void> = {}; focused = false;
    classList = { toggle: (name: string, on: boolean) => {
      const classes = new Set(this.className.split(" ").filter(Boolean));
      if (on) classes.add(name); else classes.delete(name); this.className = [...classes].join(" ");
    } };
    constructor(readonly tag = "div") {}
    append(...nodes: Element[]) { this.children.push(...nodes); }
    replaceChildren(...nodes: Element[]) { this.children = nodes; }
    setAttribute(key: string, value: string) { this.attributes[key] = value; }
    addEventListener(name: string, fn: () => void) { this.handlers[name] = fn; }
    querySelector(tag: string): Element | undefined { return this.children.find(n => n.tag === tag); }
    focus() { this.focused = true; }
    scrollIntoView() { /* No layout in this presentation seam. */ }
  }
  const elements = new Map<string, Element>();
  const get = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
  const context = createContext({ document: { getElementById: get, createElement: (tag: string) => new Element(tag), hidden: false },
    fetch: () => new Promise(() => {}), AbortSignal, setInterval: () => 0 });
  new Script(javascript).runInContext(context);
  return { get, context, run: (code: string) => new Script(code).runInContext(context) as unknown };
}

test("UI emphasizes only a permitted lifecycle action, including stopped and paused RESUME", () => {
  const ui = uiFixture();
  for (const [state, allowed, primary] of [
    ["NOT STARTED", { start: true }, "start"], ["STOPPED", { resume: true }, "resume"],
    ["PAUSED", { resume: true, stop: true }, "resume"], ["RUNNING", { pause: true, stop: true }, "pause"],
    ["STOPPED", {}, null],
  ] as const) {
    ui.context.fixture = { view: { state }, allowed };
    ui.run("current=fixture; blocked=false; controls()");
    for (const action of ["start", "stop", "pause", "resume"]) {
      assert.equal(ui.get(action).className.includes("primary"), action === primary);
      assert.equal(ui.get(action).disabled, !Reflect.get(allowed, action));
    }
  }
  ui.run("blocked=true; controls()");
  assert.ok(ui.get("resume").disabled); assert.doesNotMatch(ui.get("resume").className, /primary/u);
});

test("UI renders real counts, literal agent states and untrusted text without HTML", async () => {
  const f = await fixture(); try {
    const ui = uiFixture(); ui.context.fixture = await f.controller.view(); ui.run("render(fixture)");
    assert.equal(ui.get("metrics").children.length, 8);
    assert.ok(ui.get("metrics").children.every(n => n.children[0]!.textContent === "—"));
    await control(f.controller, "start"); ui.context.fixture = await f.controller.view(); ui.run("render(fixture)");
    assert.equal(ui.get("metrics").children[4]!.children[0]!.textContent, "0");
    assert.equal(ui.get("agents").children.length, 5);
    assert.equal(ui.get("agents").children[1]!.children[0]!.children[1]!.textContent, "idle");
    ui.run("render({...fixture, sessionId:'<script>untrusted</script>'})");
    assert.equal(ui.get("session-id").textContent, "<script>untrusted</script>");
    assert.equal(ui.get("session-id").children.length, 0);
  } finally { await f.close(); }
});

test("UI inspection separates results and provenance while retaining complete evidence", async () => {
  const ui = uiFixture();
  const result = "<script>not executable</script> " + "long-token".repeat(1000);
  const evidence = { operatorTask: { objective: "UI fixture" }, view: { jobs: [],
    tasks: [{ taskId: "ui-task", agent: "bob", compute: "result-ready", result, provenance: { testingOnly: true } }], inference: { attempts: 1 } } };
  ui.context.evidence = evidence; ui.run("api=async()=>evidence"); await ui.run("inspect('ui-job')");
  assert.equal(ui.get("inspection-results").children[0]!.children[2]!.textContent, result);
  assert.equal(JSON.parse(ui.get("provenance").textContent).tasks[0].provenance.testingOnly, true);
  assert.equal(JSON.parse(ui.get("result").textContent).tasks[0].result, result);
  assert.equal(ui.get("inspection").focused, true);
  ui.context.evidence = { ...evidence, view: { ...evidence.view, tasks: [] } };
  await ui.run("inspect('empty-job')"); assert.match(ui.get("inspection-results").children[0]!.textContent, /No task results/u);
  ui.get("close-inspection").handlers.click!(); assert.equal(ui.get("inspection").hidden, true);
});

test("UI ignores stale inspection responses and marks the selected job accessibly", async () => {
  const ui = uiFixture();
  ui.context.fixture = { sessionId: "ui-fixture", allowed: {}, agents: [], view: { state: "STOPPED", counts: {},
    inference: { attempts: 0 }, tasks: [], jobs: [{ jobId: "one", status: "completed", roleFlow: ["bob"] }], submissions: [], recentActivity: [] } };
  ui.run("render(fixture); api=()=>new Promise(resolve=>globalThis.finishInspection=resolve)");
  const pending = ui.run("inspect('one')"); ui.get("close-inspection").handlers.click!();
  ui.run("finishInspection({operatorTask:null,view:fixture.view})"); await pending;
  assert.equal(ui.get("inspection").hidden, true);
  ui.run("api=async()=>({operatorTask:null,view:fixture.view})"); await ui.run("inspect('one')");
  const button = ui.get("jobs").children[0]!.querySelector("button")!;
  assert.equal(button.attributes["aria-pressed"], "true");
  ui.get("close-inspection").handlers.click!();
  assert.equal(button.attributes["aria-pressed"], "false"); assert.equal(button.focused, true);
});
