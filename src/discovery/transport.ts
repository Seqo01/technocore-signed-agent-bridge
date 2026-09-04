import { BridgeError } from "../errors.js";
import { DISCOVERY_ORIGIN, limits, publicRoom, type Limits } from "./model.js";

export interface ReadReply { status: number; contentType: string; body: string }
export interface DiscoveryReadTransport { get(path: string, signal: AbortSignal): Promise<ReadReply> }
export function assertReadPath(path: string): void {
  const listing = /^\/rooms\?format=json&limit=([1-9]\d{0,2})$/u.exec(path);
  const room = /^\/r\/([a-z0-9][a-z0-9_-]{0,47})\?format=json&since=(0|[1-9]\d{0,14})&limit=([1-9]\d{0,2})&wait=0$/u.exec(path);
  const note = /^\/kv\/(?:did-[a-f0-9]{2}\/[a-f0-9]{14}|did\/[a-f0-9]{16})$/u.test(path);
  if (listing && Number(listing[1]) <= 200) return;
  if (room && publicRoom(room[1]) && Number(room[3]) <= 200 && Number.isSafeInteger(Number(room[2]))) return;
  if (note) return;
  throw new BridgeError("Discovery path is not an approved read-only path");
}
/** No URL, method, headers, credentials or arbitrary request options accepted from callers/content. */
export class HttpDiscoveryReadTransport implements DiscoveryReadTransport {
  private readonly bounds: Limits;
  constructor(origin: string, bounds: Partial<Limits> = {}, private readonly fetcher: typeof fetch = globalThis.fetch) {
    if (origin !== DISCOVERY_ORIGIN) throw new BridgeError("Discovery requires the reviewed Technocore origin");
    this.bounds = limits(bounds);
  }
  async get(path: string, signal: AbortSignal): Promise<ReadReply> {
    assertReadPath(path);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, this.bounds.timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      if (signal.aborted) abort();
      const response = await this.fetcher(`${DISCOVERY_ORIGIN}${path}`, { method: "GET", redirect: "manual",
        credentials: "omit", referrerPolicy: "no-referrer", headers: { accept: path.startsWith("/kv/") ? "text/plain" : "application/json" },
        signal: controller.signal });
      if (response.redirected || (response.status >= 300 && response.status < 400) ||
        (response.url && response.url !== `${DISCOVERY_ORIGIN}${path}`)) throw new Error("redirect");
      const declared = response.headers.get("content-length");
      if (declared && (!/^\d+$/u.test(declared) || Number(declared) > this.bounds.responseBytes)) throw new Error("size");
      const chunks: Buffer[] = []; let bytes = 0;
      if (response.body) {
        reader = response.body.getReader();
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > this.bounds.responseBytes) throw new Error("size");
          chunks.push(Buffer.from(chunk.value));
        }
      }
      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      return { status: response.status, contentType: contentType === "application/json" || contentType === "text/plain" ? contentType : "unknown",
        body: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)) };
    } catch { throw new BridgeError(controller.signal.aborted ? "Discovery GET timed out or was cancelled" : "Discovery GET refused or failed"); }
    finally { clearTimeout(timer); signal.removeEventListener("abort", abort); controller.abort(); void reader?.cancel().catch(() => undefined); }
  }
}
