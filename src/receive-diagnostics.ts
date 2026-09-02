/** Diagnostic values are allowlisted; never copy error messages, bodies, URLs or headers. */
export type ReceiveStage = "preflight" | "identity-unlock" | "get-intent" | "transport" | "http-status" |
  "response-parse" | "message-selection" | "sender-did-validation" | "frame-validation" |
  "payload-validation" | "sequence-validation" | "inbound-persistence" | "journal-persistence" |
  "receipt-checkpoint" | "cursor-ack" | "local-completion";

export interface ReadProgress {
  stage: "transport" | "http-status" | "response-parse";
  status?: number;
  headersReceived?: boolean;
  timedOut?: boolean;
  contentType?: "application/json" | "text/plain" | "text/html" | "other";
}

export interface ReceiveFailure {
  step: number;
  expectedSeq: number;
  previousCursor: number;
  stage: ReceiveStage;
  code: "stale-cursor-or-room-sequence-mismatch" | "receive-failed" | "reconciliation-failed";
  errorClass: string;
  causeCode?: string;
  timestamp: string;
  contactHash: string;
  http?: Omit<ReadProgress, "stage">;
}

export function receiveFailure(
  fields: Pick<ReceiveFailure, "step" | "expectedSeq" | "previousCursor" | "stage" | "code" | "contactHash" | "http">,
  error: unknown,
): ReceiveFailure {
  const classes = new Set(["Error", "BridgeError", "ProtocolError", "TransportError", "TypeError", "SyntaxError", "DOMException", "FetchAttemptError"]);
  const codes = new Set(["ENOENT", "EACCES", "EPERM", "ENOSPC", "EIO", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"]);
  const name = error instanceof Error ? error.constructor.name : "Error";
  let causeCode: string | undefined;
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
    const value = current as { code?: unknown; cause?: unknown };
    if (typeof value.code === "string" && codes.has(value.code)) causeCode ??= value.code;
    current = value.cause;
  }
  return { ...fields, errorClass: classes.has(name) ? name : "Error", ...(causeCode ? { causeCode } : {}), timestamp: new Date().toISOString() };
}
