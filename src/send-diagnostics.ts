import { AmbiguousSendError, TransportError } from "./errors.js";

export interface OutboundDiagnostics {
  stage: "approval" | "nonce-reservation" | "signing" | "dispatch" | "request" | "response-body" | "response-status" | "response-parse" | "local-confirmation";
  nonceReservation: "not-started" | "attempted" | "reserved";
  dispatchBegan: boolean;
  headersReceived: boolean;
  bodyStarted: boolean;
  responseParsed: boolean;
  timedOut: boolean;
  errorClass: string;
  status?: number | undefined;
  causeCode?: string | undefined;
}

const stages = new Set(["approval", "nonce-reservation", "signing", "dispatch", "request", "response-body", "response-status", "response-parse", "local-confirmation"]);
const classes = new Set(["Error", "BridgeError", "ProtocolError", "TransportError", "AmbiguousSendError", "SignedPostRejectedError", "TypeError", "SyntaxError", "DOMException", "UnexpectedContentType"]);
const codes = new Set(["ENOENT", "EACCES", "EPERM", "ENOSPC", "EIO", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ERR_RESPONSE_TOO_LARGE"]);
const attached = new WeakMap<object, OutboundDiagnostics>();

/** Select fields, never spread arbitrary error/HTTP data into durable telemetry. */
export function cleanOutbound(value: OutboundDiagnostics): OutboundDiagnostics {
  return { stage: stages.has(value.stage) ? value.stage : "dispatch",
    nonceReservation: ["attempted", "reserved"].includes(value.nonceReservation) ? value.nonceReservation : "not-started",
    dispatchBegan: value.dispatchBegan === true, headersReceived: value.headersReceived === true,
    bodyStarted: value.bodyStarted === true, responseParsed: value.responseParsed === true, timedOut: value.timedOut === true,
    errorClass: classes.has(value.errorClass) ? value.errorClass : "Error",
    ...(Number.isInteger(value.status) && value.status! >= 100 && value.status! <= 599 ? { status: value.status! } : {}),
    ...(codes.has(value.causeCode ?? "") ? { causeCode: value.causeCode! } : {}) };
}

export function outboundDiagnostics(error: unknown): OutboundDiagnostics | undefined {
  return error && typeof error === "object" ? attached.get(error) : undefined;
}

export function attachOutbound(error: unknown, progress: OutboundDiagnostics): Error {
  const result = error instanceof Error ? error : new Error("Outbound operation failed");
  const http = error instanceof AmbiguousSendError || error instanceof SignedPostRejectedError ? error.diagnostics : undefined;
  const diagnostics = { ...progress, ...(http ? { stage: http.stage, headersReceived: http.headersReceived,
    bodyStarted: http.bodyStarted ?? false, timedOut: http.timedOut, status: http.status, errorClass: http.errorClass ?? result.name,
    causeCode: http.causeCode } : { errorClass: error instanceof AmbiguousSendError && error.cause instanceof Error ? error.cause.name : result.name }) };
  let cause: unknown = error;
  for (let depth = 0; depth < 4 && cause && typeof cause === "object"; depth++) {
    const c = cause as { code?: string; cause?: unknown };
    if (codes.has(c.code ?? "")) diagnostics.causeCode ??= c.code;
    cause = c.cause;
  }
  attached.set(result, cleanOutbound(diagnostics));
  return result;
}

/** A complete explicit HTTP 4xx refusal, not a generic post-dispatch exception. */
export class SignedPostRejectedError extends TransportError {
  constructor(readonly diagnostics: NonNullable<AmbiguousSendError["diagnostics"]>) {
    super("Signed POST received an explicit HTTP refusal; no automatic resend", diagnostics.status);
    this.name = "SignedPostRejectedError";
  }
}
