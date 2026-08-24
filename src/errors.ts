export class BridgeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BridgeError";
  }
}

export class ProtocolError extends BridgeError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProtocolError";
  }
}

export class TransportError extends BridgeError {
  readonly status?: number;

  constructor(message: string, status?: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "TransportError";
    if (status !== undefined) this.status = status;
  }
}

export class AmbiguousSendError extends TransportError {
  readonly diagnostics?: Readonly<SendFailureDiagnostics>;

  constructor(
    message: string,
    diagnostics?: SendFailureDiagnostics,
    options?: ErrorOptions,
  ) {
    super(message, undefined, options);
    this.name = "AmbiguousSendError";
    if (diagnostics !== undefined) this.diagnostics = Object.freeze({ ...diagnostics });
  }
}

export type SendFailureStage =
  | "request"
  | "response-body"
  | "response-status"
  | "response-parse";

export interface SendFailureDiagnostics {
  stage: SendFailureStage;
  headersReceived: boolean;
  timedOut: boolean;
  endpoint: string;
  errorClass?: string;
  causeCode?: string;
  status?: number;
  contentType?: string;
  bodyStarted?: boolean;
}
