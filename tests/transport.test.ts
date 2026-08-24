import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage, RequestOptions } from "node:http";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { AmbiguousSendError, ProtocolError, TransportError } from "../src/errors.js";
import { HttpTechnocoreTransport, type HttpsRequestLike } from "../src/transport.js";
import { roomFixture } from "./helpers.js";

function jsonResponse(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
}

type HttpsPlan =
  | {
    kind: "response";
    status: number;
    headers?: IncomingHttpHeaders;
    chunks?: string[];
    errorAfterChunks?: Error;
  }
  | { kind: "request-error"; error: Error }
  | { kind: "timeout" };

interface HttpsCall {
  url: string;
  options: RequestOptions;
  body: Buffer;
}

function fakeHttps(plans: HttpsPlan[]): { request: HttpsRequestLike; calls: HttpsCall[] } {
  const calls: HttpsCall[] = [];
  const request: HttpsRequestLike = (url, options, callback) => {
    const emitter = new EventEmitter();
    const clientRequest = emitter as ClientRequest;
    clientRequest.destroy = ((error?: Error) => {
      queueMicrotask(() => emitter.emit("error", error ?? new Error("request destroyed")));
      return clientRequest;
    }) as ClientRequest["destroy"];
    clientRequest.end = ((body?: Uint8Array | string) => {
      const plan = plans.shift();
      if (!plan) throw new Error("No fake HTTPS plan remains");
      const capturedBody = Buffer.isBuffer(body) ? body : Buffer.from(body ?? "");
      calls.push({ url: url.toString(), options, body: capturedBody });
      if (plan.kind === "timeout") return clientRequest;
      if (plan.kind === "request-error") {
        queueMicrotask(() => emitter.emit("error", plan.error));
        return clientRequest;
      }

      const incoming = new PassThrough() as unknown as IncomingMessage;
      incoming.statusCode = plan.status;
      incoming.headers = plan.headers ?? { "content-type": "application/json" };
      queueMicrotask(() => {
        callback(incoming);
        for (const chunk of plan.chunks ?? []) incoming.push(Buffer.from(chunk));
        if (plan.errorAfterChunks) {
          incoming.destroy(plan.errorAfterChunks);
        } else {
          incoming.push(null);
        }
      });
      return clientRequest;
    }) as ClientRequest["end"];
    return clientRequest;
  };
  return { request, calls };
}

function signedFixture() {
  return { did: "did:key:test", sig: "x", nonce: "1", text: "hello" };
}

test("read retries transient server failures and sends bounded query parameters", async () => {
  const seen: string[] = [];
  let calls = 0;
  const transport = new HttpTechnocoreTransport("https://example.test", {
    maxRetryDelayMs: 0,
    fetch: async (input) => {
      seen.push(String(input));
      calls += 1;
      return calls === 1 ? new Response("temporary", { status: 503 }) : jsonResponse(roomFixture());
    },
  });
  await transport.readRoomJson("public", { since: 4, wait: 10, limit: 20 });
  assert.equal(calls, 2);
  assert.match(seen.at(-1)!, /since=4/);
  assert.match(seen.at(-1)!, /wait=10/);
  assert.match(seen.at(-1)!, /format=json/);
});

test("signed POST retries only explicit 429 refusals with the identical body", async () => {
  const https = fakeHttps([
    { kind: "response", status: 429, headers: { "content-type": "text/plain", "retry-after": "0" }, chunks: ["limited"] },
    { kind: "response", status: 200, chunks: [JSON.stringify(roomFixture())] },
  ]);
  const transport = new HttpTechnocoreTransport("https://example.test", {
    maxRetryDelayMs: 0,
    httpsRequest: https.request,
  });
  await transport.sendSignedMessage("mb-p-0123456789abcdef", signedFixture());
  assert.equal(https.calls.length, 2);
  assert.deepEqual(https.calls[0]?.body, https.calls[1]?.body);
});

test("signed POST stops after the configured 429 retry bound", async () => {
  const https = fakeHttps([
    { kind: "response", status: 429, headers: { "retry-after": "0" }, chunks: ["limited"] },
    { kind: "response", status: 429, headers: { "retry-after": "0" }, chunks: ["still limited"] },
  ]);
  const transport = new HttpTechnocoreTransport("https://example.test", {
    rateLimitRetries: 1,
    maxRetryDelayMs: 0,
    httpsRequest: https.request,
  });
  await assert.rejects(
    () => transport.sendSignedMessage("mb-p-0123456789abcdef", signedFixture()),
    (error: unknown) => error instanceof TransportError &&
      !(error instanceof AmbiguousSendError) &&
      error.status === 429,
  );
  assert.equal(https.calls.length, 2);
});

test("signed POST uses node:https with an exact UTF-8 Content-Length and never fetch", async () => {
  const https = fakeHttps([
    { kind: "response", status: 200, chunks: [JSON.stringify(roomFixture())] },
  ]);
  const envelope = { did: "did:key:test", sig: "signature", nonce: "7", text: "merhaba 🌍" };
  const transport = new HttpTechnocoreTransport("https://example.test", {
    fetch: async () => { throw new Error("global fetch must not handle signed writes"); },
    httpsRequest: https.request,
  });
  await transport.sendSignedMessage("mb-p-0123456789abcdef", envelope);
  assert.equal(https.calls.length, 1);
  const call = https.calls[0]!;
  assert.equal(call.options.method, "POST");
  assert.equal(call.url, "https://example.test/r/mb-p-0123456789abcdef?format=json");
  assert.equal((call.options.headers as Record<string, string>)["content-type"], "application/json");
  assert.equal((call.options.headers as Record<string, string>).accept, "application/json");
  assert.equal(
    (call.options.headers as Record<string, string>)["content-length"],
    String(Buffer.byteLength(JSON.stringify(envelope), "utf8")),
  );
  assert.deepEqual(JSON.parse(call.body.toString("utf8")), envelope);
});

test("pre-header node:https error exposes only safe staged diagnostics and is never retried", async () => {
  const room = "mb-p-0123456789abcdef";
  const signature = "sensitive-signature-value";
  const https = fakeHttps([{
    kind: "request-error",
    error: Object.assign(new Error(`socket failed for ${room} with ${signature}`), { code: "ECONNRESET" }),
  }]);
  const transport = new HttpTechnocoreTransport("https://example.test", {
    httpsRequest: https.request,
  });
  await assert.rejects(
    () => transport.sendSignedMessage(room, { did: "did:key:test", sig: signature, nonce: "1", text: "hello" }),
    (error: unknown) => {
      assert.ok(error instanceof AmbiguousSendError);
      assert.equal(error.diagnostics?.stage, "request");
      assert.equal(error.diagnostics?.headersReceived, false);
      assert.equal(error.diagnostics?.timedOut, false);
      assert.equal(error.diagnostics?.errorClass, "Error");
      assert.equal(error.diagnostics?.causeCode, "ECONNRESET");
      assert.match(error.message, /stage=request/u);
      assert.match(error.message, /endpoint=https:\/\/example\.test\/r\/\[REDACTED_CAPABILITY\]\?format=json/u);
      assert.equal(error.message.includes(room), false);
      assert.equal(error.message.includes(signature), false);
      assert.equal(error.message.includes("hello"), false);
      assert.equal(error.cause, undefined);
      return true;
    },
  );
  assert.equal(https.calls.length, 1);
});

test("5xx response diagnostics prove headers and body arrived without exposing the body", async () => {
  const responseSecret = "do-not-log-this-response";
  const https = fakeHttps([{
    kind: "response",
    status: 503,
    headers: { "content-type": "text/plain; charset=utf-8" },
    chunks: [responseSecret],
  }]);
  const transport = new HttpTechnocoreTransport("https://example.test", {
    httpsRequest: https.request,
  });
  await assert.rejects(
    () => transport.sendSignedMessage("mb-p-0123456789abcdef", { did: "did:key:test", sig: "x", nonce: "1", text: "hello" }),
    (error: unknown) => {
      assert.ok(error instanceof AmbiguousSendError);
      assert.equal(error.diagnostics?.stage, "response-status");
      assert.equal(error.diagnostics?.headersReceived, true);
      assert.equal(error.diagnostics?.status, 503);
      assert.equal(error.diagnostics?.contentType, "text/plain");
      assert.equal(error.diagnostics?.bodyStarted, true);
      assert.equal(error.message.includes(responseSecret), false);
      return true;
    },
  );
});

test("write timeout is distinguished from other pre-header failures", async () => {
  const https = fakeHttps([{ kind: "timeout" }]);
  const transport = new HttpTechnocoreTransport("https://example.test", {
    writeTimeoutMs: 10,
    httpsRequest: https.request,
  });
  await assert.rejects(
    () => transport.sendSignedMessage("mb-p-0123456789abcdef", { did: "did:key:test", sig: "x", nonce: "1", text: "hello" }),
    (error: unknown) => {
      assert.ok(error instanceof AmbiguousSendError);
      assert.equal(error.diagnostics?.stage, "request");
      assert.equal(error.diagnostics?.timedOut, true);
      assert.equal(error.diagnostics?.headersReceived, false);
      assert.equal(error.diagnostics?.causeCode, "ETIMEDOUT");
      return true;
    },
  );
});

test("response body stream failure is classified after headers without leaking partial bytes", async () => {
  const partialSecret = "partial-secret-response";
  const https = fakeHttps([{
    kind: "response",
    status: 200,
    chunks: [partialSecret],
    errorAfterChunks: Object.assign(new Error("socket reset"), { code: "ECONNRESET" }),
  }]);
  const transport = new HttpTechnocoreTransport("https://example.test", {
    httpsRequest: https.request,
  });
  await assert.rejects(
    () => transport.sendSignedMessage("mb-p-0123456789abcdef", { did: "did:key:test", sig: "x", nonce: "1", text: "hello" }),
    (error: unknown) => {
      assert.ok(error instanceof AmbiguousSendError);
      assert.equal(error.diagnostics?.stage, "response-body");
      assert.equal(error.diagnostics?.headersReceived, true);
      assert.equal(error.diagnostics?.status, 200);
      assert.equal(error.diagnostics?.contentType, "application/json");
      assert.equal(error.diagnostics?.bodyStarted, true);
      assert.equal(error.message.includes(partialSecret), false);
      return true;
    },
  );
});

test("oversized signed response is interrupted without exposing response bytes", async () => {
  const responseSecret = "oversized-secret-response";
  const https = fakeHttps([{
    kind: "response",
    status: 200,
    chunks: [responseSecret],
  }]);
  const transport = new HttpTechnocoreTransport("https://example.test", {
    maxResponseBytes: 4,
    httpsRequest: https.request,
  });
  await assert.rejects(
    () => transport.sendSignedMessage("mb-p-0123456789abcdef", signedFixture()),
    (error: unknown) => error instanceof AmbiguousSendError &&
      error.diagnostics?.stage === "response-body" &&
      error.diagnostics.causeCode === "ERR_RESPONSE_TOO_LARGE" &&
      !error.message.includes(responseSecret),
  );
});

test("accepted response with wrong Content-Type fails before JSON parsing", async () => {
  const https = fakeHttps([{
    kind: "response",
    status: 200,
    headers: { "content-type": "text/plain" },
    chunks: [JSON.stringify(roomFixture())],
  }]);
  const transport = new HttpTechnocoreTransport("https://example.test", {
    httpsRequest: https.request,
  });
  await assert.rejects(
    () => transport.sendSignedMessage("mb-p-0123456789abcdef", { did: "did:key:test", sig: "x", nonce: "1", text: "hello" }),
    (error: unknown) => {
      assert.ok(error instanceof AmbiguousSendError);
      assert.equal(error.diagnostics?.stage, "response-parse");
      assert.equal(error.diagnostics?.status, 200);
      assert.equal(error.diagnostics?.contentType, "text/plain");
      assert.equal(error.diagnostics?.errorClass, "UnexpectedContentType");
      return true;
    },
  );
});

test("accepted application/json response with malformed JSON is ambiguous", async () => {
  const https = fakeHttps([{
    kind: "response",
    status: 200,
    chunks: ["not json"],
  }]);
  const transport = new HttpTechnocoreTransport("https://example.test", {
    httpsRequest: https.request,
  });
  await assert.rejects(
    () => transport.sendSignedMessage("mb-p-0123456789abcdef", signedFixture()),
    (error: unknown) => error instanceof AmbiguousSendError &&
      error.diagnostics?.stage === "response-parse" &&
      error.diagnostics.contentType === "application/json",
  );
});

test("read timeout aborts the request and remains bounded", async () => {
  const transport = new HttpTechnocoreTransport("https://example.test", {
    timeoutMs: 10,
    readRetries: 0,
    fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }),
  });
  const started = Date.now();
  await assert.rejects(() => transport.readRoomJson("public"), TransportError);
  assert.ok(Date.now() - started < 1_000);
});

test("malformed responses fail closed and capability names are redacted", async () => {
  const malformed = new HttpTechnocoreTransport("https://example.test", {
    readRetries: 0,
    fetch: async () => jsonResponse(roomFixture({ count: 1, messages: [] })),
  });
  await assert.rejects(() => malformed.readRoomJson("public"), ProtocolError);

  const room = "mb-p-0123456789abcdef";
  const https = fakeHttps([{
    kind: "response",
    status: 400,
    headers: { "content-type": "text/plain" },
    chunks: [`bad room ${room}`],
  }]);
  const rejected = new HttpTechnocoreTransport("https://example.test", {
    rateLimitRetries: 0,
    httpsRequest: https.request,
  });
  await assert.rejects(
    () => rejected.sendSignedMessage(room, { did: "did:key:test", sig: "x", nonce: "1", text: "hello" }),
    (error: unknown) => error instanceof TransportError &&
      !error.message.includes(room) &&
      !error.message.includes(`bad room ${room}`) &&
      error.message.includes("REDACTED"),
  );
});
