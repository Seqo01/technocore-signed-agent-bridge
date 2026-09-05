import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { request as nodeHttpsRequest } from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import {
  AmbiguousSendError,
  ProtocolError,
  TransportError,
  type SendFailureDiagnostics,
} from "./errors.js";
import { assertTechnocoreName } from "./names.js";
import { redactSecrets } from "./redact.js";
import { SignedPostRejectedError } from "./send-diagnostics.js";
import type { ReadProgress } from "./receive-diagnostics.js";
import type {
  ReadRoomOptions,
  RoomMessage,
  RoomResponse,
  SignedMessageEnvelope,
  TechnocoreTransport,
} from "./types.js";

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
export type HttpsRequestLike = (
  url: URL,
  options: RequestOptions,
  callback: (response: IncomingMessage) => void,
) => ClientRequest;

export interface HttpTransportOptions {
  timeoutMs?: number;
  writeTimeoutMs?: number;
  readRetries?: number;
  rateLimitRetries?: number;
  maxRetryDelayMs?: number;
  maxResponseBytes?: number;
  fetch?: FetchLike;
  httpsRequest?: HttpsRequestLike;
  readRedirect?: RequestRedirect;
  onReadProgress?: (progress: ReadProgress) => void;
}

interface SignedPostResponse {
  status: number;
  contentType: string;
  retryAfter?: string;
  body: string;
  bodyStarted: boolean;
}

class FetchAttemptError extends Error {
  constructor(
    readonly timedOut: boolean,
    readonly errorClass: string,
    readonly causeCode: string | undefined,
    options?: ErrorOptions,
  ) {
    super("HTTP request failed before response headers", options);
    this.name = "FetchAttemptError";
  }
}

function safeDiagnosticToken(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/u.test(value)
    ? value
    : fallback;
}

function errorClass(error: unknown): string {
  if (!error || typeof error !== "object") return typeof error;
  return safeDiagnosticToken((error as { constructor?: { name?: unknown } }).constructor?.name, "Error");
}

function errorCode(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const record = current as { code?: unknown; cause?: unknown };
    if (typeof record.code === "string") {
      return safeDiagnosticToken(record.code, "REDACTED_CODE");
    }
    current = record.cause;
  }
  return undefined;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function normalizedContentType(value: string | string[] | undefined): string {
  const mediaType = headerValue(value)?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mediaType)
    ? mediaType
    : "unknown";
}

function redactedEndpoint(url: URL): string {
  return `${url.origin}/r/[REDACTED_CAPABILITY]?format=json`;
}

function diagnosticMessage(diagnostics: SendFailureDiagnostics): string {
  const fields = [
    "Signed send outcome is unknown; the reserved nonce remains consumed and was not retried",
    `stage=${diagnostics.stage}`,
    `headersReceived=${diagnostics.headersReceived}`,
    `timedOut=${diagnostics.timedOut}`,
    `endpoint=${diagnostics.endpoint}`,
  ];
  if (diagnostics.status !== undefined) fields.push(`status=${diagnostics.status}`);
  if (diagnostics.contentType !== undefined) fields.push(`contentType=${diagnostics.contentType}`);
  if (diagnostics.bodyStarted !== undefined) fields.push(`bodyStarted=${diagnostics.bodyStarted}`);
  if (diagnostics.errorClass !== undefined) fields.push(`errorClass=${diagnostics.errorClass}`);
  if (diagnostics.causeCode !== undefined) fields.push(`causeCode=${diagnostics.causeCode}`);
  return fields.join("; ");
}

function ambiguousSend(diagnostics: SendFailureDiagnostics): AmbiguousSendError {
  return new AmbiguousSendError(
    diagnosticMessage(diagnostics),
    diagnostics,
  );
}

function query(options: ReadRoomOptions = {}): URLSearchParams {
  const result = new URLSearchParams();
  if (options.since !== undefined) result.set("since", String(options.since));
  if (options.wait !== undefined) result.set("wait", String(options.wait));
  if (options.limit !== undefined) result.set("limit", String(options.limit));
  return result;
}

function assertSafeInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new ProtocolError(`Malformed server response: ${label}`);
  }
  return value as number;
}

function parseMessage(value: unknown): RoomMessage {
  if (!value || typeof value !== "object") {
    throw new ProtocolError("Malformed server response: message is not an object");
  }
  const record = value as Record<string, unknown>;
  const seq = assertSafeInteger(record.seq, "message seq", 1);
  if (typeof record.ts !== "string" || typeof record.from !== "string" || typeof record.text !== "string") {
    throw new ProtocolError("Malformed server response: message fields");
  }
  if (record.nonce !== undefined && !Number.isSafeInteger(record.nonce)) {
    throw new ProtocolError("Malformed server response: message nonce is not a safe integer");
  }
  if (record.sig !== undefined && (typeof record.sig !== "string" || record.sig.length > 512)) {
    throw new ProtocolError("Malformed server response: message signature");
  }
  return {
    seq,
    ts: record.ts,
    from: record.from,
    text: record.text,
    ...(record.nonce === undefined ? {} : { nonce: record.nonce as number }),
    ...(record.sig === undefined ? {} : { sig: record.sig }),
  };
}

export function parseRoomResponse(value: unknown): RoomResponse {
  if (!value || typeof value !== "object") {
    throw new ProtocolError("Malformed server response: expected an object");
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.messages)) {
    throw new ProtocolError("Malformed server response: messages is not an array");
  }
  const messages = record.messages.map(parseMessage);
  const count = assertSafeInteger(record.count, "count");
  const lastSeq = assertSafeInteger(record.last_seq, "last_seq");
  const firstSeq = record.first_seq === null ? null : assertSafeInteger(record.first_seq, "first_seq", 1);
  if (count !== messages.length) {
    throw new ProtocolError("Malformed server response: count does not match messages");
  }
  if (record.room !== undefined && typeof record.room !== "string") {
    throw new ProtocolError("Malformed server response: room");
  }
  return {
    ...(record.room === undefined ? {} : { room: record.room }),
    count,
    first_seq: firstSeq,
    last_seq: lastSeq,
    messages,
    ...(record.posted === undefined ? {} : { posted: parseMessage(record.posted) }),
  };
}

function retryAfterMilliseconds(raw: string | undefined, maximum: number): number {
  if (!raw) return Math.min(1_000, maximum);
  const seconds = Number(raw);
  const milliseconds = Number.isFinite(seconds)
    ? Math.max(0, seconds * 1_000)
    : Math.max(0, Date.parse(raw) - Date.now());
  return Number.isFinite(milliseconds)
    ? Math.min(milliseconds, maximum)
    : Math.min(1_000, maximum);
}

export class HttpTechnocoreTransport implements TechnocoreTransport {
  private readonly baseUrl: URL;
  private readonly timeoutMs: number;
  private readonly writeTimeoutMs: number;
  private readonly readRetries: number;
  private readonly rateLimitRetries: number;
  private readonly maxRetryDelayMs: number;
  private readonly maxResponseBytes: number;
  private readonly fetcher: FetchLike;
  private readonly httpsRequester: HttpsRequestLike;
  private readonly readRedirect: RequestRedirect;
  private readonly onReadProgress: ((progress: ReadProgress) => void) | undefined;

  constructor(baseUrl: string, options: HttpTransportOptions = {}) {
    this.baseUrl = new URL(baseUrl);
    if (!/^https?:$/.test(this.baseUrl.protocol)) {
      throw new TransportError("Technocore URL must use http or https");
    }
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.writeTimeoutMs = options.writeTimeoutMs ?? 30_000;
    this.readRetries = options.readRetries ?? 2;
    this.rateLimitRetries = options.rateLimitRetries ?? 2;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 5_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 2 * 1024 * 1024;
    this.fetcher = options.fetch ?? fetch;
    this.readRedirect = options.readRedirect ?? "follow";
    this.onReadProgress = options.onReadProgress;
    this.httpsRequester = options.httpsRequest ?? ((url, requestOptions, callback) =>
      nodeHttpsRequest(url, requestOptions, callback));
  }

  async readRoomText(room: string, options: ReadRoomOptions = {}): Promise<string> {
    const url = this.roomUrl(room, options, false);
    const response = await this.readRequest(url, room);
    return this.readBody(response, room);
  }

  async readRoomJson(room: string, options: ReadRoomOptions = {}): Promise<RoomResponse> {
    const url = this.roomUrl(room, options, true);
    const response = await this.readRequest(url, room);
    this.onReadProgress?.({ stage: "response-parse" });
    const body = await this.readBody(response, room);
    try {
      return parseRoomResponse(JSON.parse(body));
    } catch (error) {
      if (error instanceof ProtocolError) throw error;
      throw new ProtocolError("Malformed JSON from Technocore", { cause: error });
    }
  }

  async sendSignedMessage(room: string, envelope: SignedMessageEnvelope): Promise<RoomResponse> {
    assertTechnocoreName(room, "room");
    const url = new URL(`/r/${encodeURIComponent(room)}`, this.baseUrl);
    url.searchParams.set("format", "json");
    const endpoint = redactedEndpoint(url);
    const serializedEnvelope = JSON.stringify(envelope);
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.signedPost(url, serializedEnvelope);
      if (response.status === 429 && attempt < this.rateLimitRetries) {
        await delay(retryAfterMilliseconds(response.retryAfter, this.maxRetryDelayMs));
        continue;
      }
      if (response.status < 200 || response.status >= 500 || (response.status >= 300 && response.status < 400)) {
        throw ambiguousSend({
          stage: "response-status",
          headersReceived: true,
          timedOut: false,
          endpoint,
          status: response.status,
          contentType: response.contentType,
          bodyStarted: response.bodyStarted,
        });
      }
      if (response.status < 200 || response.status >= 300) {
        throw new SignedPostRejectedError({ stage: "response-status", headersReceived: true, timedOut: false,
          endpoint, status: response.status, contentType: response.contentType, bodyStarted: response.bodyStarted });
      }
      if (response.contentType !== "application/json") {
        throw ambiguousSend({
          stage: "response-parse",
          headersReceived: true,
          timedOut: false,
          endpoint,
          status: response.status,
          contentType: response.contentType,
          bodyStarted: response.bodyStarted,
          errorClass: "UnexpectedContentType",
        });
      }
      try {
        return parseRoomResponse(JSON.parse(response.body));
      } catch (error) {
        throw ambiguousSend({
          stage: "response-parse",
          headersReceived: true,
          timedOut: false,
          endpoint,
          status: response.status,
          contentType: response.contentType,
          bodyStarted: response.bodyStarted,
          errorClass: errorClass(error),
          ...(errorCode(error) === undefined ? {} : { causeCode: errorCode(error)! }),
        });
      }
    }
  }

  private signedPost(url: URL, serializedEnvelope: string): Promise<SignedPostResponse> {
    const endpoint = redactedEndpoint(url);
    const requestBody = Buffer.from(serializedEnvelope, "utf8");

    return new Promise((resolve, reject) => {
      let settled = false;
      let timedOut = false;
      let headersReceived = false;
      let status: number | undefined;
      let contentType: string | undefined;
      let bodyStarted = false;
      let response: IncomingMessage | undefined;
      let timeout: NodeJS.Timeout | undefined;

      const finish = (value: SignedPostResponse): void => {
        if (settled) return;
        settled = true;
        if (timeout !== undefined) clearTimeout(timeout);
        resolve(value);
      };
      const fail = (stage: "request" | "response-body", error: unknown): void => {
        if (settled) return;
        settled = true;
        if (timeout !== undefined) clearTimeout(timeout);
        reject(ambiguousSend({
          stage,
          headersReceived,
          timedOut,
          endpoint,
          ...(status === undefined ? {} : { status }),
          ...(contentType === undefined ? {} : { contentType }),
          ...(headersReceived ? { bodyStarted } : {}),
          errorClass: errorClass(error),
          ...(errorCode(error) === undefined ? {} : { causeCode: errorCode(error)! }),
        }));
      };

      let request: ClientRequest;
      try {
        request = this.httpsRequester(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            "content-length": String(requestBody.byteLength),
          },
        }, (incoming) => {
          response = incoming;
          headersReceived = true;
          status = incoming.statusCode;
          contentType = normalizedContentType(incoming.headers["content-type"]);
          const retryAfter = headerValue(incoming.headers["retry-after"]);
          const chunks: Buffer[] = [];
          let receivedBytes = 0;

          incoming.on("data", (chunk: Buffer | string) => {
            if (settled) return;
            bodyStarted = true;
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            receivedBytes += buffer.byteLength;
            if (receivedBytes > this.maxResponseBytes) {
              const sizeError = Object.assign(new Error("Technocore response exceeded the local size limit"), {
                code: "ERR_RESPONSE_TOO_LARGE",
              });
              fail("response-body", sizeError);
              incoming.destroy(sizeError);
              return;
            }
            chunks.push(buffer);
          });
          incoming.once("aborted", () => {
            fail("response-body", Object.assign(new Error("Technocore response was interrupted"), {
              code: "ECONNRESET",
            }));
          });
          incoming.once("error", (error) => fail("response-body", error));
          incoming.once("end", () => {
            if (status === undefined) {
              fail("response-body", new Error("Technocore response had no HTTP status"));
              return;
            }
            finish({
              status,
              contentType: contentType ?? "unknown",
              ...(retryAfter === undefined ? {} : { retryAfter }),
              body: Buffer.concat(chunks, receivedBytes).toString("utf8"),
              bodyStarted,
            });
          });
        });
      } catch (error) {
        fail("request", error);
        return;
      }

      request.once("error", (error) => fail(headersReceived ? "response-body" : "request", error));
      timeout = setTimeout(() => {
        timedOut = true;
        const timeoutError = Object.assign(new Error("Technocore signed POST timed out"), {
          code: "ETIMEDOUT",
        });
        request.destroy(timeoutError);
        if (!settled) fail(headersReceived ? "response-body" : "request", timeoutError);
      }, this.writeTimeoutMs);

      try {
        request.end(requestBody);
      } catch (error) {
        fail("request", error);
        response?.destroy();
      }
    });
  }

  private roomUrl(room: string, options: ReadRoomOptions, json: boolean): URL {
    assertTechnocoreName(room, "room");
    const url = new URL(`/r/${encodeURIComponent(room)}`, this.baseUrl);
    url.search = query(options).toString();
    if (json) url.searchParams.set("format", "json");
    return url;
  }

  private async readRequest(url: URL, room: string): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.readRetries; attempt += 1) {
      try {
        this.onReadProgress?.({ stage: "transport", headersReceived: false, timedOut: false });
        const response = await this.fetchWithTimeout(url, { method: "GET", redirect: this.readRedirect, headers: { accept: "application/json, text/plain" } });
        const media = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
        this.onReadProgress?.({ stage: "http-status", status: response.status, headersReceived: true,
          contentType: media === "application/json" || media === "text/plain" || media === "text/html" ? media : "other" });
        if ((response.status === 429 || response.status >= 500) && attempt < this.readRetries) {
          await delay(response.status === 429 ? retryAfterMilliseconds(response.headers.get("retry-after") ?? undefined, this.maxRetryDelayMs) : Math.min(100 * 2 ** attempt, this.maxRetryDelayMs));
          continue;
        }
        if (!response.ok) {
          const body = await this.readBody(response, room);
          throw new TransportError(redactSecrets(`Technocore read failed (${response.status}): ${body.slice(0, 240)}`, [room]), response.status);
        }
        return response;
      } catch (error) {
        if (error instanceof FetchAttemptError) this.onReadProgress?.({ stage: "transport", headersReceived: false, timedOut: error.timedOut });
        if (error instanceof TransportError) throw error;
        lastError = error;
        if (attempt < this.readRetries) {
          await delay(Math.min(100 * 2 ** attempt, this.maxRetryDelayMs));
          continue;
        }
      }
    }
    throw new TransportError(redactSecrets("Technocore read failed after bounded retries", [room]), undefined, { cause: lastError });
  }

  private async fetchWithTimeout(
    url: URL,
    init: RequestInit,
    timeoutMs = this.timeoutMs,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetcher(url, { ...init, signal: controller.signal });
    } catch (error) {
      throw new FetchAttemptError(
        controller.signal.aborted,
        errorClass(error),
        errorCode(error),
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async readBody(response: Response, _room: string): Promise<string> {
    if (!response.body) return "";
    const reader = response.body.getReader();
    let timer: NodeJS.Timeout | undefined;
    const consume = async () => {
      const chunks: Buffer[] = []; let size = 0;
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > this.maxResponseBytes) throw new TransportError("Technocore response exceeded the local size limit", response.status);
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks).toString("utf8");
    };
    try {
      return await Promise.race([consume(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          this.onReadProgress?.({ stage: "response-parse", headersReceived: true, status: response.status, timedOut: true });
          reject(new TransportError("Technocore response body timed out", response.status));
        }, this.timeoutMs);
      })]);
    } finally {
      if (timer) clearTimeout(timer);
      void reader.cancel().catch(() => undefined);
    }
  }
}
