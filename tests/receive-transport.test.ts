import assert from "node:assert/strict";
import { Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { HttpTechnocoreTransport, type FetchLike } from "../src/transport.js";
import { receiveFailure, type ReadProgress, type ReceiveStage } from "../src/receive-diagnostics.js";
import { RECONCILIATION_HTTP_OPTIONS, RECONCILIATION_QUERY } from "../src/rehearsal/reconciliation.js";

test("reconciliation HTTP diagnostics and bounds are offline-tested", async t => {
  const connect = Socket.prototype.connect;
  let realNetwork = 0;
  Socket.prototype.connect = function () { realNetwork++; throw new Error("Real network forbidden"); } as typeof connect;
  const cap = ["mb", "p", randomBytes(20).toString("hex")].join("-");
  const privateBody = `private response ${randomBytes(12).toString("hex")}`;
  try {
    await t.test("explicit GET, since0/wait0/limit200, no redirects or write transport", async () => {
      let calls = 0;
      const transport = new HttpTechnocoreTransport("https://example.test", { ...RECONCILIATION_HTTP_OPTIONS,
        httpsRequest: () => { throw new Error("Signed writes forbidden"); },
        fetch: async (url, init) => {
          calls++; const parsed = new URL(url);
          assert.equal(init?.method, "GET"); assert.equal(init.redirect, "error");
          assert.equal(init.body, undefined);
          assert.equal(parsed.searchParams.get("since"), "0"); assert.equal(parsed.searchParams.get("wait"), "0");
          assert.equal(parsed.searchParams.get("limit"), "200"); assert.equal(parsed.searchParams.get("format"), "json");
          return Response.json({ count: 0, first_seq: null, last_seq: 0, messages: [] });
        } });
      await transport.readRoomJson(cap, RECONCILIATION_QUERY); assert.equal(calls, 1);
    });

    const cases: { name: string; fetch: FetchLike; stage: ReceiveStage; status?: number; timedOut?: boolean }[] = [
      ...[429, 503, 302].map(status => ({ name: `HTTP ${status}`, stage: "http-status" as const, status,
        fetch: async () => new Response(privateBody, { status, headers: { "content-type": "text/plain", "retry-after": "0", location: `https://example.test/${cap}` } }) })),
      { name: "malformed JSON", stage: "response-parse", status: 200, fetch: async () => new Response(privateBody, { headers: { "content-type": "application/json" } }) },
      { name: "invalid response schema", stage: "response-parse", status: 200, fetch: async () => Response.json({ count: 1, first_seq: 1, last_seq: 1, messages: [] }) },
      { name: "response interruption", stage: "response-parse", status: 200, fetch: async () => new Response(new ReadableStream({
        start(controller) { controller.error(new Error(privateBody)); },
      }), { headers: { "content-type": `private/${cap}` } }) },
      { name: "connection failure", stage: "transport", timedOut: false, fetch: async () => { throw Object.assign(new Error(privateBody), { code: "ECONNRESET" }); } },
      { name: "redirect rejected by fetch", stage: "transport", timedOut: false, fetch: async (_url, init) => {
        assert.equal(init?.redirect, "error"); throw new TypeError(privateBody);
      } },
      { name: "timeout before headers", stage: "transport", timedOut: true, fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      }) },
    ];
    for (const entry of cases) await t.test(`${entry.name}: one attempt, safe structured failure`, async () => {
      let calls = 0; let stage: ReceiveStage = "preflight"; let http: Omit<ReadProgress, "stage"> = {};
      const progress: ReadProgress[] = [];
      const transport = new HttpTechnocoreTransport("https://example.test", { ...RECONCILIATION_HTTP_OPTIONS, timeoutMs: 10,
        fetch: (...args) => { calls++; return entry.fetch(...args); },
        onReadProgress: value => { progress.push(value); stage = value.stage; const { stage: _, ...safe } = value; http = { ...http, ...safe }; },
      });
      await assert.rejects(() => transport.readRoomJson(cap, RECONCILIATION_QUERY), error => {
        const diagnostic = receiveFailure({ step: 1, expectedSeq: 1, previousCursor: 1, stage, code: "reconciliation-failed", contactHash: "a".repeat(64), http }, error);
        assert.equal(diagnostic.stage, entry.stage); assert.equal(diagnostic.http?.status, entry.status);
        if (entry.timedOut !== undefined) assert.equal(diagnostic.http?.timedOut, entry.timedOut);
        const output = JSON.stringify([diagnostic, progress]);
        assert.equal(output.includes(cap), false); assert.equal(output.includes(privateBody), false);
        return true;
      });
      assert.equal(calls, 1);
    });
    assert.equal(realNetwork, 0);
  } finally { Socket.prototype.connect = connect; }
});
