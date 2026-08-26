import { timingSafeEqual } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { BridgeError } from "./errors.js";

export type PassphrasePurpose = "create" | "unlock" | "migrate" | "restore";

export interface PassphraseRequest {
  identityName: string;
  purpose: PassphrasePurpose;
  confirm: boolean;
}

export type PassphraseProvider = (request: PassphraseRequest) => Promise<Buffer>;

export interface HiddenInput extends Readable {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(mode: boolean): this;
}

export interface HiddenOutput extends Writable {
  isTTY?: boolean;
}

const MAX_PASSPHRASE_BYTES = 1024;

function removeLastUtf8CodePoint(bytes: number[]): void {
  if (bytes.length === 0) return;
  let start = bytes.length - 1;
  while (start > 0 && (bytes[start]! & 0xc0) === 0x80) start -= 1;
  bytes.splice(start);
}

export async function readHiddenLine(
  prompt: string,
  input: HiddenInput = process.stdin,
  output: HiddenOutput = process.stderr,
): Promise<Buffer> {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    throw new BridgeError("A private interactive TTY is required for passphrase input");
  }

  const previousRawMode = input.isRaw === true;
  const wasFlowing = input.readableFlowing === true;
  const bytes: number[] = [];
  let escapeSequence = false;
  output.write(prompt);

  try {
    input.setRawMode(true);
    input.resume();
    return await new Promise<Buffer>((resolve, reject) => {
      const cleanup = (): void => {
        input.off("data", onData);
        input.off("end", onEnd);
        input.off("error", onError);
      };
      const finish = (result: Buffer | Error): void => {
        cleanup();
        bytes.fill(0);
        bytes.length = 0;
        if (result instanceof Error) reject(result);
        else resolve(result);
      };
      const onEnd = (): void => finish(new BridgeError("Passphrase input ended unexpectedly"));
      const onError = (): void => finish(new BridgeError("Passphrase input failed"));
      const onData = (chunk: Buffer | string): void => {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
        for (const byte of data) {
          if (escapeSequence) {
            if (
              (byte >= 0x41 && byte <= 0x5a) ||
              (byte >= 0x61 && byte <= 0x7a) ||
              byte === 0x7e
            ) escapeSequence = false;
            continue;
          }
          if (byte === 0x1b) {
            escapeSequence = true;
            continue;
          }
          if (byte === 0x03) {
            finish(new BridgeError("Passphrase entry was cancelled"));
            return;
          }
          if (byte === 0x0d || byte === 0x0a) {
            finish(Buffer.from(bytes));
            return;
          }
          if (byte === 0x08 || byte === 0x7f) {
            removeLastUtf8CodePoint(bytes);
            continue;
          }
          if (byte < 0x20) continue;
          if (bytes.length >= MAX_PASSPHRASE_BYTES) {
            finish(new BridgeError("Passphrase input is too long"));
            return;
          }
          bytes.push(byte);
        }
      };
      input.on("data", onData);
      input.once("end", onEnd);
      input.once("error", onError);
    });
  } finally {
    input.setRawMode(previousRawMode);
    if (!wasFlowing) input.pause();
    output.write("\n");
  }
}

export const hiddenPassphraseProvider: PassphraseProvider = async ({
  identityName,
  purpose,
  confirm,
}) => {
  const first = await readHiddenLine(
    `${purpose === "unlock" ? "Unlock" : "Encryption"} passphrase for ${identityName}: `,
  );
  if (!confirm) return first;

  let second: Buffer | undefined;
  try {
    second = await readHiddenLine(`Confirm passphrase for ${identityName}: `);
    if (
      first.length !== second.length ||
      !timingSafeEqual(first, second)
    ) {
      throw new BridgeError("Passphrase confirmation did not match");
    }
    return first;
  } catch (error) {
    first.fill(0);
    throw error;
  } finally {
    second?.fill(0);
  }
};
