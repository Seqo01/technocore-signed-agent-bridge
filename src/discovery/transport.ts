import { BridgeError } from "../errors.js";
import { DISCOVERY_ORIGIN, limits, publicRoom, type Limits } from "./model.js";
import { classifyDiscoveryPath, diagnosticsFromError, DiscoveryTransportError,
  initialDiscoveryDiagnostics, normalizeDiscoveryContentType,
  type DiscoveryFailureDiagnostics, type DiscoveryProgress } from "./diagnostics.js";

export interface ReadReply { status: number; contentType?: string; body: string }
export interface DiscoveryReadTransport {
  get(path: string, signal: AbortSignal, progress?: DiscoveryProgress): Promise<ReadReply>;
}

export function assertReadPath(path: string): void {
  const listing = /^\/rooms\?format=json&limit=([1-9]\d{0,2})$/u.exec(path);
  const room = /^\/r\/([a-z0-9][a-z0-9_-]{0,47})\?format=json&since=(0|[1-9]\d{0,14})&limit=([1-9]\d{0,2})&wait=0$/u.exec(path);
  const note = /^\/kv\/(?:did-[a-f0-9]{2}\/[a-f0-9]{14}|did\/[a-f0-9]{16})$/u.test(path);
  if (listing && Number(listing[1]) <= 200) return;
  if (room && publicRoom(room[1]) && Number(room[3]) <= 200 && Number.isSafeInteger(Number(room[2]))) return;
  if (note) return;
  throw new BridgeError("Discovery path is not an approved read-only path");
}

function emit(progress: DiscoveryProgress | undefined, diagnostics: DiscoveryFailureDiagnostics): void {
  progress?.({ ...diagnostics });
}

function fail(
  diagnostics: DiscoveryFailureDiagnostics,
  overrides: Partial<DiscoveryFailureDiagnostics>,
  error?: unknown,
): DiscoveryTransportError {
  return new DiscoveryTransportError(diagnosticsFromError(diagnostics, error, overrides));
}

/** No URL, method, headers, credentials or arbitrary request options accepted from callers/content. */
export class HttpDiscoveryReadTransport implements DiscoveryReadTransport {
  private readonly bounds: Limits;

  constructor(origin: string, bounds: Partial<Limits> = {}, private readonly fetcher: typeof fetch = globalThis.fetch) {
    if (origin !== DISCOVERY_ORIGIN) throw new BridgeError("Discovery requires the reviewed Technocore origin");
    this.bounds = limits(bounds);
  }

  async get(path: string, signal: AbortSignal, progress?: DiscoveryProgress): Promise<ReadReply> {
    let diagnostics = initialDiscoveryDiagnostics(classifyDiscoveryPath(path));
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      try { assertReadPath(path); }
      catch (error) { throw fail(diagnostics, { errorClass: "ValidationRefused", causeCode: "ERR_DISCOVERY_VALIDATION" }, error); }
      if (signal.aborted) throw fail(diagnostics, { stage: "request", timedOut: true,
        errorClass: "TimeoutError", causeCode: "ERR_DISCOVERY_TIMEOUT" });

      diagnostics = { ...diagnostics, stage: "request", dispatched: true };
      emit(progress, diagnostics);
      const response = await this.fetcher(`${DISCOVERY_ORIGIN}${path}`, { method: "GET", redirect: "manual",
        credentials: "omit", referrerPolicy: "no-referrer", headers: { accept: path.startsWith("/kv/") ? "text/plain" : "application/json" },
        signal });

      const contentType = normalizeDiscoveryContentType(response.headers.get("content-type"));
      diagnostics = { ...diagnostics, stage: "response-headers", headersReceived: true, status: response.status,
        ...(contentType ? { contentType } : {}) };
      emit(progress, diagnostics);
      if (response.redirected || (response.status >= 300 && response.status < 400) ||
        (response.url && response.url !== `${DISCOVERY_ORIGIN}${path}`)) {
        diagnostics = { ...diagnostics, redirectDetected: true };
        emit(progress, diagnostics);
        throw fail(diagnostics, { errorClass: "RedirectRefused", causeCode: "ERR_DISCOVERY_REDIRECT" });
      }

      diagnostics = { ...diagnostics, stage: "response-body" };
      emit(progress, diagnostics);
      const declared = response.headers.get("content-length");
      if (declared && (!/^\d+$/u.test(declared) || Number(declared) > this.bounds.responseBytes)) {
        throw fail(diagnostics, { errorClass: "BodyLimitRefused", causeCode: "ERR_DISCOVERY_BODY_LIMIT" });
      }
      const chunks: Buffer[] = [];
      if (response.body) {
        reader = response.body.getReader();
        while (true) {
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try { chunk = await reader.read(); }
          catch (error) {
            throw fail(diagnostics, { timedOut: signal.aborted,
              errorClass: signal.aborted ? "TimeoutError" : "BodyInterrupted",
              causeCode: signal.aborted ? "ERR_DISCOVERY_TIMEOUT" : "ERR_DISCOVERY_BODY_INTERRUPTED" }, error);
          }
          if (chunk.done) break;
          diagnostics = { ...diagnostics, bytesReceived: diagnostics.bytesReceived + chunk.value.byteLength };
          emit(progress, diagnostics);
          if (diagnostics.bytesReceived > this.bounds.responseBytes) {
            throw fail(diagnostics, { errorClass: "BodyLimitRefused", causeCode: "ERR_DISCOVERY_BODY_LIMIT" });
          }
          chunks.push(Buffer.from(chunk.value));
        }
      }
      let body: string;
      try { body = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); }
      catch (error) {
        throw fail(diagnostics, { stage: "response-parse", errorClass: "InvalidUtf8",
          causeCode: "ERR_DISCOVERY_INVALID_UTF8" }, error);
      }
      return { status: response.status, ...(diagnostics.contentType ? { contentType: diagnostics.contentType } : {}), body };
    } catch (error) {
      if (error instanceof DiscoveryTransportError) throw error;
      const stage = diagnostics.headersReceived ? "response-body" : "request";
      throw fail(diagnostics, { stage, timedOut: signal.aborted,
        ...(signal.aborted ? { errorClass: "TimeoutError", causeCode: "ERR_DISCOVERY_TIMEOUT" } : {}) }, error);
    } finally {
      void reader?.cancel().catch(() => undefined);
    }
  }
}
