import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { BridgeError } from "../errors.js";
import { assertNoSecretLikeOutput } from "../workloads/types.js";
import { DASHBOARD_ACTIONS, type DashboardAction, type DashboardController } from "./controller.js";
import { html, css, javascript } from "./ui.js";

const BODY_LIMIT = 8192;
const RESPONSE_LIMIT = 4 * 1024 * 1024;
async function jsonBody(req: IncomingMessage): Promise<unknown> {
  if (req.headers["content-type"] !== "application/json") throw new BridgeError("Expected JSON");
  const chunks: Buffer[] = []; let size = 0;
  for await (const value of req) {
    const chunk = Buffer.from(value); size += chunk.length;
    if (size > BODY_LIMIT) throw new BridgeError("Input limit exceeded");
    chunks.push(chunk);
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
}
function send(res: ServerResponse, status: number, value: string, type = "application/json") {
  res.writeHead(status, { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
  res.end(value);
}
function json(res: ServerResponse, status: number, value: unknown) {
  const text = JSON.stringify(value);
  assertNoSecretLikeOutput(text, "Dashboard response");
  if (Buffer.byteLength(text) > RESPONSE_LIMIT) throw new BridgeError("Response exceeds dashboard bound");
  send(res, status, text);
}

/** No arbitrary filesystem endpoints, subprocesses, CORS, remote bind, or live transport. */
export async function startDashboardServer(controller: DashboardController, port = 4317) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new BridgeError("Invalid dashboard port");
  let origin = "";
  const server = createServer({ maxHeaderSize: 8192 }, (req, res) => {
    void (async () => {
      // Pin Host as well as Origin: reject cross-site writes and DNS rebinding to loopback.
      if (req.headers.host !== new URL(origin).host || req.headers.origin && req.headers.origin !== origin ||
        req.headers["sec-fetch-site"] && !["same-origin", "none"].includes(String(req.headers["sec-fetch-site"]))) {
        send(res, 403, '{"error":"Local same-origin access only"}'); return;
      }
      const url = req.url ?? "";
      if (req.method === "GET") {
        if (url === "/") { send(res, 200, html, "text/html"); return; }
        if (url === "/app.css") { send(res, 200, css, "text/css"); return; }
        if (url === "/app.js") { send(res, 200, javascript, "text/javascript"); return; }
        if (url === "/api/state") { json(res, 200, await controller.view()); return; }
        const match = /^\/api\/jobs\/([a-f0-9]{64})$/u.exec(url);
        if (match) { json(res, 200, await controller.view(match[1]!)); return; }
        send(res, 404, '{"error":"Not found"}'); return;
      }
      if (req.method !== "POST") { send(res, 405, '{"error":"Method not allowed"}'); return; }
      if (req.headers.origin !== origin || req.headers["x-swarm-local"] !== "1") { send(res, 403, '{"error":"Same-origin operator action required"}'); return; }
      if (url === "/api/tasks") { json(res, 202, await controller.submit(await jsonBody(req))); return; }
      const action = url.startsWith("/api/control/") ? url.slice("/api/control/".length) as DashboardAction : undefined;
      if (!action || !DASHBOARD_ACTIONS.includes(action)) { send(res, 404, '{"error":"Not found"}'); return; }
      const body = await jsonBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) throw new BridgeError("Control takes no arguments");
      await controller.request(action); json(res, 202, { status: "requested", action });
    })().catch(() => {
      // Never serialize exception messages, submitted text, local paths or raw state.
      if (!res.headersSent && !res.destroyed) send(res, 400, '{"error":"Request rejected or state unavailable. Check task format, policy scope and session state. No automatic retry."}');
      else res.destroy();
    });
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000; server.timeout = 15000;
  server.keepAliveTimeout = 1000; server.maxRequestsPerSocket = 100;
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => { server.off("error", reject); done(); }); });
  const address = server.address();
  if (!address || typeof address === "string") throw new BridgeError("Dashboard bind failed");
  origin = `http://127.0.0.1:${address.port}`;
  return { origin, async close() {
    const closed = new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    server.closeIdleConnections(); await controller.close(); await closed;
  } };
}
