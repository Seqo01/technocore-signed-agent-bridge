import { BridgeError } from "../errors.js";

export type DiscoveryFailureStage =
  | "validation"
  | "request"
  | "response-headers"
  | "response-body"
  | "response-status"
  | "response-parse"
  | "persistence";

export type DiscoveryPathClass = "rooms" | "events" | "public-room" | "did-note";
export type DiscoveryContentType = "application/json" | "text/plain" | "other";

export interface DiscoveryFailureDiagnostics {
  stage: DiscoveryFailureStage;
  pathClass: DiscoveryPathClass;
  dispatched: boolean;
  headersReceived: boolean;
  timedOut: boolean;
  bytesReceived: number;
  redirectDetected: boolean;
  status?: number;
  contentType?: DiscoveryContentType;
  errorClass?: string;
  causeCode?: string;
}

export type DiscoveryProgress = (update: Partial<DiscoveryFailureDiagnostics>) => void;

const stages = new Set<DiscoveryFailureStage>([
  "validation", "request", "response-headers", "response-body", "response-status", "response-parse", "persistence",
]);
const pathClasses = new Set<DiscoveryPathClass>(["rooms", "events", "public-room", "did-note"]);
const contentTypes = new Set<DiscoveryContentType>(["application/json", "text/plain", "other"]);
const errorClasses = new Set([
  "AbortError", "BridgeError", "DOMException", "Error", "FetchError", "TypeError",
  "BodyInterrupted", "BodyLimitRefused", "InvalidUtf8", "RedirectRefused",
  "ResponseShapeRefused", "ResponseStatusRefused", "ResponseTypeRefused",
  "ResponseParseRefused", "PersistenceRefused", "ValidationRefused", "TimeoutError",
]);
const causeCodes = new Set([
  "ABORT_ERR", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "EAI_AGAIN", "ECONNABORTED",
  "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EPIPE", "EPROTO",
  "ETIMEDOUT", "ERR_DISCOVERY_BODY_INTERRUPTED", "ERR_DISCOVERY_BODY_LIMIT", "ERR_DISCOVERY_INVALID_UTF8",
  "ERR_DISCOVERY_PARSE", "ERR_DISCOVERY_PERSISTENCE", "ERR_DISCOVERY_REDIRECT", "ERR_DISCOVERY_RESPONSE_SHAPE",
  "ERR_DISCOVERY_RESPONSE_STATUS", "ERR_DISCOVERY_RESPONSE_TYPE", "ERR_DISCOVERY_TIMEOUT",
  "ERR_DISCOVERY_VALIDATION", "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UND_ERR_BODY_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_RESPONSE_STATUS_CODE", "UND_ERR_SOCKET",
]);

function safeErrorClass(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 64 && errorClasses.has(value) ? value : undefined;
}

function safeCauseCode(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 64 && causeCodes.has(value) ? value : undefined;
}

function errorName(error: unknown): string | undefined {
  try { return safeErrorClass(error instanceof Error ? error.name : undefined); } catch { return undefined; }
}

function nestedCauseCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth++) {
    if (!current || typeof current !== "object") return undefined;
    try {
      const code = safeCauseCode((current as { code?: unknown }).code);
      if (code) return code;
      current = (current as { cause?: unknown }).cause;
    } catch { return undefined; }
  }
  return undefined;
}

export function classifyDiscoveryPath(path: string): DiscoveryPathClass {
  if (path.startsWith("/rooms")) return "rooms";
  if (path.startsWith("/r/events")) return "events";
  if (path.startsWith("/kv/")) return "did-note";
  return "public-room";
}

export function initialDiscoveryDiagnostics(pathClass: DiscoveryPathClass): DiscoveryFailureDiagnostics {
  return { stage: "validation", pathClass, dispatched: false, headersReceived: false, timedOut: false,
    bytesReceived: 0, redirectDetected: false };
}

export function normalizeDiscoveryContentType(value: unknown): DiscoveryContentType | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const normalized = value.split(";", 1)[0]?.trim().toLowerCase();
  return normalized === "application/json" || normalized === "text/plain" ? normalized : "other";
}

export function safeDiscoveryDiagnostics(input: DiscoveryFailureDiagnostics): DiscoveryFailureDiagnostics {
  const output: DiscoveryFailureDiagnostics = {
    stage: stages.has(input.stage) ? input.stage : "validation",
    pathClass: pathClasses.has(input.pathClass) ? input.pathClass : "public-room",
    dispatched: input.dispatched === true,
    headersReceived: input.headersReceived === true,
    timedOut: input.timedOut === true,
    bytesReceived: Number.isSafeInteger(input.bytesReceived) && input.bytesReceived >= 0 ? input.bytesReceived : 0,
    redirectDetected: input.redirectDetected === true,
  };
  const status = input.status;
  if (Number.isSafeInteger(status) && status! >= 100 && status! <= 599) output.status = status!;
  if (input.contentType !== undefined && contentTypes.has(input.contentType)) output.contentType = input.contentType;
  const errorClass = safeErrorClass(input.errorClass);
  const causeCode = safeCauseCode(input.causeCode);
  if (errorClass) output.errorClass = errorClass;
  if (causeCode) output.causeCode = causeCode;
  return output;
}

export function diagnosticsFromError(
  current: DiscoveryFailureDiagnostics,
  error: unknown,
  overrides: Partial<DiscoveryFailureDiagnostics> = {},
): DiscoveryFailureDiagnostics {
  const errorClass = safeErrorClass(overrides.errorClass) ?? errorName(error);
  const causeCode = safeCauseCode(overrides.causeCode) ?? nestedCauseCode(error);
  return safeDiscoveryDiagnostics({ ...current, ...overrides,
    ...(errorClass ? { errorClass } : {}), ...(causeCode ? { causeCode } : {}) });
}

export class DiscoveryTransportError extends BridgeError {
  readonly diagnostics: Readonly<DiscoveryFailureDiagnostics>;

  constructor(diagnostics: DiscoveryFailureDiagnostics) {
    super("Discovery GET failed; no retry");
    this.name = "DiscoveryTransportError";
    this.diagnostics = Object.freeze(safeDiscoveryDiagnostics(diagnostics));
  }
}

export function formatDiscoveryFailureDiagnostics(error: unknown): string | undefined {
  return error instanceof DiscoveryTransportError ? JSON.stringify(error.diagnostics, null, 2) : undefined;
}
