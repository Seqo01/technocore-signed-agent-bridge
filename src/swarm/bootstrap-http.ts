import { request } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { TransportError } from "../errors.js";
import type { FetchLike, HttpsRequestLike } from "../transport.js";

/** One physical GET. Unlike global fetch, never repeats an HTTP 421 on a new connection. */
export function bootstrapGet(requester: HttpsRequestLike = request): FetchLike {
  return async (input, init) => {
    if (init?.method !== "GET" || init.redirect !== "manual") throw new TransportError("Invalid bootstrap GET policy");
    const url = new URL(input);
    if (url.protocol !== "https:" || url.username || url.password) throw new TransportError("Invalid bootstrap GET origin");
    return new Promise<Response>((resolve, reject) => {
      let req: ClientRequest | undefined, incoming: IncomingMessage | undefined;
      let settled = false;
      const finish = (response?: Response) => {
        if (settled) return;
        settled = true; init.signal?.removeEventListener("abort", abort);
        if (response) resolve(response);
        else reject(new TransportError("Bootstrap GET incomplete; no retry"));
      };
      const abort = () => { finish(); incoming?.destroy(); req?.destroy(); };
      if (init.signal?.aborted) { finish(); return; }
      init.signal?.addEventListener("abort", abort, { once: true });
      try {
        req = requester(url, { method: "GET", headers: { accept: "application/json" }, agent: false }, res => {
          incoming = res;
          const status = res.statusCode;
          res.on("error", () => finish()); res.on("aborted", () => finish());
          if (!status || status < 200 || status > 599) { finish(); res.destroy(); return; }
          // Do not retain Location or error bodies. Their content is not bootstrap evidence.
          if (status >= 300) { finish(new Response(null, { status })); res.destroy(); return; }
          const type = res.headers["content-type"];
          if (typeof type !== "string" || type.split(";", 1)[0]!.trim().toLowerCase() !== "application/json") {
            finish(); res.destroy(); return;
          }
          const chunks: Buffer[] = []; let bytes = 0;
          res.on("data", (chunk: Buffer | string) => {
            if (settled) return;
            const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += value.length;
            if (bytes > 2 * 1024 * 1024) { finish(); res.destroy(); return; }
            chunks.push(value);
          });
          res.on("end", () => {
            // Empty 204/205 cannot contain the required JSON room response.
            if (status === 204 || status === 205) { finish(); return; }
            finish(new Response(Buffer.concat(chunks), { status, headers: { "content-type": "application/json" } }));
          });
          res.on("close", () => { if (!res.complete) finish(); });
        });
        req.on("error", () => finish()); req.end();
      } catch { finish(); req?.destroy(); }
    });
  };
}
