import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { Socket } from "node:net";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { HttpsRequestLike } from "../src/transport.js";
import { bootstrapGet } from "../src/swarm/bootstrap-http.js";

const connect = Socket.prototype.connect;
let sockets = 0;
before(() => { Socket.prototype.connect = function () { sockets++; throw new Error("Live IO blocked"); } as typeof connect; });
after(() => { Socket.prototype.connect = connect; assert.equal(sockets, 0); });

function fake(status: number, type = "application/json", body = "{}", failure?: "connection" | "body" | "stall") {
  let requests = 0;
  const request: HttpsRequestLike = (url, options, callback) => {
    requests++;
    assert.equal(url.toString(), "https://bootstrap.example.test/r/lobby?format=json");
    assert.equal(options.method, "GET"); assert.equal(options.agent, false);
    const req = new EventEmitter() as ClientRequest;
    req.destroy = (() => req) as ClientRequest["destroy"];
    req.end = (() => {
      queueMicrotask(() => {
        if (failure === "connection") { req.emit("error", new Error("untrusted raw failure")); return; }
        if (failure === "stall") return;
        const incoming = new PassThrough() as unknown as IncomingMessage;
        incoming.statusCode = status;
        incoming.headers = { "content-type": type, location: "https://unselected.example.test/private-fixture" };
        callback(incoming);
        incoming.push(Buffer.from(body));
        if (failure === "body") incoming.emit("aborted");
        else { incoming.complete = true; incoming.push(null); }
      });
      return req;
    }) as ClientRequest["end"];
    return req;
  };
  return { request, count: () => requests };
}

for (const status of [301, 302, 307, 308, 421, 429, 500, 503]) {
  test(`native bootstrap GET ${status}: exactly one physical request, no error body or Location retained`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => { throw new Error("Global fetch forbidden"); });
    const client = fake(status, "text/plain", "private body fixture");
    const response = await bootstrapGet(client.request)("https://bootstrap.example.test/r/lobby?format=json", { method: "GET", redirect: "manual" });
    assert.equal(client.count(), 1); assert.equal(response.status, status);
    assert.equal(response.headers.get("location"), null); assert.equal(await response.text(), "");
  });
}

for (const failure of ["connection", "body", "stall"] as const) {
  test(`native bootstrap GET ${failure} is bounded and never retried`, async () => {
    const client = fake(200, "application/json", "{}", failure);
    const abort = new AbortController();
    const pending = bootstrapGet(client.request)("https://bootstrap.example.test/r/lobby?format=json",
      { method: "GET", redirect: "manual", signal: abort.signal });
    if (failure === "stall") queueMicrotask(() => abort.abort());
    await assert.rejects(pending, error => {
      assert.equal((error as Error).message, "Bootstrap GET incomplete; no retry"); return true;
    });
    assert.equal(client.count(), 1);
  });
}

for (const [type, body] of [["text/html", "<html>fixture</html>"], ["application/json", "x".repeat(2 * 1024 * 1024 + 1)]]) {
  test(`native GET bounds reject ${type} invalid response without logging body`, async () => {
    const client = fake(200, type, body);
    await assert.rejects(bootstrapGet(client.request)("https://bootstrap.example.test/r/lobby?format=json", { method: "GET", redirect: "manual" }), /incomplete/);
    assert.equal(client.count(), 1);
  });
}

test("native GET JSON succeeds once; already-aborted request is never dispatched", async () => {
  const client = fake(200);
  assert.deepEqual(await (await bootstrapGet(client.request)("https://bootstrap.example.test/r/lobby?format=json", { method: "GET", redirect: "manual" })).json(), {});
  const signal = new AbortController(); signal.abort();
  await assert.rejects(bootstrapGet(client.request)("https://bootstrap.example.test/r/lobby?format=json", { method: "GET", redirect: "manual", signal: signal.signal }));
  assert.equal(client.count(), 1);
});
