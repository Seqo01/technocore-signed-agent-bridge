import { sanitizeText, verifySignedMessage } from "../protocol.js";
import { candidateId, didPaths, digest, DISCOVERY_ORIGIN, isClaim, isDid, limits, publicRoom, safeTopic, TRUST,
  unique, type EndpointClass, type Limits, type NewObservation, type Warning, type Claim } from "./model.js";
import { DiscoveryStore } from "./store.js";
import { assertReadPath, type DiscoveryReadTransport, type ReadReply } from "./transport.js";
import { classifyDiscoveryPath, diagnosticsFromError, DiscoveryTransportError,
  initialDiscoveryDiagnostics, normalizeDiscoveryContentType, safeDiscoveryDiagnostics,
  type DiscoveryFailureDiagnostics } from "./diagnostics.js";

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
const integer = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
function refusal(
  diagnostics: DiscoveryFailureDiagnostics,
  stage: DiscoveryFailureDiagnostics["stage"],
  errorClass: string,
  causeCode: string,
): DiscoveryTransportError {
  return new DiscoveryTransportError(diagnosticsFromError(diagnostics, undefined, { stage, errorClass, causeCode }));
}
function json(body: string, diagnostics: DiscoveryFailureDiagnostics): Record<string, unknown> {
  try { const value = object(JSON.parse(body)); if (value) return value; } catch { /* Never forward parse errors/body. */ }
  throw refusal(diagnostics, "response-parse", "ResponseParseRefused", "ERR_DISCOVERY_PARSE");
}
function base(endpointClass: EndpointClass, sourceRef: string, content: string): NewObservation {
  return { endpointClass, sourceRef, sourceOrigin: DISCOVERY_ORIGIN, sourceHash: digest(DISCOVERY_ORIGIN + sourceRef),
    contentHash: digest(content), metadataVersion: 1, signatureState: "absent", verificationState: "unverified",
    provenanceClassification: "unknown", trustClassification: TRUST, claims: [], warnings: [] };
}
/** JSON fields are a local compatibility parser, NOT an official Technocore role schema. */
function claims(text: string, did?: string): { claims: Claim[]; warnings: Warning[] } {
  let record;
  try { record = object(JSON.parse(text)); } catch { /* Prose is never mined for DIDs or roles. */ }
  if (!record) return { claims: [], warnings: ["content-omitted"] };
  if (record.did !== undefined && record.did !== did) return { claims: [], warnings: ["did-mismatch", "content-omitted"] };
  const raw = [record.role, ...(Array.isArray(record.roles) ? record.roles : []),
    ...(Array.isArray(record.capabilities) ? record.capabilities : [])].filter(v => v !== undefined);
  const safe = unique(raw.filter(isClaim));
  return { claims: safe, warnings: unique<Warning>([
    ...(raw.some(v => !isClaim(v)) ? ["unrecognized-claims" as const] : []),
    ...(Object.keys(record).some(k => !["did", "role", "roles", "capabilities"].includes(k)) ? ["content-omitted" as const] : []),
  ]) };
}
// note_read returns banner + blank line + a single-line note + optional budget footer, NOT JSON even with format=json.
function noteValue(body: string): string | undefined {
  const lines = body.replace(/\r\n/gu, "\n").split("\n");
  while (lines.at(-1) === "") lines.pop();
  if (!lines[0]?.startsWith("!! UNTRUSTED CONTENT — ") || lines[1] !== "" || lines.length < 3 || lines.length > 4) return undefined;
  if (lines.length === 4 && !lines[3]?.startsWith("# budget: ")) return undefined;
  return lines[2];
}

export class TechnocorePublicDiscoveryAdapter {
  private readonly bounds: Limits;
  private requests = 0;
  private lookups = 0;
  constructor(private readonly transport: DiscoveryReadTransport, private readonly store: DiscoveryStore,
    bounds: Partial<Limits> = {}, private readonly now: () => string = () => new Date().toISOString()) {
    this.bounds = limits(bounds);
  }
  private async read(path: string): Promise<{ reply: ReadReply; diagnostics: DiscoveryFailureDiagnostics }> {
    let diagnostics = initialDiscoveryDiagnostics(classifyDiscoveryPath(path));
    try { assertReadPath(path); }
    catch (error) { throw new DiscoveryTransportError(diagnosticsFromError(diagnostics, error,
      { errorClass: "ValidationRefused", causeCode: "ERR_DISCOVERY_VALIDATION" })); }
    if (this.requests >= this.bounds.requests) throw refusal(diagnostics, "validation", "ValidationRefused", "ERR_DISCOVERY_VALIDATION");
    this.requests++;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reply = await Promise.race([this.transport.get(path, controller.signal, update => {
        diagnostics = safeDiscoveryDiagnostics({ ...diagnostics, ...update });
      }), new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(refusal({ ...diagnostics, timedOut: true }, diagnostics.headersReceived ? "response-body" : "request",
            "TimeoutError", "ERR_DISCOVERY_TIMEOUT"));
        }, this.bounds.timeoutMs);
      })]);
      const status = reply?.status;
      const contentType = normalizeDiscoveryContentType(reply?.contentType);
      const bytesReceived = typeof reply?.body === "string" ? Buffer.byteLength(reply.body) : diagnostics.bytesReceived;
      diagnostics = safeDiscoveryDiagnostics({ ...diagnostics, stage: "response-headers", dispatched: true,
        headersReceived: true, bytesReceived, ...(integer(status) && status >= 100 && status <= 599 ? { status } : {}),
        ...(contentType ? { contentType } : {}) });
      if (!reply || !integer(reply.status) || reply.status < 100 || reply.status > 599 || typeof reply.body !== "string" ||
        bytesReceived > this.bounds.responseBytes) throw refusal(diagnostics, "response-body", "ResponseShapeRefused", "ERR_DISCOVERY_RESPONSE_SHAPE");
      if (reply.status !== 200 && reply.status !== 404) {
        throw refusal(diagnostics, "response-status", "ResponseStatusRefused", "ERR_DISCOVERY_RESPONSE_STATUS");
      }
      return { reply, diagnostics };
    } catch (error) {
      if (error instanceof DiscoveryTransportError) throw error;
      throw new DiscoveryTransportError(diagnosticsFromError(diagnostics, error,
        { stage: diagnostics.headersReceived ? "response-body" : "request" }));
    } finally { if (timer) clearTimeout(timer); controller.abort(); }
  }
  private async save(batch: NewObservation[], diagnostics: DiscoveryFailureDiagnostics) {
    try { await this.store.append(batch, this.now()); }
    catch (error) { throw new DiscoveryTransportError(diagnosticsFromError(diagnostics, error,
      { stage: "persistence", errorClass: "PersistenceRefused", causeCode: "ERR_DISCOVERY_PERSISTENCE" })); }
    return { retainedObservations: batch.length, networkGets: this.requests, authority: false as const };
  }
  async discoverRooms() {
    const { reply, diagnostics } = await this.read(`/rooms?format=json&limit=${this.bounds.rooms}`);
    if (reply.status !== 200) throw refusal(diagnostics, "response-status", "ResponseStatusRefused", "ERR_DISCOVERY_RESPONSE_STATUS");
    if (reply.contentType !== "application/json") throw refusal(diagnostics, "response-parse", "ResponseTypeRefused", "ERR_DISCOVERY_RESPONSE_TYPE");
    const value = json(reply.body, diagnostics);
    if (!Array.isArray(value.rooms) || value.rooms.length > this.bounds.rooms) {
      throw refusal(diagnostics, "response-parse", "ResponseParseRefused", "ERR_DISCOVERY_PARSE");
    }
    const batch: NewObservation[] = []; let skipped = 0;
    for (const item of value.rooms) {
      const r = object(item);
      if (!r || !publicRoom(r.room)) { skipped++; continue; }
      const o = base("rooms", "/rooms", JSON.stringify(r));
      o.room = r.room; o.topic = safeTopic(r.topic, this.bounds.stringLength);
      o.provenanceClassification = "server-observed"; o.warnings = ["topic-untrusted"];
      if (o.topic !== r.topic && r.topic != null) o.warnings.push("content-omitted");
      batch.push(o);
    }
    return { ...await this.save(batch, diagnostics), skipped, rooms: batch.map(o => ({ room: o.room, topic: o.topic, trust: TRUST })) };
  }
  async discoverEvents(since = 0) { return this.readMessages("events", since, true); }
  /** Explicit selection only. Never called automatically from rooms/events/metadata. */
  async discoverRoom(room: string, since = 0) {
    if (room === "events") return this.discoverEvents(since);
    return this.readMessages(room, since, false);
  }
  private async readMessages(room: string, since: number, events: boolean) {
    if (!publicRoom(room) || !integer(since) || since > 999999999999999) {
      throw refusal(initialDiscoveryDiagnostics(room === "events" ? "events" : "public-room"), "validation",
        "ValidationRefused", "ERR_DISCOVERY_VALIDATION");
    }
    const { reply, diagnostics } = await this.read(`/r/${room}?format=json&since=${since}&limit=${this.bounds.events}&wait=0`);
    if (reply.status !== 200) throw refusal(diagnostics, "response-status", "ResponseStatusRefused", "ERR_DISCOVERY_RESPONSE_STATUS");
    if (reply.contentType !== "application/json") throw refusal(diagnostics, "response-parse", "ResponseTypeRefused", "ERR_DISCOVERY_RESPONSE_TYPE");
    const value = json(reply.body, diagnostics);
    if (value.room !== room || !Array.isArray(value.messages) || value.messages.length > this.bounds.events ||
      value.count !== value.messages.length || !integer(value.last_seq) ||
      !(value.first_seq === null || integer(value.first_seq)) ||
      (value.generation !== undefined && !integer(value.generation))) {
      throw refusal(diagnostics, "response-parse", "ResponseParseRefused", "ERR_DISCOVERY_PARSE");
    }
    const batch: NewObservation[] = [];
    let previous = since;
    const gap = typeof value.first_seq === "number" && value.first_seq > since + 1;
    for (const item of value.messages) {
      const r = object(item); const o = base(events ? "events" : "public-room", `/r/${room}`, JSON.stringify(item));
      o.room = room;
      if (value.generation !== undefined) o.generation = value.generation as number;
      else o.warnings.push("epoch-unknown");
      if (gap) o.warnings.push("retention-gap");
      if (!r || !integer(r.seq) || r.seq <= previous || r.seq > value.last_seq || typeof r.text !== "string" ||
        r.text.length > 16384 || typeof r.ts !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3,6}Z$/u.test(r.ts) || !Number.isFinite(Date.parse(r.ts))) {
        o.provenanceClassification = "malformed"; o.warnings.push("malformed-record"); batch.push(o); continue;
      }
      previous = r.seq; o.seq = r.seq; o.serverTimestamp = r.ts;
      if (events) {
        const match = /^created ([a-z0-9][a-z0-9_-]{0,47})$/u.exec(r.text);
        if (r.from === "server" && match && publicRoom(match[1])) {
          o.room = match[1]; o.provenanceClassification = "server-observed";
        } else { o.warnings.push("unexpected-event"); o.provenanceClassification = "unknown"; }
        // Server events do not attest to any agent identity. No text/DID heuristic.
      } else if (isDid(r.from)) {
        o.claimedDid = r.from; o.candidateId = candidateId(r.from);
        o.provenanceClassification = "unsigned-self-claim";
        const parsed = claims(r.text, r.from); o.claims = parsed.claims; o.warnings.push(...parsed.warnings);
        const nonce = typeof r.nonce === "string" && /^(0|[1-9]\d{0,18})$/u.test(r.nonce) ? r.nonce : integer(r.nonce) ? String(r.nonce) : undefined;
        if (nonce !== undefined) o.verificationState = "server-reported-did";
        if (r.sig !== undefined) {
          o.signatureHash = digest(JSON.stringify(r.sig)); o.signatureState = "unverifiable";
          let canonical = false;
          try { canonical = sanitizeText(r.text) === r.text; } catch { /* retain only hash */ }
          if (nonce !== undefined && canonical && typeof r.sig === "string") {
            o.signatureState = verifySignedMessage(room, { did: r.from, signature: r.sig, nonce, sanitizedText: r.text }) ? "verified" : "invalid";
            if (o.signatureState === "verified") { o.verificationState = "local-signature-valid"; o.provenanceClassification = "signed-message-verified"; }
            else { o.verificationState = "unverified"; o.warnings.push("signature-invalid"); }
          } else { o.verificationState = "unverified"; o.warnings.push("canonical-data-unavailable"); }
        } else o.warnings.push("unsigned-record");
      } else { o.warnings.push("content-omitted"); }
      batch.push(o);
    }
    return { ...await this.save(batch, diagnostics), retentionGap: gap, lastReturnedSeq: previous === since ? null : previous,
      reportedLastSeq: value.last_seq, completeHistory: false, noCursorMutation: true };
  }
  async lookupDidMetadata(did: string) {
    let paths: ReturnType<typeof didPaths>;
    try { paths = didPaths(did); }
    catch (error) { throw new DiscoveryTransportError(diagnosticsFromError(initialDiscoveryDiagnostics("did-note"), error,
      { errorClass: "ValidationRefused", causeCode: "ERR_DISCOVERY_VALIDATION" })); }
    if (this.lookups >= this.bounds.didLookups) throw refusal(initialDiscoveryDiagnostics("did-note"), "validation",
      "ValidationRefused", "ERR_DISCOVERY_VALIDATION");
    this.lookups++;
    const batch: NewObservation[] = [];
    let persistenceDiagnostics = initialDiscoveryDiagnostics("did-note");
    for (const [kind, path] of [["did-current", paths.current], ["did-legacy", paths.legacy]] as const) {
      const { reply, diagnostics } = await this.read(path);
      persistenceDiagnostics = diagnostics;
      const o = base(kind, path, reply.status === 404 ? "not-found" : reply.body);
      o.claimedDid = did; o.candidateId = candidateId(did); o.provenanceClassification = "third-party-claim";
      o.warnings = ["note-not-owner-authenticated"];
      if (reply.status === 404) { o.warnings.push("not-found"); batch.push(o); continue; }
      if (reply.contentType !== "text/plain") throw refusal(diagnostics, "response-parse", "ResponseTypeRefused", "ERR_DISCOVERY_RESPONSE_TYPE");
      if (Buffer.byteLength(reply.body) > this.bounds.metadataBytes) {
        throw refusal(diagnostics, "response-body", "BodyLimitRefused", "ERR_DISCOVERY_BODY_LIMIT");
      }
      const value = noteValue(reply.body);
      if (value === undefined) { o.provenanceClassification = "malformed"; o.warnings.push("malformed-record"); }
      else {
        o.contentHash = digest(value); o.metadataHash = o.contentHash;
        const parsed = claims(value, did); o.claims = parsed.claims; o.warnings.push(...parsed.warnings);
      }
      batch.push(o); break; // Fallback ONLY after actual 404, never malformed/empty/5xx.
    }
    return { ...await this.save(batch, persistenceDiagnostics), candidateId: candidateId(did) };
  }
  listCandidates() { return this.store.listCandidates(); }
  inspectCandidate(id: string) { return this.store.inspectCandidate(id); }
}
